/**
 * The ingest write path.
 *
 * Steady state for a report whose issue already exists is **two row writes** — the
 * issue upsert and the usage counter — batched into one D1 round trip. Ten thousand
 * copies of one crash therefore cost ten thousand counter increments, not ten
 * thousand inserts, and the true total is preserved in Analytics Engine regardless
 * of how little of it reaches D1.
 */

import { culpritFor, titleFor, type StoredEvent } from '@tomsawyerlabs/error-collector-core';
import type { Env } from '../env.js';
import type { StorageDecision } from '../governor.js';

export type BlobKind = 'screenshot' | 'har' | 'console' | 'attachment';

export interface PendingBlob {
  kind: BlobKind;
  contentType: string;
  body: ArrayBuffer;
}

export interface ExistingIssue {
  id: string;
  count: number;
  sampleCount: number;
  lastRelease: string | null;
  status: string;
}

export interface RecordInput {
  appId: string;
  channel: string;
  event: StoredEvent;
  fingerprint: string;
  attested: boolean;
  blobs: PendingBlob[];
  decision: StorageDecision;
  now: number;
  day: string;
}

export interface RecordResult {
  issueId: string;
  stored: 'full' | 'issue-only' | 'counted';
  rowsWritten: number;
  blobBytes: number;
}

/** See the note in 0001_init.sql: the issue id is derived so it is known before the write. */
export function issueIdFor(fingerprint: string): string {
  return fingerprint.slice(0, 32);
}

export async function loadExistingIssue(env: Env, fingerprint: string): Promise<ExistingIssue | null> {
  const row = await env.DB.prepare(
    'SELECT id, count, sample_count, last_release, status FROM issues WHERE id = ? AND owner_id = ?',
  )
    .bind(issueIdFor(fingerprint), env.OWNER_ID)
    .first<{ id: string; count: number; sample_count: number; last_release: string | null; status: string }>();

  if (!row) return null;
  return {
    id: row.id,
    count: row.count,
    sampleCount: row.sample_count,
    lastRelease: row.last_release,
    status: row.status,
  };
}

/**
 * `status` is the only column with non-obvious update logic. A resolved issue
 * reopens when it recurs on a release *other* than the one it was resolved in —
 * events still trickling in from the old build during a staged rollout are exactly
 * what "resolved in 1.4.3" means, and reopening on those would make the status
 * useless. An issue resolved without a release recorded reopens on any recurrence.
 */
const UPSERT_ISSUE = `
INSERT INTO issues (
  id, owner_id, app_id, fingerprint, kind, level, title, culprit, status,
  count, attested_count, sample_count,
  first_seen, last_seen, first_channel, last_channel, first_release, last_release
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  count          = count + 1,
  attested_count = attested_count + excluded.attested_count,
  sample_count   = sample_count + excluded.sample_count,
  level          = excluded.level,
  title          = excluded.title,
  culprit        = COALESCE(excluded.culprit, culprit),
  last_seen      = excluded.last_seen,
  last_channel   = excluded.last_channel,
  last_release   = COALESCE(excluded.last_release, last_release),
  status         = CASE
                     WHEN status = 'resolved'
                      AND (resolved_in IS NULL OR excluded.last_release IS NULL OR excluded.last_release <> resolved_in)
                     THEN 'open'
                     ELSE status
                   END`;

const INSERT_EVENT = `
INSERT INTO events (id, owner_id, issue_id, app_id, channel, ts, level, attested, payload)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO NOTHING`;

const INSERT_BLOB = `
INSERT INTO blobs (key, owner_id, event_id, app_id, kind, bytes, content_type, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (key) DO NOTHING`;

const BUMP_USAGE = `
INSERT INTO usage_daily (day, app_id, reports, stored, rows_written, blob_bytes, dropped, rejected)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (day, app_id) DO UPDATE SET
  reports      = reports + excluded.reports,
  stored       = stored + excluded.stored,
  rows_written = rows_written + excluded.rows_written,
  blob_bytes   = blob_bytes + excluded.blob_bytes,
  dropped      = dropped + excluded.dropped,
  rejected     = rejected + excluded.rejected`;

