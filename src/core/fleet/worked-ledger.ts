/**
 * worked-ledger.ts — M85: per-item worked-outcome ledger.
 *
 * Tracks whether each WorkItem produced a real diff ('diff') or an empty run
 * ('empty') so the daemon can skip recently-declined items and avoid re-clogging
 * on work that has already been attempted with no result.
 *
 * Persistence discipline mirrors quota.ts EXACTLY:
 *  - Atomic writes (tmp file + POSIX rename).
 *  - NEVER throws — load returns a fresh empty ledger on missing/corrupt file;
 *    record swallows any persistence error.
 *  - mkdir -p the parent dir.
 *  - Bounded history (last ~2000 entries).
 *  - Homedir re-resolved at call time so tests can relocate HOME.
 *
 * No new runtime deps; node builtins only.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkItem } from '../types.js';
import { canonicalFilesystemPathIdentity } from '../sandbox/policy.js';
import { fsyncDirectory } from '../util/durability.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of outcome events retained in worked.json. */
const MAX_EVENTS = 2000;

/** Default cooldown window: 6 hours in milliseconds. */
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const GENERATED_REPAIR_DISPATCH_BLOCKED_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * The outcome of a single item run or judge verdict.
 *
 * - 'diff'            — run produced a real diff (work done).
 * - 'empty'           — run produced no diff (nothing to do right now).
 * - 'judged-review'   — judge returned 'review' (needs human inspection).
 * - 'judged-noise'    — judge returned 'noise' (trivial / not worth it).
 * - 'judged-decline'  — judge returned 'harmful' or 'decline' (rejected).
 * - 'dispatch-blocked' — selected work did not reach an executor; retry later.
 *
 * Any judged-* outcome suppresses the item for the cooldown window the same
 * way 'empty' does, preventing the "CI is failing" re-clog loop.
 */
export type WorkedOutcome =
  | 'diff'
  | 'empty'
  | 'dispatch-blocked'
  | 'judged-review'
  | 'judged-noise'
  | 'judged-decline';

/** A single recorded item outcome. */
export interface WorkedEvent {
  /** The WorkItem id that was run. */
  itemId: string;
  /** Whether the run produced a real diff ('diff') or nothing ('empty'). */
  outcome: WorkedOutcome;
  /** ISO timestamp of the outcome. */
  ts: string;
  /** Rejected proposal already swept into this outcome, when applicable. */
  proposalId?: string;
  /** Exact shared-claim completion marker for indeterminate-commit readback. */
  claimCompletionId?: string;
}

/** The persisted worked ledger. */
export interface WorkedLedger {
  /** Bounded list of recent outcome events (oldest first). */
  events: WorkedEvent[];
}

export function isWorkedOutcome(outcome: unknown): outcome is WorkedOutcome {
  return (
    outcome === 'diff' ||
    outcome === 'empty' ||
    outcome === 'dispatch-blocked' ||
    outcome === 'judged-review' ||
    outcome === 'judged-noise' ||
    outcome === 'judged-decline'
  );
}

export function isSuppressibleWorkedOutcome(outcome: WorkedOutcome): boolean {
  return outcome === 'empty' ||
    outcome === 'dispatch-blocked' ||
    outcome === 'judged-review' ||
    outcome === 'judged-noise' ||
    outcome === 'judged-decline';
}

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function fleetDir(): string {
  return join(homedir(), '.ashlr', 'fleet');
}

/** Absolute path to the fleet worked ledger file. */
export function workedLedgerPath(): string {
  return join(fleetDir(), 'worked.json');
}

// ---------------------------------------------------------------------------
// Fresh default
// ---------------------------------------------------------------------------

function freshLedger(): WorkedLedger {
  return { events: [] };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and parse workedLedgerPath(). NEVER throws.
 * Returns a fresh empty ledger when the file is missing or malformed.
 */
export function loadWorkedLedger(): WorkedLedger {
  const p = workedLedgerPath();
  if (!existsSync(p)) return freshLedger();
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return freshLedger();
    }
    const obj = parsed as Record<string, unknown>;
    const events = Array.isArray(obj['events'])
      ? (obj['events'] as unknown[]).filter(
          (e): e is WorkedEvent =>
            typeof e === 'object' &&
            e !== null &&
            !Array.isArray(e) &&
            typeof (e as Record<string, unknown>)['itemId'] === 'string' &&
            typeof (e as Record<string, unknown>)['ts'] === 'string' &&
            isWorkedOutcome((e as Record<string, unknown>)['outcome']),
        )
        .map((e) => {
          const raw = e as unknown as Record<string, unknown>;
          return {
            itemId: e.itemId,
            outcome: e.outcome,
            ts: e.ts,
            ...(typeof raw['proposalId'] === 'string' ? { proposalId: raw['proposalId'] } : {}),
          };
        })
      : [];
    return { events };
  } catch {
    // Corrupt JSON or any other read error — return a fresh empty ledger.
    return freshLedger();
  }
}

