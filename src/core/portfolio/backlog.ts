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
import type { Backlog, Proposal, WorkItem } from '../types.js';
import { listEnrolled } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { isTrivialItem } from './value-filter.js';
import { computeOutcomePriors, scoreAdjustment } from '../fleet/feedback.js';

// ---------------------------------------------------------------------------
// M133: normalized title for dedup matching
// ---------------------------------------------------------------------------

/**
 * Normalize a title for dedup comparison. Lower-cases, strips punctuation,
 * collapses whitespace. Used to detect duplicate items / pending proposals
 * without exact-string matching (avoids false positives from minor wording
 * differences while still catching the same item filed N times).
 *
 * Strategy: lowercase → strip leading issue/PR prefixes → strip non-word chars
 * → collapse spaces → truncate to 120 chars.
 * "Issue #42: fix null pointer" and "Fix null pointer" will NOT match (the
 * issue number makes them distinct). "1 marker in src/foo.ts:17" filed twice
 * WILL match (same id and same normalized title).
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(issue|pr|bug|feat|fix|chore|refactor|todo|fixme|hack|xxx)\s*[#:]?\s*/i, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

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
// M161: Source-tier weighting
// ---------------------------------------------------------------------------

/**
 * Source priority tiers. Higher tier = more substantive work.
 *
 * Tier 3 (highest) — goal, issue: directive goals and tracked bugs drive real
 *   feature/fix work; the fleet should always prefer these.
 * Tier 2 (high)    — security, test: security vulnerabilities and failing tests
 *   are urgent and produce concrete diffs.
 * Tier 1 (normal)  — self, plugin, doc: useful but not fleet-critical.
 * Tier 0 (low)     — dep, lint, hygiene, todo: often noisy / low yield; should
 *   rank below substantive work when both are present.
 *
 * Multipliers are chosen so that a tier-3 item with value=2 outranks a tier-0
 * item with value=5 (2 * 1.8 = 3.6 > 5/5 * 0.6 = 0.6, even at effort=1).
 */
const SOURCE_TIER_MULTIPLIER: Record<string, number> = {
  goal:     1.8,
  issue:    1.8,
  security: 1.4,
  test:     1.4,
  self:     1.0,
  plugin:   1.0,
  doc:      1.0,
  todo:     0.6,
  dep:      0.6,
  lint:     0.6,
  hygiene:  0.6,
};

