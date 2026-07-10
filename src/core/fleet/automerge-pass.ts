/**
 * automerge-pass.ts — M48: the daemon's OPT-IN auto-merge pass.
 *
 * Kept DELIBERATELY OUT of daemon/loop.ts so the daemon file itself imports no
 * merge/apply/push primitive (the `daemon-no-primitive` safety contract stays
 * literally true: loop.ts only *triggers* this pass). All merge authority lives
 * behind the M47 gate (`autoMergeProposal`), which enforces, per proposal:
 *   frontier merge-authority model ∈ cfg.foundry.mergeAuthority
 *   AND risk class ≤ maxRisk AND full verification passes
 *   AND kill-switch off AND repo enrolled.
 *
 * DEFAULT OFF: a no-op unless cfg.foundry.autoMerge.enabled === true. Only
 * 'frontier'-tier proposals are even considered; the gate re-checks everything.
 * Never throws.
 *
 * M172: judge-then-merge loop.
 * Before merging, each PENDING proposal that has no recent frontier 'ship'
 * verdict + valid HMAC attestation (checked via the decisions ledger) is sent
 * to the frontier judge (judgeProposal from manager.ts). This closes the gap where
 * proposals accumulate in 'pending' state because the daily oversight cron is
 * the only place the judge ran.
 *
 * Cost guard: at most cfg.foundry.judgePerPass (default 5) unjudged proposals
 * are judged per pass. Proposals that already have a recent 'ship' verdict in
 * the decisions ledger are skipped (idempotent).
 *
 * Fail-closed: if the judge is unavailable the proposal stays unjudged and
 * autoMergeProposal will refuse it (no regression). If judgeProposal throws,
 * the error is swallowed and the pass continues.
 */

import type { AshlrConfig, Proposal } from '../types.js';
import { listProposals, setStatus, updateProposalField } from '../inbox/store.js';
import {
  autoMergeProposal,
  evaluateAutoMergeReadinessPreflight,
  isFrontierJudge,
  verifyProposal,
  verifyResultFromProposalResult,
  type AutoMergeResult,
} from '../inbox/merge.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { readDecisions, recordDecision } from './decisions-ledger.js';
import { judgeProposal, resolveFrontierJudgeClient, type ManagerVerdict } from './manager.js';
// M294: sign + record the attested 'judged'/ship ledger entry that the merge gate
// (hasRecentShipVerdict / evaluateVerificationGate) requires. Previously the
// automerge-pass judged 'ship' but never wrote this entry → every merge refused.
import { hashDiff, signJudgeAttestation, verifyJudgeAttestation } from '../foundry/provenance.js';
// M193: additive gate-modules (flag-gated, default OFF, only tighten)
import { redTeamProposal } from './red-team.js';
import { analyzeBlastRadius } from '../run/blast-radius.js';
import { checkSpecContract } from '../run/spec-contract.js';
// M212: proactive notifications (fire-and-forget, never throws, never alters control flow)
import { notifyFleetEvent } from '../comms/events.js';
// M214: fleet→pulse OTLP emit (fire-and-forget, flag-gated cfg.foundry.pulseEmit, default OFF)
import { emitMerge, emitJudgeVerdict } from '../integrations/fleet-pulse-emit.js';
import { estCostUsd } from '../run/budget.js';
// M235: recursive self-improvement write-back (fire-and-forget, gated cfg.foundry.selfImprove, default ON)
import { learnFromRejection } from './self-improve.js';
// M243: skill-library write-back (fire-and-forget, gated cfg.foundry.skillLibrary, default ON)
import { learnFromApplied } from './skill-library.js';
import { recordAgentAction } from './agent-action-ledger.js';
import { causalMetadataFromProposal } from '../learning/causal.js';

function hasVerificationCommandEvidence(result: Proposal['verifyResult']): boolean {
  return Array.isArray(result?.ran) && result.ran.length > 0;
}

