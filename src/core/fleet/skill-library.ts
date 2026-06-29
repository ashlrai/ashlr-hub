/**
 * skill-library.ts — M243: positive skill-library write-back.
 *
 * Closes the learning loop on the SUCCESS path: when a proposal is applied
 * AND the judge verdict was 'ship' AND tests green, extract a reusable
 * WORKFLOW recipe from the proposal and persist it as a genome hub entry so
 * FUTURE agent runs have positive grounding for proven patterns.
 *
 * Mirrors M235 (self-improve.ts) structurally — same safety invariants, same
 * fire-and-forget contract, complementary polarity (success vs. rejection).
 *
 * SAFETY INVARIANTS:
 *  - WRITE TARGET: genome hub + decisions ledger ONLY. Never touches
 *    merge.ts gate logic, sandbox confinement, scope-cap, M54, or any
 *    policy file.
 *  - FIRE-AND-FORGET: learnFromApplied() never throws, never awaits
 *    anything on the critical path. All I/O is wrapped in try/catch.
 *  - GATED: every code path checks cfg.foundry?.skillLibrary !== false
 *    (default ON). When the flag is explicitly false the function returns
 *    immediately — byte-identical to having no call at all.
 *  - SHIP-ONLY: only 'ship' verdict + applied+merged proposals write a skill.
 *    Non-ship verdicts use M235 (self-improve.ts). Explicit false-flag = no-op.
 *  - ADDITIVE: the genome entry is informational grounding for future runs.
 *    It is NOT an execution directive; it does not alter the merge gate,
 *    the judge, or any safety policy.
 *  - CURATOR CAP: genome entries written by this module carry the tag
 *    'm243:skill'. curateSkills() trims entries older than STALE_DAYS and
 *    caps total injected chars at SKILL_INJECT_CAP so the genome never
 *    injects stale noise.
 *  - TELEMETRY: a usage counter is appended to the decisions ledger under
 *    action 'skill-library:written' for observability (no PII, no secrets).
 *  - AWM/Voyager principle: the captured workflow is an ABSTRACTED recipe
 *    (task-class + plan→do→verify pattern + engine), NOT the raw diff verbatim.
 */

import { appendHubEntry } from '../genome/store.js';
import { recordDecision } from './decisions-ledger.js';
import type { AshlrConfig, GenomeEntry, Proposal } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Skill genome entries older than this many days are skipped during
 *  inject-time curation (stale-archive cap). */
const STALE_DAYS = 90;

/** Hard cap on total characters injected from skill entries per run. */
export const SKILL_INJECT_CAP = 800;

/** Tag prefix for all genome entries written by this module. */
const TAG = 'm243:skill';

// ---------------------------------------------------------------------------
// Workflow distillation (pure, deterministic, no LLM)
// ---------------------------------------------------------------------------

/**
 * Derive a short reusable WORKFLOW recipe from a shipped proposal.
 *
 * AWM/Voyager principle: produce an ABSTRACTED workflow keyed by task
 * description (plan → do → verify pattern + which engine), NOT the raw diff
 * verbatim. This gives future agents positive grounding: "here is a proven
 * recipe for this class of task."
 *
 * Pure; never throws.
 */
