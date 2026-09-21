import { describe, expect, it } from 'bun:test';
import { Client, init } from './client.js';

const KEY = 'ek1.gate-manager.1.4.2.cc5g1c36bb3je8d7vmatrb59fm';
const ENDPOINT = 'https://errors.example.com';

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
