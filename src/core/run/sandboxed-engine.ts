/**
 * sandboxed-engine.ts — M45: run an external agent CLI (Claude Code / Codex)
 * INSIDE a throwaway git worktree and capture ONLY its diff as a PENDING inbox
 * proposal. This is the keystone that lets the autonomous fleet drive frontier
 * backends without ever touching the live tree.
 *
 * SECURITY MODEL (external CLIs are black boxes):
 *  - Edits are confined to an M21 sandbox worktree (cwd = worktreePath). The
 *    worktree shares the source repo's .git, so it inherits remotes — therefore
 *    we sever git's PUSH credential channel (see buildContainedEnv): no token
 *    env vars, no ssh-agent, GIT_TERMINAL_PROMPT=0, and a per-invocation
 *    `core.hooksPath` (via GIT_CONFIG_* env — NO shared-config mutation) whose
 *    `pre-push` hook hard-fails every push.
 *  - The agent still authenticates to ITS OWN vendor (Claude/Codex subscription)
 *    via its on-disk session reached through the preserved real HOME — a
 *    different credential channel from git push, which we cut.
 *  - We consume ONLY the captured worktree diff. The agent's own commits land on
 *    the throwaway scratch branch and are discarded with the sandbox.
 *  - RESIDUAL (documented): the filesystem is not jailed — the agent can READ
 *    outside the worktree. True OS isolation (container/VM) is a later milestone.
 *
 * ENTIRELY GATED: only reached when cfg.foundry opts in (or opts.sandboxEngine).
 * Default builtin-only behavior is unaffected.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// M154: repo-map + localization pre-pass (flag-gated, zero-dep)
import { buildRepoMap, renderRepoMap } from './repo-map.js';
import { localize, renderLocalization } from './localize.js';

import type {
  AshlrConfig,
  DelegationScope,
  EngineId,
  EngineTier,
  ProposalVerifyResult,
  Proposal,
  RunActionCounts,
  RunContextSummary,
  RunProposalOutcome,
  RunBudget,
  RunState,
  RunTask,
  RunUsage,
  Sandbox,
  SandboxDiff,
  WorkSource,
} from '../types.js';
import {
  normalizeDelegationScope,
  renderDelegationScopeForPrompt,
  scopeHintFiles,
  summarizeDelegationScope,
} from './delegation-scope.js';
import { buildEngineCommand, spawnEngine } from './engines.js';
import { iterateToGreen } from './verify-to-green.js';
import type { TerminationReason } from './run-monitor.js';
import {
  classifyAgentDiagnosticError,
  measureAgentDiagnosticText,
  recordAgentDiagnostic,
} from './agent-diagnostics.js';
import { resolveEngineSpec } from './engine-registry.js';
import { buildOpenAICompatibleClient } from './provider-client.js';
import { runTask } from './agent-loop.js';
import { adaptivePromptsEnabled } from './model-profile.js';
import {
  buildEngineerToolSpecs,
  type EngineerContext,
} from '../mcp-native-engineer.js';
import { buildSandboxLauncher, confinementProfileFor } from '../sandbox/confine.js';
import { audit as auditConfinement } from '../sandbox/audit.js';
import { assertMayMutate, killSwitchOn } from '../sandbox/policy.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { addUsage, newUsage, estCostUsd } from './budget.js';
import { withToolEnv } from '../env-bridge.js';
import { canonicalizeProposalDiff, scrubSecrets } from '../util/scrub.js';
import { selectInboxStore } from '../seams/inbox.js';
import {
  PROPOSAL_PERSISTENCE_MISMATCH_REASON,
  PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
} from '../inbox/persistence-mismatch.js';
import { recordAgentAction, type AgentActionOutcome } from '../fleet/agent-action-ledger.js';
import { agentRunSemanticEvents } from '../learning/agent-semantic-events.js';
import { hashDiff, signProvenance } from '../foundry/provenance.js';
// M249: RunCache shadow mode — key construction + store (import lazy so flag-off path
// incurs zero module load cost; the dynamic import is cached by Node after first call).
import { buildCacheKeyInput, buildCacheKey } from '../fabric/cache/key.js';
// M275: completeness + self-verify gate (additive, flag-off byte-identical).
import { runCompletenessGate } from './completeness-gate.js';
import { lookup as cacheLookup, write as cacheWrite } from '../fabric/cache/store.js';
import type { CacheEntry } from '../fabric/cache/store.js';
// M195: resolve api-model keys (e.g. NVIDIA_NIM_API_KEY) via the engine-auth
// mechanism — phantom vault first, then process.env. Never logs the value.
import { resolveProviderKey } from '../integrations/secrets.js';
// M264: elite context injection for local api-model engines (local-coder, local-agent).
// Frontier engines (claude, codex) are never modified. Flag-off → no-op.
import {
  buildLocalContextBundle,
  renderLocalContextBundle,
  isLocalContextEnabled,
  summarizeLocalContextBundle,
} from './local-context.js';
import { causalMetadata, runEventSummary, routeSnapshot } from '../learning/causal.js';
import { assertSafeExecutionIdentity } from '../fleet/attempt-identity.js';
import { classifyDiff, isTrivialProposal } from '../../planning/triviality.js';
import { isDiffDedupResult } from '../inbox/store.js';

export interface SandboxedEngineResult {
  /** Delegated RunState (status/usage/engineModel/engineTier). */
  state: RunState;
  /** Inbox proposal id when a non-empty diff was captured. */
  proposalId?: string;
  /** Proposal-shaped candidate captured without persisting to the inbox. */
  proposalDraft?: Proposal;
  /** Metadata-only explanation of whether proposal filing happened. */
  proposalOutcome?: RunProposalOutcome;
  /** Recovery evidence when process closure was not proven and cleanup was withheld. */
  sandboxRetention?: SandboxRetentionEvidence;
}

export interface SandboxRetentionEvidence {
  status: 'retained';
  reason: 'process-cleanup-unconfirmed';
  sandboxId: string;
  worktreePath: string;
  recovery: 'orphan-sweep';
}

export interface RunEngineSandboxedOptions {
  /** Absolute source repo the worktree forks from. */
  sourceRepo: string;
  /** Model id for the backend (else cfg.foundry.models[engine]). */
  model?: string;
  /** Budget hints recorded on the RunState. */
  budget?: Partial<RunBudget>;
  /** File the diff as a PENDING proposal (default true). */
  propose?: boolean;
  /** Reuse an existing worktree (e.g. the swarm's) instead of creating one. */
  existingWorktree?: Sandbox;
  /** Pre-generated run id (else one is generated). */
  runId?: string;
  /** Optional originating backlog/work item id for causal tracing. */
  workItemId?: string;
  /** Optional immutable generated-repair generation hash. */
  workItemGenerationId?: string;
  /** Optional originating backlog scanner/source for causal tracing. */
  workSource?: WorkSource;
  /** Optional advisory delegation contract for context/result expectations. */
  delegationScope?: DelegationScope;
  /** Cancellation owned by the daemon or direct caller that started this run. */
  signal?: AbortSignal;
  /** Internal whole-attempt generation for mutating-tool evidence. */
  effectGeneration?: string;
}

export interface CaptureSandboxedProposalOptions {
  /** Absolute source repo the worktree forks from. */
  sourceRepo: string;
  /** Existing sandbox worktree whose diff should be captured. */
  existingWorktree: Sandbox;
  /** Capture a Proposal-shaped draft without persisting or recording a decision. */
  draftOnly?: boolean;
  /** Model id for the backend (else cfg.foundry.models[engine]). */
  model?: string;
  /** Budget/usage hints recorded on the synthetic capture state. */
  budget?: Partial<RunBudget>;
  /** Pre-generated run id, usually the run that produced the diff. */
  runId?: string;
  /** Optional originating backlog/work item id for causal tracing. */
  workItemId?: string;
  /** Optional immutable generated-repair generation hash. */
  workItemGenerationId?: string;
  /** Optional originating backlog scanner/source for causal tracing. */
  workSource?: WorkSource;
  /** Mark the proposal partial and run the partial completeness gate. */
  isPartial?: boolean;
  /** Capture the diff with a known gate-style failure reason. */
  forceGateBlockReason?: string;
  /** Human-readable source label used in proposal summaries. */
  sourceLabel?: string;
  /** Producer usage to preserve in causal metadata when capture is delegated. */
  usage?: RunUsage;
  /** Producer wall-clock duration to preserve in causal metadata. */
  durationMs?: number;
  /** Producer terminal status to preserve in causal metadata. */
  producerStatus?: RunState['status'];
  /** Optional advisory delegation contract for context/result expectations. */
  delegationScope?: DelegationScope;
  /** Optional mutable metadata-only counter bag for enclosing sandbox run telemetry. */
  actionCounts?: RunActionCounts;
  /** Optional metadata-only context summary from the producing run. */
  contextSummary?: RunContextSummary;
  /** Cancellation authority inherited from the producer that owns this capture. */
  signal?: AbortSignal;
}

type SpawnEngineResult = {
  ok: boolean;
  output: string;
  usage?: { tokensIn: number; tokensOut: number };
  error?: string;
  terminationReason?: TerminationReason;
  configRecoveryAttempts?: number;
};

const PROCESS_CLEANUP_UNCONFIRMED_RE =
  /(?:termination authority lost|termination deadline elapsed[^\n]*(?:unconfirmed|could not be authenticated)|process(?:-group)?[^\n]*(?:closure|exit)[^\n]*unconfirmed)/i;

function processCleanupUnconfirmed(result: SpawnEngineResult): boolean {
  return result.terminationReason === 'error-exit' &&
    PROCESS_CLEANUP_UNCONFIRMED_RE.test(result.error ?? '');
}

function retainedSandboxEvidence(sb: Sandbox): SandboxRetentionEvidence {
  return {
    status: 'retained',
    reason: 'process-cleanup-unconfirmed',
    sandboxId: sb.id,
    worktreePath: sb.worktreePath,
    recovery: 'orphan-sweep',
  };
}

function withSandboxRetention(
  state: RunState,
  evidence: SandboxRetentionEvidence | undefined,
): RunState {
  return evidence ? ({ ...state, sandboxRetention: evidence } as RunState) : state;
}

/**
 * Default hard wall-clock for an autonomous external run (10 min).
 * M233: lowered from 20 min — bounds the run while still allowing real agent
 * work; env/config-override (cfg.foundry.timeoutMs) still wins.
 */
// Generous backstop ONLY — real frontier agents (Claude Code/Codex) legitimately
// work for long periods on substantial features, so we do NOT impose an aggressive
// wall-clock kill. This 2h cap is a runaway-cost safety net; the proper termination
// is STALL-based (no-progress detection, M234) + async dispatch so a long run never
// blocks the loop. cfg.foundry.timeoutMs overrides. Partial work is captured (M233).
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;

const TRANSIENT_ABORT_RE =
  /\b(aborted_streaming|error_during_execution|stream aborted|network error|econnreset|socket hang up|fetch failed|etimedout)\b/i;

export function isTransientAbort(res: SpawnEngineResult, hasDiff: boolean): boolean {
  if (res.ok) return false;
  if (hasDiff) return false;
  if (
    res.terminationReason === 'idle-stall' ||
    res.terminationReason === 'loop-stall' ||
    res.terminationReason === 'no-diff-stall' ||
    res.terminationReason === 'backstop-timeout'
  ) {
    return false;
  }
  return TRANSIENT_ABORT_RE.test(`${res.error ?? ''}\n${res.output ?? ''}`);
}

function dispatchMaxAttempts(cfg: AshlrConfig): number {
  const raw = (cfg.foundry as { dispatchRetries?: number } | undefined)?.dispatchRetries;
  const retries = Number.isFinite(raw) ? Math.max(0, Math.floor(raw as number)) : 2;
  return 1 + Math.min(retries, 5);
}

function proposalOutcome(
  kind: RunProposalOutcome['kind'],
  reason: string,
  diff?: { files: number; insertions: number; deletions: number },
  proposalId?: string,
  isPartial = false,
): RunProposalOutcome {
  return {
    kind,
    reason: reason.length > 240 ? reason.slice(0, 237) + '...' : reason,
    ...(proposalId ? { proposalId } : {}),
    ...(isPartial ? { isPartial: true } : {}),
    ...(diff
      ? {
          files: diff.files,
          insertions: diff.insertions,
          deletions: diff.deletions,
        }
      : {}),
  };
}

function duplicateDiffOutcome(proposal: Proposal, diff: SandboxDiff): RunProposalOutcome {
  return proposalOutcome(
    'proposal-disabled',
    `duplicate diff skipped; existing pending proposal ${proposal.id} remains authoritative`,
    diff,
  );
}

function captureGateVerifyResult(reason: string): ProposalVerifyResult {
  return {
    passed: false,
    failed: [reason],
    detail: reason,
    source: 'capture-gate',
  };
}

