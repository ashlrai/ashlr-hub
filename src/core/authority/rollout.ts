/**
 * The rollout ladder — V3.10 Track B (unit B-U1), SPEC-310B addendum §1.
 *
 * One Touch ID signs the WHOLE ramp (StandingGrantV1.rollout.stages). The
 * daemon climbs it by itself:
 *   - ADVANCE one stage when every criterion of the current stage is met,
 *     evaluated only from ledger rows written while that stage was current
 *     (`rollout:advanced`);
 *   - REGRESS one stage on a breach — any sandbox violation, any reserve
 *     breach, or a revert rate above the stage's maximum (`rollout:regressed`).
 *     A breach on the first rung re-enters it: the evidence window restarts,
 *     there is nowhere lower to go;
 *   - never past the last signed stage, and nothing (not the Leader, not
 *     config) can skip or edit a stage — there is no API that could.
 *
 * Evidence (all counted after the row that entered the stage):
 *   merges       landed `merge:landed` rows — or, in a stage where no repo is
 *                at `merge` (shadow), complete `gate:would-merge` digests;
 *   green %      post-merge verdicts for THIS stage's merges; while any of
 *                them is still being watched the stage does not advance
 *                (a pending watch is never counted as green);
 *   revert rate  `revert:landed` / merges (reverts with no merges = 100%);
 *   hours        since the stage was entered.
 *
 * `evaluateRollout` is PURE; `stepRolloutUnderLock` is the only writer and
 * runs inside the ledger lock so two ticks can never both advance.
 */
import type { LedgerAuthorityIndex, LedgerEvidenceRow, LedgerTransaction } from './ledger.js';
import type { RolloutEvidence, RolloutProgress, StandingGrantV1 } from './types.js';

export interface RolloutPositionInternal {
  stageIndex: number;
  stageId: string;
  enteredAt: string;
  entrySeq: number;
}

/**
 * Where `grant` stands on its ladder according to the ledger: its latest
 * rollout row, or its first stage since acceptance. null when the grant was
 * never accepted or the ledger names a stage the grant does not have (fail
 * closed — a position that disagrees with the signed ladder is not trusted).
 */
export function rolloutPositionFor(grant: StandingGrantV1, index: LedgerAuthorityIndex): RolloutPositionInternal | null {
  const accepted = index.accepted.get(grant.grantId);
  if (!accepted) return null;
  const moved = index.rollout.get(grant.grantId);
  if (!moved || moved.entrySeq < accepted.seq) {
    const first = grant.rollout.stages[0];
    return first ? { stageIndex: 0, stageId: first.id, enteredAt: accepted.at, entrySeq: accepted.seq } : null;
  }
  const stage = grant.rollout.stages[moved.stageIndex];
  if (!stage || stage.id !== moved.stageId) return null;
  return { stageIndex: moved.stageIndex, stageId: moved.stageId, enteredAt: moved.enteredAt, entrySeq: moved.entrySeq };
}

export type RolloutDecision = 'advance' | 'regress' | 'hold';

export interface RolloutEvaluation {
  progress: RolloutProgress;
  decision: RolloutDecision;
  /** Why the stage regresses; null otherwise. */
  breach: string | null;
  /** This stage's merges whose post-merge watch has not reported. */
  pendingWatches: number;
}

const HOUR_MS = 60 * 60 * 1000;

function pct(numerator: number, denominator: number): number {
  return Math.floor((100 * numerator) / denominator);
}

