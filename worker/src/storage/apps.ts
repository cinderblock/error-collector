/**
 * App records and the channel registry.
 *
 * The channel registry is where the "configurationless" promise is actually kept: a
 * report presenting a valid ingest key for a channel nobody has ever seen creates
 * that channel on the spot. The ingest key's MAC is what makes that safe — a
 * stranger holding a real key for `1.4.2` still cannot mint one for `9.9.9`, so this
 * cannot be used to fill the table with junk.
 */

import { generateAppSecret, isValidAppId } from '@cinderblock/telemetry-collector-core';
import { forget, memo } from '../cache.js';
import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';
import { openSecret, sealSecret } from './secrets.js';

export interface AppRecord {
  id: string;
  owner_id: string;
  name: string;
  secret: string;
  settings: string;
  created_at: number;
  archived_at: number | null;
}

const APP_TTL_SECONDS = 60;
const CHANNEL_TTL_SECONDS = 300;

export function loadApp(env: Env, appId: string): Promise<AppRecord | null> {
  if (!isValidAppId(appId)) return Promise.resolve(null);

  return memo(`app:${appId}`, APP_TTL_SECONDS, async () => {
    const row = await env.DB.prepare('SELECT * FROM apps WHERE id = ? AND archived_at IS NULL')
      .bind(appId)
      .first<AppRecord>();
    return row ?? null;
  });
}

/**
 * Returns the app's secret in plaintext, or `null` if the app is unknown or the
 * stored ciphertext does not open — which means `SECRET_KEK` has changed and is a
 * configuration error, not an attack, so it must be loud in the logs.
 */
export async function loadAppSecret(env: Env, appId: string): Promise<string | null> {
  const app = await loadApp(env, appId);
  if (!app) return null;

  if (!env.SECRET_KEK) {
    console.error('SECRET_KEK is not configured; no ingest key can be verified');
    return null;
  }

  const secret = await openSecret(env.SECRET_KEK, app.secret);
  if (!secret) {
    console.error(`app ${appId}: stored secret did not decrypt — has SECRET_KEK changed?`);
    return null;
  }
  return secret;
}

export interface CreatedApp {
  app: AppRecord;
  /** Shown to the developer exactly once; never recoverable afterwards. */
  secret: string;
}

export async function createApp(env: Env, id: string, name: string): Promise<CreatedApp> {
  if (!isValidAppId(id)) throw new Error(`invalid app id: ${JSON.stringify(id)}`);
  if (!env.SECRET_KEK) throw new Error('SECRET_KEK is not configured');

  const secret = generateAppSecret();
  const record: AppRecord = {
    id,
    owner_id: env.OWNER_ID,
    name,
    secret: await sealSecret(env.SECRET_KEK, secret),
    settings: '{}',
    created_at: nowSeconds(),
    archived_at: null,
  };

  await env.DB.prepare('INSERT INTO apps (id, owner_id, name, secret, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(record.id, record.owner_id, record.name, record.secret, record.settings, record.created_at)
    .run();

  forget(`app:${id}`);
  return { app: record, secret };
}

/**
 * Rotating an app secret invalidates every ingest key derived from it, including the
 * ones compiled into copies of the app already in users' hands. Those clients go
 * silent until they ship a rebuild. That is the correct behaviour for a compromised
 * secret and the wrong behaviour for routine hygiene, so the admin UI has to say so.
 */
export async function rotateAppSecret(env: Env, appId: string): Promise<string> {
  if (!env.SECRET_KEK) throw new Error('SECRET_KEK is not configured');

  const secret = generateAppSecret();
  await env.DB.prepare('UPDATE apps SET secret = ? WHERE id = ? AND owner_id = ?')
    .bind(await sealSecret(env.SECRET_KEK, secret), appId, env.OWNER_ID)
    .run();

  forget(`app:${appId}`);
  return secret;
}

export function listApps(env: Env): Promise<D1Result<AppRecord>> {
  return env.DB.prepare('SELECT * FROM apps WHERE owner_id = ? AND archived_at IS NULL ORDER BY name')
    .bind(env.OWNER_ID)
    .all<AppRecord>();
}
