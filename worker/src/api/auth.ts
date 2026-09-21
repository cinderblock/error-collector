/**
 * Read-token authentication for the agent/CI API.
 *
 * Tokens are stored only as a digest, so this compares digests rather than secrets
 * and a database leak yields nothing replayable.
 */

import { hashReadToken } from '@cinderblock/telemetry-collector-core';
import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';

export interface TokenScope {
  apps: string[];
  write: boolean;
}

export interface AuthedToken {
  hash: string;
  name: string;
  scope: TokenScope;
}

interface TokenRow {
  hash: string;
  name: string;
  scope: string;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

function parseScope(raw: string): TokenScope {
  try {
    const parsed = JSON.parse(raw) as Partial<TokenScope>;
    return {
      apps: Array.isArray(parsed.apps) ? parsed.apps.filter(app => typeof app === 'string') : [],
      write: parsed.write === true,
    };
  } catch {
    // An unparseable scope grants nothing rather than everything.
    return { apps: [], write: false };
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // Convenience for `curl` and for agents that find headers awkward. Query strings
  // land in logs and browser history, so this is a deliberate, documented trade.
  const url = new URL(request.url);
  return url.searchParams.get('token');
}

/**
 * `last_used_at` is refreshed at most hourly. Writing it on every request would add
 * a row write to every read — turning a read-only API into one of the larger
 * consumers of the write budget it is meant to be reporting on.
 */
const TOUCH_INTERVAL_SECONDS = 3_600;

export async function authenticateReadToken(env: Env, request: Request): Promise<AuthedToken | null> {
  const token = bearerToken(request);
  if (!token) return null;

  const hash = await hashReadToken(token);
  const row = await env.DB.prepare(
    'SELECT hash, name, scope, expires_at, last_used_at, revoked_at FROM read_tokens WHERE hash = ? AND owner_id = ?',
  )
    .bind(hash, env.OWNER_ID)
    .first<TokenRow>();

  if (!row || row.revoked_at !== null) return null;

  const now = nowSeconds();
  if (row.expires_at !== null && row.expires_at < now) return null;

  if (row.last_used_at === null || now - row.last_used_at > TOUCH_INTERVAL_SECONDS) {
    await env.DB.prepare('UPDATE read_tokens SET last_used_at = ? WHERE hash = ?').bind(now, hash).run();
  }

  return { hash: row.hash, name: row.name, scope: parseScope(row.scope) };
}

export function scopeAllows(scope: TokenScope, appId: string): boolean {
  return scope.apps.includes('*') || scope.apps.includes(appId);
}

/**
 * The SQL fragment and bindings that restrict a query to a token's apps.
 *
 * Returned as a fragment rather than applied by the caller so that no query can
 * forget it: every list endpoint composes this, and a wildcard token is the only
 * way to get a clause that matches everything.
 */
export function scopeFilter(scope: TokenScope, column = 'app_id'): { sql: string; bindings: string[] } {
  if (scope.apps.includes('*')) return { sql: '1 = 1', bindings: [] };
  if (scope.apps.length === 0) return { sql: '1 = 0', bindings: [] };

  const placeholders = scope.apps.map(() => '?').join(', ');
  return { sql: `${column} IN (${placeholders})`, bindings: [...scope.apps] };
}
