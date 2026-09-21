/**
 * Turns an untrusted native-dialect body into a `StoredEvent`.
 *
 * Everything arriving here came from a world-open endpoint, so this module assumes
 * the input is hostile: every string is length-capped, every collection is
 * count-capped, and unknown shapes are dropped rather than rejected. A malformed
 * field costs that field, not the whole report — losing a breadcrumb array is much
 * better than losing the crash it was attached to.
 */

import type {
  Breadcrumb,
  ExceptionValue,
  Level,
  ReportKind,
  ReportPayload,
  ReportUser,
  StackFrame,
  StoredEvent,
} from './types.js';
import { LEVELS } from './types.js';

export const LIMITS = {
  message: 8_000,
  exceptionValue: 4_000,
  exceptionType: 200,
  exceptions: 5,
  frames: 100,
  frameString: 500,
  breadcrumbs: 100,
  breadcrumbMessage: 1_000,
  tags: 50,
  tagKey: 64,
  tagValue: 500,
  extraJson: 32_000,
  contexts: 20,
  url: 2_000,
  userField: 256,
  release: 200,
  environment: 64,
  userAgent: 500,
} as const;

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function level(value: unknown, fallback: Level): Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value) ? (value as Level) : fallback;
}

function kind(value: unknown): ReportKind {
  return value === 'feedback' || value === 'message' ? value : 'error';
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function frame(input: unknown): StackFrame | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;

  const out: StackFrame = {};
  const fn = str(raw.function, LIMITS.frameString);
  const filename = str(raw.filename, LIMITS.frameString);
  const module = str(raw.module, LIMITS.frameString);
  if (fn) out.function = fn;
  if (filename) out.filename = filename;
  if (module) out.module = module;

  const lineno = int(raw.lineno);
  const colno = int(raw.colno);
  if (lineno !== undefined) out.lineno = lineno;
  if (colno !== undefined) out.colno = colno;
  if (typeof raw.in_app === 'boolean') out.in_app = raw.in_app;

  return out.function || out.filename || out.module ? out : null;
}

function exceptionValue(input: unknown): ExceptionValue | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;

  const out: ExceptionValue = {};
  const type = str(raw.type, LIMITS.exceptionType);
  const value = str(raw.value, LIMITS.exceptionValue);
  if (type) out.type = type;
  if (value) out.value = value;

  const stacktrace = raw.stacktrace as { frames?: unknown } | undefined;
  const frames = array<unknown>(stacktrace?.frames)
    .slice(0, LIMITS.frames)
    .map(frame)
    .filter((f): f is StackFrame => f !== null);
  if (frames.length > 0) out.stacktrace = { frames };

  return out.type || out.value || out.stacktrace ? out : null;
}

function breadcrumb(input: unknown): Breadcrumb | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;

  const out: Breadcrumb = {};
  const timestamp = int(raw.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;

  const type = str(raw.type, LIMITS.tagValue);
  const category = str(raw.category, LIMITS.tagValue);
  const message = str(raw.message, LIMITS.breadcrumbMessage);
  if (type) out.type = type;
  if (category) out.category = category;
  if (message) out.message = message;
  if (raw.level !== undefined) out.level = level(raw.level, 'info');
  if (typeof raw.data === 'object' && raw.data !== null) out.data = raw.data as Record<string, unknown>;

  return Object.keys(out).length > 0 ? out : null;
}

function tags(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof input !== 'object' || input === null) return out;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= LIMITS.tags) break;
    const k = str(key, LIMITS.tagKey);
    const v = str(typeof value === 'string' ? value : JSON.stringify(value), LIMITS.tagValue);
    if (k && v) out[k] = v;
  }
  return out;
}

/** Bounded by serialized size rather than key count — one enormous value is the
 *  realistic failure mode, not a thousand small ones. */
function extra(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length <= LIMITS.extraJson) return input as Record<string, unknown>;
    return { _truncated: `extra dropped: ${serialized.length} bytes exceeds ${LIMITS.extraJson}` };
  } catch {
    return { _truncated: 'extra dropped: not serializable' };
  }
}