export interface AutoMergePassResult {
  /** Proposals the gate was run against this pass (frontier + branch-eligible mid). */
  attempted: number;
  /** Of those, how many actually merged to main (frontier only). */
  merged: number;
  /** Of those, how many a MID-tier proposal applied to a branch/PR (M56). */
  branched: number;
  /** Of those, how many opened a remote host PR awaiting host-side merge. */
  handoffs: number;
  /** Per-proposal gate results (for observability/audit). */
  results: AutoMergeResult[];
	  /** M172: how many proposals were judged inline this pass. */
	  judged: number;
	  /** M172: configured maximum inline judge calls for this pass. */
	  judgePerPass: number;
	  /** M172: how many proposals were skipped by the judge-per-pass cap. */
	  judgeCapped: number;
	  /** M307: configured maximum verification-before-judge runs for this pass. */
	  verifyBeforeJudgePerPass: number;
	  /** M307: how many verification-before-judge runs executed this pass. */
	  verifyBeforeJudgeRan: number;
	  /** M307: how many proposals were skipped by the verification-before-judge cap. */
	  verifyBeforeJudgeCapped: number;
	  /** Display-only estimate for inline frontier judge calls; not measured spend. */
	  judgeEstimatedSpendUsd: number;
  /**
   * M193: proposals that passed the ship-verdict gate but were blocked by an
   * additive check (red-team / blast-radius / spec-contract). Per-skip detail
   * recorded here for observability.
   */
  skipped: Array<{ proposalId: string; check: string; reason: string }>;
  /**
   * M259: proposals auto-archived this pass (K non-ship verdicts reached).
   * These proposals are now 'rejected' and will not be re-judged.
   */
  autoArchived: number;
  /**
   * M259: proposals TTL-rejected this pass (older than proposalTtlDays).
   * These proposals are now 'rejected' and will not be re-judged.
   */
  ttlRejected: number;
  /**
   * M314: proposals rejected because they were produced from ephemeral Ashlr
   * temp-worktree regression goals. Reject-only; never merges.
   */
  invalidRejected: number;
}

// ---------------------------------------------------------------------------
// M172: judge-cache helpers
// ---------------------------------------------------------------------------

const JUDGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — mirrors Gate 7 staleness window
const JUDGE_ESTIMATE_TOKENS_IN = 4_000;
const JUDGE_ESTIMATE_TOKENS_OUT = 1_000;

function recordAutoMergeVerificationAgentAction(fields: {
  proposal: Proposal;
  check: string;
  phase: 'start' | 'finish';
  ok?: boolean;
  detail?: string;
  durationMs?: number;
  ranCount?: number;
}): void {
  const status =
    fields.phase === 'start'
      ? 'started'
      : fields.ok === true
        ? 'passed'
        : 'failed';
  const ts = new Date().toISOString();
  const causal = causalMetadataFromProposal(fields.proposal, {
    ts,
    learningSource: 'agent-action',
    labelBasis: 'verification-outcome',
  });
  recordAgentAction({
    schemaVersion: 1,
    ts,
    actor: 'verifier',
    kind: 'verification',
    outcome: fields.phase === 'start' ? 'unknown' : fields.ok === true ? 'verified' : 'failed',
    action: `auto-merge:${fields.check}-${fields.phase}`,
    summary: `${fields.check} ${status} for ${fields.proposal.title ?? fields.proposal.id}`,
    ...(typeof fields.proposal.repo === 'string' && fields.proposal.repo ? { repo: fields.proposal.repo } : {}),
    ...(causal.workItemId ? { itemId: causal.workItemId } : {}),
    ...(causal.workSource ? { source: causal.workSource } : {}),
    proposalId: fields.proposal.id,
    ...(causal.runId ? { runId: causal.runId } : {}),
    ...(causal.trajectoryId ? { trajectoryId: causal.trajectoryId } : {}),
    ...(causal.routeSnapshot ? { routeSnapshot: causal.routeSnapshot } : {}),
    ...(causal.runEventSummary ? { runEventSummary: causal.runEventSummary } : {}),
    ...(causal.evidenceOutcome ? { evidenceOutcome: causal.evidenceOutcome } : {}),
    learningSource: causal.learningSource ?? 'agent-action',
    labelBasis: causal.labelBasis ?? 'verification-outcome',
    ...(causal.routerPolicyVersion ? { routerPolicyVersion: causal.routerPolicyVersion } : {}),
    ...(causal.learningEpoch ? { learningEpoch: causal.learningEpoch } : {}),
    reason: fields.detail ?? fields.check,
    durationMs: fields.durationMs,
    tags: ['auto-merge', fields.check, fields.phase],
    counts: {
      ...(typeof fields.ranCount === 'number' ? { commands: fields.ranCount } : {}),
    },
  });
}

/**
 * Return true when the decisions ledger already contains a recent frontier
 * 'ship' verdict for this proposal with an HMAC-valid frontier judge attestation.
 * "Recent" = within the last hour (idempotent skip).
 *
 * Never throws.
 */
function hasRecentShipVerdict(proposal: Proposal): boolean {
  try {
    const sinceMs = Date.now() - JUDGE_CACHE_TTL_MS;
    const decisions = readDecisions({ proposalId: proposal.id, sinceMs });
    const diffHash = hashDiff(proposal.diff ?? '');
    return decisions.some((d) => {
      if (d.action !== 'judged' || d.verdict !== 'ship' || d.detail !== 'would-merge') return false;
      const judgeEngine = d.engine ?? d.model;
      if (!judgeEngine) return false;
      if (!isFrontierJudge(judgeEngine)) return false;
      const attestation = (d as unknown as Record<string, unknown>)['judgeAttestation'];
      if (typeof attestation !== 'string' || attestation.length === 0) return false;
      return verifyJudgeAttestation(attestation, {
        proposalId: proposal.id,
        judgeEngine,
        verdict: 'ship',
        diffHash,
      }).ok;
    });
  } catch {
    return false;
  }
}

