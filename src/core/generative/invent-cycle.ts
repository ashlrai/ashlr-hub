/**
 * M186: invent-cycle — the self-sustaining creation loop.
 *
 * CONTINUOUS INVENTION. Where self-heal (M165) keeps the fleet GREEN, this
 * keeps the fleet AMBITIOUS: every cadence it invents bold, net-new
 * compositional work for the enrolled repos and ENQUEUES it into the backlog
 * so the fleet never runs out of things worth building.
 *
 * Modeled directly on `runSelfHealCycle` (src/core/fleet/self-heal.ts):
 *   - STANDALONE cadence function — NOT wired into loop.ts (deferred).
 *   - Flag-gated: cfg.foundry.generative defaults OFF → returns {invented:0}.
 *     (Opposite posture to self-heal, which defaults ON: inventing is opt-in
 *     because it spends a frontier model; healing is always-on safety.)
 *   - Bounded: at most `inventPerCycle` (default 3) items enqueued per cycle,
 *     spread across repos — keeps the loop cheap and the backlog from flooding.
 *   - Deduped: a ledger at ~/.ashlr/generative/invent-cycle.json (mirrors
 *     self-heal's queue file) records recently-enqueued items so we don't
 *     re-file the same idea cycle after cycle. (inventWorkItems has its OWN
 *     7-day ledger too; this is a second guard scoped to the cycle's enqueue.)
 *   - Never throws — every failure is swallowed; returns counts only.
 *   - Proposal-only: items land in the backlog as pending work; nothing is
 *     applied or merged here.
 *
 * ENQUEUE MECHANISM: appends WorkItems to ~/.ashlr/backlog.json (the same
 * persisted Backlog the daemon reads), mirroring the proven `emitToBacklog`
 * path in src/cli/invent.ts (--emit). New ids only; existing ids are skipped.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, WorkItem } from '../types.js';
import { enqueueBacklogItemsDetailed } from '../portfolio/backlog.js';
import { listGoals } from '../goals/store.js';
import { goalFocusSnapshot } from '../goals/focus.js';
import { listEnrolled } from '../sandbox/policy.js';
import { inventWorkItems } from './invent.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default items enqueued per cycle when foundry.inventPerCycle is unset. */
const DEFAULT_INVENT_PER_CYCLE = 3;
/** Default north-star when no strategist briefing is available. */
const DEFAULT_DIRECTION =
  'Build an incredible, autonomous AI engineering fleet that ships real ' +
  'features at scale with minimal human intervention.';
/** TTL for the cycle dedup ledger — mirrors invent.ts's 7-day window. */
const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap on repos visited per cycle so a huge enrollment can't stall the loop. */
const MAX_REPOS_PER_CYCLE = 12;

// ---------------------------------------------------------------------------
// Cycle dedup ledger (~/.ashlr/generative/invent-cycle.json)
// Mirrors self-heal's atomic tmp+rename persistence; best-effort throughout.
// ---------------------------------------------------------------------------

interface CycleLedgerEntry {
  /** sha1(repo + '::' + normalizedTitle), first 16 hex chars. */
  hash: string;
  repo: string;
  title: string;
  ts: number; // epoch ms
}

interface CycleLedger {
  entries: CycleLedgerEntry[];
}

function ledgerPath(): string {
  return join(homedir(), '.ashlr', 'generative', 'invent-cycle.json');
}

function loadLedger(): CycleLedger {
  try {
    const raw = readFileSync(ledgerPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as CycleLedger).entries)
    ) {
      return parsed as CycleLedger;
    }
  } catch {
    /* absent or corrupt — start fresh */
  }
  return { entries: [] };
}

