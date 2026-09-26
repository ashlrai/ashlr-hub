/**
 * core/verse/projects.ts — Verse project discovery (owner B).
 *
 * Projects come from two sources, merged and de-duplicated by path:
 *   1. ~/.ashlr/enrollment.json `{ repos: string[] }` (enrolled: true)
 *   2. `projectPath` of every existing Verse session (enrolled: false unless
 *      also enrolled) — so a session opened on an ad-hoc folder still shows
 *      up in the picker.
 *
 * Filters: only existing directories are kept, and anything under
 * ~/.codex/artifacts (codex's scratch checkouts) is dropped.
 *
 * Never throws. Reads only; never enrolls or creates anything.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { enrollmentPath } from '../sandbox/policy.js';
import type { VerseProject, VerseSession } from './types.js';

export interface VerseProjectDiscoveryOptions {
  /** Override the enrollment registry path (tests). Defaults to ~/.ashlr/enrollment.json. */
  enrollmentPath?: string;
  /** Existing sessions whose projectPath should be included. */
  sessions?: readonly Pick<VerseSession, 'projectPath'>[];
  /** Override the codex artifacts root to exclude (tests). Defaults to ~/.codex/artifacts. */
  artifactsRoot?: string;
}

const MAX_ENROLLMENT_BYTES = 1024 * 1024;

function readEnrolledRepos(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    if (raw.length > MAX_ENROLLMENT_BYTES) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const repos = (parsed as { repos?: unknown }).repos;
    if (!Array.isArray(repos)) return [];
    return repos.filter((r): r is string => typeof r === 'string' && r.length > 0);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isUnder(path: string, root: string): boolean {
  const r = resolve(root);
  const p = resolve(path);
  const rootWithSep = r.endsWith(sep) ? r : r + sep;
  return p === r || p.startsWith(rootWithSep);
}

function safeEnrollmentPath(): string {
  try {
    return enrollmentPath();
  } catch {
    return join(homedir(), '.ashlr', 'enrollment.json');
  }
}

/**
 * Discover Verse projects: enrolled repos first (in registry order), then
 * session project paths not already listed. Only existing directories.
 */
export function discoverProjects(opts: VerseProjectDiscoveryOptions = {}): VerseProject[] {
  const registry = opts.enrollmentPath ?? safeEnrollmentPath();
  const artifactsRoot = opts.artifactsRoot ?? join(homedir(), '.codex', 'artifacts');

  const out: VerseProject[] = [];
  const seen = new Set<string>();

  const add = (rawPath: string, enrolled: boolean): void => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return;
    const path = resolve(rawPath);
    if (seen.has(path)) {
      if (enrolled) {
        const existing = out.find((p) => p.path === path);
        if (existing) existing.enrolled = true;
      }
      return;
    }
    if (isUnder(path, artifactsRoot)) return;
    if (!isDirectory(path)) return;
    seen.add(path);
    out.push({ path, name: basename(path) || path, enrolled });
  };

  for (const repo of readEnrolledRepos(registry)) add(repo, true);
  for (const session of opts.sessions ?? []) add(session.projectPath, false);

  return out;
}

/** Test seam for {@link discoverProjectsAsync}: resolves whether `path` is a directory. Never rejects. */
export type AsyncDirectoryCheck = (path: string) => Promise<boolean>;

async function isDirectoryAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readEnrolledReposAsync(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > MAX_ENROLLMENT_BYTES) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const repos = (parsed as { repos?: unknown }).repos;
    if (!Array.isArray(repos)) return [];
    return repos.filter((r): r is string => typeof r === 'string' && r.length > 0);
  } catch {
    return [];
  }
}

/**
 * `discoverProjects`, with every filesystem touch off the event loop — for
 * the HTTP routes the page calls as it loads (GET /api/verse/bootstrap).
 *
 * WHY. Project paths are the operator's folders, usually under ~/Desktop or
 * ~/Documents, which macOS guards with a privacy (TCC) consent prompt. While
 * that prompt is up — every time the app's ad-hoc code identity changes, e.g.
 * right after `ship:local` swaps the binary — a SYNCHRONOUS stat into the
 * folder parks the calling thread until the operator answers it. On the main
 * thread that froze the whole sidecar, static `/verse/` included, for as long
 * as the dialog went unanswered (3.13.0 ship, 2026-09-26: ~3 minutes). Here
 * the wait lands on a libuv pool thread instead, so only this request waits.
 *
 * Same answer, same order, same filters as the synchronous version; the
 * directory checks run concurrently. Never throws.
 */
export async function discoverProjectsAsync(
  opts: VerseProjectDiscoveryOptions & { isDirectory?: AsyncDirectoryCheck } = {},
): Promise<VerseProject[]> {
  const registry = opts.enrollmentPath ?? safeEnrollmentPath();
  const artifactsRoot = opts.artifactsRoot ?? join(homedir(), '.codex', 'artifacts');
  const checkDirectory = opts.isDirectory ?? isDirectoryAsync;

  // Candidates in the exact order the synchronous version visits them.
  const candidates: Array<{ path: string; enrolled: boolean }> = [];
  for (const repo of await readEnrolledReposAsync(registry)) candidates.push({ path: repo, enrolled: true });
  for (const session of opts.sessions ?? []) candidates.push({ path: session.projectPath, enrolled: false });

  const unique = new Map<string, Promise<boolean>>();
  const resolved = candidates.map(({ path: rawPath, enrolled }) => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
    const path = resolve(rawPath);
    if (isUnder(path, artifactsRoot)) return null;
    if (!unique.has(path)) unique.set(path, checkDirectory(path).catch(() => false));
    return { path, enrolled };
  });
  const isDir = new Map<string, boolean>();
  await Promise.all([...unique].map(async ([path, check]) => { isDir.set(path, await check); }));

  const out: VerseProject[] = [];
  const byPath = new Map<string, VerseProject>();
  for (const candidate of resolved) {
    if (!candidate || !isDir.get(candidate.path)) continue;
    const existing = byPath.get(candidate.path);
    if (existing) {
      if (candidate.enrolled) existing.enrolled = true;
      continue;
    }
    const project: VerseProject = { path: candidate.path, name: basename(candidate.path) || candidate.path, enrolled: candidate.enrolled };
    byPath.set(candidate.path, project);
    out.push(project);
  }
  return out;
}
