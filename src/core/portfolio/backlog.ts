/**
 * backlog.ts — Aggregated work-discovery backlog for enrolled repos.
 *
 * GUARDRAILS:
 *  - READ-ONLY: this module never writes to any scanned repo.
 *  - ENROLLMENT-SCOPED: only listEnrolled() repos are scanned (DEFAULT EMPTY).
 *  - Never throws: all errors are caught and produce empty/null results.
 *  - No secrets in persisted data (enforced by scanners + audit).
 *  - Persists atomically to ~/.ashlr/backlog.json.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Backlog, WorkItem } from '../types.js';
import { listEnrolled } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Absolute path of the persisted backlog file: ~/.ashlr/backlog.json.
 * Re-resolved at call time so tests can relocate HOME.
 */
export function backlogPath(): string {
  return join(homedir(), '.ashlr', 'backlog.json');
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Priority score; higher = do first.
 * Heuristic: value / effort (effort clamped >= 1; both clamped to 1..5).
 * Deterministic, pure.
 */
export function scoreItem(value: number, effort: number): number {
  const v = Math.max(1, Math.min(5, value));
  const e = Math.max(1, Math.min(5, effort));
  return v / e;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load the persisted backlog from ~/.ashlr/backlog.json.
 * Returns null if the file is absent or unreadable/malformed.
 * Never throws.
 */
export function loadBacklog(): Backlog | null {
  try {
    const p = backlogPath();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)['generatedAt'] === 'string' &&
      Array.isArray((parsed as Record<string, unknown>)['repos']) &&
      Array.isArray((parsed as Record<string, unknown>)['items'])
    ) {
      return parsed as Backlog;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the backlog atomically (write + sync approach for node builtins). */
function persistBacklog(backlog: Backlog): void {
  const p = backlogPath();
  const dir = join(homedir(), '.ashlr');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Atomic write: write to a temp file then rename. Node's fs.renameSync is
  // atomic on POSIX within the same filesystem.
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(backlog, null, 2) + '\n', 'utf8');
  // Atomic rename: node:fs renameSync is atomic on POSIX within one filesystem.
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

function dedupeItems(items: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  const out: WorkItem[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildBacklog
// ---------------------------------------------------------------------------

// Deferred import of SCANNERS to avoid a circular-dependency risk and to keep
// this module importable even before scanners.ts exists (e.g. in tests that
// only exercise backlogPath/scoreItem/loadBacklog).
type Scanner = (repo: string) => Promise<WorkItem[]>;

async function getScanners(): Promise<ReadonlyArray<Scanner>> {
  try {
    const mod = await import('./scanners.js');
    return mod.SCANNERS as ReadonlyArray<Scanner>;
  } catch {
    return [];
  }
}

/**
 * Run all SCANNERS over each enrolled repo, aggregate, dedupe, score, persist,
 * and return the Backlog.
 *
 * - Default repos = listEnrolled() (DEFAULT EMPTY => items: []).
 * - Bounded concurrency: repos scanned sequentially; scanners within a repo
 *   run in parallel (each scanner is individually bounded + never throws).
 * - Never throws: any scanner error yields [] (enforced by scanner contract).
 */
export async function buildBacklog(opts?: { repos?: string[] }): Promise<Backlog> {
  const repos: string[] = opts?.repos ?? listEnrolled();
  const scanners = await getScanners();
  const now = new Date().toISOString();

  const allItems: WorkItem[] = [];

  // Repos scanned sequentially to avoid thundering-herd on gh/npm APIs.
  for (const repo of repos) {
    // Scanners within each repo run in parallel; each is bounded + never throws.
    const perScannerResults = await Promise.all(
      scanners.map(async (scanner) => {
        try {
          return await scanner(repo);
        } catch {
          // Belt-and-suspenders: scanners must not throw, but we catch anyway.
          return [] as WorkItem[];
        }
      }),
    );
    for (const items of perScannerResults) {
      allItems.push(...items);
    }
  }

  // Dedupe by id, recompute score, sort descending.
  const deduped = dedupeItems(allItems).map((item) => ({
    ...item,
    score: scoreItem(item.value, item.effort),
  }));
  deduped.sort((a, b) => b.score - a.score);

  const backlog: Backlog = {
    generatedAt: now,
    repos,
    items: deduped,
  };

  // Persist; never throw on persistence failure.
  try {
    persistBacklog(backlog);
  } catch {
    // Persistence failure does not prevent returning the in-memory backlog.
  }

  // Audit record (metadata only; never secrets).
  audit({
    action: 'backlog:refresh',
    repo: null,
    sandboxId: null,
    summary: `backlog refreshed: ${repos.length} repo(s), ${deduped.length} item(s)`,
    result: 'ok',
  });

  return backlog;
}
