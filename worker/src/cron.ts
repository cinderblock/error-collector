/**
 * Scheduled work.
 *
 * One cron trigger fires every minute and fans out by clock, rather than declaring
 * several triggers, so there is a single place to reason about what runs when.
 *
 * - Every minute: publish the governor's current level for the admin UI.
 * - 04:17 UTC: refresh channel recency, then prune expired events and blobs.
 *
 * Pruning is chunked. A retention sweep that tried to clear a backlog in one pass
 * could spend the entire day's D1 row-write allowance on deletes and leave nothing
 * for ingest — which would be a self-inflicted outage in the name of housekeeping.
 */

import type { Env } from './env.js';
import { dayKey, nowSeconds } from './env.js';
import { levelFor, loadGovernorConfig, publishGovernorState, usageRatio } from './governor.js';
import { readAccountUsage } from './storage/usage.js';

/** Deletes per daily sweep. At 30-day retention this clears a steady 2k events/day. */
const PRUNE_LIMIT = 2_000;

export async function runScheduled(event: ScheduledController, env: Env): Promise<void> {
  const now = nowSeconds();
  const minuteOfDay = new Date(now * 1000).getUTCHours() * 60 + new Date(now * 1000).getUTCMinutes();

  await publishLevel(env, now);

  // 04:17 UTC — deliberately not on the hour, where every other scheduled job is.
  if (minuteOfDay === 4 * 60 + 17) {
    await refreshChannels(env);
    await prune(env, now);
  }

  void event;
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
