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
 */

import type {
  AshlrConfig,
  WorkItem,
  Proposal,
  WorkSource,
  EngineId,
  RunProposalOutcome,
  RunState,
  SkillCard,
  DelegationScope,
  Sandbox,
} from '../types.js';
import type { ManagerVerdict } from '../fleet/manager.js';
import type { TasteScore } from '../fleet/taste-critic.js';
import { resolveEngineSpec } from './engine-registry.js';
import {
  deriveCandidateAttemptIdentity,
  type OuterAttemptIdentity,
} from '../fleet/attempt-identity.js';
import { mergeDelegationScope, scopeFromWorkItem } from './delegation-scope.js';
import { observeShadowSkills } from '../fleet/skill-shadow-observer.js';

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
  /** Opaque execution id for joining this candidate, including losers. */
  runId?: string;
  /** Verdict from the critic judge. undefined when judging failed. */
  verdict?: ManagerVerdict;
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
  /** Error from the sandbox run or judge, if any. */
  error?: string;
  /** Structured reason the sandbox run did or did not file a proposal. */
  proposalOutcome?: RunProposalOutcome;
}

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
  if (typeof override === 'number' && override >= 1) return Math.floor(override);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromCfg = (cfg.foundry as any)?.bestOfN;
  if (typeof fromCfg === 'number' && fromCfg >= 1) return Math.floor(fromCfg);
  return 1;
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
  if (c.error) return false;
  const draft = (c as InternalCandidateResult).proposalDraft;
  return !!c.proposalId || !!draft;
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
  const seen = new Set<string>();
  for (const c of candidates) {
    const sb = c.sandbox;
    if (!sb || seen.has(sb.id)) continue;
    seen.add(sb.id);
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
 * Never throws — all errors surface inside CandidateResult.error.
 *
 * @param item  The work item to solve.
 * @param cfg   AshlrConfig — reads cfg.foundry.bestOfN for N (default 1).
 * @param opts  Optional overrides: { n } overrides the config N.
 */
export async function runBestOfN(
  item: WorkItem,
  cfg: AshlrConfig,
  opts?: {
    n?: number;
    workItemId?: string;
    workItemGenerationId?: string;
    workSource?: WorkSource;
    engine?: EngineId;
    model?: string | null;
    delegationScope?: DelegationScope;
    /** Opaque outer dispatch identity used to derive stable candidate run ids. */
    attemptId?: OuterAttemptIdentity;
    /** Immutable signed-card snapshot read once by the daemon tick. */
    shadowSkillCards?: readonly SkillCard[];
    /** Stable timestamp associated with the daemon's signed-card snapshot. */
    shadowSkillSelectedAt?: string;
    /**
     * M333: per-candidate engine/model specs. Candidate i runs on
     * specs[i % specs.length] — one candidate per spec when n matches the
     * list length, cycling when the operator asks for more candidates than
     * specs. Absent → single-engine stochastic resampling (M142/M170
     * byte-identical).
     */
    candidates?: Array<{ engine: EngineId; model?: string | null }>;
  },
): Promise<BestOfNResult | { winner: undefined; candidates: CandidateResult[]; critique: BestOfNResult['critique'] }> {
  const n = readN(cfg, opts?.n);
  const goal = goalFor(item);

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
  try {
    const mod = await import('../fleet/manager.js');
    judgeProposal = mod.judgeProposal;
  } catch {
    // manager unavailable — candidates will be unjudged; score falls back to 0
  }

  // ── 3. Resolve test runner (M140 — tolerate absence) ───────────────────
  type RunTestsFn = (proposalId: string, cfg: AshlrConfig) => Promise<boolean>;
  let runTests: RunTestsFn | undefined;
  try {
    // Dynamic import so absence is graceful — runTests may not exist yet
    const mod = await import('../run/run-tests.js' as string);
    if (typeof (mod as Record<string, unknown>).runTests === 'function') {
      runTests = (mod as { runTests: RunTestsFn }).runTests;
    }
  } catch {
    // M140 not yet available — skip real test filter
  }

  // ── 3b. Resolve taste critic (M183 — flag-gated) ───────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tasteCriticEnabled = !!(cfg.foundry as any)?.tasteCritic;
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
  const specs: Array<{ engine: EngineId; model?: string | null }> =
    opts?.candidates && opts.candidates.length > 0
      ? opts.candidates
      : [{ engine: defaultEngine, model: opts?.model ?? null }];
  const runnerFor = (e: EngineId): typeof runEngineSandboxed => {
    const spec = resolveEngineSpec(e, cfg);
    return spec?.kind === 'api-model' ? runApiModelSandboxed : runEngineSandboxed;
  };
  const missingRunnerMessageFor = (e: EngineId): string =>
    resolveEngineSpec(e, cfg)?.kind === 'api-model'
      ? 'api-model sandbox runner unavailable'
      : 'cli-agent sandbox runner unavailable';

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

  // ── 5. Generate N candidates in parallel ────────────────────────────────
  const candidatePromises = Array.from({ length: n }, async (_, i): Promise<InternalCandidateResult> => {
    // Vary temperature and seed so candidates differ across calls.
    // We pass opts into the sandbox via model override naming conventions where
    // supported; the primary divergence comes from the engine's own stochasticity.
    const spec = specs[i % specs.length]!;
    const cEngine = spec.engine;
    const requestedModel = spec.model ?? null;
    const engineSpec = resolveEngineSpec(cEngine, cfg);
    const cModel = requestedModel
      ?? cfg.foundry?.models?.[cEngine]
      ?? engineSpec?.defaultModel
      ?? engineSpec?.api?.defaultModel
      ?? 'default';
    let runId: string;
    try {
      runId = opts?.attemptId
        ? deriveCandidateAttemptIdentity(opts.attemptId, i)
        : `best-of-n-${i}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    } catch (err) {
      return {
        index: i,
        diff: '',
        score: 0,
        engine: cEngine,
        model: cModel,
        error: err instanceof Error ? err.message : 'invalid attempt identity',
      };
    }
    const base: InternalCandidateResult = {
      index: i,
      diff: '',
      score: 0,
      engine: cEngine,
      model: cModel,
      runId,
      requestedModel,
    };
    const runSandboxed = runnerFor(cEngine);

    if (!runSandboxed) {
      return { ...base, error: missingRunnerMessageFor(cEngine) };
    }

    const t0 = Date.now();
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
          identity: { trajectoryId: `run:${opts.attemptId}`, runId },
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

      if (captureSandboxedProposal && createSandbox) {
        let sb: Sandbox;
        try {
          sb = createSandbox(sourceRepo, {
            allowAnyRepo: process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ...base,
            latencyMs: Date.now() - t0,
            error: `sandbox unavailable: ${msg}`,
          };
        }

        const result = await runSandboxed(cEngine as import('../types.js').EngineId, goal, cfg, {
          ...(typeof requestedModel === 'string' ? { model: requestedModel } : {}),
          sourceRepo,
          propose: false,
          existingWorktree: sb,
          runId,
          workItemId: opts?.workItemId ?? item.id,
          workItemGenerationId: opts?.workItemGenerationId,
          workSource: opts?.workSource ?? item.source,
          ...(delegationScope ? { delegationScope } : {}),
        });
        observeExecutedCandidate(
          result.state,
          result.proposalOutcome ?? result.state.proposalOutcome,
        );

        const draft = await captureSandboxedProposal(cEngine, goal, cfg, {
          sourceRepo,
          existingWorktree: sb,
          draftOnly: true,
          ...(typeof requestedModel === 'string' ? { model: requestedModel } : {}),
          runId,
          workItemId: opts?.workItemId ?? item.id,
          workItemGenerationId: opts?.workItemGenerationId,
          workSource: opts?.workSource ?? item.source,
          ...(delegationScope ? { delegationScope } : {}),
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

      const result = await runSandboxed(cEngine as import('../types.js').EngineId, goal, cfg, {
        ...(typeof requestedModel === 'string' ? { model: requestedModel } : {}),
        sourceRepo,
        propose: true,
        runId,
        workItemId: opts?.workItemId ?? item.id,
        workItemGenerationId: opts?.workItemGenerationId,
        workSource: opts?.workSource ?? item.source,
        ...(delegationScope ? { delegationScope } : {}),
      });
      observeExecutedCandidate(
        result.state,
        result.proposalOutcome ?? result.state.proposalOutcome,
      );

      const diff = (result.state as unknown as Record<string, unknown>)['result'] as string ?? '';
      // The actual diff patch lives in the proposal; the state.result is the
      // engine's stdout. We'll use proposalId to fetch the diff from the inbox
      // if needed — but for scoring we work with what we have.
      const proposalOutcome = result.proposalOutcome ?? result.state.proposalOutcome;
      const hasMaterial = !!result.proposalId;
      const candidateError = candidateErrorFromState(result.state, hasMaterial, proposalOutcome);
      return {
        ...base,
        diff: typeof diff === 'string' ? diff : '',
        proposalId: result.proposalId,
        ...(proposalOutcome ? { proposalOutcome } : {}),
        latencyMs: Date.now() - t0,
        ...(typeof result.state.usage?.estCostUsd === 'number'
          ? { costUsd: result.state.usage.estCostUsd }
          : {}),
        ...(candidateError ? { error: candidateError } : {}),
        state: result.state,
      } as InternalCandidateResult;
    } catch (err) {
      return {
        ...base,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  let rawCandidates: InternalCandidateResult[] = [];
  let scored: InternalCandidateResult[] = [];

  try {
    rawCandidates = await Promise.all(candidatePromises);

    // ── 6. Filter empty diffs ─────────────────────────────────────────────
    // A candidate is "non-empty" when it produced proposal material. In the
    // default file-once path that material is a draft captured from the live
    // sandbox; legacy test/partial-build paths may still expose proposalId.
    const withProposals = rawCandidates.filter(candidateHasProposalMaterial);

    // ── 7. Score each non-empty candidate via the critic ──────────────────
    const judgeClient = buildNullJudgeClient(); // fallback when no provider
    scored = await Promise.all(
      rawCandidates.map(async (c): Promise<InternalCandidateResult> => {
        if (!candidateHasProposalMaterial(c)) return c;

      let verdict: ManagerVerdict | undefined;
      let score = 0;
      let testsPassed: boolean | undefined;
      const proposal = proposalForCandidate(item, c, loadProposal);

      // Score via judge
      if (judgeProposal) {
        try {
          verdict = await judgeProposal(proposal, cfg, judgeClient, { recordTrace: false });
          score = scoreVerdict(verdict);
        } catch {
          // Judge failure — candidate stays with score 0
        }
      }

      // Real test filter (M140 — optional)
      if (runTests && c.proposalId) {
        try {
          testsPassed = await runTests(c.proposalId, cfg);
          // If tests failed, penalise score strongly so passing candidates win
          if (!testsPassed) score = score * 0.1;
        } catch {
          // test runner unavailable — don't penalise
        }
      }

      // M183: taste scoring (flag-gated; only when tasteCritic enabled)
      let taste: TasteScore | undefined;
      if (scoreTaste) {
        try {
          taste = await scoreTaste(
            proposal,
            { repo: sourceRepo },
            cfg,
          );
        } catch {
          // taste score failure is non-fatal — candidate is still eligible
        }
      }

      return { ...c, diff: proposal.diff ?? c.diff, verdict, score, testsPassed, taste };
      }),
    );

    // ── 8. Pick winner ────────────────────────────────────────────────────
    // Among non-empty candidates, prefer those that passed tests, then highest score.
    const eligible = scored.filter(candidateHasProposalMaterial);
    eligible.sort((a, b) => {
      // Passing > non-passing.
      // NOTE: testsPassed !== false intentionally treats undefined (tests not attempted /
      // not available) as non-blocking — it is not a failure; only explicit false is penalised.
      const aPass = a.testsPassed !== false ? 1 : 0;
      const bPass = b.testsPassed !== false ? 1 : 0;
      if (bPass !== aPass) return bPass - aPass;

      // M183: when tasteCritic is enabled, prefer highest taste overall score.
      // Tie-break with existing correctness critic score (unchanged path when flag off).
      if (tasteCriticEnabled) {
        const aTaste = a.taste?.overall ?? 0;
        const bTaste = b.taste?.overall ?? 0;
        if (bTaste !== aTaste) return bTaste - aTaste;
      }

      return b.score - a.score;
    });

    let winner: InternalCandidateResult | undefined;
    for (const c of eligible) {
      if (c.proposalId) {
        winner = c;
        break;
      }

      if (!c.sandbox || !captureSandboxedProposal) {
        scored[c.index] = {
          ...c,
          error: c.error ?? 'candidate sandbox unavailable for final proposal capture',
        };
        continue;
      }

      const cEngine = c.engine ?? defaultEngine;
      const filed = await captureSandboxedProposal(cEngine, goal, cfg, {
        sourceRepo,
        existingWorktree: c.sandbox,
        ...(typeof c.requestedModel === 'string' ? { model: c.requestedModel } : {}),
        runId: c.runId,
        workItemId: opts?.workItemId ?? item.id,
        workItemGenerationId: opts?.workItemGenerationId,
        workSource: opts?.workSource ?? item.source,
        ...(c.delegationScope ? { delegationScope: c.delegationScope } : {}),
        sourceLabel: 'Best-of-N winner',
        isPartial: c.proposalDraft?.isPartial === true || c.state?.status !== 'done',
        usage: c.state?.usage,
        durationMs: c.latencyMs,
        producerStatus: c.state?.status ?? 'done',
      });
      const outcome = filed.proposalOutcome ?? filed.state.proposalOutcome;

      if (filed.proposalId) {
        let persisted: Proposal | undefined;
        try {
          persisted = loadProposal?.(filed.proposalId) ?? undefined;
        } catch {
          persisted = undefined;
        }
        winner = {
          ...c,
          proposalId: filed.proposalId,
          ...(outcome ? { proposalOutcome: outcome } : {}),
          diff: persisted?.diff ?? c.proposalDraft?.diff ?? c.diff,
          state: filed.state,
          error: undefined,
        };
        scored[c.index] = winner;
        break;
      }

      const error = candidateErrorFromState(filed.state, false, outcome)
        ?? 'final proposal capture did not file a proposal';
      scored[c.index] = {
        ...c,
        ...(outcome ? { proposalOutcome: outcome } : {}),
        state: filed.state,
        error,
      };
    }

    // ── M333: full-cost accounting across ALL candidates ──────────────
    let isSubscription: ((e: string) => boolean) | undefined;
    try {
      const mod = await import('../fleet/subscription-usage.js');
      isSubscription = mod.isSubscriptionEngine as (e: string) => boolean;
    } catch {
      // conservative fallback: treat every candidate as billable
    }
    const totalCostUsd = scored.reduce((s, c) => s + (c.costUsd ?? 0), 0);
    const billableCostUsd = scored.reduce(
      (s, c) =>
        s + (isSubscription && c.engine && isSubscription(String(c.engine)) ? 0 : (c.costUsd ?? 0)),
      0,
    );
    const noProposalReasons = summarizeNoProposalReasons(scored);
    const winnerPid = winner?.proposalId;

    const critique: BestOfNResult['critique'] = {
      n,
      nonEmpty: withProposals.length,
      judged: eligible.filter(c => c.verdict != null).length,
      topScore: winner?.score ?? 0,
      winnerIndex: winner?.index ?? -1,
      totalCostUsd,
      billableCostUsd,
      ...(noProposalReasons.length > 0 ? { noProposalReasons } : {}),
    };

    // ── M333: per-candidate record stream (feeds M335 win-rates) ───────
    // Losers remain metadata-only rows here; they are never persisted as
    // rejected inbox proposals in the file-once path.
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
        candidates: scored.map((c) => ({
          index: c.index,
          ...(c.runId ? { runId: c.runId } : {}),
          engine: String(c.engine ?? ''),
          model: c.model ?? null,
          score: c.score,
          ...(c.testsPassed !== undefined ? { testsPassed: c.testsPassed } : {}),
          ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}),
          ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
          ...(c.error ? { error: c.error } : {}),
          ...(c.proposalOutcome
            ? {
                proposalOutcome: c.proposalOutcome.kind,
                proposalOutcomeReason: c.proposalOutcome.reason,
              }
            : {}),
          proposalId: c.proposalId && c.proposalId === winnerPid ? c.proposalId : null,
          won: c.proposalId != null && c.proposalId === winnerPid,
        })),
      });
    } catch {
      // ledger is best-effort
    }

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
