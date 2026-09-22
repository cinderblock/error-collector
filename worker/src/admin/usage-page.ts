/**
 * The usage tab.
 *
 * Reads from Analytics Engine over the SQL API, which needs an account token that a
 * deployment may legitimately not have yet — writing usage needs no token, only
 * reading does. So "not configured" is a first-class state with instructions, not an
 * error page.
 */

import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';
import { AnalyticsUnavailableError, analyticsConfigured } from '../analytics/sql.js';
import {
  fetchBreakdown,
  fetchSeries,
  parseGroupBy,
  parseInterval,
  type BreakdownRow,
  type GroupBy,
  type Interval,
  type SeriesRow,
} from '../analytics/usage-queries.js';
import { listApps } from '../storage/apps.js';
import { barChart, count, escapeHtml, html, layout, rankedBars } from './ui.js';

const WINDOWS: { label: string; since: string; interval: Interval }[] = [
  { label: '24 hours', since: '24h', interval: 'hour' },
  { label: '7 days', since: '7d', interval: 'day' },
  { label: '30 days', since: '30d', interval: 'day' },
  { label: '90 days', since: '90d', interval: 'day' },
];

function relativeSince(value: string, now: number): number {
  const match = /^(\d+)([hdw])$/.exec(value);
  if (!match) return now - 7 * 86_400;
  const scale = { h: 3_600, d: 86_400, w: 604_800 }[match[2]!]!;
  return now - Number(match[1]) * scale;
}

/** `2026-09-21 00:00:00` → `09-21`; hour buckets keep the hour. */
function tick(bucket: string, interval: Interval): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(bucket);
  if (!match) return bucket.slice(0, 16);
  return interval === 'day' ? `${match[2]}-${match[3]}` : `${match[3]} ${match[4]}:${match[5]}`;
}

function notConfigured(message: string): string {
  return `<div class="card">
    <h2 style="margin-top:0">Usage reporting is not set up yet</h2>
    <p class="sub">${escapeHtml(message)}</p>
    <p class="muted">Collection is already working — usage events are being written and will still
    be there once this is configured. Only <em>reading</em> them needs an account token, because
    Analytics Engine is written through a binding but queried over the HTTP API.</p>
    <pre>wrangler secret put CF_ANALYTICS_TOKEN   # needs Account Analytics: Read
# and set CF_ACCOUNT_ID in wrangler.toml [vars]</pre>
  </div>`;
}

