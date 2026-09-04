/**
 * best-of-n.ts — M142: best-of-N candidate generation with critic selection.
 *
 * Research basis: Rubric-Supervised critic gives Best@8 = +15.9 pts over random
 * on SWE-bench (2026). Local compute is free; generate N candidates and let the
 * judge pick the best one to propose.
 *
 * STANDALONE — not wired into loop.ts (a concurrent session owns that).
 * Expose via: import { runBestOfN } from './best-of-n.js'
 *
 * Flag-off parity: cfg.foundry.bestOfN defaults to 1 → identical to a single run.
 *
 * CI session isolation (opt-in via LOCUS_CI_BINDING / LOCUS_BINDING):
 *   runBestOfN mints an ephemeral Locus pin and overlays LOCUS_* onto
 *   process.env so sandboxed engines (runEngineSandboxed /
 *   runApiModelSandboxed) inherit the sealed session. LOCUS_ENFORCE without a
 *   binding refuses as empty-candidate result (never throws). Default is a
 *   no-op pass-through. Does not add a second pre-mutate gate — that lives on
 *   spawnEngine / runSwarm / runApiModelSandboxed only.
 */

import type {
  AshlrConfig,
  WorkItem,
  Proposal,
  WorkSource,
  EngineId,
  RunProposalOutcome,
  RunBudget,
  RunState,
  SkillCard,
  DelegationScope,
  Sandbox,
  BestOfNCandidateSpec,
} from '../types.js';
import type { ManagerVerdict, FrontierJudgeClient } from '../fleet/manager.js';
import type { TasteScore } from '../fleet/taste-critic.js';
import { resolveEngineSpec } from './engine-registry.js';
import {
  deriveCandidateAttemptIdentity,
  type OuterAttemptIdentity,
} from '../fleet/attempt-identity.js';
import { mergeDelegationScope, scopeFromWorkItem } from './delegation-scope.js';
import { observeShadowSkills } from '../fleet/skill-shadow-observer.js';
import type { SandboxRetentionEvidence } from './sandboxed-engine.js';
import { runTests, runTestsForProposal } from './run-tests.js';
import { isAuthoritativeDurablePendingProposal } from '../inbox/pending-authority.js';
import {
  abandonExecutionAuthority,
  acquireExecutionAuthority,
  beginExecutionAuthority,
  finishExecutionAuthority,
} from '../util/execution-lease.js';
import {
  applyLocusSessionEnv,
  LocusMintError,
  LocusSessionConfigError,
  runWithLocusSessionIfConfigured,
} from '../integrations/locus.js';
import {
  MAX_BEST_OF_N_CANDIDATE_SPECS_INSPECTED,
  MAX_BEST_OF_N_CONCURRENCY,
  resolveBestOfNCount,
} from './best-of-n-policy.js';
import {
  verifyOllamaModelIdentity,
  normalizeNumericLoopbackOllamaBaseUrl,
  type OllamaModelIdentity,
} from './ollama-identity.js';
import type {
  FleetQuotaReservationRequest,
  FleetQuotaReservationResult,
} from '../fleet/quota.js';
import { sanitizePublicJson } from '../util/public-json.js';
import type { RunOutputStreamClaim } from './streaming.js';

const SHADOW_REQUEST_TIMEOUT_MS = 120_000;
const SHADOW_REQUEST_MAX_BYTES = 1024 * 1024;
const SHADOW_RESPONSE_MAX_BYTES = 1024 * 1024;
const SHADOW_MAX_TOKENS = 32_768;
const SHADOW_MAX_STEPS = 20;
const SHADOW_MAX_OUTPUT_TOKENS = 8_192;
const CANDIDATE_RESULT_PREVIEW_CHARS = 8_192;
const CANDIDATE_STEP_SUMMARY_CHARS = 1_024;
const MAX_OBSERVED_CANDIDATE_TASKS = 64;
const MAX_OBSERVED_CANDIDATE_STEPS = 256;

function boundedPublicText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const safe = sanitizePublicJson(value);
  return typeof safe === 'string' ? safe.slice(0, limit) : undefined;
}

/**
 * Sanitize candidate state before it reaches durable observability storage.
 */
function safeCandidateOutputState(
  state: RunState,
  candidateIndex: number,
): RunState {
  return sanitizePublicJson({
    ...state,
    goal: `Best-of-N candidate ${candidateIndex + 1}`,
    result: boundedPublicText(state.result, CANDIDATE_RESULT_PREVIEW_CHARS),
    tasks: state.tasks.slice(0, MAX_OBSERVED_CANDIDATE_TASKS).map((task, index) => ({
      ...task,
      goal: `Candidate task ${index + 1}`,
      result: boundedPublicText(task.result, CANDIDATE_RESULT_PREVIEW_CHARS),
      error: boundedPublicText(task.error, CANDIDATE_STEP_SUMMARY_CHARS),
    })),
    steps: state.steps.slice(-MAX_OBSERVED_CANDIDATE_STEPS).map((step) => ({
      ...step,
      summary: boundedPublicText(step.summary, CANDIDATE_STEP_SUMMARY_CHARS) ?? '',
    })),
  }) as RunState;
}

type CandidateObservationOwnership =
  | { ok: true; state: RunState; streamClaim: RunOutputStreamClaim }
  | { ok: false; reason: 'candidate-observation-stream-collision' | 'candidate-observation-state-collision' };

/**
 * Exclusively claim both durable resources before candidate dispatch. The
 * stream claim is inode-bound and non-serializable; saveRun atomically refuses
 * an existing RunState. A failed state claim releases only our still-empty
 * stream inode, so neither an orphan stream nor a reused attempt can be
 * adopted by a new provider execution.
 */
async function startCandidateOutputObservation(
  cfg: AshlrConfig,
  state: RunState,
  candidateIndex: number,
): Promise<CandidateObservationOwnership> {
  if (cfg.foundry?.runOutputPersistence?.enabled !== true) {
    return { ok: false, reason: 'candidate-observation-state-collision' };
  }
  const { claimRunOutputStream, releaseRunOutputStreamClaim } = await import('./streaming.js');
  const streamClaim = claimRunOutputStream(state.id);
  if (!streamClaim) return { ok: false, reason: 'candidate-observation-stream-collision' };
  try {
    const { saveRun } = await import('./orchestrator.js');
    const safe = safeCandidateOutputState(state, candidateIndex);
    saveRun(safe);
    return { ok: true, state: safe, streamClaim };
  } catch {
    releaseRunOutputStreamClaim(streamClaim);
    return { ok: false, reason: 'candidate-observation-state-collision' };
  }
}

/** Refresh only the exact object carrying saveRun's generation authority. */
async function updateCandidateOutputObservation(
  state: RunState,
  candidateIndex: number,
  prior: RunState,
): Promise<RunState> {
  try {
    const { saveRun } = await import('./orchestrator.js');
    Object.assign(prior, safeCandidateOutputState(state, candidateIndex));
    saveRun(prior);
  } catch {
    // Terminal observation is best effort after exclusive dispatch ownership.
  }
  return prior;
}

export {
  MAX_BEST_OF_N_CANDIDATE_SPECS_INSPECTED,
  MAX_BEST_OF_N_CANDIDATES,
  MAX_BEST_OF_N_CONCURRENCY,
  resolveBestOfNCount,
} from './best-of-n-policy.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CandidateResult {
  /** 0-based candidate index. */
  index: number;
  /** The diff patch captured by the sandbox run, or empty string. */
  diff: string;
  /** The inbox proposal id, if one was created. */
  proposalId?: string;
  /** Created proposal identity awaiting reconciliation; never winner authority. */
  candidateProposalId?: string;
  /** Opaque execution id for joining this candidate, including losers. */
  runId?: string;
  /** Causal trajectory bound to this candidate run. */
  trajectoryId?: string;
  /**
   * Verdict from the critic judge. undefined when no real judgment was
   * obtained — a synthetic manager.ts fallback (verdict.judgeFailure set) is
   * never surfaced here; see `judgeSource` for why no verdict exists.
   */
  verdict?: ManagerVerdict;
  /**
   * M498: provenance of this candidate's judging.
   * 'real'        = an independently resolved judge client
   *                 (resolveFrontierJudgeClient, requireIndependent) produced
   *                 a considered verdict (or a real call failed — see
   *                 critique.judge.callsFailed).
   * 'unavailable' = a real judge was sought but none could be resolved
   *                 (no independent engine installed/authorized).
   * 'skipped'     = judging was never attempted — cfg.foundry.bestOfNJudge is
   *                 not enabled, or fewer than 2 materially distinct
   *                 candidates existed to differentiate.
   * undefined     = the manager judge module itself was not importable.
   */
  judgeSource?: 'real' | 'unavailable' | 'skipped';
  /** Score derived from verdict dimensions (value+correctness+scope+alignment). */
  score: number;
  /** Whether the real test loop passed (undefined = not attempted / not available). */
  testsPassed?: boolean;
  /**
   * M183: TASTE critic result (only present when cfg.foundry.tasteCritic=true).
   * Scores vision-alignment, ambition/impact, and design taste (1–5 each).
   */
  taste?: TasteScore;
  /** M333: the engine that produced this candidate (multi-model mode). */
  engine?: EngineId;
  /** M333: the model spec used for this candidate (null = engine default). */
  model?: string | null;
  /** M333: raw generation cost for this candidate (USD, pre-subscription-rule). */
  costUsd?: number;
  /** M333: wall-clock generation latency for this candidate (ms). */
  latencyMs?: number;
  /** Observation-only candidate: never eligible for final proposal capture. */
  shadow?: boolean;
  /** Result of the read-only, digest-pinned local artifact preflight. */
  shadowIdentityStatus?: 'verified' | 'refused';
  /** Bounded metadata returned by Ollama's local inventory endpoint. */
  artifactIdentity?: OllamaModelIdentity;
  /** Counterfactual pre-capture winner under the ordinary ranking policy. */
  shadowWouldHaveWon?: boolean;
  /** True only when the underlying provider request was actually opened. */
  shadowParticipated?: boolean;
  /** Error from the sandbox run or judge, if any. */
  error?: string;
  /** Durable batch reservation that governed this logical producer dispatch. */
  quotaReservation?: FleetQuotaReservationResult;
  /** True only when the sandboxed producer runner was actually invoked. */
  providerDispatchAttempted?: boolean;
  /** Structured reason the sandbox run did or did not file a proposal. */
  proposalOutcome?: RunProposalOutcome;
  /** Bounded final-capture classification consumed by the daemon. */
  proposalDisposition?: CandidateProposalDisposition;
  /** Durable quarantine evidence when process closure could not be confirmed. */
  sandboxRetention?: SandboxRetentionEvidence;
}

