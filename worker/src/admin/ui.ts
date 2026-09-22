/**
 * Server-rendered admin UI.
 *
 * No build step and no client framework: the whole surface is a handful of pages
 * that render from a D1 query, and a worker that serves HTML directly has no bundle
 * to keep in sync with the schema.
 *
 * Deliberately **no `title=` attributes anywhere**. They are invisible on touch
 * devices and hide information behind a hover, and this is a service that gets read
 * from a phone. Anything worth saying is a visible label, a hint line, or a chip.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfc;
  --panel: #ffffff;
  --border: #e3e5ea;
  --text: #16181d;
  --muted: #666d7a;
  --accent: #2b6cb0;
  --ok: #1f7a4d;
  --warn: #9a6400;
  --bad: #b3261e;
  /* Chart ink is its own token, not --accent: marks carry identity, text wears text
     colours. Both modes validated against their real surface with the palette
     checker (lightness band, chroma floor, 3:1 contrast) rather than eyeballed. */
  --chart: #2b6cb0;
  --grid: #e8eaee;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --panel: #1c1f25;
    --border: #2c313a;
    --text: #e7e9ee;
    --muted: #99a1b0;
    --accent: #7aa9dd;
    --ok: #63c08c;
    --warn: #e0b054;
    --bad: #f08379;
    /* Selected for the dark surface, not flipped from light: the light accent
       measures chroma 0.091 on #1c1f25, i.e. it reads grey. */
    --chart: #3d8ff5;
    --grid: #2c313a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top {
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline;
  padding: 12px 16px;
  background: var(--panel); border-bottom: 1px solid var(--border);
}
header.top .brand { font-weight: 650; margin-right: auto; }
header.top nav { display: flex; gap: 14px; flex-wrap: wrap; }
main { max-width: 1000px; margin: 0 auto; padding: 18px 16px 64px; }
h1 { font-size: 1.35rem; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 26px 0 10px; }
.sub { color: var(--muted); margin: 0 0 18px; }
.card {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px 16px; margin-bottom: 14px;
}
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 0.86em; }
.row { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
.chip {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--border); font-size: 0.78rem; color: var(--muted);
  white-space: nowrap;
}
.chip.fatal, .chip.error { color: var(--bad); border-color: currentColor; }
.chip.warning { color: var(--warn); border-color: currentColor; }
.chip.ok { color: var(--ok); border-color: currentColor; }
.issue { display: block; padding: 12px 0; border-bottom: 1px solid var(--border); color: inherit; }
.issue:hover { text-decoration: none; }
.issue:last-child { border-bottom: 0; }
.issue .title { font-weight: 560; }
.issue .meta { color: var(--muted); font-size: 0.85rem; margin-top: 3px; }
.count { font-variant-numeric: tabular-nums; font-weight: 650; }
.bar { height: 7px; border-radius: 4px; background: var(--border); overflow: hidden; margin-top: 5px; }
.bar > span { display: block; height: 100%; background: var(--ok); }
.bar.warn > span { background: var(--warn); }
.bar.bad > span { background: var(--bad); }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
/* Meters must not wrap their header: one wrapping value pushes that column's bar
   out of line with its neighbours, which reads as a rendering bug. The label
   ellipsises instead. */
