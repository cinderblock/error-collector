/**
 * Admin routing and the session guard.
 *
 * Everything except the login and enrolment pages goes through `readSession`. The
 * guard is applied here, once, rather than at the top of each handler — a page that
 * forgets the check is the whole failure mode, and there is no way to forget it if
 * no handler is reachable without passing through this function.
 */

import type { Env } from '../env.js';
import { clearCookie, destroySession, readSession } from '../auth/tokens.js';
import {
  handleAuthOptions,
  handleAuthVerify,
  handleRegisterOptions,
  handleRegisterVerify,
  loginPage,
  registerPage,
  requireLogin,
} from './auth-pages.js';
import {
  appsPage,
  createAppAction,
  createInviteAction,
  createTokenAction,
  deleteDeviceAction,
  issuePage,
  issuesPage,
  overviewPage,
  revokeTokenAction,
  runMaintenanceAction,
  rotateAppAction,
  saveGovernorAction,
  serveAdminBlob,
  settingsPage,
  updateIssueStatus,
} from './pages.js';
import { usagePage } from './usage-page.js';
import { channelsPage, reactivateChannelAction, retireChannelAction } from './channels-page.js';

/** Reachable without a session. Everything else redirects to /login. */
const PUBLIC_PATHS = new Set([
  '/login',
  '/register',
  '/auth/options',
  '/auth/verify',
  '/devices/register/options',
  '/devices/register/verify',
]);

export function isAdminPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  if (
    path === '/' ||
    path === '/issues' ||
    path === '/usage' ||
    path === '/channels' ||
    path === '/apps' ||
    path === '/settings' ||
    path === '/logout'
  ) {
    return true;
  }
  return (
    path.startsWith('/issues/') ||
    path.startsWith('/apps/') ||
    path.startsWith('/settings/') ||
    path.startsWith('/channels/') ||
    path.startsWith('/b/')
  );
}

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // Auth endpoints are the one place an unauthenticated POST is legitimate, so they
  // get their own rate limit — a passkey ceremony is human-paced and a flood is
  // never a real user.
  if (PUBLIC_PATHS.has(path)) {
    if (method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.AUTH_LIMIT.limit({ key: `auth:${ip}` });
      if (success === false) {
        return new Response(JSON.stringify({ ok: false, error: 'too many attempts' }), {
          status: 429,
          headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60' },
        });
      }
    }

    switch (`${method} ${path}`) {
      case 'GET /login':
        return loginPage(env);
      case 'GET /register':
        return registerPage(env, url);
      case 'POST /auth/options':
        return handleAuthOptions(env, url);
      case 'POST /auth/verify':
        return handleAuthVerify(env, url, request);
      case 'POST /devices/register/options':
        return handleRegisterOptions(env, url, request);
      case 'POST /devices/register/verify':
        return handleRegisterVerify(env, url, request);
      default:
        return new Response('method not allowed', { status: 405 });
    }
  }

  const session = await readSession(env, request);
  if (!session) return requireLogin();

  if (method === 'POST') {
    switch (path) {
      case '/logout': {
        await destroySession(env, session.id);
        return new Response(null, {
          status: 303,
          headers: { location: '/login', 'set-cookie': clearCookie(url.protocol === 'https:') },
        });
      }
      case '/apps':
        return createAppAction(env, request);
      case '/settings/governor':
        return saveGovernorAction(env, request);
      case '/settings/tokens':
        return createTokenAction(env, request);
      case '/settings/tokens/revoke':
        return revokeTokenAction(env, request);
      case '/settings/devices/invite':
        return createInviteAction(env, url);
      case '/settings/devices/delete':
        return deleteDeviceAction(env, request);
      case '/settings/maintenance':
        return runMaintenanceAction(env);
      case '/channels/retire':
        return retireChannelAction(env, request);
      case '/channels/reactivate':
        return reactivateChannelAction(env, request);
    }

    const rotate = /^\/apps\/([^/]+)\/rotate$/.exec(path);
    if (rotate) return rotateAppAction(env, decodeURIComponent(rotate[1]!));

    const status = /^\/issues\/([^/]+)\/status$/.exec(path);
    if (status) return updateIssueStatus(env, decodeURIComponent(status[1]!), request);

    return new Response('not found', { status: 404 });
  }

  switch (path) {
    case '/':
      return overviewPage(env);
    case '/issues':
      return issuesPage(env, url);
    case '/usage':
      return usagePage(env, url);
    case '/channels':
      return channelsPage(env, url);
    case '/apps':
      return appsPage(env);
    case '/settings':
      return settingsPage(env);
  }

  if (path.startsWith('/issues/')) {
    return issuePage(env, decodeURIComponent(path.slice('/issues/'.length)));
  }
  if (path.startsWith('/b/')) {
    return serveAdminBlob(env, decodeURIComponent(path.slice('/b/'.length)));
  }

  return new Response('not found', { status: 404 });
}
