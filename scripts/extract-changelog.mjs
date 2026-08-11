#!/usr/bin/env node
/**
 * scripts/extract-changelog.mjs — print the CHANGELOG.md section for the
 * current package.json version (between its `## [X.Y.Z]` heading and the next
 * `## [` heading). Used by release.yml as the GitHub release notes.
 *
 * Exits 1 when the section is missing — forcing changelog discipline: a
 * version without a changelog entry cannot be released.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

const version = process.argv[2] ?? pkg.version;
const canonicalVersionRe = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
if (typeof version !== 'string' || version.length > 64 || !canonicalVersionRe.test(version)) {
  console.error('extract-changelog: version must be canonical X.Y.Z SemVer');
  process.exit(1);
}

// Match the already-validated version as literal text. A release heading may
// be bare or use the repository's exact em-dash metadata separator; no argv
// bytes are ever compiled as a regular expression.
const heading = `## [${version}]`;
const lines = changelog.split('\n');
const matchingHeadings = lines.flatMap((line, index) =>
  line === heading || line.startsWith(`${heading} — `) ? [index] : []
);
if (matchingHeadings.length !== 1) {
  console.error(`extract-changelog: no "## [${version}]" section in CHANGELOG.md`);
  process.exit(1);
}
const start = matchingHeadings[0] + 1;
const nextOffset = lines.slice(start).findIndex((line) => line.startsWith('## ['));
const end = nextOffset === -1 ? lines.length : start + nextOffset;
const body = lines.slice(start, end).join('\n').trim();
if (!body) {
  console.error(`extract-changelog: "## [${version}]" section is empty`);
  process.exit(1);
}
process.stdout.write(body + '\n');
