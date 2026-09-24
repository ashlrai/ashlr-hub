/**
 * Enrolled path → GitHub `owner/name` — V3.10 Track B unit U5.
 *
 * The daemon keys work by `WorkItem.repo` (the absolute path of an enrolled
 * checkout — under autonomy, the fleet's own mirror); grants, holds, PRs and
 * merges are keyed by the GitHub repo (fleet-types.ts header). This is the
 * one bridge between the two, so a hold on `ashlrai/binshield` really pauses
 * `~/.ashlr/fleet/mirrors/ashlrai__binshield`.
 *
 * Two sources, strongest first:
 *   1. the mirror layout SPEC-310B §2 fixes (`<owner>__<repo>` under
 *      `~/.ashlr/fleet/mirrors/`) — no file read at all;
 *   2. the checkout's `origin` remote in `.git/config` (a worktree's `.git`
 *      FILE is followed through `gitdir` / `commondir`). A file read, never a
 *      `git` subprocess: this runs every tick for every enrolled repo.
 * Anything else (no origin, a non-GitHub remote) is null — unknown, and the
 * caller fails closed (the repo is not dispatched under a standing policy).
 *
 * READ-ONLY. Cached per path + config mtime. Never throws.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { STANDING_GRANT_PATTERNS } from '../authority/types.js';

const MAX_CONFIG_BYTES = 256 * 1024;

export function fleetMirrorsDir(): string {
  return join(homedir(), '.ashlr', 'fleet', 'mirrors');
}

/** `owner/name` from a GitHub remote URL (https, ssh, git@), or null. */
export function nameWithOwnerFromRemote(url: string): string | null {
  const match = /github\.com[:/]+([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match) return null;
  const nwo = `${match[1]}/${match[2]}`;
  return STANDING_GRANT_PATTERNS.nameWithOwner.test(nwo) ? nwo : null;
}

/** The `[remote "origin"] url` of a git config file's text, or null. */
export function originUrlFromConfig(text: string): string | null {
  let inOrigin = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^url\s*=\s*(.+)$/.exec(line);
    if (kv) return kv[1]!.trim();
  }
  return null;
}

function readSmall(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The git config file governing a checkout (following a worktree's `.git` file). */
export function gitConfigPathOf(repoPath: string): string | null {
  const dotGit = join(repoPath, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return join(dotGit, 'config');
  if (!stat.isFile()) return null;
  const pointer = readSmall(dotGit);
  const gitdirMatch = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer) : null;
  if (!gitdirMatch) return null;
  const gitdir = isAbsolute(gitdirMatch[1]!.trim()) ? gitdirMatch[1]!.trim() : resolve(repoPath, gitdirMatch[1]!.trim());
  const common = readSmall(join(gitdir, 'commondir'));
  const base = common ? resolve(gitdir, common.trim()) : gitdir;
  return join(base, 'config');
}

const cache = new Map<string, { mtimeMs: number; value: string | null }>();

/** Test hook. */
export function resetRepoIdentityCache(): void {
  cache.clear();
}

/** GitHub `owner/name` for an enrolled checkout path, or null when it cannot be proven. */
export function repoIdentityOfPath(repoPath: string): string | null {
  try {
    const mirrors = fleetMirrorsDir();
    if (resolve(dirname(repoPath)) === resolve(mirrors)) {
      const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})__([A-Za-z0-9._-]{1,100})$/.exec(basename(repoPath));
      if (match) {
        const nwo = `${match[1]}/${match[2]}`;
        if (STANDING_GRANT_PATTERNS.nameWithOwner.test(nwo)) return nwo;
      }
    }
    const configPath = gitConfigPathOf(repoPath);
    if (!configPath) return null;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(configPath).mtimeMs;
    } catch {
      return null;
    }
    const cached = cache.get(repoPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.value;
    const text = readSmall(configPath);
    const url = text ? originUrlFromConfig(text) : null;
    const value = url ? nameWithOwnerFromRemote(url) : null;
    cache.set(repoPath, { mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

/**
 * Resolve a loose repo label — `owner/name`, an absolute path, or a bare
 * directory name — against the enrolled checkouts. Used for labels that come
 * from other subsystems (reasoning insights, agent actions).
 */
export function resolveRepoLabel(label: string, enrolledPaths: readonly string[]): string | null {
  const text = label.trim();
  if (STANDING_GRANT_PATTERNS.nameWithOwner.test(text)) return text;
  if (isAbsolute(text)) {
    const exact = enrolledPaths.find((p) => resolve(p) === resolve(text));
    return repoIdentityOfPath(exact ?? text);
  }
  const byName = enrolledPaths.filter((p) => basename(p).toLowerCase() === text.toLowerCase());
  if (byName.length === 1) return repoIdentityOfPath(byName[0]!);
  // A mirror's directory name is `<owner>__<repo>`; a bare label may name the repo half.
  const byMirrorRepo = enrolledPaths.filter((p) => basename(p).toLowerCase().endsWith(`__${text.toLowerCase()}`));
  if (byMirrorRepo.length === 1) return repoIdentityOfPath(byMirrorRepo[0]!);
  return null;
}