export async function usagePage(env: Env, url: URL): Promise<Response> {
  const now = nowSeconds();
  const apps = await listApps(env);

  const app = url.searchParams.get('app') ?? apps.results[0]?.id ?? '';
  const windowKey = url.searchParams.get('since') ?? '7d';
  const chosen = WINDOWS.find(w => w.since === windowKey) ?? WINDOWS[1]!;
  const interval = parseInterval(url.searchParams.get('interval') ?? chosen.interval);
  const groupBy = parseGroupBy(url.searchParams.get('groupBy'));
  const event = url.searchParams.get('event');

  const controls = `<form class="card row" method="get" action="/usage">
    <label>App
      <select name="app">
        ${apps.results
          .map(
            a => `<option value="${escapeHtml(a.id)}"${a.id === app ? ' selected' : ''}>${escapeHtml(a.id)}</option>`,
          )
          .join('')}
      </select>
    </label>
    <label>Window
      <select name="since">
        ${WINDOWS.map(
          w => `<option value="${w.since}"${w.since === windowKey ? ' selected' : ''}>${w.label}</option>`,
        ).join('')}
      </select>
    </label>
    <label>Break down by
      <select name="groupBy">
        ${(['event', 'channel', 'release', 'environment'] as GroupBy[])
          .map(g => `<option value="${g}"${g === groupBy ? ' selected' : ''}>${g}</option>`)
          .join('')}
      </select>
    </label>
    ${event ? `<input type="hidden" name="event" value="${escapeHtml(event)}">` : ''}
    <button type="submit">Show</button>
  </form>`;

  if (apps.results.length === 0) {
    return html(layout({ title: 'Usage', body: `<h1>Usage</h1><div class="card empty">Register an app first.</div>` }));
  }

  if (!analyticsConfigured(env)) {
    return html(
      layout({
        title: 'Usage',
        body: `<h1>Usage</h1>${controls}${notConfigured('CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are not both set.')}`,
      }),
    );
  }

  let series: SeriesRow[] = [];
  let breakdown: BreakdownRow[] = [];
  try {
    const query = {
      dataset: env.USAGE_DATASET,
      appId: app,
      since: relativeSince(windowKey, now),
      event,
    };
    [series, breakdown] = await Promise.all([
      fetchSeries(env, query, interval),
      fetchBreakdown(env, query, groupBy, 25),
    ]);
  } catch (error) {
    if (error instanceof AnalyticsUnavailableError) {
      return html(layout({ title: 'Usage', body: `<h1>Usage</h1>${controls}${notConfigured(error.message)}` }));
    }
    return html(
      layout({
        title: 'Usage',
        body: `<h1>Usage</h1>${controls}
          <div class="card"><p class="notice bad">The analytics query failed. The worker log has the
          statement and the error.</p></div>`,
      }),
      502,
    );
  }

  const points = series.map(row => ({ label: tick(row.bucket, interval), value: Number(row.events) }));
  const total = points.reduce((sum, point) => sum + point.value, 0);

  return html(
    layout({
      title: 'Usage',
      body: `
        <h1>Usage</h1>
        <p class="sub">
          ${escapeHtml(app)} · last ${escapeHtml(chosen.label)}
          ${event ? `· only <span class="mono">${escapeHtml(event)}</span> · <a href="/usage?app=${encodeURIComponent(app)}&since=${escapeHtml(windowKey)}">clear filter</a>` : ''}
        </p>
        ${controls}

        <div class="card">
          <div class="row" style="justify-content: space-between; align-items: baseline">
            <strong class="count" style="font-size: 1.6rem">${escapeHtml(count(Math.round(total)))}</strong>
            <span class="muted">events, per ${escapeHtml(interval)}</span>
          </div>
          ${barChart(points)}
          <p class="muted" style="font-size: 0.8rem; margin-bottom: 0">
            Estimated from Analytics Engine, which samples above roughly 100 events/second and
            records the rate so these totals can be weighted back up. Statistically accurate,
            not exact — don't reconcile them against a number that has to balance.
          </p>
        </div>

        <h2>By ${escapeHtml(groupBy)}</h2>
        <div class="card">
          ${rankedBars(
            breakdown.map(row => ({ key: row.key, value: Number(row.events) })),
            value => count(Math.round(value)),
          )}
          ${
            groupBy === 'event' && breakdown.length > 0
              ? `<p class="muted" style="font-size: 0.82rem; margin-bottom: 0">
                   ${breakdown
                     .slice(0, 8)
                     .map(
                       row =>
                         `<a href="/usage?app=${encodeURIComponent(app)}&since=${escapeHtml(windowKey)}&event=${encodeURIComponent(row.key)}">${escapeHtml(row.key || '(none)')}</a>`,
                     )
                     .join(' · ')}
                 </p>`
              : ''
          }
        </div>

        <h2>Values</h2>
        <div class="card">
          <p class="muted" style="font-size: 0.85rem; margin-top: 0">
            The same numbers as the chart, readable without hovering — which is the point, since
            hover does not exist on a phone.
          </p>
          ${
            points.length === 0
              ? `<div class="empty">No data in this window.</div>`
              : `<table>
                  <tr><th>${escapeHtml(interval)}</th><th>events</th></tr>
                  ${points
                    .slice()
                    .reverse()
                    .slice(0, 100)
                    .map(
                      point =>
                        `<tr><td class="mono">${escapeHtml(point.label)}</td><td class="mono">${escapeHtml(count(Math.round(point.value)))}</td></tr>`,
                    )
                    .join('')}
                </table>`
          }
        </div>`,
    }),
  );
}
