#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILD_IDENTITY_SCHEMA_VERSION = 1;

const REVISION_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function unavailable(packageVersion = null) {
  return {
    schemaVersion: BUILD_IDENTITY_SCHEMA_VERSION,
    packageVersion,
    revision: null,
    dirty: null,
    provenance: 'unavailable',
  };
}

function readPackageVersion(repoRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.length > 0
      ? pkg.version
      : null;
  } catch {
    return null;
  }
}

function git(repoRoot, args) {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Build an identity using Git only when repository metadata is present. */
export function createBuildIdentity({ repoRoot, env = process.env }) {
  const packageVersion = readPackageVersion(repoRoot);
  if (!packageVersion) return unavailable();

  if (!existsSync(join(repoRoot, '.git'))) {
    const ciRevision = env.GITHUB_SHA?.trim() ?? '';
    if (!REVISION_RE.test(ciRevision)) return unavailable(packageVersion);
    return {
      schemaVersion: BUILD_IDENTITY_SCHEMA_VERSION,
      packageVersion,
      revision: ciRevision.toLowerCase(),
      dirty: null,
      provenance: 'github-actions',
    };
  }

  const revisionResult = git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  const revision = revisionResult.status === 0 ? revisionResult.stdout.trim() : '';
  if (!REVISION_RE.test(revision)) return unavailable(packageVersion);

  const statusResult = git(repoRoot, ['status', '--porcelain', '--untracked-files=normal']);
  if (statusResult.status !== 0) return unavailable(packageVersion);

  return {
    schemaVersion: BUILD_IDENTITY_SCHEMA_VERSION,
    packageVersion,
    revision: revision.toLowerCase(),
    dirty: statusResult.stdout.length > 0,
    provenance: 'git',
  };
}

export function writeBuildIdentity({ repoRoot, outputPath = join(repoRoot, 'dist', 'build-identity.json'), env = process.env }) {
  const identity = createBuildIdentity({ repoRoot, env });
  writeFileSync(outputPath, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
  return identity;
}

/** Return a JavaScript string literal without raw line/HTML separator characters. */
export function javascriptStringLiteral(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';

if (import.meta.url === invokedPath) {
  const outputPath = join(repoRoot, 'dist', 'build-identity.json');
  const identity = writeBuildIdentity({ repoRoot, outputPath });
  console.log(`[build-identity] wrote ${outputPath} (${identity.provenance})`);
}
