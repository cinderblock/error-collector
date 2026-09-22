/**
 * Channels and their lifecycle.
 *
 * A channel is auto-created the first time a valid ingest key presents one — that is
 * the "configurationless" promise, and the key's MAC is what makes it safe, since a
 * stranger cannot mint a key for a channel they invented.
 *
 * Retiring one is the opposite: **always deliberate, never automatic.** A version
 * stops being interesting on a judgement call, not on a date — people update at their
 * own pace, and the entire reason to collect from 1.4.2 is that some of them are
 * still running it. `quietChannels()` exists to *suggest* candidates in the UI;
 * nothing here or in the cron ever retires anything by itself.
 *
 * Status rides along in the cache the ingest path already consults, so knowing
 * whether a channel is retired costs nothing extra per report. The price is that
 * retirement is not instantaneous: a retired channel can keep being accepted for up
 * to `CHANNEL_TTL_SECONDS` while cached copies expire. For a graceful wind-down that
 * is the right trade, but it is a real property and not a rounding error.
 */

import { forget, memo } from '../cache.js';
import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';

export type ChannelStatus = 'active' | 'retired';

/** Short, because it bounds how long a retirement takes to take effect globally. */
const CHANNEL_TTL_SECONDS = 60;

export interface ChannelRow {
  app_id: string;
  channel: string;
  owner_id: string;
  first_seen: number;
  last_seen: number;
  status: ChannelStatus;
  retired_at: number | null;
  purge_after: number | null;
  note: string | null;
}

export interface ResolvedChannel {
  status: ChannelStatus;
  retiredAt: number | null;
  note: string | null;
}

const ACTIVE: ResolvedChannel = { status: 'active', retiredAt: null, note: null };

function cacheKey(appId: string, channel: string): string {
  return `chan:${appId}:${channel}`;
}

/**
 * Resolves a channel, creating it on first sight.
 *
 * Replaces the old `ensureChannel`, which only answered "does it exist". Folding
 * status into the same cached lookup is what keeps the retirement check free: the
 * hot path was already paying for this.
 *
 * `last_seen` is still not written here — that would put a row write on every report
 * for a field nothing reads in real time. The daily cron reconciles it.
 */
export async function resolveChannel(env: Env, appId: string, channel: string): Promise<ResolvedChannel> {
  const key = cacheKey(appId, channel);

  return memo(key, CHANNEL_TTL_SECONDS, async () => {
    const cached = await env.KV.get<ResolvedChannel>(key, { type: 'json', cacheTtl: CHANNEL_TTL_SECONDS });
    if (cached) return cached;

    const row = await env.DB.prepare('SELECT status, retired_at, note FROM channels WHERE app_id = ? AND channel = ?')
      .bind(appId, channel)
      .first<{ status: ChannelStatus; retired_at: number | null; note: string | null }>();

    let resolved: ResolvedChannel;
    if (row) {
      resolved = { status: row.status, retiredAt: row.retired_at, note: row.note };
    } else {
      const now = nowSeconds();
      await env.DB.prepare(
        `INSERT INTO channels (app_id, channel, owner_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (app_id, channel) DO NOTHING`,
      )
        .bind(appId, channel, env.OWNER_ID, now, now)
        .run();
      resolved = ACTIVE;
    }

    // One KV write per channel per TTL, not per report.
    await env.KV.put(key, JSON.stringify(resolved), { expirationTtl: 86_400 });
    return resolved;
  });
}

/** Drops cached status so a lifecycle change is picked up as fast as the TTL allows. */
async function invalidate(env: Env, appId: string, channel: string): Promise<void> {
  const key = cacheKey(appId, channel);
  forget(key);
  await env.KV.delete(key);
}

// ---------------------------------------------------------------------------
// Lifecycle — every one of these is an explicit admin action
// ---------------------------------------------------------------------------

export interface RetireOptions {
  note?: string;
  /** Delete this channel's data after N days. Omit to keep normal retention. */
  purgeAfterDays?: number;
}

export async function retireChannel(
  env: Env,
  appId: string,
  channel: string,
  options: RetireOptions = {},
): Promise<void> {
  const now = nowSeconds();
  const purgeAfter =
    options.purgeAfterDays !== undefined && options.purgeAfterDays > 0
      ? now + Math.trunc(options.purgeAfterDays) * 86_400
      : null;

  await env.DB.prepare(
    `UPDATE channels SET status = 'retired', retired_at = ?, purge_after = ?, note = ?
     WHERE app_id = ? AND channel = ? AND owner_id = ?`,
  )
    .bind(now, purgeAfter, options.note?.slice(0, 200) ?? null, appId, channel, env.OWNER_ID)
    .run();

  await invalidate(env, appId, channel);
}

/** Undoes a retirement, including any scheduled purge. */
export async function reactivateChannel(env: Env, appId: string, channel: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE channels SET status = 'active', retired_at = NULL, purge_after = NULL
     WHERE app_id = ? AND channel = ? AND owner_id = ?`,
  )
    .bind(appId, channel, env.OWNER_ID)
    .run();

  await invalidate(env, appId, channel);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ChannelSummary extends ChannelRow {
  issues: number;
  events: number;
}

/** Channels with the counts that make a retire/keep decision an informed one. */
export async function listChannels(env: Env, appId?: string): Promise<ChannelSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.*,
            (SELECT COUNT(*) FROM issues i WHERE i.app_id = c.app_id AND i.last_channel = c.channel) AS issues,
            (SELECT COUNT(*) FROM events e WHERE e.app_id = c.app_id AND e.channel = c.channel) AS events
     FROM channels c
     WHERE c.owner_id = ? ${appId ? 'AND c.app_id = ?' : ''}
     ORDER BY c.status, c.last_seen DESC`,
  )
    .bind(...(appId ? [env.OWNER_ID, appId] : [env.OWNER_ID]))
    .all<ChannelSummary>();

  return results;
}

/**
 * Channels that have not been seen for a while — *candidates* for retirement.
 *
 * This is the whole extent of the automation: it produces a list for a human to look
 * at. Nothing consumes it to act. Auto-retiring on silence would break exactly the
 * case retirement exists to serve, where an old version is quiet for a fortnight and
 * then a straggler finally hits the bug you were waiting for.
 */
export async function quietChannels(env: Env, days: number, appId?: string): Promise<ChannelSummary[]> {
  const cutoff = nowSeconds() - Math.max(1, days) * 86_400;
  return (await listChannels(env, appId)).filter(c => c.status === 'active' && c.last_seen < cutoff);
}

/** Retired channels whose scheduled purge has come due. */
export async function duePurges(env: Env, now: number): Promise<ChannelRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM channels
     WHERE owner_id = ? AND status = 'retired' AND purge_after IS NOT NULL AND purge_after <= ?`,
  )
    .bind(env.OWNER_ID, now)
    .all<ChannelRow>();
  return results;
}

/** Marks a scheduled purge as done, leaving the channel retired. */
export async function clearPurgeSchedule(env: Env, appId: string, channel: string): Promise<void> {
  await env.DB.prepare('UPDATE channels SET purge_after = NULL WHERE app_id = ? AND channel = ? AND owner_id = ?')
    .bind(appId, channel, env.OWNER_ID)
    .run();
  await invalidate(env, appId, channel);
}
