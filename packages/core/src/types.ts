/**
 * The event model.
 *
 * Shaped after Sentry's event payload on purpose. The native ingest dialect is
 * flatter and friendlier to hand-written `curl` calls, but it normalizes into
 * exactly this structure — so when the Sentry envelope dialect lands (phase 2) it
 * writes the same rows and needs no migration.
 */

export type ReportKind = 'error' | 'feedback' | 'message';

export type Level = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export const LEVELS: readonly Level[] = ['fatal', 'error', 'warning', 'info', 'debug'];

export interface StackFrame {
  function?: string;
  filename?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  /** False for framework/vendor frames — they are skipped when picking a culprit. */
  in_app?: boolean;
}

export interface ExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: { frames: StackFrame[] };
}

export interface Breadcrumb {
  timestamp?: number;
  type?: string;
  category?: string;
  level?: Level;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ReportUser {
  id?: string;
  email?: string;
  username?: string;
}

/** The native ingest dialect's request body. Every field is optional but one of
 *  `message` / `exception` must be present for the report to mean anything. */
export interface ReportPayload {
  kind?: ReportKind;
  level?: Level;
  message?: string;
  /** Accepts a single exception or a chain (innermost last, as Sentry orders them). */
  exception?: ExceptionValue | ExceptionValue[];
  breadcrumbs?: Breadcrumb[];
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: ReportUser;
  contexts?: Record<string, Record<string, unknown>>;
  /** Free-form release identifier. Distinct from the ingest key's channel, which is
   *  the *routing* dimension; a channel of `prod` can carry many releases. */
  release?: string;
  environment?: string;
  /** Unix seconds. Server clock wins if this is missing or implausible. */
  timestamp?: number;
  url?: string;
  /** Explicit grouping override. When set, replaces the derived fingerprint. */
  fingerprint?: string[];
  sdk?: { name: string; version: string };
}

/** The normalized, stored form. */
export interface StoredEvent {
  event_id: string;
  kind: ReportKind;
  level: Level;
  timestamp: number;
  message?: string;
  exception?: { values: ExceptionValue[] };
  breadcrumbs?: { values: Breadcrumb[] };
  tags: Record<string, string>;
  extra: Record<string, unknown>;
  user?: ReportUser;
  contexts: Record<string, Record<string, unknown>>;
  release?: string;
  environment?: string;
  url?: string;
  sdk?: { name: string; version: string };
  request?: {
    /** Coarse client hints only — never the raw IP. See `privacy.ts`. */
    user_agent?: string;
    country?: string;
  };
}

export type IssueStatus = 'open' | 'resolved' | 'ignored';

export interface Issue {
  id: string;
  app_id: string;
  fingerprint: string;
  kind: ReportKind;
  level: Level;
  title: string;
  culprit: string | null;
  status: IssueStatus;
  count: number;
  first_seen: number;
  last_seen: number;
  first_channel: string;
  last_channel: string;
  first_release: string | null;
  last_release: string | null;
  attested_count: number;
}

export interface BlobKind {
  kind: 'screenshot' | 'har' | 'console' | 'attachment';
}

export interface StoredBlob {
  key: string;
  event_id: string;
  kind: BlobKind['kind'];
  bytes: number;
  content_type: string;
  created_at: number;
}

/** What the ingest endpoint returns. `stored` reflects how much detail survived the
 *  budget governor, so a reporter can tell "counted but not stored" from "dropped". */
export interface IngestResponse {
  ok: true;
  event_id: string;
  issue_id: string | null;
  stored: 'full' | 'issue-only' | 'counted';
}