function recordSafetySkip(
  out: AutoMergePassResult,
  proposalId: string,
  check: string,
  reason: string,
): void {
  out.results.push({ ok: false, merged: false, branched: false, reason });
  out.skipped.push({ proposalId, check, reason });
}

function incrementStuckOrArchive(
  proposal: Proposal,
  threshold: number,
  reason: string,
): { archived: boolean; stuckPassCount: number } {
  const current = (proposal as unknown as Record<string, unknown>)['stuckPassCount'];
  const stuckPassCount = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + 1;
  if (stuckPassCount >= threshold) {
    updateProposalField(proposal.id, { stuckPassCount });
    setStatus(proposal.id, 'rejected', undefined, reason);
    return { archived: true, stuckPassCount };
  }
  updateProposalField(proposal.id, { stuckPassCount });
  return { archived: false, stuckPassCount };
}

function knownFailedVerificationDetail(p: Proposal): string {
  return p.verifyResult?.failed?.filter(Boolean).join('; ') ?? '';
}

function referencesEphemeralAshlrPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/');
  return (
    normalized.includes('/.ashlr/sandboxes/') ||
    /\/\.ashlr\/tmp\/vwt-[^/\s"'`)]*/.test(normalized)
  );
}

function isEphemeralRegressionGoalProposal(p: Proposal): boolean {
  const rec = p as unknown as Record<string, unknown>;
  return (
    rec['workSource'] === 'goal' &&
    typeof p.title === 'string' &&
    p.title.includes('Fix regression in') &&
    referencesEphemeralAshlrPath(p.title)
  );
}

