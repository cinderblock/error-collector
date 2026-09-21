/**
 * Login and device-enrolment pages, plus the WebAuthn ceremony endpoints.
 *
 * There is no password anywhere in this service. The first device enrols with
 * `BOOTSTRAP_TOKEN`, which is honoured **only while zero devices exist** — so it
 * stops being a credential the moment it has been used once. Every later device
 * enrols through a single-use invite link minted by an already-trusted device.
 */

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '../env.js';
import {
  authenticationOptions,
  countDevices,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../auth/webauthn.js';
import { timingSafeEqual } from '@cinderblock/error-collector-core';
import { claimInvite, createSession, sessionCookie } from '../auth/tokens.js';
import { escapeHtml, html, layout } from './ui.js';

/** Shared browser-side helpers for both ceremonies. */
const WEBAUTHN_CLIENT = `
const b64uToBytes = s => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const bytesToB64u = b =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');

function say(message, bad) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = bad ? 'notice bad' : 'notice';
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
}
`;

function unsupportedNotice(): string {
  return `<p class="muted">Passkeys need a secure context. On a plain-HTTP origin other than
    <span class="mono">localhost</span>, the browser will refuse the ceremony.</p>`;
}

export async function loginPage(env: Env): Promise<Response> {
  if ((await countDevices(env)) === 0) {
    return html(
      layout({
        title: 'Set up',
        authed: false,
        body: `<h1>No devices enrolled yet</h1>
          <p class="sub">This service has never been set up. Enrol the first passkey with the
          bootstrap token.</p>
          <p><a href="/register">Enrol the first device →</a></p>`,
      }),
    );
  }

  return html(
    layout({
      title: 'Sign in',
      authed: false,
      body: `<h1>Sign in</h1>
        <p class="sub">Use the passkey on this device.</p>
        <div id="status" class="notice">Ready.</div>
        <button id="go">Sign in with a passkey</button>
        ${unsupportedNotice()}
        <script>
        ${WEBAUTHN_CLIENT}
        document.getElementById('go').addEventListener('click', async () => {
          try {
            say('Waiting for your passkey…');
            const { options, stateId } = await post('/auth/options', {});

            options.challenge = b64uToBytes(options.challenge);
            for (const c of options.allowCredentials ?? []) c.id = b64uToBytes(c.id);

            const credential = await navigator.credentials.get({ publicKey: options });
            await post('/auth/verify', {
              stateId,
              response: {
                id: credential.id,
                rawId: bytesToB64u(credential.rawId),
                type: credential.type,
                clientExtensionResults: credential.getClientExtensionResults(),
                response: {
                  clientDataJSON: bytesToB64u(credential.response.clientDataJSON),
                  authenticatorData: bytesToB64u(credential.response.authenticatorData),
                  signature: bytesToB64u(credential.response.signature),
                  userHandle: credential.response.userHandle ? bytesToB64u(credential.response.userHandle) : undefined,
                },
              },
            });
            location.href = '/';
          } catch (error) {
            say(error.message || String(error), true);
          }
        });
        </script>`,
    }),
  );
}

export async function registerPage(env: Env, url: URL): Promise<Response> {
  const first = (await countDevices(env)) === 0;
  const invite = url.searchParams.get('invite') ?? '';

  if (!first && !invite) {
    return html(
      layout({
        title: 'Enrol a device',
        authed: false,
        body: `<h1>Enrolment needs an invite</h1>
          <p class="sub">Devices are enrolled from a single-use link. Sign in on a device you
          already have and mint one under Settings.</p>
          <p><a href="/login">← Sign in</a></p>`,
      }),
      403,
    );
  }

  const credentialField = first
    ? `<label>Bootstrap token
         <span class="hint">From <span class="mono">wrangler secret put BOOTSTRAP_TOKEN</span>. Accepted only while no devices exist.</span>
         <input id="bootstrap" type="password" autocomplete="off">
       </label>`
    : `<input id="bootstrap" type="hidden" value="">`;

  return html(
    layout({
      title: 'Enrol a device',
      authed: false,
      body: `<h1>${first ? 'Enrol the first device' : 'Enrol this device'}</h1>
        <p class="sub">${
          first
            ? 'Creates a passkey for this service. The bootstrap token stops working once this succeeds.'
            : 'This invite link works once, and expires shortly after it was created.'
        }</p>
        <form class="stack" id="form" onsubmit="return false">
          <label>Device name
            <span class="hint">So you can tell them apart later — "iPhone", "work laptop".</span>
            <input id="name" value="my device" maxlength="60">
          </label>
          ${credentialField}
          <div><button id="go">Create a passkey</button></div>
        </form>
        <div id="status" class="notice">Ready.</div>
        ${unsupportedNotice()}
        <script>
        ${WEBAUTHN_CLIENT}
        const invite = ${JSON.stringify(invite)};
        document.getElementById('go').addEventListener('click', async () => {
          try {
            say('Waiting for your passkey…');
            const bootstrap = document.getElementById('bootstrap').value;
            const name = document.getElementById('name').value || 'device';

            const { options, stateId } = await post('/devices/register/options', { bootstrap, invite });

            options.challenge = b64uToBytes(options.challenge);
            options.user.id = b64uToBytes(options.user.id);
            for (const c of options.excludeCredentials ?? []) c.id = b64uToBytes(c.id);

            const credential = await navigator.credentials.create({ publicKey: options });
            await post('/devices/register/verify', {
              stateId, name, bootstrap, invite,
              response: {
                id: credential.id,
                rawId: bytesToB64u(credential.rawId),
                type: credential.type,
                clientExtensionResults: credential.getClientExtensionResults(),
                response: {
                  clientDataJSON: bytesToB64u(credential.response.clientDataJSON),
                  attestationObject: bytesToB64u(credential.response.attestationObject),
                  transports: credential.response.getTransports ? credential.response.getTransports() : [],
                },
              },
            });
            location.href = '/';
          } catch (error) {
            say(error.message || String(error), true);
          }
        });
        </script>`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Ceremony endpoints
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

export async function handleAuthOptions(env: Env, url: URL): Promise<Response> {
  return json(await authenticationOptions(env, url));
}

export async function handleAuthVerify(env: Env, url: URL, request: Request): Promise<Response> {
  const body = (await request.json()) as { stateId?: string; response?: AuthenticationResponseJSON };
  if (!body.stateId || !body.response) return json({ ok: false, error: 'malformed request' }, 400);

  try {
    const device = await verifyAuthentication(env, url, body.stateId, body.response);
    const session = await createSession(env, device.id);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(session, url.protocol === 'https:') });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : 'sign-in failed' }, 401);
  }
}

/**
 * Both registration endpoints re-check the caller's right to enrol. Checking only
 * when handing out options would let someone skip straight to `verify` with a
 * stateId they obtained some other way.
 */
async function mayEnrol(env: Env, bootstrap: string, invite: string, consumeInvite: boolean): Promise<boolean> {
  if ((await countDevices(env)) === 0) {
    if (!env.BOOTSTRAP_TOKEN) return false;
    return timingSafeEqual(bootstrap, env.BOOTSTRAP_TOKEN);
  }
  if (!invite) return false;
  // Only the verify step consumes it, so a failed passkey ceremony does not burn
  // the link and strand the user.
  return consumeInvite ? claimInvite(env, invite) : inviteIsLive(env, invite);
}

async function inviteIsLive(env: Env, invite: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT id FROM device_invites WHERE id = ? AND owner_id = ? AND used_at IS NULL AND expires_at > ?',
  )
    .bind(invite, env.OWNER_ID, Math.floor(Date.now() / 1000))
    .first<{ id: string }>();
  return row !== null;
}

