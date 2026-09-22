/**
 * The channels tab.
 *
 * Retiring a version is always a deliberate act here — there is no automation behind
 * this page that retires anything. What it does offer is the information that makes
 * the decision easy: when a channel was last seen, how much data it holds, and a
 * flagged list of ones that have gone quiet. Suggesting is useful; acting would be
 * wrong, because "quiet for three weeks" and "safe to stop collecting" are not the
 * same statement.
 */

import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';
import { listChannels, quietChannels, reactivateChannel, retireChannel } from '../storage/channels.js';
import { listApps } from '../storage/apps.js';
import { ago, count, escapeHtml, html, layout } from './ui.js';

/** How long a channel must be silent before it is *suggested* for retirement. */
const QUIET_DAYS = 30;

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export async function channelsPage(env: Env, url: URL): Promise<Response> {
  const now = nowSeconds();
  const app = url.searchParams.get('app') ?? '';

  const [apps, channels, quiet] = await Promise.all([
    listApps(env),
    listChannels(env, app || undefined),
    quietChannels(env, QUIET_DAYS, app || undefined),
  ]);

  const quietKeys = new Set(quiet.map(c => `${c.app_id}/${c.channel}`));

  const filter = `<form class="card row" method="get" action="/channels">
    <label>App
      <select name="app">
        <option value="">all apps</option>
        ${apps.results
          .map(
            a => `<option value="${escapeHtml(a.id)}"${a.id === app ? ' selected' : ''}>${escapeHtml(a.id)}</option>`,
          )
          .join('')}
      </select>
    </label>
    <button type="submit">Filter</button>
  </form>`;

  const row = (channel: (typeof channels)[number]) => {
    const key = `${channel.app_id}/${channel.channel}`;
    const retired = channel.status === 'retired';

    const action = retired
      ? `<form method="post" action="/channels/reactivate">
           <input type="hidden" name="app" value="${escapeHtml(channel.app_id)}">
           <input type="hidden" name="channel" value="${escapeHtml(channel.channel)}">
           <button class="secondary" type="submit">Resume collecting</button>
         </form>`
      : `<form method="post" action="/channels/retire" class="row" style="gap: 6px">
           <input type="hidden" name="app" value="${escapeHtml(channel.app_id)}">
           <input type="hidden" name="channel" value="${escapeHtml(channel.channel)}">
           <input name="note" placeholder="superseded by…" maxlength="200" style="max-width: 11rem">
           <select name="purgeAfterDays">
             <option value="0">keep data</option>
             <option value="30">delete in 30d</option>
             <option value="90">delete in 90d</option>
           </select>
           <button class="danger" type="submit">Retire</button>
         </form>`;

    return `<tr>
      <td class="mono">${escapeHtml(channel.channel)}
        ${quietKeys.has(key) ? `<span class="chip warning">quiet ${QUIET_DAYS}d+</span>` : ''}
        ${retired ? `<span class="chip">retired ${escapeHtml(ago(channel.retired_at ?? now, now))}</span>` : ''}
        ${channel.note ? `<div class="muted" style="font-size: 0.82rem">${escapeHtml(channel.note)}</div>` : ''}
        ${
          channel.purge_after
            ? `<div class="muted" style="font-size: 0.82rem">data deleted ${escapeHtml(
                ago(channel.purge_after, now).replace(' ago', ''),
              )} from now</div>`
            : ''
        }
      </td>
      <td class="mono">${escapeHtml(channel.app_id)}</td>
      <td class="muted">${escapeHtml(ago(channel.last_seen, now))}</td>
      <td class="mono">${escapeHtml(count(channel.issues))} / ${escapeHtml(count(channel.events))}</td>
      <td>${action}</td>
    </tr>`;
  };

  return html(
    layout({
      title: 'Channels',
      body: `
        <h1>Channels</h1>
        <p class="sub">Every version, environment and preview that has ever reported. Retiring one stops
        it being collected; it never happens on its own.</p>
        ${filter}

        ${
          quiet.length > 0
            ? `<div class="card">
                 <strong>${quiet.length} channel(s) have not reported in ${QUIET_DAYS} days</strong>
                 <p class="muted" style="margin: 6px 0 0">
                   Flagged, not retired. Silence usually means everyone has moved on — but it is also
                   what a version looks like right before a straggler finally hits the bug you were
                   waiting for, so this is your call to make.
                 </p>
               </div>`
            : ''
        }

        <div class="card">
          ${
            channels.length === 0
              ? `<div class="empty">Nothing has reported yet.</div>`
              : `<table>
                  <tr><th>Channel</th><th>App</th><th>Last seen</th><th>Issues / events</th><th></th></tr>
                  ${channels.map(row).join('')}
                </table>`
          }
        </div>

        <div class="card">
          <p class="muted" style="margin: 0; font-size: 0.85rem">
            A retired channel answers <span class="mono">410 Gone</span>, which the SDK honours by
            standing down for the rest of the session rather than retrying. Expect up to a minute
            before that takes effect everywhere — the status is cached on the ingest path so that
            checking it costs nothing per report.
          </p>
        </div>`,
    }),
  );
}

export async function retireChannelAction(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const app = String(form.get('app') ?? '');
  const channel = String(form.get('channel') ?? '');
  if (!app || !channel) return redirect('/channels');

  const days = Number(form.get('purgeAfterDays') ?? 0);
  await retireChannel(env, app, channel, {
    note: String(form.get('note') ?? '').trim() || undefined,
    purgeAfterDays: Number.isFinite(days) && days > 0 ? days : undefined,
  });

  return redirect(`/channels?app=${encodeURIComponent(app)}`);
}

export async function reactivateChannelAction(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const app = String(form.get('app') ?? '');
  const channel = String(form.get('channel') ?? '');
  if (!app || !channel) return redirect('/channels');

  await reactivateChannel(env, app, channel);
  return redirect(`/channels?app=${encodeURIComponent(app)}`);
}