function errorDetail(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isRedTeamResult(value: unknown): value is { verdict: 'broken' | 'survived'; detail?: unknown } {
  return isRecord(value) && (value['verdict'] === 'broken' || value['verdict'] === 'survived');
}

function isBlastRadiusResult(
  value: unknown,
): value is { risk: 'none' | 'low' | 'medium' | 'high'; detail?: unknown } {
  return (
    isRecord(value) &&
    (value['risk'] === 'none' || value['risk'] === 'low' || value['risk'] === 'medium' || value['risk'] === 'high')
  );
}

function isSpecContractResult(value: unknown): value is { satisfied: boolean; detail?: unknown } {
  return isRecord(value) && typeof value['satisfied'] === 'boolean';
}

// ---------------------------------------------------------------------------
// Public: runAutoMergePass
// ---------------------------------------------------------------------------

/**
 * Run the M47 tiered-trust gate over PENDING proposals. No-op (returns zeros)
 * unless auto-merge is explicitly enabled. Honors the kill switch before and
 * during the pass. Never throws.
 *
 * M172 extension: before attempting to merge each eligible proposal, if it has
 * no recent frontier 'ship' verdict in the decisions ledger, run the frontier
 * judge on it (via judgeProposal from manager.ts). The judge records a
 * decisions-ledger entry + HMAC attestation (on mergeable 'ship'), enabling
 * autoMergeProposal's verification gate to proceed. Only proposals whose judge
 * verdict is `ship` with `wouldMerge === true` are forwarded to autoMergeProposal.
 *
 * Bounds: at most cfg.foundry.judgePerPass (default 5) unjudged proposals are
 * judged per pass. Already-judged proposals (cache hit) do NOT count against
 * the cap.
 */
export async function runAutoMergePass(cfg: AshlrConfig): Promise<AutoMergePassResult> {
  const out: AutoMergePassResult = {
    attempted: 0,
    merged: 0,
    branched: 0,
    handoffs: 0,
	    results: [],
	    judged: 0,
	    judgePerPass: 0,
	    judgeCapped: 0,
	    verifyBeforeJudgePerPass: 0,
	    verifyBeforeJudgeRan: 0,
	    verifyBeforeJudgeCapped: 0,
	    judgeEstimatedSpendUsd: 0,
	    skipped: [],
	    autoArchived: 0,
    ttlRejected: 0,
    invalidRejected: 0,
  };
  if (cfg.foundry?.autoMerge?.enabled !== true) return out;
  if (killSwitchOn()) return out;

  let pending: Proposal[];
  try {
    pending = listProposals({ status: 'pending' });
  } catch {
    return out;
  }

  // M259: resolve drain config from foundry (all additive — only add reject paths).
  const foundry = cfg.foundry as Record<string, unknown> | undefined;

  // judgePerPass: default 8 (raised from 5 to drain backlog faster — M259).
  const judgePerPass =
    typeof foundry?.['judgePerPass'] === 'number' && foundry['judgePerPass'] > 0
      ? (foundry['judgePerPass'] as number)
      : 8;

  const autoMergeCfg = foundry?.['autoMerge'] as Record<string, unknown> | undefined;
	  const verifyBeforeJudgePerPass =
	    typeof autoMergeCfg?.['verifyBeforeJudgePerPass'] === 'number' &&
	    (autoMergeCfg['verifyBeforeJudgePerPass'] as number) >= 0
	      ? Math.floor(autoMergeCfg['verifyBeforeJudgePerPass'] as number)
	      : judgePerPass;
	  out.judgePerPass = judgePerPass;
	  out.verifyBeforeJudgePerPass = verifyBeforeJudgePerPass;
	  let verifyBeforeJudgeUsed = 0;

  // autoArchiveAfterRejects: default 3 — archive after K non-ship verdicts.
  const autoArchiveAfterRejects =
    typeof foundry?.['autoArchiveAfterRejects'] === 'number' && (foundry['autoArchiveAfterRejects'] as number) > 0
      ? (foundry['autoArchiveAfterRejects'] as number)
      : 3;

  // proposalTtlDays: default 7 — auto-reject proposals older than N days.
  const proposalTtlDays =
    typeof foundry?.['proposalTtlDays'] === 'number'
      ? (foundry['proposalTtlDays'] as number)
      : 7;

  // M263: sort oldest-first before the judge loop so the stalest proposals
  // drain first and are never perpetually starved by a most-recent-first queue.
  // listProposals returns most-recent-first (for UI); the drain loop needs the
  // inverse so the oldest pending entry is always the first to be judged/counted.
  // SAFETY: sort is in-place on the local array only — no store mutation.
  pending.sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return 0;
  });

  // M314: reject stale proposals generated from goals that targeted ephemeral
  // Ashlr execution worktrees. Those goals cannot be acted on after teardown,
  // and letting their proposals remain pending pins the fleet in verify-only.
  for (const p of pending) {
    try {
      if (!isEphemeralRegressionGoalProposal(p)) continue;
      const reason = 'auto-rejected: proposal came from an ephemeral Ashlr temp-worktree regression goal';
      setStatus(p.id, 'rejected', undefined, reason);
      out.invalidRejected++;
      out.skipped.push({ proposalId: p.id, check: 'ephemeral-regression-goal', reason });
      out.results.push({ ok: false, merged: false, branched: false, reason });
    } catch {
      // Best-effort — invalid-goal rejection never disrupts the pass.
    }
  }
  if (out.invalidRejected > 0) {
    try {
      pending = listProposals({ status: 'pending' });
    } catch {
      pending = pending.filter((p) => !isEphemeralRegressionGoalProposal(p));
    }
    pending = pending.filter((p) => !isEphemeralRegressionGoalProposal(p));
  }

  // M259: TTL pre-pass — reject stale proposals before spending any judge calls.
  // Belt-and-suspenders: runs independently of the judge loop.
  // SAFETY: only adds 'rejected' status — NEVER merges anything.
  if (proposalTtlDays > 0) {
    const ttlCutoffMs = Date.now() - proposalTtlDays * 24 * 60 * 60 * 1000;
    for (const p of pending) {
      try {
        const createdMs = new Date(p.createdAt).getTime();
        if (Number.isFinite(createdMs) && createdMs < ttlCutoffMs) {
          setStatus(
            p.id,
            'rejected',
            undefined,
            `auto-rejected: proposal older than ${proposalTtlDays} days (TTL)`,
          );
          out.ttlRejected++;
        }
      } catch {
        // Best-effort — TTL reject never disrupts the pass.
      }
    }
    // Re-fetch pending after TTL culling so the judge loop skips stale proposals.
    if (out.ttlRejected > 0) {
      try {
        pending = listProposals({ status: 'pending' });
      } catch {
        // If re-fetch fails, continue with the original list. Downstream store
        // reads and merge gates still enforce the rejected status fail-closed.
      }
    }
  }

  // Lazily resolve judge client once per pass (avoid re-calling getActiveClient
  // for every proposal). null = judge unavailable → fail-closed (proposals stay unjudged).
  let judgeClient: { complete: (system: string, user: string) => Promise<string>; model: string } | null | undefined =
    undefined; // undefined = not yet resolved; null = unavailable (fail-closed)

  for (const p of pending) {
    if (killSwitchOn()) break;
    // Pre-filter: decide whether this proposal is eligible to be judged/merged
    // this pass. The decision is trust-basis-aware (M175).
    //
    // trustBasis='verification' (M153/M175): ANY tier may be judged. The full
    // verification gate (frontier-judge-ship + verifyResult + risk + scope +
    // EDV + signed attestation) enforces the safety bar — the GATE is the
    // trust, not the producer's tier.  We do NOT skip local/mid proposals here;
    // autoMergeProposal will refuse them if any criterion is unmet.
    //
    // trustBasis='evidence': ANY tier may proceed to the deterministic evidence
    // gate after verification. This mode intentionally skips frontier judging.
    //
    // trustBasis='tier' or absent (default / M51): frontier proposals are
    // main-merge-eligible; mid proposals are branch/PR-eligible ONLY when the
    // separate default-off midToBranch flag is on; local/undefined are skipped.
    // This path is BYTE-IDENTICAL to pre-M175 behaviour — M51 is untouched.
    const trustBasis = (cfg.foundry as Record<string, unknown> | undefined)
      ?.['autoMerge'] as Record<string, unknown> | undefined;
    const trustMode = trustBasis?.['trustBasis'] as string | undefined;
    const isVerificationMode = trustMode === 'verification';
    const isEvidenceMode = trustMode === 'evidence';
    const isEvidenceBackedMode = isVerificationMode || isEvidenceMode;
    const managerGateEnabled = trustBasis?.['managerGate'] === true;
    const shouldJudgeBeforeMerge = isVerificationMode || managerGateEnabled;

    if (!isEvidenceBackedMode) {
      // Tier-mode pre-filter (M51 — unchanged).
      const midEligible = cfg.foundry?.autoMerge?.midToBranch === true && p.engineTier === 'mid';
      if (p.engineTier !== 'frontier' && !midEligible) continue;
    }
    // In evidence-backed modes: no tier pre-filter — the full gate is authority.

    // Cheap static readiness gate before spending judge/merge resources.
    // autoMergeProposal remains authoritative; this only avoids judging records
    // that already fail immutable, pure, no-I/O merge prerequisites.
    const readiness = evaluateAutoMergeReadinessPreflight(p, cfg);
    if (!readiness.ready) {
      const advisorySuffix =
        readiness.advisories.length > 0
          ? `; advisories: ${readiness.advisories.join('; ')}`
          : '';
      const reason = `readiness preflight: ${readiness.reason ?? 'not ready'}${advisorySuffix}`;
      out.results.push({ ok: false, merged: false, branched: false, reason });
      out.skipped.push({ proposalId: p.id, check: 'readiness-preflight', reason });
      if (readiness.permanent === true) {
        const priorStuck = (p as unknown as Record<string, unknown>)['stuckPassCount'];
        const nextStuck = (typeof priorStuck === 'number' && Number.isFinite(priorStuck) ? priorStuck : 0) + 1;
        const failed = knownFailedVerificationDetail(p);
        const detail = p.verifyResult?.passed === false && failed
          ? `${readiness.reason ?? 'permanent readiness blocker'} (${failed})`
          : (readiness.reason ?? 'permanent readiness blocker');
        const drain = incrementStuckOrArchive(
          p,
          autoArchiveAfterRejects,
          `auto-drained: permanent readiness blocker persisted for ${nextStuck} pass(es): ${detail}`,
        );
        if (drain.archived) out.autoArchived++;
      }
      continue;
    }

    if (isEvidenceBackedMode) {
      const verifyCheck = isEvidenceMode ? 'verify-before-merge' : 'verify-before-judge';
      const verifyResultIsReusable =
        p.verifyResult?.passed === true &&
        (
          !isEvidenceMode ||
          (
            typeof p.verifyResult.baseBranch === 'string' &&
            p.verifyResult.baseBranch.length > 0 &&
            typeof p.verifyResult.baseHead === 'string' &&
            p.verifyResult.baseHead.length > 0 &&
            p.verifyResult.diffHash === hashDiff(p.diff ?? '') &&
            hasVerificationCommandEvidence(p.verifyResult)
          )
        );
      if (p.verifyResult?.passed === false) {
        const failed = p.verifyResult.failed?.filter(Boolean).join('; ');
        const reason = `${verifyCheck}: known failed verification${failed ? `: ${failed}` : ''}`;
        out.results.push({ ok: false, merged: false, branched: false, reason });
        out.skipped.push({ proposalId: p.id, check: verifyCheck, reason });
        continue;
      }

      if (!verifyResultIsReusable) {
        if (verifyBeforeJudgeUsed >= verifyBeforeJudgePerPass) {
          const reason = `${verifyCheck}: cap reached (${verifyBeforeJudgePerPass}/pass)`;
          out.verifyBeforeJudgeCapped++;
          out.skipped.push({ proposalId: p.id, check: `${verifyCheck}-cap`, reason });
          continue;
        }
        verifyBeforeJudgeUsed++;
        out.verifyBeforeJudgeRan++;

        const verifyStartedAt = Date.now();
        recordAutoMergeVerificationAgentAction({
          proposal: p,
          check: verifyCheck,
          phase: 'start',
        });
        let verify: Awaited<ReturnType<typeof verifyProposal>>;
        try {
          verify = await verifyProposal(p, cfg);
        } catch (err) {
          recordAutoMergeVerificationAgentAction({
            proposal: p,
            check: verifyCheck,
            phase: 'finish',
            ok: false,
            detail: (err as Error)?.message ?? String(err),
            durationMs: Date.now() - verifyStartedAt,
          });
          throw err;
        }
        recordAutoMergeVerificationAgentAction({
          proposal: p,
          check: verifyCheck,
          phase: 'finish',
          ok: verify.ok,
          detail: verify.detail,
          durationMs: Date.now() - verifyStartedAt,
          ranCount: verify.ran.length,
        });
        const verifyResult = verifyResultFromProposalResult(
          verify,
          'auto-merge-preflight',
          new Date().toISOString(),
          hashDiff(p.diff ?? ''),
        );
        try {
          updateProposalField(p.id, { verifyResult });
        } catch {
          // Best-effort evidence write. The merge gate still re-checks/fails closed.
        }
        p.verifyResult = verifyResult;

        if (!verify.ok) {
          const reason = `${verifyCheck}: verification failed: ${verify.detail}`;
          out.results.push({ ok: false, merged: false, branched: false, reason });
          out.skipped.push({ proposalId: p.id, check: verifyCheck, reason });
          continue;
        }
      }
    }

    // ── M172: judge-then-merge ─────────────────────────────────────────────
    // Judge in explicit judge-backed modes only: verification trust or
    // managerGate. Tier/evidence modes proceed to autoMergeProposal(), whose
    // merge gate remains authoritative for verification, risk/scope, provenance,
    // enrollment, kill switch, self-target, and host/local merge safety.
    if (shouldJudgeBeforeMerge && !hasRecentShipVerdict(p)) {

      // Check per-pass cap before spending a frontier judge call.
      if (out.judged >= judgePerPass) {
        out.judgeCapped++;
        // M271: CHEAP DRAIN PATH — proposals already seen as non-ship (judgeNonShipCount>=1)
        // but capped out of judging this pass accumulate a stuckPassCount WITHOUT spending
        // a fresh judge call. When stuckPassCount reaches autoArchiveAfterRejects they are
        // archived (status→rejected). This drains the queue over K cheap passes.
        // SAFETY: NEVER archives a proposal that might receive a ship verdict next pass —
        // only proposals that have already been judged non-ship at least once qualify.
        // NEVER hard-deletes (status change only). NEVER weakens the merge gate.
        try {
          const priorNonShip = (p as unknown as Record<string, unknown>)['judgeNonShipCount'] as number | undefined;
          if (typeof priorNonShip === 'number' && priorNonShip >= 1) {
            const newStuck = ((p as unknown as Record<string, unknown>)['stuckPassCount'] as number ?? 0) + 1;
            if (newStuck >= autoArchiveAfterRejects) {
              setStatus(
                p.id,
                'rejected',
                undefined,
                `M271 drained: persistently non-ship/non-mergeable (stuck ${newStuck} pass(es), judgeNonShipCount=${priorNonShip})`,
              );
              out.autoArchived++;
            } else {
              updateProposalField(p.id, { stuckPassCount: newStuck });
            }
          }
        } catch {
          // Best-effort — drain failure never disrupts the pass.
        }
        continue; // Skip: backlog will be processed in subsequent pass ticks.
      }

      // Lazily resolve the judge client.
      if (judgeClient === undefined) {
        judgeClient = resolveFrontierJudgeClient(cfg);
      }

      if (judgeClient !== null) {
        let verdict: ManagerVerdict | null = null;
        try {
          verdict = await judgeProposal(p, cfg, judgeClient);
        } catch {
          // judgeProposal should never throw, but be defensive.
          verdict = null;
        }
	        out.judged++;
	        out.judgeEstimatedSpendUsd += estCostUsd(
	          judgeClient.model,
	          JUDGE_ESTIMATE_TOKENS_IN,
	          JUDGE_ESTIMATE_TOKENS_OUT,
	        );
	        // M214: fire-and-forget judge-verdict emit — additive, never throws, no control-flow change.
        void emitJudgeVerdict(cfg, p.id, verdict?.verdict ?? 'null', p.repo, p.engineTier).catch(() => {});

        // Only proposals the judge would actually merge proceed to the merge gate.
        // 'ship' with wouldMerge=false is non-mergeable and must not create
        // durable merge authority.
        // SAFETY: this ONLY adds a reject path — it can NEVER cause a merge.
        if (!verdict || verdict.verdict !== 'ship' || verdict.wouldMerge !== true) {
          // M235: fire-and-forget self-improvement write-back — additive, never throws, no control-flow change.
          try {
            learnFromRejection(
              p.id,
              p.title ?? '',
              verdict?.verdict ?? 'review',
              (verdict as unknown as Record<string, unknown>)?.['rationale'] as string ?? '',
              cfg,
            );
          } catch { /* learnFromRejection never throws; defensive */ }

          // M259: track non-mergeable count + auto-archive when threshold reached.
          // `ship` + `wouldMerge=false` is intentionally non-mergeable.
          try {
            const newCount = ((p as unknown as Record<string, unknown>)['judgeNonShipCount'] as number ?? 0) + 1;
            if (newCount >= autoArchiveAfterRejects) {
              // Auto-archive: mark as rejected so it is no longer re-judged.
              // Status change only — never hard-deletes. Strictly safer: the
              // merge gate (autoMergeProposal) is never reached for this proposal.
              setStatus(
                p.id,
                'rejected',
                undefined,
                `auto-archived: judge returned non-mergeable verdict ${newCount} time(s) (threshold: ${autoArchiveAfterRejects})`,
              );
              out.autoArchived++;
            } else {
              // Below threshold: persist the updated count so next tick picks up.
              updateProposalField(p.id, { judgeNonShipCount: newCount });
            }
          } catch {
            // Auto-archive is best-effort — never disrupts the pass.
          }
          continue;
        }
        // Reset judgeNonShipCount on a ship verdict (belt-and-suspenders).
        try {
          const existingCount = (p as unknown as Record<string, unknown>)['judgeNonShipCount'] as number | undefined;
          if (existingCount !== undefined && existingCount > 0) {
            updateProposalField(p.id, { judgeNonShipCount: 0 });
          }
        } catch {
          // Best-effort — reset failure never blocks the merge path.
        }

        // M294: record the attested 'judged'/ship ledger entry that the merge gate
        // (hasRecentShipVerdict / evaluateVerificationGate criterion 1) requires.
        // The automerge-pass previously judged 'ship' but NEVER wrote this entry —
        // so autoMergeProposal always refused with "no 'judged' decision with
        // verdict='ship' found", meaning NO proposal could ever auto-merge. Mirrors
        // runManager's signing/recording (manager.ts). judgeClient is non-null here.
        try {
          const judgeEngine = judgeClient.model;
          let judgeAttestation: string | undefined;
          if (isFrontierJudge(judgeEngine)) {
            try {
              const diffHash = hashDiff(p.diff ?? '');
              judgeAttestation = signJudgeAttestation({
                proposalId: p.id,
                judgeEngine,
                verdict: 'ship',
                diffHash,
              });
            } catch {
              // Signing failure → no attestation → gate fails-closed (refuses), never a bad merge.
              judgeAttestation = undefined;
            }
          }
          const ts = new Date().toISOString();
          recordDecision({
            ts,
            proposalId: p.id,
            ...causalMetadataFromProposal(p, {
              ts,
              learningSource: 'decision-ledger',
              labelBasis: 'judge-verdict',
            }),
            action: 'judged',
            engine: judgeEngine,
            model: judgeEngine,
            verdict: 'ship',
            reason: verdict.rationale ?? '',
            detail: verdict.wouldMerge ? 'would-merge' : '',
            ...(judgeAttestation !== undefined ? { judgeAttestation } : {}),
          });
        } catch {
          // Best-effort — a record failure means the gate fails-closed (no merge), never a bad merge.
        }
      } else {
        // No judge available → fail-closed: skip this proposal for merging.
        // M273: when no judge client is available AND the proposal has already
        // been seen as non-ship at least once (judgeNonShipCount>=1), apply the
        // same M271-style cheap drain so the proposal doesn't idle forever.
        // SAFETY: never accrues stuckPassCount for fresh (never-judged) proposals
        // — only proposals that have already received ≥1 non-ship verdict.
        // NEVER archives or merges a proposal that might receive a ship verdict
        // if a judge becomes available — the stuckPassCount path is additive-only.
        try {
          const priorNonShip = (p as unknown as Record<string, unknown>)['judgeNonShipCount'] as number | undefined;
          if (typeof priorNonShip === 'number' && priorNonShip >= 1) {
            const newStuck = ((p as unknown as Record<string, unknown>)['stuckPassCount'] as number ?? 0) + 1;
            if (newStuck >= autoArchiveAfterRejects) {
              setStatus(
                p.id,
                'rejected',
                undefined,
                `M273 drained: judge unavailable, persistently non-ship (stuck ${newStuck} pass(es), judgeNonShipCount=${priorNonShip})`,
              );
              out.autoArchived++;
            } else {
              updateProposalField(p.id, { stuckPassCount: newStuck });
            }
          }
        } catch {
          // Best-effort — drain failure never disrupts the pass.
        }
        continue;
      }
    }
    // ── End M172 ──────────────────────────────────────────────────────────

    out.attempted++;

    // ── M193: additive gate-checks (flag-gated, default OFF, only tighten) ──
    // Each check runs only when its feature flag is enabled. A check that
    // throws or returns an untrustworthy shape fails closed: the proposal is
    // skipped (stays pending) and the reason is recorded. These checks NEVER
    // cause a merge that wouldn't happen otherwise.

    // M191 — Red-team critic
    if ((foundry as Record<string, unknown> | undefined)?.['redTeam'] === true) {
      let shouldSkip = false;
      try {
        const rt = await redTeamProposal(p, cfg);
        if (!isRedTeamResult(rt)) {
          shouldSkip = true;
          recordSafetySkip(out, p.id, 'red-team', 'red-team check produced an untrustworthy result');
        } else if (rt.verdict === 'broken') {
          shouldSkip = true;
          const detail = typeof rt.detail === 'string' && rt.detail ? rt.detail : 'red-team check failed';
          recordSafetySkip(out, p.id, 'red-team', detail);
        }
      } catch (err) {
        shouldSkip = true;
        recordSafetySkip(out, p.id, 'red-team', `red-team check failed closed: ${errorDetail(err)}`);
      }
      if (shouldSkip) continue;
    }

    // M188 — Blast-radius
    if ((foundry as Record<string, unknown> | undefined)?.['blastRadius'] === true) {
      let shouldSkip = false;
      try {
        const changedFiles = p.diff
          ? p.diff
              .split('\n')
              .filter((l: string) => l.startsWith('+++ '))
              .map((l: string) => l.slice(4).replace(/^[ab]\//, '').trim())
              .filter((f: string) => f && f !== '/dev/null')
          : [];
        const br = await analyzeBlastRadius(
          { repo: p.repo ?? '', changedFiles },
          cfg as unknown as import('../run/blast-radius.js').BlastRadiusConfig,
        );
        if (!isBlastRadiusResult(br)) {
          shouldSkip = true;
          recordSafetySkip(out, p.id, 'blast-radius', 'blast-radius check produced an untrustworthy result');
        } else if (br.risk === 'high') {
          shouldSkip = true;
          const detail = typeof br.detail === 'string' && br.detail ? br.detail : 'blast-radius risk is high';
          recordSafetySkip(out, p.id, 'blast-radius', detail);
        }
      } catch (err) {
        shouldSkip = true;
        recordSafetySkip(out, p.id, 'blast-radius', `blast-radius check failed closed: ${errorDetail(err)}`);
      }
      if (shouldSkip) continue;
    }

    // M190 — Spec-contract
    if ((foundry as Record<string, unknown> | undefined)?.['specContract'] === true) {
      const specId = (p as unknown as Record<string, unknown>)['specId'];
      if (specId && typeof specId === 'string') {
        let shouldSkip = false;
        try {
          // Lazily load the spec body so this path costs nothing when no spec is present.
          let specInput: import('../run/spec-contract.js').SpecInput = null;
          try {
            const { loadSpec } = await import('../spec/spec-store.js');
            const loaded = loadSpec(specId, p.repo ?? undefined);
            if (loaded) specInput = { meta: loaded.meta, body: loaded.body };
          } catch {
            shouldSkip = true;
            recordSafetySkip(out, p.id, 'spec-contract', `spec-contract could not load spec '${specId}'`);
          }
          if (!shouldSkip && specInput === null) {
            shouldSkip = true;
            recordSafetySkip(out, p.id, 'spec-contract', `spec-contract could not load spec '${specId}'`);
          }
          if (!shouldSkip && specInput !== null) {
            const sc = await checkSpecContract(
              { spec: specInput, repoDir: p.repo ?? undefined, diff: p.diff },
              cfg,
            );
            if (!isSpecContractResult(sc)) {
              shouldSkip = true;
              recordSafetySkip(out, p.id, 'spec-contract', 'spec-contract check produced an untrustworthy result');
            } else if (!sc.satisfied) {
              shouldSkip = true;
              const detail =
                isRecord(sc.detail) && typeof sc.detail['reason'] === 'string'
                  ? sc.detail['reason']
                  : 'spec contract unsatisfied';
              recordSafetySkip(out, p.id, 'spec-contract', detail);
            }
          }
        } catch (err) {
          shouldSkip = true;
          recordSafetySkip(out, p.id, 'spec-contract', `spec-contract check failed closed: ${errorDetail(err)}`);
        }
        if (shouldSkip) continue;
      }
    }
    // ── End M193 ──────────────────────────────────────────────────────────

    try {
      const res = await autoMergeProposal(p.id, cfg);
      out.results.push(res);
      if (res.merged) {
        out.merged++;
        // M212: fire-and-forget merge notification — additive, never throws, no control-flow change.
        notifyFleetEvent('merge', { repo: p.repo ?? undefined, title: p.title, engine: p.engineTier }, cfg).catch(() => {});
        // M214: fire-and-forget merge emit to Pulse OTLP — additive, never throws, no control-flow change.
        void emitMerge(cfg, p.id, p.repo, p.engineTier).catch(() => {});
        // M241: fire-and-forget fleet event-bus emit — additive, never throws, no control-flow change.
        void import('./event-bus.js').then(({ emit }) => emit('merge:shipped', { proposalId: p.id, title: p.title, repo: p.repo ?? undefined, engineTier: p.engineTier }, cfg)).catch(() => {});
        // M243: fire-and-forget skill-library write-back — additive, never throws, no control-flow change.
        void learnFromApplied(p, cfg);
      }
      if (res.branched) out.branched++;
      if (res.handoff) out.handoffs++;
    } catch {
      // autoMergeProposal never throws by contract; defensive only.
    }
  }
  return out;
}
