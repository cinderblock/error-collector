/**
 * Isolate-scoped memo with a TTL.
 *
 * A Workers isolate serves many requests before it is recycled, so caching here
 * removes most repeat KV reads on the ingest hot path entirely. That matters more
 * than it looks: the free plan allows 100k KV reads/day, and the naive design reads
 * the governor state, the app record and the channel registry on every single
 * report, which would exhaust the read allowance well before the request allowance.
 *
 * Deliberately not used for anything that must be globally consistent — entries can
 * be up to `ttlSeconds` stale, and different isolates disagree. Everything cached
 * through here (config, app records, "has this channel been seen") tolerates that.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

/** Bounded so a pathological key space cannot grow the isolate's heap without limit. */
const MAX_ENTRIES = 2_000;

export async function memo<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const value = await load();

  if (store.size >= MAX_ENTRIES) {
    // Cheap eviction: drop the oldest insertion. Map preserves insertion order.
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });

  return value;
}

export function forget(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Test seam. */
export function clearMemo(): void {
  store.clear();
}
