import { describe, expect, it } from 'bun:test';
import { ago, barChart, bytes, count, escapeHtml, meter, rankedBars } from './ui.js';

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

describe('barChart', () => {
  const points = [
    { label: '09-19', value: 10 },
    { label: '09-20', value: 40 },
    { label: '09-21', value: 25 },
  ];

  it('hides nothing behind a hover', () => {
    // No title attribute and no <title> element: both are hover-only, and both are
    // invisible on a phone, which is where this gets read.
    const svg = barChart(points);
    expect(svg).not.toContain('title=');
    expect(svg).not.toContain('<title');
  });

  it('labels the peak directly, so the scale is readable without interaction', () => {
    expect(barChart(points)).toContain('peak 40');
  });

  it('describes itself for a screen reader', () => {
    const svg = barChart(points);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="3 buckets from 09-19 to 09-21; peak 40"');
  });

  it('shows the first and last bucket on the axis', () => {
    const svg = barChart(points);
    expect(svg).toContain('>09-19</text>');
    expect(svg).toContain('>09-21</text>');
  });

  it('rounds the data end and squares the baseline end', () => {
    // Rounded tops come from quadratic curves; a plain rounded rect would round the
    // baseline too and float the bar off its axis.
    expect(barChart(points)).toContain('Q');
    expect(barChart(points)).toContain('class="bar"');
  });

  it('renders one mark per point', () => {
    expect([...barChart(points).matchAll(/class="bar"/g)]).toHaveLength(3);
  });

  it('drops the gap when bars would be thinner than it', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ label: `b${i}`, value: 1 }));
    // With a gap wider than the bar, every bar would vanish.
    expect(barChart(many)).toContain('class="bar"');
  });

  it('gives a zero-value bucket no mark rather than a stub', () => {
    const svg = barChart([
      { label: 'a', value: 0 },
      { label: 'b', value: 5 },
    ]);
    expect([...svg.matchAll(/class="bar"/g)]).toHaveLength(1);
  });

  it('survives an all-zero window without dividing by zero', () => {
    const svg = barChart([
      { label: 'a', value: 0 },
      { label: 'b', value: 0 },
    ]);
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('peak 1');
  });

  it('says so plainly when there is nothing to draw', () => {
    expect(barChart([])).toContain('No data in this window.');
  });

  it('escapes bucket labels', () => {
    expect(barChart([{ label: '<script>', value: 1 }])).toContain('&lt;script&gt;');
  });
});

describe('rankedBars', () => {
  const rows = [
    { key: 'gate.opened', value: 120 },
    { key: 'page.view', value: 30 },
  ];

  it('puts the number beside every bar, never on hover', () => {
    const html = rankedBars(rows, v => String(v));
    expect(html).toContain('>120<');
    expect(html).toContain('>30<');
    expect(html).not.toContain('title=');
  });

  it('scales widths against the largest row', () => {
    const html = rankedBars(rows, v => String(v));
    expect(html).toContain('width: 100.0%');
    expect(html).toContain('width: 25.0%');
  });

  it('labels an empty key rather than rendering a blank row', () => {
    expect(rankedBars([{ key: '', value: 1 }], v => String(v))).toContain('(none)');
  });

  it('escapes keys, which come from the open internet', () => {
    expect(rankedBars([{ key: '<img onerror=x>', value: 1 }], v => String(v))).toContain('&lt;img');
  });

  it('handles an all-zero breakdown', () => {
    expect(rankedBars([{ key: 'a', value: 0 }], v => String(v))).not.toContain('NaN');
  });

  it('says so plainly when empty', () => {
    expect(rankedBars([], v => String(v))).toContain('Nothing recorded yet.');
  });
});

describe('barChart geometry', () => {
  /** Width of each bar, from the horizontal extent of its path. */
  function barWidths(svg: string): number[] {
    return [...svg.matchAll(/<path class="bar" d="([^"]+)"/g)].map(match => {
      const xs = [...match[1]!.matchAll(/[MLQ](-?\d+(?:\.\d+)?) /g)].map(m => Number(m[1]));
      return Math.max(...xs) - Math.min(...xs);
    });
  }

  it('caps bar width so a short window is not drawn as colour blocks', () => {
    // Three buckets across a 720px chart would otherwise be 240px slabs.
    const svg = barChart([
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
      { label: 'c', value: 3 },
    ]);
    expect(Math.max(...barWidths(svg))).toBeLessThanOrEqual(48);
  });

  it('centres a capped bar in its slot rather than jamming it left', () => {
    const svg = barChart([
      { label: 'a', value: 1 },
      { label: 'b', value: 1 },
    ]);
    const firstX = Number(/<path class="bar" d="M(\d+(?:\.\d+)?) /.exec(svg)![1]);
    // Slot is 360 wide, bar is 48 — centred puts it at 156, not 0.
    expect(firstX).toBeGreaterThan(100);
  });

  it('still fills the slot when there are many buckets', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ label: `b${i}`, value: 5 }));
    expect(Math.max(...barWidths(many.length ? barChart(many) : ''))).toBeLessThanOrEqual(48);
    expect(Math.min(...barWidths(barChart(many)))).toBeGreaterThan(5);
  });

  it('does not print the same axis label twice for a single bucket', () => {
    const svg = barChart([{ label: '09-21', value: 7 }]);
    // One tick, not "09-21 … 09-21". The aria-label mentions it too, which is
    // correct, so count the rendered ticks rather than the string.
    expect([...svg.matchAll(/class="tick"/g)]).toHaveLength(1);
    expect(svg).toContain('aria-label="1 bucket at 09-21; peak 7"');
  });

  it('still labels both ends when they differ', () => {
    const svg = barChart([
      { label: 'first', value: 1 },
      { label: 'last', value: 2 },
    ]);
    expect(svg).toContain('>first</text>');
    expect(svg).toContain('>last</text>');
  });
});

describe('peak label placement', () => {
  it('sits over the bar it describes, not at the slot edge', () => {
    // With capped, centred bars those are far apart on a short window.
    const svg = barChart([
      { label: 'a', value: 1 },
      { label: 'b', value: 9 },
      { label: 'c', value: 1 },
    ]);
    const peakX = Number(/<text class="peak" x="(\d+)"/.exec(svg)![1]);
    const barXs = [...svg.matchAll(/<path class="bar" d="M(\d+(?:\.\d+)?) /g)].map(m => Number(m[1]));
    const tallBarX = barXs[1]!;
    // Within half a bar width of the bar's left edge.
    expect(Math.abs(peakX - tallBarX)).toBeLessThan(48);
    expect(svg).toContain('text-anchor="middle"');
  });

  it('never runs off either edge', () => {
    for (const points of [
      [{ label: 'only', value: 5 }],
      [
        { label: 'a', value: 9 },
        { label: 'b', value: 1 },
      ],
      [
        { label: 'a', value: 1 },
        { label: 'b', value: 9 },
      ],
    ]) {
      const peakX = Number(/<text class="peak" x="(\d+)"/.exec(barChart(points))![1]);
      expect(peakX).toBeGreaterThanOrEqual(36);
      expect(peakX).toBeLessThanOrEqual(720);
    }
  });
});
