/**
 * Registers an app against the *local* D1 database and prints its ingest keys.
 *
 * Exists because the interesting part of this service — a report arriving at a
 * world-open endpoint and being verified, fingerprinted, coalesced and governed —
 * cannot be exercised without a real app row whose secret is sealed under the same
 * `SECRET_KEK` the dev worker is running with.
 *
 *   bun run scripts/dev-seed.ts <app-id> [channel ...]
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deriveIngestKey, generateAppSecret } from '@cinderblock/telemetry-collector-core';
import { sealSecret } from '../src/storage/secrets.js';

const [appId, ...channels] = process.argv.slice(2);
if (!appId) {
  console.error('usage: bun run scripts/dev-seed.ts <app-id> [channel ...]');
  process.exit(1);
}

const devVars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter(line => line.includes('='))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const kek = devVars.SECRET_KEK;
if (!kek) throw new Error('.dev.vars is missing SECRET_KEK — see the README');

const secret = generateAppSecret();
const sealed = await sealSecret(kek, secret);
const now = Math.floor(Date.now() / 1000);

const sql =
  `INSERT INTO apps (id, owner_id, name, secret, settings, created_at) ` +
  `VALUES ('${appId}', 'cameron', '${appId}', '${sealed}', '{}', ${now}) ` +
  `ON CONFLICT (id) DO UPDATE SET secret = excluded.secret;`;

// Handed over as a file rather than `--command`: the sealed secret is base64url and
// the statement is full of quotes, and Windows' shell mangles both on the way
// through `shell: true`.
const sqlPath = new URL('../.dev-seed.sql', import.meta.url);
writeFileSync(sqlPath, sql);

const result = spawnSync(
  process.platform === 'win32' ? 'bunx.exe' : 'bunx',
  ['wrangler', 'd1', 'execute', 'TELEMETRY_DB', '--local', '--file', fileURLToPath(sqlPath)],
  { stdio: 'inherit' },
);
rmSync(sqlPath, { force: true });
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`\napp:    ${appId}`);
console.log(`secret: ${secret}   (never ships to a client; keep it in CI)`);
console.log('\ningest keys (public — these go in the app bundle):');
for (const channel of channels.length > 0 ? channels : ['dev']) {
  console.log(`  ${channel.padEnd(12)} ${await deriveIngestKey(secret, appId, channel)}`);
}
