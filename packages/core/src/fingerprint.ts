/**
 * Grouping.
 *
 * Coalescing is what makes this service cheap: 10,000 copies of one crash must cost
 * one row update, not 10,000 inserts. The fingerprint is the grouping key.
 *
 * Two deliberate choices:
 *
 * - **The channel and release are NOT part of the fingerprint.** An issue is meant to
 *   span versions, so the admin view can say "this started in 1.4.2 and is still
 *   happening in 1.4.4". `first_channel` / `last_channel` carry that instead.
 * - **Line and column numbers are NOT part of the fingerprint.** They shift on every
 *   unrelated edit to the file, which would fragment one long-lived issue into a new
 *   one per build.
 *
 * Normalization is deliberately moderate. Over-normalizing silently merges unrelated
 * bugs (lossy, and very hard to notice); under-normalizing shatters one bug into
 * thousands (noisy, but obvious). When the default is wrong, a reporter can send an
 * explicit `fingerprint` array, which wins outright.
 */

import { sha256Hex } from './keys.js';
import type { ExceptionValue, ReportKind, StackFrame, StoredEvent } from './types.js';

/** How many innermost frames contribute to the fingerprint. */
const FINGERPRINT_FRAMES = 5;

const NORMALIZERS: readonly (readonly [RegExp, string])[] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'],
  [/\bhttps?:\/\/[^\s'"`)]+/gi, '<url>'],
  [/\b0x[0-9a-f]+\b/gi, '<hex>'],
  [/\b[0-9a-f]{8,}\b/gi, '<hex>'],
  [/\b\d+(?:\.\d+)*\b/g, '<n>'],
];

/**
 * Collapses the parts of a message that vary per occurrence — ids, addresses,
 * counters — while leaving the parts that identify the bug.
 *
 * Quoted substrings are intentionally left alone: in `Cannot read property 'foo' of
 * undefined`, the `'foo'` usually *is* the distinguishing detail.
 */
export function normalizeMessage(message: string): string {
  let out = message.trim().slice(0, 1000);
  for (const [pattern, replacement] of NORMALIZERS) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ');
}

function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Strips query strings and cache-busting hashes so `app.4f3a1b.js` groups with `app.9cd02e.js`. */
function normalizeFilename(filename: string): string {
  const name = basename(filename.split('?')[0]!.split('#')[0]!);
  return name.replace(/[.-][0-9a-f]{6,}(?=\.[a-z]+$)/i, '');
}

function frameIdentity(frame: StackFrame): string {
  const where = frame.module ?? (frame.filename ? normalizeFilename(frame.filename) : '?');
  return `${where}:${frame.function ?? '?'}`;
}

/**
 * Frames follow Sentry's ordering convention: **oldest first, innermost last**. The
 * innermost frames are the ones that identify the bug, so we take from the end.
 *
 * (Browser `Error.stack` is the opposite order — innermost first. SDKs are
 * responsible for reversing before handing an event over. Getting this backwards
 * silently produces fingerprints built from `main()`, which group everything
 * together, so it is worth being explicit.)
 */
function significantFrames(frames: StackFrame[]): StackFrame[] {
  const inApp = frames.filter(frame => frame.in_app !== false);
  const pool = inApp.length > 0 ? inApp : frames;
  return pool.slice(-FINGERPRINT_FRAMES);
}

/**
 * The exception a human (and the fingerprint) should key on.
 *
 * Sentry orders `exception.values` oldest-first, so the last entry is the error
 * actually thrown and the earlier ones are the causes it wrapped. Keying on the
 * thrown error keeps two unrelated bugs that both wrap, say, an `ECONNRESET` from
 * collapsing into one issue.
 */
function primaryException(exception: ExceptionValue[] | undefined): ExceptionValue | undefined {
  return exception && exception.length > 0 ? exception[exception.length - 1] : undefined;
}

/**
 * The material the fingerprint hashes. Returned separately from the hash so tests
 * (and the admin UI's "why is this grouped here?" view) can show the reasoning.
 */
export function fingerprintComponents(event: StoredEvent, appId: string): string[] {
  const parts = [`app:${appId}`, `kind:${event.kind}`];

  const exception = primaryException(event.exception?.values);
  const frames = exception?.stacktrace?.frames ?? [];

  if (exception) {
    parts.push(`type:${exception.type ?? 'Error'}`);
    if (frames.length > 0) {
      for (const frame of significantFrames(frames)) parts.push(`frame:${frameIdentity(frame)}`);
    } else {
      // No stack to group on, so the message has to carry it.
      parts.push(`message:${normalizeMessage(exception.value ?? '')}`);
    }
  } else {
    parts.push(`message:${normalizeMessage(event.message ?? '')}`);
  }

  return parts;
}

/**
 * Feedback never coalesces — two people reporting "the button is broken" are two
 * things to read, not one thing seen twice. `seed` makes each submission distinct.
 */
function isUngrouped(kind: ReportKind): boolean {
  return kind === 'feedback';
}

export async function computeFingerprint(event: StoredEvent, appId: string, seed: string): Promise<string> {
  if (isUngrouped(event.kind)) return sha256Hex(`app:${appId}\nkind:feedback\nseed:${seed}`);
  return sha256Hex(fingerprintComponents(event, appId).join('\n'));
}

/** Honors an explicit `fingerprint` override from the reporter. */
export async function resolveFingerprint(
  event: StoredEvent,
  appId: string,
  seed: string,
  override?: string[],
): Promise<string> {
  if (override && override.length > 0) {
    return sha256Hex([`app:${appId}`, ...override.map(part => `custom:${part}`)].join('\n'));
  }
  return computeFingerprint(event, appId, seed);
}

// ---------------------------------------------------------------------------
// Human-facing labels
// ---------------------------------------------------------------------------

export function titleFor(event: StoredEvent): string {
  const exception = primaryException(event.exception?.values);
  if (exception) {
    const type = exception.type ?? 'Error';
    const value = exception.value?.trim();
    return truncate(value ? `${type}: ${value}` : type, 200);
  }
  return truncate(event.message?.trim() || '(no message)', 200);
}

/** The frame a human should look at first: the innermost in-app frame. */
export function culpritFor(event: StoredEvent): string | null {
  const frames = primaryException(event.exception?.values)?.stacktrace?.frames ?? [];
  const chosen = significantFrames(frames).at(-1);
  if (!chosen) return null;

  const where = chosen.module ?? (chosen.filename ? normalizeFilename(chosen.filename) : null);
  if (!where) return chosen.function ?? null;
  return chosen.function ? `${chosen.function} (${where})` : where;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
