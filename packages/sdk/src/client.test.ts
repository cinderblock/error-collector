import { afterEach, describe, expect, it } from 'bun:test';
import { MAX_EVENTS_PER_REQUEST } from '@cinderblock/telemetry-collector-core';
import { Client, init } from './client.js';

const KEY = 'ek1.gate-manager.1.4.2.cc5g1c36bb3je8d7vmatrb59fm';
const ENDPOINT = 'https://errors.example.com';
const SECRET = 'ecs_0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk';

describe('endpoint', () => {
  it('has no built-in default', () => {
    // This is self-hosted software with no canonical server. A default would mean an
    // app that forgot to configure one silently shipped its users' crashes to
    // whoever owns that hostname — so this must fail loudly at init.
    expect(() => init({ ingestKey: KEY } as never)).toThrow('`endpoint` is required');
    expect(() => init({ endpoint: '   ', ingestKey: KEY })).toThrow('`endpoint` is required');
  });

  it('requires an ingest key too', () => {
    expect(() => init({ endpoint: ENDPOINT, ingestKey: '' })).toThrow('`ingestKey` is required');
  });

  it('builds the ingest URL from the configured endpoint', () => {
    expect(new Client({ endpoint: ENDPOINT, ingestKey: KEY }).url).toBe(`${ENDPOINT}/i/${KEY}`);
  });

  it('tolerates a trailing slash rather than producing a double slash', () => {
    expect(new Client({ endpoint: `${ENDPOINT}///`, ingestKey: KEY }).url).toBe(`${ENDPOINT}/i/${KEY}`);
  });

  it('carries no hostname of its own anywhere in the module', async () => {
    // A guard against this regressing: the source must not contain an absolute URL
    // that isn't a documentation placeholder.
    const source = await Bun.file(new URL('./client.ts', import.meta.url)).text();
    const urls = source.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [];
    expect(urls.filter(url => !url.includes('example.com'))).toEqual([]);
  });
});

describe('breadcrumbs', () => {
  it('keeps only the most recent, so a long session cannot grow without bound', () => {
    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY, maxBreadcrumbs: 3 });
    for (let i = 0; i < 10; i++) client.addBreadcrumb({ message: `step ${i}` });

    // Reading through a send would need a network call; assert via the payload the
    // client would build, which is what actually ships.
    const crumbs = (client as unknown as { breadcrumbs: { message: string }[] }).breadcrumbs;
    expect(crumbs).toHaveLength(3);
    expect(crumbs.at(-1)?.message).toBe('step 9');
  });

  it('stamps a timestamp when the caller omits one', () => {
    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY });
    client.addBreadcrumb({ message: 'clicked' });
    const crumbs = (client as unknown as { breadcrumbs: { timestamp?: number }[] }).breadcrumbs;
    expect(crumbs[0]?.timestamp).toBeGreaterThan(1_700_000_000);
  });
});

describe('usage tracking', () => {
  const original = globalThis.fetch;

  function stubFetch() {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response('{"ok":true}', { status: 202 });
    }) as typeof fetch;
    return calls;
  }

  afterEach(() => {
    globalThis.fetch = original;
  });

  it('batches several events into one request', async () => {
    const calls = stubFetch();
    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY, release: '2.0.0' });

    client.track('gate.opened');
    client.track('gate.closed', { value: 3 });
    client.track('page.view', { dims: { path: '/home' } });
    expect(calls).toHaveLength(0); // still queued

    await client.flushUsage();

    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as { events: unknown[]; release: string };
    expect(body.events).toHaveLength(3);
    expect(body.release).toBe('2.0.0');
  });

  it('posts to the usage endpoint, not the error one', async () => {
    const calls = stubFetch();
    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY });
    client.track('x');
    await client.flushUsage();
    expect(calls[0]!.url).toBe(`${ENDPOINT}/u/${KEY}`);
  });

  it('sends immediately when batching is disabled', async () => {
    const calls = stubFetch();
    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY, usageFlushMs: 0 });
    client.track('x');
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('flushes early rather than dropping when a burst fills the batch', async () => {
    const calls = stubFetch();
    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY });
    for (let i = 0; i < MAX_EVENTS_PER_REQUEST + 5; i++) client.track('burst');
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0]!.body as { events: unknown[] }).events.length).toBeLessThanOrEqual(MAX_EVENTS_PER_REQUEST);
  });

  it('does nothing when the queue is empty', async () => {
    const calls = stubFetch();
    await new Client({ endpoint: ENDPOINT, ingestKey: KEY }).flushUsage();
    expect(calls).toHaveLength(0);
  });

  it('signs the batch when an app secret is available', async () => {
    const calls = stubFetch();
    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY, appSecret: SECRET });
    client.track('x');
    await client.flushUsage();
    expect(calls[0]!.headers['x-report-signature']).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('never throws into the host app, even if the transport explodes', async () => {
    globalThis.fetch = (() => {
      throw new Error('network is down');
    }) as unknown as typeof fetch;

    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY });
    expect(() => client.track('x')).not.toThrow();
    await expect(client.flushUsage()).resolves.toBeUndefined();
  });

  it('drops a failed batch rather than requeuing it', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network is down');
    }) as unknown as typeof fetch;

    const client = new Client({ endpoint: ENDPOINT, ingestKey: KEY });
    client.track('x');
    await client.flushUsage();

    // Requeuing would grow without bound against a failing endpoint, to recover
    // data whose entire value is being approximately right in aggregate.
    const calls = stubFetch();
    await client.flushUsage();
    expect(calls).toHaveLength(0);
  });
});
