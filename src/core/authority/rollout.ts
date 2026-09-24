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
 *   revert rate  reverts OF THIS STAGE'S MERGES / merges. A revert is charged
 *                to the stage of the merge it reverts (`revertsLandingId`), not
 *                the stage it lands in: the revert of a red merge usually lands
 *                a few ticks after the red verdict, and charging it to the next
 *                stage read as a 100% revert rate there (0 merges) and
 *                regressed the ladder right after it advanced (3.10 review c6).
 *                A revert row that names no landing (legacy) still counts
 *                where it lands, the conservative reading. While a red merge of
 *                this stage has neither a `revert:landed` nor a `revert:failed`
 *                row, the stage does not advance for up to REVERT_SETTLE_MS, so
 *                the revert is counted HERE before the ladder moves on;
 *   hours        since the stage was entered.
 *
 * Unknown evidence (3.10 d0): a `sandbox:evidence-unknown` row — an
 * autonomous run whose kernel violation evidence was unavailable or
 * incomplete — is neither a clean run nor a breach. It HOLDS the stage for
 * EVIDENCE_UNKNOWN_HOLD_MS: the stage never advances on it and never
 * regresses on it (a real breach in the same window still regresses).
 *
 * `evaluateRollout` is PURE; `stepRolloutUnderLock` is the only writer of
 * rollout rows and runs inside the ledger lock so two ticks can never both
 * advance. `recordSandboxEvidenceUnknown` writes the evidence row above.
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

/**
 * How long a red merge's revert may take to settle before the stage stops
 * waiting for it. The post-merge watch retries a pending revert for up to
 * 60 min (REVERT_PENDING_DEADLINE_MS) and then writes `revert:failed`; 90 min
 * covers that plus a few ticks. The wait is bounded because an INHERITED red
 * (the default branch was already red at the parent) is never reverted and
 * writes no revert row at all — an unbounded wait would hold the stage
 * forever on a red that was not the fleet's.
 */
export const REVERT_SETTLE_MS = 90 * 60 * 1000;

/**
 * How long one run with UNKNOWN sandbox evidence holds the stage. WHY a fixed
 * window and not "until the stage is re-entered": one transient failure of the
 * kernel log watch must not pin a stage forever (only a breach or a new grant
 * re-enters one), yet a machine where the evidence is ALWAYS unknown writes a
 * row per run and so stays held indefinitely — fail closed. WHY not the
 * stage's own minHours: a shadow stage may need 0 h, which would make the hold
 * a single tick. 24 h is a full day of runs whose evidence was complete.
 */