function diffLineCount(outcome: RunProposalOutcome | undefined): number | undefined {
  if (
    outcome === undefined ||
    (typeof outcome.insertions !== 'number' && typeof outcome.deletions !== 'number')
  ) {
    return undefined;
  }
  return (outcome.insertions ?? 0) + (outcome.deletions ?? 0);
}

const RUN_ACTION_COUNT_ZEROES: Required<RunActionCounts> = {
  sandboxCreated: 0,
  spawnAttempts: 0,
  transientRetries: 0,
  proposalCaptureAttempts: 0,
  completenessGateRuns: 0,
  verifyRepairAttempts: 0,
  modelSteps: 0,
  toolSteps: 0,
  totalSteps: 0,
  diffFiles: 0,
  diffLines: 0,
  proposalCreated: 0,
  proposalBlocked: 0,
  proposalDisabled: 0,
};

const RUN_ACTION_COUNT_KEYS = Object.keys(RUN_ACTION_COUNT_ZEROES) as Array<keyof Required<RunActionCounts>>;

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

function completeRunActionCounts(counts: RunActionCounts | undefined): Required<RunActionCounts> {
  const out = { ...RUN_ACTION_COUNT_ZEROES };
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return out;
  const record = counts as Record<string, unknown>;
  for (const key of RUN_ACTION_COUNT_KEYS) out[key] = nonNegativeInteger(record[key]) ?? 0;
  return out;
}

function setRunActionCount(
  counts: RunActionCounts,
  key: keyof RunActionCounts,
  value: unknown,
): void {
  const count = nonNegativeInteger(value);
  if (count !== undefined) counts[key] = count;
}

function incrementRunActionCount(
  counts: RunActionCounts | undefined,
  key: keyof RunActionCounts,
  by = 1,
): void {
  if (!counts) return;
  const current = nonNegativeInteger(counts[key]) ?? 0;
  setRunActionCount(counts, key, current + by);
}

function sanitizedRunActionCounts(counts: RunActionCounts): RunActionCounts | undefined {
  return runEventSummary({ actionCounts: completeRunActionCounts(counts) })?.actionCounts;
}

function setRunDiffActionCounts(counts: RunActionCounts | undefined, diff: SandboxDiff | undefined): void {
  if (!counts || !diff) return;
  setRunActionCount(counts, 'diffFiles', diff.files);
  setRunActionCount(counts, 'diffLines', (diff.insertions ?? 0) + (diff.deletions ?? 0));
}

function trySetRunDiffActionCounts(counts: RunActionCounts, readDiff: () => SandboxDiff): void {
  try {
    setRunDiffActionCounts(counts, readDiff());
  } catch {
    // Metadata collection is best-effort and must never perturb sandbox behavior.
  }
}

function isProposalBlockedOutcome(outcome: RunProposalOutcome | undefined): boolean {
  return !!outcome && (outcome.isPartial === true || (outcome.kind !== 'filed' && outcome.kind !== 'proposal-disabled'));
}

function actionCountsWithOutcome(
  counts: RunActionCounts,
  outcome: RunProposalOutcome | undefined,
): RunActionCounts {
  const out: RunActionCounts = completeRunActionCounts(counts);
  setRunActionCount(out, 'diffFiles', outcome?.files);
  setRunActionCount(out, 'diffLines', diffLineCount(outcome));
  setRunActionCount(out, 'proposalCreated', outcome?.kind === 'filed' && outcome.isPartial !== true ? 1 : 0);
  setRunActionCount(out, 'proposalBlocked', isProposalBlockedOutcome(outcome) ? 1 : 0);
  setRunActionCount(out, 'proposalDisabled', outcome?.kind === 'proposal-disabled' ? 1 : 0);
  return out;
}

function withProposalOutcome(
  state: RunState,
  outcome: RunProposalOutcome | undefined,
  counts?: RunActionCounts,
  contextSummary?: RunContextSummary,
): RunState {
  if (!outcome && !counts) return state;
  const actionCounts = counts ? sanitizedRunActionCounts(actionCountsWithOutcome(counts, outcome)) : undefined;
  const proposalCreated = proposalCreatedForRunEvent(outcome);
  const summary = runEventSummary({
    ...(state.runEventSummary ?? {}),
    runId: state.id,
    status: state.status,
    ...(outcome ? { outcome: outcome.kind === 'filed' && outcome.isPartial !== true ? 'proposal-created' : outcome.isPartial ? 'gate-blocked' : outcome.kind } : {}),
    ...(proposalCreated !== undefined ? { proposalCreated } : {}),
    proposalId: outcome?.proposalId,
    diffFiles: outcome?.files ?? actionCounts?.diffFiles,
    diffLines: diffLineCount(outcome) ?? actionCounts?.diffLines,
    tokensIn: state.usage.tokensIn,
    tokensOut: state.usage.tokensOut,
    costUsd: state.usage.estCostUsd,
    contextSummary: contextSummary ?? state.runEventSummary?.contextSummary,
    ...(actionCounts ? { actionCounts } : {}),
  });
  return {
    ...state,
    ...(outcome ? { proposalOutcome: outcome } : {}),
    ...(summary ? { runEventSummary: summary } : {}),
  };
}

function proposalCreatedForRunEvent(outcome: RunProposalOutcome | undefined): boolean | undefined {
  if (!outcome || outcome.kind === 'proposal-disabled') return undefined;
  return outcome.kind === 'filed' && outcome.isPartial !== true;
}

function sandboxAgentOutcome(
  outcome: RunProposalOutcome | undefined,
  status: RunState['status'],
): AgentActionOutcome {
  if (status === 'aborted') return 'blocked';
  switch (outcome?.kind) {
    case 'filed':
      return outcome.isPartial === true ? 'blocked' : 'ok';
    case 'proposal-disabled':
      return 'ok';
    case 'empty-diff':
      return 'ok';
    case 'trivial-proposal':
    case 'completeness-gate':
    case 'partial-completeness-gate':
    case 'kill-switch':
      return 'blocked';
    case 'engine-failed-no-diff':
    case 'api-model-task-failed':
    case 'sandbox-unavailable':
    case 'engine-command-missing':
    case 'engine-unsupported':
    case 'proposal-capture-error':
      return 'failed';
    default:
      return status === 'failed' ? 'failed' : 'ok';
  }
}

function recordSandboxedRunAgentAction(fields: {
  engine: EngineId;
  engineModel: string;
  tier: EngineTier;
  runId: string;
  sourceRepo: string;
  workItemId?: string;
  workSource?: WorkSource;
  proposalId?: string;
  outcome?: RunProposalOutcome;
  status: RunState['status'];
  usage?: RunUsage;
  durationMs?: number;
  actionCounts: RunActionCounts;
  contextSummary?: RunContextSummary;
}): void {
  try {
    const counts = sanitizedRunActionCounts(actionCountsWithOutcome(fields.actionCounts, fields.outcome));
    const outcomeLabel = fields.outcome?.kind ?? fields.status;
    const proposalId = fields.proposalId ?? fields.outcome?.proposalId;
    const proposalCreated = proposalCreatedForRunEvent(fields.outcome);
    const semanticEvents = agentRunSemanticEvents({
      runId: fields.runId,
      model: fields.engineModel,
      status: fields.status,
      ...(proposalCreated !== undefined ? { proposalCreated } : {}),
    });
    const summary = runEventSummary({
      runId: fields.runId,
      status: fields.status,
      outcome: fields.outcome?.kind === 'filed' && fields.outcome.isPartial !== true
        ? 'proposal-created'
        : fields.outcome?.isPartial
          ? 'gate-blocked'
          : outcomeLabel,
      ...(proposalCreated !== undefined ? { proposalCreated } : {}),
      proposalId,
      diffFiles: fields.outcome?.files,
      diffLines: diffLineCount(fields.outcome),
      tokensIn: fields.usage?.tokensIn,
      tokensOut: fields.usage?.tokensOut,
      costUsd: fields.usage?.estCostUsd,
      durationMs: fields.durationMs,
      contextSummary: fields.contextSummary,
      ...(counts ? { actionCounts: counts } : {}),
    });
    recordAgentAction({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      actor: 'agent',
      kind: 'maintenance',
      outcome: sandboxAgentOutcome(fields.outcome, fields.status),
      action: 'sandboxed-engine:run',
      summary: `${fields.engine} sandboxed-engine run ${fields.status}:${outcomeLabel}`,
      repo: fields.sourceRepo,
      ...(fields.workItemId ? { itemId: fields.workItemId } : {}),
      ...(fields.workSource ? { source: fields.workSource } : {}),
      ...(proposalId ? { proposalId } : {}),
      runId: fields.runId,
      routeSnapshot: {
        backend: fields.engine,
        tier: fields.tier,
        model: fields.engineModel,
        assignedBy: 'sandboxed-engine',
        reason: 'sandboxed terminal telemetry',
      },
      ...(summary ? { runEventSummary: summary } : {}),
      learningSource: 'agent-action',
      labelBasis: 'dispatch-outcome',
      semanticEvents,
      backend: fields.engine,
      tier: fields.tier,
      model: fields.engineModel,
      reason: outcomeLabel,
      ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
      ...(fields.usage ? { spentUsd: fields.usage.estCostUsd } : {}),
      tags: ['sandboxed-engine', fields.engine, outcomeLabel],
      ...(counts ? { counts: { ...counts } } : {}),
    });
  } catch {
    // Terminal telemetry is best-effort and must never perturb sandbox behavior.
  }
}

const TRIVIAL_PROPOSAL_CHANGED_LINE_THRESHOLD = 15;

function trivialProposalOutcomeForDiff(diff: SandboxDiff): RunProposalOutcome | undefined {
  const scrubbedPatch = scrubSecrets(diff.patch);
  if (!isTrivialProposal(scrubbedPatch, TRIVIAL_PROPOSAL_CHANGED_LINE_THRESHOLD)) return undefined;
  const classification = classifyDiff(scrubbedPatch);
  const categories =
    classification.categories.length > 0
      ? classification.categories.join(', ')
      : 'trivial categories';
  return proposalOutcome(
    'trivial-proposal',
    `trivial proposal blocked: ${classification.changedLines} changed line(s) in ${categories} only`,
    diff,
  );
}

function sandboxedProducerCausalMetadata(fields: {
  engine: EngineId;
  engineModel: string;
  tier: EngineTier;
  runId: string;
  workItemId?: string;
  workSource?: WorkSource;
  proposalId?: string;
  outcome?: RunProposalOutcome;
  usage?: RunUsage;
  durationMs?: number;
  status?: string;
  actionCounts?: RunActionCounts;
  contextSummary?: RunContextSummary;
}) {
  const rs = routeSnapshot({
    backend: fields.engine,
    tier: fields.tier,
    model: fields.engineModel,
    assignedBy: 'sandboxed-engine',
    reason: fields.workSource ? `workSource:${fields.workSource}` : 'sandboxed autonomous producer',
  });
  const summary = runEventSummary({
    runId: fields.runId,
    status: fields.status,
    outcome: fields.outcome?.isPartial === true ? 'gate-blocked' : fields.outcome?.kind,
    proposalCreated: fields.outcome?.kind === 'filed' && fields.outcome.isPartial !== true,
    proposalId: fields.proposalId ?? fields.outcome?.proposalId,
    diffFiles: fields.outcome?.files,
    diffLines: diffLineCount(fields.outcome),
    tokensIn: fields.usage?.tokensIn,
    tokensOut: fields.usage?.tokensOut,
    costUsd: fields.usage?.estCostUsd,
    durationMs: fields.durationMs,
    contextSummary: fields.contextSummary,
    actionCounts: fields.actionCounts,
  });
  return {
    ...(fields.workItemId ? { workItemId: fields.workItemId } : {}),
    ...(fields.workSource ? { workSource: fields.workSource } : {}),
    ...(fields.runId ? { runId: fields.runId } : {}),
    ...causalMetadata({
      proposalId: fields.proposalId,
      workItemId: fields.workItemId,
      runId: fields.runId,
      routeSnapshot: rs,
      runEventSummary: summary,
      learningSource: 'daemon-dispatch',
      labelBasis: 'dispatch-outcome',
    }),
  };
}

// ---------------------------------------------------------------------------
// M154: repo-map + localization context prefix (flag-gated)
// ---------------------------------------------------------------------------

/**
 * Build a repo-map and/or localization context prefix for the given goal/repo.
 * Returns '' (empty string) when both flags are OFF — byte-identical to the
 * pre-M154 behaviour for all flag-off callers.
 *
 * Never throws.
 */
