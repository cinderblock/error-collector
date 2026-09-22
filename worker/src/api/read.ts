/**
 * The dataset API.
 *
 * Aimed squarely at a coding agent working on one of these projects: authenticate
 * with one scoped token, ask one question, get back everything needed to act.
 * `GET /api/digest` is the endpoint that matters — a single call returning the open
 * issues for an app, each already carrying a representative event with its stack,
 * so an agent does not have to walk a list and then fetch each item.
 */

import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';
import { AnalyticsUnavailableError } from '../analytics/sql.js';
import {
  fetchBreakdown,
  fetchSeries,
  parseGroupBy,
  parseInterval,
  type UsageQuery,
} from '../analytics/usage-queries.js';
import { listChannels } from '../storage/channels.js';
import { authenticateReadToken, scopeAllows, scopeFilter, type AuthedToken } from './auth.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_DIGEST_SAMPLES = 1;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Accepts `7d`, `24h`, `90m`, a unix timestamp, or an ISO date. */
export function parseSince(value: string | null, now: number): number | null {
  if (!value) return null;

  const relative = /^(\d+)([smhdw])$/.exec(value.trim());
  if (relative) {
    const scale = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 }[relative[2]!]!;
    return now - Number(relative[1]) * scale;
  }

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds > 10_000_000_000 ? Math.trunc(seconds / 1000) : seconds;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function clampLimit(value: string | null, fallback = DEFAULT_LIMIT): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

interface IssueRow {
  id: string;
  app_id: string;
  fingerprint: string;
  kind: string;
  level: string;
  title: string;
  culprit: string | null;
  status: string;
  count: number;
  attested_count: number;
  sample_count: number;
  first_seen: number;
  last_seen: number;
  first_channel: string;
  last_channel: string;
  first_release: string | null;
  last_release: string | null;
}

interface IssueQuery {
  scope: AuthedToken['scope'];
  app: string | null;
  status: string;
  kind: string | null;
  channel: string | null;
  release: string | null;
  since: number | null;
  search: string | null;
  limit: number;
  offset: number;
}

function readIssueQuery(url: URL, token: AuthedToken, now: number, defaultLimit = DEFAULT_LIMIT): IssueQuery {
  return {
    scope: token.scope,
    app: url.searchParams.get('app'),
    status: url.searchParams.get('status') ?? 'open',
    kind: url.searchParams.get('kind'),
    channel: url.searchParams.get('channel'),
    release: url.searchParams.get('release'),
    since: parseSince(url.searchParams.get('since'), now),
    search: url.searchParams.get('q'),
    limit: clampLimit(url.searchParams.get('limit'), defaultLimit),
    offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0),
  };
}

/** Bindings are accumulated alongside the clauses so their order cannot drift apart. */
function buildIssueSql(query: IssueQuery, ownerId: string): { sql: string; bindings: unknown[] } {
  const scope = scopeFilter(query.scope);
  const where = ['owner_id = ?', scope.sql];
  const bindings: unknown[] = [ownerId, ...scope.bindings];

  if (query.app) {
    where.push('app_id = ?');
    bindings.push(query.app);
  }
  if (query.status !== 'all') {
    where.push('status = ?');
    bindings.push(query.status);
  }
  if (query.kind && query.kind !== 'all') {
    where.push('kind = ?');
    bindings.push(query.kind);
  }
  if (query.channel) {
    where.push('(first_channel = ? OR last_channel = ?)');
    bindings.push(query.channel, query.channel);
  }
  if (query.release) {
    where.push('(first_release = ? OR last_release = ?)');
    bindings.push(query.release, query.release);
  }
  if (query.since !== null) {
    where.push('last_seen >= ?');
    bindings.push(query.since);
  }
  if (query.search) {
    where.push('(title LIKE ? OR culprit LIKE ?)');
    bindings.push(`%${query.search}%`, `%${query.search}%`);
  }

  return {
    sql: `SELECT * FROM issues WHERE ${where.join(' AND ')} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
    bindings: [...bindings, query.limit, query.offset],
  };
}

async function selectIssues(env: Env, query: IssueQuery): Promise<IssueRow[]> {
  const { sql, bindings } = buildIssueSql(query, env.OWNER_ID);
  const { results } = await env.DB.prepare(sql)
    .bind(...bindings)
    .all<IssueRow>();
  return results;
}

interface EventRow {
  id: string;
  issue_id: string;
  app_id: string;
  channel: string;
  ts: number;
  level: string;
  attested: number;
  payload: string;
}

function hydrateEvent(row: EventRow) {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = { _unparseable: true };
  }
  return {
    id: row.id,
    issue_id: row.issue_id,
    app_id: row.app_id,
    channel: row.channel,
    ts: row.ts,
    level: row.level,
    attested: row.attested === 1,
    event: payload,
  };
}

async function samplesFor(env: Env, issueIds: string[], perIssue: number): Promise<Map<string, EventRow[]>> {
  const byIssue = new Map<string, EventRow[]>();
  if (issueIds.length === 0) return byIssue;

  // One query for the whole page rather than one per issue: the same digest built
  // with a query per issue turns a 50-issue page into 51 round trips.
  const placeholders = issueIds.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id, issue_id, app_id, channel, ts, level, attested, payload
     FROM events WHERE issue_id IN (${placeholders}) AND owner_id = ?
     ORDER BY ts DESC`,
  )
    .bind(...issueIds, env.OWNER_ID)
    .all<EventRow>();

  for (const row of results) {
    const bucket = byIssue.get(row.issue_id) ?? [];
    if (bucket.length < perIssue) bucket.push(row);
    byIssue.set(row.issue_id, bucket);
  }
  return byIssue;
}

