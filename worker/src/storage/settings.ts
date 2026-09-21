/**
 * Runtime configuration, stored as JSON blobs in D1 and read through a KV cache.
 *
 * Defaults self-seed on first read so a fresh deploy needs no manual SQL — the same
 * pattern the ops `uptime` worker uses for its cost thresholds, which has proven out
 * in practice.
 *
 * Writes go to D1 (durable, transactional with the rest of a change) and invalidate
 * the KV copy. Reads come from KV with a short `cacheTtl`, so the hot path costs a
 * cached edge read rather than a database round trip.
 */

import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';

const KV_PREFIX = 'setting:';
const CACHE_TTL_SECONDS = 60;

export async function readSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  const cached = await env.KV.get(`${KV_PREFIX}${key}`, { type: 'json', cacheTtl: CACHE_TTL_SECONDS });
  if (cached !== null) return cached as T;

  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) {
    // Seed so the admin UI has something concrete to edit rather than an empty form.
    await writeSetting(env, key, fallback);
    return fallback;
  }

  let parsed: T;
  try {
    parsed = JSON.parse(row.value) as T;
  } catch {
    // A corrupt row must not take the ingest path down with it.
    return fallback;
  }

  await env.KV.put(`${KV_PREFIX}${key}`, row.value, { expirationTtl: 300 });
  return parsed;
}

export async function writeSetting<T>(env: Env, key: string, value: T): Promise<void> {
  const serialized = JSON.stringify(value);
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, serialized, nowSeconds())
    .run();

  await env.KV.put(`${KV_PREFIX}${key}`, serialized, { expirationTtl: 300 });
}