export function buildM154ContextPrefix(
  goal: string,
  sourceRepo: string,
  cfg: AshlrConfig,
  hintedFiles?: string[],
): string {
  try {
    const repoMapOn = (cfg.foundry as Record<string, unknown> | undefined)?.['repoMap'] === true;
    const localizeOn = (cfg.foundry as Record<string, unknown> | undefined)?.['localization'] === true;
    if (!repoMapOn && !localizeOn) return '';

    const parts: string[] = [];

    if (repoMapOn) {
      const map = buildRepoMap(sourceRepo);
      const rendered = renderRepoMap(map);
      if (rendered) parts.push(rendered);

      if (localizeOn) {
        const loc = localize(
          { title: goal, files: hintedFiles },
          map,
        );
        const rendered2 = renderLocalization(loc);
        if (rendered2) parts.push(rendered2);
      }
    } else if (localizeOn) {
      const map = buildRepoMap(sourceRepo);
      const objective = goal.match(/^Current objective:\s*(.+)$/mi)?.[1]?.trim() || goal;
      const loc = localize(
        { title: objective, files: hintedFiles },
        map,
        { maxFiles: 1 },
      );
      const rendered = renderLocalization({
        ...loc,
        files: loc.files.slice(0, 1),
      });
      if (rendered) parts.push(rendered);
    }

    return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
  } catch {
    return '';
  }
}

/** Credential-shaped env var names that must never reach the agent subprocess.
 * M107 (P2): broadened to cover PAT, API-key, OAuth, and generic credentials
 * variants that the original regex missed (e.g. GITHUB_PAT, X_API_KEY,
 * MY_OAUTH_TOKEN, DB_CREDS). ENGINE_AUTH_ALLOW still exempts the engine CLIs'
 * own subscription tokens so CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_AUTH_TOKEN survive.
 */
const CRED_ENV_DENY =
  /(_|^)(TOKEN|SECRET|KEY|PAT|PASSWORD|PASSWD|CREDENTIALS?|API[_-]?KEY|OAUTH[_-]?TOKEN|CREDS?)$/i;

/** The agent CLIs' OWN headless auth tokens. These ARE the engine's subscription
 * credential (e.g. `claude setup-token` exports CLAUDE_CODE_OAUTH_TOKEN) — not a
 * third-party secret — so they must survive CRED_ENV_DENY and reach the engine.
 *
 * M195 (NVIDIA NIM / Kimi K2): NVIDIA_NIM_API_KEY is DELIBERATELY NOT listed here.
 * NIM is an api-model engine driven IN-PROCESS by runApiModelSandboxed (below) —
 * it never spawns a CLI subprocess, so its bearer key must never be exported into
 * a subprocess env. The key is resolved in-process at dispatch time via the
 * engine-auth mechanism resolveProviderKey() (phantom vault → process.env), used
 * over the wire as an `Authorization: Bearer` header by buildOpenAICompatibleClient
 * and never logged. CRED_ENV_DENY correctly STRIPS NVIDIA_NIM_API_KEY from every
 * spawned cli-agent subprocess — that is the intended containment, not a gap. */
const ENGINE_AUTH_ALLOW = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);

/**
 * Trust tier of a backend. M50: read from the declarative engine registry (single
 * source of truth) rather than a hardcoded set — so a config-added backend is
 * tiered by its declared `tier`. An unknown engine is 'local' (never implicitly
 * frontier). The builtin registry maps {claude, codex} → 'frontier', all else →
 * 'local', identical to the pre-M50 FRONTIER_ENGINES behavior.
 */
export function engineTierOf(engine: EngineId, cfg?: AshlrConfig): EngineTier {
  return resolveEngineSpec(engine, cfg)?.tier ?? 'local';
}

/**
 * M127/M260 — resolve a concrete model string for `engine`.
 *
 * Priority:
 *   1. cfg.foundry?.models?.[engine]   (operator-configured concrete model)
 *   2. capturedModel                    (model the run actually used, e.g. from
 *                                        opts.model when the caller captured it)
 *   3. process.env.ASHLR_MODEL          (runtime override)
 *   4. spec.defaultModel                (M260: registry canonical default for this
 *                                        engine — resolves cli-agent entries like
 *                                        claude/codex that have no api.defaultModel.
 *                                        Makes `codex:default` → `codex:gpt-5.5` so
 *                                        frontier proposals can pass evaluateMergeAuthority
 *                                        even when no explicit model was configured.)
 *   5. spec.api?.defaultModel           (api-model registry default — e.g. local-coder)
 *   6. 'default'                        (genuinely unknown — still REJECTED by
 *                                        evaluateMergeAuthority, by design)
 *
 * The merge-authority gate still rejects ':default'. Priorities 4–5 ensure that
 * frontier cli-agent engines (claude, codex) resolve to their authorised concrete
 * model rather than falling through to ':default' when opts.model is absent.
 * Non-frontier engines (local-coder, nim, etc.) are unaffected — their tier
 * check in evaluateMergeAuthority refuses them regardless of the model string.
 */
export function resolveConcreteModel(
  engine: EngineId,
  cfg: AshlrConfig,
  capturedModel?: string,
): string {
  const spec = resolveEngineSpec(engine, cfg);
  return (
    cfg.foundry?.models?.[engine] ||
    capturedModel ||
    process.env.ASHLR_MODEL ||
    spec?.defaultModel ||
    spec?.api?.defaultModel ||
    'default'
  );
}

const PRE_PUSH_BLOCK =
  '#!/bin/sh\n' +
  '# ashlr M45: pushes are forbidden from a sandboxed-engine worktree.\n' +
  'echo "ashlr: git push is blocked inside the sandbox" >&2\n' +
  'exit 1\n';

/**
 * Build the contained env for an external agent subprocess. Preserves the agent's
 * OWN auth (real HOME + its config-home overrides) while severing git push creds.
 * `hooksDir` holds the pre-push blocker installed via per-invocation git config.
 */
export function buildContainedEnv(cfg: AshlrConfig, hooksDir: string): NodeJS.ProcessEnv {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const base: NodeJS.ProcessEnv = {};
  base.PATH = process.env.PATH ?? process.env.Path ?? '';
  if (realHome) base.HOME = realHome;
  base.LANG = process.env.LANG ?? 'C';
  if (process.env.TERM) base.TERM = process.env.TERM;
  if (process.env.TMPDIR) base.TMPDIR = process.env.TMPDIR;

  // M230: USER + LOGNAME are required for macOS Keychain access. The Security
  // framework uses the OS username to locate the login keychain
  // (~/Library/Keychains/login.keychain-db). Without them, `claude` fails with
  // "Not logged in · Please run /login" even with HOME set and ~/.claude present,
  // because the Keychain lookup for "Claude Code-credentials" silently fails.
  //
  // USER and LOGNAME are IDENTITY vars — the OS username — NOT credentials.
  // Passing them does NOT weaken any security boundary: no secret value is
  // transmitted, git-push remains severed (GIT_TERMINAL_PROMPT=0 + pre-push hook
  // + no SSH_AUTH_SOCK remain in force), and the worktree containment is unchanged.
  if (process.env.USER) base.USER = process.env.USER;
  if (process.env.LOGNAME) base.LOGNAME = process.env.LOGNAME;

  if (process.platform === 'win32') {
    if (realHome) base.USERPROFILE = realHome;
    for (const k of ['SystemRoot', 'windir', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
      const v = process.env[k];
      if (v) base[k] = v;
    }
  }

  // Preserve the agent CLIs' OWN config homes — their subscription auth lives here.
  for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    const v = process.env[k];
    if (v) base[k] = v;
  }

  // Preserve the agent CLIs' OWN headless auth tokens (claude's CLAUDE_CODE_OAUTH_TOKEN
  // etc.) — the engine's subscription credential, which must reach the engine.
  for (const k of ENGINE_AUTH_ALLOW) {
    const v = process.env[k];
    if (v) base[k] = v;
  }

  // Layer ashlr non-secret config (OLLAMA_HOST, provider chain, paths, …).
  const env = withToolEnv(cfg, base);

  // Defensive: strip any credential-shaped var that slipped through.
  for (const k of Object.keys(env)) {
    if (CRED_ENV_DENY.test(k) && !ENGINE_AUTH_ALLOW.has(k)) delete env[k];
  }

  // M289: the ashlr plugin installs global PreToolUse hooks (HOME→~/.claude) that,
  // in the default 'redirect' mode, intercept/redirect (and for some tools BLOCK)
  // the agent's NATIVE Read/Grep/Edit/Bash in favor of ashlr__ MCP equivalents.
  // The fleet's NESTED claude agent inherits these hooks — and the redirect failed
  // in the sandbox context, BLOCKING its native Read calls → permission_denials →
  // aborted_streaming → ZERO edits → empty diffs → 0 proposals (root cause of the
  // substantial-task failure, found via M288 observability). Set 'nudge' so the
  // hooks DON'T block the nested agent's native tools — it must be able to WORK
  // (the token-saving redirect is irrelevant for a one-shot autonomous run). The
  // agent still has the ashlr__ MCP tools available (M248) and may use them.
  env.ASHLR_HOOK_MODE = 'nudge';

  // Sever git's PUSH credential channels (the agent's vendor auth via HOME is untouched).
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  delete env.SSH_AUTH_SOCK;
  env.GIT_CONFIG_NOSYSTEM = '1';
  // Per-invocation core.hooksPath (no shared-config mutation) → pre-push blocker.
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  env.GIT_CONFIG_VALUE_0 = hooksDir;
  return env;
}

// ---------------------------------------------------------------------------
// M248: ashlr-plugin MCP config injection
// ---------------------------------------------------------------------------

/**
 * Resolve the ashlr binary path (used as the MCP server command).
 * Returns the absolute path when found on PATH, or null when absent.
 * Pure, best-effort — never throws.
 */
