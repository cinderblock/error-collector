/**
 * Usage events.
 *
 * The one rule that makes this affordable: **a usage event never touches D1.** It
 * becomes exactly one Analytics Engine data point and nothing else.
 *
 * The error path costs ~2 D1 row writes per report, which is right for errors — they
 * are rare and you want the detail. For usage it would be ruinous twice over: a
 * pageview is not an "issue", and the writes would land in the very `usage_daily`
 * counters the budget governor grades error collection against, so tracking usage
 * would throttle crash reporting. AE is unlimited-cardinality, 90-day, and currently
 * unbilled; it is simply the right store.
 *
 * What lives here is the part the writer and the reader must agree on: validation,
 * and the **positional field layout**. AE has no column names — just `blob1..blob20`
 * and `double1..double20` — so a layout that exists only as two matching lists of
 * arguments in two different files will drift, and the symptom is silently
 * mis-attributed data rather than an error. Hence one table, used by both.
 */

export const MAX_DIMENSIONS = 8;
/** AE accepts 250 data points per Worker invocation; stay well under. */
export const MAX_EVENTS_PER_REQUEST = 100;

/** Dotted lowercase, e.g. `gate.opened`, `page.view`, `export.csv`. */
const EVENT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIMENSION_KEY_RE = /^[a-z0-9][a-z0-9_]{0,31}$/;
const DIMENSION_VALUE_MAX = 64;

export interface UsageEvent {
  /** What happened. Keep it a small, stable vocabulary — this is the grouping key. */
  event: string;
  /** Defaults to 1. Use it for durations, counts, sizes — anything summable. */
  value?: number;
  /** Up to 8 low-cardinality labels. */
  dims?: Record<string, string>;
  timestamp?: number;
}

export interface NormalizedUsageEvent {
  event: string;
  value: number;
  dims: [string, string][];
}

export function isValidEventName(value: string): boolean {
  return EVENT_RE.test(value);
}

/**
 * Returns `null` for anything unusable rather than throwing: a malformed event in a
 * batch should cost that event, not the whole batch.
 *
 * Dimensions are sorted, which matters more than it looks — the layout below is
 * positional, so `{a,b}` and `{b,a}` would otherwise land in different slots and
 * split one series into two.
 */
export function normalizeUsageEvent(input: unknown): NormalizedUsageEvent | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;

  const event = typeof raw.event === 'string' ? raw.event.trim().toLowerCase() : '';
  if (!isValidEventName(event)) return null;

  const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : 1;

  const dims: [string, string][] = [];
  if (typeof raw.dims === 'object' && raw.dims !== null && !Array.isArray(raw.dims)) {
    for (const [key, rawValue] of Object.entries(raw.dims as Record<string, unknown>)) {
      if (dims.length >= MAX_DIMENSIONS) break;
      const k = key.trim().toLowerCase();
      if (!DIMENSION_KEY_RE.test(k)) continue;

      const v = typeof rawValue === 'string' ? rawValue : typeof rawValue === 'number' ? String(rawValue) : null;
      if (v === null || v.length === 0) continue;
      dims.push([k, v.slice(0, DIMENSION_VALUE_MAX)]);
    }
    dims.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  return { event, value, dims };
}

// ---------------------------------------------------------------------------
// Analytics Engine field layout
// ---------------------------------------------------------------------------

/**
 * Blob slots, 1-indexed to match AE's own `blob1..blob20` naming so a query and this
 * table can be read side by side without arithmetic.
 *
 * Slots 5 upward hold `key=value` for the sorted custom dimensions. They are
 * deliberately *not* one slot per named dimension: dimension names vary per app, and
 * a fixed mapping would either run out or force a schema change per app.
 */
export const USAGE_BLOBS = {
  channel: 1,
  event: 2,
  release: 3,
  environment: 4,
  /** First slot holding a `key=value` dimension pair. */
  firstDimension: 5,
} as const;

export const USAGE_DOUBLES = {
  value: 1,
} as const;

/** `blobN` / `doubleN` as the SQL API names them. */
export function blobColumn(slot: number): string {
  return `blob${slot}`;
}

export function doubleColumn(slot: number): string {
  return `double${slot}`;
}

export interface UsageDataPointInput {
  appId: string;
  channel: string;
  release: string | null;
  environment: string | null;
  event: NormalizedUsageEvent;
}

export interface UsageDataPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/**
 * Builds the data point. The single index is the app id: AE allows exactly one, it
 * caps at 96 bytes, and it is the dimension every query filters on first. It is also
 * what AE samples *per*, so one noisy app cannot cause another's data to be sampled.
 */
export function buildUsageDataPoint(input: UsageDataPointInput): UsageDataPoint {
  const blobs: string[] = [];
  blobs[USAGE_BLOBS.channel - 1] = input.channel;
  blobs[USAGE_BLOBS.event - 1] = input.event.event;
  blobs[USAGE_BLOBS.release - 1] = input.release ?? '';
  blobs[USAGE_BLOBS.environment - 1] = input.environment ?? '';

  for (const [index, [key, value]] of input.event.dims.entries()) {
    blobs[USAGE_BLOBS.firstDimension - 1 + index] = `${key}=${value}`;
  }

  // AE rejects sparse arrays; unused slots must be present and empty.
  for (let i = 0; i < blobs.length; i++) blobs[i] ??= '';

  return {
    indexes: [input.appId.slice(0, 96)],
    blobs,
    doubles: [input.event.value],
  };
}

/** Splits a stored `key=value` blob slot back apart. */
export function parseDimension(slot: string): [string, string] | null {
  const split = slot.indexOf('=');
  if (split <= 0) return null;
  return [slot.slice(0, split), slot.slice(split + 1)];
}
