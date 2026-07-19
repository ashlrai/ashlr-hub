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
import { recordDecision } from './decisions-ledger.js';
import type { AshlrConfig, GenomeEntry } from '../types.js';

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