// ---------------------------------------------------------------------------
// Save (atomic) — internal
// ---------------------------------------------------------------------------

/**
 * Atomically write the ledger via tmp-file + rename (POSIX-atomic).
 * Creates ~/.ashlr/fleet recursively. Bounds events. Never throws.
 */
function saveWorkedLedger(l: WorkedLedger): boolean {
  let tmp: string | undefined;
  let fd: number | undefined;
  try {
    const dir = fleetDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const bounded: WorkedLedger = {
      events: l.events.slice(-MAX_EVENTS),
    };
    const dest = workedLedgerPath();
    tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify(bounded, null, 2) + '\n', 'utf8');
    fd = openSync(tmp, 'r+');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, dest);
    tmp = undefined;
    fsyncDirectory(dir);
    return true;
  } catch {
    // Persistence failure must not crash the fleet — swallow silently.
    if (tmp) { try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ } }
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

// ---------------------------------------------------------------------------
// Record an outcome
// ---------------------------------------------------------------------------

/**
 * Append an outcome event for `itemId` and persist. Never throws.
 *
 * @param itemId   - The WorkItem id.
 * @param outcome  - 'diff' when the run produced a real diff; 'empty' when not.
 * @param ts       - Optional ISO timestamp; defaults to now. Injectable for tests.
 */
export function recordOutcome(
  itemId: string,
  outcome: WorkedOutcome,
  ts?: string,
): boolean {
  return recordOutcomeEvent(itemId, outcome, ts);
}

function recordOutcomeEvent(
  itemId: string,
  outcome: WorkedOutcome,
  ts?: string,
  proposalId?: string,
): boolean {
  try {
    const l = loadWorkedLedger();
    l.events.push({
      itemId,
      outcome,
      ts: ts ?? new Date().toISOString(),
      ...(proposalId ? { proposalId } : {}),
    });
    return saveWorkedLedger(l);
  } catch {
    // Never throws.
    return false;
  }
}

function proposalAlreadySwept(proposalId: string): boolean {
  try {
    return loadWorkedLedger().events.some((event) => event.proposalId === proposalId);
  } catch {
    return false;
  }
}

function sweptProposalMarkerItemId(proposalId: string): string {
  return `__swept_proposal__:${proposalId}`;
}

function recordSweptProposalOutcome(
  itemId: string,
  outcome: WorkedOutcome,
  proposalId: string,
  ts: string | undefined,
  record: (
    itemId: string,
    outcome: WorkedOutcome,
    ts?: string,
    workItemGenerationId?: string,
    matchedItem?: WorkItem,
  ) => void,
  workItemGenerationId?: string,
  matchedItem?: WorkItem,
): void {
  if (record === recordOutcome) {
    recordOutcomeEvent(itemId, outcome, ts, proposalId);
    return;
  }
  record(itemId, outcome, ts, workItemGenerationId, matchedItem);
  recordOutcomeEvent(sweptProposalMarkerItemId(proposalId), outcome, ts, proposalId);
}

// ---------------------------------------------------------------------------
// Cooldown check
// ---------------------------------------------------------------------------

/**
 * Returns true when the item's LAST recorded outcome was 'empty' AND that
 * outcome occurred within the last `cooldownMs` milliseconds.
 *
 * - Returns false (not declined) when the item has no recorded outcome.
 * - Returns false when the last outcome was 'diff' (real work was done).
 * - Returns false when the last suppressible outcome is older than cooldownMs.
 * - Suppressible outcomes: 'empty', 'judged-review', 'judged-noise', 'judged-decline'.
 * - `now` is injectable for deterministic tests (defaults to Date.now()).
 * - NEVER throws.
 */