export interface UsageDelta {
  reports: number;
  stored: number;
  rowsWritten: number;
  blobBytes: number;
  dropped: number;
  rejected: number;
}

/** Two rows per call — the app's own tally and the account-wide roll-up under `''`. */
export function usageStatements(env: Env, day: string, appId: string, delta: UsageDelta): D1PreparedStatement[] {
  const bind = (scope: string) =>
    env.DB.prepare(BUMP_USAGE).bind(
      day,
      scope,
      delta.reports,
      delta.stored,
      delta.rowsWritten,
      delta.blobBytes,
      delta.dropped,
      delta.rejected,
    );
  return [bind(appId), bind('')];
}

function blobKey(appId: string, day: string, eventId: string, kind: BlobKind, index: number): string {
  return `${appId}/${day}/${eventId}/${index}-${kind}`;
}

export async function recordReport(env: Env, input: RecordInput): Promise<RecordResult> {
  const { appId, channel, event, fingerprint, attested, decision, now, day } = input;
  const issueId = issueIdFor(fingerprint);

  if (!decision.storeIssue && !decision.storeEvent) {
    // Counted in Analytics Engine only. Still tally usage so per-app quotas and the
    // admin view reflect reality rather than only what survived.
    await env.DB.batch(
      usageStatements(env, day, appId, {
        reports: 1,
        stored: 0,
        rowsWritten: 2,
        blobBytes: 0,
        dropped: 1,
        rejected: 0,
      }),
    );
    return { issueId, stored: 'counted', rowsWritten: 2, blobBytes: 0 };
  }

  // Blobs go to R2 before the batch so their byte counts are known. A batch that
  // subsequently fails leaves an orphan object, which the retention cron sweeps —
  // preferable to a D1 row pointing at an object that was never written.
  const uploaded: { key: string; blob: PendingBlob }[] = [];
  if (decision.storeBlobs) {
    for (const [index, blob] of input.blobs.entries()) {
      const key = blobKey(appId, day, event.event_id, blob.kind, index);
      await env.BLOBS.put(key, blob.body, { httpMetadata: { contentType: blob.contentType } });
      uploaded.push({ key, blob });
    }
  }
  const blobBytes = uploaded.reduce((total, item) => total + item.blob.body.byteLength, 0);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(UPSERT_ISSUE).bind(
      issueId,
      env.OWNER_ID,
      appId,
      fingerprint,
      event.kind,
      event.level,
      titleFor(event),
      culpritFor(event),
      attested ? 1 : 0,
      decision.storeEvent ? 1 : 0,
      event.timestamp,
      event.timestamp,
      channel,
      channel,
      event.release ?? null,
      event.release ?? null,
    ),
  ];

  if (decision.storeEvent) {
    statements.push(
      env.DB.prepare(INSERT_EVENT).bind(
        event.event_id,
        env.OWNER_ID,
        issueId,
        appId,
        channel,
        event.timestamp,
        event.level,
        attested ? 1 : 0,
        JSON.stringify(event),
      ),
    );
    for (const { key, blob } of uploaded) {
      statements.push(
        env.DB.prepare(INSERT_BLOB).bind(
          key,
          env.OWNER_ID,
          event.event_id,
          appId,
          blob.kind,
          blob.body.byteLength,
          blob.contentType,
          now,
        ),
      );
    }
  }

  // +2 for the usage rows appended below.
  const rowsWritten = statements.length + 2;
  statements.push(
    ...usageStatements(env, day, appId, {
      reports: 1,
      stored: decision.storeEvent ? 1 : 0,
      rowsWritten,
      blobBytes,
      dropped: decision.storeEvent ? 0 : 1,
      rejected: 0,
    }),
  );

  await env.DB.batch(statements);

  return {
    issueId,
    stored: decision.storeEvent ? 'full' : 'issue-only',
    rowsWritten,
    blobBytes,
  };
}

/** Called when a report is refused, so refusals are visible rather than silent. */
export async function recordRejection(env: Env, day: string, appId: string): Promise<void> {
  await env.DB.batch(
    usageStatements(env, day, appId, {
      reports: 0,
      stored: 0,
      rowsWritten: 2,
      blobBytes: 0,
      dropped: 0,
      rejected: 1,
    }),
  );
}
