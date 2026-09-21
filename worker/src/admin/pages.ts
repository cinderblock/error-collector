/**
 * The admin pages.
 *
 * Plain forms and full page loads rather than a client-side app. Everything here is
 * read from a phone as often as a desktop, and a server-rendered page works on a bad
 * connection, needs no bundle, and cannot drift out of sync with the schema.
 */

import { deriveIngestKey, generateReadToken, hashReadToken, isValidAppId } from '@cinderblock/error-collector-core';
import type { Env } from '../env.js';
import { dayKey, nowSeconds } from '../env.js';
import {
  applyPreset,
  defaultConfig,
  describeLevel,
  levelFor,
  loadGovernorConfig,
  saveGovernorConfig,
  usageRatio,
  type GovernorConfig,
  type Plan,
} from '../governor.js';
import { createApp, listApps, loadAppSecret, rotateAppSecret } from '../storage/apps.js';
import { readAccountUsage, readUsage } from '../storage/usage.js';
import { deleteDevice, listDevices } from '../auth/webauthn.js';
import { createInvite } from '../auth/tokens.js';
import { ago, bytes, count, escapeHtml, html, layout, meter } from './ui.js';

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overviewPage(env: Env): Promise<Response> {
  const now = nowSeconds();
  const day = dayKey(now);

  const [config, usage, apps, recent] = await Promise.all([
    loadGovernorConfig(env),
    readAccountUsage(env, day),
    listApps(env),
    env.DB.prepare(
      `SELECT id, app_id, kind, level, title, culprit, count, last_seen, last_release
       FROM issues WHERE owner_id = ? AND status = 'open' ORDER BY last_seen DESC LIMIT 15`,
    )
      .bind(env.OWNER_ID)
      .all<IssueRow>(),
  ]);

  const level = levelFor(usage, config.account);
  const ratio = usageRatio(usage, config.account);

  const perApp = await Promise.all(apps.results.map(async app => ({ app, usage: await readUsage(env, day, app.id) })));

  return html(
    layout({
      title: 'Overview',
      body: `
        <h1>Overview</h1>
        <p class="sub">${escapeHtml(config.plan)} plan budgets · today is ${escapeHtml(day)} (UTC)</p>

        <div class="card">
          <div class="row" style="justify-content: space-between">
            <strong>Collection level: <span class="chip ${ratio >= 0.95 ? 'error' : ratio >= 0.6 ? 'warning' : 'ok'}">${escapeHtml(level)}</span></strong>
            <a href="/settings">Adjust budgets</a>
          </div>
          <p class="muted" style="margin: 8px 0 14px">${escapeHtml(describeLevel(level))}</p>
          <div class="grid">
            ${meter('Reports', usage.requests, config.account.requestsPerDay, count)}
            ${meter('D1 row writes', usage.d1RowWrites, config.account.d1RowWritesPerDay, count)}
            ${meter('Analytics points', usage.aeDataPoints, config.account.aeDataPointsPerDay, count)}
            ${meter('Attachments today', usage.r2BytesToday, config.account.r2BytesPerDay, bytes)}
            ${meter('Attachments stored', usage.r2BytesTotal, config.account.r2BytesTotal, bytes)}
          </div>
        </div>

        <h2>Apps</h2>
        ${
          perApp.length === 0
            ? `<div class="card empty">No apps yet. <a href="/apps">Register one →</a></div>`
            : `<div class="card"><table>
                <tr><th>App</th><th>Reports today</th><th>Stored</th><th>Dropped</th><th>Quota</th></tr>
                ${perApp
                  .map(
                    ({ app, usage: u }) => `<tr>
                      <td><a href="/issues?app=${encodeURIComponent(app.id)}">${escapeHtml(app.id)}</a></td>
                      <td class="mono">${escapeHtml(count(u.reports))}</td>
                      <td class="mono">${escapeHtml(count(u.stored))}</td>
                      <td class="mono">${escapeHtml(count(u.dropped + u.rejected))}</td>
                      <td class="mono muted">${escapeHtml(count(config.app.maxReportsPerDay))}</td>
                    </tr>`,
                  )
                  .join('')}
              </table></div>`
        }

        <h2>Recent open issues</h2>
        <div class="card">${issueList(recent.results, now)}</div>`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

interface IssueRow {
  id: string;
  app_id: string;
  kind: string;
  level: string;
  title: string;
  culprit: string | null;
  count: number;
  last_seen: number;
  last_release: string | null;
}

function issueList(issues: IssueRow[], now: number): string {
  if (issues.length === 0) return `<div class="empty">Nothing here.</div>`;

  return issues
    .map(
      issue => `<a class="issue" href="/issues/${encodeURIComponent(issue.id)}">
        <div class="row" style="justify-content: space-between; gap: 10px">
          <span class="title">${escapeHtml(issue.title)}</span>
          <span class="count">${escapeHtml(count(issue.count))}×</span>
        </div>
        <div class="meta">
          <span class="chip ${escapeHtml(issue.level)}">${escapeHtml(issue.level)}</span>
          <span class="chip">${escapeHtml(issue.kind)}</span>
          <span class="chip">${escapeHtml(issue.app_id)}</span>
          ${issue.last_release ? `<span class="chip">${escapeHtml(issue.last_release)}</span>` : ''}
          ${issue.culprit ? `${escapeHtml(issue.culprit)} · ` : ''}${escapeHtml(ago(issue.last_seen, now))}
        </div>
      </a>`,
    )
    .join('');
}

export async function issuesPage(env: Env, url: URL): Promise<Response> {
  const now = nowSeconds();
  const app = url.searchParams.get('app') ?? '';
  const status = url.searchParams.get('status') ?? 'open';
  const kind = url.searchParams.get('kind') ?? 'all';

  const where = ['owner_id = ?'];
  const bindings: unknown[] = [env.OWNER_ID];
  if (app) {
    where.push('app_id = ?');
    bindings.push(app);
  }
  if (status !== 'all') {
    where.push('status = ?');
    bindings.push(status);
  }
  if (kind !== 'all') {
    where.push('kind = ?');
    bindings.push(kind);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, app_id, kind, level, title, culprit, count, last_seen, last_release
     FROM issues WHERE ${where.join(' AND ')} ORDER BY last_seen DESC LIMIT 100`,
  )
    .bind(...bindings)
    .all<IssueRow>();

  const apps = await listApps(env);
  const option = (value: string, label: string, selected: string) =>
    `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

  return html(
    layout({
      title: 'Issues',
      body: `
        <h1>Issues</h1>
        <form class="card row" method="get" action="/issues">
          <label>App
            <select name="app">
              ${option('', 'all apps', app)}
              ${apps.results.map(a => option(a.id, a.id, app)).join('')}
            </select>
          </label>
          <label>Status
            <select name="status">
              ${['open', 'resolved', 'ignored', 'all'].map(s => option(s, s, status)).join('')}
            </select>
          </label>
          <label>Kind
            <select name="kind">
              ${['all', 'error', 'feedback', 'message'].map(k => option(k, k, kind)).join('')}
            </select>
          </label>
          <button type="submit">Filter</button>
        </form>
        <div class="card">${issueList(results, now)}</div>`,
    }),
  );
}

interface EventRow {
  id: string;
  channel: string;
  ts: number;
  level: string;
  attested: number;
  payload: string;
}

export async function issuePage(env: Env, id: string): Promise<Response> {
  const now = nowSeconds();

  const issue = await env.DB.prepare('SELECT * FROM issues WHERE id = ? AND owner_id = ?')
    .bind(id, env.OWNER_ID)
    .first<Record<string, unknown>>();
  if (!issue) return html(layout({ title: 'Not found', body: '<h1>No such issue</h1>' }), 404);

  const [{ results: events }, { results: blobs }] = await Promise.all([
    env.DB.prepare(
      'SELECT id, channel, ts, level, attested, payload FROM events WHERE issue_id = ? ORDER BY ts DESC LIMIT 10',
    )
      .bind(id)
      .all<EventRow>(),
    env.DB.prepare(
      'SELECT b.key, b.event_id, b.kind, b.bytes, b.content_type FROM blobs b JOIN events e ON e.id = b.event_id WHERE e.issue_id = ?',
    )
      .bind(id)
      .all<{ key: string; event_id: string; kind: string; bytes: number; content_type: string }>(),
  ]);

  const attachmentsFor = (eventId: string) =>
    blobs
      .filter(blob => blob.event_id === eventId)
      .map(blob =>
        blob.content_type.startsWith('image/')
          ? `<figure style="margin: 10px 0">
               <img src="/b/${encodeURIComponent(blob.key)}" alt="${escapeHtml(blob.kind)} attached to this report"
                    style="max-width: 100%; border: 1px solid var(--border); border-radius: 8px">
               <figcaption class="muted" style="font-size: 0.8rem">${escapeHtml(blob.kind)} · ${escapeHtml(bytes(blob.bytes))}</figcaption>
             </figure>`
          : `<p><a href="/b/${encodeURIComponent(blob.key)}">${escapeHtml(blob.kind)}</a>
               <span class="muted">${escapeHtml(bytes(blob.bytes))}</span></p>`,
      )
      .join('');

  const status = String(issue.status);
  const statusButton = (next: string, label: string, className = 'secondary') =>
    status === next
      ? ''
      : `<form method="post" action="/issues/${encodeURIComponent(id)}/status" style="display:inline">
           <input type="hidden" name="status" value="${next}">
           <button class="${className}" type="submit">${escapeHtml(label)}</button>
         </form>`;

  return html(
    layout({
      title: String(issue.title),
      body: `
        <h1>${escapeHtml(issue.title)}</h1>
        <p class="sub">
          <span class="chip ${escapeHtml(issue.level)}">${escapeHtml(issue.level)}</span>
          <span class="chip">${escapeHtml(issue.kind)}</span>
          <span class="chip">${escapeHtml(issue.app_id)}</span>
          <span class="chip ${status === 'open' ? '' : 'ok'}">${escapeHtml(status)}</span>
          ${issue.culprit ? `at ${escapeHtml(issue.culprit)}` : ''}
        </p>

        <div class="card">
          <div class="grid">
            <div><strong class="count">${escapeHtml(count(Number(issue.count)))}</strong><br><span class="muted">occurrences</span></div>
            <div><strong class="count">${escapeHtml(count(Number(issue.attested_count)))}</strong><br><span class="muted">signed by our own code</span></div>
            <div><strong>${escapeHtml(ago(Number(issue.first_seen), now))}</strong><br><span class="muted">first seen, in ${escapeHtml(String(issue.first_release ?? issue.first_channel))}</span></div>
            <div><strong>${escapeHtml(ago(Number(issue.last_seen), now))}</strong><br><span class="muted">last seen, in ${escapeHtml(String(issue.last_release ?? issue.last_channel))}</span></div>
          </div>
          <p class="muted" style="margin-top: 14px; font-size: 0.85rem">
            ${escapeHtml(count(Number(issue.sample_count)))} full example(s) kept. The occurrence count is exact even
            when examples were sampled away.
          </p>
          <div class="row" style="margin-top: 10px">
            ${statusButton('resolved', 'Mark resolved')}
            ${statusButton('ignored', 'Ignore')}
            ${statusButton('open', 'Reopen')}
          </div>
        </div>

        <h2>Examples</h2>
        ${
          events.length === 0
            ? `<div class="card empty">No examples were kept for this issue.</div>`
            : events.map(event => renderEvent(event, now, attachmentsFor(event.id))).join('')
        }`,
    }),
  );
}

function renderEvent(event: EventRow, now: number, attachments: string): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.payload) as Record<string, unknown>;
  } catch {
    return `<div class="card muted">This example could not be parsed.</div>`;
  }

  const exception = (payload.exception as { values?: ExceptionValue[] } | undefined)?.values ?? [];
  const breadcrumbs = (payload.breadcrumbs as { values?: BreadcrumbValue[] } | undefined)?.values ?? [];

  return `<div class="card">
    <div class="row" style="justify-content: space-between">
      <span>
        <span class="chip">${escapeHtml(event.channel)}</span>
        ${event.attested ? `<span class="chip ok">signed</span>` : `<span class="chip">unsigned</span>`}
      </span>
      <span class="muted">${escapeHtml(ago(event.ts, now))}</span>
    </div>

    ${payload.message ? `<p>${escapeHtml(payload.message)}</p>` : ''}
    ${payload.url ? `<p class="muted mono">${escapeHtml(payload.url)}</p>` : ''}

    ${exception.map(renderException).join('')}
    ${attachments}

    ${
      breadcrumbs.length > 0
        ? `<details><summary>${breadcrumbs.length} breadcrumb(s) before the failure</summary>
             <pre>${escapeHtml(
               breadcrumbs
                 .slice(-20)
                 .map(crumb => `${crumb.category ?? crumb.type ?? '-'}  ${crumb.message ?? ''}`)
                 .join('\n'),
             )}</pre>
           </details>`
        : ''
    }

    <details><summary>Full event</summary><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></details>
  </div>`;
}

interface ExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: { frames?: { function?: string; filename?: string; lineno?: number; in_app?: boolean }[] };
}

interface BreadcrumbValue {
  type?: string;
  category?: string;
  message?: string;
}

function renderException(exception: ExceptionValue): string {
  const frames = exception.stacktrace?.frames ?? [];
  // Stored innermost-last; humans read stacks the other way round.
  const lines = [...frames]
    .reverse()
    .map(
      frame =>
        `  at ${frame.function ?? '?'} (${frame.filename ?? '?'}:${frame.lineno ?? '?'})${frame.in_app === false ? '   [library]' : ''}`,
    )
    .join('\n');

  return `<p><strong>${escapeHtml(exception.type ?? 'Error')}</strong>: ${escapeHtml(exception.value ?? '')}</p>
    ${lines ? `<pre>${escapeHtml(lines)}</pre>` : ''}`;
}

export async function updateIssueStatus(env: Env, id: string, request: Request): Promise<Response> {
  const form = await request.formData();
  const status = String(form.get('status') ?? '');
  if (!['open', 'resolved', 'ignored'].includes(status)) return redirect(`/issues/${encodeURIComponent(id)}`);

  // Recording *which release* it was resolved in is what lets the ingest path tell a
  // genuine regression from events still trickling in from an older build.
  await env.DB.prepare(
    `UPDATE issues SET status = ?, resolved_in = CASE WHEN ? = 'resolved' THEN last_release ELSE NULL END
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(status, status, id, env.OWNER_ID)
    .run();

  return redirect(`/issues/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export async function appsPage(env: Env, revealed?: { id: string; secret: string }): Promise<Response> {
  const apps = await listApps(env);
  const now = nowSeconds();

  const reveal = revealed
    ? `<div class="card">
        <h2 style="margin-top:0">Secret for ${escapeHtml(revealed.id)}</h2>
        <p class="sub">Shown once and never again. Put it in the project's CI secrets as
        <span class="mono">ERROR_COLLECTOR_APP_SECRET</span>.</p>
        <div class="reveal mono">${escapeHtml(revealed.secret)}</div>
        <p class="muted">Derive a build's public ingest key from it, offline:</p>
        <pre>error-collector key --app ${escapeHtml(revealed.id)} --channel "$VERSION"</pre>
        <p class="muted">The ingest key that produces is <em>public</em> — it is meant to ship inside
        the app. This secret is not.</p>
      </div>`
    : '';

  return html(
    layout({
      title: 'Apps',
      body: `
        <h1>Apps</h1>
        <p class="sub">Each app has one secret. Every version, environment and preview derives its own
        public ingest key from it, with no registration step.</p>

        ${reveal}

        <div class="card">
          ${
            apps.results.length === 0
              ? `<div class="empty">No apps yet.</div>`
              : `<table>
                  <tr><th>App</th><th>Name</th><th>Added</th><th></th></tr>
                  ${apps.results
                    .map(
                      app => `<tr>
                        <td class="mono">${escapeHtml(app.id)}</td>
                        <td>${escapeHtml(app.name)}</td>
                        <td class="muted">${escapeHtml(ago(app.created_at, now))}</td>
                        <td>
                          <form method="post" action="/apps/${encodeURIComponent(app.id)}/rotate">
                            <button class="danger" type="submit">Rotate secret</button>
                          </form>
                        </td>
                      </tr>`,
                    )
                    .join('')}
                </table>
                <p class="muted" style="font-size: 0.85rem; margin-top: 12px">
                  Rotating invalidates every ingest key derived from the old secret, including the ones
                  already compiled into copies of the app people are running. Those go silent until they
                  ship a rebuild — right for a compromised secret, wrong for routine hygiene.
                </p>`
          }
        </div>

        <h2>Register an app</h2>
        <div class="card">
          <form class="stack" method="post" action="/apps">
            <label>App id
              <span class="hint">Lowercase, hyphens, no dots — dots separate the fields of an ingest key.</span>
              <input name="id" required maxlength="64" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]" placeholder="gate-manager">
            </label>
            <label>Display name
              <input name="name" maxlength="100" placeholder="Gate Manager">
            </label>
            <div><button type="submit">Register</button></div>
          </form>
        </div>`,
    }),
  );
}

export async function createAppAction(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get('id') ?? '').trim();
  const name = String(form.get('name') ?? '').trim() || id;

  if (!isValidAppId(id)) {
    return html(
      layout({
        title: 'Apps',
        body: `<h1>That app id will not work</h1>
          <p class="sub">Ids are lowercase letters, digits and hyphens, and must not contain a dot.</p>
          <p><a href="/apps">← Back</a></p>`,
      }),
      400,
    );
  }

  const created = await createApp(env, id, name);
  return appsPage(env, { id, secret: created.secret });
}

export async function rotateAppAction(env: Env, id: string): Promise<Response> {
  const secret = await rotateAppSecret(env, id);
  return appsPage(env, { id, secret });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const ACCOUNT_FIELDS: { key: keyof GovernorConfig['account']; label: string; hint: string }[] = [
  { key: 'requestsPerDay', label: 'Reports per day', hint: 'Worker requests. Free plan allows 100k account-wide.' },
  { key: 'd1RowWritesPerDay', label: 'D1 row writes per day', hint: 'Free plan hard-fails at 100k; leave headroom.' },
  { key: 'aeDataPointsPerDay', label: 'Analytics points per day', hint: 'Free plan allows 100k.' },
  { key: 'r2BytesPerDay', label: 'Attachment bytes per day', hint: 'Screenshots and uploads written today.' },
  { key: 'r2BytesTotal', label: 'Attachment bytes stored', hint: 'Total in R2. Free plan includes 10 GB.' },
];

const APP_FIELDS: { key: keyof GovernorConfig['app']; label: string; hint: string }[] = [
  { key: 'maxReportsPerDay', label: 'Reports per app per day', hint: 'Stops one runaway app blinding the others.' },
  { key: 'maxSamplesPerIssue', label: 'Examples kept per issue', hint: 'The count stays exact past this.' },
  { key: 'sampleEveryN', label: 'Sample one in every', hint: 'After the first few examples of an issue.' },
  { key: 'keepFirst', label: 'Always keep the first', hint: 'Early examples of a new issue.' },
  { key: 'maxBodyBytes', label: 'Max report body bytes', hint: '' },
  { key: 'maxBlobBytes', label: 'Max attachment bytes', hint: '' },
  { key: 'retentionDays', label: 'Keep examples for (days)', hint: 'Analytics keeps 90 days regardless.' },
];

export async function settingsPage(env: Env, revealedToken?: string): Promise<Response> {
  const now = nowSeconds();
  const [config, usage, devices, apps, tokens] = await Promise.all([
    loadGovernorConfig(env),
    readAccountUsage(env, dayKey(now)),
    listDevices(env),
    listApps(env),
    env.DB.prepare(
      'SELECT hash, name, scope, created_at, expires_at, last_used_at, revoked_at FROM read_tokens WHERE owner_id = ? ORDER BY created_at DESC',
    )
      .bind(env.OWNER_ID)
      .all<{
        hash: string;
        name: string;
        scope: string;
        created_at: number;
        last_used_at: number | null;
        revoked_at: number | null;
      }>(),
  ]);

  const level = levelFor(usage, config.account);
  const numberField = (name: string, label: string, hint: string, value: number) =>
    `<label>${escapeHtml(label)}
       ${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}
       <input type="number" name="${escapeHtml(name)}" value="${value}" min="0" step="1">
     </label>`;

  return html(
    layout({
      title: 'Settings',
      body: `
        <h1>Settings</h1>

        <h2>Budget</h2>
        <div class="card">
          <p class="sub">Currently <strong>${escapeHtml(level)}</strong>. ${escapeHtml(describeLevel(level))}</p>
          <form class="stack" method="post" action="/settings/governor">
            <label>Cloudflare plan
              <span class="hint">Switching resets every budget below to that plan's preset, discarding tuning.</span>
              <select name="plan">
                ${(['free', 'paid'] as Plan[])
                  .map(
                    plan =>
                      `<option value="${plan}"${plan === config.plan ? ' selected' : ''}>${plan}${plan === config.plan ? ' (current)' : ''}</option>`,
                  )
                  .join('')}
              </select>
            </label>
            <div class="row"><button name="action" value="preset" class="secondary" type="submit">Apply preset</button></div>
          </form>
        </div>

        <div class="card">
          <form class="stack" method="post" action="/settings/governor">
            <input type="hidden" name="plan" value="${escapeHtml(config.plan)}">
            <strong>Account budget, per day</strong>
            <div class="grid">
              ${ACCOUNT_FIELDS.map(f => numberField(`account.${f.key}`, f.label, f.hint, config.account[f.key])).join('')}
            </div>
            <strong style="margin-top: 10px">Per-app limits</strong>
            <div class="grid">
              ${APP_FIELDS.map(f => numberField(`app.${f.key}`, f.label, f.hint, config.app[f.key])).join('')}
            </div>
            <div class="row">
              <button name="action" value="save" type="submit">Save budgets</button>
              <button name="action" value="reset" class="secondary" type="submit">Reset to ${escapeHtml(config.plan)} preset</button>
            </div>
          </form>
        </div>

        <h2>Read tokens</h2>
        <div class="card">
          ${
            revealedToken
              ? `<p class="sub">Shown once. Put it in the agent's environment as
                 <span class="mono">ERROR_COLLECTOR_TOKEN</span>.</p>
                 <div class="reveal mono">${escapeHtml(revealedToken)}</div>`
              : ''
          }
          ${
            tokens.results.length === 0
              ? `<div class="empty">No tokens yet.</div>`
              : `<table>
                  <tr><th>Name</th><th>Scope</th><th>Last used</th><th></th></tr>
                  ${tokens.results
                    .map(token => {
                      const scope = JSON.parse(token.scope) as { apps: string[]; write: boolean };
                      return `<tr>
                        <td>${escapeHtml(token.name)}${token.revoked_at ? ' <span class="chip">revoked</span>' : ''}</td>
                        <td class="mono">${escapeHtml(scope.apps.join(', '))}${scope.write ? ' <span class="chip warning">write</span>' : ''}</td>
                        <td class="muted">${token.last_used_at ? escapeHtml(ago(token.last_used_at, now)) : 'never'}</td>
                        <td>${
                          token.revoked_at
                            ? ''
                            : `<form method="post" action="/settings/tokens/revoke">
                                 <input type="hidden" name="hash" value="${escapeHtml(token.hash)}">
                                 <button class="danger" type="submit">Revoke</button>
                               </form>`
                        }</td>
                      </tr>`;
                    })
                    .join('')}
                </table>`
          }
          <form class="stack" method="post" action="/settings/tokens" style="margin-top: 14px">
            <label>Name
              <span class="hint">Where it will live, so a leak is traceable — "claude on laptop", "gate-manager CI".</span>
              <input name="name" required maxlength="60" placeholder="agent on laptop">
            </label>
            <label>Scope
              <span class="hint">Give an agent only the app it works on.</span>
              <select name="app">
                <option value="*">all apps</option>
                ${apps.results.map(app => `<option value="${escapeHtml(app.id)}">${escapeHtml(app.id)}</option>`).join('')}
              </select>
            </label>
            <div><button type="submit">Mint token</button></div>
          </form>
        </div>

        <h2>Devices</h2>
        <div class="card">
          <table>
            <tr><th>Device</th><th>Added</th><th>Last used</th><th></th></tr>
            ${devices.results
              .map(
                device => `<tr>
                  <td>${escapeHtml(device.name)}</td>
                  <td class="muted">${escapeHtml(ago(device.created_at, now))}</td>
                  <td class="muted">${device.last_used_at ? escapeHtml(ago(device.last_used_at, now)) : 'never'}</td>
                  <td>
                    <form method="post" action="/settings/devices/delete">
                      <input type="hidden" name="id" value="${escapeHtml(device.id)}">
                      <button class="danger" type="submit"${devices.results.length === 1 ? ' disabled' : ''}>Remove</button>
                    </form>
                  </td>
                </tr>`,
              )
              .join('')}
          </table>
          ${
            devices.results.length === 1
              ? `<p class="muted" style="font-size: 0.85rem">The last device cannot be removed — doing so would lock
                 everyone out and leave the bootstrap token as the only way back in.</p>`
              : ''
          }
          <form method="post" action="/settings/devices/invite" style="margin-top: 12px">
            <button class="secondary" type="submit">Create an enrolment link</button>
          </form>
        </div>

        <div class="card">
          <form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form>
        </div>`,
    }),
  );
}

function readNumbers<T extends object>(form: FormData, prefix: string, current: T): T {
  const next = { ...current } as Record<string, unknown>;
  for (const key of Object.keys(current)) {
    const raw = form.get(`${prefix}.${key}`);
    const value = Number(raw);
    // A blank or nonsense field keeps the current value rather than zeroing a
    // budget, which would instantly put the service into `rejecting`.
    if (raw !== null && Number.isFinite(value) && value >= 0) next[key] = value;
  }
  return next as T;
}

export async function saveGovernorAction(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const action = String(form.get('action') ?? 'save');
  const plan = (String(form.get('plan') ?? 'free') === 'paid' ? 'paid' : 'free') as Plan;
  const current = await loadGovernorConfig(env);

  if (action === 'preset' || action === 'reset') {
    await saveGovernorConfig(env, action === 'preset' ? applyPreset(plan) : defaultConfig(current.plan));
    return redirect('/settings');
  }

  await saveGovernorConfig(env, {
    plan,
    account: readNumbers(form, 'account', current.account),
    app: readNumbers(form, 'app', current.app),
  });
  return redirect('/settings');
}

export async function createTokenAction(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const name =
    String(form.get('name') ?? '')
      .trim()
      .slice(0, 60) || 'token';
  const app = String(form.get('app') ?? '*');

  const token = generateReadToken();
  await env.DB.prepare('INSERT INTO read_tokens (hash, owner_id, name, scope, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await hashReadToken(token), env.OWNER_ID, name, JSON.stringify({ apps: [app], write: false }), nowSeconds())
    .run();

  return settingsPage(env, token);
}

export async function revokeTokenAction(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  await env.DB.prepare('UPDATE read_tokens SET revoked_at = ? WHERE hash = ? AND owner_id = ?')
    .bind(nowSeconds(), String(form.get('hash') ?? ''), env.OWNER_ID)
    .run();
  return redirect('/settings');
}

export async function deleteDeviceAction(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');

  // Refused server-side as well as disabled in the UI: the button is a courtesy,
  // this is the actual guarantee that the service cannot be locked out.
  const devices = await listDevices(env);
  if (devices.results.length <= 1) return redirect('/settings');

  await deleteDevice(env, id);
  return redirect('/settings');
}

export async function createInviteAction(env: Env, url: URL): Promise<Response> {
  const invite = await createInvite(env);
  const link = `${url.origin}/register?invite=${encodeURIComponent(invite.id)}`;

  return html(
    layout({
      title: 'Enrolment link',
      body: `<h1>Enrolment link</h1>
        <p class="sub">Open this on the new device. It works once, and expires
        ${escapeHtml(ago(invite.expiresAt, nowSeconds()).replace(' ago', ''))} from now.</p>
        <div class="reveal mono">${escapeHtml(link)}</div>
        <p><a href="/settings">← Settings</a></p>`,
    }),
  );
}

export async function serveAdminBlob(env: Env, key: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT content_type FROM blobs WHERE key = ? AND owner_id = ?')
    .bind(key, env.OWNER_ID)
    .first<{ content_type: string }>();
  if (!row) return new Response('not found', { status: 404 });

  const object = await env.BLOBS.get(key);
  if (!object) return new Response('attachment has been pruned', { status: 410 });

  return new Response(object.body, {
    headers: { 'content-type': row.content_type, 'cache-control': 'private, max-age=3600' },
  });
}

export { loadAppSecret, deriveIngestKey };