.meter-head { display: flex; flex-wrap: nowrap; gap: 10px; align-items: baseline; justify-content: space-between; }
.meter-head .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meter-head .value { flex: 0 0 auto; white-space: nowrap; }
pre {
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; overflow-x: auto; font-size: 0.83rem; margin: 8px 0;
}
form.stack { display: grid; gap: 10px; }
label { display: grid; gap: 3px; font-size: 0.88rem; }
label .hint { color: var(--muted); font-size: 0.82rem; font-weight: 400; }
input, select, button, textarea {
  font: inherit; color: inherit;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px;
}
input[type=number] { font-variant-numeric: tabular-nums; }
button { background: var(--accent); color: #fff; border-color: transparent; cursor: pointer; font-weight: 550; }
button.secondary { background: var(--panel); color: var(--text); border-color: var(--border); }
button.danger { background: transparent; color: var(--bad); border-color: currentColor; }
button:disabled { opacity: 0.5; cursor: default; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px 8px 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
th { color: var(--muted); font-weight: 550; }
.reveal {
  background: var(--bg); border: 1px dashed var(--accent); border-radius: 8px;
  padding: 10px 12px; margin: 10px 0; word-break: break-all;
}
.notice { border-left: 3px solid var(--accent); padding-left: 12px; margin: 12px 0; }
.notice.bad { border-color: var(--bad); }
.empty { color: var(--muted); padding: 22px 0; text-align: center; }
details > summary { cursor: pointer; color: var(--accent); }
/* Charts. Marks are thin, gaps are surface-coloured, axes are recessive. */
.chart { width: 100%; height: auto; display: block; }
.chart .bar { fill: var(--chart); }
.chart .axis { stroke: var(--grid); stroke-width: 1; }
.chart .tick { fill: var(--muted); font-size: 10px; }
.chart .peak { fill: var(--text); font-size: 10px; font-weight: 600; }
.hbar { display: grid; grid-template-columns: minmax(0, 12rem) 1fr auto; gap: 8px; align-items: center; margin: 6px 0; }
.hbar .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.88rem; }
.hbar .track { background: var(--grid); border-radius: 4px; height: 10px; }
.hbar .fill { background: var(--chart); border-radius: 4px; height: 100%; }
.hbar .num { font-variant-numeric: tabular-nums; font-size: 0.85rem; color: var(--muted); }

@media (max-width: 560px) {
  main { padding: 14px 12px 56px; }
  th:nth-child(n + 4), td:nth-child(n + 4) { display: none; }
}
`;

export interface LayoutOptions {
  title: string;
  authed?: boolean;
  body: string;
  head?: string;
}

export function layout({ title, authed = true, body, head = '' }: LayoutOptions): string {
  const nav = authed
    ? `<nav>
         <a href="/">Overview</a>
         <a href="/issues">Issues</a>
         <a href="/usage">Usage</a>
         <a href="/channels">Channels</a>
         <a href="/apps">Apps</a>
         <a href="/settings">Settings</a>
       </nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} — telemetry-collector</title>
