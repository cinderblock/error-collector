/**
 * Mints a read token against the *local* D1 database.
 *
 *   bun run scripts/dev-token.ts <name> [app-id ...]     # omit apps for "*"
 *   bun run scripts/dev-token.ts agent gate-manager --write
 */

import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateReadToken, hashReadToken } from '@cinderblock/error-collector-core';

const args = process.argv.slice(2);
const write = args.includes('--write');
const [name, ...apps] = args.filter(arg => arg !== '--write');

if (!name) {
  console.error('usage: bun run scripts/dev-token.ts <name> [app-id ...] [--write]');
  process.exit(1);
}

const token = generateReadToken();
const hash = await hashReadToken(token);
const scope = JSON.stringify({ apps: apps.length > 0 ? apps : ['*'], write });
const now = Math.floor(Date.now() / 1000);

const sqlPath = new URL('../.dev-seed.sql', import.meta.url);
writeFileSync(
  sqlPath,
  `INSERT INTO read_tokens (hash, owner_id, name, scope, created_at) ` +
    `VALUES ('${hash}', 'cameron', '${name}', '${scope}', ${now});`,
);

const result = spawnSync(
  process.platform === 'win32' ? 'bunx.exe' : 'bunx',
  ['wrangler', 'd1', 'execute', 'ERRORS_DB', '--local', '--file', fileURLToPath(sqlPath)],
  { stdio: 'inherit' },
);
rmSync(sqlPath, { force: true });
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`\nname:  ${name}`);
console.log(`scope: ${scope}`);
console.log(`token: ${token}`);
console.log('\nOnly the digest is stored — this is the only time the token is shown.');