function saveLedger(ledger: CycleLedger): void {
  try {
    const dir = join(homedir(), '.ashlr', 'generative');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Cap ledger growth (mirror invent.ts's 2000-entry trim).
    if (ledger.entries.length > 2000) {
      ledger.entries = ledger.entries.slice(-2000);
    }
    const p = ledgerPath();
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
    renameSync(tmp, p);
  } catch {
    /* best-effort — never propagate */
  }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function cycleHash(repo: string, title: string): string {
  return createHash('sha1')
    .update(`${repo}::${normalizeTitle(title)}`)
    .digest('hex')
    .slice(0, 16);
}

function isRecentlyEnqueued(ledger: CycleLedger, hash: string): boolean {
  const now = Date.now();
  return ledger.entries.some((e) => e.hash === hash && now - e.ts < DEDUP_TTL_MS);
}

function recordEnqueued(ledger: CycleLedger, repo: string, title: string): void {
  const hash = cycleHash(repo, title);
  ledger.entries = ledger.entries.filter((e) => e.hash !== hash);
  ledger.entries.push({ hash, repo, title, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Direction resolution — latest strategist briefing, else a bold default.
// Mirrors resolveDirection() in src/cli/invent.ts. Best-effort, never throws.
// ---------------------------------------------------------------------------

async function resolveDirection(): Promise<string> {
  try {
    const { loadLatestBriefing } = await import('../vision/strategist.js');
    const briefing = loadLatestBriefing(null);
    if (briefing) {
      const ns = (briefing.proposedEvolution as Record<string, unknown> | undefined)?.['northStar'];
      if (typeof ns === 'string' && ns.trim()) return ns.trim();
      if (briefing.recommendedDirection?.length) {
        return briefing.recommendedDirection.join('; ');
      }
      if (briefing.proposedGoals?.length) {
        return briefing.proposedGoals
          .map((g) => g.objective)
          .filter(Boolean)
          .join('; ');
      }
    }
  } catch {
    /* no briefing — use default */
  }
  return DEFAULT_DIRECTION;
}

// ---------------------------------------------------------------------------
// Lightweight repo-state summary. Mirrors buildRepoState() in cli/invent.ts.
// Never throws — degrades to the bare repo path.
// ---------------------------------------------------------------------------

async function buildRepoState(repo: string): Promise<string> {
  try {
    const pkgPath = join(repo, 'package.json');
    let name = repo;
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          description?: string;
        };
        name = pkg.name ?? repo;
        if (pkg.description) name += ` — ${pkg.description}`;
      } catch {
        /* ignore */
      }
    }
    try {
      const { execSync } = await import('node:child_process');
      const log = execSync('git log --oneline -20', {
        cwd: repo,
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      return `Repo: ${name}\nRecent commits:\n${log}`;
    } catch {
      return `Repo: ${name}`;
    }
  } catch {
    return `Repo: ${repo}`;
  }
}

// ---------------------------------------------------------------------------
// Enqueue fresh WorkItems through the shared queue/backlog lock.
// Returns the number of items actually enqueued (existing ids are skipped).
// ---------------------------------------------------------------------------

function enqueueToBacklog(items: WorkItem[]): { ok: boolean; enqueued: number } {
  return enqueueBacklogItemsDetailed(items);
}

// ---------------------------------------------------------------------------
// runInventCycle
// ---------------------------------------------------------------------------

export interface InventCycleResult {
  /** Total fresh items invented (post per-repo dedup, pre cap) this cycle. */
  invented: number;
  /** Items actually enqueued into the backlog (after cap + cycle-ledger dedup). */
  enqueued: number;
  /** True when new invention is intentionally held behind active-goal closure. */
  deferredByGoalFocus?: boolean;
  /** Bounded reason metadata for observability/tests; no raw goal text. */
  goalFocus?: {
    activeThreshold: number;
    actionableActiveGoalCount: number;
  };
}

export interface InventCycleOptions {
  /** Test seam: bypass the cycle dedup ledger entirely. */
  skipDedup?: boolean;
}

/**
 * Run one invention cadence: invent bold compositional work for the enrolled
 * repos and enqueue the fresh ideas into the backlog as pending work.
 *
 *  - Flag-gated: skipped entirely unless cfg.foundry.generative === true
 *    (default OFF → returns {invented:0, enqueued:0}).
 *  - Bounded: at most `cfg.foundry.inventPerCycle` items (default 3) are
 *    enqueued per cycle, accumulated across repos in enrollment order.
 *  - Deduped: against ~/.ashlr/generative/invent-cycle.json (recently enqueued).
 *  - Never throws.
 */
export async function runInventCycle(
  cfg: AshlrConfig,
  opts: InventCycleOptions = {},
): Promise<InventCycleResult> {
  try {
    const foundry = (cfg.foundry as Record<string, unknown> | undefined) ?? {};

    // Flag gate — default OFF (inventing spends a frontier model; opt-in).
    if (foundry['generative'] !== true) {
      return { invented: 0, enqueued: 0 };
    }

    // Per-cycle cap (items enqueued across all repos this cycle).
    const rawCap = foundry['inventPerCycle'];
    const cap =
      typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0
        ? Math.floor(rawCap)
        : DEFAULT_INVENT_PER_CYCLE;

    const repos = listEnrolled().slice(0, MAX_REPOS_PER_CYCLE);
    if (repos.length === 0) {
      return { invented: 0, enqueued: 0 };
    }

    const focus = goalFocusSnapshot(listGoals({ status: 'active' }), cfg, { repos });
    if (focus.shouldDeferNewGoalWork) {
      return {
        invented: 0,
        enqueued: 0,
        deferredByGoalFocus: true,
        goalFocus: {
          activeThreshold: focus.activeThreshold,
          actionableActiveGoalCount: focus.actionableActiveGoalCount,
        },
      };
    }

    const direction = await resolveDirection();
    const ledger: CycleLedger = opts.skipDedup ? { entries: [] } : loadLedger();

    let invented = 0;
    let enqueued = 0;
    let ledgerChanged = false;

    for (const repo of repos) {
      if (enqueued >= cap) break;
      try {
        const remaining = cap - enqueued;
        const repoState = await buildRepoState(repo);

        // Ask invent for a little extra so cycle-ledger dedup still leaves
        // enough to hit the cap; invent has its own dedup + maintenance filter.
        const items = await inventWorkItems(
          { repo, repoState, direction },
          { cfg },
          { n: Math.max(remaining + 2, 3) },
        );

        // Cycle-ledger dedup + accumulate toward the global cap.
        const fresh: WorkItem[] = [];
        for (const item of items) {
          if (enqueued + fresh.length >= cap) break;
          const hash = cycleHash(repo, item.title);
          if (!opts.skipDedup && isRecentlyEnqueued(ledger, hash)) continue;
          fresh.push(item);
        }

        invented += fresh.length;
        const persisted = enqueueToBacklog(fresh);
        enqueued += persisted.enqueued;
        if (persisted.ok && !opts.skipDedup) {
          for (const item of fresh) recordEnqueued(ledger, repo, item.title);
          ledgerChanged ||= fresh.length > 0;
        }
      } catch {
        // Per-repo errors never abort the cycle.
      }
    }

    if (!opts.skipDedup && ledgerChanged) {
      saveLedger(ledger);
    }

    return { invented, enqueued };
  } catch {
    return { invented: 0, enqueued: 0 };
  }
}
