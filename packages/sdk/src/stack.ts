/**
 * Stack parsing.
 *
 * Two things here are easy to get wrong and expensive when wrong:
 *
 * 1. **Frame order.** Every engine's `Error.stack` lists the innermost frame
 *    *first*. The event model follows Sentry's convention, which is the opposite —
 *    oldest first, innermost last — because that is what the grouping code reads
 *    from the end. Reversing is not optional: get it backwards and every
 *    fingerprint is built from `main()`, which silently groups unrelated crashes
 *    together.
 *
 * 2. **`in_app`.** Grouping prefers in-app frames, so marking library frames
 *    correctly is what keeps two different bugs that both bottom out in the same
 *    framework function from merging.
 */

import type { StackFrame } from '@cinderblock/telemetry-collector-core';

/** V8/Chrome/Node: `    at fn (file:line:col)`, `    at file:line:col` */
const V8_FRAME = /^\s*at (?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+)|([^)]+))\)?\s*$/;

/** SpiderMonkey/JavaScriptCore: `fn@file:line:col` */
const MOZ_FRAME = /^\s*(?:(.*?)@)?(.*?):(\d+):(\d+)\s*$/;

const NOT_IN_APP = [
  'node_modules',
  'node:internal',
  '/webpack/',
  'webpack-internal:',
  '/.vite/deps/',
  '/vendor/',
  '/vendor.',
  'cdn.jsdelivr.net',
  'unpkg.com',
];

export function isInApp(filename: string | undefined): boolean {
  if (!filename) return true;
  if (filename.startsWith('node:')) return false;
  const lower = filename.toLowerCase();
  return !NOT_IN_APP.some(marker => lower.includes(marker));
}

function cleanFunctionName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = name
    .replace(/^(?:async|new|get|set)\s+/, '')
    .replace(/^Object\./, '')
    .trim();
  return trimmed && trimmed !== '<anonymous>' ? trimmed : undefined;
}

function parseLine(line: string): StackFrame | null {
  const v8 = V8_FRAME.exec(line);
  if (v8) {
    // Group 5 is the bare-location form (`at file:line:col`), which still carries
    // line/col inside it and has to be re-split.
    const location = v8[2] ?? v8[5];
    if (!location) return null;

    const bare = v8[2] ? null : /^(.*?):(\d+):(\d+)$/.exec(location);
    const filename = v8[2] ?? bare?.[1] ?? location;
    const lineno = Number(v8[3] ?? bare?.[2]);
    const colno = Number(v8[4] ?? bare?.[3]);

    const frame: StackFrame = { filename, in_app: isInApp(filename) };
    const fn = cleanFunctionName(v8[1]);
    if (fn) frame.function = fn;
    if (Number.isFinite(lineno)) frame.lineno = lineno;
    if (Number.isFinite(colno)) frame.colno = colno;
    return frame;
  }

  const moz = MOZ_FRAME.exec(line);
  if (moz && moz[2]) {
    const frame: StackFrame = { filename: moz[2], in_app: isInApp(moz[2]) };
    const fn = cleanFunctionName(moz[1]);
    if (fn) frame.function = fn;
    const lineno = Number(moz[3]);
    const colno = Number(moz[4]);
    if (Number.isFinite(lineno)) frame.lineno = lineno;
    if (Number.isFinite(colno)) frame.colno = colno;
    return frame;
  }

  return null;
}

export const MAX_FRAMES = 50;

/** Returns frames in Sentry order: oldest first, innermost last. */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];

  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    // The first line is `Error: message` in V8 and is not a frame.
    const frame = parseLine(line);
    if (frame) frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }

  return frames.reverse();
}

/**
 * Walks `cause` so a wrapped error reports the whole chain.
 *
 * Ordered oldest-first, matching Sentry: the original cause comes first and the
 * error actually thrown comes last. Grouping keys on the last entry, so a crash
 * groups by what the application threw rather than by whatever low-level cause it
 * happened to wrap — two different bugs that both wrap `ECONNRESET` stay separate.
 */
export function exceptionChain(error: unknown, maxDepth = 5): { type: string; value: string; stack?: string }[] {
  const chain: { type: string; value: string; stack?: string }[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < maxDepth && current; depth++) {
    if (current instanceof Error) {
      chain.push({ type: current.name || 'Error', value: current.message, stack: current.stack });
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      chain.push({ type: typeof current === 'string' ? 'Error' : 'UnknownError', value: describe(current) });
      break;
    }
  }

  // Collected outermost-first; Sentry wants oldest-first.
  return chain.reverse();
}

/** Non-Error throws are common in the wild; they must not produce `[object Object]`. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value)?.slice(0, 1000) ?? String(value);
  } catch {
    return String(value);
  }
}