function contexts(input: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (typeof input !== 'object' || input === null) return out;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= LIMITS.contexts) break;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = value as Record<string, unknown>;
    }
  }
  return out;
}

/**
 * Deliberately does **not** carry an IP address. The endpoint is world-open, so
 * anything stored here is stored about strangers; country plus user-agent is enough
 * to debug with and is not a tracking identifier. If per-reporter correlation is
 * ever needed, it should be an opt-in hashed value, not the raw address.
 */
function user(input: unknown): ReportUser | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const raw = input as Record<string, unknown>;

  const out: ReportUser = {};
  const id = str(raw.id, LIMITS.userField);
  const email = str(raw.email, LIMITS.userField);
  const username = str(raw.username, LIMITS.userField);
  if (id) out.id = id;
  if (email) out.email = email;
  if (username) out.username = username;

  return Object.keys(out).length > 0 ? out : undefined;
}

export function generateEventId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export interface NormalizeContext {
  /** Server receive time, unix seconds. Used when the reporter's clock is absent or absurd. */
  now: number;
  userAgent?: string | null;
  country?: string | null;
}

/**
 * A client timestamp is accepted only when it is plausible — inside a day either
 * side of the server clock. Devices with a wrong clock are common enough that
 * trusting them unconditionally scatters events across the timeline.
 */
function timestamp(value: unknown, now: number): number {
  const claimed = int(value);
  if (claimed === undefined) return now;
  // Tolerate milliseconds, which is the single most common reporter mistake.
  const seconds = claimed > 10_000_000_000 ? Math.trunc(claimed / 1000) : claimed;
  return Math.abs(seconds - now) <= 86_400 ? seconds : now;
}

export function normalizeReport(payload: ReportPayload, context: NormalizeContext): StoredEvent {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const reportKind = kind(raw.kind);

  const exceptions = (Array.isArray(raw.exception) ? raw.exception : raw.exception ? [raw.exception] : [])
    .slice(0, LIMITS.exceptions)
    .map(exceptionValue)
    .filter((e): e is ExceptionValue => e !== null);

  const breadcrumbs = array<unknown>(raw.breadcrumbs)
    .slice(-LIMITS.breadcrumbs)
    .map(breadcrumb)
    .filter((b): b is Breadcrumb => b !== null);

  const event: StoredEvent = {
    event_id: generateEventId(),
    kind: reportKind,
    level: level(raw.level, reportKind === 'feedback' ? 'info' : 'error'),
    timestamp: timestamp(raw.timestamp, context.now),
    tags: tags(raw.tags),
    extra: extra(raw.extra),
    contexts: contexts(raw.contexts),
  };

  const message = str(raw.message, LIMITS.message);
  if (message) event.message = message;
  if (exceptions.length > 0) event.exception = { values: exceptions };
  if (breadcrumbs.length > 0) event.breadcrumbs = { values: breadcrumbs };

  const resolvedUser = user(raw.user);
  if (resolvedUser) event.user = resolvedUser;

  const release = str(raw.release, LIMITS.release);
  const environment = str(raw.environment, LIMITS.environment);
  const url = str(raw.url, LIMITS.url);
  if (release) event.release = release;
  if (environment) event.environment = environment;
  if (url) event.url = url;

  if (typeof raw.sdk === 'object' && raw.sdk !== null) {
    const sdk = raw.sdk as Record<string, unknown>;
    const name = str(sdk.name, LIMITS.tagValue);
    const version = str(sdk.version, LIMITS.tagValue);
    if (name && version) event.sdk = { name, version };
  }

  const userAgent = str(context.userAgent, LIMITS.userAgent);
  const country = str(context.country, 8);
  if (userAgent || country) {
    event.request = {};
    if (userAgent) event.request.user_agent = userAgent;
    if (country) event.request.country = country;
  }

  return event;
}

/** A report with neither a message nor an exception carries no information. */
export function isEmptyEvent(event: StoredEvent): boolean {
  return !event.message && !event.exception;
}