export type CandidateProposalDisposition =
  | { kind: 'verification-rejected' }
  | { kind: 'duplicate-owned'; proposalId: string; diffHash: string }
  | { kind: 'capture-missing' };

interface InternalCandidateResult extends CandidateResult {
  requestedModel?: string | null;
  proposalDraft?: Proposal;
  sandbox?: Sandbox;
  delegationScope?: DelegationScope;
  state?: RunState;
}

export interface BestOfNResult {
  winner: CandidateResult;
  candidates: CandidateResult[];
  /** JSON-serialisable critique summary for logging/CLI output. */
  critique: {
    n: number;
    nonEmpty: number;
    judged: number;
    topScore: number;
    winnerIndex: number;
    /** M333: summed raw generation cost across ALL candidates (USD). */
    totalCostUsd: number;
    /**
     * M333: totalCostUsd with the M80 subscription-$0 rule applied
     * PER-CANDIDATE — this is what the daemon counts against the tick budget
     * (the pre-M333 daemon counted only the winner's spend, under-reporting
     * a fan-out by ~N-1 candidates).
     */
    billableCostUsd: number;
    /** Top terminal reasons for candidates that produced no proposal. */
    noProposalReasons?: Array<{ reason: string; count: number }>;
    /**
     * M498: real-judge wiring summary. 'real' only when at least one
     * candidate received a genuine judge verdict this run; 'unavailable' when
     * a real judge was sought but none could be resolved; 'skipped' when
     * judging was never attempted (config off, or <2 materially distinct
     * candidates). Lets Models/Production views show whether best-of-N is
     * actually earning its cost.
     */
    judge?: {
      status: 'real' | 'unavailable' | 'skipped';
      /** Distinct judge model identities actually used this run. */
      models?: string[];
      /** Real judge calls attempted (excludes the always-present null-client fallback). */
      callsAttempted: number;
      /** Real judge calls that threw or returned a synthetic fallback verdict. */
      callsFailed: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read bestOfN from cfg loosely — the field is not yet in types.ts.
 * Default 1 = current behaviour (flag-off parity).
 */
function readN(cfg: AshlrConfig, override?: number): number {
  if (override !== undefined) return resolveBestOfNCount(override);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromCfg = (cfg.foundry as any)?.bestOfN;
  return resolveBestOfNCount(fromCfg);
}

function partitionFanOutBudget(
  budget: Partial<RunBudget> | undefined,
  n: number,
): Partial<RunBudget> | undefined {
  if (!budget) return undefined;
  return {
    ...(budget.maxTokens !== undefined
      ? {
          maxTokens: Number.isSafeInteger(budget.maxTokens) && budget.maxTokens >= 0
            ? Math.floor(budget.maxTokens / n)
            : 0,
        }
      : {}),
    ...(budget.maxSteps !== undefined
      ? {
          maxSteps: Number.isSafeInteger(budget.maxSteps) && budget.maxSteps >= 0
            ? Math.floor(budget.maxSteps / n)
            : 0,
        }
      : {}),
    ...(budget.allowCloud !== undefined ? { allowCloud: budget.allowCloud } : {}),
  };
}

function constrainCandidateBudget(
  budget: Partial<RunBudget> | undefined,
  cap: RunBudget,
): Partial<RunBudget> {
  return {
    maxTokens: Math.min(budget?.maxTokens ?? cap.maxTokens, cap.maxTokens),
    maxSteps: Math.min(budget?.maxSteps ?? cap.maxSteps, cap.maxSteps),
    allowCloud: budget?.allowCloud ?? cap.allowCloud,
  };
}

/**
 * Order-preserving bounded async map. Only `limit` workers are created, so an
 * oversized input cannot eagerly construct an unbounded Promise fan-out.
 */
async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(limit)));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Build the goal string for a WorkItem — mirrors what the daemon uses.
 */
function goalFor(item: WorkItem): string {
  return item.detail?.trim() ? `${item.title}\n\n${item.detail}` : item.title;
}

/**
 * Derive a numeric score from a ManagerVerdict.
 * value + correctness + (5 - scope) + alignment → max 20.
 * Scope is inverted because lower blast radius is better.
 */
function scoreVerdict(v: ManagerVerdict): number {
  return v.value + v.correctness + (5 - Math.min(5, Math.max(1, v.scope))) + v.alignment;
}

/**
 * Build a synthetic Proposal object from a candidate diff so the judge can
 * rate it. The judge only needs the diff and basic metadata.
 */
function syntheticProposal(item: WorkItem, diff: string, index: number): Proposal {
  return {
    id: `best-of-n-candidate-${index}-${Date.now().toString(36)}`,
    repo: item.repo ?? null,
    origin: 'agent',
    kind: 'patch',
    title: item.title,
    summary: `Best-of-N candidate ${index} for: ${item.title}`,
    diff,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Proposal;
}

function stateResultMessage(state: RunState): string | undefined {
  return typeof state.result === 'string' && state.result.trim().length > 0
    ? state.result.trim()
    : undefined;
}

function formatProposalOutcome(outcome?: RunProposalOutcome): string | undefined {
  if (!outcome || outcome.kind === 'filed') return undefined;
  const reason = outcome.reason?.trim();
  const label = reason ? `${outcome.kind}: ${reason}` : outcome.kind;
  return label.length > 220 ? `${label.slice(0, 217)}...` : label;
}

function candidateErrorFromState(
  state: RunState,
  hasProposalMaterial = false,
  outcome: RunProposalOutcome | undefined = state.proposalOutcome,
): string | undefined {
  if (!hasProposalMaterial) {
    const proposalReason = formatProposalOutcome(outcome);
    if (proposalReason) return proposalReason;
  }

  if (state.status === 'failed' || state.status === 'aborted') {
    return stateResultMessage(state) ?? `sandboxed candidate ${state.status}`;
  }

  // Most no-proposal success paths are just empty diffs. If a runner does return
  // an explicit gate/block reason in the existing RunState shape, surface it.
  if (!hasProposalMaterial) {
    const msg = stateResultMessage(state);
    if (msg && /\b(blocked|gate|refused|denied)\b/i.test(msg)) return msg;
  }

  return undefined;
}

function summarizeNoProposalReasons(candidates: CandidateResult[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (candidateHasProposalMaterial(c)) continue;
    const reason = c.error ?? formatProposalOutcome(c.proposalOutcome) ?? 'no proposal filed';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));
}

function candidateHasProposalMaterial(c: CandidateResult): boolean {
  const draft = (c as InternalCandidateResult).proposalDraft;
  return !!c.proposalId || !!draft;
}

function candidateHasPartialProposalMaterial(c: InternalCandidateResult): boolean {
  if (!candidateHasProposalMaterial(c)) return false;
  return c.proposalDraft?.isPartial === true ||
    c.proposalOutcome?.isPartial === true ||
    c.state?.status === 'failed' ||
    c.state?.status === 'aborted';
}

function proposalForCandidate(item: WorkItem, c: InternalCandidateResult, loadProposal?: (id: string) => Proposal | null): Proposal {
  if (c.proposalDraft) return c.proposalDraft;
  if (c.proposalId) {
    try {
      const loaded = loadProposal?.(c.proposalId);
      if (loaded) return loaded;
    } catch {
      // fall through to synthetic
    }
  }
  return syntheticProposal(item, c.diff, c.index);
}

function durableDuplicateDisposition(
  candidate: InternalCandidateResult,
  outcome: RunProposalOutcome | undefined,
  loadProposal: ((id: string) => Proposal | null) | undefined,
  cfg: AshlrConfig,
): CandidateProposalDisposition | undefined {
  const draft = candidate.proposalDraft;
  if (
    outcome?.kind !== 'proposal-disabled' ||
    !outcome.proposalId ||
    !draft?.diffHash ||
    !loadProposal
  ) return undefined;

  try {
    const existing = loadProposal(outcome.proposalId);
    if (!isAuthoritativeDurablePendingProposal(existing, {
      id: outcome.proposalId,
      repo: draft.repo as string,
      origin: 'agent',
      kind: 'patch',
      diff: draft.diff,
      diffHash: draft.diffHash,
      workItemId: draft.workItemId,
      workItemGenerationId: draft.workItemGenerationId,
      isPartial: draft.isPartial === true,
    }, cfg)) return undefined;
    return { kind: 'duplicate-owned', proposalId: existing.id, diffHash: existing.diffHash as string };
  } catch {
    return undefined;
  }
}

function finalCaptureDisposition(
  candidate: InternalCandidateResult,
  outcome: RunProposalOutcome | undefined,
  loadProposal: ((id: string) => Proposal | null) | undefined,
  cfg: AshlrConfig,
): CandidateProposalDisposition | undefined {
  const duplicate = durableDuplicateDisposition(candidate, outcome, loadProposal, cfg);
  if (duplicate) return duplicate;
  if (
    typeof candidate.proposalDraft?.diff === 'string' &&
    candidate.proposalDraft.diff.trim().length > 0 &&
    (outcome === undefined || outcome.kind === 'proposal-disabled')
  ) return { kind: 'capture-missing' };
  return undefined;
}

function exactDurablePendingProposal(
  candidate: InternalCandidateResult,
  proposalId: string | undefined,
  outcome: RunProposalOutcome | undefined,
  loadProposal: ((id: string) => Proposal | null) | undefined,
  expected: {
    repo: string;
    workItemId: string;
    workItemGenerationId?: string;
  },
  cfg: AshlrConfig,
): Proposal | undefined {
  if (
    !proposalId ||
    outcome?.kind !== 'filed' ||
    outcome.proposalId !== proposalId ||
    !candidate.runId ||
    !loadProposal
  ) return undefined;

  let persisted: Proposal | null;
  try {
    persisted = loadProposal(proposalId);
  } catch {
    return undefined;
  }
  const draft = candidate.proposalDraft;
  const trajectoryId = candidate.trajectoryId ?? `run:${candidate.runId}`;
  if (!isAuthoritativeDurablePendingProposal(persisted, {
    id: proposalId,
    repo: expected.repo,
    origin: 'agent',
    kind: 'patch',
    diff: draft?.diff ?? candidate.diff,
    ...(draft?.diffHash ? { diffHash: draft.diffHash } : {}),
    ...(draft?.provenanceSig ? { provenanceSig: draft.provenanceSig } : {}),
    ...(draft?.sandboxId ? { sandboxId: draft.sandboxId } : {}),
    runId: candidate.runId,
    trajectoryId,
    workItemId: expected.workItemId,
    workItemGenerationId: expected.workItemGenerationId,
    isPartial: draft?.isPartial === true || outcome.isPartial === true,
  }, cfg)) return undefined;

  return persisted;
}

function finalCaptureFailureOutcome(
  outcome: RunProposalOutcome | undefined,
  proposalId: string | undefined,
): RunProposalOutcome {
  if (outcome?.kind === 'proposal-capture-error') return outcome;
  return {
    kind: 'proposal-capture-error',
    reason: 'final proposal capture lacked exact durable pending proposal identity',
    ...(proposalId ? { proposalId } : {}),
    ...(outcome?.files !== undefined ? { files: outcome.files } : {}),
    ...(outcome?.insertions !== undefined ? { insertions: outcome.insertions } : {}),
    ...(outcome?.deletions !== undefined ? { deletions: outcome.deletions } : {}),
  };
}

function publicCandidate(c: InternalCandidateResult): CandidateResult {
  const {
    proposalDraft: _proposalDraft,
    sandbox: _sandbox,
    delegationScope: _delegationScope,
    ...rest
  } = c;
  return rest;
}

function cleanupCandidateSandboxes(candidates: InternalCandidateResult[], removeSandbox?: (sb: Sandbox) => void): void {
  if (!removeSandbox) return;
  const retainedIds = new Set(
    candidates
      .map((candidate) => candidate.sandboxRetention?.sandboxId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const seen = new Set<string>();
  for (const c of candidates) {
    const sb = c.sandbox;
    if (!sb || seen.has(sb.id)) continue;
    seen.add(sb.id);
    if (retainedIds.has(sb.id)) continue;
    try {
      removeSandbox(sb);
    } catch {
      // Best-of-N cleanup is best-effort; orphan sweeps reclaim stragglers.
    }
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Generate N candidate diffs for `item`, score each via the Manager critic,
 * filter empties, prefer passing candidates, and return the highest-scoring one.
 *
 * Never throws — all errors surface inside CandidateResult.error (or as an
 * empty-candidate refuse for execution-authority / Locus session failures).
 *
 * Dispatches via runEngineSandboxed / runApiModelSandboxed (not runTask), so
 * CI session mint is applied here — same pattern as runSwarm / runTask.
 *
 * @param item  The work item to solve.
 * @param cfg   AshlrConfig — reads cfg.foundry.bestOfN for N (default 1).
 * @param opts  Optional overrides: { n } overrides the config N.
 */
export async function runBestOfN(
  item: WorkItem,
  cfg: AshlrConfig,
  opts?: Parameters<typeof runBestOfNInternal>[2],
): ReturnType<typeof runBestOfNInternal> {
  const n = readN(cfg, opts?.n);
  const refused = (reason: string): Awaited<ReturnType<typeof runBestOfNInternal>> => ({
    winner: undefined,
    candidates: [],
    critique: {
      n,
      nonEmpty: 0,
      judged: 0,
      topScore: 0,
      winnerIndex: -1,
      totalCostUsd: 0,
      billableCostUsd: 0,
      noProposalReasons: [{ reason, count: 1 }],
      judge: { status: 'skipped', callsAttempted: 0, callsFailed: 0 },
    },
  });

  // CI isolation: when LOCUS_CI_BINDING/LOCUS_BINDING is set, mint an
  // ephemeral sealed session and overlay LOCUS_* onto process.env so
  // sandboxed engines inherit it. Restores prior values after the fan-out.
  // Default (unset binding + LOCUS_ENFORCE off) is a no-op pass-through.
  // Never throws — session refuse/mint failures become empty-candidate refuse.
  try {
    return await runWithLocusSessionIfConfigured(async (handle) => {
      const restored: Array<[string, string | undefined]> = [];
      if (handle) {
        const overlay: NodeJS.ProcessEnv = {};
        applyLocusSessionEnv(overlay, handle.env);
        for (const [key, value] of Object.entries(overlay)) {
          if (typeof value !== 'string') continue;
          restored.push([key, process.env[key]]);
          process.env[key] = value;
        }
      }
      try {
        return await runBestOfNWithAuthority(item, cfg, opts, refused);
      } finally {
        for (const [key, prev] of restored) {
          if (prev === undefined) delete process.env[key];
          else process.env[key] = prev;
        }
      }
    });
  } catch (error) {
    if (
      error instanceof LocusSessionConfigError ||
      error instanceof LocusMintError
    ) {
      return refused(error.message);
    }
    throw error;
  }
}

/**
 * Execution-authority gate + body. Callers must use {@link runBestOfN} so CI
 * session mint + never-throw locus contract stay intact.
 */
async function runBestOfNWithAuthority(
  item: WorkItem,
  cfg: AshlrConfig,
  opts: Parameters<typeof runBestOfNInternal>[2] | undefined,
  refused: (reason: string) => Awaited<ReturnType<typeof runBestOfNInternal>>,
): ReturnType<typeof runBestOfNInternal> {
  if (!opts?.attemptId || opts.signal?.aborted === true) {
    return runBestOfNInternal(item, cfg, opts);
  }
  const acquired = acquireExecutionAuthority('run', opts.attemptId);
  if (!acquired.ok) return refused(`execution authority ${acquired.reason}`);
  if (!beginExecutionAuthority(acquired.authority)) {
    abandonExecutionAuthority(acquired.authority);
    return refused('execution authority unavailable');
  }
  let completed = false;
  try {
    const result = await runBestOfNInternal(item, cfg, opts);
    completed = true;
    return result;
  } finally {
    if (completed) finishExecutionAuthority(acquired.authority);
    else abandonExecutionAuthority(acquired.authority);
  }
}

type ParsedShadowConfig =
  | { kind: 'off' }
  | { kind: 'invalid' }
  | { kind: 'on'; artifactDigest: string };

function parseShadowConfig(spec: BestOfNCandidateSpec): ParsedShadowConfig {
  const property = Object.getOwnPropertyDescriptor(spec, 'shadow');
  if (property === undefined) return { kind: 'off' };
  if (!property.enumerable || !('value' in property)) return { kind: 'invalid' };
  const value = property.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' };
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('enabled') || !keys.includes('artifactDigest')) {
    return { kind: 'invalid' };
  }
  const enabled = Object.getOwnPropertyDescriptor(value, 'enabled');
  const digest = Object.getOwnPropertyDescriptor(value, 'artifactDigest');
  if (
    !enabled?.enumerable || !('value' in enabled) || enabled.value !== true ||
    !digest?.enumerable || !('value' in digest) ||
    typeof digest.value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest.value)
  ) return { kind: 'invalid' };
  return { kind: 'on', artifactDigest: digest.value };
}

interface RuntimeCandidateSpec extends BestOfNCandidateSpec {
  invalidReason?: string;
  invalidShadow?: true;
}

const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'grok',
]);

function materializeCandidateSpecs(
  input: BestOfNCandidateSpec[] | undefined,
  fallback: BestOfNCandidateSpec,
): readonly RuntimeCandidateSpec[] {
  if (!Array.isArray(input)) return Object.freeze([{ ...fallback }]);
  const inputLength = input.length;
  if (inputLength === 0) return Object.freeze([{ ...fallback }]);
  const materialized: RuntimeCandidateSpec[] = [];
  const inspected = Math.min(inputLength, MAX_BEST_OF_N_CANDIDATE_SPECS_INSPECTED);
  for (let index = 0; index < inspected; index += 1) {
    const slot = Object.getOwnPropertyDescriptor(input, String(index));
    const value = slot?.value;
    if (!slot?.enumerable || !value || typeof value !== 'object' || Array.isArray(value)) {
      materialized.push({ ...fallback, invalidReason: 'candidate spec is not plain data' });
      continue;
    }
    const keys = Object.keys(value);
    const engineProperty = Object.getOwnPropertyDescriptor(value, 'engine');
    const modelProperty = Object.getOwnPropertyDescriptor(value, 'model');
    const shadowProperty = Object.getOwnPropertyDescriptor(value, 'shadow');
    if (
      keys.some((key) => key !== 'engine' && key !== 'model' && key !== 'shadow') ||
      !engineProperty?.enumerable || !('value' in engineProperty) ||
      typeof engineProperty.value !== 'string' || !ENGINE_IDS.has(engineProperty.value as EngineId) ||
      (modelProperty !== undefined && (!modelProperty.enumerable || !('value' in modelProperty) ||
        (typeof modelProperty.value !== 'string' && modelProperty.value !== null))) ||
      (shadowProperty !== undefined && (!shadowProperty.enumerable || !('value' in shadowProperty)))
    ) {
      materialized.push({ ...fallback, invalidReason: 'candidate spec has invalid fields' });
      continue;
    }
    let shadow: BestOfNCandidateSpec['shadow'];
    if (shadowProperty) {
      const rawShadow = shadowProperty.value;
      if (!rawShadow || typeof rawShadow !== 'object' || Array.isArray(rawShadow)) {
        materialized.push({ ...fallback, invalidReason: 'shadow candidate has invalid fields', invalidShadow: true });
        continue;
      }
      const shadowKeys = Object.keys(rawShadow);
      const enabled = Object.getOwnPropertyDescriptor(rawShadow, 'enabled');
      const digest = Object.getOwnPropertyDescriptor(rawShadow, 'artifactDigest');
      if (
        shadowKeys.length !== 2 || !shadowKeys.includes('enabled') ||
        !shadowKeys.includes('artifactDigest') || !enabled?.enumerable || !('value' in enabled) ||
        enabled.value !== true || !digest?.enumerable || !('value' in digest) ||
        typeof digest.value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest.value)
      ) {
        materialized.push({ ...fallback, invalidReason: 'shadow candidate has invalid fields', invalidShadow: true });
        continue;
      }
      shadow = Object.freeze({ enabled: true, artifactDigest: digest.value });
    }
    const candidate: RuntimeCandidateSpec = {
      engine: engineProperty.value as EngineId,
      ...(modelProperty ? { model: modelProperty.value as string | null } : {}),
      ...(shadow ? { shadow } : {}),
    };
    materialized.push(Object.freeze(candidate));
  }
  return Object.freeze(materialized);
}

