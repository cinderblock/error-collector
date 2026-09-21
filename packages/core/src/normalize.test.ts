import { describe, expect, it } from 'bun:test';
import { LIMITS, isEmptyEvent, normalizeReport } from './normalize.js';
import type { ReportPayload } from './types.js';

const NOW = 1_760_000_000;
const context = { now: NOW };

function norm(payload: unknown) {
  return normalizeReport(payload as ReportPayload, context);
}

describe('normalizeReport', () => {
  it('keeps a well-formed report intact', () => {
    const event = norm({
      kind: 'error',
      level: 'fatal',
      message: 'gate stuck',
      release: '1.4.2',
      environment: 'prod',
      url: 'https://gate.example.com/open',
      tags: { device: 'pi-4' },
      user: { id: 'u-1' },
    });

    expect(event.kind).toBe('error');
    expect(event.level).toBe('fatal');
    expect(event.message).toBe('gate stuck');
    expect(event.release).toBe('1.4.2');
    expect(event.tags).toEqual({ device: 'pi-4' });
    expect(event.user).toEqual({ id: 'u-1' });
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('wraps a single exception into Sentry-shaped values[]', () => {
    const event = norm({ exception: { type: 'TypeError', value: 'boom' } });
    expect(event.exception?.values).toHaveLength(1);
    expect(event.exception?.values[0]?.type).toBe('TypeError');
  });

  it('gives feedback a sensible default level', () => {
    expect(norm({ kind: 'feedback', message: 'the button is broken' }).level).toBe('info');
    expect(norm({ message: 'boom' }).level).toBe('error');
  });

  it('falls back to error for an unknown level or kind', () => {
    expect(norm({ level: 'catastrophic', message: 'x' }).level).toBe('error');
    expect(norm({ kind: 'nonsense', message: 'x' }).kind).toBe('error');
  });
});

describe('hostile input', () => {
  it('survives junk in every field without throwing', () => {
    const event = norm({
      kind: 42,
      level: {},
      message: { not: 'a string' },
      exception: 'not an array or object',
      breadcrumbs: 'nope',
      tags: 'nope',
      extra: [1, 2, 3],
      contexts: 7,
      user: 'anonymous',
      timestamp: 'yesterday',
      sdk: 'mine',
    });

    expect(event.kind).toBe('error');
    expect(event.message).toBeUndefined();
    expect(event.exception).toBeUndefined();
    expect(event.tags).toEqual({});
    expect(event.extra).toEqual({});
    expect(event.user).toBeUndefined();
    expect(event.timestamp).toBe(NOW);
    expect(isEmptyEvent(event)).toBe(true);
  });

  it('keeps the crash when an attached collection is malformed', () => {
    // Losing a breadcrumb array is much better than losing the crash it described.
    const event = norm({ message: 'boom', breadcrumbs: [null, 5, { message: 'clicked' }, 'x'] });
    expect(event.message).toBe('boom');
    expect(event.breadcrumbs?.values).toHaveLength(1);
  });

  it('caps oversized strings rather than rejecting the report', () => {
    const event = norm({ message: 'x'.repeat(LIMITS.message * 3) });
    expect(event.message).toHaveLength(LIMITS.message);
  });

  it('caps collection sizes', () => {
    const event = norm({
      message: 'boom',
      breadcrumbs: Array.from({ length: 500 }, (_, i) => ({ message: `step ${i}` })),
      tags: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v'])),
      exception: Array.from({ length: 50 }, () => ({ type: 'E', value: 'v' })),
    });

    expect(event.breadcrumbs?.values).toHaveLength(LIMITS.breadcrumbs);
    expect(Object.keys(event.tags)).toHaveLength(LIMITS.tags);
    expect(event.exception?.values).toHaveLength(LIMITS.exceptions);
  });

  it('keeps the most recent breadcrumbs, not the oldest', () => {
    const event = norm({
      message: 'boom',
      breadcrumbs: Array.from({ length: LIMITS.breadcrumbs + 10 }, (_, i) => ({ message: `step ${i}` })),
    });
    expect(event.breadcrumbs?.values.at(-1)?.message).toBe(`step ${LIMITS.breadcrumbs + 9}`);
  });

  it('caps frames per exception', () => {
    const frames = Array.from({ length: 400 }, (_, i) => ({ function: `f${i}`, filename: 'a.js' }));
    const event = norm({ exception: { type: 'E', stacktrace: { frames } } });
    expect(event.exception?.values[0]?.stacktrace?.frames).toHaveLength(LIMITS.frames);
  });

  it('replaces oversized extra with a note instead of storing it', () => {
    const event = norm({ message: 'boom', extra: { blob: 'x'.repeat(LIMITS.extraJson * 2) } });
    expect(event.extra._truncated).toContain('exceeds');
    expect(JSON.stringify(event.extra).length).toBeLessThan(200);
  });

  it('drops extra that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(norm({ message: 'boom', extra: cyclic }).extra._truncated).toBe('extra dropped: not serializable');
  });

  it('drops frames carrying no location at all', () => {
    const event = norm({ exception: { type: 'E', stacktrace: { frames: [{ lineno: 5 }, { function: 'real' }] } } });
    expect(event.exception?.values[0]?.stacktrace?.frames).toHaveLength(1);
  });
});

describe('timestamps', () => {
  it('accepts a plausible client clock', () => {
    expect(norm({ message: 'x', timestamp: NOW - 30 }).timestamp).toBe(NOW - 30);
  });

  it('accepts milliseconds, the most common reporter mistake', () => {
    expect(norm({ message: 'x', timestamp: NOW * 1000 }).timestamp).toBe(NOW);
  });

  it('ignores a clock that is wildly wrong', () => {
    // Devices with a bad clock are common; trusting them scatters events across
    // the timeline and makes "what happened at 3pm" unanswerable.
    expect(norm({ message: 'x', timestamp: 0 }).timestamp).toBe(NOW);
    expect(norm({ message: 'x', timestamp: NOW + 400_000 }).timestamp).toBe(NOW);
  });
});

describe('privacy', () => {
  it('records coarse request context but never an IP address', () => {
    const event = normalizeReport({ message: 'boom' } as ReportPayload, {
      now: NOW,
      userAgent: 'Mozilla/5.0',
      country: 'US',
    });
    expect(event.request).toEqual({ user_agent: 'Mozilla/5.0', country: 'US' });
    expect(JSON.stringify(event)).not.toContain('ip');
  });

  it('ignores an ip the reporter tries to supply in the user object', () => {
    const event = norm({ message: 'boom', user: { id: 'u-1', ip: '203.0.113.9' } });
    expect(event.user).toEqual({ id: 'u-1' });
  });
});
