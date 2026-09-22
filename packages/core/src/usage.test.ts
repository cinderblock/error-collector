import { describe, expect, it } from 'bun:test';
import {
  MAX_DIMENSIONS,
  USAGE_BLOBS,
  buildUsageDataPoint,
  isValidEventName,
  normalizeUsageEvent,
  parseDimension,
} from './usage.js';

const base = { appId: 'gate-manager', channel: 'prod', release: '2.0.0', environment: 'production' };

function point(input: unknown) {
  const event = normalizeUsageEvent(input);
  expect(event).not.toBeNull();
  return buildUsageDataPoint({ ...base, event: event! });
}

describe('event names', () => {
  it('accepts the dotted lowercase vocabulary', () => {
    for (const name of ['gate.opened', 'page.view', 'export.csv', 'a', 'a-b_c.d']) {
      expect(isValidEventName(name)).toBe(true);
    }
  });

  it('rejects anything that would fragment the grouping key', () => {
    for (const name of ['Gate.Opened', 'gate opened', '.leading', '', 'x'.repeat(100), 'emoji🎉']) {
      expect(isValidEventName(name)).toBe(false);
    }
  });

  it('lowercases and trims rather than rejecting', () => {
    expect(normalizeUsageEvent({ event: '  Gate.Opened  ' })?.event).toBe('gate.opened');
  });
});

describe('normalizeUsageEvent', () => {
  it('defaults value to 1', () => {
    expect(normalizeUsageEvent({ event: 'page.view' })?.value).toBe(1);
  });

  it('keeps a supplied numeric value, including zero and negatives', () => {
    expect(normalizeUsageEvent({ event: 'x', value: 0 })?.value).toBe(0);
    expect(normalizeUsageEvent({ event: 'x', value: -4.5 })?.value).toBe(-4.5);
  });

  it('falls back to 1 for a non-finite value', () => {
    expect(normalizeUsageEvent({ event: 'x', value: NaN })?.value).toBe(1);
    expect(normalizeUsageEvent({ event: 'x', value: Infinity })?.value).toBe(1);
    expect(normalizeUsageEvent({ event: 'x', value: 'lots' })?.value).toBe(1);
  });

  it('returns null for junk, so one bad event costs only itself', () => {
    for (const bad of [null, 'a string', 42, {}, { event: '' }, { event: 'BAD NAME' }]) {
      expect(normalizeUsageEvent(bad)).toBeNull();
    }
  });

  it('sorts dimensions, because the layout is positional', () => {
    // {a,b} and {b,a} must land in the same slots or one series silently becomes two.
    const forwards = normalizeUsageEvent({ event: 'x', dims: { alpha: '1', beta: '2' } });
    const backwards = normalizeUsageEvent({ event: 'x', dims: { beta: '2', alpha: '1' } });
    expect(forwards?.dims).toEqual(backwards!.dims);
    expect(forwards?.dims).toEqual([
      ['alpha', '1'],
      ['beta', '2'],
    ]);
  });

  it('coerces numeric dimension values and drops unusable ones', () => {
    const dims = normalizeUsageEvent({
      event: 'x',
      dims: { count: 3, ok: 'yes', empty: '', nope: null, 'Bad Key': 'v' },
    })?.dims;
    expect(dims).toEqual([
      ['count', '3'],
      ['ok', 'yes'],
    ]);
  });

  it('caps the number of dimensions', () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v']));
    expect(normalizeUsageEvent({ event: 'x', dims: many })?.dims.length).toBe(MAX_DIMENSIONS);
  });

  it('truncates a long dimension value rather than dropping it', () => {
    const dims = normalizeUsageEvent({ event: 'x', dims: { path: 'p'.repeat(500) } })?.dims;
    expect(dims?.[0]?.[1]).toHaveLength(64);
  });
});

describe('buildUsageDataPoint', () => {
  it('puts each field in its documented slot', () => {
    const dp = point({ event: 'gate.opened', value: 2 });
    expect(dp.indexes).toEqual(['gate-manager']);
    expect(dp.blobs[USAGE_BLOBS.channel - 1]).toBe('prod');
    expect(dp.blobs[USAGE_BLOBS.event - 1]).toBe('gate.opened');
    expect(dp.blobs[USAGE_BLOBS.release - 1]).toBe('2.0.0');
    expect(dp.blobs[USAGE_BLOBS.environment - 1]).toBe('production');
    expect(dp.doubles).toEqual([2]);
  });

  it('writes dimensions as key=value from the first dimension slot', () => {
    const dp = point({ event: 'x', dims: { method: 'app', source: 'button' } });
    expect(dp.blobs[USAGE_BLOBS.firstDimension - 1]).toBe('method=app');
    expect(dp.blobs[USAGE_BLOBS.firstDimension]).toBe('source=button');
  });

  it('never emits a sparse array — AE rejects holes', () => {
    const dp = point({ event: 'x', dims: { z: '1' } });
    for (let i = 0; i < dp.blobs.length; i++) {
      expect(typeof dp.blobs[i]).toBe('string');
    }
  });

  it('emits empty strings, not undefined, for absent release and environment', () => {
    const event = normalizeUsageEvent({ event: 'x' })!;
    const dp = buildUsageDataPoint({ ...base, release: null, environment: null, event });
    expect(dp.blobs[USAGE_BLOBS.release - 1]).toBe('');
    expect(dp.blobs[USAGE_BLOBS.environment - 1]).toBe('');
  });

  it('truncates the index to the 96 bytes AE allows', () => {
    const event = normalizeUsageEvent({ event: 'x' })!;
    const dp = buildUsageDataPoint({ ...base, appId: 'a'.repeat(300), event });
    expect(dp.indexes[0]).toHaveLength(96);
  });

  it('round-trips a dimension through parseDimension', () => {
    const dp = point({ event: 'x', dims: { url: 'https://example.com/a=b' } });
    expect(parseDimension(dp.blobs[USAGE_BLOBS.firstDimension - 1]!)).toEqual(['url', 'https://example.com/a=b']);
  });

  it('returns null for a slot that is not a dimension', () => {
    expect(parseDimension('')).toBeNull();
    expect(parseDimension('=novalue')).toBeNull();
  });
});