/** Returns the source-tier multiplier for an item's source. Unknown sources → 1.0. */
export function sourceTierMultiplier(source: string): number {
  return SOURCE_TIER_MULTIPLIER[source] ?? 1.0;
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
  const seenId = new Set<string>();
  const seenTitle = new Set<string>();
  const out: WorkItem[] = [];
  for (const item of items) {
    const normTitle = normalizeTitle(item.title);
    if (!seenId.has(item.id) && !seenTitle.has(normTitle)) {
      seenId.add(item.id);
      seenTitle.add(normTitle);
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
import type { AshlrConfig } from '../types.js';
type Scanner = (repo: string, cfg?: Pick<AshlrConfig, 'foundry'>) => Promise<WorkItem[]>;

async function getScanners(): Promise<ReadonlyArray<Scanner>> {
  let builtin: ReadonlyArray<Scanner> = [];
  try {
    const mod = await import('./scanners.js');
    // SCANNERS type in scanners.ts is ReadonlyArray<(repo, cfg?) => ...>, which
    // matches Scanner here. The cast silences the readonly widening mismatch.
    builtin = mod.SCANNERS as unknown as ReadonlyArray<Scanner>;
  } catch {
    builtin = [];
  }
  // M33: merge enabled-plugin scanners (already wrapped: bounded, never-throw,
  // scrubbed, namespaced). Best-effort — a broken plugin layer never blocks
  // the builtin sweep; with plugins.enabled [] this resolves to [].
  let fromPlugins: ReadonlyArray<Scanner> = [];
  try {
    const { loadConfig } = await import('../config.js');
    const { getPluginScanners } = await import('../plugins/registry.js');
    fromPlugins = await getPluginScanners(loadConfig());
  } catch {
    fromPlugins = [];
  }
  return [...builtin, ...fromPlugins];
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
export async function buildBacklog(opts?: {
  repos?: string[];
  minItemValue?: number;
  /** M125: injectable listProposals for feedback-loop tests. */
  listProposals?: () => Proposal[];
  /**
   * M133: injectable pending-proposals reader for dedup tests.
   * When provided, replaces the default listProposals({status:'pending'}) call
   * that drops items already represented by an open pending proposal.
   * Separate from the M125 listProposals to keep feedback-loop tests isolated.
   */
  listPendingProposals?: () => Proposal[];
  /** Override the loaded config (tests / programmatic scanner-flag control, e.g. scanTodos). */
  cfg?: Pick<AshlrConfig, "foundry">;
}): Promise<Backlog> {
  const repos: string[] = opts?.repos ?? listEnrolled();
  const scanners = await getScanners();
  const now = new Date().toISOString();

  // Load cfg ONCE — used for minItemValue, feedbackEnabled, and scanner flags
  // (e.g. cfg.foundry.scanTodos). Must be loaded before the scanner loop so
  // it can be threaded through to each scanner call.
  let cfg: Pick<AshlrConfig, 'foundry'> | undefined = opts?.cfg;
  if (!cfg) {
    try {
      const { loadConfig } = await import('../config.js');
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
  }

  // Resolve min-value threshold: explicit opt > config > default (2).
  let minValue = opts?.minItemValue;
  // M125: resolve feedbackEnabled from config (default true).
  let feedbackEnabled = true;
  // M151: EDV independent-confirmation gate (default false = opt-in via cfg.foundry.edvVerify).
  let edvVerify = false;
  if (minValue === undefined) {
    minValue = cfg?.foundry?.minItemValue ?? 2;
    // cfg.foundry.feedbackEnabled: absent → true (opt-out by setting false).
    const rawFeedback = (cfg?.foundry as Record<string, unknown> | undefined)?.['feedbackEnabled'];
    if (rawFeedback === false) feedbackEnabled = false;
    // M151: cfg.foundry.edvVerify: absent → false (opt-in).
    const rawEdv = (cfg?.foundry as Record<string, unknown> | undefined)?.['edvVerify'];
    if (rawEdv === true) edvVerify = true;
  }

  const allItems: WorkItem[] = [];

  // Repos scanned sequentially to avoid thundering-herd on gh/npm APIs.
  for (const repo of repos) {
    // Scanners within each repo run in parallel; each is bounded + never throws.
    // cfg is threaded so scanners that consult flags (e.g. scanTodos checks
    // cfg.foundry.scanTodos) receive the live config rather than undefined.
    const perScannerResults = await Promise.all(
      scanners.map(async (scanner) => {
        try {
          return await scanner(repo, cfg);
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
  // M161: score = raw value/effort score × source-tier multiplier so substantive
  // sources (goal, issue, security, test) naturally outrank dep/lint/hygiene
  // even when raw scores are similar.
  const deduped = dedupeItems(allItems).map((item) => ({
    ...item,
    score: scoreItem(item.value, item.effort) * sourceTierMultiplier(item.source),
  }));
  deduped.sort((a, b) => b.score - a.score);

  // M124: value-filter gate — drop trivial / low-value items before persisting.
  // Two-stage: (1) drop items below minItemValue threshold, (2) drop items that
  // isTrivialItem flags as unlikely to yield a valuable diff. Both gates apply.
  const passed: WorkItem[] = [];
  const filtered: WorkItem[] = [];
  for (const item of deduped) {
    if (item.value < minValue) {
      filtered.push(item);
      continue;
    }
    const { trivial } = isTrivialItem(item);
    if (trivial) {
      filtered.push(item);
      continue;
    }
    passed.push(item);
  }

  // M161: No-starvation guard — if ALL items were filtered by isTrivialItem (not
  // by the value gate) AND no substantive items exist, restore the trivial-flagged
  // items so the fleet always has something to do. This only activates when the
  // only available work is low-tier; it does NOT override the minItemValue gate.
  //
  // Condition: passed is empty but deduped is non-empty (items exist but all were
  // trivial-flagged). In this case we restore the trivial-flagged items that
  // still met the minValue threshold so the fleet can still make progress.
  if (passed.length === 0 && deduped.length > 0) {
    const valueGateOnly = deduped.filter((item) => item.value >= minValue);
    passed.push(...valueGateOnly);
    // Remove the restored items from filtered to avoid double-counting in audit.
    const restoredIds = new Set(valueGateOnly.map((i) => i.id));
    for (let i = filtered.length - 1; i >= 0; i--) {
      if (restoredIds.has(filtered[i]!.id)) filtered.splice(i, 1);
    }
  }

  // M133: Dedup vs open pending proposals — drop any item that already has an
  // open (pending) proposal so the same item cannot be re-filed N times while
  // one is still awaiting review.
  //
  // Matching strategy (robust, not naive substring):
  //   1. Match by item.id against proposal.workItemId (when set).
  //   2. Match by normalized title — strips punctuation/prefixes/case so minor
  //      wording differences don't cause false negatives, but the normalization
  //      is narrow enough that different items (different file paths, different
  //      issue numbers) still resolve to distinct tokens.
  //
  // False-positive avoidance: we do NOT match on raw title substring (that
  // would drop "Fix auth.ts:88" because "auth" appears in "Fix auth flow in
  // docs/auth.md"). The normalized-title approach requires the CORE noun phrase
  // to match, not just a shared substring.
  let passedAfterPendingDedup = passed;
  let pendingDedupCount = 0;
  try {
    const pendingProposals: Proposal[] = opts?.listPendingProposals
      ? opts.listPendingProposals()
      : await (async () => {
          try {
            const { listProposals: lp } = await import('../inbox/store.js');
            return lp({ status: 'pending' });
          } catch {
            return [] as Proposal[];
          }
        })();

    if (pendingProposals.length > 0) {
      // Build lookup sets for both matching strategies.
      const pendingIds = new Set<string>();
      const pendingNormTitles = new Set<string>();
      for (const p of pendingProposals) {
        // workItemId: optional field that directly links a proposal to its item
        const pRec = p as unknown as Record<string, unknown>;
        if (typeof pRec['workItemId'] === 'string') {
          pendingIds.add(pRec['workItemId']);
        }
        pendingNormTitles.add(normalizeTitle(p.title));
      }

      passedAfterPendingDedup = passed.filter((item) => {
        if (pendingIds.has(item.id)) {
          pendingDedupCount++;
          return false;
        }
        if (pendingNormTitles.has(normalizeTitle(item.title))) {
          pendingDedupCount++;
          return false;
        }
        return true;
      });
    }
  } catch {
    // Pending-dedup failure must never block backlog delivery.
    passedAfterPendingDedup = passed;
  }

  // M125: feedback-loop re-ranking — apply outcome priors to adjust item scores.
  // Gate: feedbackEnabled (default true; set cfg.foundry.feedbackEnabled=false to skip).
  // When enabled, items from historically-productive sources are up-ranked; noisy/
  // empty sources are down-ranked. Floor ≥ 0.5 keeps exploration alive.
  // Flag-off: no adjustment, byte-identical order to pre-M125.
  let finalItems = passedAfterPendingDedup;
  if (feedbackEnabled) {
    try {
      const priors = await computeOutcomePriors({ listProposals: opts?.listProposals, edvVerify });
      const adjusted = passedAfterPendingDedup.map((item) => {
        const multiplier = scoreAdjustment(item, priors);
        return multiplier === 1.0 ? item : { ...item, score: item.score * multiplier };
      });
      adjusted.sort((a, b) => b.score - a.score);
      finalItems = adjusted;
    } catch {
      // Feedback failure must never disrupt backlog delivery — fall through to
      // the original passed array (flag-off equivalent).
      finalItems = passed;
    }
  }

  const backlog: Backlog = {
    generatedAt: now,
    repos,
    items: finalItems,
  };

  // Persist; never throw on persistence failure.
  try {
    persistBacklog(backlog);
  } catch {
    // Persistence failure does not prevent returning the in-memory backlog.
  }

  // Audit record (metadata only; never secrets).
  const filteredMsg = filtered.length > 0 ? `; ${filtered.length} trivial/low-value item(s) filtered (minItemValue=${minValue})` : '';
  const dedupMsg = pendingDedupCount > 0 ? `; ${pendingDedupCount} item(s) deduplicated vs open pending proposals` : '';
  audit({
    action: 'backlog:refresh',
    repo: null,
    sandboxId: null,
    summary: `backlog refreshed: ${repos.length} repo(s), ${finalItems.length} item(s)${filteredMsg}${dedupMsg}`,
    result: 'ok',
  });

  return backlog;
}
