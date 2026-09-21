/**
 * Refuses to publish from anywhere but CI.
 *
 * Releases go through GitHub Actions so they carry provenance attestation, are built
 * from a clean checkout, and are auditable against a specific commit. A local publish
 * has none of that and can silently ship a dirty working tree or a stale `dist/`.
 *
 * The single exception is claiming a brand-new package name: npm has no way to
 * reserve a name, and trusted publishing (OIDC) can only be configured on a package
 * that already exists. So a `0.0.0` placeholder may be published locally. That is
 * self-limiting — a registry will never accept the same version twice, so this path
 * can be used exactly once per package, and never for anything anyone would install.
 *
 * Wired in as `prepublishOnly` in every publishable package.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifestPath = resolve(process.cwd(), 'package.json');
const { name, version } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string };

if (process.env.CI) {
  console.log(`guard-publish: CI detected — allowing publish of ${name}@${version}`);
  process.exit(0);
}

if (version === '0.0.0') {
  console.log(
    `guard-publish: allowing the one-time local name claim for ${name}@0.0.0.\n` +
      'Configure trusted publishing on the package immediately afterwards, so the\n' +
      'first real release ships from CI with provenance.',
  );
  process.exit(0);
}

console.error(
  `guard-publish: refusing to publish ${name}@${version} outside CI.\n\n` +
    'Releases ship from GitHub Actions only — that is what provides provenance\n' +
    'attestation and a reproducible build from a clean checkout.\n\n' +
    'To release: push a version tag, or dispatch the release workflow.',
);
process.exit(1);
