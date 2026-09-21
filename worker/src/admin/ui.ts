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
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
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
<title>${escapeHtml(title)} — error-collector</title>
<style>${STYLES}</style>
${head}
</head>
<body>
<header class="top"><span class="brand"><a href="/">error-collector</a></span>${nav}</header>
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

/** A labelled usage bar. The numbers are always visible — nothing hides in a hover. */
export function meter(label: string, used: number, limit: number, render: (value: number) => string): string {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const tone = ratio >= 0.95 ? 'bad' : ratio >= 0.6 ? 'warn' : '';
  return `<div>
    <div class="row" style="justify-content: space-between">
      <span>${escapeHtml(label)}</span>
      <span class="muted mono">${escapeHtml(render(used))} / ${escapeHtml(render(limit))}</span>
    </div>
    <div class="bar ${tone}"><span style="width: ${(ratio * 100).toFixed(1)}%"></span></div>
    <div class="muted" style="font-size: 0.8rem; margin-top: 2px">${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}% of today's budget</div>
  </div>`;
}