export async function handleRegisterOptions(env: Env, url: URL, request: Request): Promise<Response> {
  const body = (await request.json()) as { bootstrap?: string; invite?: string };
  if (!(await mayEnrol(env, body.bootstrap ?? '', body.invite ?? '', false))) {
    return json({ ok: false, error: 'not allowed to enrol a device' }, 403);
  }
  return json(await registrationOptions(env, url));
}

export async function handleRegisterVerify(env: Env, url: URL, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    stateId?: string;
    name?: string;
    bootstrap?: string;
    invite?: string;
    response?: RegistrationResponseJSON;
  };
  if (!body.stateId || !body.response) return json({ ok: false, error: 'malformed request' }, 400);

  if (!(await mayEnrol(env, body.bootstrap ?? '', body.invite ?? '', true))) {
    return json({ ok: false, error: 'not allowed to enrol a device' }, 403);
  }

  try {
    const device = await verifyRegistration(
      env,
      url,
      body.stateId,
      (body.name ?? 'device').slice(0, 60),
      body.response,
    );
    const session = await createSession(env, device.id);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(session, url.protocol === 'https:') });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : 'enrolment failed' }, 400);
  }
}

export function requireLogin(): Response {
  return new Response(null, { status: 302, headers: { location: '/login' } });
}

export { escapeHtml };
