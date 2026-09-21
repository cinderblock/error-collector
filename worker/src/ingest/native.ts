/**
 * The native ingest dialect.
 *
 *   POST /i/<ingestKey>            JSON body, or multipart when there's a screenshot
 *
 * World-open by design: the ingest key is public, so this endpoint authenticates
 * nothing. What the key's MAC does buy is that a stranger cannot invent *new*
 * channels for an app, which is what makes zero-registration provisioning safe.
 * Everything else that protects the service lives here instead — rate limits, size
 * caps, per-app quotas and the budget governor.
 */

import {
  isValidChannel,
  normalizeReport,
  isEmptyEvent,
  parseIngestKey,
  resolveFingerprint,
  verifyIngestKey,
  verifyReportSignature,
  type ReportPayload,
} from '@cinderblock/error-collector-core';
import type { Env } from '../env.js';
import { dayKey, nowSeconds } from '../env.js';
import { decideStorage, levelFor, loadGovernorConfig } from '../governor.js';
import { ensureChannel, loadAppSecret } from '../storage/apps.js';
import {
  loadExistingIssue,
  recordRejection,
  recordReport,
  type BlobKind,
  type PendingBlob,
} from '../storage/reports.js';
import { readStoredBytes, readUsagePair, toAccountUsage } from '../storage/usage.js';

const CORS_HEADERS: Record<string, string> = {
  // The endpoint is meant to be callable from any page of any app being developed,
  // and it holds no ambient credentials, so there is nothing for a permissive
  // origin policy to leak. Credentials are explicitly not allowed.
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

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const BLOB_FIELDS: Record<string, BlobKind> = {
  screenshot: 'screenshot',
  har: 'har',
  console: 'console',
  attachment: 'attachment',
};

interface ParsedBody {
  payload: ReportPayload;
  /** The exact text an attestation signature covers. */
  signedText: string;
  blobs: PendingBlob[];
}

async function parseBody(request: Request, maxBlobBytes: number): Promise<ParsedBody | { error: string }> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const reportField = form.get('report');
    const signedText = typeof reportField === 'string' ? reportField : '{}';

    let payload: ReportPayload;
    try {
      payload = JSON.parse(signedText) as ReportPayload;
    } catch {
      return { error: 'the `report` field must be JSON' };
    }

    const blobs: PendingBlob[] = [];
    for (const [field, kind] of Object.entries(BLOB_FIELDS)) {
      const file = form.get(field);
      if (!file || typeof file === 'string') continue;
      if (file.size > maxBlobBytes) return { error: `${field} exceeds ${maxBlobBytes} bytes` };
      blobs.push({ kind, contentType: file.type || 'application/octet-stream', body: await file.arrayBuffer() });
    }

    return { payload, signedText, blobs };
  }

  const text = await request.text();
  try {
    return { payload: JSON.parse(text) as ReportPayload, signedText: text, blobs: [] };
  } catch {
    return { error: 'body must be JSON' };
  }
}

export async function handleIngest(request: Request, env: Env, ingestKey: string): Promise<Response> {
  const parsed = parseIngestKey(ingestKey);
  if (!parsed) return json({ ok: false, error: 'malformed ingest key' }, 400);
  if (!isValidChannel(parsed.channel)) return json({ ok: false, error: 'malformed channel' }, 400);

  const secret = await loadAppSecret(env, parsed.appId);
  // Deliberately the same answer for "no such app" and "bad MAC": the endpoint is
  // public, and distinguishing them would turn it into an app-name oracle.
  if (!secret) return json({ ok: false, error: 'unknown ingest key' }, 401);

  const verified = await verifyIngestKey(secret, ingestKey);
  if (!verified) return json({ ok: false, error: 'unknown ingest key' }, 401);

  const now = nowSeconds();
  const day = dayKey(now);
  const config = await loadGovernorConfig(env);

  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.INGEST_LIMIT.limit({ key: `${parsed.appId}:${clientIp}` });
  if (!success) {
    return json({ ok: false, error: 'rate limited' }, 429, { 'retry-after': '60' });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > config.app.maxBodyBytes + config.app.maxBlobBytes) {
    return json({ ok: false, error: 'payload too large' }, 413);
  }

  const usage = await readUsagePair(env, day, parsed.appId);
  if (usage.app.reports >= config.app.maxReportsPerDay) {
    // A per-app cap, so one runaway app cannot consume the whole account's budget
    // and blind every other app for the rest of the day.
    await recordRejection(env, day, parsed.appId);
    return json({ ok: false, error: 'daily quota reached for this app' }, 429, { 'retry-after': '3600' });
  }

  const body = await parseBody(request, config.app.maxBlobBytes);
  if ('error' in body) return json({ ok: false, error: body.error }, 400);

  const event = normalizeReport(body.payload, {
    now,
    userAgent: request.headers.get('user-agent'),
    country: request.headers.get('cf-ipcountry'),
  });
  if (isEmptyEvent(event)) {
    return json({ ok: false, error: 'report needs a message or an exception' }, 400);
  }

  // Optional attestation. A reporter that legitimately holds the app secret — a
  // server, a CLI, a CI job — can sign, and its reports are marked so triage can
  // filter out everything that merely arrived from the internet.
  const signature = request.headers.get('x-report-signature');
  const signedAt = Number(request.headers.get('x-report-timestamp') ?? 'NaN');
  const attested = signature ? await verifyReportSignature(secret, signedAt, body.signedText, signature, now) : false;
  if (signature && !attested) {
    // Failing closed matters here: silently downgrading a bad signature to an
    // unsigned report would make a broken signing setup invisible.
    return json({ ok: false, error: 'invalid report signature' }, 401);
  }

  const fingerprint = await resolveFingerprint(event, parsed.appId, event.event_id, body.payload.fingerprint);
  const existing = await loadExistingIssue(env, fingerprint);

  const level = levelFor(toAccountUsage(usage.account, await readStoredBytes(env)), config.account);
  const decision = decideStorage({
    level,
    budget: config.app,
    attested,
    existing: existing
      ? { count: existing.count, sampleCount: existing.sampleCount, lastRelease: existing.lastRelease }
      : null,
    release: event.release ?? null,
    hasBlobs: body.blobs.length > 0,
  });

  if (!decision.accept) {
    await recordRejection(env, day, parsed.appId);
    return json({ ok: false, error: decision.reason }, 429, { 'retry-after': '3600' });
  }

  await ensureChannel(env, parsed.appId, parsed.channel);

  const result = await recordReport(env, {
    appId: parsed.appId,
    channel: parsed.channel,
    event,
    fingerprint,
    attested,
    blobs: body.blobs,
    decision,
    now,
    day,
  });

  // Written last and unconditionally: this is the meter the governor reads, so the
  // true volume survives even when almost none of the detail was stored.
  env.AE.writeDataPoint({
    indexes: [parsed.appId],
    blobs: [parsed.channel, result.issueId, event.kind, event.level, event.release ?? '', result.stored],
    doubles: [1, result.rowsWritten, result.blobBytes],
  });

  return json(
    {
      ok: true,
      event_id: event.event_id,
      issue_id: result.issueId,
      stored: result.stored,
      detail: decision.reason,
    },
    202,
  );
}