export function recentlyDeclined(
  itemId: string,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
  now?: number,
): boolean {
  try {
    return workedEventIsCooling(
      latestWorkedEventForKeys(loadWorkedLedger().events, [itemId]),
      cooldownMs,
      now,
    );
  } catch {
    // Never throws — fail open (not declined).
    return false;
  }
}

export function latestWorkedEvent(itemId: string): WorkedEvent | undefined {
  try {
    return latestWorkedEventForKeys(loadWorkedLedger().events, [itemId]);
  } catch {
    return undefined;
  }
}

export function latestWorkedEventForKeys(
  events: readonly WorkedEvent[],
  itemIds: readonly string[],
): WorkedEvent | undefined {
  const keys = new Set(itemIds);
  let latest: WorkedEvent | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (!keys.has(event.itemId)) continue;
    const eventMs = Date.parse(event.ts);
    if (!Number.isFinite(eventMs)) continue;
    // Equal timestamps resolve to the later append, matching ledger order.
    if (eventMs >= latestMs) {
      latest = event;
      latestMs = eventMs;
    }
  }
  return latest;
}

export function workedEventIsCooling(
  event: WorkedEvent | undefined,
  cooldownMs: number,
  now?: number,
): boolean {
  if (!event || !isSuppressibleWorkedOutcome(event.outcome)) return false;
  const eventMs = Date.parse(event.ts);
  if (!Number.isFinite(eventMs)) return false;
  return (now ?? Date.now()) - eventMs < cooldownMs;
}

// ---------------------------------------------------------------------------
// M220: Judge-verdict feedback — recordVerdict + sweepJudgedProposals
// ---------------------------------------------------------------------------

/**
 * Map a raw judge verdict string to a WorkedOutcome decline class.
 * Returns undefined when the verdict should NOT suppress the item
 * (e.g. 'ship' — real work passed the judge).
 */
export function verdictToOutcome(
  verdict: string,
): 'judged-review' | 'judged-noise' | 'judged-decline' | undefined {
  switch (verdict.toLowerCase()) {
    case 'review': return 'judged-review';
    case 'noise':
    case 'trivial':
    case 'skip':
    case 'ignore': return 'judged-noise';
    case 'harmful':
    case 'dangerous':
    case 'reject':
    case 'rejected':
    case 'block':
    case 'decline': return 'judged-decline';
    default: return undefined; // 'ship' or unknown → do not suppress
  }
}

/**
 * Record a judge verdict for `itemId`. Convenience wrapper over recordOutcome.
 *
 * - verdict='ship'    → ignored (ship is positive; item should stay selectable)
 * - verdict='review'  → records 'judged-review'
 * - verdict='noise'   → records 'judged-noise'
 * - verdict='harmful' → records 'judged-decline'
 * - Never throws.
 *
 * @param itemId  - The WorkItem id the proposal was generated from.
 * @param verdict - The raw verdict string from ManagerVerdict.verdict.
 * @param ts      - Optional ISO timestamp; defaults to now. Injectable for tests.
 */
export function recordVerdict(itemId: string, verdict: string, ts?: string): void {
  try {
    const outcome = verdictToOutcome(verdict);
    if (outcome === undefined) return; // 'ship' or unknown — do not suppress
    recordOutcome(itemId, outcome, ts);
  } catch {
    // Never throws.
  }
}

/**
 * Build a STABLE signature for an item used to match it across scanner ticks.
 *
 * The scanner generates item IDs as `repoBasename:source:sha1(discriminator)`
 * (see scanners.ts makeId). If the discriminator changes between ticks (e.g.
 * a CI scanner that includes a timestamp), the ledger would never match.
 *
 * To guard against ID drift we ALSO key on `repo + normalised title`, which is
 * invariant across ticks for the same real issue. sweepJudgedProposals tries
 * the item.id first (exact), then falls back to the stable signature.
 *
 * Normalisation: lowercase, collapse whitespace, strip punctuation.
 */
export function stableItemSig(repo: string, title: string): string {
  const canonicalRepo = canonicalFilesystemPathIdentity(repo, { foldWindowsCase: false });
  if (canonicalRepo === null) return '';
  const normTitle = title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  return `${canonicalRepo}::${normTitle}`;
}

function sameWorkItemRepo(left: string, right: string | null): boolean {
  if (right === null) return false;
  const leftCanonical = canonicalFilesystemPathIdentity(left, { foldWindowsCase: false });
  const rightCanonical = canonicalFilesystemPathIdentity(right, { foldWindowsCase: false });
  return leftCanonical !== null && leftCanonical === rightCanonical;
}

