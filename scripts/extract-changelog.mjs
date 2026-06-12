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
const headingRe = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*$`, 'm');
const match = headingRe.exec(changelog);
if (!match) {
  console.error(`extract-changelog: no "## [${version}]" section in CHANGELOG.md`);
  process.exit(1);
}
const start = match.index + match[0].length;
const next = changelog.slice(start).search(/^## \[/m);
const body = (next === -1 ? changelog.slice(start) : changelog.slice(start, start + next)).trim();
if (!body) {
  console.error(`extract-changelog: "## [${version}]" section is empty`);
  process.exit(1);
}
process.stdout.write(body + '\n');