export function distillWorkflow(proposal: Proposal): string {
  const safeTitle = (proposal.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '(untitled)';
  const safeSummary = (proposal.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const engine = (proposal.engineModel ?? proposal.engineTier ?? 'unknown').toString().slice(0, 40);
  const repo = (proposal.repo ?? '').toString().slice(0, 60) || '(no repo)';

  // Derive a task-class label from the proposal title heuristically.
  const taskClass = deriveTaskClass(safeTitle);

  const summaryPart = safeSummary
    ? `\n\nWhat was done: ${safeSummary}`
    : '';

  return (
    `Skill: proven workflow for "${safeTitle}"\n\n` +
    `Task class: ${taskClass}\n` +
    `Engine/model: ${engine}\n` +
    `Repo: ${repo}` +
    summaryPart +
    `\n\nPattern (plan→do→verify): this proposal was judged 'ship', applied, ` +
    `and passed verification. Future agents: if your task matches this pattern, ` +
    `this recipe is a proven baseline — adapt, don't just copy the diff.`
  );
}

/**
 * Heuristically derive a short task-class label from a proposal title.
 * Pure; never throws; returns a safe default on any input.
 */
function deriveTaskClass(title: string): string {
  const t = title.toLowerCase();
  if (/\b(fix|bug|patch|crash|error|exception|broken)\b/.test(t)) return 'bug-fix';
  if (/\b(add|implement|feature|support|new)\b/.test(t)) return 'feature-add';
  if (/\b(refactor|rename|move|extract|clean|tidy)\b/.test(t)) return 'refactor';
  if (/\b(test|spec|coverage|vitest|jest)\b/.test(t)) return 'test-improvement';
  if (/\b(dep|dependency|bump|upgrade|update.*package)\b/.test(t)) return 'dependency-update';
  if (/\b(doc|readme|comment|jsdoc|changelog)\b/.test(t)) return 'documentation';
  if (/\b(perf|optim|speed|latency|throughput)\b/.test(t)) return 'performance';
  if (/\b(security|vuln|cve|audit)\b/.test(t)) return 'security';
  if (/\b(type|typescript|lint|eslint)\b/.test(t)) return 'type-lint';
  return 'general';
}

// ---------------------------------------------------------------------------
// Public: learnFromApplied
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget skill write-back.
 *
 * Called AFTER a proposal is successfully merged (in automerge-pass.ts, after
 * res.merged++ in the success branch). Writes:
 *   1. A genome hub entry (skill workflow) tagged 'm243:skill'.
 *   2. A decisions-ledger entry for telemetry/observability.
 *
 * NEVER THROWS. NEVER BLOCKS (all I/O is synchronous JSONL append behind
 * try/catch). Gated on cfg.foundry?.skillLibrary !== false (default ON).
 *
 * @param proposal  The applied Proposal (must have verdict 'ship' and be merged).
 * @param cfg  Fleet config.
 */
export function learnFromApplied(proposal: Proposal, cfg: AshlrConfig): void {
  // Gate: default ON; explicit false = no-op (byte-identical to no call).
  try {
    const foundry = cfg.foundry as Record<string, unknown> | undefined;
    if (foundry?.['skillLibrary'] === false) return;
  } catch {
    return;
  }

  // Derive and write the workflow skill.
  try {
    const workflow = distillWorkflow(proposal);
    const safeTitle = (proposal.title ?? '').slice(0, 60) || 'untitled';
    const title = `Skill: ${(proposal.engineTier ?? 'unknown')} — ${safeTitle}`;

    appendHubEntry({
      title,
      text: workflow,
      tags: [TAG, `engine:${(proposal.engineTier ?? 'unknown').toString().slice(0, 24)}`, `proposal:${proposal.id.slice(0, 24)}`],
      hubOnly: true,
    });
  } catch {
    // appendHubEntry never throws by contract; guard defensively.
  }

  // Telemetry: record to decisions ledger (action 'skill-library:written').
  try {
    recordDecision({
      ts: new Date().toISOString(),
      proposalId: proposal.id,
      action: 'skill-library:written' as Parameters<typeof recordDecision>[0]['action'],
      detail: `engine=${(proposal.engineTier ?? 'unknown')}`,
      repo: proposal.repo ?? '',
      engine: proposal.engineModel ?? '',
      model: '',
    } as Parameters<typeof recordDecision>[0]);
  } catch {
    // Ledger write is best-effort observability only.
  }
}

// ---------------------------------------------------------------------------
// Curator: curateSkills
// ---------------------------------------------------------------------------

/**
 * Filter a list of genome entries to skill entries suitable for inject-time
 * grounding. Applies:
 *   1. Tag filter: only entries tagged 'm243:skill'.
 *   2. Stale-archive: skip entries older than STALE_DAYS.
 *   3. Char cap: accumulate entries (most-recent first) until
 *      SKILL_INJECT_CAP chars would be exceeded.
 *
 * Returns a subset of the input, safe to prepend to agent prompts.
 * Pure; never throws.
 */
export function curateSkills(entries: GenomeEntry[]): GenomeEntry[] {
  try {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const cutoffMs = Date.now() - STALE_DAYS * 86_400_000;

    // Filter to skill entries that are fresh.
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

    // Accumulate up to SKILL_INJECT_CAP chars.
    const result: GenomeEntry[] = [];
    let charCount = 0;
    for (const e of fresh) {
      const size = e.title.length + e.text.length;
      if (charCount + size > SKILL_INJECT_CAP) break;
      charCount += size;
      result.push(e);
    }
    return result;
  } catch {
    return [];
  }
}
