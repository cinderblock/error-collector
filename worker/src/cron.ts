/**
 * Scheduled work.
 *
 * One cron trigger fires every minute and fans out by clock, rather than declaring
 * several triggers, so there is a single place to reason about what runs when.
 *
 * - Every minute: publish the governor's current level, which the usage ingest path
 *   reads from KV to decide whether it still has budget.
 * - 04:17 UTC: roll yesterday's usage out of Analytics Engine into D1, refresh
 *   channel recency, then prune expired events and blobs.
 *
 * Pruning is chunked. A retention sweep that tried to clear a backlog in one pass
 * could spend the entire day's D1 row-write allowance on deletes and leave nothing
 * for ingest — which would be a self-inflicted outage in the name of housekeeping.
 */

import type { Env } from './env.js';
import { dayKey, nowSeconds } from './env.js';
import { AnalyticsUnavailableError, runSql } from './analytics/sql.js';
import { dailyRollupSql } from './analytics/usage-queries.js';
import { levelFor, loadGovernorConfig, publishGovernorState, usageRatio } from './governor.js';
import { listApps } from './storage/apps.js';
import { clearPurgeSchedule, duePurges } from './storage/channels.js';
import { readAccountUsage } from './storage/usage.js';

/** Deletes per daily sweep. At 30-day retention this clears a steady 2k events/day. */
const PRUNE_LIMIT = 2_000;

export async function runScheduled(event: ScheduledController, env: Env): Promise<void> {
  const now = nowSeconds();
  const minuteOfDay = new Date(now * 1000).getUTCHours() * 60 + new Date(now * 1000).getUTCMinutes();

  await publishLevel(env, now);

  // 04:17 UTC — deliberately not on the hour, where every other scheduled job is.
  if (minuteOfDay === 4 * 60 + 17) {
    await runDailyMaintenance(env, now);
  }

  void event;
}

/**
 * The daily housekeeping, as one callable unit.
 *
 * Separated from the clock on purpose. Wiring it directly into "is it 04:17?" made it
 * impossible to exercise without waiting for a specific minute of the day, which is
 * how retention bugs survive to production — and it also meant there was no way to
 * make a retention change take effect without sleeping on it. The admin UI can now
 * run it on demand.
 *
 * Every step is independent; one failing must not abandon the rest.
 */
export async function runDailyMaintenance(env: Env, now: number = nowSeconds()): Promise<string[]> {
  const log: string[] = [];

  for (const [name, step] of [
    ['usage rollup', () => rollUpUsage(env, now)],
    ['channel recency', () => refreshChannels(env)],
    ['retired channel purge', () => purgeRetiredChannels(env, now)],
    ['issue pruning', () => pruneIssues(env, now)],
    ['event and blob pruning', () => prune(env, now)],
  ] as const) {
    try {
      await step();
      log.push(`${name}: ok`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`maintenance step "${name}" failed`, error);
      log.push(`${name}: FAILED — ${message}`);
    }
  }

  return log;
}

async function publishLevel(env: Env, now: number): Promise<void> {
  const config = await loadGovernorConfig(env);
  const usage = await readAccountUsage(env, dayKey(now));
  const ratio = usageRatio(usage, config.account);

  await publishGovernorState(env, {
    level: levelFor(usage, config.account),
    ratio,
    updatedAt: now,
    usage,
  });
}

/**
 * Copies yesterday's usage totals from Analytics Engine into D1.
 *
 * AE keeps 90 days with no knob, so this is the only way to have a year-on-year
 * number later — and it cannot be backfilled, because the source data is simply gone
 * once it expires. Runs for *yesterday* rather than today so the day is complete;
 * re-running is safe because the write is an upsert keyed on (day, app, event).
 *
 * Skipped without complaint when the account token is absent: writing usage needs no
 * token, only reading does, so a deployment can legitimately collect usage for a
 * while before anyone sets one up. Nothing is lost until data ages out.
 */
