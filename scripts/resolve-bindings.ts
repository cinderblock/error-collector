/**
 * Substitute the real Cloudflare resource ids into `worker/wrangler.toml`.
 *
 * The committed file carries `"local"` placeholders so that `wrangler dev` works with
 * no setup at all. The real ids are **deployment configuration, not source** — this
 * repo is public and self-hosted software, so where a copy runs and which database it
 * writes to are properties of that deployment. They arrive as environment variables
 * and are never committed.
 *
 * For my deployment they are supplied by Cloudflare Workers Builds, as build
 * environment variables set on the build trigger, which the ops repo owns. Anyone
 * self-hosting sets the same two variables however their pipeline prefers.
 *
 * This **fails** when a value is missing or malformed. It does not warn and carry on:
 * a Worker deployed with `database_id = "local"` binds to nothing, starts happily and
 * only fails once a request arrives — which is precisely the "green but broken" shape
 * this project exists to catch in other people's software.
 */

const TOML = new URL('../worker/wrangler.toml', import.meta.url);

/** Cloudflare resource id shapes. A KV namespace id and a D1 database id are easy to swap. */
const EXPECTED = {
  D1_DATABASE_ID: {
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    shape: 'a D1 database id (a UUID)',
  },
  KV_NAMESPACE_ID: {
    pattern: /^[0-9a-f]{32}$/,
    shape: 'a KV namespace id (32 hex digits)',
  },
} as const;

function read(name: keyof typeof EXPECTED): string {
  const value = (process.env[name] ?? '').trim();
  const { pattern, shape } = EXPECTED[name];

  if (!value) {
    throw new Error(`${name} is not set — it must be supplied as a build environment variable`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${name} does not look like ${shape}: ${JSON.stringify(value)}`);
  }
  return value;
}

const problems: string[] = [];
const values: Partial<Record<keyof typeof EXPECTED, string>> = {};

// Collect every problem rather than stopping at the first, so one build tells you
// everything that is wrong instead of one thing per attempt.
for (const name of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
  try {
    values[name] = read(name);
  } catch (error) {
    problems.push((error as Error).message);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  console.error(`\n${problems.length} problem(s). See "Deployment" in README.md.`);
  process.exit(1);
}

const original = await Bun.file(TOML).text();

let updated = original.replace(/^database_id = "local"$/m, `database_id = "${values.D1_DATABASE_ID}"`);
updated = updated.replace(/^id = "local"$/m, `id = "${values.KV_NAMESPACE_ID}"`);

// A placeholder that survived means the file moved on and this script did not — the
// substitution silently missing is exactly the failure worth being loud about.
const leftover = updated.match(/^(?:database_id|id) = "local"$/gm);
if (leftover) {
  console.error(`error: still unresolved after substitution: ${leftover.join(', ')}`);
  console.error('worker/wrangler.toml changed shape; update scripts/resolve-bindings.ts to match.');
  process.exit(1);
}

if (updated === original) {
  console.error('error: nothing was substituted — expected "local" placeholders in worker/wrangler.toml');
  process.exit(1);
}

await Bun.write(TOML, updated);

// Ids identify resources, they do not grant access to them, so echoing them is safe
// and makes a mis-set variable obvious in the build log.
console.log(`d1 database_id = ${values.D1_DATABASE_ID}`);
console.log(`kv id          = ${values.KV_NAMESPACE_ID}`);