async function runBestOfNInternal(
  item: WorkItem,
  cfg: AshlrConfig,
  opts?: {
    n?: number;
    workItemId?: string;
    workItemGenerationId?: string;
    workSource?: WorkSource;
    engine?: EngineId;
    model?: string | null;
    /**
     * Aggregate producer budget partitioned across candidates. In-process API
     * models enforce it preventively; external CLI engines receive it as an
     * advisory runner budget and remain outside this token-authority claim.
     */
    budget?: Partial<RunBudget>;
    /** Disable paid taste scoring when no separate judge authority exists. */
    disableTasteCritic?: boolean;
    /** M498: force-disable real judge resolution for this call regardless of cfg.foundry.bestOfNJudge. */
    disableJudge?: boolean;
    delegationScope?: DelegationScope;
    /** Opaque outer dispatch identity used to derive stable candidate run ids. */
    attemptId?: OuterAttemptIdentity;
    /** Immutable signed-card snapshot read once by the daemon tick. */
    shadowSkillCards?: readonly SkillCard[];
    /** Stable timestamp associated with the daemon's signed-card snapshot. */
    shadowSkillSelectedAt?: string;
    /** Optional owner cancellation shared by every candidate in this fan-out. */
    signal?: AbortSignal;
    /**
     * M333: per-candidate engine/model specs. Candidate i runs on
     * specs[i % specs.length] — one candidate per spec when n matches the
     * list length, cycling when the operator asks for more candidates than
     * specs. Absent → single-engine stochastic resampling (M142/M170
     * byte-identical).
     */
    candidates?: BestOfNCandidateSpec[];
    /** Daemon-side fail-closed refusal for an explicit malformed candidate list. */
    candidateConfigRefusal?: string;
    /**
     * Final fleet-only quota authority. When supplied, every runnable candidate
     * is admitted as one atomic batch before any producer runner is invoked.
     */
    reserveQuotaUses?: (
      requests: readonly FleetQuotaReservationRequest[],
    ) => FleetQuotaReservationResult;
    /** Final daemon ownership/telemetry fence, after quota admission. */
    beforeProviderDispatch?: () => boolean;
    /** Rechecked immediately before every provider or provider-inventory call. */
    providerDispatchStillAuthorized?: () => boolean;
    /** Final per-candidate authority/telemetry handoff immediately before the runner. */
    beforeCandidateProviderDispatch?: (backend: EngineId, runId: string) => boolean;
    /** Best-effort observation after the sandboxed runner has been invoked. */
    onProviderDispatchStarted?: (backend: EngineId, runId: string) => void;
  },
): Promise<BestOfNResult | { winner: undefined; candidates: CandidateResult[]; critique: BestOfNResult['critique'] }> {
  const n = readN(cfg, opts?.n);
  const goal = goalFor(item);
  const candidateOutputPersistenceEnabled =
    cfg.foundry?.runOutputPersistence?.enabled === true;

  // ── 1. Resolve sandbox runners ──────────────────────────────────────────
  // Import lazily so the module doesn't blow up when sandboxed-engine isn't
  // built yet (tests mock it).
  type SandboxedRunner = typeof import('./sandboxed-engine.js').runEngineSandboxed;
  type CaptureSandboxedProposal = typeof import('./sandboxed-engine.js').captureSandboxedProposal;
  let runEngineSandboxed: SandboxedRunner | undefined;
  let runApiModelSandboxed: SandboxedRunner | undefined;
  let captureSandboxedProposal: CaptureSandboxedProposal | undefined;
  try {
    const mod = await import('./sandboxed-engine.js');
    runEngineSandboxed = mod.runEngineSandboxed;
    runApiModelSandboxed = mod.runApiModelSandboxed;
    captureSandboxedProposal = mod.captureSandboxedProposal;
  } catch {
    // sandboxed-engine unavailable — all candidates will error
  }

  let createSandbox: ((sourceRepo: string, opts?: { allowAnyRepo?: boolean }) => Sandbox) | undefined;
  let removeSandbox: ((sb: Sandbox) => void) | undefined;
  try {
    const wt = await import('../sandbox/worktree.js');
    createSandbox = wt.createSandbox;
    removeSandbox = wt.removeSandbox;
  } catch {
    // sandbox worktree unavailable — candidates will use the legacy runner path.
  }

  // ── 2. Resolve judge ────────────────────────────────────────────────────
  let judgeProposal: typeof import('../fleet/manager.js').judgeProposal | undefined;
  let resolveFrontierJudgeClient: typeof import('../fleet/manager.js').resolveFrontierJudgeClient | undefined;
  try {
    const mod = await import('../fleet/manager.js');
    judgeProposal = mod.judgeProposal;
    resolveFrontierJudgeClient = mod.resolveFrontierJudgeClient;
  } catch {
    // manager unavailable — candidates will be unjudged; score falls back to 0
  }
  // M498: real-judge call accounting, surfaced via critique.judge below.
  // callsAttempted/callsFailed count ONLY calls made with a real,
  // independently resolved client — the always-present null-client fallback
  // call (which lets judgeProposal's own honest-fallback path run exactly as
  // it did before this change) is never counted as a "judge call" since it
  // never leaves the process.
  let judgeCallsAttempted = 0;
  let judgeCallsFailed = 0;
  const judgeModelsUsed = new Set<string>();
  const buildJudgeSummary = (
    candidatesForStatus: readonly CandidateResult[],
  ): NonNullable<BestOfNResult['critique']['judge']> => {
    const sources = new Set(
      candidatesForStatus
        .filter(candidateHasProposalMaterial)
        .map((candidate) => candidate.judgeSource)
        .filter((source): source is NonNullable<CandidateResult['judgeSource']> => source != null),
    );
    const status: NonNullable<BestOfNResult['critique']['judge']>['status'] =
      sources.has('real') ? 'real' : sources.has('unavailable') ? 'unavailable' : 'skipped';
    return {
      status,
      ...(judgeModelsUsed.size > 0 ? { models: [...judgeModelsUsed] } : {}),
      callsAttempted: judgeCallsAttempted,
      callsFailed: judgeCallsFailed,
    };
  };

  // ── 3b. Resolve taste critic (M183 — flag-gated) ───────────────────────
  const tasteCriticConfigured = (cfg.foundry as { tasteCritic?: unknown } | undefined)?.tasteCritic;
  const tasteCriticEnabled = opts?.disableTasteCritic !== true
    && opts?.budget === undefined
    && !!tasteCriticConfigured;
  type ScoreTasteFn = typeof import('../fleet/taste-critic.js').scoreTaste;
  let scoreTaste: ScoreTasteFn | undefined;
  if (tasteCriticEnabled) {
    try {
      const mod = await import('../fleet/taste-critic.js');
      scoreTaste = mod.scoreTaste;
    } catch {
      // taste-critic unavailable — degrade gracefully (no taste scores)
    }
  }

  let loadProposal: typeof import('../inbox/store.js').loadProposal | undefined;
  try {
    const mod = await import('../inbox/store.js');
    loadProposal = mod.loadProposal;
  } catch {
    // Inbox unavailable in tests/partial builds — fall back to synthetic diffs.
  }

  // ── 4. Choose engine ────────────────────────────────────────────────────
  // Engine selection priority:
  //   1. Use 'local-coder' if it appears in cfg.foundry.allowedBackends.
  //   2. Otherwise use the first allowed backend (whatever the operator configured).
  //   3. If allowedBackends is empty, default to 'local-coder'.
  // If the selected runner is unavailable we can't generate candidates — they will all error below.
  const defaultEngine = (() => {
    if (opts?.engine) return opts.engine;
    const allowed = cfg.foundry?.allowedBackends ?? [];
    // Prefer 'local-coder' if explicitly allowed
    if (allowed.includes('local-coder' as import('../types.js').EngineId)) {
      return 'local-coder' as import('../types.js').EngineId;
    }
    // Fall back to the first configured backend, or 'local-coder' as last resort
    return allowed[0] ?? ('local-coder' as import('../types.js').EngineId);
  })();
  // M333: multi-model candidate specs — absent → the single-engine
  // stochastic-resampling behavior, byte-identical to M142/M170.
  let specs: readonly RuntimeCandidateSpec[];
  if (opts?.candidateConfigRefusal) {
    specs = Object.freeze([{
      engine: defaultEngine,
      model: opts?.model ?? null,
      invalidReason: opts.candidateConfigRefusal,
    }]);
  } else try {
    specs = materializeCandidateSpecs(
      opts?.candidates,
      { engine: defaultEngine, model: opts?.model ?? null },
    );
  } catch {
    specs = Object.freeze([{
      engine: defaultEngine,
      model: opts?.model ?? null,
      invalidReason: 'candidate specs could not be materialized',
    }]);
  }
  const invalidSpec = specs.find((spec) => spec.invalidReason !== undefined);
  if (invalidSpec) {
    // An explicit candidate list is one authority-bearing configuration unit.
    // Never let a valid sibling run when another entry was malformed: doing so
    // could turn an intended shadow-only race into an ordinary proposal-capable
    // execution. Collapse the entire list to a refusal before fan-out.
    specs = Object.freeze([{
      engine: defaultEngine,
      model: opts?.model ?? null,
      invalidReason: invalidSpec.invalidReason,
      ...(invalidSpec.invalidShadow ? { invalidShadow: true as const } : {}),
    }]);
  }
  const runnerFor = (e: EngineId): typeof runEngineSandboxed => {
    const spec = resolveEngineSpec(e, cfg);
    return spec?.kind === 'api-model' ? runApiModelSandboxed : runEngineSandboxed;
  };
  const missingRunnerMessageFor = (e: EngineId): string =>
    resolveEngineSpec(e, cfg)?.kind === 'api-model'
      ? 'api-model sandbox runner unavailable'
      : 'cli-agent sandbox runner unavailable';

  type CandidatePlan = {
    index: number;
    spec: RuntimeCandidateSpec;
    runId?: string;
    runIdError?: string;
  };
  const candidatePlans: CandidatePlan[] = Array.from({ length: n }, (_, index) => {
    const spec = specs[index % specs.length]!;
    try {
      return {
        index,
        spec,
        runId: opts?.attemptId
          ? deriveCandidateAttemptIdentity(opts.attemptId, index)
          : `best-of-n-${index}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      };
    } catch (error) {
      return {
        index,
        spec,
        runIdError: error instanceof Error ? error.message : 'invalid attempt identity',
      };
    }
  });

  let quotaReservation: FleetQuotaReservationResult | undefined;
  let providerDispatchPreflightRefusal: string | undefined;
  let reservableCount = 0;
  if (opts?.reserveQuotaUses) {
    const reservable = candidatePlans.filter((plan) =>
      plan.runId !== undefined && plan.spec.invalidReason === undefined && !!runnerFor(plan.spec.engine));
    reservableCount = reservable.length;
    if (reservable.length > 0) {
      try {
        const requests = reservable.map((plan) => ({
          backend: plan.spec.engine,
          dispatchId: plan.runId!,
        }));
        const observed = opts.reserveQuotaUses(requests);
        const validAuthorized = observed && typeof observed === 'object' &&
          observed.launchAuthorized === true &&
          (observed.kind === 'reserved' || observed.kind === 'unlimited') &&
          Array.isArray(observed.reservations) && observed.reservations.length === requests.length &&
          observed.reservations.every((receipt, index) =>
            receipt?.backend === requests[index]?.backend &&
            (receipt.status === 'reserved' || receipt.status === 'unlimited') &&
            Number.isSafeInteger(receipt.used) && receipt.used >= 0 &&
            (receipt.limit === null || (Number.isSafeInteger(receipt.limit) && receipt.limit > 0)));
        const validRefusal = observed && typeof observed === 'object' &&
          observed.launchAuthorized === false && [
            'invalid', 'duplicate', 'conflict', 'exhausted', 'unavailable', 'capacity',
          ].includes(observed.kind);
        quotaReservation = validAuthorized || validRefusal
          ? observed
          : { kind: 'invalid', launchAuthorized: false };
        if (quotaReservation.launchAuthorized && !validAuthorized) {
          quotaReservation = { kind: 'invalid', launchAuthorized: false };
        }
      } catch {
        quotaReservation = { kind: 'unavailable', launchAuthorized: false };
      }
    }
  }
  if (reservableCount > 0 && (!quotaReservation || quotaReservation.launchAuthorized) &&
    opts?.beforeProviderDispatch) {
    try {
      if (opts.beforeProviderDispatch() !== true) {
        providerDispatchPreflightRefusal = 'provider-dispatch-preflight-refused';
      }
    } catch {
      providerDispatchPreflightRefusal = 'provider-dispatch-preflight-unavailable';
    }
  }

  const sourceRepo = item.repo ?? process.cwd();
  const parentDelegationScope =
    opts?.delegationScope ??
    scopeFromWorkItem(item, {
      backend: {
        engine: defaultEngine,
        model: opts?.model ?? null,
        assignedBy: 'best-of-n',
        reason: `best-of-${n} default scope`,
      },
    });

  // ── 5. Generate N candidates with bounded internal concurrency ──────────
  const candidateBudget = partitionFanOutBudget(opts?.budget, n);
  const generateCandidate = async (plan: CandidatePlan): Promise<InternalCandidateResult> => {
    const i = plan.index;
    // Vary temperature and seed so candidates differ across calls.
    // We pass opts into the sandbox via model override naming conventions where
    // supported; the primary divergence comes from the engine's own stochasticity.
    const spec = plan.spec;
    const cEngine = spec.engine;
    const requestedModel = spec.model ?? null;
    const engineSpec = resolveEngineSpec(cEngine, cfg);
    const cModel = requestedModel
      ?? cfg.foundry?.models?.[cEngine]
      ?? engineSpec?.defaultModel
      ?? engineSpec?.api?.defaultModel
      ?? 'default';
    if (!plan.runId) {
      return {
        index: i,
        diff: '',
        score: 0,
        engine: cEngine,
        model: cModel,
        providerDispatchAttempted: false,
        error: plan.runIdError ?? 'invalid attempt identity',
      };
    }
    const runId = plan.runId;
    const shadowConfig = parseShadowConfig(spec);
    let base: InternalCandidateResult = {
      index: i,
      diff: '',
      score: 0,
      engine: cEngine,
      model: cModel,
      runId,
      trajectoryId: `run:${runId}`,
      requestedModel,
      providerDispatchAttempted: false,
      ...(shadowConfig.kind !== 'off' || spec.invalidShadow
        ? { shadow: true, shadowParticipated: false }
        : {}),
    };
    if (opts?.signal?.aborted) {
      return {
        ...base,
        ...(shadowConfig.kind === 'on' ? { shadowIdentityStatus: 'refused' as const } : {}),
        error: 'cancelled',
      };
    }
    const t0 = Date.now();
    if (spec.invalidReason) {
      return {
        ...base,
        ...(spec.invalidShadow ? { shadowIdentityStatus: 'refused' as const } : {}),
        latencyMs: 0,
        error: `candidate configuration refused: ${spec.invalidReason}`,
      };
    }
    if (
      shadowConfig.kind === 'invalid' ||
      (shadowConfig.kind === 'on' && (
        cEngine !== 'local-coder' || typeof spec.model !== 'string' ||
        spec.model.length === 0 || spec.model.length > 256
      ))
    ) {
      return {
        ...base,
        shadowIdentityStatus: 'refused',
        latencyMs: Date.now() - t0,
        error: 'shadow identity refused: invalid-config',
      };
    }
    // The legacy compatibility path asks the runner to file immediately. A
    // shadow must never enter that path: without both isolated-worktree and
    // draft-only capture primitives, refuse before inventory or model contact.
    if (shadowConfig.kind === 'on' && (!captureSandboxedProposal || !createSandbox)) {
      return {
        ...base,
        shadowIdentityStatus: 'refused',
        latencyMs: Date.now() - t0,
        error: 'shadow execution refused: draft-capture unavailable',
      };
    }
    const runSandboxed = runnerFor(cEngine);
    if (!runSandboxed) {
      return { ...base, error: missingRunnerMessageFor(cEngine) };
    }
    if (quotaReservation && !quotaReservation.launchAuthorized) {
      return {
        ...base,
        quotaReservation,
        providerDispatchAttempted: false,
        error: `quota-reservation-refused:${quotaReservation.kind}`,
      };
    }
    if (quotaReservation) {
      base = { ...base, quotaReservation, providerDispatchAttempted: false };
    }
    if (providerDispatchPreflightRefusal) {
      return {
        ...base,
        providerDispatchAttempted: false,
        error: providerDispatchPreflightRefusal,
      };
    }
    const providerStillAuthorized = (): boolean => {
      if (opts?.signal?.aborted) return false;
      if (!opts?.providerDispatchStillAuthorized) return true;
      try {
        return opts.providerDispatchStillAuthorized() === true;
      } catch {
        return false;
      }
    };
    const providerFenceRefusal = (): InternalCandidateResult => ({
      ...base,
      providerDispatchAttempted: false,
      error: 'provider-dispatch-final-fence-refused',
    });
    const admitProviderDispatchAttempt = (): boolean => {
      if (!providerStillAuthorized()) return false;
      if (opts?.beforeCandidateProviderDispatch) {
        try {
          if (opts.beforeCandidateProviderDispatch(cEngine, runId) !== true) return false;
        } catch {
          return false;
        }
      }
      // Close the synchronous callback/telemetry gap before runner invocation.
      if (!providerStillAuthorized()) return false;
      base = { ...base, providerDispatchAttempted: true };
      return true;
    };
    let verifiedShadowBaseUrl: string | undefined;
    if (shadowConfig.kind === 'on') {
      const baseUrlEnv = engineSpec?.api?.baseUrlEnv;
      const configuredBaseUrl = (baseUrlEnv && process.env[baseUrlEnv]?.trim()) ||
        engineSpec?.api?.defaultBaseUrl || '';
      const baseUrl = normalizeNumericLoopbackOllamaBaseUrl(configuredBaseUrl);
      if (!baseUrl) {
        return {
          ...base,
          shadowIdentityStatus: 'refused',
          latencyMs: Date.now() - t0,
          error: 'shadow identity refused: non-loopback-endpoint',
        };
      }
      if (!providerStillAuthorized()) return providerFenceRefusal();
      const verification = await verifyOllamaModelIdentity({
        baseUrl,
        model: spec.model!,
        expectedDigest: shadowConfig.artifactDigest,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      if (!verification.ok) {
        return {
          ...base,
          shadowIdentityStatus: 'refused',
          ...(verification.identity ? { artifactIdentity: verification.identity } : {}),
          latencyMs: Date.now() - t0,
          error: `shadow identity refused: ${verification.reason}`,
        };
      }
      base = {
        ...base,
        shadowIdentityStatus: 'verified',
        artifactIdentity: verification.identity,
      };
      verifiedShadowBaseUrl = baseUrl;
    }

    let ownedSandbox: Sandbox | undefined;
    let observedCandidateState: RunState | undefined;
    let observedCandidateStreamClaim: RunOutputStreamClaim | undefined;
    try {
      const observeExecutedCandidate = (state: RunState, proposalOutcome?: RunProposalOutcome): void => {
        const actionCounts = state.runEventSummary?.actionCounts;
        const executed = state.status === 'done' || [
          actionCounts?.spawnAttempts,
          actionCounts?.modelSteps,
          actionCounts?.toolSteps,
          actionCounts?.totalSteps,
        ].some((count) => typeof count === 'number' && count > 0);
        if (
          !executed ||
          proposalOutcome?.kind === 'kill-switch' ||
          !opts?.attemptId ||
          !opts.shadowSkillSelectedAt ||
          !opts.shadowSkillCards?.length
        ) return;
        const executedBackend = state.engine || cEngine;
        const engineModelPrefix = `${executedBackend}:`;
        const reportedModel = state.engineModel?.startsWith(engineModelPrefix)
          ? state.engineModel.slice(engineModelPrefix.length)
          : cModel;
        const allowedModels = new Set([
          requestedModel,
          cfg.foundry?.models?.[cEngine],
          engineSpec?.defaultModel,
          engineSpec?.api?.defaultModel,
        ].filter((model): model is string => typeof model === 'string' && model.length > 0));
        const executedModel = allowedModels.has(reportedModel) ? reportedModel : null;
        const executedTier = state.engineTier ?? engineSpec?.tier ?? null;
        observeShadowSkills({
          cards: opts.shadowSkillCards,
          query: {
            title: item.title,
            detail: item.detail,
            source: item.source,
            tags: item.tags,
            route: {
              backend: executedBackend,
              tier: executedTier,
              model: executedModel,
              reason: `best-of-${n} candidate ${i + 1}`,
            },
          },
          identity: { trajectoryId: `run:${runId}`, runId },
          selectedAt: opts.shadowSkillSelectedAt,
          route: {
            backend: executedBackend,
            tier: executedTier,
            model: executedModel,
          },
        });
      };
      const delegationScope = mergeDelegationScope(parentDelegationScope, {
        origin: 'best-of-n',
        runId,
        taskId: `candidate-${i}`,
        sourceRepo,
        executionRoot: sourceRepo,
        objective: item.title,
        backend: {
          engine: cEngine,
          model: requestedModel,
          assignedBy: 'best-of-n',
          reason: `candidate ${i + 1}/${n}`,
        },
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: false },
      });
      const effectiveCandidateBudget = shadowConfig.kind === 'on'
        ? constrainCandidateBudget(candidateBudget, {
            maxTokens: SHADOW_MAX_TOKENS,
            maxSteps: SHADOW_MAX_STEPS,
            allowCloud: false,
          })
        : candidateBudget;
      const startCandidateObservation = async (): Promise<CandidateObservationOwnership> => {
        const now = new Date().toISOString();
        const candidateState: RunState = {
          id: runId,
          goal: `Best-of-N candidate ${i + 1}`,
          engine: cEngine,
          provider: engineSpec?.kind === 'api-model'
            ? (engineSpec.api?.protocol ?? 'openai-compat')
            : 'external',
          engineModel: `${cEngine}:${cModel}`,
          engineTier: engineSpec?.tier,
          createdAt: now,
          updatedAt: now,
          budget: {
            maxTokens: effectiveCandidateBudget?.maxTokens ?? 0,
            maxSteps: effectiveCandidateBudget?.maxSteps ?? 0,
            allowCloud: effectiveCandidateBudget?.allowCloud ?? false,
          },
          usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
          tasks: [{
            id: `candidate-${i}`,
            goal: `Candidate task ${i + 1}`,
            deps: [],
            status: 'running',
          }],
          steps: [],
          status: 'running',
        };
        const ownership = await startCandidateOutputObservation(cfg, candidateState, i);
        if (ownership.ok) {
          observedCandidateState = ownership.state;
          observedCandidateStreamClaim = ownership.streamClaim;
        }
        return ownership;
      };
      const finishCandidateObservation = async (state: RunState): Promise<void> => {
        if (observedCandidateState) {
          observedCandidateState = await updateCandidateOutputObservation(state, i, observedCandidateState);
        }
      };
      const candidateObservationRefusal = (
        reason: CandidateObservationOwnership & { ok: false },
        sandbox?: Sandbox,
      ): InternalCandidateResult => ({
        ...base,
        providerDispatchAttempted: false,
        latencyMs: Date.now() - t0,
        error: reason.reason,
        ...(sandbox ? { sandbox } : {}),
      });

      if (captureSandboxedProposal && createSandbox) {
        let sb: Sandbox;
        try {
          sb = createSandbox(sourceRepo, {
            allowAnyRepo: process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1',
          });
          ownedSandbox = sb;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ...base,
            latencyMs: Date.now() - t0,
            error: `sandbox unavailable: ${msg}`,
          };
        }

        if (!admitProviderDispatchAttempt()) return providerFenceRefusal();
        if (candidateOutputPersistenceEnabled) {
          const ownership = await startCandidateObservation();
          if (!ownership.ok) return candidateObservationRefusal(ownership, sb);
        }
        const pendingResult = runSandboxed(cEngine as import('../types.js').EngineId, goal, cfg, {
          ...(typeof requestedModel === 'string' ? { model: requestedModel } : {}),
          sourceRepo,
          ...(effectiveCandidateBudget ? { budget: effectiveCandidateBudget } : {}),
          propose: false,
          ...(shadowConfig.kind === 'on'
            ? {
                localShadowBinding: {
                  baseUrl: verifiedShadowBaseUrl!,
                  model: spec.model!,
                  requestTimeoutMs: SHADOW_REQUEST_TIMEOUT_MS,
                  maxRequestBytes: SHADOW_REQUEST_MAX_BYTES,
                  maxResponseBytes: SHADOW_RESPONSE_MAX_BYTES,
                  maxOutputTokens: SHADOW_MAX_OUTPUT_TOKENS,
                },
              }
            : {}),
          existingWorktree: sb,
          runId,
          ...(observedCandidateStreamClaim
            ? { runOutputStreamClaim: observedCandidateStreamClaim }
            : {}),
          workItemId: opts?.workItemId ?? item.id,
          workItemGenerationId: opts?.workItemGenerationId,
          workSource: opts?.workSource ?? item.source,
          ...(delegationScope ? { delegationScope } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        try { opts?.onProviderDispatchStarted?.(cEngine, runId); } catch { /* telemetry only */ }
        const result = await pendingResult;
        if (candidateOutputPersistenceEnabled) await finishCandidateObservation(result.state);
        if (shadowConfig.kind === 'on' && result.providerContacted === true) {
          base = { ...base, shadowParticipated: true };
        }
        const generationOutcome = result.proposalOutcome ?? result.state.proposalOutcome;
        observeExecutedCandidate(result.state, generationOutcome);
        if (result.sandboxRetention) {
          return {
            ...base,
            ...(shadowConfig.kind === 'on' ? { shadowIdentityStatus: 'refused' as const } : {}),
            latencyMs: Date.now() - t0,
            error: shadowConfig.kind === 'on'
              ? 'shadow execution refused: post-inference identity not verified'
              : candidateErrorFromState(result.state, false, generationOutcome),
            sandbox: sb,
            sandboxRetention: result.sandboxRetention,
            runId,
            delegationScope,
            state: result.state,
            ...(generationOutcome ? { proposalOutcome: generationOutcome } : {}),
            ...(typeof result.state.usage?.estCostUsd === 'number'
              ? { costUsd: result.state.usage.estCostUsd }
              : {}),
          };
        }
        if (opts?.signal?.aborted) {
          const generationError = candidateErrorFromState(result.state, false, generationOutcome);
          return {
            ...base,
            ...(shadowConfig.kind === 'on' ? { shadowIdentityStatus: 'refused' as const } : {}),
            latencyMs: Date.now() - t0,
            error: shadowConfig.kind === 'on'
              ? 'shadow execution refused: cancelled before post-inference identity verification'
              : generationError ?? 'cancelled',
            sandbox: sb,
            runId,
            delegationScope,
            state: result.state,
            ...(generationOutcome ? { proposalOutcome: generationOutcome } : {}),
            ...(typeof result.state.usage?.estCostUsd === 'number'
              ? { costUsd: result.state.usage.estCostUsd }
              : {}),
          };
        }

        if (shadowConfig.kind === 'on') {
          if (!providerStillAuthorized()) {
            return {
              ...base,
              shadowIdentityStatus: 'refused',
              latencyMs: Date.now() - t0,
              error: 'shadow identity refused: final authority lost before post-inference verification',
              sandbox: sb,
              runId,
              delegationScope,
              state: result.state,
            };
          }
          const postVerification = await verifyOllamaModelIdentity({
            baseUrl: verifiedShadowBaseUrl!,
            model: spec.model!,
            expectedDigest: shadowConfig.artifactDigest,
            ...(opts?.signal ? { signal: opts.signal } : {}),
          });
          if (!postVerification.ok) {
            return {
              ...base,
              shadowIdentityStatus: 'refused',
              ...(postVerification.identity ? { artifactIdentity: postVerification.identity } : {}),
              latencyMs: Date.now() - t0,
              error: `shadow identity refused after inference: ${postVerification.reason}`,
              sandbox: sb,
              runId,
              delegationScope,
              state: result.state,
              ...(typeof result.state.usage?.estCostUsd === 'number'
                ? { costUsd: result.state.usage.estCostUsd }
                : {}),
            };
          }
          base = { ...base, artifactIdentity: postVerification.identity };
        }

        const draft = await captureSandboxedProposal(cEngine, goal, cfg, {
          sourceRepo,
          existingWorktree: sb,
          ...(effectiveCandidateBudget ? { budget: effectiveCandidateBudget } : {}),
          draftOnly: true,
          ...(typeof requestedModel === 'string' ? { model: requestedModel } : {}),
          runId,
          workItemId: opts?.workItemId ?? item.id,
          workItemGenerationId: opts?.workItemGenerationId,
          workSource: opts?.workSource ?? item.source,
          ...(delegationScope ? { delegationScope } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
          sourceLabel: 'Best-of-N draft',
          isPartial: result.state.status !== 'done',
          usage: result.state.usage,
          producerStatus: result.state.status,
        });

        const proposalOutcome = draft.proposalOutcome ?? result.proposalOutcome ?? result.state.proposalOutcome;
        const proposalDraft = draft.proposalDraft;
        const diff = proposalDraft?.diff ?? '';
        const hasMaterial = !!proposalDraft || diff.trim().length > 0;
        const stateForCandidate = proposalDraft ? result.state : draft.state;
        const candidateError = candidateErrorFromState(stateForCandidate, hasMaterial, proposalOutcome);
        return {
          ...base,
          diff,
          ...(proposalDraft ? { proposalDraft } : {}),
          ...(proposalOutcome ? { proposalOutcome } : {}),
          latencyMs: Date.now() - t0,
          ...(typeof result.state.usage?.estCostUsd === 'number'
            ? { costUsd: result.state.usage.estCostUsd }
            : {}),
          ...(candidateError ? { error: candidateError } : {}),
          sandbox: sb,
          runId,
          delegationScope,
          state: stateForCandidate,
        };
      }

      if (!admitProviderDispatchAttempt()) return providerFenceRefusal();
      if (candidateOutputPersistenceEnabled) {
        const ownership = await startCandidateObservation();
        if (!ownership.ok) return candidateObservationRefusal(ownership);
      }
      const pendingResult = runSandboxed(cEngine as import('../types.js').EngineId, goal, cfg, {
        ...(typeof requestedModel === 'string' ? { model: requestedModel } : {}),
        sourceRepo,
        ...(effectiveCandidateBudget ? { budget: effectiveCandidateBudget } : {}),
        propose: true,
        runId,
        ...(observedCandidateStreamClaim
          ? { runOutputStreamClaim: observedCandidateStreamClaim }
          : {}),
        workItemId: opts?.workItemId ?? item.id,
        workItemGenerationId: opts?.workItemGenerationId,
        workSource: opts?.workSource ?? item.source,
        ...(delegationScope ? { delegationScope } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      try { opts?.onProviderDispatchStarted?.(cEngine, runId); } catch { /* telemetry only */ }
      const result = await pendingResult;
      if (candidateOutputPersistenceEnabled) await finishCandidateObservation(result.state);
      const proposalOutcome = result.proposalOutcome ?? result.state.proposalOutcome;
      observeExecutedCandidate(result.state, proposalOutcome);
      if (opts?.signal?.aborted) {
        const diff = typeof result.state.result === 'string' ? result.state.result : '';
        const hasMaterial = !!result.proposalId;
        const candidateError = candidateErrorFromState(result.state, hasMaterial, proposalOutcome);
        return {
          ...base,
          diff,
          ...(result.proposalId ? { proposalId: result.proposalId } : {}),
          ...(proposalOutcome ? { proposalOutcome } : {}),
          ...(result.sandboxRetention ? { sandboxRetention: result.sandboxRetention } : {}),
          latencyMs: Date.now() - t0,
          error: candidateError ?? 'cancelled',
          state: result.state,
          ...(typeof result.state.usage?.estCostUsd === 'number'
            ? { costUsd: result.state.usage.estCostUsd }
            : {}),
        };
      }
      const diff = (result.state as unknown as Record<string, unknown>)['result'] as string ?? '';
      // The actual diff patch lives in the proposal; the state.result is the
      // engine's stdout. We'll use proposalId to fetch the diff from the inbox
      // if needed — but for scoring we work with what we have.
      const hasMaterial = !!result.proposalId;
      const candidateError = candidateErrorFromState(result.state, hasMaterial, proposalOutcome);
      return {
        ...base,
        diff: typeof diff === 'string' ? diff : '',
        proposalId: result.proposalId,
        ...(proposalOutcome ? { proposalOutcome } : {}),
        ...(result.sandboxRetention ? { sandboxRetention: result.sandboxRetention } : {}),
        latencyMs: Date.now() - t0,
        ...(typeof result.state.usage?.estCostUsd === 'number'
          ? { costUsd: result.state.usage.estCostUsd }
          : {}),
        ...(candidateError ? { error: candidateError } : {}),
        state: result.state,
      } as InternalCandidateResult;
    } catch (err) {
      if (observedCandidateState) {
        observedCandidateState = await updateCandidateOutputObservation({
          ...observedCandidateState,
          updatedAt: new Date().toISOString(),
          status: 'failed',
          result: 'candidate runner failed',
          tasks: observedCandidateState.tasks.map((task) => ({
            ...task,
            status: task.status === 'running' ? 'failed' : task.status,
            ...(task.status === 'running' ? { error: 'candidate runner failed' } : {}),
          })),
        }, i, observedCandidateState);
      }
      return {
        ...base,
        ...(shadowConfig.kind === 'on' ? { shadowIdentityStatus: 'refused' as const } : {}),
        latencyMs: Date.now() - t0,
        error: shadowConfig.kind === 'on'
          ? `shadow execution refused before post-inference identity verification: ${
              err instanceof Error ? err.message : String(err)
            }`
          : err instanceof Error ? err.message : String(err),
        ...(ownedSandbox ? { sandbox: ownedSandbox } : {}),
      };
    }
  };

  let rawCandidates: InternalCandidateResult[] = [];
  let scored: InternalCandidateResult[] = [];
  const costsFor = async (candidates: InternalCandidateResult[]): Promise<{
    totalCostUsd: number;
    billableCostUsd: number;
  }> => {
    let isSubscription: ((engine: string) => boolean) | undefined;
    try {
      const mod = await import('../fleet/subscription-usage.js');
      isSubscription = mod.isSubscriptionEngine as (engine: string) => boolean;
    } catch {
      // Conservative fallback: treat every candidate as billable.
    }
    return {
      totalCostUsd: candidates.reduce((sum, candidate) => sum + (candidate.costUsd ?? 0), 0),
      billableCostUsd: candidates.reduce(
        (sum, candidate) =>
          sum + (isSubscription && candidate.engine && isSubscription(String(candidate.engine))
            ? 0
            : (candidate.costUsd ?? 0)),
        0,
      ),
    };
  };
  const recordCandidates = async (
    candidates: InternalCandidateResult[],
    totalCostUsd: number,
    winner?: InternalCandidateResult,
  ): Promise<void> => {
    const winnerPid = winner?.proposalId;
    try {
      const { recordBestOfN } = await import('../fleet/best-of-n-ledger.js');
      recordBestOfN({
        ts: new Date().toISOString(),
        ...(opts?.attemptId ? { attemptId: opts.attemptId } : {}),
        workItemId: opts?.workItemId ?? item.id,
        source: String(item.source ?? ''),
        repo: item.repo ?? null,
        n,
        winnerIndex: winner?.index ?? -1,
        winnerProposalId: winnerPid ?? null,
        totalCostUsd,
        candidates: candidates.map((c) => {
          const selectionWon = c.proposalId != null && c.proposalId === winnerPid;
          const isPartial = candidateHasPartialProposalMaterial(c);
          const producerStatus = c.state?.status ?? (c.error ? 'failed' as const : undefined);
          const fullProposalWon = selectionWon && !isPartial && producerStatus === 'done' &&
            c.proposalOutcome?.kind === 'filed';
          return {
            index: c.index,
            ...(c.runId ? { runId: c.runId } : {}),
            engine: String(c.engine ?? ''),
            model: c.model ?? null,
            score: c.score,
            ...(c.testsPassed !== undefined ? { testsPassed: c.testsPassed } : {}),
            ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}),
            ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
            ...(c.shadow === true ? { shadow: true as const } : {}),
            ...(c.shadow === true
              ? {
                  shadowParticipated: c.shadowParticipated === true,
                  shadowJudged: c.shadowIdentityStatus === 'verified' && c.verdict !== undefined,
                  ...(c.shadowIdentityStatus === 'verified' && c.testsPassed !== undefined
                    ? { shadowTestPassed: c.testsPassed }
                    : {}),
                  shadowScore: c.score,
                  shadowWouldHaveWon: c.shadowWouldHaveWon === true,
                }
              : {}),
            ...(c.shadowIdentityStatus ? { shadowIdentityStatus: c.shadowIdentityStatus } : {}),
            ...(c.artifactIdentity
              ? {
                  artifactDigest: c.artifactIdentity.digest,
                  artifactName: c.artifactIdentity.name,
                  artifactSizeBytes: c.artifactIdentity.size,
                  artifactDetails: c.artifactIdentity.details,
                }
              : {}),
            ...(c.error ? { error: c.error } : {}),
            ...(c.proposalOutcome
              ? {
                  proposalOutcome: c.proposalOutcome.kind,
                  proposalOutcomeReason: c.proposalOutcome.reason,
                }
              : {}),
            ...(producerStatus ? { producerStatus } : {}),
            isPartial,
            selectionWon,
            fullProposalWon,
            proposalId: selectionWon ? c.proposalId! : null,
            // Compatibility alias: historical readers interpret `won` as selection.
            won: selectionWon,
          };
        }),
      });
    } catch {
      // Ledger capture is best-effort and must not change execution results.
    }
  };
  const cancelledSelection = async (
    candidates: InternalCandidateResult[],
  ): Promise<{
    winner: undefined;
    candidates: CandidateResult[];
    critique: BestOfNResult['critique'];
  }> => {
    candidates = candidates.map((candidate) => candidate.shadow === true &&
      candidate.shadowWouldHaveWon === undefined
      ? { ...candidate, shadowWouldHaveWon: false }
      : candidate);
    const { totalCostUsd, billableCostUsd } = await costsFor(candidates);
    await recordCandidates(candidates, totalCostUsd);
    const actualReasons = summarizeNoProposalReasons(candidates);
    return {
      winner: undefined,
      candidates: candidates.map(publicCandidate),
      critique: {
        n,
        nonEmpty: candidates.filter(candidateHasProposalMaterial).length,
        judged: candidates.filter((candidate) => candidate.verdict != null).length,
        topScore: candidates.reduce((top, candidate) => Math.max(top, candidate.score), 0),
        winnerIndex: -1,
        totalCostUsd,
        billableCostUsd,
        noProposalReasons: [
          { reason: 'selection cancelled', count: 1 },
          ...actualReasons.filter((entry) => entry.reason !== 'selection cancelled'),
        ].slice(0, 8),
        judge: buildJudgeSummary(candidates),
      },
    };
  };

  try {
    rawCandidates = await mapWithConcurrency(
      candidatePlans,
      MAX_BEST_OF_N_CONCURRENCY,
      generateCandidate,
    );

    if (opts?.signal?.aborted) {
      scored = rawCandidates;
      return cancelledSelection(scored);
    }

    // ── 6. Filter empty diffs ─────────────────────────────────────────────
    // A candidate is "non-empty" when it produced proposal material. In the
    // default file-once path that material is a draft captured from the live
    // sandbox; legacy test/partial-build paths may still expose proposalId.
    const withProposals = rawCandidates.filter(candidateHasProposalMaterial);

    // ── 7. Score each non-empty candidate via the critic ──────────────────
    // M498: real judge wiring. Before this fix every call used
    // buildNullJudgeClient() unconditionally — a client whose complete()
    // always returns '', so parseJudgeResponse('') always failed and every
    // candidate "score" was manager.ts's synthetic parse-failure fallback
    // (value=correctness=scope=alignment=3 → score 8, identical for every
    // candidate, every run). Selection was therefore always the deterministic
    // tiebreak heuristic, never a real judgment, despite the config surface
    // (foundry.bestOfN + tasteCritic) implying a critic scores candidates.
    //
    // Fix: attempt a REAL, independent judge using the SAME resolver +
    // independence rule as inbox/merge.ts's Gate 7 and fleet/model-racing.ts
    // — a judge must not share a model family with the engine that produced
    // the candidate it scores, or it could rubber-stamp its own output.
    //
    // Cost + safety default: OFF unless the operator explicitly sets
    // cfg.foundry.bestOfNJudge=true. Judging N candidates costs N judge calls
    // on top of N generation calls; silently enabling that for every existing
    // best-of-N dispatch site (including the live daemon, once this ships in
    // a build) would multiply spend without operator consent. Even when
    // enabled, judging only runs when ≥2 candidates carry materially distinct
    // proposal content (by diff string — a cheap proxy; a proposalId-only
    // candidate without a captured draft compares by its placeholder `diff`,
    // which may under/over-count distinctness, but this only affects the
    // cost-bound heuristic, never correctness of an actual judged verdict):
    // clones of the sole distinct diff can't be usefully ranked, so a call
    // would just spend money confirming what the heuristic tiebreak already
    // knows.
    const bestOfNJudgeConfigured =
      (cfg.foundry as Record<string, unknown> | undefined)?.['bestOfNJudge'] === true;
    const judgeEnabled = opts?.disableJudge !== true && bestOfNJudgeConfigured;
    const distinctCandidateDiffs = new Set(
      withProposals.map((c) => c.proposalDraft?.diff ?? c.diff),
    );
    const judgeCostBoundOk = withProposals.length >= 2 && distinctCandidateDiffs.size >= 2;
    const judgePolicy: 'attempt' | 'skip' = judgeEnabled && judgeCostBoundOk ? 'attempt' : 'skip';

    // Honest fallback: unlike the pre-fix code, this client is used ONLY when
    // no real judging was attempted (config off, cost-bound skip, or no
    // independent client resolvable) — its synthetic verdict is filtered out
    // below (judgeFailure check) rather than allowed to masquerade as a score.
    const nullJudgeClient = buildNullJudgeClient();
    const judgeClientCache = new Map<string, FrontierJudgeClient | null>();
    const resolveJudgeFor = (c: InternalCandidateResult): FrontierJudgeClient | null => {
      if (!resolveFrontierJudgeClient) return null;
      const engine = String(c.engine ?? defaultEngine);
      const producerModel = `${engine}:${c.model ?? engine}`;
      const cached = judgeClientCache.get(producerModel);
      if (cached !== undefined) return cached;
      let resolved: FrontierJudgeClient | null;
      try {
        resolved = resolveFrontierJudgeClient(cfg, { producerModel, requireIndependent: true });
      } catch {
        resolved = null;
      }
      judgeClientCache.set(producerModel, resolved);
      return resolved;
    };

    scored = await mapWithConcurrency(
      rawCandidates,
      MAX_BEST_OF_N_CONCURRENCY,
      async (c): Promise<InternalCandidateResult> => {
        if (opts?.signal?.aborted) return c;
        if (!candidateHasProposalMaterial(c)) return c;

        let verdict: ManagerVerdict | undefined;
        let score = 0;
        let testsPassed: boolean | undefined;
        const proposal = proposalForCandidate(item, c, loadProposal);

        // Score via judge
        let judgeSource: NonNullable<CandidateResult['judgeSource']> = 'unavailable';
        if (judgeProposal) {
          let client: FrontierJudgeClient | ReturnType<typeof buildNullJudgeClient> = nullJudgeClient;
          if (judgePolicy === 'attempt') {
            const resolved = resolveJudgeFor(c);
            if (resolved) {
              judgeSource = 'real';
              client = resolved;
              judgeCallsAttempted += 1;
              judgeModelsUsed.add(resolved.model);
            } else {
              judgeSource = 'unavailable';
            }
          } else {
            judgeSource = 'skipped';
          }
          try {
            const rawVerdict = await judgeProposal(proposal, cfg, client, {
              recordTrace: false,
              ...(opts?.signal ? { signal: opts.signal } : {}),
            });
            if (rawVerdict.judgeFailure) {
              // Synthetic fallback (manager.ts's own no-real-judgment marker
              // — set whether this came from the null client above or a real
              // client's failed call). Never let it masquerade as a
              // considered verdict or move the score off its honest 0.
              if (judgeSource === 'real') judgeCallsFailed += 1;
            } else {
              verdict = rawVerdict;
              score = scoreVerdict(rawVerdict);
            }
          } catch {
            if (judgeSource === 'real') judgeCallsFailed += 1;
            // Judge failure — candidate stays with score 0, verdict undefined.
          }
        }
        if (opts?.signal?.aborted) return { ...c, verdict, score, judgeSource };

        // Deterministic quick verification. Infrastructure errors remain neutral.
        if (c.proposalDraft || c.proposalId) {
          try {
            testsPassed = c.proposalDraft
              ? await runTestsForProposal(
                  c.proposalDraft,
                  cfg,
                  'quick',
                  opts?.signal ? { signal: opts.signal } : undefined,
                )
              : await runTests(
                  c.proposalId as string,
                  cfg,
                  'quick',
                  opts?.signal ? { signal: opts.signal } : undefined,
                );
          } catch {
            // test runner unavailable — don't penalise
          }
        }
        if (opts?.signal?.aborted) return { ...c, verdict, score, judgeSource, testsPassed };

        // M183: taste scoring (flag-gated; only when tasteCritic enabled)
        let taste: TasteScore | undefined;
        if (scoreTaste) {
          try {
            taste = await scoreTaste(
              proposal,
              { repo: sourceRepo },
              cfg,
              opts?.signal ? { signal: opts.signal } : undefined,
            );
          } catch {
            // taste score failure is non-fatal — candidate is still eligible
          }
        }
        if (opts?.signal?.aborted) return { ...c, verdict, score, judgeSource, testsPassed, taste };

        return {
          ...c,
          diff: proposal.diff ?? c.diff,
          verdict,
          score,
          judgeSource,
          testsPassed,
          taste,
          ...(testsPassed === false && c.proposalDraft
            ? { proposalDisposition: { kind: 'verification-rejected' } as const }
            : {}),
        };
      },
    );

    if (opts?.signal?.aborted) {
      return cancelledSelection(scored);
    }

    // ── 8. Pick winner ────────────────────────────────────────────────────
    // Prefer clean material over partial evidence. If every clean candidate is
    // absent or fails final capture, the strongest partial remains a truthful,
    // deterministic fallback instead of being discarded with its producer error.
    const compareCandidates = (a: InternalCandidateResult, b: InternalCandidateResult): number => {
      const aClean = candidateHasPartialProposalMaterial(a) ? 0 : 1;
      const bClean = candidateHasPartialProposalMaterial(b) ? 0 : 1;
      if (bClean !== aClean) return bClean - aClean;

      // Passing > unverified. Explicit failures were removed from eligibility.
      const aPass = a.testsPassed === true ? 1 : 0;
      const bPass = b.testsPassed === true ? 1 : 0;
      if (bPass !== aPass) return bPass - aPass;

      // M183: when tasteCritic is enabled, prefer highest taste overall score.
      // Tie-break with existing correctness critic score (unchanged path when flag off).
      if (tasteCriticEnabled) {
        const aTaste = a.taste?.overall ?? 0;
        const bTaste = b.taste?.overall ?? 0;
        if (bTaste !== aTaste) return bTaste - aTaste;
      }

      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    };
    const counterfactualEligible = scored.filter((candidate) =>
      candidateHasProposalMaterial(candidate) && candidate.testsPassed !== false,
    ).sort(compareCandidates);
    const counterfactualWinnerIndex = counterfactualEligible[0]?.index;
    scored = scored.map((candidate) => candidate.shadow === true
      ? { ...candidate, shadowWouldHaveWon: candidate.index === counterfactualWinnerIndex }
      : candidate);
    const eligible = scored.filter((candidate) =>
      candidate.shadow !== true &&
      candidateHasProposalMaterial(candidate) && candidate.testsPassed !== false,
    );
    eligible.sort(compareCandidates);

    let winner: InternalCandidateResult | undefined;
    for (const c of eligible) {
      if (opts?.signal?.aborted) break;

      if (c.proposalId) {
        const persisted = exactDurablePendingProposal(
          c,
          c.proposalId,
          c.proposalOutcome,
          loadProposal,
          {
            repo: sourceRepo,
            workItemId: opts?.workItemId ?? item.id,
            workItemGenerationId: opts?.workItemGenerationId,
          },
          cfg,
        );
        if (persisted) {
          winner = { ...c, diff: persisted.diff ?? c.diff };
          scored[c.index] = winner;
          break;
        }
        const captureFailure = finalCaptureFailureOutcome(c.proposalOutcome, c.proposalId);
        const { proposalId: _unverifiedProposalId, ...candidateWithoutProposalId } = c;
        scored[c.index] = {
          ...candidateWithoutProposalId,
          proposalOutcome: captureFailure,
          error: formatProposalOutcome(captureFailure),
        };
        continue;
      }

      if (!c.sandbox || !captureSandboxedProposal) {
        scored[c.index] = {
          ...c,
          error: c.error ?? 'candidate sandbox unavailable for final proposal capture',
        };
        continue;
      }

      const cEngine = c.engine ?? defaultEngine;
      let filed: Awaited<ReturnType<CaptureSandboxedProposal>>;
      try {
        filed = await captureSandboxedProposal(cEngine, goal, cfg, {
          sourceRepo,
          existingWorktree: c.sandbox,
          ...(candidateBudget ? { budget: candidateBudget } : {}),
          ...(typeof c.requestedModel === 'string' ? { model: c.requestedModel } : {}),
          runId: c.runId,
          workItemId: opts?.workItemId ?? item.id,
          workItemGenerationId: opts?.workItemGenerationId,
          workSource: opts?.workSource ?? item.source,
          ...(c.delegationScope ? { delegationScope: c.delegationScope } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
          sourceLabel: 'Best-of-N winner',
          isPartial: c.proposalDraft?.isPartial === true || c.state?.status !== 'done',
          usage: c.state?.usage,
          durationMs: c.latencyMs,
          producerStatus: c.state?.status ?? 'done',
        });
      } catch {
        const captureOutcome: RunProposalOutcome = {
          kind: 'proposal-capture-error',
          reason: 'final proposal capture state unknown; refusing additional proposal filing',
        };
        scored[c.index] = {
          ...c,
          proposalOutcome: captureOutcome,
          error: formatProposalOutcome(captureOutcome),
        };
        break;
      }
      const outcome = filed.proposalOutcome ?? filed.state.proposalOutcome;
      const persisted = exactDurablePendingProposal(
        c,
        filed.proposalId,
        outcome,
        loadProposal,
        {
          repo: sourceRepo,
          workItemId: opts?.workItemId ?? item.id,
          workItemGenerationId: opts?.workItemGenerationId,
        },
        cfg,
      );

      if (persisted && filed.proposalId && outcome) {
        winner = {
          ...c,
          proposalId: filed.proposalId,
          proposalOutcome: outcome,
          diff: persisted.diff ?? c.proposalDraft?.diff ?? c.diff,
          state: filed.state,
        };
        scored[c.index] = winner;
        break;
      }

      if (opts?.signal?.aborted) break;

      const captureOutcome = filed.proposalId
        ? finalCaptureFailureOutcome(outcome, filed.proposalId)
        : outcome;
      const error = candidateErrorFromState(filed.state, false, captureOutcome)
        ?? 'final proposal capture did not file a proposal';
      const proposalDisposition = finalCaptureDisposition(c, captureOutcome, loadProposal, cfg);
      scored[c.index] = {
        ...c,
        ...(filed.candidateProposalId ? { candidateProposalId: filed.candidateProposalId } : {}),
        ...(captureOutcome ? { proposalOutcome: captureOutcome } : {}),
        ...(proposalDisposition ? { proposalDisposition } : {}),
        state: filed.state,
        error,
      };
      // A returned identity means durable creation may already have happened.
      // Never file a second candidate unless the first capture proved that it
      // created no proposal identity at all.
      if (
        filed.proposalId ||
        filed.candidateProposalId ||
        proposalDisposition?.kind === 'duplicate-owned'
      ) break;
    }

    if (opts?.signal?.aborted && !winner) {
      return cancelledSelection(scored);
    }

    // ── M333: full-cost accounting across ALL candidates ──────────────
    const { totalCostUsd, billableCostUsd } = await costsFor(scored);
    const noProposalReasons = summarizeNoProposalReasons(scored);

    const critique: BestOfNResult['critique'] = {
      n,
      nonEmpty: withProposals.length,
      judged: eligible.filter(c => c.verdict != null).length,
      topScore: winner?.score ?? 0,
      winnerIndex: winner?.index ?? -1,
      totalCostUsd,
      billableCostUsd,
      ...(noProposalReasons.length > 0 ? { noProposalReasons } : {}),
      judge: buildJudgeSummary(scored),
    };

    // Losers remain metadata-only rows; cancelled/no-proposal attempts are
    // still captured so routing can learn from paid failures.
    await recordCandidates(scored, totalCostUsd, winner);

    const candidates = scored.map(publicCandidate);
    if (!winner) {
      // All candidates empty, failing, or blocked at final capture — caller skips proposing.
      return { winner: undefined, candidates, critique };
    }

    return { winner: publicCandidate(winner), candidates, critique };
  } finally {
    cleanupCandidateSandboxes(rawCandidates, removeSandbox);
  }
}

// ---------------------------------------------------------------------------
// Null judge client (fallback when no LLM provider is configured)
// ---------------------------------------------------------------------------

/**
 * A judge client that always returns an empty string, causing judgeProposal
 * to fall through to its parse-failure → 'review' path (score stays 0).
 * This means best-of-N still works without a configured LLM — it just can't
 * rank candidates meaningfully; it picks the first non-empty one.
 */
function buildNullJudgeClient(): { complete: (system: string, user: string) => Promise<string> } {
  return {
    complete: async (_system: string, _user: string): Promise<string> => '',
  };
}