async function rollUpUsage(env: Env, now: number): Promise<void> {
  const dayEnd = Math.floor(now / 86_400) * 86_400;
  const dayStart = dayEnd - 86_400;
  const day = dayKey(dayStart);

  const apps = await listApps(env);

  for (const app of apps.results) {
    try {
      const result = await runSql<{ event: string; events: number; value: number }>(
        env,
        dailyRollupSql(env.USAGE_DATASET, app.id, dayStart, dayEnd),
      );
      if (result.data.length === 0) continue;

      await env.DB.batch(
        result.data.map(row =>
          env.DB.prepare(
            `INSERT INTO usage_rollup (day, app_id, event, owner_id, events, value)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (day, app_id, event) DO UPDATE SET
               events = excluded.events, value = excluded.value`,
          ).bind(day, app.id, row.event, env.OWNER_ID, row.events, row.value),
        ),
      );
    } catch (error) {
      if (error instanceof AnalyticsUnavailableError) return;
      // One app's rollup failing must not abandon the rest, and must not take the
      // prune that follows down with it.
      console.error(`usage rollup failed for ${app.id}`, error);
    }
  }
}

/**
 * `channels.last_seen` is not touched on the ingest path — doing so would double the
 * steady-state row-write cost of every report for a field nothing reads in real
 * time. It is reconciled here from the issues table instead.
 */