function resolveAshlrBin(): string | null {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(probe, ['ashlr'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')[0]
      ?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export const FLEET_MCP_CONFIG_FILENAME = '.ashlr-fleet.mcp.json';

/**
 * Write a minimal sidecar MCP config into the worktree so the fleet's claude instance
 * always has ashlr__ MCP tools regardless of the user's global settings.
 *
 * GUARD: only writes when `ashlr` is on PATH — CI/CD environments without the
 * plugin are completely unaffected (returns null → caller skips --mcp-config).
 *
 * M283 PRE-EXISTING GUARD: this writes a fleet-owned sidecar instead of `.mcp.json`,
 * so a repo-owned `.mcp.json` can be edited by the agent and captured normally.
 *
 * M283 DIFF EXCLUSION: after writing, registers the sidecar in the worktree's
 * `.git/info/exclude` file so `git add -A` never stages the fleet-written file.
 * This guarantees the fleet-infra file NEVER leaks into any proposal diff, which
 * previously caused the judge to return 'review' instead of 'ship' (M283).
 * Best-effort — a failure in exclude registration is silently suppressed; the
 * sandboxDiff pathspec filter (worktree.ts) is an independent belt-and-suspenders.
 *
 * Returns the path to the written file, or null when the plugin is absent.
 * Never throws — any failure is silently suppressed so it never breaks dispatch.
 */
export function writeMcpConfigIfAvailable(worktreePath: string): string | null {
  try {
    const ashlrBin = resolveAshlrBin();
    if (!ashlrBin) return null;

    const mcpConfigPath = join(worktreePath, FLEET_MCP_CONFIG_FILENAME);
    // Only write if the worktree path exists (sanity check).
    if (!existsSync(worktreePath)) return null;

    const mcpConfig = {
      mcpServers: {
        ashlr: {
          command: ashlrBin,
          args: ['mcp'],
          env: {
            ASHLR_MCP_HOST: 'ashlr-fleet-engine',
            ASHLR_HOOK_MODE: 'redirect',
            ASHLR_SESSION_LOG: '0',
          },
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

    // M283: register the fleet sidecar in the worktree's git exclude file so `git add -A`
    // never stages the fleet-written infra file. The worktree's gitdir is found via
    // `git rev-parse --git-dir` run inside the worktree — for a linked worktree this
    // resolves to the per-worktree gitdir (e.g. <source>/.git/worktrees/<id>), NOT
    // the main .git directory, so this never affects the source repo's exclude.
    // Best-effort: failure is silently suppressed — sandboxDiff's pathspec filter
    // is an independent second layer.
    try {
      const gitdirRaw = execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      if (gitdirRaw) {
        // gitdir may be relative (e.g. ".git") or absolute (worktree gitdir).
        const gitdir = gitdirRaw.startsWith('/') ? gitdirRaw : join(worktreePath, gitdirRaw);
        const infoDir = join(gitdir, 'info');
        const excludePath = join(infoDir, 'exclude');
        mkdirSync(infoDir, { recursive: true });
        // Only append if not already excluded (idempotent).
        const existing = existsSync(excludePath)
          ? readFileSync(excludePath, 'utf8')
          : '';
        if (!existing.split('\n').some((l) => l.trim() === FLEET_MCP_CONFIG_FILENAME)) {
          appendFileSync(
            excludePath,
            `\n# ashlr M283: fleet-infra file — excluded from proposal diff\n${FLEET_MCP_CONFIG_FILENAME}\n`,
            'utf8',
          );
        }
      }
    } catch {
      // Exclude registration is best-effort — never fails the run.
    }

    return mcpConfigPath;
  } catch {
    // Best-effort: never fail the run if MCP config can't be written.
    return null;
  }
}

/** Create a temp hooks dir containing a pre-push blocker. Returns its path. */
function installPrePushBlocker(): string {
  const hooksDir = mkdtempSync(join(tmpdir(), 'ashlr-hooks-'));
  writeFileSync(join(hooksDir, 'pre-push'), PRE_PUSH_BLOCK, { mode: 0o755 });
  return hooksDir;
}

/**
 * Capture and file a proposal from an already-mutated sandbox worktree without
 * invoking the model again. TITRR uses this after tests pass so the proposal is
 * bound to the exact diff that was just verified.
 */
export async function captureSandboxedProposal(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  opts: CaptureSandboxedProposalOptions,
): Promise<SandboxedEngineResult> {
  const model = opts.model ?? cfg.foundry?.models?.[engine];
  const engineModel = `${engine}:${resolveConcreteModel(engine, cfg, model)}`;
  const tier = engineTierOf(engine, cfg);
  const id = assertSafeExecutionIdentity(
    opts.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const sb = opts.existingWorktree;
  const now = new Date().toISOString();
  const producerStatus = opts.producerStatus ?? 'done';
  const actionCounts = opts.actionCounts ?? {};
  incrementRunActionCount(actionCounts, 'proposalCaptureAttempts');
  const delegationScope = opts.delegationScope
    ? normalizeDelegationScope(opts.delegationScope, {
        origin: 'run',
        sourceRepo: opts.sourceRepo,
        executionRoot: sb.worktreePath,
        objective: goal,
        runId: id,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        budget: opts.budget,
        backend: {
          engine,
          model: engineModel,
          tier,
          assignedBy: 'sandboxed-engine',
          reason: opts.isPartial ? 'partial proposal capture' : 'proposal capture',
        },
      })
    : undefined;
  const delegationScopeSummary = summarizeDelegationScope(delegationScope);
  const mk = (over: Partial<RunState>): RunState => ({
    id,
    goal,
    engine,
    provider: 'external',
    engineModel,
    engineTier: tier,
    createdAt: now,
    updatedAt: new Date().toISOString(),
    budget: {
      maxTokens: opts.budget?.maxTokens ?? 0,
      maxSteps: opts.budget?.maxSteps ?? 0,
      allowCloud: opts.budget?.allowCloud ?? false,
    },
    usage: opts.usage ?? newUsage(),
    tasks: [],
    steps: [],
    status: producerStatus,
    ...(delegationScopeSummary ? { delegationScope: delegationScopeSummary } : {}),
    ...over,
  });
  const cancelledCapture = (): SandboxedEngineResult => ({
    state: withProposalOutcome(
      mk({ status: 'aborted', result: 'proposal capture cancelled', terminationReason: 'cancelled' }),
      undefined,
      actionCounts,
      opts.contextSummary,
    ),
  });
  let proposalCreationStarted = false;
  if (opts.signal?.aborted) return cancelledCapture();

  try {
    const wt = await import('../sandbox/worktree.js');
    if (opts.signal?.aborted) return cancelledCapture();
    const sourceAdmission = wt.inspectSandboxSourceRevision(sb, opts.sourceRepo);
    if (!sourceAdmission.ok) {
      const outcome = proposalOutcome(
        'sandbox-unavailable',
        `sandbox source revision refused: ${sourceAdmission.reason}`,
      );
      return {
        state: withProposalOutcome(mk({ status: 'failed', result: outcome.reason }), outcome, actionCounts, opts.contextSummary),
        proposalOutcome: outcome,
      };
    }
    const diff: SandboxDiff = wt.sandboxDiff(sb);
    setRunDiffActionCounts(actionCounts, diff);
    if (diff.files <= 0 || diff.patch.trim().length === 0) {
      const outcome = proposalOutcome('empty-diff', `engine "${engine}" completed without file changes`);
      return {
        state: withProposalOutcome(mk({ result: outcome.reason }), outcome, actionCounts, opts.contextSummary),
        proposalOutcome: outcome,
      };
    }

    const trivialOutcome = trivialProposalOutcomeForDiff(diff);
    if (trivialOutcome) {
      return {
        state: withProposalOutcome(mk({ result: trivialOutcome.reason }), trivialOutcome, actionCounts, opts.contextSummary),
        proposalOutcome: trivialOutcome,
      };
    }

    let reviewOnlyVerifyResult: ProposalVerifyResult | undefined;
    if (opts.forceGateBlockReason) {
      const outcome = proposalOutcome(
        opts.isPartial ? 'partial-completeness-gate' : 'completeness-gate',
        opts.forceGateBlockReason,
        diff,
      );
      if (!opts.isPartial) {
        return {
          state: withProposalOutcome(mk({ result: outcome.reason }), outcome, actionCounts, opts.contextSummary),
          proposalOutcome: outcome,
        };
      }
      reviewOnlyVerifyResult = captureGateVerifyResult(outcome.reason);
    }

    let shouldFile = true;
    let blockedOutcome: RunProposalOutcome | undefined;
    if (reviewOnlyVerifyResult === undefined && cfg.foundry?.completenessGate !== false) {
      incrementRunActionCount(actionCounts, 'completenessGateRuns');
      const gateResult = await runCompletenessGate({
        worktreePath: sb.worktreePath,
        diff,
        goal,
        cfg,
        ...(opts.isPartial ? { isPartial: true } : {}),
      });
      if (opts.signal?.aborted) return cancelledCapture();
      if (!gateResult.pass) {
        blockedOutcome = proposalOutcome(
          opts.isPartial ? 'partial-completeness-gate' : 'completeness-gate',
          `${opts.isPartial ? 'partial ' : ''}completeness gate blocked proposal: ${gateResult.reason ?? 'blocked'}`,
          diff,
        );
        if (opts.isPartial) {
          reviewOnlyVerifyResult = captureGateVerifyResult(blockedOutcome.reason);
        } else {
          shouldFile = false;
        }
      }
    }

    if (!shouldFile && blockedOutcome) {
      return {
        state: withProposalOutcome(mk({ result: blockedOutcome.reason }), blockedOutcome, actionCounts, opts.contextSummary),
        proposalOutcome: blockedOutcome,
      };
    }

    const scrubbed = canonicalizeProposalDiff(diff.patch);
    const diffHash = hashDiff(scrubbed);
    const provenanceSig = signProvenance(engineModel, tier, diffHash);
    const label = opts.sourceLabel ?? 'Sandboxed';
    const filedOutcomeForMetadata = proposalOutcome(
      'filed',
      opts.isPartial ? 'partial proposal filed' : 'proposal filed',
      diff,
      undefined,
      opts.isPartial === true,
    );
    const draftId = `draft-${id}`;
    const proposalInput = {
      repo: sb.sourceRepo,
      origin: 'agent',
      kind: 'patch',
      title: `${opts.isPartial ? '[partial] ' : ''}${engine} run: ${goal.slice(0, 80)}`,
      summary:
        `${opts.isPartial ? 'Partial ' : ''}${label} ${engineModel} run produced ` +
        `${diff.files} file(s) (+${diff.insertions}/-${diff.deletions}). Review before applying.`,
      diff: scrubbed,
      diffHash,
      provenanceSig,
      sandboxId: sb.id,
      workItemId: opts.workItemId,
      ...(opts.workItemGenerationId ? { workItemGenerationId: opts.workItemGenerationId } : {}),
      workSource: opts.workSource,
      runId: id,
      engineModel,
      engineTier: tier,
      ...(reviewOnlyVerifyResult ? { verifyResult: reviewOnlyVerifyResult } : {}),
      ...(delegationScopeSummary ? { delegationScope: delegationScopeSummary } : {}),
      ...sandboxedProducerCausalMetadata({
        engine,
        engineModel,
        tier,
        runId: id,
        proposalId: opts.draftOnly ? draftId : undefined,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        outcome: filedOutcomeForMetadata,
        usage: opts.usage,
        durationMs: opts.durationMs,
        status: producerStatus,
        actionCounts: actionCountsWithOutcome(actionCounts, filedOutcomeForMetadata),
        contextSummary: opts.contextSummary,
      }),
      ...(opts.isPartial ? { isPartial: true } : {}),
    } satisfies Omit<Proposal, 'id' | 'status' | 'createdAt'>;

    if (opts.draftOnly === true) {
      if (opts.signal?.aborted) return cancelledCapture();
      const draft: Proposal = {
        ...proposalInput,
        id: draftId,
        status: 'pending',
        createdAt: now,
      };
      return {
        state: mk({ result: opts.isPartial ? 'partial proposal draft captured' : 'proposal draft captured' }),
        proposalDraft: draft,
      };
    }

    // Cancellation is authoritative until proposal creation begins. Once create()
    // returns, the proposal may be durable and must remain visible to the caller;
    // finish persistence verification and report it as filed even if the signal
    // becomes aborted during or after create().
    if (opts.signal?.aborted) return cancelledCapture();
    const inbox = selectInboxStore(cfg);
    proposalCreationStarted = true;
    const proposal = inbox.create(proposalInput);
    if (isDiffDedupResult(proposal)) {
      const outcome = duplicateDiffOutcome(proposal, diff);
      return {
        state: withProposalOutcome(mk({ result: outcome.reason }), outcome, actionCounts, opts.contextSummary),
        proposalOutcome: outcome,
      };
    }
    const persisted = inbox.load(proposal.id);
    const durablePending =
      proposal.status === 'pending' &&
      persisted?.status === 'pending' &&
      persisted.id === proposal.id &&
      persisted.repo === sb.sourceRepo &&
      persisted.runId === id &&
      persisted.trajectoryId === `run:${id}` &&
      persisted.workItemId === opts.workItemId &&
      persisted.workItemGenerationId === opts.workItemGenerationId &&
      persisted.diffHash === diffHash &&
      persisted.provenanceSig === provenanceSig &&
      persisted.diff === scrubbed &&
      (persisted.isPartial === true) === (opts.isPartial === true) &&
      typeof persisted.diff === 'string' &&
      persisted.diff.trim().length > 0;
    if (!durablePending) {
      if (
        proposal.status === 'pending' &&
        persisted?.status === 'pending' &&
        persisted.id === proposal.id &&
        persisted.runId === id
      ) {
        inbox.setStatus(
          proposal.id,
          'rejected',
          PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
          PROPOSAL_PERSISTENCE_MISMATCH_REASON,
        );
      }
      const outcome = proposalOutcome(
        'proposal-capture-error',
        'proposal was not durably persisted with matching capture metadata',
        diff,
      );
      return {
        state: withProposalOutcome(mk({ result: outcome.reason }), outcome, actionCounts, opts.contextSummary),
        proposalOutcome: outcome,
      };
    }
    const outcome = proposalOutcome(
      'filed',
      opts.isPartial ? 'partial proposal filed' : 'proposal filed',
      diff,
      proposal.id,
      opts.isPartial === true,
    );

    try {
      const { recordDecision } = await import('../fleet/decisions-ledger.js');
      recordDecision({
        ts: new Date().toISOString(),
        proposalId: proposal.id,
        ...sandboxedProducerCausalMetadata({
          engine,
          engineModel,
          tier,
          runId: id,
          workItemId: opts.workItemId,
          workSource: opts.workSource,
          proposalId: proposal.id,
          outcome,
          usage: opts.usage,
          durationMs: opts.durationMs,
          status: producerStatus,
          actionCounts: actionCountsWithOutcome(actionCounts, outcome),
          contextSummary: opts.contextSummary,
        }),
        action: 'proposed',
        engine,
        model: engineModel,
        costUsd: opts.usage?.estCostUsd ?? 0,
        tokensIn: opts.usage?.tokensIn ?? 0,
        tokensOut: opts.usage?.tokensOut ?? 0,
        durationMs: opts.durationMs ?? 0,
        cacheHit: opts.usage ? opts.usage.tokensIn === 0 && opts.usage.estCostUsd === 0 : true,
      });
    } catch {
      // telemetry is best-effort — never fails proposal capture
    }

    return {
      state: withProposalOutcome(mk({ result: outcome.reason }), outcome, actionCounts, opts.contextSummary),
      proposalId: proposal.id,
      proposalOutcome: outcome,
    };
  } catch (err) {
    if (opts.signal?.aborted && !proposalCreationStarted) return cancelledCapture();
    const msg = err instanceof Error ? err.message : String(err);
    const outcome = proposalOutcome('proposal-capture-error', `proposal capture failed: ${msg}`);
    return {
      state: withProposalOutcome(mk({ status: 'failed', result: outcome.reason }), outcome, actionCounts, opts.contextSummary),
      proposalOutcome: outcome,
    };
  }
}

/**
 * Run `engine` on `goal` inside a sandbox worktree of `opts.sourceRepo`, capturing
 * the diff as a PENDING proposal. Never throws; failures surface as a 'failed'
 * RunState. Does NOT fall back to a raw (unsandboxed) run — that would defeat the
 * containment, so a sandbox-creation failure is terminal here.
 */
export async function runEngineSandboxed(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  opts: RunEngineSandboxedOptions,
): Promise<SandboxedEngineResult> {
  const model = opts.model ?? cfg.foundry?.models?.[engine];
  const engineModel = `${engine}:${resolveConcreteModel(engine, cfg, model)}`;
  const tier = engineTierOf(engine, cfg);
  const id = assertSafeExecutionIdentity(
    opts.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let delegationScope = opts.delegationScope
    ? normalizeDelegationScope(opts.delegationScope, {
        origin: 'run',
        sourceRepo: opts.sourceRepo,
        objective: goal,
        runId: id,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        budget: opts.budget,
        backend: {
          engine,
          model: engineModel,
          tier,
          assignedBy: 'sandboxed-engine',
          reason: 'sandboxed autonomous producer',
        },
      })
    : undefined;
  let delegationScopeSummary = summarizeDelegationScope(delegationScope);

  const mk = (over: Partial<RunState>): RunState => ({
    id,
    goal,
    engine,
    provider: 'external',
    engineModel,
    engineTier: tier,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: {
      maxTokens: opts.budget?.maxTokens ?? 0,
      maxSteps: opts.budget?.maxSteps ?? 0,
      allowCloud: opts.budget?.allowCloud ?? false,
    },
    usage: newUsage(),
    tasks: [],
    steps: [],
    status: 'running',
    ...(delegationScopeSummary ? { delegationScope: delegationScopeSummary } : {}),
    ...over,
  });
  const actionCounts: RunActionCounts = {};

  if (opts.signal?.aborted) {
    recordSandboxedRunAgentAction({
      engine,
      engineModel,
      tier,
      runId: id,
      sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      status: 'aborted',
      actionCounts,
    });
    return {
      state: withProposalOutcome(
        mk({ status: 'aborted', result: 'run cancelled before execution', terminationReason: 'cancelled' }),
        undefined,
        actionCounts,
      ),
    };
  }

  if (killSwitchOn() || (cfg.foundry as { killSwitch?: boolean } | undefined)?.killSwitch === true) {
    const outcome = proposalOutcome('kill-switch', 'autonomy kill-switch is ON');
    recordSandboxedRunAgentAction({
      engine,
      engineModel,
      tier,
      runId: id,
      sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      outcome,
      status: 'failed',
      actionCounts,
    });
    return {
      state: withProposalOutcome(mk({ status: 'failed', result: outcome.reason }), outcome, actionCounts),
      proposalOutcome: outcome,
    };
  }

  const wt = await import('../sandbox/worktree.js');

  // Acquire a worktree (reuse the caller's when provided).
  let sb: Sandbox;
  let createdHere = false;
  if (opts.existingWorktree) {
    sb = opts.existingWorktree;
    setRunActionCount(actionCounts, 'sandboxCreated', 0);
  } else {
    try {
      sb = wt.createSandbox(opts.sourceRepo, {
        allowAnyRepo: process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1',
      });
      createdHere = true;
      setRunActionCount(actionCounts, 'sandboxCreated', 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const outcome = proposalOutcome('sandbox-unavailable', `sandbox unavailable: ${msg}`);
      recordSandboxedRunAgentAction({
        engine,
        engineModel,
        tier,
        runId: id,
        sourceRepo: opts.sourceRepo,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        outcome,
        status: 'failed',
        actionCounts,
      });
      return {
        state: withProposalOutcome(mk({ status: 'failed', result: outcome.reason }), outcome, actionCounts),
        proposalOutcome: outcome,
      };
    }
  }
  if (opts.delegationScope) {
    delegationScope = normalizeDelegationScope(opts.delegationScope, {
      origin: 'run',
      sourceRepo: opts.sourceRepo,
      executionRoot: sb.worktreePath,
      objective: goal,
      runId: id,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      budget: opts.budget,
      backend: {
        engine,
        model: engineModel,
        tier,
        assignedBy: 'sandboxed-engine',
        reason: 'sandboxed autonomous producer',
      },
    });
    delegationScopeSummary = summarizeDelegationScope(delegationScope);
  }

  if (opts.signal?.aborted) {
    recordSandboxedRunAgentAction({
      engine,
      engineModel,
      tier,
      runId: id,
      sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      status: 'aborted',
      actionCounts,
    });
    if (createdHere) {
      try { wt.removeSandbox(sb); } catch { /* removal is idempotent */ }
    }
    return {
      state: withProposalOutcome(
        mk({ status: 'aborted', result: 'run cancelled before engine spawn', terminationReason: 'cancelled' }),
        undefined,
        actionCounts,
      ),
    };
  }

  // Hold authority through the complete agent lifecycle. Creation has its own
  // short fence; this second acquisition closes the gap before agent writes and
  // makes kill/unenroll wait for execution, proposal capture, and cleanup.
  const executionFence = acquireOutwardMutationFence();
  let cleanupAuthority: ReturnType<typeof wt.borrowSandboxCleanupAuthority> = null;
  let executionAuthorityFailure: string | undefined;
  if (!ownsOutwardMutationFence(executionFence)) {
    executionAuthorityFailure = 'outward mutation fence unavailable before engine execution';
  } else {
    try {
      assertMayMutate(opts.sourceRepo, {
        allowAnyRepo: process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1',
      });
      cleanupAuthority = wt.borrowSandboxCleanupAuthority(executionFence);
      if (!cleanupAuthority) throw new Error('outward mutation authority became invalid before engine execution');
    }
    catch (err) { executionAuthorityFailure = err instanceof Error ? err.message : String(err); }
  }
  if (executionAuthorityFailure) {
    releaseOutwardMutationFence(executionFence);
    if (createdHere) {
      try { wt.removeSandbox(sb); } catch { /* removal is idempotent */ }
    }
    const outcome = proposalOutcome('sandbox-unavailable', executionAuthorityFailure);
    recordSandboxedRunAgentAction({
      engine, engineModel, tier, runId: id, sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId, workSource: opts.workSource,
      outcome, status: 'failed', actionCounts,
    });
    return {
      state: withProposalOutcome(mk({ status: 'failed', result: outcome.reason }), outcome, actionCounts),
      proposalOutcome: outcome,
    };
  }

  const hooksDir = installPrePushBlocker();
  const env = buildContainedEnv(cfg, hooksDir);
  let sandboxRetention: SandboxRetentionEvidence | undefined;
  let processCleanupFailure: SpawnEngineResult | undefined;

  // M248: inject CLAUDE_SESSION_ID so fleet savings land under nameable
  // ashlr-fleet-* keys in ~/.ashlr/stats.json — visible in ashlr__savings.
  env.CLAUDE_SESSION_ID = `ashlr-fleet-${id}`;

  let proposalId: string | undefined;
  let proposalOutcomeResult: RunProposalOutcome | undefined;

  // M248: write a fleet-owned MCP sidecar to the worktree (guarded: only when ashlr is on PATH).
  // fleetMcp defaults to true (on) — set cfg.foundry.fleetMcp = false to opt out.
  const fleetMcpEnabled = (cfg.foundry as Record<string, unknown> | undefined)?.['fleetMcp'] !== false;
  let mcpConfigPath: string | null = null;
  if (fleetMcpEnabled) {
    mcpConfigPath = writeMcpConfigIfAvailable(sb.worktreePath);
  }

  // M154: prepend repo-map + localization context to goal when flags are ON.
  // Flag-OFF → contextPrefix is '' → goalWithContext === goal (byte-identical).
  const contextPrefix = buildM154ContextPrefix(goal, opts.sourceRepo, cfg, scopeHintFiles(delegationScope));
  const goalWithContext = `${renderDelegationScopeForPrompt(delegationScope)}${contextPrefix ? contextPrefix + goal : goal}`;

  try {
    let cmd = buildEngineCommand(engine, goalWithContext, cfg, {
      cwd: sb.worktreePath,
      model,
      autonomous: true,
    });

    // M248/MCP safety: inject the worktree MCP config strictly for Claude so
    // daemon runs get only the sandbox-local ashlr MCP server, not global MCPs.
    // Codex does not support --mcp-config (no equivalent flag) — skip silently.
    // Any other cli-agent: skip (safe no-op fallback).
    if (cmd && mcpConfigPath && engine === 'claude') {
      cmd = { ...cmd, args: [...cmd.args, '--mcp-config', mcpConfigPath, '--strict-mcp-config'] };
    }
    if (!cmd) {
      proposalOutcomeResult = proposalOutcome('engine-command-missing', `no command for engine "${engine}"`);
      recordSandboxedRunAgentAction({
        engine,
        engineModel,
        tier,
        runId: id,
        sourceRepo: opts.sourceRepo,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        outcome: proposalOutcomeResult,
        status: 'failed',
        actionCounts,
      });
      return {
        state: withProposalOutcome(mk({ status: 'failed', result: proposalOutcomeResult.reason }), proposalOutcomeResult, actionCounts),
        proposalOutcome: proposalOutcomeResult,
      };
    }

    // M249: RunCache SHADOW MODE — compute the key and log would-hit/would-miss.
    // SAFETY INVARIANT: this block NEVER short-circuits the spawn. It is purely
    // observational. The spawn always proceeds regardless of hit/miss.
    // Flag-off (default): the entire block is skipped → byte-identical behavior.
    let _shadowCacheKey: string | undefined;
    try {
      const fabricCfg = (cfg.foundry as Record<string, unknown> | undefined)?.['fabric'] as
        Record<string, unknown> | undefined;
      if (fabricCfg?.['cacheShadow'] === true) {
        const _keyInput = buildCacheKeyInput(engine, engineModel, tier, goalWithContext, opts.sourceRepo, cfg);
        _shadowCacheKey = buildCacheKey(_keyInput);
        const _hit = cacheLookup(cfg, _shadowCacheKey, opts.sourceRepo);
        // Log to decisions ledger (best-effort, fire-and-forget, never throws).
        try {
          const { recordDecision } = await import('../fleet/decisions-ledger.js');
          recordDecision({
            ts: new Date().toISOString(),
            proposalId: `shadow-${id}`,
            ...sandboxedProducerCausalMetadata({
              engine,
              engineModel,
              tier,
              runId: id,
              workItemId: opts.workItemId,
              workSource: opts.workSource,
              proposalId: `shadow-${id}`,
              status: 'shadow',
            }),
            action: 'proposed',
            engine,
            model: engineModel,
            detail: JSON.stringify({
              event: 'fabric.shadow',
              cacheKey: _shadowCacheKey,
              wouldHit: _hit !== null,
              repoTreeSha: _keyInput.repoTreeSha,
              dirtyHash: _keyInput.dirtyHash,
            }),
          });
        } catch { /* telemetry is best-effort */ }
        // NEVER short-circuit here — always fall through to spawn below.
      }
    } catch { /* shadow hook is best-effort — never affects run */ }

    // M52: compute the OS-level sandbox launcher for this engine.
    // confinementProfileFor is pure; buildSandboxLauncher may throw when
    // onUnsupported:'fail' and the platform has no jail binary — that
    // propagates as a failed run (caught in spawnEngine's never-throw wrapper).
    // buildContainedEnv, the pre-push hook, and the diff/provenance logic are
    // all unchanged — the launcher wraps the final spawn only.
    const confinementProfile = confinementProfileFor(engine, cfg);
    const launcher = buildSandboxLauncher(confinementProfile, {
      worktree: sb.worktreePath,
      home: process.env.HOME ?? process.env.USERPROFILE,
      env: env,
    });

    // Emit confinement audit event (append-only, never throws).
    auditConfinement({
      action: 'confinement.run',
      repo: sb.worktreePath,
      sandboxId: sb.id,
      summary: `engine=${engine} mode=${confinementProfile.mode ?? 'off'} platform=${process.platform} launched=${launcher !== null} networkEgress=${confinementProfile.networkEgress ?? false}`,
      result: 'ok',
    });

    // M236: spawnEngine is now async + streaming. The stall monitor is wired
    // inside spawnEngineInner (engines.ts) and terminates the child on stall
    // conditions (idle / loop / no-diff). terminationReason surfaces here via
    // the return value and is recorded on the RunState.
    // M246: capture wall-clock duration for durationMs telemetry.
    // M297: retry only empty-diff transient aborts. Partial work, stall
    // terminations, and non-transient failures fall through to the existing
    // capture/proposal path.
    const maxAttempts = dispatchMaxAttempts(cfg);
    let res: SpawnEngineResult = { ok: false, output: '', error: 'engine did not run' };
    let _spawnDurationMs = 0;
    const usage = newUsage();
    let hasReportedUsage = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.signal?.aborted) {
        res = { ok: false, output: '', error: 'run cancelled', terminationReason: 'cancelled' };
        break;
      }
      incrementRunActionCount(actionCounts, 'spawnAttempts');
      const _spawnStart = Date.now();
      res = await spawnEngine(cmd, cfg, {
        env,
        timeoutMs: cfg.foundry?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        launcher: launcher ?? undefined,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const invocationCount = 1 + (res.configRecoveryAttempts ?? 0);
      if (res.configRecoveryAttempts) {
        incrementRunActionCount(actionCounts, 'spawnAttempts', res.configRecoveryAttempts);
      }
      usage.steps += invocationCount;
      setRunActionCount(actionCounts, 'modelSteps', usage.steps);
      setRunActionCount(actionCounts, 'totalSteps', usage.steps);
      const invocationDurationMs = Date.now() - _spawnStart;
      _spawnDurationMs += invocationDurationMs;
      if (res.usage) {
        hasReportedUsage = true;
        usage.tokensIn += res.usage.tokensIn;
        usage.tokensOut += res.usage.tokensOut;
        usage.estCostUsd = estCostUsd(engine, usage.tokensIn, usage.tokensOut);
      }

      // Persist one fixed-schema row per actual retry attempt. Raw prompt/argv,
      // output/error, paths, diffs, environment, and file content never cross
      // this boundary.
      recordAgentDiagnostic({
        runId: id,
        engine,
        ok: res.ok,
        ...(res.terminationReason ? { terminationReason: res.terminationReason } : {}),
        errorClass: classifyAgentDiagnosticError(res.error),
        durationMs: invocationDurationMs,
        attempt,
        maxAttempts,
        ...(res.configRecoveryAttempts !== undefined
          ? { configRecoveryAttempts: res.configRecoveryAttempts }
          : {}),
        ...(res.usage?.tokensIn !== undefined ? { tokensIn: res.usage.tokensIn } : {}),
        ...(res.usage?.tokensOut !== undefined ? { tokensOut: res.usage.tokensOut } : {}),
        output: measureAgentDiagnosticText(res.output),
        error: measureAgentDiagnosticText(res.error),
      });

      if (opts.signal?.aborted || res.terminationReason === 'cancelled') break;

      if (res.ok) break;

      let hasDiff = false;
      try {
        const diff = wt.sandboxDiff(sb);
        setRunDiffActionCounts(actionCounts, diff);
        hasDiff = diff.files > 0 && diff.patch.trim().length > 0;
      } catch {
        hasDiff = false;
      }

      if (attempt < maxAttempts && isTransientAbort(res, hasDiff)) {
        incrementRunActionCount(actionCounts, 'transientRetries');
        continue;
      }
      break;
    }

    const terminationReason: TerminationReason | undefined = res.terminationReason;

    const failedAfterAuthoritativeTermination = (
      failure: SpawnEngineResult,
      retainSandbox: boolean,
      captured?: SandboxedEngineResult,
    ): SandboxedEngineResult => {
      if (retainSandbox) sandboxRetention = retainedSandboxEvidence(sb);
      const capturedProposalId = captured?.proposalId;
      const capturedOutcome = captured?.proposalOutcome;
      const result = retainSandbox
        ? `engine "${engine}" failed with sandbox retained: ${failure.error ?? 'process cleanup unconfirmed'}`
        : `engine "${engine}" failed: ${failure.error ?? 'termination failed'}`;
      recordSandboxedRunAgentAction({
        engine,
        engineModel,
        tier,
        runId: id,
        sourceRepo: opts.sourceRepo,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        proposalId: capturedProposalId,
        outcome: capturedOutcome,
        status: 'failed',
        usage,
        durationMs: _spawnDurationMs,
        actionCounts,
      });
      return {
        state: withSandboxRetention(
          withProposalOutcome(
            mk({ status: 'failed', result, usage, terminationReason: failure.terminationReason }),
            capturedOutcome,
            actionCounts,
          ),
          sandboxRetention,
        ),
        ...(capturedProposalId ? { proposalId: capturedProposalId } : {}),
        ...(capturedOutcome ? { proposalOutcome: capturedOutcome } : {}),
        ...(sandboxRetention ? { sandboxRetention } : {}),
      };
    };

    const cancelledAfterSpawn = (captured?: SandboxedEngineResult): SandboxedEngineResult => {
      // A settled error exit is process truth. A signal arriving while its
      // partial diff is being captured cannot retroactively relabel it cancelled.
      if (terminationReason === 'error-exit') {
        return failedAfterAuthoritativeTermination(res, processCleanupUnconfirmed(res), captured);
      }
      const capturedProposalId = captured?.proposalId;
      const capturedOutcome = captured?.proposalOutcome;
      recordSandboxedRunAgentAction({
        engine,
        engineModel,
        tier,
        runId: id,
        sourceRepo: opts.sourceRepo,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        proposalId: capturedProposalId,
        outcome: capturedOutcome,
        status: 'aborted',
        usage,
        durationMs: _spawnDurationMs,
        actionCounts,
      });
      return {
        state: withProposalOutcome(
          mk({ status: 'aborted', result: 'run cancelled', usage, terminationReason: 'cancelled' }),
          capturedOutcome,
          actionCounts,
        ),
        ...(capturedProposalId ? { proposalId: capturedProposalId } : {}),
        ...(capturedOutcome ? { proposalOutcome: capturedOutcome } : {}),
      };
    };

    if (processCleanupUnconfirmed(res)) {
      return failedAfterAuthoritativeTermination(res, true);
    }

    if (terminationReason === 'error-exit' && opts.signal?.aborted) {
      return failedAfterAuthoritativeTermination(res, false);
    }

    if (
      terminationReason === 'cancelled' ||
      (opts.signal?.aborted && terminationReason !== 'error-exit')
    ) {
      return cancelledAfterSpawn();
    }

    if (!res.ok) {
      // M233: even on timeout/non-zero exit, attempt to capture a partial diff.
      // If the agent did real work before the cap, save it as a PENDING proposal
      // marked isPartial:true so the judge/reviewer knows it may be incomplete.
      // A truly-empty diff (agent made no edits) is not filed — no-op run stays blocked.
      if (opts.propose !== false) {
        try {
          const captured = await captureSandboxedProposal(engine, goal, cfg, {
            sourceRepo: opts.sourceRepo,
            model,
            budget: opts.budget,
            runId: id,
            existingWorktree: sb,
            workItemId: opts.workItemId,
            workItemGenerationId: opts.workItemGenerationId,
            workSource: opts.workSource,
            delegationScope,
            ...(opts.signal ? { signal: opts.signal } : {}),
            isPartial: true,
            usage,
            durationMs: _spawnDurationMs,
            producerStatus: 'failed',
            actionCounts,
          });
          if (opts.signal?.aborted || captured.state.status === 'aborted') {
            return cancelledAfterSpawn(captured);
          }
          proposalId = captured.proposalId;
          proposalOutcomeResult = captured.proposalOutcome;
          if (proposalOutcomeResult?.kind === 'empty-diff') {
            proposalOutcomeResult = proposalOutcome(
              'engine-failed-no-diff',
              `engine "${engine}" failed before producing a diff: ${res.error ?? terminationReason ?? 'unknown error'}`,
            );
          }
        } catch (err) {
          if (opts.signal?.aborted) return cancelledAfterSpawn();
          const msg = err instanceof Error ? err.message : String(err);
          proposalOutcomeResult = proposalOutcome('proposal-capture-error', `proposal capture failed after engine error: ${msg}`);
          // diff/proposal capture is best-effort — never fail the run on it.
        }
      } else {
        trySetRunDiffActionCounts(actionCounts, () => wt.sandboxDiff(sb));
        proposalOutcomeResult = proposalOutcome('proposal-disabled', 'proposal filing disabled for this sandboxed attempt');
      }
      recordSandboxedRunAgentAction({
        engine,
        engineModel,
        tier,
        runId: id,
        sourceRepo: opts.sourceRepo,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        proposalId,
        outcome: proposalOutcomeResult,
        status: 'failed',
        usage,
        durationMs: _spawnDurationMs,
        actionCounts,
      });
      return {
        state: withProposalOutcome(
          mk({ status: 'failed', result: `engine "${engine}" failed: ${res.error ?? 'unknown error'}`, usage, terminationReason }),
          proposalOutcomeResult,
          actionCounts,
        ),
        proposalId,
        proposalOutcome: proposalOutcomeResult,
      };
    }

    // Capture the worktree diff (best-effort) and file it as a PENDING proposal.
    if (opts.propose !== false) {
      incrementRunActionCount(actionCounts, 'proposalCaptureAttempts');
      try {
        const diff = wt.sandboxDiff(sb);
        setRunDiffActionCounts(actionCounts, diff);
        if (diff.files > 0 && diff.patch.trim().length > 0) {
          const trivialOutcome = trivialProposalOutcomeForDiff(diff);
          if (trivialOutcome) {
            proposalOutcomeResult = trivialOutcome;
          } else {
          // M47.1 (H3): scrub ONCE and reuse the same scrubbed string for BOTH
          // the stored diff and the signed hash — so the merge gate recomputes
          // an identical hash. Bind {engineModel, tier, diffHash} with an HMAC
          // so a forged on-disk record cannot claim frontier merge-authority.
          // M331: bindings are `let` — a verify-to-green repair mutates the
          // worktree, so the diff is re-captured and RE-SIGNED after repair.
          let effDiff = diff;
          let scrubbed = canonicalizeProposalDiff(effDiff.patch);
          let diffHash = hashDiff(scrubbed);
          let provenanceSig = signProvenance(engineModel, tier, diffHash);
          // M275: completeness + self-verify gate. Runs typecheck/test in the
          // sandbox worktree before filing. Flag-off → byte-identical to pre-M275.
          let _m275ShouldFile = true;
          if (cfg.foundry?.completenessGate !== false) {
            incrementRunActionCount(actionCounts, 'completenessGateRuns');
            let _gateResult = await runCompletenessGate({
              worktreePath: sb.worktreePath,
              diff: effDiff,
              goal,
              cfg,
            });
            if (opts.signal?.aborted) return cancelledAfterSpawn();
            // M331: verify-to-green — bounded repair loop (DEFAULT OFF). When
            // the gate fails, re-invoke the SAME engine inside the SAME confined
            // worktree (identical contained env + OS sandbox launcher — worktree
            // jail and severed push fully preserved) with the failure tail, then
            // re-verify. Only a green worktree is filed, re-signed against the
            // repaired diff. Flag-off ⇒ the single-shot gate above, unchanged.
            const _v2g = cfg.foundry?.verifyToGreen;
            // Repair invocations are model steps. Book each returned invocation
            // directly into the shared usage exactly once so cancellation and
            // proposal telemetry observe the same authoritative totals.
            if (!_gateResult.pass && _v2g?.enabled === true) {
              const _v2gOut = await iterateToGreen({
                cfg,
                initialFailure: String(_gateResult.reason ?? ''),
                ...(opts.signal ? { signal: opts.signal } : {}),
                verify: async () => {
                  if (opts.signal?.aborted) return { pass: false, reason: 'cancelled' };
                  const d = wt.sandboxDiff(sb);
                  incrementRunActionCount(actionCounts, 'completenessGateRuns');
                  const g = await runCompletenessGate({
                    worktreePath: sb.worktreePath,
                    diff: d,
                    goal,
                    cfg,
                  });
                  if (opts.signal?.aborted) return { pass: false, reason: 'cancelled' };
                  return { pass: g.pass, reason: String(g.reason ?? '') };
                },
                repair: async (failureTail: string) => {
                  if (opts.signal?.aborted) return null;
                  const maxSteps = opts.budget?.maxSteps;
                  if (maxSteps !== undefined && usage.steps >= Math.max(0, maxSteps)) {
                    return null;
                  }
                  const repairGoal =
                    `${goal}\n\n[verify-to-green] A previous attempt failed verification. ` +
                    `Fix ONLY what is needed to make the checks pass — do not start new work.\n` +
                    `Verification failure (tail):\n${failureTail}`;
                  const repairCmd = buildEngineCommand(engine, repairGoal, cfg, {
                    cwd: sb.worktreePath,
                    model,
                    autonomous: true,
                  });
                  if (!repairCmd) return null;
                  incrementRunActionCount(actionCounts, 'verifyRepairAttempts');
                  incrementRunActionCount(actionCounts, 'spawnAttempts');
                  const r = await spawnEngine(repairCmd, cfg, {
                    env,
                    timeoutMs: _v2g.perRunTimeoutMs ?? 180_000,
                    launcher: launcher ?? undefined,
                    ...(opts.signal ? { signal: opts.signal } : {}),
                  });
                  const invocationCount = 1 + (r.configRecoveryAttempts ?? 0);
                  if (r.configRecoveryAttempts) {
                    incrementRunActionCount(actionCounts, 'spawnAttempts', r.configRecoveryAttempts);
                  }
                  usage.steps += invocationCount;
                  setRunActionCount(actionCounts, 'modelSteps', usage.steps);
                  setRunActionCount(actionCounts, 'totalSteps', usage.steps);
                  if (r.usage) {
                    hasReportedUsage = true;
                    usage.tokensIn += r.usage.tokensIn;
                    usage.tokensOut += r.usage.tokensOut;
                    usage.estCostUsd = estCostUsd(engine, usage.tokensIn, usage.tokensOut);
                  }
                  if (processCleanupUnconfirmed(r)) processCleanupFailure = r;
                  return { ok: r.ok };
                },
              });
              if (processCleanupFailure) {
                return failedAfterAuthoritativeTermination(processCleanupFailure, true);
              }
              if (opts.signal?.aborted || _v2gOut.stopped === 'cancelled') {
                return cancelledAfterSpawn();
              }
              if (_v2gOut.green) {
                const repaired = wt.sandboxDiff(sb);
                if (repaired.files > 0 && repaired.patch.trim().length > 0) {
                  effDiff = repaired;
                  scrubbed = canonicalizeProposalDiff(effDiff.patch);
                  diffHash = hashDiff(scrubbed);
                  provenanceSig = signProvenance(engineModel, tier, diffHash);
                  _gateResult = {
                    ..._gateResult,
                    pass: true,
                    reason: `verify-to-green: green after ${_v2gOut.iterations} repair iteration(s)`,
                  };
                  console.log(`[M331] ${_gateResult.reason}`);
                }
              }
            }
            if (!_gateResult.pass) {
              console.log(`[M275] completeness gate blocked proposal: ${_gateResult.reason}`);
              proposalOutcomeResult = proposalOutcome(
                'completeness-gate',
                `completeness gate blocked proposal: ${_gateResult.reason ?? 'blocked'}`,
                effDiff,
              );
              _m275ShouldFile = false;
            }
          }
          if (_m275ShouldFile) {
          if (opts.signal?.aborted) return cancelledAfterSpawn();
          const filedOutcomeForMetadata = proposalOutcome('filed', 'proposal filed', effDiff);
          const inbox = selectInboxStore(cfg);
          const proposal = inbox.create({
            repo: sb.sourceRepo,
            origin: 'agent',
            kind: 'patch',
            title: `${engine} run: ${goal.slice(0, 80)}`,
            summary:
              `Sandboxed ${engineModel} run produced ${effDiff.files} file(s) ` +
              `(+${effDiff.insertions}/-${effDiff.deletions}). Review before applying.`,
            diff: scrubbed,
            diffHash,
            provenanceSig,
            sandboxId: sb.id,
            workItemId: opts.workItemId,
            ...(opts.workItemGenerationId ? { workItemGenerationId: opts.workItemGenerationId } : {}),
            workSource: opts.workSource,
            runId: id,
            engineModel,
            engineTier: tier,
            ...(delegationScopeSummary ? { delegationScope: delegationScopeSummary } : {}),
            ...sandboxedProducerCausalMetadata({
              engine,
              engineModel,
              tier,
              runId: id,
              workItemId: opts.workItemId,
              workSource: opts.workSource,
              outcome: filedOutcomeForMetadata,
              usage,
              durationMs: _spawnDurationMs,
              status: 'done',
              actionCounts: actionCountsWithOutcome(actionCounts, filedOutcomeForMetadata),
            }),
          });
          if (isDiffDedupResult(proposal)) {
            proposalOutcomeResult = duplicateDiffOutcome(proposal, effDiff);
          } else {
            const persisted = proposal.status === 'pending' ? inbox.load(proposal.id) : null;
            const durablePending =
              proposal.status === 'pending' &&
              persisted?.status === 'pending' &&
              persisted.id === proposal.id &&
              persisted.repo === sb.sourceRepo &&
              persisted.runId === id &&
              persisted.diffHash === diffHash &&
              persisted.provenanceSig === provenanceSig &&
              persisted.diff === scrubbed;
            if (!durablePending) {
              proposalOutcomeResult = proposalOutcome(
                'proposal-capture-error',
                'proposal was not durably persisted with matching capture metadata',
                effDiff,
              );
            } else {
            proposalId = proposal.id;
            proposalOutcomeResult = proposalOutcome('filed', 'proposal filed', effDiff, proposal.id);
            // M246: record telemetry fields on the decision entry (additive, never-throws).
            try {
              const { recordDecision } = await import('../fleet/decisions-ledger.js');
              recordDecision({
                ts: new Date().toISOString(),
                proposalId: proposal.id,
                ...sandboxedProducerCausalMetadata({
                  engine,
                  engineModel,
                  tier,
                  runId: id,
                  workItemId: opts.workItemId,
                  workSource: opts.workSource,
                  proposalId: proposal.id,
                  outcome: proposalOutcomeResult,
                  usage,
                  durationMs: _spawnDurationMs,
                  status: 'done',
                  actionCounts: actionCountsWithOutcome(actionCounts, proposalOutcomeResult),
                }),
                action: 'proposed',
                engine,
                model: engineModel,
                // M337 (review fix): `usage` includes verify-to-green repair
                // spend when the loop ran — book the true totals.
                costUsd: usage.estCostUsd,
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
                durationMs: _spawnDurationMs,
                cacheHit: hasReportedUsage ? (usage.tokensIn === 0 && usage.estCostUsd === 0) : false,
              });
            } catch {
              // telemetry is best-effort — never fails the run
            }
            if (opts.signal?.aborted) {
              return cancelledAfterSpawn({
                state: withProposalOutcome(
                  mk({ status: 'done', result: proposalOutcomeResult.reason, usage }),
                  proposalOutcomeResult,
                  actionCounts,
                ),
                proposalId,
                proposalOutcome: proposalOutcomeResult,
              });
            }
            // M249: RunCache shadow write — record the (key → outcome) entry for
            // measurement. Fire-and-forget, never throws, never changes run behavior.
            // Flag-off (default cacheShadow === false) → cacheWrite is a no-op.
            try {
              if (_shadowCacheKey) {
                const _entry: CacheEntry = {
                  key: _shadowCacheKey,
                  patch: scrubbed,
                  provenanceSig,
                  engineModel,
                  tier,
                  diffHash,
                  repoTreeSha: (() => {
                    try {
                      return execSync('git rev-parse HEAD:', {
                        cwd: opts.sourceRepo,
                        encoding: 'utf8',
                        stdio: ['pipe', 'pipe', 'pipe'],
                      }).trim();
                    } catch { return 'unknown'; }
                  })(),
                  verdictAtWrite: 'unknown',
                  shipOutcomes: { ship: 0, reject: 0 },
                  createdAt: new Date().toISOString(),
                  lastHit: new Date().toISOString(),
                  hits: 0,
                  schemaVersion: 1,
                };
                cacheWrite(cfg, _entry, opts.sourceRepo);
              }
            } catch { /* shadow write is best-effort */ }
            }
          }
          } // end if (_m275ShouldFile)
          }
        } else {
          proposalOutcomeResult = proposalOutcome('empty-diff', `engine "${engine}" completed without file changes`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        proposalOutcomeResult = proposalOutcome('proposal-capture-error', `proposal capture failed: ${msg}`);
        // diff/proposal capture is best-effort — never fail the run on it.
      }
    } else {
      trySetRunDiffActionCounts(actionCounts, () => wt.sandboxDiff(sb));
      proposalOutcomeResult = proposalOutcome('proposal-disabled', 'proposal filing disabled for this sandboxed attempt');
    }

    recordSandboxedRunAgentAction({
      engine,
      engineModel,
      tier,
      runId: id,
      sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      proposalId,
      outcome: proposalOutcomeResult,
      status: 'done',
      usage,
      durationMs: _spawnDurationMs,
      actionCounts,
    });
    return {
      state: withProposalOutcome(mk({ status: 'done', result: res.output, usage }), proposalOutcomeResult, actionCounts),
      proposalId,
      proposalOutcome: proposalOutcomeResult,
    };
  } finally {
    if (!sandboxRetention) {
      try {
        rmSync(hooksDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    if (createdHere && !sandboxRetention) {
      try {
        wt.removeSandboxWithBorrowedAuthority(sb, cleanupAuthority);
      } catch {
        // removal is idempotent
      }
    }
    releaseOutwardMutationFence(executionFence);
  }
}

// ---------------------------------------------------------------------------
// M117: runApiModelSandboxed — in-process api-model dispatch
// ---------------------------------------------------------------------------

/**
 * Run an api-model engine (e.g. local-coder / Ollama) IN-PROCESS inside a
 * sandbox worktree, capturing the resulting diff as a PENDING inbox proposal.
 *
 * Unlike runEngineSandboxed (which spawns a CLI subprocess), this function:
 *   1. Builds a ProviderClient for the engine's api config (openai-compat →
 *      Ollama at http://localhost:11434/v1, or whatever baseUrl is configured).
 *   2. Gives the agent-loop engineer write-tools (read_file / write_file /
 *      edit_file / bash) scoped to the sandbox worktree so every edit lands
 *      ONLY in the throwaway branch.
 *   3. Captures the worktree diff and files it as a PENDING proposal — identical
 *      provenance/scrub/sign path as runEngineSandboxed.
 *
 * Security model: identical to runEngineSandboxed for filesystem containment
 * (edits go into the worktree only). Network is NOT OS-jailed (the in-process
 * agent makes fetch calls directly) — the same residual as cli-agent sandbox,
 * and intentional: Ollama runs at localhost:11434 which must be reachable.
 */
export async function runApiModelSandboxed(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  opts: RunEngineSandboxedOptions,
): Promise<SandboxedEngineResult> {
  const actionCounts: RunActionCounts = {};
  const spec = resolveEngineSpec(engine, cfg);
  if (!spec || spec.kind !== 'api-model' || !spec.api) {
    const outcome = proposalOutcome('engine-unsupported', `engine "${engine}" is not an api-model — cannot run in-process`);
    const unsupportedRunId = `run-${Date.now().toString(36)}`;
    recordSandboxedRunAgentAction({
      engine,
      engineModel: `${engine}:${resolveConcreteModel(engine, cfg, opts.model)}`,
      tier: engineTierOf(engine, cfg),
      runId: unsupportedRunId,
      sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      outcome,
      status: 'failed',
      actionCounts,
    });
    return {
      state: withProposalOutcome({
        id: unsupportedRunId,
        goal,
        engine,
        provider: 'none',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        budget: { maxTokens: 0, maxSteps: 0, allowCloud: false },
        usage: newUsage(),
        tasks: [],
        steps: [],
        status: 'failed',
        result: outcome.reason,
      }, outcome, actionCounts),
      proposalOutcome: outcome,
    };
  }

  const modelFromCfg = opts.model ?? cfg.foundry?.models?.[engine] ?? spec.api.defaultModel ?? '';
  const model = modelFromCfg || (spec.api.defaultModel ?? '');
  const engineModel = `${engine}:${resolveConcreteModel(engine, cfg, model || undefined)}`;
  const tier = engineTierOf(engine, cfg);
  const id = assertSafeExecutionIdentity(
    opts.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let delegationScope = opts.delegationScope
    ? normalizeDelegationScope(opts.delegationScope, {
        origin: 'run',
        sourceRepo: opts.sourceRepo,
        objective: goal,
        runId: id,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        budget: opts.budget,
        backend: {
          engine,
          model: engineModel,
          tier,
          assignedBy: 'sandboxed-engine',
          reason: 'api-model sandboxed producer',
        },
      })
    : undefined;
  let delegationScopeSummary = summarizeDelegationScope(delegationScope);

  const mk = (over: Partial<RunState>): RunState => ({
    id,
    goal,
    engine,
    provider: spec.api!.protocol ?? 'openai-compat',
    engineModel,
    engineTier: tier,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: {
      maxTokens: opts.budget?.maxTokens ?? 50_000,
      maxSteps: opts.budget?.maxSteps ?? 40,
      allowCloud: opts.budget?.allowCloud ?? false,
    },
    usage: newUsage(),
    tasks: [],
    steps: [],
    status: 'running',
    ...(delegationScopeSummary ? { delegationScope: delegationScopeSummary } : {}),
    ...over,
  });

  if (opts.signal?.aborted) {
    recordSandboxedRunAgentAction({
      engine,
      engineModel,
      tier,
      runId: id,
      sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      status: 'aborted',
      actionCounts,
    });
    return {
      state: withProposalOutcome(
        mk({ status: 'aborted', result: 'run cancelled before execution', terminationReason: 'cancelled' }),
        undefined,
        actionCounts,
      ),
    };
  }

  const wt = await import('../sandbox/worktree.js');

  // Acquire sandbox worktree (reuse caller's when provided).
  let sb: Sandbox;
  let createdHere = false;
  if (opts.existingWorktree) {
    sb = opts.existingWorktree;
    setRunActionCount(actionCounts, 'sandboxCreated', 0);
  } else {
    try {
      sb = wt.createSandbox(opts.sourceRepo, {
        allowAnyRepo: process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1',
      });
      createdHere = true;
      setRunActionCount(actionCounts, 'sandboxCreated', 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const outcome = proposalOutcome('sandbox-unavailable', `sandbox unavailable: ${msg}`);
      recordSandboxedRunAgentAction({
        engine,
        engineModel,
        tier,
        runId: id,
        sourceRepo: opts.sourceRepo,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        outcome,
        status: 'failed',
        actionCounts,
      });
      return {
        state: withProposalOutcome(mk({ status: 'failed', result: outcome.reason }), outcome, actionCounts),
        proposalOutcome: outcome,
      };
    }
  }
  if (opts.delegationScope) {
    delegationScope = normalizeDelegationScope(opts.delegationScope, {
      origin: 'run',
      sourceRepo: opts.sourceRepo,
      executionRoot: sb.worktreePath,
      objective: goal,
      runId: id,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      budget: opts.budget,
      backend: {
        engine,
        model: engineModel,
        tier,
        assignedBy: 'sandboxed-engine',
        reason: 'api-model sandboxed producer',
      },
    });
    delegationScopeSummary = summarizeDelegationScope(delegationScope);
  }

  if (opts.signal?.aborted) {
    recordSandboxedRunAgentAction({
      engine,
      engineModel,
      tier,
      runId: id,
      sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      status: 'aborted',
      actionCounts,
    });
    if (createdHere) {
      try { wt.removeSandbox(sb); } catch { /* removal is idempotent */ }
    }
    return {
      state: withProposalOutcome(
        mk({ status: 'aborted', result: 'run cancelled before provider request', terminationReason: 'cancelled' }),
        undefined,
        actionCounts,
      ),
    };
  }

  const executionFence = acquireOutwardMutationFence();
  let cleanupAuthority: ReturnType<typeof wt.borrowSandboxCleanupAuthority> = null;
  let executionAuthorityFailure: string | undefined;
  if (!ownsOutwardMutationFence(executionFence)) {
    executionAuthorityFailure = 'outward mutation fence unavailable before api-model execution';
  } else {
    try {
      assertMayMutate(opts.sourceRepo, {
        allowAnyRepo: process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1',
      });
      cleanupAuthority = wt.borrowSandboxCleanupAuthority(executionFence);
      if (!cleanupAuthority) throw new Error('outward mutation authority became invalid before api-model execution');
    }
    catch (err) { executionAuthorityFailure = err instanceof Error ? err.message : String(err); }
  }
  if (executionAuthorityFailure) {
    releaseOutwardMutationFence(executionFence);
    if (createdHere) {
      try { wt.removeSandbox(sb); } catch { /* removal is idempotent */ }
    }
    const outcome = proposalOutcome('sandbox-unavailable', executionAuthorityFailure);
    recordSandboxedRunAgentAction({
      engine, engineModel, tier, runId: id, sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId, workSource: opts.workSource,
      outcome, status: 'failed', actionCounts,
    });
    return {
      state: withProposalOutcome(mk({ status: 'failed', result: outcome.reason }), outcome, actionCounts),
      proposalOutcome: outcome,
    };
  }

  let proposalId: string | undefined;
  let proposalOutcomeResult: RunProposalOutcome | undefined;
  const runStartedAt = Date.now();

  try {
    // Build baseUrl — honour env override, then spec default, then Ollama fallback.
    const baseUrlEnv = spec.api.baseUrlEnv;
    const baseUrl = (baseUrlEnv && process.env[baseUrlEnv]?.trim()) ||
      spec.api.defaultBaseUrl ||
      'http://localhost:11434/v1';
    // M195: source the bearer key via the engine-auth mechanism (phantom vault
    // first, then process.env) so NVIDIA_NIM_API_KEY etc. work whether stored in
    // the phantom vault or the raw env. The VALUE is never logged or returned.
    const apiKey = (spec.api.envKey && resolveProviderKey(spec.api.envKey, cfg)?.trim()) || '';

    // qwen2.5:72b confirms tool_calls — treat all local-coder models as tool-capable.
    const supportsTools = true;

    const client = buildOpenAICompatibleClient(
      baseUrl,
      apiKey,
      model,
      supportsTools,
      undefined,
      opts.signal,
    );

    // Engineer tools scoped to the sandbox worktree — write/exec enabled so the
    // model can make real file edits inside the throwaway branch.
    const engCtx: EngineerContext = {
      workspaceRoot: sb.worktreePath,
      sourceRepo: sb.sourceRepo,
      allowWrite: true,
      allowExec: false, // exec disabled: keep blast radius minimal for local model
    };
    const tools = buildEngineerToolSpecs(engCtx);

    const budget = {
      maxTokens: opts.budget?.maxTokens ?? 50_000,
      maxSteps: opts.budget?.maxSteps ?? 40,
      allowCloud: false,
    };
    const usage: RunUsage = newUsage();
    const steps: RunState['steps'] = [];

    // M154: prepend repo-map + localization context to goal when flags are ON.
    // Flag-OFF → contextPrefix2 is '' → task.goal === goal (byte-identical).
    const contextPrefix2 = buildM154ContextPrefix(goal, opts.sourceRepo, cfg, scopeHintFiles(delegationScope));
    const goalWithContext2 = `${renderDelegationScopeForPrompt(delegationScope)}${contextPrefix2 ? contextPrefix2 + goal : goal}`;

    const task: RunTask = {
      id: 't1',
      goal: goalWithContext2,
      deps: [],
      status: 'pending',
    };

    // M264: build elite context bundle for local engines (flag-gated, never-throws).
    // Frontier engines are excluded by isLocalContextEnabled. Flag-off → systemPrefix
    // is undefined → runTask system prompt is byte-identical to pre-M264.
    let m264SystemPrefix: string | undefined;
    let m264ContextSummary: RunContextSummary | undefined;
    if (isLocalContextEnabled(engine, cfg) && delegationScope?.memoryMode !== 'none') {
      try {
        const bundle = await buildLocalContextBundle(goal, sb.worktreePath, cfg);
        m264ContextSummary = summarizeLocalContextBundle(bundle, { toolCount: tools.length });
        const rendered = renderLocalContextBundle(bundle);
        if (rendered.length > 0) m264SystemPrefix = rendered;
      } catch {
        // Context injection is best-effort — never fails the run.
      }
    }

    await runTask(task, client, {
      tools,
      budget,
      usage,
      adaptivePrompts: adaptivePromptsEnabled(cfg),
      onStep: (step) => {
        steps.push(step);
        if (step.usage) {
          const next = addUsage(usage, step.usage);
          usage.tokensIn = next.tokensIn;
          usage.tokensOut = next.tokensOut;
          usage.steps = next.steps;
          usage.estCostUsd = next.estCostUsd;
        }
      },
      systemPrefix: m264SystemPrefix,
      // Direct API runs expose only reversible sandbox write tools. A fresh
      // generation lets a discarded sandbox be reconstructed; callers under a
      // durable run lease supply that exact lease generation instead.
      effectJournal: { scopeId: id, generation: opts.effectGeneration ?? randomUUID() },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    const finalUsage: RunUsage = {
      ...usage,
      estCostUsd: estCostUsd(engine, usage.tokensIn, usage.tokensOut),
    };
    setRunActionCount(actionCounts, 'modelSteps', steps.filter((step) => step.kind === 'model').length);
    setRunActionCount(actionCounts, 'toolSteps', steps.filter((step) => step.kind === 'tool').length);
    setRunActionCount(actionCounts, 'totalSteps', steps.length);
    const durationMs = Date.now() - runStartedAt;
    const isPartialResult =
      typeof task.result === 'string' &&
      (task.result.startsWith('[budget exceeded') || task.result.startsWith('[step cap reached'));

    const cancelledAfterTask = (captured?: SandboxedEngineResult): SandboxedEngineResult => {
      const capturedProposalId = captured?.proposalId;
      const capturedOutcome = captured?.proposalOutcome;
      recordSandboxedRunAgentAction({
        engine,
        engineModel,
        tier,
        runId: id,
        sourceRepo: opts.sourceRepo,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        proposalId: capturedProposalId,
        outcome: capturedOutcome,
        status: 'aborted',
        usage: finalUsage,
        durationMs,
        actionCounts,
        contextSummary: m264ContextSummary,
      });
      return {
        state: withProposalOutcome(
          mk({
            status: 'aborted',
            result: 'run cancelled',
            usage: finalUsage,
            tasks: [task],
            steps,
            terminationReason: 'cancelled',
          }),
          capturedOutcome,
          actionCounts,
          m264ContextSummary,
        ),
        ...(capturedProposalId ? { proposalId: capturedProposalId } : {}),
        ...(capturedOutcome ? { proposalOutcome: capturedOutcome } : {}),
      };
    };

    if (opts.signal?.aborted) {
      return cancelledAfterTask();
    }

    if (task.status === 'failed') {
      if (opts.propose !== false) {
        const captured = await captureSandboxedProposal(engine, goal, cfg, {
          sourceRepo: opts.sourceRepo,
          model,
          budget: opts.budget,
          runId: id,
          existingWorktree: sb,
          workItemId: opts.workItemId,
          workItemGenerationId: opts.workItemGenerationId,
          workSource: opts.workSource,
          delegationScope,
          ...(opts.signal ? { signal: opts.signal } : {}),
          isPartial: true,
          sourceLabel: 'api-model',
          usage: finalUsage,
          durationMs,
          producerStatus: 'failed',
          actionCounts,
          contextSummary: m264ContextSummary,
        });
        if (opts.signal?.aborted || captured.state.status === 'aborted') {
          return cancelledAfterTask(captured);
        }
        proposalId = captured.proposalId;
        proposalOutcomeResult =
          captured.proposalOutcome?.kind === 'empty-diff'
            ? proposalOutcome('api-model-task-failed', task.error ?? 'api-model run failed')
            : captured.proposalOutcome;
      } else {
        trySetRunDiffActionCounts(actionCounts, () => wt.sandboxDiff(sb));
        proposalOutcomeResult = proposalOutcome('proposal-disabled', 'proposal filing disabled for this api-model attempt');
      }
      recordSandboxedRunAgentAction({
        engine,
        engineModel,
        tier,
        runId: id,
        sourceRepo: opts.sourceRepo,
        workItemId: opts.workItemId,
        workSource: opts.workSource,
        proposalId,
        outcome: proposalOutcomeResult,
        status: 'failed',
        usage: finalUsage,
        durationMs,
        actionCounts,
        contextSummary: m264ContextSummary,
      });
      return {
        state: withProposalOutcome(
          mk({
            status: 'failed',
            result: task.error ?? 'api-model run failed',
            usage: finalUsage,
            tasks: [task],
            steps,
          }),
          proposalOutcomeResult,
          actionCounts,
          m264ContextSummary,
        ),
        proposalId,
        proposalOutcome: proposalOutcomeResult,
      };
    }

    // Capture worktree diff and file as PENDING proposal.
    if (opts.propose !== false) {
      try {
        const captured = await captureSandboxedProposal(engine, goal, cfg, {
          sourceRepo: opts.sourceRepo,
          model,
          budget: opts.budget,
          runId: id,
          existingWorktree: sb,
          workItemId: opts.workItemId,
          workItemGenerationId: opts.workItemGenerationId,
          workSource: opts.workSource,
          delegationScope,
          ...(opts.signal ? { signal: opts.signal } : {}),
          isPartial: isPartialResult,
          sourceLabel: 'api-model',
          usage: finalUsage,
          durationMs,
          producerStatus: 'done',
          actionCounts,
          contextSummary: m264ContextSummary,
        });
        if (opts.signal?.aborted || captured.state.status === 'aborted') {
          return cancelledAfterTask(captured);
        }
        proposalId = captured.proposalId;
        proposalOutcomeResult = captured.proposalOutcome;
        if (proposalOutcomeResult?.kind === 'empty-diff') {
          proposalOutcomeResult = proposalOutcome('empty-diff', `api-model engine "${engine}" completed without file changes`);
        }
      } catch (err) {
        if (opts.signal?.aborted) return cancelledAfterTask();
        const msg = err instanceof Error ? err.message : String(err);
        proposalOutcomeResult = proposalOutcome('proposal-capture-error', `api-model proposal capture failed: ${msg}`);
        // diff/proposal capture is best-effort
      }
    } else {
      trySetRunDiffActionCounts(actionCounts, () => wt.sandboxDiff(sb));
      proposalOutcomeResult = proposalOutcome(
        'proposal-disabled',
        'proposal filing disabled for this api-model attempt',
        undefined,
        undefined,
        isPartialResult,
      );
    }

    recordSandboxedRunAgentAction({
      engine,
      engineModel,
      tier,
      runId: id,
      sourceRepo: opts.sourceRepo,
      workItemId: opts.workItemId,
      workSource: opts.workSource,
      proposalId,
      outcome: proposalOutcomeResult,
      status: 'done',
      usage: finalUsage,
      durationMs,
      actionCounts,
      contextSummary: m264ContextSummary,
    });
    return {
      state: withProposalOutcome(
        mk({ status: 'done', result: task.result ?? '', usage: finalUsage, tasks: [task], steps }),
        proposalOutcomeResult,
        actionCounts,
        m264ContextSummary,
      ),
      proposalId,
      proposalOutcome: proposalOutcomeResult,
    };
  } finally {
    if (createdHere) {
      try {
        wt.removeSandboxWithBorrowedAuthority(sb!, cleanupAuthority);
      } catch {
        // removal is idempotent
      }
    }
    releaseOutwardMutationFence(executionFence);
  }
}