/**
 * M220: Sweep judged proposals back into the worked ledger.
 *
 * Called once per tick (BEFORE selection) to feed judge verdicts back so items
 * whose proposals were judged 'review', 'noise', or 'harmful'/'decline' are
 * suppressed for the cooldown window and not re-proposed every tick.
 *
 * Matching strategy (ID-stability):
 *  1. Prefer proposal.workItemId when present; it is the causal source item.
 *  2. Otherwise scan `backlogItems` for a match.
 *  3. Primary key: item.id appears as a token in `prop.title + ' ' + prop.summary`
 *     (same regex logic as pendingItemIds in loop.ts — exact word boundary).
 *  4. Fallback key: stableItemSig(item.repo, item.title) matches
 *     stableItemSig(prop.repo ?? '', prop.title) — handles fresh scanner IDs.
 *  5. Only the FIRST match is recorded to avoid double-counting.
 *
 * A proposal is "judged-decline-class" when its status is 'rejected' (the
 * manager sets status='rejected' for noise/harmful when applyRejects=true).
 * The `decisionReason` carries the raw verdict when available.
 *
 * @param judgedProposals - Proposals to sweep (caller filters by status).
 * @param backlogItems    - Current tick's full backlog.
 * @param ts              - Optional ISO timestamp; defaults to now. Injectable for tests.
 * @returns               - Number of items that had a verdict recorded.
 */
export function sweepJudgedProposals(
  judgedProposals: ReadonlyArray<{
    id: string;
    title: string;
    summary: string;
    repo: string | null;
    status: string;
    decisionReason?: string;
    workItemId?: string;
    workItemGenerationId?: string;
  }>,
  backlogItems: ReadonlyArray<WorkItem>,
  ts?: string,
  record: (
    itemId: string,
    outcome: WorkedOutcome,
    ts?: string,
    workItemGenerationId?: string,
    matchedItem?: WorkItem,
  ) => void = recordOutcome,
): number {
  let recorded = 0;
  try {
    // Build stable-sig index of backlog items for O(n) fallback lookup.
    const sigIndex = new Map<string, WorkItem>();
    for (const item of backlogItems) {
      const sig = stableItemSig(item.repo, item.title);
      if (!sigIndex.has(sig)) sigIndex.set(sig, item);
    }

    for (const prop of judgedProposals) {
      if (proposalAlreadySwept(prop.id)) continue;

      // Determine the verdict outcome from the proposal.
      // For rejected proposals: decisionReason may carry the raw verdict.
      // When absent, treat as 'judged-decline' (the manager only rejects noise/harmful).
      let outcome: WorkedOutcome;
      if (prop.status === 'rejected') {
        const rawVerdict = prop.decisionReason ?? 'harmful';
        outcome = verdictToOutcome(rawVerdict) ?? 'judged-decline';
      } else {
        // Non-rejected proposals are not a decline signal — skip.
        continue;
      }

      if (prop.workItemId) {
        const candidates = backlogItems.filter((item) => item.id === prop.workItemId);
        const matched = prop.repo !== null
          ? candidates.find((item) => sameWorkItemRepo(item.repo, prop.repo))
          : candidates.length === 1 ? candidates[0] : undefined;
        recordSweptProposalOutcome(
          prop.workItemId,
          outcome,
          prop.id,
          ts,
          record,
          prop.workItemGenerationId,
          matched,
        );
        recorded++;
        continue;
      }

      // Try primary match: item.id as exact token in the proposal text.
      const haystack = `${prop.title} ${prop.summary}`;
      let matched: WorkItem | undefined;
      const candidates = prop.repo === null
        ? backlogItems
        : backlogItems.filter((item) => sameWorkItemRepo(item.repo, prop.repo));
      for (const item of candidates) {
        const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
        if (re.test(haystack)) {
          matched = item;
          break;
        }
      }

      // Fallback: stable-sig match (repo + normalised title).
      if (!matched && prop.repo !== null) {
        const propSig = stableItemSig(prop.repo ?? '', prop.title);
        matched = sigIndex.get(propSig);
      }

      if (!matched) continue;

      recordSweptProposalOutcome(
        matched.id,
        outcome,
        prop.id,
        ts,
        record,
        prop.workItemGenerationId,
        matched,
      );
      recorded++;
    }
  } catch {
    // Never throws.
  }
  return recorded;
}
