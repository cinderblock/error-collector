import { describe, expect, it } from 'bun:test';
import { parseSince } from './read.js';

const NOW = 1_790_000_000;

describe('parseSince', () => {
  it('accepts the relative forms an agent will actually type', () => {
    expect(parseSince('7d', NOW)).toBe(NOW - 7 * 86_400);
    expect(parseSince('24h', NOW)).toBe(NOW - 24 * 3_600);
    expect(parseSince('90m', NOW)).toBe(NOW - 90 * 60);
    expect(parseSince('30s', NOW)).toBe(NOW - 30);
    expect(parseSince('2w', NOW)).toBe(NOW - 2 * 604_800);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSince('  7d ', NOW)).toBe(NOW - 7 * 86_400);
  });

  it('accepts absolute timestamps in seconds or milliseconds', () => {
    expect(parseSince(String(NOW - 100), NOW)).toBe(NOW - 100);
    expect(parseSince(String((NOW - 100) * 1000), NOW)).toBe(NOW - 100);
  });

  it('accepts an ISO date', () => {
    expect(parseSince('2026-09-01T00:00:00Z', NOW)).toBe(Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000));
  });

  it('returns null for absent or unparseable input, meaning "no lower bound"', () => {
    expect(parseSince(null, NOW)).toBeNull();
    expect(parseSince('last tuesday', NOW)).toBeNull();
    expect(parseSince('7 days', NOW)).toBeNull();
  });
});