async function refreshChannels(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE channels SET last_seen = COALESCE(
       (SELECT MAX(last_seen) FROM issues WHERE issues.app_id = channels.app_id
          AND issues.last_channel = channels.channel),
       last_seen)`,
  ).run();
}

/**
 * Deletes the R2 objects belonging to a set of issues, then the issues themselves.
 *
 * Order and explicitness both matter. `events` cascades from `issues` and `blobs`
 * cascades from `events`, so deleting an issue silently takes the blob *rows* with
 * it — and the R2 *objects* they pointed at would be orphaned, invisible, and billed
 * forever. The ledger has to be read before it is destroyed.
 */
async function deleteIssuesAndObjects(env: Env, issueIds: string[]): Promise<number> {
  if (issueIds.length === 0) return 0;

  const placeholders = issueIds.map(() => '?').join(', ');
  const { results: objects } = await env.DB.prepare(
    `SELECT b.key FROM blobs b JOIN events e ON e.id = b.event_id
     WHERE e.issue_id IN (${placeholders})`,
  )
    .bind(...issueIds)
    .all<{ key: string }>();

  for (const { key } of objects) {
    await env.BLOBS.delete(key);
  }

  await env.DB.batch(
    issueIds.map(id => env.DB.prepare('DELETE FROM issues WHERE id = ? AND owner_id = ?').bind(id, env.OWNER_ID)),
  );

  return issueIds.length;
}

/**
 * Deletes the data belonging to channels whose scheduled purge has come due.
 *
 * The channel *row* deliberately survives. Deleting it would let the next stray
 * report from an old client recreate it as active — undoing the retirement and
 * starting collection again, which is the opposite of what was asked for.
 */
async function purgeRetiredChannels(env: Env, now: number): Promise<void> {
  const due = await duePurges(env, now);

  for (const channel of due) {
    const { results: issues } = await env.DB.prepare(
      'SELECT id FROM issues WHERE owner_id = ? AND app_id = ? AND last_channel = ? LIMIT ?',
    )
      .bind(env.OWNER_ID, channel.app_id, channel.channel, PRUNE_LIMIT)
      .all<{ id: string }>();

    const deleted = await deleteIssuesAndObjects(
      env,
      issues.map(row => row.id),
    );

    // Events not attached to a surviving issue for this channel (samples whose issue
    // last appeared on a different channel) still belong to it.
    await env.DB.prepare('DELETE FROM events WHERE app_id = ? AND channel = ?')
      .bind(channel.app_id, channel.channel)
      .run();

    console.log(`purged retired channel ${channel.app_id}/${channel.channel}: ${deleted} issue(s)`);

    // Only clear the schedule once a pass completes under the limit, so a channel
    // with more than PRUNE_LIMIT issues keeps being worked on tomorrow.
    if (issues.length < PRUNE_LIMIT) {
      await clearPurgeSchedule(env, channel.app_id, channel.channel);
    }
  }
}

/**
 * Prunes issues that have aged out.
 *
 * Resolved and ignored issues go on `resolvedRetentionDays`. Open ones are only
 * touched if `staleIssueDays` has been deliberately set above zero — an open issue is
 * the triage surface, and silently deleting one is how a real bug gets forgotten.
 */
async function pruneIssues(env: Env, now: number): Promise<void> {
  const config = await loadGovernorConfig(env);

  const closedCutoff = now - config.app.resolvedRetentionDays * 86_400;
  const { results: closed } = await env.DB.prepare(
    `SELECT id FROM issues
     WHERE owner_id = ? AND status IN ('resolved', 'ignored') AND last_seen < ?
     LIMIT ?`,
  )
    .bind(env.OWNER_ID, closedCutoff, PRUNE_LIMIT)
    .all<{ id: string }>();

  const closedDeleted = await deleteIssuesAndObjects(
    env,
    closed.map(row => row.id),
  );
  if (closedDeleted > 0) console.log(`pruned ${closedDeleted} resolved/ignored issue(s)`);

  if (config.app.staleIssueDays > 0) {
    const staleCutoff = now - config.app.staleIssueDays * 86_400;
    const { results: stale } = await env.DB.prepare(
      `SELECT id FROM issues WHERE owner_id = ? AND status = 'open' AND last_seen < ? LIMIT ?`,
    )
      .bind(env.OWNER_ID, staleCutoff, PRUNE_LIMIT)
      .all<{ id: string }>();

    const staleDeleted = await deleteIssuesAndObjects(
      env,
      stale.map(row => row.id),
    );
    if (staleDeleted > 0) console.log(`pruned ${staleDeleted} stale open issue(s)`);
  }
}

async function prune(env: Env, now: number): Promise<void> {
  const config = await loadGovernorConfig(env);
  const cutoff = now - config.app.retentionDays * 86_400;

  // Blobs first, so an interrupted sweep leaves rows pointing at missing objects
  // rather than objects nothing points at — the former is visible in the UI, the
  // latter silently accrues storage cost forever.
  const { results: staleBlobs } = await env.DB.prepare('SELECT key FROM blobs WHERE created_at < ? LIMIT ?')
    .bind(cutoff, PRUNE_LIMIT)
    .all<{ key: string }>();

  for (const { key } of staleBlobs) {
    await env.BLOBS.delete(key);
  }
  if (staleBlobs.length > 0) {
    await env.DB.batch(staleBlobs.map(({ key }) => env.DB.prepare('DELETE FROM blobs WHERE key = ?').bind(key)));
  }

  await env.DB.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? LIMIT ?)')
    .bind(cutoff, PRUNE_LIMIT)
    .run();

  // `issues.sample_count` is the sampler's budget for an issue, and pruning has just
  // removed rows it counts. Without this, a long-lived issue whose samples aged out
  // would sit permanently at its cap and never keep another example again — the bug
  // would only appear one retention period after launch.
  //
  // Only issues whose count actually drifted are rewritten, so the cost is
  // proportional to what was pruned rather than to the size of the table.
  await env.DB.prepare(
    `UPDATE issues SET sample_count = (SELECT COUNT(*) FROM events WHERE events.issue_id = issues.id)
     WHERE sample_count <> (SELECT COUNT(*) FROM events WHERE events.issue_id = issues.id)`,
  ).run();

  // Expired sessions and usage rows are tiny but unbounded if never swept.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('DELETE FROM usage_daily WHERE day < ?')
    .bind(dayKey(now - 400 * 86_400))
    .run();
}
