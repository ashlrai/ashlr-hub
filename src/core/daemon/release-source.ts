import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export type DaemonSourceCheckoutInspection =
  | { state: 'not-git' }
  | { state: 'clean'; root: string }
  | { state: 'dirty'; root: string }
  | { state: 'unverifiable'; root: string; reason: string };

function sourceDirectory(binPath: string): string {
  try {
    return path.dirname(fs.realpathSync(binPath));
  } catch {
    return path.dirname(path.resolve(binPath));
  }
}

function packageRoot(binPath: string): string {
  return path.dirname(sourceDirectory(binPath));
}

function gitFailure(result: ReturnType<typeof spawnSync>): string {
  if (result.error) return result.error.message;
  const stderr = String(result.stderr ?? '').trim();
  return stderr || `git exited ${result.status ?? 'without status'}`;
}

function runGit(root: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/**
 * Inspect the Git checkout that owns a daemon executable path, when one exists.
 * Packaged installs whose package root has no `.git` marker are outside this
 * first staging guard. Git-backed source installs must be provably clean, including staged,
 * unstaged, untracked, and dirty-submodule changes.
 */
export function inspectDaemonSourceCheckout(binPath: string): DaemonSourceCheckoutInspection {
  const checkout = packageRoot(binPath);
  try {
    const marker = fs.lstatSync(path.join(checkout, '.git'));
    if (!marker.isDirectory() && !marker.isFile()) {
      return { state: 'unverifiable', root: checkout, reason: 'unsafe .git marker' };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'not-git' };
    return {
      state: 'unverifiable',
      root: checkout,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const resolved = runGit(checkout, ['rev-parse', '--show-toplevel']);
  if (resolved.error || resolved.status !== 0) {
    return { state: 'unverifiable', root: checkout, reason: gitFailure(resolved) };
  }
  const resolvedRoot = String(resolved.stdout ?? '').trim();
  if (resolvedRoot.length === 0 || canonicalPath(resolvedRoot) !== canonicalPath(checkout)) {
    return { state: 'unverifiable', root: checkout, reason: 'Git root does not match package root' };
  }

  const result = runGit(checkout, [
    'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
  ]);

  if (result.error || result.status !== 0) {
    return { state: 'unverifiable', root: checkout, reason: gitFailure(result) };
  }
  return String(result.stdout ?? '').length === 0
    ? { state: 'clean', root: checkout }
    : { state: 'dirty', root: checkout };
}

/** Fail before an OS service unloads or replaces an existing daemon service. */
export function assertDaemonServiceSourceClean(binPath: string): void {
  const inspection = inspectDaemonSourceCheckout(binPath);
  if (inspection.state === 'dirty') {
    throw new Error(
      `Refusing to install daemon service from dirty Git checkout: ${inspection.root}. ` +
      'Stage a clean immutable release first.',
    );
  }
  if (inspection.state === 'unverifiable') {
    throw new Error(
      `Refusing to install daemon service from unverifiable Git checkout: ${inspection.root} ` +
      `(${inspection.reason}). Stage a clean immutable release first.`,
    );
  }
}
