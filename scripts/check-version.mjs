#!/usr/bin/env node
/**
 * scripts/check-version.mjs — release-gate: the pushed tag must equal the
 * package.json version (tag `v<X.Y.Z>` ⇔ version `<X.Y.Z>`).
 *
 * Used by .github/workflows/release.yml before `npm publish`. Exits 1 with a
 * clear message on mismatch so a mistagged release can never publish.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Explicit argv wins over the ambient env: GITHUB_REF_NAME is set on EVERY
// Actions run (it's the branch name on push builds), so an explicitly passed
// tag (tests, local dry-runs) must take precedence. release.yml passes no
// argv, so the tag-triggered publish path still reads GITHUB_REF_NAME.
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
if (!tag) {
  console.error('check-version: no tag (set GITHUB_REF_NAME or pass as arg)');
  process.exit(1);
}
const tagVersion = tag.replace(/^v/, '');
if (tagVersion !== pkg.version) {
  console.error(
    `check-version: tag "${tag}" (→ ${tagVersion}) does not match package.json version ${pkg.version}`,
  );
  process.exit(1);
}
console.log(`check-version: ok — ${tag} matches package.json ${pkg.version}`);
