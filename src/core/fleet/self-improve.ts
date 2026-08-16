/**
 * self-improve.ts — M235: recursive self-improvement write-back.
 *
 * Closes the learning loop with metadata-only negative observations. Model
 * reasoning and proposal text are never persisted or replayed into future runs.
 *
 * SAFETY INVARIANTS:
 *  - WRITE TARGET: genome hub + decisions ledger ONLY. Never touches
 *    merge.ts gate logic, sandbox confinement, scope-cap, M54, or any
 *    policy file.
 *  - FIRE-AND-FORGET: learnFromRejection() never throws, never awaits
 *    anything on the critical path. All I/O is wrapped in try/catch.
 *  - GATED: every code path checks cfg.foundry?.selfImprove !== false
 *    (default ON). When the flag is explicitly false the function returns
 *    immediately — byte-identical to having no call at all.
 *  - ADDITIVE: the genome entry is informational grounding for future runs.
 *    It is NOT an execution directive; it does not alter the merge gate,
 *    the judge, or any safety policy.
 *  - CURATOR CAP: genome entries written by this module carry the tag
 *    'm235:anti-playbook'. The inject-time curator (curateAntiPlaybooks)
 *    trims entries older than STALE_DAYS and caps total injected chars at
 *    INJECT_CHAR_CAP so the genome never injects stale noise.
 *  - TELEMETRY: a usage counter is appended to the decisions ledger under
 *    action 'self-improve:written' for observability (no PII, no secrets).
 */