/** PURE: the current stage's evidence, criteria and the resulting decision. */
export function evaluateRollout(input: {
  grant: StandingGrantV1;
  position: RolloutPositionInternal;
  evidence: readonly LedgerEvidenceRow[];
  nowMs: number;
}): RolloutEvaluation {
  const { grant, position, nowMs } = input;
  const stages = grant.rollout.stages;
  const stage = stages[position.stageIndex]!;
  const rows = input.evidence.filter((row) => row.seq > position.entrySeq);
  const merges = rows.filter((row) => row.kind === 'merge:landed');
  const reverts = rows.filter((row) => row.kind === 'revert:landed');
  const wouldMerges = rows.filter((row) => row.kind === 'gate:would-merge');
  const violations = rows.filter((row) => row.kind === 'sandbox:violation').length;
  const reserveBreaches = rows.filter((row) => row.kind === 'reserve:breach').length;

  const stageMerges = stage.repos.some((repo) => repo.stage === 'merge');
  const mergeCount = stageMerges ? merges.length : wouldMerges.length;

  const stageLandingIds = new Set(merges.map((row) => row.landingId).filter((id): id is string => id !== null));
  const verdicts = new Map<string, 'green' | 'red'>();
  for (const row of rows) {
    if (row.kind === 'post-merge:result' && row.landingId !== null && stageLandingIds.has(row.landingId) && row.verdict) {
      // The last verdict for a landing wins (a watch reports once; a re-run would supersede).
      verdicts.set(row.landingId, row.verdict);
    }
  }
  let green = 0;
  let red = 0;
  for (const verdict of verdicts.values()) {
    if (verdict === 'green') green += 1;
    else red += 1;
  }
  const completed = green + red;
  const pendingWatches = [...stageLandingIds].filter((id) => !verdicts.has(id)).length;
  const postMergeGreenPct = completed > 0 ? pct(green, completed) : null;
  const revertRatePct = merges.length > 0 ? Math.min(100, pct(reverts.length, merges.length)) : reverts.length > 0 ? 100 : null;

  const enteredMs = Date.parse(position.enteredAt);
  const elapsedMs = Math.max(0, nowMs - (Number.isFinite(enteredMs) ? enteredMs : nowMs));
  const hoursInStage = Math.floor(elapsedMs / (HOUR_MS / 10)) / 10;
  const evidence: RolloutEvidence = {
    hoursInStage,
    merges: mergeCount,
    postMergeGreenPct,
    revertRatePct,
    sandboxViolations: violations,
    reserveBreaches,
  };

  const c = stage.criteria;
  let breach: string | null = null;
  if (violations > 0) breach = `${violations} sandbox violation${violations === 1 ? '' : 's'} in stage ${stage.id}`;
  else if (reserveBreaches > 0) breach = `${reserveBreaches} reserve breach${reserveBreaches === 1 ? '' : 'es'} in stage ${stage.id}`;
  else if (revertRatePct !== null && revertRatePct > c.maxRevertRatePct) {
    breach = `revert rate ${revertRatePct}% in stage ${stage.id} is above its ${c.maxRevertRatePct}% limit`;
  }

  const unmet: string[] = [];
  if (mergeCount < c.minMerges) unmet.push(`${mergeCount} of ${c.minMerges} ${stageMerges ? 'merges' : 'would-merge digests'}`);
  if (c.minPostMergeGreenPct > 0) {
    if (completed === 0) {
      if (c.minMerges > 0) unmet.push('no post-merge watch has finished yet');
    } else if ((postMergeGreenPct ?? 0) < c.minPostMergeGreenPct) {
      unmet.push(`post-merge green ${postMergeGreenPct}% (needs ${c.minPostMergeGreenPct}%)`);
    }
    if (pendingWatches > 0) unmet.push(`${pendingWatches} post-merge watch${pendingWatches === 1 ? '' : 'es'} still running`);
  }
  if (revertRatePct !== null && revertRatePct > c.maxRevertRatePct) unmet.push(`revert rate ${revertRatePct}% (max ${c.maxRevertRatePct}%)`);
  if (elapsedMs < c.minHours * HOUR_MS) unmet.push(`${Math.floor(hoursInStage)} h of ${c.minHours} h`);
  if (violations > 0) unmet.push(`${violations} sandbox violation${violations === 1 ? '' : 's'} (0 allowed)`);
  if (reserveBreaches > 0) unmet.push(`${reserveBreaches} reserve breach${reserveBreaches === 1 ? '' : 'es'} (0 allowed)`);

  const met = unmet.length === 0;
  const last = position.stageIndex >= stages.length - 1;
  const decision: RolloutDecision = breach ? 'regress' : met && !last ? 'advance' : 'hold';
  return {
    progress: {
      stageId: stage.id,
      stageIndex: position.stageIndex,
      stageCount: stages.length,
      enteredAt: position.enteredAt,
      ...evidence,
      criteria: { ...c },
      nextStageId: last ? null : stages[position.stageIndex + 1]!.id,
      met,
      unmet,
    },
    decision,
    breach,
    pendingWatches,
  };
}

export interface RolloutStepResult {
  decision: RolloutDecision;
  fromStageId: string;
  toStageId: string;
  evaluation: RolloutEvaluation;
}

/**
 * Evaluate and, when due, record ONE move — inside a ledger transaction so
 * the decision and the row are made against the same verified chain.
 * Returns null when the grant has no position (never accepted).
 */
export function stepRolloutUnderLock(tx: LedgerTransaction, grant: StandingGrantV1, nowMs: number): RolloutStepResult | null {
  if (tx.snapshot.chain === 'broken') return null;
  const position = rolloutPositionFor(grant, tx.snapshot.index);
  if (!position) return null;
  const evaluation = evaluateRollout({ grant, position, evidence: tx.snapshot.index.evidence, nowMs });
  const stages = grant.rollout.stages;
  if (evaluation.decision === 'hold') {
    return { decision: 'hold', fromStageId: position.stageId, toStageId: position.stageId, evaluation };
  }
  const evidence: RolloutEvidence = {
    hoursInStage: evaluation.progress.hoursInStage,
    merges: evaluation.progress.merges,
    postMergeGreenPct: evaluation.progress.postMergeGreenPct,
    revertRatePct: evaluation.progress.revertRatePct,
    sandboxViolations: evaluation.progress.sandboxViolations,
    reserveBreaches: evaluation.progress.reserveBreaches,
  };
  if (evaluation.decision === 'advance') {
    const toIndex = position.stageIndex + 1;
    const to = stages[toIndex]!;
    tx.append({
      kind: 'rollout:advanced',
      actor: 'daemon',
      grantId: grant.grantId,
      repo: null,
      data: { grantId: grant.grantId, fromStageId: position.stageId, toStageId: to.id, toStageIndex: toIndex, evidence },
    });
    return { decision: 'advance', fromStageId: position.stageId, toStageId: to.id, evaluation };
  }
  const toIndex = Math.max(0, position.stageIndex - 1);
  const to = stages[toIndex]!;
  tx.append({
    kind: 'rollout:regressed',
    actor: 'daemon',
    grantId: grant.grantId,
    repo: null,
    data: { grantId: grant.grantId, fromStageId: position.stageId, toStageId: to.id, toStageIndex: toIndex, breach: evaluation.breach ?? 'breach', evidence },
  });
  return { decision: 'regress', fromStageId: position.stageId, toStageId: to.id, evaluation };
}
