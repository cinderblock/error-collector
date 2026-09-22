/**
 * The usage dialect.
 *
 *   POST /u/<ingestKey>    { event, value?, dims? }  or  { events: [ … ] }
 *
 * **Writes one Analytics Engine data point per event and touches D1 not at all.**
 * That is the whole design. See `@cinderblock/telemetry-collector-core/usage` for
 * why, and for the field layout.
 *
 * Two deliberate differences from the error path:
 *
 * 1. **Usage is shed first.** When the account is over budget, usage stops being
 *    accepted well before errors do. A dropped pageview costs you a rounding error
 *    in a chart; a dropped crash costs you the bug. Usage is the expendable signal
 *    and should behave like it.
 *
 * 2. **The budget is read from the cron-published KV state, not from D1.** The error
 *    path reads `usage_daily` directly because a minute of staleness during a flood
 *    is thousands of reports and D1 writes are the thing being protected. Here there
 *    are no D1 writes at all to protect, the only cost of over-accepting for a
 *    minute is some free AE points, and a D1 round trip on every pageview would be
 *    the single most expensive thing in an otherwise free path.
 */

import {
  MAX_EVENTS_PER_REQUEST,
  buildUsageDataPoint,
  isValidChannel,
  normalizeUsageEvent,
  parseIngestKey,
  verifyIngestKey,
  verifyReportSignature,
  type NormalizedUsageEvent,
} from '@cinderblock/telemetry-collector-core';
import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';
import { readGovernorState, type GovernorLevel } from '../governor.js';
import { loadAppSecret } from '../storage/apps.js';
import { resolveChannel } from '../storage/channels.js';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-report-signature, x-report-timestamp',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

export function usagePreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Usage is accepted only while there is comfortable headroom. */
export function usageAccepted(level: GovernorLevel): boolean {
  return level === 'full' || level === 'reduced';
}

function extractEvents(body: unknown): NormalizedUsageEvent[] {
  const raw = body as { events?: unknown } | null;
  const list = Array.isArray(raw?.events) ? raw.events : [body];

  return list
    .slice(0, MAX_EVENTS_PER_REQUEST)
    .map(normalizeUsageEvent)
    .filter((event): event is NormalizedUsageEvent => event !== null);
}

function countSubmitted(body: unknown): number {
  const raw = body as { events?: unknown } | null;
  return Array.isArray(raw?.events) ? raw.events.length : 1;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export async function handleUsage(request: Request, env: Env, ingestKey: string): Promise<Response> {
  const parsed = parseIngestKey(ingestKey);
  if (!parsed) return json({ ok: false, error: 'malformed ingest key' }, 400);
  if (!isValidChannel(parsed.channel)) return json({ ok: false, error: 'malformed channel' }, 400);

  const secret = await loadAppSecret(env, parsed.appId);
  // Same opaque answer as the error path: distinguishing "no such app" from "bad
  // MAC" would turn a public endpoint into an app-name oracle.
  if (!secret) return json({ ok: false, error: 'unknown ingest key' }, 401);
  if (!(await verifyIngestKey(secret, ingestKey))) return json({ ok: false, error: 'unknown ingest key' }, 401);

  // Retirement applies to usage exactly as it does to errors — a retired version
  // should go quiet altogether, not half of it.
  const channel = await resolveChannel(env, parsed.appId, parsed.channel);
  if (channel.status === 'retired') {
    return json(
      {
        ok: false,
        error: 'channel retired',
        detail: channel.note ?? 'This version is no longer collecting telemetry.',
        retired_at: channel.retiredAt,
      },
      410,
    );
  }

  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.INGEST_LIMIT.limit({ key: `u:${parsed.appId}:${clientIp}` });
  if (!success) return json({ ok: false, error: 'rate limited' }, 429, { 'retry-after': '60' });

  const level = (await readGovernorState(env))?.level ?? 'full';
  if (!usageAccepted(level)) {
    // 202, not 429. There is nothing useful for a client to retry — the budget will
    // not recover within any sensible backoff — and a retry storm from every app is
    // the last thing an account that is already over budget needs.
    return json({ ok: true, accepted: 0, reason: `usage paused: budget level is ${level}` }, 202);
  }

  const text = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const signature = request.headers.get('x-report-signature');
  if (signature) {
    const signedAt = Number(request.headers.get('x-report-timestamp') ?? 'NaN');
    if (!(await verifyReportSignature(secret, signedAt, text, signature, nowSeconds()))) {
      return json({ ok: false, error: 'invalid report signature' }, 401);
    }
  }

  const submitted = countSubmitted(body);
  const events = extractEvents(body);
  if (events.length === 0) {
    return json({ ok: false, error: 'no valid events — each needs a lowercase dotted `event` name' }, 400);
  }

  const envelope = body as { release?: unknown; environment?: unknown };
  const release = str(envelope.release, 200);
  const environment = str(envelope.environment, 64);

  for (const event of events) {
    env.USAGE.writeDataPoint(
      buildUsageDataPoint({
        appId: parsed.appId,
        channel: parsed.channel,
        release,
        environment,
        event,
      }),
    );
  }

  // `dropped` is how many were rejected as malformed or trimmed past the batch cap.
  // Surfaced rather than silent: an SDK sending a field name we reject would
  // otherwise just see its numbers quietly fail to appear.
  const dropped = Math.max(0, submitted - events.length);
  return json(
    dropped > 0 ? { ok: true, accepted: events.length, dropped } : { ok: true, accepted: events.length },
    202,
  );
}