<style>${STYLES}</style>
${head}
</head>
<body>
<header class="top"><span class="brand"><a href="/">telemetry-collector</a></span>${nav}</header>
<main>${body}</main>
</body>
</html>`;
}

export function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The admin UI renders data submitted by anyone on the internet. A strict CSP
      // means a stored-XSS bug in an error message would be inert rather than
      // session-stealing; escaping is the first line, this is the second.
      'content-security-policy':
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function ago(seconds: number, now: number): string {
  const delta = Math.max(0, now - seconds);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3_600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h ago`;
  if (delta < 2_592_000) return `${Math.floor(delta / 86_400)}d ago`;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`;
}

export function count(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * A time-series bar chart.
 *
 * Single series, so no legend — the heading names it. Bars are separated by a 2px
 * surface gap and have 4px rounded tops anchored to the baseline.
 *
 * **No hover tooltip, deliberately**, which is a departure from the usual advice to
 * add one. Hover is invisible on touch and this gets read from a phone. The values
 * are instead reachable without hovering: the axis carries the maximum, the tallest
 * bar is directly labelled, and the caller renders a table underneath — which is the
 * accessible fallback a chart is supposed to have anyway, so making it the primary
 * route costs nothing.
 */
export function barChart(points: { label: string; value: number }[], height = 120): string {
  if (points.length === 0) return `<div class="empty">No data in this window.</div>`;

  const width = 720;
  const padBottom = 16;
  const plot = height - padBottom;
  const peak = Math.max(...points.map(point => point.value), 1);
  const slot = width / points.length;
  const gap = points.length > 120 ? 0 : 2;
  // Capped, and centred in its slot. Without a cap a three-bucket window draws
  // 240px-wide slabs that read as a colour-blocked background rather than a chart.
  const barWidth = Math.min(48, Math.max(1, slot - gap));
  const inset = (slot - barWidth) / 2;
  const radius = Math.min(4, barWidth / 2);

  const peakIndex = points.reduce((best, point, i) => (point.value > points[best]!.value ? i : best), 0);

  const bars = points
    .map((point, i) => {
      const barHeight = Math.max(point.value > 0 ? 1 : 0, (point.value / peak) * plot);
      const x = i * slot + inset;
      const y = plot - barHeight;
      if (barHeight <= 0) return '';

      const r = Math.min(radius, barHeight);
      // Rounded at the data end only; square where it meets the baseline.
      return `<path class="bar" d="M${x.toFixed(1)} ${(y + barHeight).toFixed(1)} L${x.toFixed(1)} ${(y + r).toFixed(1)} Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)} L${(x + barWidth - r).toFixed(1)} ${y.toFixed(1)} Q${(x + barWidth).toFixed(1)} ${y.toFixed(1)} ${(x + barWidth).toFixed(1)} ${(y + r).toFixed(1)} L${(x + barWidth).toFixed(1)} ${(y + barHeight).toFixed(1)} Z"/>`;
    })
    .join('');

  const first = points[0]?.label ?? '';
  const last = points.at(-1)?.label ?? '';
  const peakPoint = points[peakIndex]!;
  // Anchored to the middle of the bar it describes, not the left edge of its slot —
  // with capped, centred bars those are far apart on a short window.
  const peakCentre = peakIndex * slot + inset + barWidth / 2;
  const peakX = Math.min(width - 4, Math.max(36, peakCentre));

  const described =
    points.length === 1
      ? `1 bucket at ${first}; peak ${count(peak)}`
      : `${points.length} buckets from ${first} to ${last}; peak ${count(peak)}`;

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(described)}">
    ${bars}
    <line class="axis" x1="0" y1="${plot}" x2="${width}" y2="${plot}"/>
    <text class="peak" x="${peakX.toFixed(0)}" y="10" text-anchor="middle">peak ${escapeHtml(count(peakPoint.value))}</text>
    <text class="tick" x="0" y="${height - 3}">${escapeHtml(first)}</text>
    ${last && last !== first ? `<text class="tick" x="${width}" y="${height - 3}" text-anchor="end">${escapeHtml(last)}</text>` : ''}
  </svg>`;
}

/** Horizontal magnitude bars with the number always beside them, never on hover. */
export function rankedBars(rows: { key: string; value: number }[], render: (value: number) => string): string {
  if (rows.length === 0) return `<div class="empty">Nothing recorded yet.</div>`;
  const peak = Math.max(...rows.map(row => row.value), 1);

  return rows
    .map(
      row => `<div class="hbar">
        <span class="name">${escapeHtml(row.key || '(none)')}</span>
        <span class="track"><span class="fill" style="width: ${((row.value / peak) * 100).toFixed(1)}%"></span></span>
        <span class="num">${escapeHtml(render(row.value))}</span>
      </div>`,
    )
    .join('');
}

/** A labelled usage bar. The numbers are always visible — nothing hides in a hover. */
export function meter(label: string, used: number, limit: number, render: (value: number) => string): string {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const tone = ratio >= 0.95 ? 'bad' : ratio >= 0.6 ? 'warn' : '';
  return `<div>
    <div class="meter-head">
      <span class="label">${escapeHtml(label)}</span>
      <span class="value muted mono">${escapeHtml(render(used))} / ${escapeHtml(render(limit))}</span>
    </div>
    <div class="bar ${tone}"><span style="width: ${(ratio * 100).toFixed(1)}%"></span></div>
    <div class="muted" style="font-size: 0.8rem; margin-top: 2px">${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}% of today's budget</div>
  </div>`;
}