async function attachmentsFor(env: Env, eventIds: string[]) {
  if (eventIds.length === 0) return new Map<string, { key: string; kind: string; bytes: number }[]>();

  const placeholders = eventIds.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT key, event_id, kind, bytes, content_type FROM blobs WHERE event_id IN (${placeholders}) AND owner_id = ?`,
  )
    .bind(...eventIds, env.OWNER_ID)
    .all<{ key: string; event_id: string; kind: string; bytes: number; content_type: string }>();

  const byEvent = new Map<string, { key: string; kind: string; bytes: number; content_type: string }[]>();
  for (const row of results) {
    const bucket = byEvent.get(row.event_id) ?? [];
    bucket.push({ key: row.key, kind: row.kind, bytes: row.bytes, content_type: row.content_type });
    byEvent.set(row.event_id, bucket);
  }
  return byEvent;
}

export async function handleReadApi(request: Request, env: Env, path: string): Promise<Response> {
  const token = await authenticateReadToken(env, request);
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'a read token is required' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer' },
    });
  }

  const url = new URL(request.url);
  const now = nowSeconds();

  if (path === '/api/apps') {
    // `apps` names the column `id`, not `app_id`, hence the explicit column here.
    const scope = scopeFilter(token.scope, 'id');
    const { results } = await env.DB.prepare(
      `SELECT id, name, created_at FROM apps
       WHERE owner_id = ? AND archived_at IS NULL AND ${scope.sql}
       ORDER BY name`,
    )
      .bind(env.OWNER_ID, ...scope.bindings)
      .all();
    return json({ ok: true, apps: results });
  }

  if (path === '/api/issues') {
    const issues = await selectIssues(env, readIssueQuery(url, token, now));
    return json({ ok: true, count: issues.length, issues });
  }

  if (path.startsWith('/api/issues/')) {
    const issueId = path.slice('/api/issues/'.length);
    const issue = await env.DB.prepare('SELECT * FROM issues WHERE id = ? AND owner_id = ?')
      .bind(issueId, env.OWNER_ID)
      .first<IssueRow>();

    if (!issue || !scopeAllows(token.scope, issue.app_id)) {
      return json({ ok: false, error: 'not found' }, 404);
    }

    const limit = clampLimit(url.searchParams.get('limit'), 20);
    const samples = (await samplesFor(env, [issueId], limit)).get(issueId) ?? [];
    const attachments = await attachmentsFor(
      env,
      samples.map(row => row.id),
    );

    return json({
      ok: true,
      issue,
      events: samples.map(row => ({ ...hydrateEvent(row), attachments: attachments.get(row.id) ?? [] })),
    });
  }

  if (path === '/api/digest') {
    return digest(env, url, token, now);
  }

  if (path === '/api/usage') {
    return usage(env, url, token, now);
  }

  if (path === '/api/channels') {
    const app = url.searchParams.get('app');
    if (app && !scopeAllows(token.scope, app)) return json({ ok: false, error: 'not found' }, 404);

    const channels = (await listChannels(env, app ?? undefined)).filter(c => scopeAllows(token.scope, c.app_id));
    return json({ ok: true, channels });
  }

  if (path.startsWith('/api/blob/')) {
    return serveBlob(env, token, decodeURIComponent(path.slice('/api/blob/'.length)));
  }

  return json({ ok: false, error: 'not found' }, 404);
}

/**
 * Everything an agent needs about an app in one response: the open issues, each with
 * a representative event including its stack, plus what channels and releases are in
 * play. Built to be pasted into a model's context, so it is ordered by recency and
 * capped hard rather than paginated.
 */
async function digest(env: Env, url: URL, token: AuthedToken, now: number): Promise<Response> {
  const app = url.searchParams.get('app');
  if (app && !scopeAllows(token.scope, app)) return json({ ok: false, error: 'not found' }, 404);

  const query = readIssueQuery(url, token, now, 20);
  const issues = await selectIssues(env, query);
  const perIssue = clampLimit(url.searchParams.get('samples'), DEFAULT_DIGEST_SAMPLES);

  const samples = await samplesFor(
    env,
    issues.map(issue => issue.id),
    perIssue,
  );
  const attachments = await attachmentsFor(
    env,
    [...samples.values()].flat().map(row => row.id),
  );

  const scope = scopeFilter(token.scope);
  const { results: channels } = await env.DB.prepare(
    `SELECT app_id, channel, first_seen, last_seen FROM channels
     WHERE owner_id = ? AND ${scope.sql} ${app ? 'AND app_id = ?' : ''}
     ORDER BY last_seen DESC LIMIT 50`,
  )
    .bind(env.OWNER_ID, ...scope.bindings, ...(app ? [app] : []))
    .all();

  return json({
    ok: true,
    generated_at: now,
    app: app ?? null,
    filters: {
      status: query.status,
      kind: query.kind ?? 'all',
      since: query.since,
      channel: query.channel,
      release: query.release,
    },
    channels,
    issues: issues.map(issue => ({
      ...issue,
      events: (samples.get(issue.id) ?? []).map(row => ({
        ...hydrateEvent(row),
        attachments: attachments.get(row.id) ?? [],
      })),
    })),
  });
}

/**
 * Usage analytics, read from Analytics Engine.
 *
 * Note the numbers here are *estimates*: AE samples above roughly 100 data points
 * per second per app and records the inverse rate, which the queries weight by. They
 * are statistically accurate, not exact — good for "how much is this used", wrong
 * for anything you would bill on. Said in the response so a consumer cannot mistake
 * one for the other.
 */
async function usage(env: Env, url: URL, token: AuthedToken, now: number): Promise<Response> {
  const app = url.searchParams.get('app');
  if (!app) return json({ ok: false, error: '`app` is required' }, 400);
  if (!scopeAllows(token.scope, app)) return json({ ok: false, error: 'not found' }, 404);

  const since = parseSince(url.searchParams.get('since'), now) ?? now - 7 * 86_400;
  const interval = parseInterval(url.searchParams.get('interval'));
  const groupBy = parseGroupBy(url.searchParams.get('groupBy'));

  const query: UsageQuery = {
    dataset: env.USAGE_DATASET,
    appId: app,
    since,
    event: url.searchParams.get('event'),
    channel: url.searchParams.get('channel'),
    release: url.searchParams.get('release'),
  };

  try {
    const [series, breakdown] = await Promise.all([
      fetchSeries(env, query, interval),
      fetchBreakdown(env, query, groupBy, clampLimit(url.searchParams.get('limit'))),
    ]);

    return json({
      ok: true,
      app,
      since,
      interval,
      group_by: groupBy,
      sampled: true,
      note: 'Totals are weighted by Analytics Engine’s sample interval: statistically accurate, not exact.',
      series,
      breakdown,
    });
  } catch (error) {
    if (error instanceof AnalyticsUnavailableError) {
      // Writing usage works without the account token; only reading needs it. A
      // fresh deploy legitimately has one and not the other, so this is a
      // configuration answer rather than a server error.
      return json({ ok: false, error: error.message }, 501);
    }
    throw error;
  }
}

async function serveBlob(env: Env, token: AuthedToken, key: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT app_id, content_type FROM blobs WHERE key = ? AND owner_id = ?')
    .bind(key, env.OWNER_ID)
    .first<{ app_id: string; content_type: string }>();

  // Checked against the ledger rather than served straight from R2: the object key
  // embeds the app id, and trusting a caller-supplied key would let any token read
  // any app's screenshots.
  if (!row || !scopeAllows(token.scope, row.app_id)) return json({ ok: false, error: 'not found' }, 404);

  const object = await env.BLOBS.get(key);
  if (!object) return json({ ok: false, error: 'attachment has been pruned' }, 410);

  return new Response(object.body, {
    headers: {
      'content-type': row.content_type,
      'cache-control': 'private, max-age=3600',
      'content-disposition': 'inline',
    },
  });
}