import { appendHubEntry } from '../genome/store.js';
import { readDecisions, readDecisionsDetailed, recordDecision } from './decisions-ledger.js';
import type { AshlrConfig, DecisionEntry, GenomeEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Anti-playbook genome entries older than this many days are skipped during
 *  inject-time curation (stale-archive cap). */
const STALE_DAYS = 90;

/** Hard cap on total characters injected from anti-playbook entries per run. */
export const ANTI_PLAYBOOK_INJECT_CAP = 800;

/** Tag prefix for all genome entries written by this module. */
const TAG = 'm235:anti-playbook';

// ---------------------------------------------------------------------------
// Verdict that triggers write-back (review | noise | harmful).
// We never write back for 'ship' — that is the playbooks.ts path.
// ---------------------------------------------------------------------------

type RejectionVerdict = 'review' | 'noise' | 'harmful';

function isRejection(v: string): v is RejectionVerdict {
  return v === 'review' || v === 'noise' || v === 'harmful';
}

// ---------------------------------------------------------------------------
// Lesson derivation (pure, deterministic, no LLM)
// ---------------------------------------------------------------------------

/**
 * Derive a finite anti-playbook lesson from a judge verdict. The legacy text
 * parameters are intentionally ignored so older callers cannot persist raw
 * proposal content or model reasoning.
 */
export function deriveLesson(
  verdict: RejectionVerdict,
  _reasoning: string,
  _proposalTitle: string,
): string {
  const lessonByVerdict: Record<RejectionVerdict, string> = {
    review: 'A proposal required review. Do not promote uncertain work without stronger deterministic evidence.',
    noise: 'A proposal was classified as noise. Prefer work with explicit user value and measurable repository impact.',
    harmful: 'A proposal was classified as harmful. Refuse the pattern and require independent safety evidence before retrying.',
  };
  return `Anti-playbook observation (${verdict}): ${lessonByVerdict[verdict]}`;
}

// ---------------------------------------------------------------------------
// Public: learnFromRejection
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget learning write-back.
 *
 * Called AFTER the judge verdict is known (in automerge-pass.ts, after the
 * non-ship branch). Writes:
 *   1. A genome hub entry (anti-playbook lesson) tagged 'm235:anti-playbook'.
 *   2. A decisions-ledger entry for telemetry/observability.
 *
 * NEVER THROWS. NEVER BLOCKS (all I/O is synchronous JSONL append behind
 * try/catch). Gated on cfg.foundry?.selfImprove !== false.
 *
 * @param proposalId  The proposal id (for ledger correlation).
 * @param proposalTitle  Legacy compatibility input; deliberately discarded.
 * @param verdict  Must be 'review' | 'noise' | 'harmful'.
 * @param reasoning  Legacy compatibility input; deliberately discarded.
 * @param cfg  Fleet config.
 */
export function learnFromRejection(
  proposalId: string,
  proposalTitle: string,
  verdict: string,
  reasoning: string,
  cfg: AshlrConfig,
): void {
  // Gate: default ON; explicit false = no-op (byte-identical to no call).
  try {
    const foundry = cfg.foundry as Record<string, unknown> | undefined;
    if (foundry?.['selfImprove'] === false) return;
  } catch {
    return;
  }

  // Only act on rejection verdicts.
  if (!isRejection(verdict)) return;

  // Derive and write the lesson.
  try {
    const lesson = deriveLesson(verdict, reasoning, proposalTitle);
    const title = `Anti-playbook observation: ${verdict}`;

    appendHubEntry({
      title,
      text: lesson,
      tags: [TAG, `verdict:${verdict}`, `proposal:${proposalId.slice(0, 24)}`],
      hubOnly: true,
    });
  } catch {
    // appendHubEntry never throws by contract; guard defensively.
  }

  // Telemetry: record to decisions ledger (action 'self-improve:written').
  try {
    recordDecision({
      ts: new Date().toISOString(),
      proposalId,
      action: 'self-improve:written' as Parameters<typeof recordDecision>[0]['action'],
      detail: `verdict=${verdict}`,
      repo: '',
      engine: '',
      model: '',
    } as Parameters<typeof recordDecision>[0]);
  } catch {
    // Ledger write is best-effort observability only.
  }
}

// ---------------------------------------------------------------------------
// Public: sweepRejectionLearning — auto-merge-independent reachability
// ---------------------------------------------------------------------------

/**
 * Bound on judged-decision candidates inspected per sweep pass.
 */
const MAX_REJECTION_SWEEP_CANDIDATES = 200;

export interface RejectionLearningSweepResult {
  /** Distinct proposals with a rejection-shaped judge verdict inspected. */
  scanned: number;
  /** Proposals for which learnFromRejection actually wrote a lesson. */
  written: number;
  /** Proposals inspected but skipped (already written, or a transient error). */
  skipped: number;
  /** False when the decisions source was incomplete/degraded, or the
   *  candidate cap was hit — a hint the pass should be retried. */
  sourceComplete: boolean;
}

/**
 * Sweep the decisions ledger for judged rejection verdicts (review | noise |
 * harmful) and call learnFromRejection() for each one that hasn't already
 * produced a genome lesson.
 *
 * learnFromRejection's ONLY prior caller was automerge-pass.ts, reached
 * exclusively from inside the auto-merge pass (cfg.foundry.autoMerge.enabled
 * === true). With auto-merge off — the default — a judge verdict could still
 * be recorded (manual `ashlr judge`, a shadow/observe-only judge pass, etc.)
 * but the fleet never learned from it. This sweep reads the SAME
 * decisions-ledger 'judged' rows regardless of what produced them, so a
 * rejected or failed run teaches the fleet whether or not auto-merge is on.
 *
 * Idempotent: a proposalId that already has a 'self-improve:written'
 * telemetry row is skipped. Bounded, fail-open-on-nothing-to-do,
 * fail-closed-on-source-degradation (sourceComplete:false signals "retry
 * later", never treated as "nothing to learn"). Never throws.
 */
export function sweepRejectionLearning(
  cfg: AshlrConfig,
  opts: { sinceMs?: number; listDecisions?: () => DecisionEntry[] } = {},
): RejectionLearningSweepResult {
  const result: RejectionLearningSweepResult = {
    scanned: 0, written: 0, skipped: 0, sourceComplete: true,
  };
  try {
    const foundry = cfg.foundry as Record<string, unknown> | undefined;
    if (foundry?.['selfImprove'] === false) return result;

    let decisions: DecisionEntry[];
    if (typeof opts.listDecisions === 'function') {
      try {
        decisions = opts.listDecisions();
      } catch {
        decisions = [];
      }
    } else {
      const read = readDecisionsDetailed({
        requireComplete: true,
        ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
      });
      if (!read.complete || read.sourceState === 'degraded') {
        result.sourceComplete = false;
        return result;
      }
      decisions = read.decisions;
    }

    // Newest judged verdict per proposalId — mirrors the isNewerDecision
    // pattern used elsewhere (feedback.ts, quality-metrics.ts). The compare
    // must run over EVERY judged verdict (not just rejection-shaped ones):
    // if a proposal's latest verdict is 'ship', a stale earlier
    // noise/harmful/review verdict must not be taught as a lesson — it was
    // superseded.
    const latestJudged = new Map<string, DecisionEntry>();
    for (const entry of decisions) {
      if (entry.action !== 'judged') continue;
      const existing = latestJudged.get(entry.proposalId);
      if (!existing || Date.parse(entry.ts) > Date.parse(existing.ts)) {
        latestJudged.set(entry.proposalId, entry);
      }
    }
    const latestRejection = new Map<string, DecisionEntry>();
    for (const [proposalId, entry] of latestJudged) {
      const verdict = (entry.verdict ?? '').toLowerCase();
      if (isRejection(verdict)) latestRejection.set(proposalId, entry);
    }

    let inspected = 0;
    for (const [proposalId, entry] of latestRejection) {
      if (inspected >= MAX_REJECTION_SWEEP_CANDIDATES) {
        result.sourceComplete = false;
        break;
      }
      inspected++;
      result.scanned++;
      try {
        const existing = readDecisions({ proposalId, requireComplete: true });
        const existingQuality = (existing as typeof existing & {
          sourceQuality?: { sourceState?: string; complete?: boolean };
        }).sourceQuality;
        if (existingQuality && (existingQuality.sourceState === 'degraded' || existingQuality.complete === false)) {
          result.skipped++;
          result.sourceComplete = false;
          continue;
        }
        if (existing.some((row) => row.action === 'self-improve:written')) continue;

        learnFromRejection(proposalId, '', entry.verdict ?? 'review', '', cfg);
        result.written++;
      } catch {
        result.skipped++;
      }
    }
    return result;
  } catch {
    return result;
  }
}

// ---------------------------------------------------------------------------
// Curator: curateAntiPlaybooks
// ---------------------------------------------------------------------------

/**
 * Filter a list of genome entries to anti-playbook entries suitable for
 * inject-time grounding. Applies:
 *   1. Tag filter: only entries tagged 'm235:anti-playbook'.
 *   2. Stale-archive: skip entries older than STALE_DAYS.
 *   3. Char cap: accumulate entries (most-recent first) until
 *      ANTI_PLAYBOOK_INJECT_CAP chars would be exceeded.
 *
 * Returns a subset of the input, safe to prepend to agent prompts.
 * Pure; never throws.
 */
export function curateAntiPlaybooks(entries: GenomeEntry[]): GenomeEntry[] {
  try {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const cutoffMs = Date.now() - STALE_DAYS * 86_400_000;

    // Filter to anti-playbook entries that are fresh.
    const fresh = entries.filter((e) => {
      if (!e.tags.includes(TAG)) return false;
      try {
        const ms = Date.parse(e.ts);
        if (!Number.isFinite(ms)) return true; // no valid ts — keep it
        return ms >= cutoffMs;
      } catch {
        return true;
      }
    });

    // Sort most-recent first.
    fresh.sort((a, b) => {
      const ta = Date.parse(a.ts) || 0;
      const tb = Date.parse(b.ts) || 0;
      return tb - ta;
    });

    // Accumulate up to ANTI_PLAYBOOK_INJECT_CAP chars.
    const result: GenomeEntry[] = [];
    let charCount = 0;
    for (const e of fresh) {
      const size = e.title.length + e.text.length;
      if (charCount + size > ANTI_PLAYBOOK_INJECT_CAP) break;
      charCount += size;
      result.push(e);
    }
    return result;
  } catch {
    return [];
  }
}
