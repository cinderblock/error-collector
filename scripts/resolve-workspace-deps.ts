/**
 * Rewrites `workspace:*` dependency ranges to concrete versions before publishing.
 *
 * `workspace:` is a Bun/pnpm/Yarn protocol. Bun's own publish resolves it, but npm
 * does not — and provenance attestation is an npm feature, so these packages are
 * published with `npm publish`. Without this step the SDK would ship declaring a
 * dependency on the literal string `workspace:*`, which fails to install for
 * everyone.
 *
 *   bun run scripts/resolve-workspace-deps.ts           # rewrite in place
 *   bun run scripts/resolve-workspace-deps.ts --check   # fail if any remain
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PACKAGES = ['packages/core', 'packages/sdk', 'packages/cli'];
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

const check = process.argv.includes('--check');
const root = resolve(import.meta.dirname, '..');

type Manifest = Record<string, unknown> & {
  name: string;
  version: string;
} & Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;

const manifests = new Map<string, { path: string; manifest: Manifest }>();
for (const directory of PACKAGES) {
  const path = resolve(root, directory, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  manifests.set(manifest.name, { path, manifest });
}

let changed = 0;
const unresolved: string[] = [];

for (const { path, manifest } of manifests.values()) {
  let dirty = false;

  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!deps) continue;

    for (const [name, range] of Object.entries(deps)) {
      if (!range.startsWith('workspace:')) continue;

      const target = manifests.get(name);
      if (!target) {
        unresolved.push(`${manifest.name} → ${name} (not a workspace package)`);
        continue;
      }

      if (check) {
        unresolved.push(`${manifest.name} → ${name}@${range}`);
        continue;
      }

      // `workspace:*` means "exactly the version in this repo"; every package here
      // is released together from one tag, so a caret range on that version is the
      // honest translation.
      deps[name] = `^${target.manifest.version}`;
      dirty = true;
      changed++;
    }
  }

  if (dirty) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (check && unresolved.length > 0) {
  console.error('unresolved workspace ranges:\n  ' + unresolved.join('\n  '));
  process.exit(1);
}
if (!check && unresolved.length > 0) {
  console.error('could not resolve:\n  ' + unresolved.join('\n  '));
  process.exit(1);
}

console.log(check ? 'no workspace ranges remain' : `rewrote ${changed} workspace range(s)`);
