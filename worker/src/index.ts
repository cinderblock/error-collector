import { handleReadApi } from './api/read.js';
import { handleAdmin, isAdminPath } from './admin/routes.js';
import { runScheduled } from './cron.js';
import type { Env } from './env.js';
import { handleIngest, preflight } from './ingest/native.js';

function notFound(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/healthz') {
    return new Response('ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  // Ingest first: it is the only hot path, and the only one that must stay fast and
  // dependency-free even when everything else is misconfigured.
  if (path.startsWith('/i/')) {
    if (request.method === 'OPTIONS') return preflight();
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, error: 'use POST' }), {
        status: 405,
        headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST, OPTIONS' },
      });
    }
    return handleIngest(request, env, decodeURIComponent(path.slice('/i/'.length)));
  }

  if (path.startsWith('/api/')) {
    return handleReadApi(request, env, path);
  }

  if (isAdminPath(path)) {
    return handleAdmin(request, env, url);
  }

  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      // An error collector that 500s on its own bugs loses the very reports it
      // exists to keep, so the failure is logged and answered opaquely rather than
      // surfaced to a reporter that can do nothing with it.
      console.error('unhandled error', error);
      return new Response(JSON.stringify({ ok: false, error: 'internal error' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(controller, env));
  },
};
