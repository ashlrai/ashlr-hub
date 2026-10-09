#!/usr/bin/env node
/** Synchronize local candidate metadata; never publish or rewrite release history. */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const canonicalVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const files = [
  'package.json', 'package-lock.json', 'desktop/package.json',
  'desktop/src-tauri/tauri.conf.json', 'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
  'desktop/README.md',
  'README.md', 'docs/QUICKSTART.md',
];

function replaceOne(text, pattern, replace, label) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one metadata field`);
  return text.replace(pattern, replace);
}

// Fixed metadata fields only. Preserve whitespace, escaping and every dependency line.
function jsonVersion(text, version, indent, label) {
  return replaceOne(text, new RegExp(`^(${indent}"version"\\s*:\\s*")[^"\\r\\n]+("[^\\r\\n]*)$`, 'gm'),
    (_line, before, after) => `${before}${version}${after}`, label);
}

function ownCargoVersion(text, version, lock) {
  const marker = lock ? /^\[\[package\]\]\r?$/gm : /^\[package\]\r?$/gm;
  const sections = [...text.matchAll(marker)].map((match) => {
    const start = match.index;
    const tail = text.slice(start + match[0].length);
    const next = tail.search(/^\[/m);
    const end = next < 0 ? text.length : start + match[0].length + next;
    return { start, end, body: text.slice(start, end) };
  }).filter(({ body }) => /^name\s*=\s*"ashlr-desktop"\s*$/m.test(body));
  if (sections.length !== 1) throw new Error(`Cargo ${lock ? 'lock' : 'package'}: expected one ashlr-desktop entry`);
  const { start, end, body } = sections[0];
  const updated = replaceOne(body, /^(version\s*=\s*")[^"\r\n]+("[^\r\n]*)$/gm,
    (_line, before, after) => `${before}${version}${after}`, 'Cargo own version');
  return text.slice(0, start) + updated + text.slice(end);
}

export function syncCandidateVersion(root, version, { check = false } = {}) {
  // Only read-only checks may derive the expected value; writing always requires an explicit version.
  if (check && version === undefined) version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || version.length > 64 || !canonicalVersion.test(version)) {
    throw new Error('Expected a canonical release version X.Y.Z (no tag prefix, leading zeroes or prerelease)');
  }
  const sources = new Map(files.map((file) => [file, readFileSync(resolve(root, file), 'utf8')]));
  const pkg = JSON.parse(sources.get('package.json'));
  const lock = JSON.parse(sources.get('package-lock.json'));
  const desktop = JSON.parse(sources.get('desktop/package.json'));
  const tauri = JSON.parse(sources.get('desktop/src-tauri/tauri.conf.json'));
  if (pkg.name !== '@ashlr/phantom' || lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name || desktop.name !== 'ashlr-desktop') {
    throw new Error('Candidate package identities do not match Phantom');
  }
  const main = tauri.app?.windows?.filter((window) => window.label === 'main');
  if (main?.length !== 1 || typeof main[0].url !== 'string') throw new Error('Expected exactly one main desktop URL');
  const url = new URL(main[0].url);
  if (url.origin !== 'http://127.0.0.1:7777' || url.pathname !== '/verse/' || url.searchParams.getAll('v').length !== 1) {
    throw new Error('Expected the existing local Verse URL with one version query');
  }
  url.searchParams.set('v', version);
  const replacements = new Map();
  replacements.set('package.json', jsonVersion(sources.get('package.json'), version, '  ', 'root package'));
  let updatedLock = jsonVersion(sources.get('package-lock.json'), version, '  ', 'root lock');
  updatedLock = replaceOne(updatedLock, /^ {4}"": \{\r?\n[\s\S]*?^ {4}\}[,]?\r?$/gm,
    (section) => jsonVersion(section, version, '      ', 'root lock package'), 'root lock entry');
  replacements.set('package-lock.json', updatedLock);
  replacements.set('desktop/package.json', jsonVersion(sources.get('desktop/package.json'), version, '  ', 'desktop package'));
  let updatedTauri = jsonVersion(sources.get('desktop/src-tauri/tauri.conf.json'), version, '  ', 'Tauri package');
  // Qualify the parsed main window before changing its one existing URL literal.
  const oldLiteral = JSON.stringify(main[0].url);
  const before = updatedTauri.split(oldLiteral);
  if (before.length !== 2) throw new Error('Main desktop URL literal is ambiguous');
  updatedTauri = before.join(JSON.stringify(url.href));
  replacements.set('desktop/src-tauri/tauri.conf.json', updatedTauri);
  replacements.set('desktop/src-tauri/Cargo.toml', ownCargoVersion(sources.get('desktop/src-tauri/Cargo.toml'), version, false));
  replacements.set('desktop/src-tauri/Cargo.lock', ownCargoVersion(sources.get('desktop/src-tauri/Cargo.lock'), version, true));
  // Source identity stays true before and after publication; historical releases stay intact.
  for (const file of ['desktop/README.md', 'README.md', 'docs/QUICKSTART.md']) {
    replacements.set(file, replaceOne(sources.get(file),
      /^(This source tree targets version )\d+\.\d+\.\d+(; check canonical release availability and exact matching assets before installation\.)$/gm,
      (_line, before, after) => `${before}${version}${after}`, `${file} candidate documentation`));
  }
  const changed = files.filter((file) => sources.get(file) !== replacements.get(file));
  // Validate the entire plan before touching any file. --check is strictly read-only.
  if (!check) for (const file of changed) writeFileSync(resolve(root, file), replacements.get(file));
  return { version, changed, matches: changed.length === 0, check };
}

const script = fileURLToPath(import.meta.url);
let invokedDirectly = false;
try { invokedDirectly = Boolean(process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(script)); }
catch { /* Library import from a virtual entrypoint is not a CLI invocation. */ }
if (invokedDirectly) {
  try {
    const args = process.argv.slice(2);
    const check = args[0] === '--check';
    if (check ? args.length < 1 || args.length > 2 : args.length !== 1) throw new Error('Usage: node scripts/sync-candidate-version.mjs X.Y.Z | --check [X.Y.Z]');
    const result = syncCandidateVersion(resolve(dirname(script), '..'), check ? args[1] : args[0], { check });
    console.log(JSON.stringify(result));
    if (check && !result.matches) process.exitCode = 1;
  } catch (error) {
    console.error(`sync-candidate-version: ${error.message}`);
    process.exitCode = 1;
  }
}