export const EVIDENCE_UNKNOWN_HOLD_MS = 24 * 60 * 60 * 1000;

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
  const wouldMerges = rows.filter((row) => row.kind === 'gate:would-merge');
  const violations = rows.filter((row) => row.kind === 'sandbox:violation').length;
  const reserveBreaches = rows.filter((row) => row.kind === 'reserve:breach').length;
  // Unknown evidence within the hold window. An unparseable time counts as
  // holding (fail closed; the ledger verifies timestamps, so it cannot happen).
  const evidenceUnknownHolding = rows.filter((row) => {
    if (row.kind !== 'sandbox:evidence-unknown') return false;
    const atMs = Date.parse(row.at);
    return !Number.isFinite(atMs) || nowMs - atMs < EVIDENCE_UNKNOWN_HOLD_MS;
  }).length;

  const stageMerges = stage.repos.some((repo) => repo.stage === 'merge');
  const mergeCount = stageMerges ? merges.length : wouldMerges.length;

  const stageLandingIds = new Set(merges.map((row) => row.landingId).filter((id): id is string => id !== null));
  // Charged to the stage of the merge it reverts (see header). A revert of an
  // EARLIER stage's merge that lands now is that stage's evidence, not ours.
  const reverts = rows.filter((row) => row.kind === 'revert:landed'
    && (typeof row.revertsLandingId === 'string' && row.revertsLandingId.length > 0
      ? stageLandingIds.has(row.revertsLandingId)
      : true));
  const verdicts = new Map<string, 'green' | 'red'>();
  const verdictAt = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === 'post-merge:result' && row.landingId !== null && stageLandingIds.has(row.landingId) && row.verdict) {
      // The last verdict for a landing wins (a watch reports once; a re-run would supersede).
      verdicts.set(row.landingId, row.verdict);
      verdictAt.set(row.landingId, row.at);
    }
  }
  const settled = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'revert:landed' && typeof row.revertsLandingId === 'string') settled.add(row.revertsLandingId);
    else if (row.kind === 'revert:failed' && row.landingId !== null) settled.add(row.landingId);
  }
  let revertsSettling = 0;
  for (const [id, verdict] of verdicts) {
    if (verdict !== 'red' || settled.has(id)) continue;
    const redMs = Date.parse(verdictAt.get(id) ?? '');
    if (Number.isFinite(redMs) && nowMs - redMs < REVERT_SETTLE_MS) revertsSettling += 1;
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
  if (revertsSettling > 0) {
    unmet.push(`${revertsSettling} revert${revertsSettling === 1 ? '' : 's'} of a red merge still landing`);
  }
  if (revertRatePct !== null && revertRatePct > c.maxRevertRatePct) unmet.push(`revert rate ${revertRatePct}% (max ${c.maxRevertRatePct}%)`);
  if (elapsedMs < c.minHours * HOUR_MS) unmet.push(`${Math.floor(hoursInStage)} h of ${c.minHours} h`);
  if (violations > 0) unmet.push(`${violations} sandbox violation${violations === 1 ? '' : 's'} (0 allowed)`);
  if (reserveBreaches > 0) unmet.push(`${reserveBreaches} reserve breach${reserveBreaches === 1 ? '' : 'es'} (0 allowed)`);
  // Never a breach (the regress decision below reads only `breach`): unknown
  // is not a violation, it is the absence of proof there was none.
  if (evidenceUnknownHolding > 0) {
    unmet.push(`${evidenceUnknownHolding} run${evidenceUnknownHolding === 1 ? '' : 's'} with unknown sandbox evidence in the last ${EVIDENCE_UNKNOWN_HOLD_MS / HOUR_MS} h`);
  }

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

// ---------------------------------------------------------------------------
// Unknown-evidence rows (3.10 d0)
// ---------------------------------------------------------------------------

/**
 * One `sandbox:evidence-unknown` row for an autonomous run whose kernel
 * violation evidence was not complete (`finishAutonomousSpawn().violationsKnown`
 * false). Returns whether a row was written. Best-effort, never throws.
 *
 * Only written while a standing grant is in force: the row exists to hold a
 * rollout, and without a grant there is no rollout — writing then would only
 * create a ledger on a machine that never granted autonomy (every non-macOS
 * run is `unavailable`). No environment check here (authority files never
 * read the environment): test runs are kept off the real ledger by the global
 * fail-loud HOME boundary in test/setup/home.ts, as for sandbox:violation.
 */
export async function recordSandboxEvidenceUnknown(input: {
  engine: string;
  /** Local repo path (mapped to owner/name for the row), or null (judges). */
  sourceRepo: string | null;
  runId: string | null;
  /** The run's kernel evidence; missing = unknown (fail closed). */
  evidence?: { state: 'complete' | 'incomplete' | 'unavailable'; reason: string | null } | null;
}, deps: {
  /**
   * The grant in force (default: `currentStandingPolicy()`). Injectable
   * because effective-config imports this module, and a module mock of it
   * does not reach this module's own dynamic import under vitest.
   */
  standingGrantId?: () => string | null;
} = {}): Promise<boolean> {
  const state = input.evidence?.state === 'complete' || input.evidence?.state === 'incomplete' ? input.evidence.state : 'unavailable';
  if (state === 'complete') return false;
  try {
    const [{ appendLedger }, { currentStandingPolicy }, { repoIdentityOfPath }] = await Promise.all([
      import('./ledger.js'),
      import('./effective-config.js'),
      import('../fleet/repo-identity.js'),
    ]);
    let grantId: string | null = null;
    try {
      grantId = deps.standingGrantId ? deps.standingGrantId() : currentStandingPolicy()?.grantId ?? null;
    } catch {
      grantId = null;
    }
    if (!grantId) return false;
    let repo: string | null = null;
    try { repo = input.sourceRepo ? repoIdentityOfPath(input.sourceRepo) : null; } catch { repo = null; }
    const written = appendLedger({
      kind: 'sandbox:evidence-unknown',
      data: {
        v: 1,
        engine: String(input.engine).slice(0, 64),
        repo,
        runId: input.runId,
        state,
        reason: (input.evidence?.reason ?? 'the kernel evidence was not complete').slice(0, 300),
        at: new Date().toISOString(),
      },
      actor: 'daemon',
      grantId,
      repo,
    });
    return written.ok;
  } catch {
    // A ledger that cannot be written is the rollout's own fail-closed signal.
    return false;
  }
}
