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
