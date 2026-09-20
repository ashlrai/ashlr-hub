#!/usr/bin/env node
/* global process, URL */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const mode = process.argv[2];
const recoveryRootArg = process.argv[3];
if (!['clean', 'dirty'].includes(mode)) {
  throw new Error('usage: reclaim_hub_worktrees.mjs <clean|dirty> [recovery-root]');
}

const root = realpathSync(process.cwd());
if (basename(root) !== 'ashlr-hub') {
  throw new Error(`refusing to run outside the canonical ashlr-hub checkout: ${root}`);
}

const allowedPrefix = `${dirname(root)}/ashlr-hub-`;
const planDir = dirname(new URL(import.meta.url).pathname);
const recoveryRoot = recoveryRootArg
  ? resolve(recoveryRootArg)
  : join(planDir, 'worktree-recovery');
const manifestPath = join(planDir, `cleanup-${mode}-manifest.json`);
const commonGitDir = realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
const startedAt = new Date().toISOString();
const runId = startedAt.replaceAll(/[^0-9A-Za-z]/g, '').slice(0, 15);

if (mode === 'dirty') mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });

const entries = parseWorktrees(git(['worktree', 'list', '--porcelain']));
const manifest = {
  schemaVersion: 1,
  mode,
  startedAt,
  root,
  allowedPrefix,
  commonGitDir,
  recoveryRoot: mode === 'dirty' ? recoveryRoot : null,
  results: [],
};

for (const entry of entries) {
  const path = entry.path;
  const result = {
    path,
    head: entry.head,
    branch: entry.branch,
    state: 'skipped',
    reason: null,
    sizeKiB: null,
    archiveRef: null,
    recoveryFiles: [],
  };
  manifest.results.push(result);

  try {
    if (path === root) {
      result.reason = 'canonical checkout';
      persistManifest();
      continue;
    }
    if (!path.startsWith(allowedPrefix)) {
      result.reason = 'outside exact Desktop ashlr-hub-* boundary';
      persistManifest();
      continue;
    }
    if (!existsSync(path)) {
      result.reason = 'missing path';
      persistManifest();
      continue;
    }
    const candidateCommonDir = realpathSync(
      git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path).trim(),
    );
    if (candidateCommonDir !== commonGitDir) {
      result.reason = `foreign git common dir: ${candidateCommonDir}`;
      persistManifest();
      continue;
    }

    const status = git(
      ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
      path,
    );
    const isDirty = status.length > 0;
    if (mode === 'clean' && isDirty) {
      result.reason = 'dirty; reserved for recovery archive pass';
      persistManifest();
      continue;
    }
    if (mode === 'dirty' && !isDirty) {
      result.reason = 'clean; not part of dirty archive pass';
      persistManifest();
      continue;
    }

    result.sizeKiB = Number(gitExternal('du', ['-sk', path]).trim().split(/\s+/)[0] ?? 0);

    if (mode === 'dirty' || !entry.branch) {
      const slug = safeSlug(basename(path));
      const shortHead = entry.head.slice(0, 12);
      const archiveRef = `refs/archive/worktrees/${runId}/${slug}-${shortHead}`;
      git(['update-ref', archiveRef, entry.head]);
      result.archiveRef = archiveRef;
    }

    if (mode === 'dirty') {
      archiveDirtyTree({ entry, path, status, result });
    }

    const removeArgs = ['worktree', 'remove'];
    if (mode === 'dirty') removeArgs.push('--force');
    removeArgs.push(path);
    git(removeArgs);
    result.state = 'removed';
    result.reason = null;
  } catch (error) {
    result.state = 'failed';
    result.reason = error instanceof Error ? error.message : String(error);
  }
  persistManifest();
}

manifest.completedAt = new Date().toISOString();
persistManifest();

const removed = manifest.results.filter((item) => item.state === 'removed');
const failed = manifest.results.filter((item) => item.state === 'failed');
const reclaimedKiB = removed.reduce((sum, item) => sum + (item.sizeKiB ?? 0), 0);
process.stdout.write(
  JSON.stringify(
    {
      mode,
      removed: removed.length,
      failed: failed.length,
      reclaimedGiB: Number((reclaimedKiB / 1_048_576).toFixed(2)),
      manifestPath,
      recoveryRoot: mode === 'dirty' ? recoveryRoot : null,
    },
    null,
    2,
  ) + '\n',
);
if (failed.length > 0) process.exitCode = 2;

function archiveDirtyTree({ entry, path, status, result }) {
  const slug = `${safeSlug(basename(path))}-${entry.head.slice(0, 12)}`;
  const destination = join(recoveryRoot, slug);
  mkdirSync(destination, { recursive: true, mode: 0o700 });

  const metadataPath = join(destination, 'metadata.json');
  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        originalPath: path,
        head: entry.head,
        branch: entry.branch,
        archiveRef: result.archiveRef,
        status,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  result.recoveryFiles.push(fileReceipt(metadataPath));

  const diff = execBuffer('git', ['-C', path, 'diff', '--binary', 'HEAD']);
  if (diff.length > 0) {
    const patchPath = join(destination, 'tracked.patch');
    writeFileSync(patchPath, diff, { mode: 0o600 });
    result.recoveryFiles.push(fileReceipt(patchPath));
  }

  const untracked = execBuffer(
    'git',
    ['-C', path, 'ls-files', '--others', '--exclude-standard', '-z'],
  );
  if (untracked.length > 0) {
    const archivePath = join(destination, 'untracked.tar.gz');
    const tar = spawnSync(
      'tar',
      ['-C', path, '--null', '-T', '-', '-czf', archivePath],
      { input: untracked, maxBuffer: 1024 * 1024 * 1024 },
    );
    if (tar.status !== 0) {
      throw new Error(`untracked archive failed for ${path}: ${tar.stderr?.toString() ?? ''}`);
    }
    result.recoveryFiles.push(fileReceipt(archivePath));
  }
}

function parseWorktrees(text) {
  const parsed = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) parsed.push(current);
      current = { path: line.slice(9), head: '', branch: null };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) parsed.push(current);
  return parsed;
}

function git(args, cwd = root) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function gitExternal(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
}

function execBuffer(command, args) {
  return execFileSync(command, args, { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
}

function safeSlug(value) {
  return value.replaceAll(/[^0-9A-Za-z._-]/g, '-').slice(0, 160);
}

function fileReceipt(path) {
  const bytes = readFileSync(path);
  return {
    path,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function persistManifest() {
  const temporary = `${manifestPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, manifestPath);
}
