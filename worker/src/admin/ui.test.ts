import { describe, expect, it } from 'bun:test';
import { ago, bytes, count, escapeHtml, meter } from './ui.js';

describe('escapeHtml', () => {
  it('neutralises every character that can break out of markup', () => {
    // Error messages and user feedback arrive from a world-open endpoint and are
    // rendered in a page that holds an admin session. This is the first line of
    // defence; the strict CSP is the second.
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`" onmouseover="evil()`)).toBe('&quot; onmouseover=&quot;evil()');
    expect(escapeHtml("' onload='evil()")).toBe('&#39; onload=&#39;evil()');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes the ampersand before the entities it introduces', () => {
    // Wrong order produces `&amp;lt;`, which renders as literal `&lt;`.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('renders nullish as empty rather than "null"', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(0)).toBe('0');
  });
});

describe('ago', () => {
  const now = 1_790_000_000;

  it('scales the unit to the distance', () => {
    expect(ago(now - 5, now)).toBe('5s ago');
    expect(ago(now - 300, now)).toBe('5m ago');
    expect(ago(now - 7_200, now)).toBe('2h ago');
    expect(ago(now - 3 * 86_400, now)).toBe('3d ago');
  });

  it('falls back to a date once "days ago" stops being useful', () => {
    expect(ago(now - 200 * 86_400, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never reports a negative age for a clock slightly ahead', () => {
    expect(ago(now + 30, now)).toBe('0s ago');
  });
});

describe('bytes', () => {
  it('scales and keeps the number readable', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(2048)).toBe('2.0 KB');
    expect(bytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(bytes(42 * 1024 * 1024)).toBe('42 MB');
    expect(bytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

describe('count', () => {
  it('abbreviates large counts without losing the sense of scale', () => {
    expect(count(42)).toBe('42');
    expect(count(999)).toBe('999');
    expect(count(1500)).toBe('1.5k');
    expect(count(42_000)).toBe('42k');
    expect(count(2_500_000)).toBe('2.5M');
  });
});

describe('meter', () => {
  it('always shows the numbers, never hiding them behind a hover', () => {
    const rendered = meter('Reports', 250, 1000, count);
    expect(rendered).toContain('250 / 1.0k');
    expect(rendered).toContain('25% of');
    expect(rendered).not.toContain('title=');
  });

  it('shifts tone as the budget is consumed', () => {
    expect(meter('x', 10, 100, count)).not.toContain('bar warn');
    expect(meter('x', 70, 100, count)).toContain('bar warn');
    expect(meter('x', 99, 100, count)).toContain('bar bad');
  });

  it('does not overflow the bar past 100%', () => {
    expect(meter('x', 5000, 100, count)).toContain('width: 100.0%');
  });

  it('survives a zero limit rather than rendering NaN', () => {
    const rendered = meter('x', 5, 0, count);
    expect(rendered).not.toContain('NaN');
    expect(rendered).toContain('width: 0.0%');
  });

  it('escapes its label', () => {
    expect(meter('<b>x</b>', 1, 2, count)).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
