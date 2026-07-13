/**
 * core/run/orchestrator.ts — M4/M11/M15 local-first agent orchestrator.
 *
 * Responsibilities:
 *  - planGoal:  single chat call -> RunTask[] DAG (1-6 tasks, deps valid).
 *  - runGoal:   resolve client, plan/resume, execute DAG (parallel up to opts.parallel),
 *               enforce HARD budget, persist RunState after every step, synthesize
 *               final answer, best-effort Pulse POST.
 *  - loadRun / listRuns / saveRun: JSON persistence under ~/.ashlr/runs/.
 *
 * M7 addition: genome-aware injection. Before planning, runGoal calls
 * recall(goal, cfg) from src/core/genome/recall.ts (dynamic import, best-effort)
 * and prepends a bounded "Relevant project memory:" block to the planning system
 * prompt so the planner starts with relevant cross-project context.
 * Gated on cfg.genome?.injectOnRun (default true) and opts.noMemory (opt-out).
 * Never throws — if recall fails or is empty, the run proceeds unchanged.
 *
 * M16 addition: playbook injection + auto-capture.
 *  - Planning injection: when cfg.genome?.playbookOnRun !== false and !noMemory,
 *    builds a synthesized playbook via genome/playbook.buildPlaybook (dynamic import,
 *    best-effort) and injects playbookText(...) instead of raw recall. Falls back to
 *    the existing raw-recall block on any playbook failure.
 *  - Auto-capture: after final state is persisted, calls captureFromRun (fire-and-
 *    forget) from genome/capture.ts. Disabled via opts.noCapture or
 *    cfg.genome?.autoCapture === false. Never throws, never blocks.
 *
 * M11 additions:
 *  - HARDENED ENGINE DELEGATION: buildEngineCommand + spawnEngine (engines.ts)
 *    replace the guessed ['--goal',goal] spawn. Per-engine adapters produce
 *    correct argv; phantom-exec wraps when cfg.phantom?.enabled.
 *  - STREAMING: StreamSink threaded from CLI (__sink on opts) through runGoal
 *    → runTask → agent loop. Events: task-start/model-delta/tool-call/task-done/
 *    retry/verify/log. nullSink used when absent.
 *  - RETRY: per-task withRetry (bounded, budget-aware) on tool/transient failures.
 *  - VERIFY: verifyTask after each builtin task; one retry on !ok if budget allows;
 *    else annotates result with [needs-attention].
 *
 * M15 additions:
 *  - PER-TASK ROUTING: before each task attempt, chooseRoute() selects the best
 *    LOCAL provider+model (or cloud when allowCloud + key + escalation reason).
 *    Dynamic import of router.ts — best-effort; falls back to getActiveClient when
 *    the module is absent (preserves pre-M15 behavior in the build pipeline).
 *  - AUTO-ESCALATE: on task failure or verify !ok, if allowCloud is set AND a cloud
 *    key is present, ONE escalated routed retry is attempted. Otherwise stays local
 *    and marks needs-attention. Gated exactly by chooseRoute's guardrails.
 *  - COST ATTRIBUTION: estCostUsd uses the per-task RouteDecision.provider so local
 *    tasks always cost $0 and cloud escalations are estimated correctly.
 *
 * Safety guardrails (binding):
 *  - Never writes outside ~/.ashlr/runs/ — no repos/Desktop, no git.
 *  - Budget is a HARD ceiling (aborts with partial results preserved).
 *  - Cloud endpoints require explicit allowCloud + key present (delegated to
 *    getActiveClient / chooseRoute). NO SILENT CLOUD SPEND.
 *  - Zero new runtime deps (Node builtins + @modelcontextprotocol/sdk only).
 *  - Genome recall is local-only (keyword/TF-IDF, optional local Ollama embeddings).
 *  - Engine delegation is a single bounded spawn — never recursive.
 *  - NO AUTO-DOWNLOAD: ollama pull is never called from routing or runs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import type {
  AshlrConfig,
  EngineId,
  RunTask,
  RunTaskStatus,
  RunState,
  RunOptions,
  RunStep,
  RunStreamEvent,
  RunProposalOutcome,
  ProviderClient,
  ChatMessage,
  RouteDecision,
  EscalationReason,
  RunActionCounts,
  RunBudget,
  RunUsage,
} from '../types.js';

import { getActiveClient } from './provider-client.js';
import { addUsage, newUsage, overBudget, estCostUsd } from './budget.js';
import { runTask } from './agent-loop.js';
import type { ModelStepReservation, ReserveModelStep } from './agent-loop.js';
import { withToolEnv } from '../env-bridge.js';
import { buildEngineCommand, engineInstalled, spawnEngine } from './engines.js';
import { resolveEngineSpec } from './engine-registry.js';
import { nullSink } from './streaming.js';
import type { StreamSink } from './streaming.js';
import { withRetry } from './retry.js';
import { verifyTaskStructured } from './verify.js';
import { detectVerifyCommands, runVerifyCommandAsync } from './verify-commands.js';
import { normalizeDelegationScope, summarizeDelegationScope } from './delegation-scope.js';
import { withHeal, defaultHealPolicy } from './self-heal.js';
import type { HealEvent, Sandbox } from '../types.js';
import { PLANNER_ROLE, SYNTHESIZER_ROLE } from './prompts/roles.js';
import { systemPromptFor } from './prompts/index.js';
import { resolveModelProfile, adaptivePromptsEnabled } from './model-profile.js';
// M42: executable, sandboxed engineering tool surface.
import {
  buildEngineerToolSpecs,
  buildNativeToolSpecsWithFn,
  type EngineerContext,
} from '../mcp-native-engineer.js';
import { listNativeTools } from '../mcp-native.js';
import { selectInboxStore } from '../seams/inbox.js';
import { scrubSecrets } from '../knowledge/index.js';
import { causalMetadata } from '../learning/causal.js';
import { assertSafeExecutionIdentity } from '../fleet/attempt-identity.js';
import {
  assureStableRegularFiles,
  openStableDirectoryGuard,
  readStableRegularFile,
  type StableFileReadFailureReason,
} from '../util/stable-file-read.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  addPersistenceMarker,
  bindPersistenceSnapshot,
  inheritPersistenceSnapshot,
  persistenceDigest,
  persistenceSnapshot,
  stripPersistenceMarker,
} from '../util/persistence-generation.js';
import {
  acquireCaseFoldedOwnership,
  completeCaseFoldedOwnership,
  isCaseFoldedOwnershipMetadataEntry,
  MAX_CASE_OWNERSHIP_METADATA_ENTRIES,
  type CaseOwnershipClaim,
} from '../util/case-folded-ownership.js';
import type { SandboxedEngineResult, SandboxRetentionEvidence } from './sandboxed-engine.js';
// M171: headless browser verification for web repos.
import { isWebApp, verifyInBrowser } from './browser-verify.js';
// NOTE: sandbox/worktree.js is imported DYNAMICALLY inside runGoal (matching the
// swarm runner) so its absence degrades gracefully at runtime instead of
// becoming a hard load-time dependency (H4 simulates the module being absent).

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

/** Default token budget per run. */
export const DEFAULT_MAX_TOKENS = 50_000;
/** Default step budget per run. */
export const DEFAULT_MAX_STEPS = 40;
/** Default parallel task execution limit. */
export const DEFAULT_PARALLEL = 2;
/** Directory for persisted run state. */
/** Re-resolved at call time so tests can relocate HOME (matches swarmsDir()). */
function runsDir(): string {
  return path.join(os.homedir(), '.ashlr', 'runs');
}

function stateRoot(): string {
  return path.join(os.homedir(), '.ashlr');
}
/**
 * Sentinel error attached to tasks that were force-failed by a budget abort
 * (as opposed to a genuine model failure). On --resume we reset tasks bearing
 * this exact error back to 'pending' so they re-run under the new budget.
 */
const ABORT_TASK_ERROR = 'Aborted: run budget exceeded';
const CANCELLED_TASK_ERROR = 'Task cancelled.';
const CANCELLED_MARKER = '_ashlrCancelled' as const;
const CANCELLED_MARKER_VERSION = 1 as const;

type CancellationMarker = {
  version: typeof CANCELLED_MARKER_VERSION;
  epoch: string;
  fingerprint: string;
};

type PersistedRunTask = RunTask & {
  [CANCELLED_MARKER]?: unknown;
};

type PersistedRunState = Omit<RunState, 'tasks'> & {
  tasks: PersistedRunTask[];
  [CANCELLED_MARKER]?: unknown;
};

function cancellationFingerprint(state: PersistedRunState): string {
  const canonical = JSON.stringify(state, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function cancellationMarkerMatches(
  marker: unknown,
  state: PersistedRunState,
  fingerprint: string,
): marker is CancellationMarker {
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return false;
  const candidate = marker as Record<string, unknown>;
  return (
    candidate['version'] === CANCELLED_MARKER_VERSION &&
    candidate['epoch'] === state.updatedAt &&
    candidate['fingerprint'] === fingerprint
  );
}

function rehydrateRunStateFromPersistence(state: PersistedRunState): RunState {
  const { [CANCELLED_MARKER]: runMarker, ...semanticState } = state;
  const taskRecords = state.tasks.map((task) => {
    const { [CANCELLED_MARKER]: marker, ...semanticTask } = task;
    return { marker, semanticTask };
  });
  const markerFreeState: PersistedRunState = {
    ...semanticState,
    tasks: taskRecords.map(({ semanticTask }) => semanticTask),
  };
  const fingerprint = cancellationFingerprint(markerFreeState);
  const markedCancelled =
    markerFreeState.status === 'aborted' &&
    cancellationMarkerMatches(runMarker, markerFreeState, fingerprint) &&
    (markerFreeState.terminationReason === undefined ||
      markerFreeState.terminationReason === 'cancelled');
  return {
    ...markerFreeState,
    ...(markedCancelled ? { terminationReason: 'cancelled' as const } : {}),
    tasks: taskRecords.map(({ marker, semanticTask }) => {
      const taskMarkedCancelled =
        semanticTask.status === 'failed' &&
        semanticTask.error === ABORT_TASK_ERROR &&
        cancellationMarkerMatches(marker, markerFreeState, fingerprint);
      return taskMarkedCancelled
        ? { ...semanticTask, error: CANCELLED_TASK_ERROR }
        : semanticTask;
    }),
  };
}

function reportedModelUsage(value: unknown): { tokensIn: number; tokensOut: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = (value as { usage?: { tokensIn?: unknown; tokensOut?: unknown } }).usage;
  if (
    typeof usage?.tokensIn !== 'number' ||
    !Number.isFinite(usage.tokensIn) ||
    usage.tokensIn < 0 ||
    typeof usage.tokensOut !== 'number' ||
    !Number.isFinite(usage.tokensOut) ||
    usage.tokensOut < 0
  ) {
    return undefined;
  }
  return { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
}

/**
 * Maximum characters of genome memory injected into the planning prompt.
 * Keeps the injection bounded regardless of entry size.
 */
const GENOME_INJECT_CHAR_CAP = 1500;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the runs directory exists (mkdir -p).
 * Only creates entries under ~/.ashlr/runs — never repos/Desktop.
 */
function ensureRunsDir(): void {
  const root = path.join(os.homedir(), '.ashlr');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory()) {
    throw new Error(`Refusing non-directory Ashlr state root: ${root}`);
  }
  fs.chmodSync(root, 0o700);

  const dir = runsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) {
    throw new Error(`Refusing non-directory run store: ${dir}`);
  }
  fs.chmodSync(dir, 0o700);
}

/**
 * Compute the absolute path for a run file.
 * Validates the id contains only safe characters to prevent path traversal.
 */
function runFilePath(id: string): string {
  // Only allow alphanumeric, hyphens, underscores, dots — no slashes or traversal
  if (!/^[\w.-]+$/.test(id)) {
    throw new Error(`Invalid run id: ${JSON.stringify(id)}`);
  }
  return path.join(runsDir(), `${id}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePersistedRun(raw: string, expectedId: string): RunState | null {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return null;
  const persisted = stripPersistenceMarker(parsed);
  if (
    persisted.record['id'] !== expectedId ||
    !Array.isArray(persisted.record['tasks']) ||
    !persisted.record['tasks'].every(isRecord)
  ) {
    return null;
  }
  const state = rehydrateRunStateFromPersistence(
    persisted.record as unknown as PersistedRunState,
  );
  bindPersistenceSnapshot(state, raw, persisted.revision);
  return state;
}

const DEFAULT_RUN_LIST_LIMIT = 200;
const DEFAULT_RUN_DIRECTORY_ENTRIES = 10_000;
const DEFAULT_RUN_CANDIDATES = DEFAULT_RUN_DIRECTORY_ENTRIES;
const DEFAULT_RUN_BYTES = 8 * 1024 * 1024;
const DEFAULT_RUN_FILE_BYTES = 1024 * 1024;
const MAX_PERSISTED_RUN_BYTES = 64 * 1024 * 1024;

export interface ListRunsDetailedOptions {
  limit?: number;
  maxDirectoryEntries?: number;
  maxCandidates?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}

export type RunReadStopReason =
  | StableFileReadFailureReason
  | 'directory-limit'
  | 'candidate-limit'
  | 'invalid-file';

export interface RunsReadResult {
  runs: RunState[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: RunReadStopReason[];
  entriesExamined: number;
  filesDiscovered: number;
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  unreadableFiles: number;
  oversizedFiles: number;
}

interface RunFileCandidate {
  name: string;
  mtimeMs: number;
}

function boundedRunReadOption(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function emptyRunsRead(
  sourceState: RunsReadResult['sourceState'],
  overrides: Partial<RunsReadResult> = {},
): RunsReadResult {
  return {
    runs: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    entriesExamined: 0,
    filesDiscovered: 0,
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
    oversizedFiles: 0,
    ...overrides,
  };
}

function pushRunStopReason(reasons: RunReadStopReason[], reason: RunReadStopReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function runFreshness(run: RunState): number {
  const updated = Date.parse(run.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(run.createdAt);
  return Number.isFinite(created) ? created : Number.NEGATIVE_INFINITY;
}

function sortRunsNewestFirst(left: RunState, right: RunState): number {
  const freshness = runFreshness(right) - runFreshness(left);
  return freshness !== 0 ? freshness : left.id.localeCompare(right.id);
}

function recordRunReadFailure(result: RunsReadResult, reason: StableFileReadFailureReason): void {
  pushRunStopReason(result.stopReasons, reason);
  if (reason === 'per-file-byte-limit') result.oversizedFiles += 1;
  else if (reason !== 'byte-limit') result.unreadableFiles += 1;
  result.sourceState = 'degraded';
  result.complete = false;
}

/**
 * Load a persisted RunState by id. Returns null if absent, unreadable, or invalid JSON.
 */
export function loadRun(id: string): RunState | null {
  try {
    const file = runFilePath(id);
    const loaded = readStableRegularFile(file, {
      anchorPath: stateRoot(),
      maxFileBytes: MAX_PERSISTED_RUN_BYTES,
      remainingBytes: MAX_PERSISTED_RUN_BYTES,
    });
    return loaded.ok ? parsePersistedRun(loaded.text, id) : null;
  } catch {
    return null;
  }
}

/**
 * List recent persisted runs through bounded, descriptor-bound reads.
 */
export function listRunsDetailed(options: ListRunsDetailedOptions = {}): RunsReadResult {
  try {
    const limit = boundedRunReadOption(options.limit, DEFAULT_RUN_LIST_LIMIT);
    const maxDirectoryEntries = boundedRunReadOption(
      options.maxDirectoryEntries,
      DEFAULT_RUN_DIRECTORY_ENTRIES,
    );
    const maxCandidates = boundedRunReadOption(options.maxCandidates, DEFAULT_RUN_CANDIDATES);
    const maxBytes = boundedRunReadOption(options.maxBytes, DEFAULT_RUN_BYTES);
    const maxFileBytes = boundedRunReadOption(options.maxFileBytes, DEFAULT_RUN_FILE_BYTES);
    const dir = runsDir();
    const directoryGuard = openStableDirectoryGuard(dir, { anchorPath: stateRoot() });
    if (!directoryGuard.ok) {
      return directoryGuard.reason === 'missing'
        ? emptyRunsRead('missing')
        : emptyRunsRead('degraded', {
            sourcePresent: true,
            complete: false,
            stopReasons: [directoryGuard.reason],
            unreadableFiles: 1,
          });
    }

    const result = emptyRunsRead('healthy', { sourcePresent: true });
    const candidates: RunFileCandidate[] = [];
    let ownershipMetadataEntries = 0;
    let handle: fs.Dir | undefined;
    try {
      handle = fs.opendirSync(dir);
      while (true) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (isCaseFoldedOwnershipMetadataEntry(entry.name)) {
          ownershipMetadataEntries += 1;
          if (ownershipMetadataEntries > MAX_CASE_OWNERSHIP_METADATA_ENTRIES) {
            result.complete = false;
            result.sourceState = 'degraded';
            pushRunStopReason(result.stopReasons, 'directory-limit');
            break;
          }
          continue;
        }
        if (result.entriesExamined >= maxDirectoryEntries) {
          result.complete = false;
          result.sourceState = 'degraded';
          pushRunStopReason(result.stopReasons, 'directory-limit');
          break;
        }
        result.entriesExamined += 1;
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const expectedId = entry.name.slice(0, -'.json'.length);
        if (!/^[\w.-]+$/.test(expectedId)) {
          result.invalidFiles += 1;
          result.sourceState = 'degraded';
          pushRunStopReason(result.stopReasons, 'invalid-file');
          continue;
        }
        try {
          const metadata = fs.lstatSync(path.join(dir, entry.name));
          if (!metadata.isFile()) continue;
          candidates.push({ name: entry.name, mtimeMs: metadata.mtimeMs });
        } catch {
          result.unreadableFiles += 1;
          result.complete = false;
          result.sourceState = 'degraded';
          pushRunStopReason(result.stopReasons, 'io-error');
        }
      }
    } catch {
      result.sourceState = 'degraded';
      result.complete = false;
      result.unreadableFiles += 1;
      pushRunStopReason(result.stopReasons, 'io-error');
    } finally {
      try { handle?.closeSync(); } catch { /* best-effort bounded enumeration */ }
    }

    const directoryFailure = directoryGuard.finish();
    if (directoryFailure !== null) {
      return emptyRunsRead('degraded', {
        sourcePresent: true,
        complete: false,
        stopReasons: [directoryFailure],
        entriesExamined: result.entriesExamined,
        filesDiscovered: candidates.length,
        unreadableFiles: result.unreadableFiles + 1,
      });
    }

    candidates.sort((left, right) =>
      right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name),
    );
    result.filesDiscovered = candidates.length;
    const selected = candidates.slice(0, maxCandidates);
    if (selected.length < candidates.length) {
      result.complete = false;
      result.sourceState = 'degraded';
      pushRunStopReason(result.stopReasons, 'candidate-limit');
    }

    let byteLimitReached = false;
    for (let batchStart = 0; batchStart < selected.length; batchStart += 512) {
      const batch = selected.slice(batchStart, batchStart + 512);
      const batchAssurance = assureStableRegularFiles(
        batch.map((candidate) => path.join(dir, candidate.name)),
        stateRoot(),
      );
      if (!batchAssurance.ok) {
        return emptyRunsRead('degraded', {
          sourcePresent: true,
          complete: false,
          stopReasons: [batchAssurance.reason],
          entriesExamined: result.entriesExamined,
          filesDiscovered: result.filesDiscovered,
          unreadableFiles: batch.length,
        });
      }

      for (const candidate of batch) {
        const remainingBytes = maxBytes - result.bytesRead;
        if (remainingBytes <= 0) {
          result.complete = false;
          result.sourceState = 'degraded';
          pushRunStopReason(result.stopReasons, 'byte-limit');
          byteLimitReached = true;
          break;
        }
        result.filesRead += 1;
        const expectedId = candidate.name.slice(0, -'.json'.length);
        const loaded = readStableRegularFile(path.join(dir, candidate.name), {
          anchorPath: stateRoot(),
          maxFileBytes,
          remainingBytes,
          batchAssurance: batchAssurance.token,
        });
        if (!loaded.ok) {
          recordRunReadFailure(result, loaded.reason);
          if (loaded.reason === 'byte-limit') {
            byteLimitReached = true;
            break;
          }
          continue;
        }
        result.bytesRead += loaded.bytesRead;
        try {
          const state = parsePersistedRun(loaded.text, expectedId);
          if (state) result.runs.push(state);
          else {
            result.invalidFiles += 1;
            result.sourceState = 'degraded';
            pushRunStopReason(result.stopReasons, 'invalid-file');
          }
        } catch {
          result.invalidFiles += 1;
          result.sourceState = 'degraded';
          pushRunStopReason(result.stopReasons, 'invalid-file');
        }
      }
      if (byteLimitReached) break;
    }

    result.runs.sort(sortRunsNewestFirst);
    result.runs = result.runs.slice(0, limit);
    return result;
  } catch {
    return emptyRunsRead('degraded', {
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  }
}

/** Compatibility wrapper around the bounded detailed reader. */
export function listRuns(options: ListRunsDetailedOptions = {}): RunState[] {
  return listRunsDetailed(options).runs;
}

function runDurationMs(state: RunState): number | undefined {
  const summarized = state.runEventSummary?.durationMs;
  if (typeof summarized === 'number' && Number.isFinite(summarized) && summarized >= 0) {
    return summarized;
  }
  const start = Date.parse(state.createdAt);
  const end = Date.parse(state.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

const RUN_PROPOSAL_OUTCOME_KINDS = new Set<string>([
  'filed',
  'empty-diff',
  'trivial-proposal',
  'completeness-gate',
  'partial-completeness-gate',
  'engine-failed-no-diff',
  'api-model-task-failed',
  'sandbox-unavailable',
  'engine-command-missing',
  'engine-unsupported',
  'kill-switch',
  'proposal-disabled',
  'proposal-capture-error',
]);

function nonNegativeCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function runCausalTimestamp(state: RunState): string | undefined {
  for (const candidate of [state.updatedAt, state.createdAt]) {
    if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) return candidate;
  }
  return undefined;
}

function runOutcomeLabel(state: RunState): string {
  const kind = state.proposalOutcome?.kind;
  if (kind === 'filed') return state.proposalOutcome?.isPartial === true ? 'gate-blocked' : 'proposal-created';
  return kind && RUN_PROPOSAL_OUTCOME_KINDS.has(kind) ? kind : state.status;
}

function runMetadataSummary(state: RunState): NonNullable<RunState['runEventSummary']> {
  const proposalOutcome = state.proposalOutcome;
  const insertions = nonNegativeCount(proposalOutcome?.insertions);
  const deletions = nonNegativeCount(proposalOutcome?.deletions);
  const files = nonNegativeCount(proposalOutcome?.files);
  const diffLines =
    insertions !== undefined || deletions !== undefined
      ? (insertions ?? 0) + (deletions ?? 0)
      : state.runEventSummary?.diffLines;
  const durationMs = runDurationMs(state);
  const actionCounts = state.runEventSummary?.actionCounts
    ? ({
        ...state.runEventSummary.actionCounts,
        ...(files !== undefined ? { diffFiles: files } : {}),
        ...(diffLines !== undefined ? { diffLines } : {}),
        ...(proposalOutcome
          ? {
              proposalCreated: proposalOutcome.kind === 'filed' && proposalOutcome.isPartial !== true ? 1 : 0,
              proposalBlocked: proposalOutcome.isPartial === true || (proposalOutcome.kind !== 'filed' && proposalOutcome.kind !== 'proposal-disabled') ? 1 : 0,
              proposalDisabled: proposalOutcome.kind === 'proposal-disabled' ? 1 : 0,
            }
          : {}),
      } satisfies RunActionCounts)
    : undefined;
  return {
    ...(state.runEventSummary ?? {}),
    runId: state.id,
    status: state.status,
    outcome: runOutcomeLabel(state),
    ...(proposalOutcome ? { proposalCreated: proposalOutcome.kind === 'filed' && proposalOutcome.isPartial !== true } : {}),
    ...(proposalOutcome?.proposalId ? { proposalId: proposalOutcome.proposalId } : {}),
    ...(files !== undefined ? { diffFiles: files } : {}),
    ...(diffLines !== undefined ? { diffLines } : {}),
    tokensIn: state.usage.tokensIn,
    tokensOut: state.usage.tokensOut,
    costUsd: state.usage.estCostUsd,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(actionCounts ? { actionCounts } : {}),
  };
}

function runRouteSnapshot(state: RunState): NonNullable<RunState['routeSnapshot']> | undefined {
  if (state.routeSnapshot) return state.routeSnapshot;
  if (!state.engine && !state.engineModel && !state.engineTier && !state.provider) return undefined;
  return {
    backend: state.engine || state.provider || null,
    tier: state.engineTier ?? null,
    model: state.engineModel ?? null,
    assignedBy: 'run-orchestrator',
    reason: 'run persistence metadata',
  };
}

function runLabelBasis(state: RunState): NonNullable<RunState['labelBasis']> {
  return state.proposalOutcome ? 'dispatch-outcome' : 'unknown';
}

function normalizeRunStateForPersistence(state: RunState): RunState {
  const meta = causalMetadata({
    trajectoryId: state.trajectoryId,
    runId: state.id,
    routeSnapshot: runRouteSnapshot(state),
    runEventSummary: runMetadataSummary(state),
    evidenceOutcome: state.evidenceOutcome,
    learningSource: state.learningSource ?? 'run-ledger',
    labelBasis: state.labelBasis ?? runLabelBasis(state),
    routerPolicyVersion: state.routerPolicyVersion,
    learningEpoch: state.learningEpoch,
    ts: runCausalTimestamp(state),
  });
  return {
    ...state,
    ...meta,
  };
}

function downgradeRunStateForPersistence(state: RunState): PersistedRunState {
  const { [CANCELLED_MARKER]: _runMarker, ...semanticState } = state as PersistedRunState;
  const cancelledTaskIndexes = new Set<number>();
  const persisted: PersistedRunState = {
    ...semanticState,
    tasks: state.tasks.map((task, index) => {
      const { [CANCELLED_MARKER]: _taskMarker, ...semanticTask } = task as PersistedRunTask;
      if (task.status === 'failed' && task.error === CANCELLED_TASK_ERROR) {
        cancelledTaskIndexes.add(index);
        return {
          ...semanticTask,
          error: ABORT_TASK_ERROR,
        };
      }
      return semanticTask;
    }),
  };

  if (state.status === 'aborted' && state.terminationReason === 'cancelled') {
    delete persisted.terminationReason;
  } else {
    if (persisted.terminationReason === 'cancelled') delete persisted.terminationReason;
  }

  const marker: CancellationMarker = {
    version: CANCELLED_MARKER_VERSION,
    epoch: persisted.updatedAt,
    fingerprint: cancellationFingerprint(persisted),
  };
  for (const index of cancelledTaskIndexes) {
    persisted.tasks[index]![CANCELLED_MARKER] = marker;
  }
  if (state.status === 'aborted' && state.terminationReason === 'cancelled') {
    persisted[CANCELLED_MARKER] = marker;
  }
  return persisted;
}

function actionCountsForProposalCapture(state: RunState): RunActionCounts | undefined {
  const counts = state.runEventSummary?.actionCounts;
  return counts ? { ...counts } : undefined;
}

type RunStateWithSandboxRetention = RunState & {
  sandboxRetention?: SandboxRetentionEvidence;
};

function sandboxRetentionFrom(
  result: Pick<SandboxedEngineResult, 'state' | 'sandboxRetention'> | null | undefined,
): SandboxRetentionEvidence | undefined {
  return result?.sandboxRetention ?? (result?.state as RunStateWithSandboxRetention | undefined)?.sandboxRetention;
}

function withSandboxRetention(
  state: RunState,
  evidence: SandboxRetentionEvidence | undefined,
): RunState {
  return evidence ? ({ ...state, sandboxRetention: evidence } as RunState) : state;
}

function hasAuthoritativeErrorExit(state: RunState): boolean {
  return state.status === 'failed' && state.terminationReason === 'error-exit';
}

function withCapturedProposalMetadata(producerState: RunState, capturedState: RunState): RunState {
  const captureAborted = capturedState.status === 'aborted' && !hasAuthoritativeErrorExit(producerState);
  const merged = {
    ...producerState,
    ...(captureAborted
      ? {
          status: capturedState.status,
          result: capturedState.result,
          updatedAt: capturedState.updatedAt,
          terminationReason: capturedState.terminationReason,
        }
      : {}),
    ...(capturedState.proposalOutcome ? { proposalOutcome: capturedState.proposalOutcome } : {}),
    ...(capturedState.runEventSummary
      ? {
          runEventSummary: {
            ...capturedState.runEventSummary,
            ...(captureAborted ? { status: 'aborted' as const } : {}),
          },
        }
      : {}),
    ...(capturedState.trajectoryId ? { trajectoryId: capturedState.trajectoryId } : {}),
    ...(capturedState.routeSnapshot ? { routeSnapshot: capturedState.routeSnapshot } : {}),
    ...(capturedState.evidenceOutcome ? { evidenceOutcome: capturedState.evidenceOutcome } : {}),
    ...(capturedState.learningSource ? { learningSource: capturedState.learningSource } : {}),
    ...(capturedState.labelBasis ? { labelBasis: capturedState.labelBasis } : {}),
    ...(capturedState.routerPolicyVersion ? { routerPolicyVersion: capturedState.routerPolicyVersion } : {}),
    ...(capturedState.learningEpoch ? { learningEpoch: capturedState.learningEpoch } : {}),
  };
  return withSandboxRetention(
    merged,
    (producerState as RunStateWithSandboxRetention).sandboxRetention ??
      (capturedState as RunStateWithSandboxRetention).sandboxRetention,
  );
}

function failedCaptureOutcome(
  producerState: RunState,
  capturedOutcome: RunProposalOutcome | undefined,
  kind: 'engine-failed-no-diff' | 'api-model-task-failed',
): RunProposalOutcome | undefined {
  if (capturedOutcome?.kind !== 'empty-diff') return capturedOutcome;
  if (producerState.proposalOutcome?.kind === kind) return producerState.proposalOutcome;
  return {
    ...capturedOutcome,
    kind,
    reason: kind === 'api-model-task-failed'
      ? 'api-model producer failed without a material diff'
      : `engine "${producerState.engine}" failed without a material diff`,
  };
}

function runStateHasKnownEmptyDiff(state: RunState): boolean {
  const summary = state.runEventSummary;
  const counts = summary?.actionCounts;
  const observed = [
    summary?.diffFiles,
    summary?.diffLines,
    counts?.diffFiles,
    counts?.diffLines,
    state.proposalOutcome?.files,
    state.proposalOutcome?.insertions,
    state.proposalOutcome?.deletions,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (observed.length === 0) return state.proposalOutcome?.kind === 'empty-diff';
  return observed.every((value) => value <= 0);
}

function requiredDiffRetryGoal(goal: string, attempt: number, maxAttempts: number): string {
  return (
    `${goal}\n\n[TITRR required-diff retry ${attempt}/${maxAttempts - 1}]\n` +
    'The prior attempt completed without changing any files. Re-inspect the relevant repository code with the available tools. ' +
    'If the task remains actionable, use an edit tool and make the smallest complete change that satisfies it. ' +
    'If inspection proves the task is already satisfied or not safely actionable, do not make a cosmetic edit; report that evidence concisely.'
  );
}

function resolveTitrrBudget(budget: Partial<RunBudget> | undefined, allowCloud: boolean | undefined): RunBudget {
  return {
    maxTokens: budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSteps: budget?.maxSteps ?? DEFAULT_MAX_STEPS,
    allowCloud: allowCloud ?? budget?.allowCloud ?? false,
  };
}

function remainingTitrrBudget(budget: RunBudget, usage: RunUsage): RunBudget {
  return {
    maxTokens: Math.max(1, budget.maxTokens - usage.tokensIn - usage.tokensOut),
    maxSteps: Math.max(1, budget.maxSteps - usage.steps),
    allowCloud: budget.allowCloud,
  };
}

function accountedTitrrAttemptUsage(usage: RunUsage): RunUsage {
  return usage.steps > 0 ? usage : { ...usage, steps: 1 };
}

const TITRR_CUMULATIVE_ACTION_KEYS = [
  'sandboxCreated',
  'spawnAttempts',
  'transientRetries',
  'proposalCaptureAttempts',
  'completenessGateRuns',
  'verifyRepairAttempts',
  'modelSteps',
  'toolSteps',
  'totalSteps',
  'proposalDisabled',
] as const satisfies readonly (keyof RunActionCounts)[];

function addTitrrActionCounts(total: RunActionCounts, attempt: RunActionCounts | undefined): RunActionCounts {
  const next = { ...total };
  for (const key of TITRR_CUMULATIVE_ACTION_KEYS) {
    const value = attempt?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      next[key] = value > 0
        ? Math.min(Number.MAX_SAFE_INTEGER, (next[key] ?? 0) + Math.trunc(value))
        : (next[key] ?? 0);
    }
  }
  for (const key of ['diffFiles', 'diffLines', 'proposalCreated', 'proposalBlocked'] as const) {
    const value = attempt?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) next[key] = Math.trunc(value);
  }
  return next;
}

function withCumulativeUsage(
  state: RunState,
  usage: RunUsage,
  budget: RunBudget,
  actionCounts: RunActionCounts,
  durationMs: number,
): RunState {
  return {
    ...state,
    budget,
    usage,
    runEventSummary: {
      ...(state.runEventSummary ?? {}),
      runId: state.id,
      status: state.status,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costUsd: usage.estCostUsd,
      durationMs,
      actionCounts,
    },
  };
}

function asCancelledRunState(state: RunState, result = 'Run cancelled.'): RunState {
  if (hasAuthoritativeErrorExit(state)) return state;
  return {
    ...state,
    status: 'aborted',
    result,
    terminationReason: 'cancelled',
    updatedAt: new Date().toISOString(),
    ...(state.runEventSummary
      ? { runEventSummary: { ...state.runEventSummary, status: 'aborted' } }
      : {}),
  };
}

function newCancelledRunState(
  goal: string,
  opts: RunOptions,
  engine = opts.engine ?? 'builtin',
  provider = 'none',
): RunState {
  const now = new Date().toISOString();
  return {
    id: opts.runId ?? generateRunId(),
    goal,
    engine,
    provider,
    createdAt: now,
    updatedAt: now,
    budget: {
      maxTokens: opts.budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
      maxSteps: opts.budget?.maxSteps ?? DEFAULT_MAX_STEPS,
      allowCloud: opts.allowCloud ?? false,
    },
    usage: newUsage(),
    tasks: [],
    steps: [],
    status: 'aborted',
    result: 'Run cancelled before execution.',
    terminationReason: 'cancelled',
  };
}

/**
 * Atomically persist a RunState to ~/.ashlr/runs/<id>.json (write-then-rename).
 * Existing records require generation authority from the exact loaded object.
 * ONLY writes under runsDir() — never touches repos or Desktop.
 */
export function saveRun(s: RunState): void {
  const normalized = normalizeRunStateForPersistence(s);
  const semantic = downgradeRunStateForPersistence(normalized);
  const semanticPayload = JSON.stringify(semantic, null, 2);
  if (Buffer.byteLength(semanticPayload, 'utf8') > MAX_PERSISTED_RUN_BYTES) {
    throw new Error(`Refusing run record larger than ${MAX_PERSISTED_RUN_BYTES} bytes`);
  }
  ensureRunsDir();
  const dest = runFilePath(s.id);
  const foldedId = createHash('sha256').update(s.id.toLowerCase()).digest('hex');
  const lock = acquireLocalStoreLock(path.join(runsDir(), `.write-lock-${foldedId}`));
  if (!lock) throw new Error(`Run persistence lock unavailable for ${s.id}`);
  const legacyTmp = `${dest}.tmp`;
  let tmp: string | undefined;
  let ownershipClaim: CaseOwnershipClaim | null = null;
  try {
    ownershipClaim = acquireCaseFoldedOwnership({
      anchorPath: stateRoot(),
      storeDir: runsDir(),
      recordFile: dest,
      id: s.id,
      label: 'Run',
    });
    try {
      if (fs.lstatSync(legacyTmp).isDirectory()) {
        throw new Error(`Refusing to save run with invalid legacy temporary path: ${legacyTmp}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    let currentRaw: string | null = null;
    try {
      fs.lstatSync(dest);
      const loaded = readStableRegularFile(dest, {
        anchorPath: stateRoot(),
        maxFileBytes: MAX_PERSISTED_RUN_BYTES,
        remainingBytes: MAX_PERSISTED_RUN_BYTES,
      });
      if (!loaded.ok) throw new Error(`Run persistence source is unsafe: ${loaded.reason}`);
      currentRaw = loaded.text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const expected = persistenceSnapshot(s);
    if (
      (currentRaw === null && expected !== undefined) ||
      (currentRaw !== null && (expected === undefined || persistenceDigest(currentRaw) !== expected.digest))
    ) {
      throw new Error(`Stale run persistence generation for ${s.id}`);
    }

    let currentRevision = 0;
    if (currentRaw !== null) {
      const parsed: unknown = JSON.parse(currentRaw);
      if (!isRecord(parsed)) throw new Error(`Invalid current run persistence record for ${s.id}`);
      currentRevision = stripPersistenceMarker(parsed).revision;
    }
    const revision = currentRevision + 1;
    const payload = JSON.stringify(addPersistenceMarker(
      semantic as unknown as Record<string, unknown>,
      revision,
    ), null, 2);
    if (Buffer.byteLength(payload, 'utf8') > MAX_PERSISTED_RUN_BYTES) {
      throw new Error(`Refusing run record larger than ${MAX_PERSISTED_RUN_BYTES} bytes`);
    }
    tmp = path.join(
      path.dirname(dest),
      `.${path.basename(dest)}.${process.pid}.${randomUUID()}.tmp`,
    );
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, dest);
    tmp = undefined;
    completeCaseFoldedOwnership(ownershipClaim);
    ownershipClaim = null;
    Object.assign(s, normalized);
    bindPersistenceSnapshot(s, payload, revision);
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best-effort cleanup after a failed write or rename.
      }
    }
    releaseLocalStoreLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Run id generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique run id from the wall clock (format: run-<timestamp>-<random>).
 * Callers may inject an id for test determinism.
 */
function generateRunId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  return `run-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// M7: Genome recall injection (best-effort, local-only)
// ---------------------------------------------------------------------------

/**
 * Attempt to recall relevant genome entries for the goal and format them as a
 * bounded context block suitable for prepending to a planning system prompt.
 *
 * Rules:
 *  - Dynamic import of ../genome/recall.js — if the module does not exist yet
 *    (other M7 agents have not shipped it), returns '' gracefully.
 *  - Total injected text is capped at GENOME_INJECT_CHAR_CAP characters.
 *  - Never throws — any error returns '' so the run proceeds unchanged.
 *  - Local-only: embeddings via local Ollama only, never cloud.
 */
async function buildMemoryBlock(goal: string, cfg: AshlrConfig): Promise<string> {
  try {
    // Dynamic import: tolerates the module being absent (pre-M7 build).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recallMod = await import('../genome/recall.js') as any;

    if (typeof recallMod.recall !== 'function') return '';

    const limit = cfg.genome?.maxRecall ?? 3;
    const hits: Array<{
      entry: { title: string; text: string; project: string | null };
      score: number;
    }> = await recallMod.recall(goal, cfg, { limit });

    if (!Array.isArray(hits) || hits.length === 0) return '';

    const lines: string[] = ['Relevant project memory:'];
    let charCount = lines[0]!.length + 1;

    for (const hit of hits) {
      if (!hit?.entry) continue;
      const project = hit.entry.project ? ` [${hit.entry.project}]` : '';
      const header = `- ${hit.entry.title ?? 'note'}${project}:`;
      const body = String(hit.entry.text ?? '').replace(/\s+/g, ' ').trim();
      const fragment = `${header} ${body}`;

      // Stop if adding this entry would exceed the character cap
      if (charCount + fragment.length + 1 > GENOME_INJECT_CHAR_CAP) {
        // Attempt a truncated version (at least 20 chars of body are worth showing)
        const remaining = GENOME_INJECT_CHAR_CAP - charCount - header.length - 4;
        if (remaining > 20) {
          lines.push(`${header} ${body.slice(0, remaining)}…`);
        }
        break;
      }

      lines.push(fragment);
      charCount += fragment.length + 1;
    }

    // Only return the block if we actually added at least one entry beyond header
    if (lines.length <= 1) return '';

    return lines.join('\n');
  } catch {
    // Module absent, recall failed, or any other error — proceed without memory
    return '';
  }
}

// ---------------------------------------------------------------------------
// M15: Per-task router (dynamic import, best-effort)
// ---------------------------------------------------------------------------

/**
 * Router module type — matches the contract in core/run/router.ts.
 * Typed narrowly so we only depend on what we call here.
 */
interface RouterModule {
  chooseRoute(
    taskGoal: string,
    cfg: AshlrConfig,
    opts: { allowCloud: boolean; attempt: number; lastReason: EscalationReason },
  ): Promise<RouteDecision>;
  cloudKeyAvailable(provider: string): boolean;
}

/** Cached router module reference (loaded once, null when unavailable). */
let _routerMod: RouterModule | null | undefined = undefined; // undefined = not yet tried

/**
 * Load the router module (core/run/router.ts) exactly once, best-effort.
 * Returns null when the module is not yet present in the build (pre-M15).
 * Never throws.
 */
async function loadRouter(): Promise<RouterModule | null> {
  if (_routerMod !== undefined) return _routerMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('./router.js') as any;
    if (typeof mod.chooseRoute === 'function' && typeof mod.cloudKeyAvailable === 'function') {
      _routerMod = mod as RouterModule;
    } else {
      _routerMod = null;
    }
  } catch {
    // Module not present or failed to load — fall back to getActiveClient.
    _routerMod = null;
  }
  return _routerMod;
}

/**
 * Build a ProviderClient for a given RouteDecision.
 *
 * Provider-aware (M15): the routed provider+model are passed EXPLICITLY into
 * getActiveClient (no process.env mutation), so a cloud RouteDecision actually
 * targets the routed cloud provider instead of silently re-running on the local
 * active provider. This also removes the global ASHLR_MODEL env race that would
 * misroute concurrent tasks resolving to different per-task models.
 *
 * For local routes (tier='local'): getActiveClient(provider, model, allowCloud=false).
 * For cloud routes (tier='cloud'): getActiveClient(provider, model, allowCloud=true) —
 *   which enforces the key check and (until cloud completions are implemented)
 *   throws; on ANY failure we fall back to the default local client.
 *
 * Never throws — on failure, falls back to the default client. The CALLER must
 * attribute cost using the returned client's `.id` (not the decision's intended
 * provider), because a cloud decision that fails to build falls back to local
 * and must be charged at $0, not at cloud rates.
 */
async function buildRoutedClient(
  decision: RouteDecision,
  cfg: AshlrConfig,
  allowCloud: boolean,
): Promise<ProviderClient> {
  const routedModel =
    decision.model && decision.model !== 'default' ? decision.model : undefined;
  try {
    const cloudOk = decision.tier === 'cloud' && allowCloud;
    return await getActiveClient(cfg, {
      allowCloud: cloudOk,
      provider: decision.provider,
      model: routedModel,
    });
  } catch {
    // Route failed (e.g. provider down, cloud key missing, cloud completions
    // not implemented) — fall back to the default local-first client. The
    // returned client's .id reflects the LOCAL provider, so the caller charges
    // local rates ($0) for this attempt rather than the unbuilt cloud provider.
    return await getActiveClient(cfg, { allowCloud, model: routedModel });
  }
}

/**
 * Choose a route for a task attempt and build the appropriate ProviderClient.
 *
 * On success: returns {client, decision}.
 * On any error (router absent, provider down): falls back to the run-level
 * client and returns a synthetic local RouteDecision with reason 'fallback'.
 *
 * GUARDRAIL: cloud routes only when allowCloud && lastReason !== 'none' && key present.
 * This is enforced by chooseRoute itself; we never bypass it.
 */
async function routeTask(
  taskGoal: string,
  cfg: AshlrConfig,
  opts: { allowCloud: boolean; attempt: number; lastReason: EscalationReason },
  fallbackClient: ProviderClient,
): Promise<{ client: ProviderClient; decision: RouteDecision }> {
  const router = await loadRouter();

  if (!router) {
    // Pre-M15 build or router unavailable — use the run-level client as-is.
    return {
      client: fallbackClient,
      decision: {
        provider: fallbackClient.id,
        model: process.env['ASHLR_MODEL'] ?? 'default',
        tier: 'local',
        reason: 'router unavailable — local-first fallback',
      },
    };
  }

  try {
    const decision = await router.chooseRoute(taskGoal, cfg, opts);
    const client = await buildRoutedClient(decision, cfg, opts.allowCloud);
    return { client, decision };
  } catch {
    // chooseRoute or buildRoutedClient failed — use fallback client.
    return {
      client: fallbackClient,
      decision: {
        provider: fallbackClient.id,
        model: process.env['ASHLR_MODEL'] ?? 'default',
        tier: 'local',
        reason: 'route error — local-first fallback',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Prompt template for decomposing a goal into a task DAG.
 * M41: single-sourced from prompts/roles.PLANNER_ROLE (verbatim) so the legacy
 * (flag-off) and adaptive (flag-on) paths share identical planner text.
 */
const PLANNING_SYSTEM = PLANNER_ROLE;

/**
 * Parse a RunTask[] from model output, tolerating prose wrapped around JSON.
 * Returns null if no valid JSON array of tasks is found.
 *
 * Tolerances added for local-model output (M76):
 *   1. Strip markdown code fences (```json…``` / ```…```) before extracting.
 *   2. Strip trailing commas before `]` / `}` so JSON.parse doesn't choke.
 *   3. Accept alternate field names per task object:
 *        id   ← id | name | step | key  (else synthesise t1, t2, …)
 *        goal ← goal | task | description | title | summary | text
 *        deps ← deps | dependsOn | dependencies
 *   4. Numbered/bulleted-list fallback when no JSON array is found:
 *        lines matching /^\s*(\d+\.|[-*])\s+\S/ → tasks with synthesised ids.
 */
export function parseTaskList(text: string): RunTask[] | null {
  // ── 1. Strip markdown code fences ────────────────────────────────────────
  // Remove ```json ... ``` or ``` ... ``` wrappers, then trim surrounding prose.
  const stripped = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  // ── 2. Extract JSON array (greedy first match) ────────────────────────────
  const match = stripped.match(/\[[\s\S]*\]/);

  if (match) {
    // Strip trailing commas before ] or } (common local-model mistake)
    const cleaned = match[0].replace(/,\s*([}\]])/g, '$1');

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // fall through to list fallback below
      parsed = null;
    }

    if (Array.isArray(parsed) && parsed.length > 0) {
      const result = _buildTasksFromArray(parsed);
      if (result) return result;
    }
  }

  // ── 4. Numbered / bulleted list fallback ──────────────────────────────────
  // Accept lines like:  "1. Do the thing"  /  "- Do the thing"  /  "* Do the thing"
  const listLines = stripped
    .split('\n')
    .map((l) => l.match(/^\s*(?:\d+\.|[-*])\s+(.+)/))
    .filter((m): m is RegExpMatchArray => m !== null && (m[1]?.trim().length ?? 0) > 3)
    .map((m) => m[1]!.trim());

  if (listLines.length >= 1) {
    const tasks: RunTask[] = listLines.map((goal, i) => ({
      id: `t${i + 1}`,
      goal,
      deps: [],
      status: 'pending' as RunTaskStatus,
    }));
    return tasks;
  }

  return null;
}

/**
 * Build RunTask[] from a parsed JSON array, accepting alternate field names.
 * Returns null if the array is structurally invalid (bad fields, dup ids, cycles).
 */
function _buildTasksFromArray(parsed: unknown[]): RunTask[] | null {
  const tasks: RunTask[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== 'object' || item === null) return null;
    const obj = item as Record<string, unknown>;

    // ── 3a. id: id | name | step | key → else synthesise ─────────────────
    const rawId =
      obj['id'] ?? obj['name'] ?? obj['step'] ?? obj['key'];
    const id =
      typeof rawId === 'string' && rawId.trim().length > 0
        ? rawId.trim()
        : `t${i + 1}`;

    // ── 3b. goal: goal | task | description | title | summary | text ──────
    const rawGoal =
      obj['goal'] ?? obj['task'] ?? obj['description'] ??
      obj['title'] ?? obj['summary'] ?? obj['text'];
    const goal =
      typeof rawGoal === 'string' ? rawGoal.trim() : null;

    if (!goal) return null;
    if (seenIds.has(id)) return null; // duplicate id
    seenIds.add(id);

    // ── 3c. deps: deps | dependsOn | dependencies ─────────────────────────
    const rawDeps =
      Array.isArray(obj['deps'])          ? obj['deps'] :
      Array.isArray(obj['dependsOn'])     ? obj['dependsOn'] :
      Array.isArray(obj['dependencies'])  ? obj['dependencies'] :
      [];
    const deps = rawDeps.filter((d): d is string => typeof d === 'string');

    tasks.push({
      id,
      goal,
      deps,
      status: 'pending' as RunTaskStatus,
    });
  }

  // Validate deps reference only known ids
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!taskIds.has(dep)) return null; // unknown dep
      if (dep === task.id) return null;   // self-dep
    }
  }

  // Reject multi-node cycles
  if (hasCycle(tasks)) return null;

  return tasks.length > 0 ? tasks : null;
}

/**
 * DFS-based cycle detection over the task DAG (deps are edges dep -> task).
 * Returns true if any cycle exists.
 */
function hasCycle(tasks: RunTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const VISITING = 1;
  const DONE = 2;
  const mark = new Map<string, number>();

  const visit = (id: string): boolean => {
    const cur = mark.get(id);
    if (cur === VISITING) return true; // back-edge -> cycle
    if (cur === DONE) return false;
    mark.set(id, VISITING);
    const task = byId.get(id);
    if (task) {
      for (const dep of task.deps) {
        if (byId.has(dep) && visit(dep)) return true;
      }
    }
    mark.set(id, DONE);
    return false;
  };

  for (const t of tasks) {
    if (visit(t.id)) return true;
  }
  return false;
}

/**
 * Planning call: ask the model to decompose `goal` into a RunTask[] DAG.
 * Falls back to a single task whose goal is the original goal on parse failure.
 *
 * @param memoryContext Optional genome memory block to prepend to the system prompt.
 *   When non-empty, injects "Relevant project memory:" context so the planner
 *   benefits from cross-project knowledge. Kept bounded upstream (GENOME_INJECT_CHAR_CAP).
 */
export async function planGoal(
  goal: string,
  client: ProviderClient,
  onUsage?: (usage: { tokensIn: number; tokensOut: number }) => void,
  memoryContext?: string,
  adaptive?: boolean,
  signal?: AbortSignal,
): Promise<RunTask[]> {
  // M41: adaptive path budgets the memory block via the prompt suite; the legacy
  // path keeps the original prepend behavior byte-for-byte.
  const systemContent = adaptive
    ? systemPromptFor({
        role: 'planner',
        useTools: false,
        profile: resolveModelProfile(client.model),
        memory: memoryContext,
      })
    : memoryContext && memoryContext.length > 0
      ? `${memoryContext}\n\n${PLANNING_SYSTEM}`
      : PLANNING_SYSTEM;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: goal },
  ];

  let result: import('../types.js').ChatResult;
  try {
    result = await client.chat(messages, undefined, signal);
  } catch (err) {
    const reportedUsage = reportedModelUsage(err);
    if (reportedUsage && onUsage) onUsage(reportedUsage);
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ashlr run] planning call failed: ${msg} — using single-task fallback\n`);
    return [{ id: 't1', goal, deps: [], status: 'pending' }];
  }

  // Report planning-call usage so the orchestrator can charge it to the budget
  // and the cost summary. Best-effort: a failed plan call (handled above)
  // reports nothing.
  if (onUsage) onUsage({ tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut });

  const parsed = parseTaskList(result.content);
  if (!parsed) {
    process.stderr.write(
      `[ashlr run] could not parse task list from planning response — using single-task fallback\n`,
    );
    return [{ id: 't1', goal, deps: [], status: 'pending' }];
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

// M41: single-sourced from prompts/roles.SYNTHESIZER_ROLE (verbatim).
const SYNTHESIS_SYSTEM = SYNTHESIZER_ROLE;

/**
 * Synthesize a final answer from completed task results.
 * Returns a best-effort string even if the model call fails.
 */
async function synthesize(
  goal: string,
  tasks: RunTask[],
  client: ProviderClient,
  signal?: AbortSignal,
): Promise<{
  content: string;
  usage: { tokensIn: number; tokensOut: number };
  failed?: boolean;
}> {
  const doneTasks = tasks.filter((t) => t.status === 'done' && t.result);
  if (doneTasks.length === 0) {
    return {
      content: 'No tasks completed successfully — no result to synthesize.',
      usage: { tokensIn: 0, tokensOut: 0 },
    };
  }

  const taskSummary = doneTasks
    .map((t) => `### ${t.id}: ${t.goal}\n${t.result ?? '(no result)'}`)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYNTHESIS_SYSTEM },
    {
      role: 'user',
      content: `Goal: ${goal}\n\nTask results:\n\n${taskSummary}\n\nPlease synthesize a final answer.`,
    },
  ];

  try {
    const res = await client.chat(messages, undefined, signal);
    return { content: res.content, usage: res.usage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort fallback: concatenate task results
    const fallback = doneTasks.map((t) => `[${t.id}] ${t.result ?? ''}`).join('\n');
    process.stderr.write(`[ashlr run] synthesis call failed: ${msg} — using concatenated fallback\n`);
    return {
      content: fallback,
      usage: reportedModelUsage(err) ?? { tokensIn: 0, tokensOut: 0 },
      failed: true,
    };
  }
}

// ---------------------------------------------------------------------------
// DAG execution helpers
// ---------------------------------------------------------------------------

/**
 * Returns all tasks that are ready to run (pending + all deps done).
 */
function readyTasks(tasks: RunTask[]): RunTask[] {
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return tasks.filter(
    (t) => t.status === 'pending' && t.deps.every((dep) => doneIds.has(dep)),
  );
}

/**
 * Returns true when all tasks are in a terminal state (done/failed/skipped/aborted).
 */
function allTerminal(tasks: RunTask[]): boolean {
  const terminal: RunTaskStatus[] = ['done', 'failed', 'skipped'];
  return tasks.every((t) => terminal.includes(t.status));
}

// ---------------------------------------------------------------------------
// M19: Telemetry emit + governance (best-effort, fire-and-forget, opt-in)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget OTLP/local telemetry emit for a completed run.
 *
 * Dynamically imports core/observability/telemetry-sink.ts and
 * core/observability/otlp.ts so this file compiles even before those modules
 * exist in the build. Only emits when both modules are available; all failures
 * are logged to stderr and never thrown to the caller. Never blocks the run.
 * METADATA ONLY — spans carry model/token/cost/ids/status; never prompts,
 * completions, tool args, file contents, or secrets.
 */
async function fireEmitRun(state: RunState, cfg: AshlrConfig): Promise<void> {
  await (async () => {
    try {
      // Lazy-import the telemetry seam so the orchestrator core has no hard
      // dependency on it at module-load time (keeps the hot path lean and the
      // emit fully best-effort). Both modules are real and fully typed.
      const [sinkMod, otlpMod] = await Promise.all([
        import('../observability/telemetry-sink.js'),
        import('../observability/otlp.js'),
      ]);
      if (
        typeof sinkMod.getSink !== 'function' ||
        typeof otlpMod.spansFromRun !== 'function'
      ) {
        return;
      }
      // allowPhantomProbe:false — never run a blocking spawnSync phantom probe
      // on the run completion path; OtlpHttpSink resolves the PAT async/bounded.
      const telSink = sinkMod.getSink(cfg, false);
      const spans = otlpMod.spansFromRun(state);
      const result = await telSink.emit(spans);
      if (!result.ok) {
        process.stderr.write(
          `[ashlr run] telemetry: emit failed — ${result.detail ?? 'unknown'}\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashlr run] telemetry: best-effort emit failed — ${msg}\n`);
    }
  })();
}

/**
 * Evaluate spend governance and return a blocking reason string when
 * govAction==='block' AND level==='over' AND --over-budget was not passed.
 * Prints a prominent advisory when level is 'warn' or 'over'. Never throws.
 * Returns null to proceed normally.
 */
async function checkGovernance(cfg: AshlrConfig, overBudgetFlag: boolean): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const govMod = await import('../observability/governance.js') as any;
    if (typeof govMod.evalGovernance !== 'function') return null;
    const verdict = govMod.evalGovernance(cfg) as import('../types.js').GovernanceStatus;
    if (verdict.level === 'over') {
      process.stderr.write(`\n[ashlr run] SPEND GOVERNANCE OVER-CAP: ${verdict.message}\n\n`);
      if (cfg.telemetry?.govAction === 'block' && !overBudgetFlag) {
        return (
          `Run blocked by spend governance: ${verdict.message} ` +
          `Pass --over-budget to proceed.`
        );
      }
    } else if (verdict.level === 'warn') {
      process.stderr.write(`\n[ashlr run] SPEND GOVERNANCE WARNING: ${verdict.message}\n\n`);
    }
    return null;
  } catch {
    // Governance must never block a run on error.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine delegation helpers
// ---------------------------------------------------------------------------

/**
 * Check if a binary is installed by probing PATH via `which`.
 * Uses the top-level execFileSync import (Node builtin, ESM-safe).
 * Kept for non-engine-id fallback detection (e.g. arbitrary string engines).
 */
function isBinaryInstalled(name: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Emit a RunStreamEvent via the sink. Never throws.
 */
function emit(sink: StreamSink, event: Omit<RunStreamEvent, 'ts'>): void {
  try {
    sink({ ...event, ts: new Date().toISOString() });
  } catch {
    // Sinks must never crash the run.
  }
}

/** Known engine ids (typed subset). */
const KNOWN_ENGINE_IDS: ReadonlySet<string> = new Set(['builtin', 'ashlrcode', 'aw', 'claude', 'codex', 'local-coder']);

// ---------------------------------------------------------------------------
// M78: TITRR — Test→Iterate→Test→Refine→Repeat helpers
// ---------------------------------------------------------------------------

/**
 * Default maximum TITRR loop attempts (conservative: 1 initial + 1 repair).
 * Callers may override via opts.titrrMaxAttempts.
 */
export const TITRR_MAX_ATTEMPTS = 2;

/** Hard wall-clock per test run inside the TITRR loop (60 s). */
const TITRR_TEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// M171: browser-verify fold helper
// ---------------------------------------------------------------------------

/**
 * Fold a BrowserVerifyResult into a task result string.
 *
 * Rules (exported for unit testing):
 *   skipped          → null (caller leaves task.result unchanged)
 *   renderOk=false
 *     OR errors > 0  → "[browser-verify: FAIL — <summary>]\n<existing>"
 *   clean pass       → "<existing>\n[browser-verify: PASS — <evidence>]"
 *
 * Pure function — never throws, never touches I/O.
 */
export function foldBrowserVerify(
  existing: string | undefined,
  bv: import('./browser-verify.js').BrowserVerifyResult,
): string | null {
  if (bv.skipped) return null;

  if (!bv.renderOk || bv.consoleErrors.length > 0) {
    const errSummary = bv.consoleErrors.length > 0
      ? `console errors: ${bv.consoleErrors.slice(0, 5).join('; ')}`
      : 'render failed';
    return `[browser-verify: FAIL — ${errSummary}]\n${existing ?? ''}`;
  }

  // Clean pass.
  const evidence = [
    bv.detail,
    bv.screenshotPath ? 'screenshot: captured' : '',
    browserVisualGroundingEvidence(bv.visualGrounding),
    `console errors: ${bv.consoleErrors.length}`,
  ].filter(Boolean).join(' | ');
  return `${existing ?? ''}\n[browser-verify: PASS — ${evidence}]`.trimStart();
}

function browserVisualGroundingEvidence(
  vg: import('../types.js').VisualGroundingEvidence | undefined,
): string {
  if (!vg) return '';
  const parts = [
    `visual grounding: ${vg.status}`,
    `provider: ${vg.provider}`,
    `boxes: ${vg.boxCount}`,
    vg.image?.sha256 ? `image sha256: ${vg.image.sha256}` : '',
    vg.detail ? `detail: ${vg.detail}` : '',
  ];
  return parts.filter(Boolean).join(', ');
}

/** Maximum output characters fed back to the engine as failure context. */
const TITRR_OUTPUT_CAP = 4_000;

/**
 * Run the repo's test command (kind='test') in `worktreePath`, bounded by a
 * hard timeout and output cap. Returns null when no test command is detected
 * (no-test-command repo → caller skips gracefully).
 *
 * Reuses detectVerifyCommands + runVerifyCommandAsync from verify-commands.ts (DRY).
 * Never throws — all errors surface as { ok:false, output:... }.
 */
export async function titrrTestRun(
  worktreePath: string,
  cfg: AshlrConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string } | null> {
  const cancelledResult = { ok: false, output: 'TITRR test run cancelled.' };
  if (signal?.aborted) return cancelledResult;

  // Only run the test command — typecheck/lint are out of scope for TITRR.
  const allCmds = detectVerifyCommands(worktreePath);
  const testCmd = allCmds.find((c) => c.kind === 'test');
  if (!testCmd) return null; // no test command → skip gracefully

  const verifyOptions = {
    timeoutMs: TITRR_TEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  };
  // The verifier owns subprocess cancellation and resolves only after process
  // settlement. Await it directly so callers cannot remove the worktree while
  // the cancelled verifier still has an active cwd or open file handles.
  const result = await runVerifyCommandAsync(testCmd, worktreePath, cfg, verifyOptions);
  if (signal?.aborted) return cancelledResult;

  const trimmed = result.output.length > TITRR_OUTPUT_CAP
    ? result.output.slice(0, TITRR_OUTPUT_CAP) + '\n…[output truncated]'
    : result.output;

  return { ok: result.ok, output: trimmed };
}

/**
 * M45: whether an external engine should run SANDBOXED (worktree + diff→inbox)
 * instead of raw on the live tree. True only when cfg.foundry opts in; default
 * (absent) keeps the raw delegation path → today's behavior unchanged.
 */
function foundryWantsSandbox(cfg: AshlrConfig, engine: EngineId): boolean {
  if (engine === 'builtin') return false;
  if (!cfg.foundry) return false;
  return cfg.foundry.sandboxExternal ?? true;
}

// ---------------------------------------------------------------------------
// Main: runGoal
// ---------------------------------------------------------------------------

/**
 * Top-level orchestrator driver. Builds/loads RunState, plans (unless resuming),
 * executes the DAG with parallelism up to opts.parallel, enforces HARD budget,
 * persists after every step, synthesizes final answer, best-effort Pulse POST.
 *
 * M7: genome-aware. Before planning, recalls top-k genome hits for the goal
 * and injects them as context into the planning prompt — bounded, local-only,
 * best-effort. Disabled via opts.noMemory or cfg.genome?.injectOnRun === false.
 */
export async function runGoal(
  goal: string,
  cfg: AshlrConfig,
  opts: RunOptions,
): Promise<RunState> {
  if (opts.resumeId && opts.runId) opts = { ...opts, runId: undefined };
  if (opts.runId) {
    const runId = assertSafeExecutionIdentity(opts.runId);
    if (loadRun(runId)) throw new Error(`Run "${runId}" already exists; use resumeId to continue it`);
    opts = { ...opts, runId };
  }
  const cancelled = (): boolean => opts.signal?.aborted === true;
  if (cancelled() && opts.resumeId) {
    const existing = loadRun(opts.resumeId);
    if (!existing) throw new Error(`Run "${opts.resumeId}" not found in ${runsDir()}`);
    return existing;
  }
  if (cancelled()) {
    return newCancelledRunState(goal, opts);
  }
  // Optional CLI progress hook. The CLI (src/cli/run.ts) attaches a non-typed
  // __onStep property to opts to receive live per-step progress. We read it off
  // here and invoke it after each persisted step (model/plan/synthesize). It is
  // best-effort: it must never crash the run.
  const rawCliOnStep = (opts as RunOptions & {
    __onStep?: (step: RunStep, tasks: RunTask[]) => void;
  }).__onStep;
  const cliOnStep =
    typeof rawCliOnStep === 'function'
      ? (step: RunStep, tasks: RunTask[]): void => {
          try {
            rawCliOnStep(step, tasks);
          } catch {
            // Progress reporting must never break the run.
          }
        }
      : undefined;

  // M11: read __sink (StreamSink) from opts. The CLI attaches it for live progress.
  // Falls back to nullSink() when absent (non-TTY, tests, --no-stream).
  const rawSink = (opts as RunOptions & { __sink?: StreamSink }).__sink;
  const sink: StreamSink = typeof rawSink === 'function' ? rawSink : nullSink();

  // M11: opt-in model verification. Default OFF → the per-task verify step is
  // heuristic-only, charging NO extra model calls (preserves M4 deterministic
  // usage accounting). When enabled, verifyTask may make one cheap model call
  // per task (and one verify-driven retry) under the global budget.
  const verifyModel = opts.verifyModel === true;

  const delegationScope = opts.delegationScope
    ? normalizeDelegationScope(opts.delegationScope, {
        origin: 'run',
        sourceRepo: opts.cwd ?? process.cwd(),
        objective: goal,
        budget: opts.budget,
      })
    : undefined;
  const delegationScopeSummary = summarizeDelegationScope(delegationScope);

  // M7: read noMemory from opts. Not yet typed in RunOptions (avoid editing
  // types.ts) — read as an extended property, same pattern as __onStep above.
  const noMemory =
    (opts as RunOptions & { noMemory?: boolean }).noMemory === true ||
    delegationScope?.memoryMode === 'none';

  // -- Resume short-circuit (M10 fix: must run BEFORE engine delegation) -------
  // When --resume is requested we must NEVER delegate to an external engine —
  // the run was already started by whichever engine created it, and resuming
  // means continuing with the builtin executor against the persisted state.
  // Previously the engine-delegation block ran first, so
  // `run --engine ashlrcode --resume <id>` would re-run via ashlrcode instead
  // of resuming.  Now we handle all resume guards here, before engine selection:
  //   1. Not found  → throw immediately.
  //   2. Already complete → return early (no-op).
  //   3. Incomplete → fall through with opts.resumeId set; engine selection
  //      below skips delegation because we override engine to 'builtin'.
  if (opts.resumeId) {
    const existingForResume = loadRun(opts.resumeId);
    if (!existingForResume) {
      throw new Error(`Run "${opts.resumeId}" not found in ${runsDir()}`);
    }
    if (existingForResume.status === 'done' && existingForResume.result) {
      process.stderr.write(
        `[ashlr run] run ${existingForResume.id} is already complete — nothing to resume\n`,
      );
      return existingForResume;
    }
    // Incomplete resume: force builtin so engine delegation is skipped.
    // The full state reload / task-reset happens in the "Load or create
    // RunState" block further below.
    opts = { ...opts, engine: 'builtin' };
  }

  // -- Engine selection --------------------------------------------------------
  const requestedEngine = opts.engine ?? 'builtin';
  let engine = requestedEngine;
  if (engine !== 'builtin') {
    // Determine if this is a known typed engine id or an arbitrary binary name.
    const isKnownEngineId = KNOWN_ENGINE_IDS.has(engine);
    const engineId = isKnownEngineId ? (engine as EngineId) : 'ashlrcode'; // arbitrary → treat as external

    // Check installation: for known ids use engineInstalled(); for arbitrary names use isBinaryInstalled().
    const installed = isKnownEngineId
      ? engineInstalled(engineId)
      : isBinaryInstalled(engine);

    if (!installed) {
      process.stderr.write(
        `[ashlr run] engine "${engine}" not found on PATH — falling back to builtin\n`,
      );
      emit(sink, { kind: 'log', text: `engine "${engine}" not found — falling back to builtin` });
      engine = 'builtin';
    } else {
      // Delegate to the external engine via the hardened per-engine adapter.
      // buildEngineCommand produces the EXACT argv for the real CLI.
      // spawnEngine applies withToolEnv(cfg) + phantom-exec wrap when enabled.
      // This is a SINGLE BOUNDED SPAWN — never recursive.
      const modelEnv =
        typeof opts.model === 'string' && opts.model.trim().length > 0
          ? opts.model.trim()
          : process.env['ASHLR_MODEL'] ?? process.env['AC_MODEL'];
      // Honor opts.cwd (e.g. a swarm task's target project dir) so the engine
      // spawns WITHIN the intended project, not wherever the parent launched.
      // Validate it is an existing directory before use; fall back to cwd.
      let cwd = process.cwd();
      if (opts.cwd) {
        try {
          if (
            path.isAbsolute(opts.cwd) &&
            fs.existsSync(opts.cwd) &&
            fs.statSync(opts.cwd).isDirectory()
          ) {
            cwd = opts.cwd;
          } else {
            process.stderr.write(
              `[ashlr run] opts.cwd "${opts.cwd}" is not an existing absolute directory — using ${cwd}\n`,
            );
          }
        } catch {
          // stat failed — keep the default cwd
        }
      }

      // Build the correct command for known engine ids; for unknown use the
      // old-style fallback (engine binary not in KNOWN_ENGINE_IDS was already
      // handled above via isBinaryInstalled, so this branch is only reached
      // for known ids).
      const cmd = isKnownEngineId
        ? buildEngineCommand(engineId, goal, cfg, { cwd, model: modelEnv })
        : null;

      if (!cmd) {
        // M117: api-model engines have no CLI argv (buildEngineCommand returns null
        // for kind==='api-model'). Run them IN-PROCESS via the agent-loop +
        // buildOpenAICompatibleClient, confined to a sandbox worktree, capturing
        // the resulting diff as a PENDING proposal — identical containment to
        // cli-agent sandbox, but no subprocess spawn. This is the ONLY path that
        // produces real diffs from local models (Ollama/local-coder).
        //
        // Requires: (a) foundryWantsSandbox or opts.sandboxEngine — same gate as
        // cli-agent sandbox; (b) the engine spec has kind==='api-model' with a
        // valid api config. Falls through to builtin if either precondition fails.
        const spec = isKnownEngineId ? resolveEngineSpec(engineId, cfg) : null;
        if (
          spec?.kind === 'api-model' &&
          spec.api &&
          (opts.sandboxEngine === true || foundryWantsSandbox(cfg, engineId))
        ) {
          process.stderr.write(
            `[ashlr run] api-model engine "${engine}" — in-process sandboxed run (${goal.slice(0, 60)}…)\n`,
          );
          emit(sink, { kind: 'log', text: `api-model engine "${engine}" — in-process sandboxed run` });

          const { captureSandboxedProposal, runApiModelSandboxed } = await import('./sandboxed-engine.js');
          const titrrMax = Math.max(1, (opts as RunOptions & { titrrMaxAttempts?: number }).titrrMaxAttempts ?? TITRR_MAX_ATTEMPTS);

          const wtMod = await import('../sandbox/worktree.js');
          let titrrSandbox: Sandbox | null = null;
          try {
            titrrSandbox = wtMod.createSandbox(cwd);
          } catch {
            // sandbox creation failed — fall through to builtin
          }

          if (cancelled() && !titrrSandbox) {
            const cancelledState = newCancelledRunState(goal, opts, engine, 'external');
            saveRun(cancelledState);
            return cancelledState;
          }

          if (titrrSandbox) {
            let titrrAttempt = 0;
            let lastApiR: Awaited<ReturnType<typeof runApiModelSandboxed>> | null = null;
            let apiGoal = goal;
            const titrrBudget = resolveTitrrBudget(opts.budget, opts.allowCloud);
            let titrrUsage = newUsage();
            let titrrActionCounts: RunActionCounts = {};
            let titrrDurationMs = 0;

            try {
              while (titrrAttempt < titrrMax) {
                if (cancelled()) break;
                titrrAttempt++;
                const isLastAttempt = titrrAttempt === titrrMax;
                const rawApiR = await runApiModelSandboxed(engineId, apiGoal, cfg, {
                  sourceRepo: cwd,
                  model: modelEnv,
                  budget: remainingTitrrBudget(titrrBudget, titrrUsage),
                  propose: false,
                  existingWorktree: titrrSandbox,
                  workItemId: opts.workItemId,
                  workItemGenerationId: opts.workItemGenerationId,
                  workSource: opts.workSource,
                  delegationScope,
                  ...(opts.signal ? { signal: opts.signal } : {}),
                  ...(opts.runId ? { runId: opts.runId } : {}),
                });
                titrrUsage = addUsage(titrrUsage, accountedTitrrAttemptUsage(rawApiR.state.usage));
                titrrActionCounts = addTitrrActionCounts(
                  titrrActionCounts,
                  rawApiR.state.runEventSummary?.actionCounts,
                );
                titrrDurationMs += runDurationMs(rawApiR.state) ?? 0;
                const apiR = {
                  ...rawApiR,
                  state: withCumulativeUsage(
                    rawApiR.state,
                    titrrUsage,
                    titrrBudget,
                    titrrActionCounts,
                    titrrDurationMs,
                  ),
                };
                lastApiR = apiR;

                if (cancelled()) {
                  lastApiR = { ...apiR, state: asCancelledRunState(apiR.state) };
                  break;
                }
                if (apiR.state.status === 'aborted') break;

                if (apiR.state.status !== 'done') {
                  const propR = await captureSandboxedProposal(engineId, goal, cfg, {
                    sourceRepo: cwd,
                    model: modelEnv,
                    budget: opts.budget,
                    runId: apiR.state.id,
                    existingWorktree: titrrSandbox,
                    workItemId: opts.workItemId,
                    workItemGenerationId: opts.workItemGenerationId,
                    workSource: opts.workSource,
                    delegationScope,
                    ...(opts.signal ? { signal: opts.signal } : {}),
                    isPartial: true,
                    sourceLabel: 'TITRR api-model failed producer',
                    usage: apiR.state.usage,
                    durationMs: runDurationMs(apiR.state),
                    producerStatus: apiR.state.status,
                    actionCounts: actionCountsForProposalCapture(apiR.state),
                    contextSummary: apiR.state.runEventSummary?.contextSummary,
                  });
                  const captureOutcome = failedCaptureOutcome(
                    apiR.state,
                    propR.proposalOutcome,
                    'api-model-task-failed',
                  );
                  lastApiR = {
                    ...apiR,
                    proposalId: propR.proposalId,
                    proposalOutcome: captureOutcome,
                    state: withCapturedProposalMetadata(
                      apiR.state,
                      captureOutcome
                        ? { ...propR.state, proposalOutcome: captureOutcome }
                        : propR.state,
                    ),
                  };
                  break;
                }

                if (
                  delegationScope?.resultContract?.requireDiff === true &&
                  runStateHasKnownEmptyDiff(apiR.state)
                ) {
                  const retryBudgetExceeded = overBudget(
                    titrrUsage,
                    titrrBudget,
                  );
                  if (isLastAttempt || retryBudgetExceeded) {
                    const propR = await captureSandboxedProposal(engineId, goal, cfg, {
                      sourceRepo: cwd,
                      model: modelEnv,
                      budget: opts.budget,
                      runId: apiR.state.id,
                      existingWorktree: titrrSandbox,
                      workItemId: opts.workItemId,
                      workItemGenerationId: opts.workItemGenerationId,
                      workSource: opts.workSource,
                      delegationScope,
                      ...(opts.signal ? { signal: opts.signal } : {}),
                      sourceLabel: 'TITRR api-model required-diff',
                      usage: apiR.state.usage,
                      durationMs: runDurationMs(apiR.state),
                      producerStatus: apiR.state.status,
                      actionCounts: actionCountsForProposalCapture(apiR.state),
                      contextSummary: apiR.state.runEventSummary?.contextSummary,
                    });
                    lastApiR = {
                      ...apiR,
                      proposalId: propR.proposalId,
                      proposalOutcome: propR.proposalOutcome,
                      state: withCapturedProposalMetadata(
                        apiR.state,
                        propR.proposalOutcome
                          ? { ...propR.state, proposalOutcome: propR.proposalOutcome }
                          : propR.state,
                      ),
                    };
                    break;
                  }
                  apiGoal = requiredDiffRetryGoal(goal, titrrAttempt, titrrMax);
                  emit(sink, {
                    kind: 'retry',
                    text: `[TITRR] required diff missing - retry attempt ${titrrAttempt + 1}/${titrrMax}`,
                  });
                  continue;
                }

                // M140: realTestLoop flag (default true). When false, skip test execution
                // and treat as if no test command was found (propose immediately).
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- m140 pins this exact source text
                const realTestLoop = (cfg.foundry as any)?.realTestLoop ?? true;
                const titrrResult = realTestLoop
                  ? await titrrTestRun(titrrSandbox.worktreePath, cfg, opts.signal)
                  : null;
                if (cancelled()) {
                  lastApiR = { ...lastApiR, state: asCancelledRunState(lastApiR.state) };
                  break;
                }
                if (!titrrResult || titrrResult.ok) {
                  const propR = await captureSandboxedProposal(engineId, goal, cfg, {
                    sourceRepo: cwd,
                    model: modelEnv,
                    budget: opts.budget,
                    runId: lastApiR.state.id,
                    existingWorktree: titrrSandbox,
                    workItemId: opts.workItemId,
                    workItemGenerationId: opts.workItemGenerationId,
                    workSource: opts.workSource,
                    delegationScope,
                    ...(opts.signal ? { signal: opts.signal } : {}),
                    ...(lastApiR.proposalOutcome?.isPartial === true ? { isPartial: true } : {}),
                    sourceLabel: 'TITRR api-model',
                    usage: lastApiR.state.usage,
                    durationMs: runDurationMs(lastApiR.state),
                    producerStatus: lastApiR.state.status,
                    actionCounts: actionCountsForProposalCapture(lastApiR.state),
                    contextSummary: lastApiR.state.runEventSummary?.contextSummary,
                  });
                  lastApiR = {
                    ...lastApiR,
                    proposalId: propR.proposalId,
                    proposalOutcome: propR.proposalOutcome,
                    state: withCapturedProposalMetadata(
                      lastApiR.state,
                      propR.proposalOutcome
                        ? { ...propR.state, proposalOutcome: propR.proposalOutcome }
                        : propR.state,
                    ),
                  };
                  break;
                }

                if (isLastAttempt) {
                  const propR = await captureSandboxedProposal(engineId, goal, cfg, {
                    sourceRepo: cwd,
                    model: modelEnv,
                    budget: opts.budget,
                    runId: lastApiR.state.id,
                    existingWorktree: titrrSandbox,
                    workItemId: opts.workItemId,
                    workItemGenerationId: opts.workItemGenerationId,
                    workSource: opts.workSource,
                    delegationScope,
                    ...(opts.signal ? { signal: opts.signal } : {}),
                    isPartial: true,
                    forceGateBlockReason: `tests: still failing after ${titrrAttempt} attempt(s)`,
                    sourceLabel: 'TITRR api-model',
                    usage: lastApiR.state.usage,
                    durationMs: runDurationMs(lastApiR.state),
                    producerStatus: lastApiR.state.status,
                    actionCounts: actionCountsForProposalCapture(lastApiR.state),
                    contextSummary: lastApiR.state.runEventSummary?.contextSummary,
                  });
                  lastApiR = {
                    ...lastApiR,
                    proposalId: propR.proposalId,
                    proposalOutcome: propR.proposalOutcome,
                    state: withCapturedProposalMetadata(
                      lastApiR.state,
                      propR.proposalOutcome
                        ? { ...propR.state, proposalOutcome: propR.proposalOutcome }
                        : propR.state,
                    ),
                  };
                  break;
                }
                if (overBudget(titrrUsage, titrrBudget)) {
                  const forceGateBlockReason = `tests: still failing - budget exceeded after attempt ${titrrAttempt}`;
                  const propR = await captureSandboxedProposal(engineId, goal, cfg, {
                    sourceRepo: cwd,
                    model: modelEnv,
                    budget: opts.budget,
                    runId: lastApiR.state.id,
                    existingWorktree: titrrSandbox,
                    workItemId: opts.workItemId,
                    workItemGenerationId: opts.workItemGenerationId,
                    workSource: opts.workSource,
                    delegationScope,
                    ...(opts.signal ? { signal: opts.signal } : {}),
                    isPartial: true,
                    forceGateBlockReason,
                    sourceLabel: 'TITRR api-model',
                    usage: lastApiR.state.usage,
                    durationMs: runDurationMs(lastApiR.state),
                    producerStatus: lastApiR.state.status,
                    actionCounts: actionCountsForProposalCapture(lastApiR.state),
                    contextSummary: lastApiR.state.runEventSummary?.contextSummary,
                  });
                  lastApiR = {
                    ...lastApiR,
                    proposalId: propR.proposalId,
                    proposalOutcome: propR.proposalOutcome,
                    state: withCapturedProposalMetadata(
                      lastApiR.state,
                      propR.proposalOutcome
                        ? { ...propR.state, proposalOutcome: propR.proposalOutcome }
                        : propR.state,
                    ),
                  };
                  break;
                }
                apiGoal = `${goal}\n\n[REPAIR] Tests failed:\n${titrrResult.output.slice(0, 2000)}`;
              }
            } finally {
              try { wtMod.removeSandbox(titrrSandbox); } catch { /* best-effort */ }
            }

            if (cancelled() && !lastApiR) {
              const cancelledState = newCancelledRunState(goal, opts, engine, 'external');
              saveRun(cancelledState);
              return cancelledState;
            }
            if (lastApiR) {
              if (cancelled()) {
                lastApiR = { ...lastApiR, state: asCancelledRunState(lastApiR.state) };
              }
              emit(sink, {
                kind: 'log',
                text: lastApiR.proposalId
                  ? `api-model engine "${engine}" → inbox proposal ${lastApiR.proposalId}`
                  : `api-model engine "${engine}" → no diff produced`,
              });
              saveRun(lastApiR.state);
              return lastApiR.state;
            }
          }

          // sandbox creation failed or no result — fall through to builtin
          engine = 'builtin';
        } else {
          // buildEngineCommand returned null for a non-api-model engine (builtin) —
          // fall through to builtin path.
          engine = 'builtin';
        }
      } else {
        process.stderr.write(
          `[ashlr run] delegating to engine "${engine}" (${goal.slice(0, 60)}…)\n`,
        );
        emit(sink, { kind: 'log', text: `delegating to engine "${engine}"` });

        // M45/M78: sandboxed-external path — run the agent CLI confined to a throwaway
        // worktree and capture its diff as a PENDING proposal. Gated by
        // opts.sandboxEngine or cfg.foundry; when neither is set the raw delegation
        // below runs unchanged (today's behavior). No raw fallback here: defeating
        // the sandbox would break the no-outward guarantee for autonomous runs.
        //
        // M78 TITRR: after each engine run, detect and run the repo's test command
        // inside the sandbox worktree. On failure, re-invoke the engine with the
        // failing output as context (up to titrrMaxAttempts). The final proposal is
        // annotated with the TITRR outcome. Degrades gracefully when no test command
        // is detected (no-test-command repo → behavior identical to pre-M78).
        if (opts.sandboxEngine === true || foundryWantsSandbox(cfg, engineId)) {
          const { captureSandboxedProposal, runEngineSandboxed } = await import('./sandboxed-engine.js');
          const titrrMax = Math.max(1, (opts as RunOptions & { titrrMaxAttempts?: number }).titrrMaxAttempts ?? TITRR_MAX_ATTEMPTS);

          // Create one shared sandbox worktree for all TITRR attempts so the engine
          // accumulates its edits across repairs and we run tests in the same tree.
          const wtMod = await import('../sandbox/worktree.js');
          let titrrSandbox: Sandbox | null = null;
          try {
            titrrSandbox = wtMod.createSandbox(cwd);
          } catch {
            // Sandbox creation failed — fall back to the original single-attempt path.
          }

          if (cancelled() && !titrrSandbox) {
            const cancelledState = newCancelledRunState(goal, opts, engine, 'external');
            saveRun(cancelledState);
            return cancelledState;
          }

          if (!titrrSandbox) {
            const fallback = await runEngineSandboxed(engineId, goal, cfg, {
              sourceRepo: cwd,
              model: modelEnv,
              budget: opts.budget,
              propose: true,
              workItemId: opts.workItemId,
              workItemGenerationId: opts.workItemGenerationId,
              workSource: opts.workSource,
              delegationScope,
              ...(opts.signal ? { signal: opts.signal } : {}),
              ...(opts.runId ? { runId: opts.runId } : {}),
            });
            const fallbackStateWithRetention = withSandboxRetention(
              fallback.state,
              sandboxRetentionFrom(fallback),
            );
            const fallbackState = cancelled()
              ? asCancelledRunState(fallbackStateWithRetention)
              : fallbackStateWithRetention;
            saveRun(fallbackState);
            return fallbackState;
          }

          let titrrAttempt = 0;
          let titrrResult: { ok: boolean; output: string } | null = null;
          let titrrAnnotation = '';
          let lastR: Awaited<ReturnType<typeof runEngineSandboxed>> | null = null;
          let titrrGoal = goal;
          const titrrBudget = resolveTitrrBudget(opts.budget, opts.allowCloud);
          let titrrUsage = newUsage();
          let titrrActionCounts: RunActionCounts = {};
          let titrrDurationMs = 0;
          const captureTitrrProposal = async (options: { isPartial?: boolean; forceGateBlockReason?: string } = {}) => {
            if (cancelled()) return;
            const sandbox = titrrSandbox;
            const producer = lastR;
            if (!sandbox || !producer) return;
            const propR = await captureSandboxedProposal(engineId, goal, cfg, {
              sourceRepo: cwd,
              model: modelEnv,
              budget: opts.budget,
              runId: producer.state.id,
              existingWorktree: sandbox,
              workItemId: opts.workItemId,
              workItemGenerationId: opts.workItemGenerationId,
              workSource: opts.workSource,
              delegationScope,
              ...(opts.signal ? { signal: opts.signal } : {}),
              ...(options.isPartial ? { isPartial: true } : {}),
              ...(options.forceGateBlockReason ? { forceGateBlockReason: options.forceGateBlockReason } : {}),
              sourceLabel: 'TITRR',
              usage: producer.state.usage,
              durationMs: runDurationMs(producer.state),
              producerStatus: producer.state.status,
              actionCounts: actionCountsForProposalCapture(producer.state),
              contextSummary: producer.state.runEventSummary?.contextSummary,
            });
            const capturedState = propR.proposalOutcome
              ? { ...propR.state, proposalOutcome: propR.proposalOutcome }
              : propR.state;
            lastR = {
              ...producer,
              proposalId: propR.proposalId,
              proposalOutcome: propR.proposalOutcome,
              state: withCapturedProposalMetadata(producer.state, capturedState),
            };
          };

          try {
            while (titrrAttempt < titrrMax) {
              if (cancelled()) break;
              titrrAttempt++;

              // Run every TITRR model attempt without filing. Once tests pass
              // (or no test command exists), capture the already-verified
              // sandbox diff exactly once without invoking the model again.
              const isLastAttempt = titrrAttempt === titrrMax;
              const rawR = await runEngineSandboxed(engineId, titrrGoal, cfg, {
                sourceRepo: cwd,
                model: modelEnv,
                budget: remainingTitrrBudget(titrrBudget, titrrUsage),
                propose: false,
                existingWorktree: titrrSandbox ?? undefined,
                workItemId: opts.workItemId,
                workItemGenerationId: opts.workItemGenerationId,
                workSource: opts.workSource,
                delegationScope,
                ...(opts.signal ? { signal: opts.signal } : {}),
                ...(opts.runId ? { runId: opts.runId } : {}),
              });
              const retention = sandboxRetentionFrom(rawR);
              titrrUsage = addUsage(titrrUsage, accountedTitrrAttemptUsage(rawR.state.usage));
              titrrActionCounts = addTitrrActionCounts(
                titrrActionCounts,
                rawR.state.runEventSummary?.actionCounts,
              );
              titrrDurationMs += runDurationMs(rawR.state) ?? 0;
              const r = {
                ...rawR,
                state: withSandboxRetention(
                  withCumulativeUsage(
                    rawR.state,
                    titrrUsage,
                    titrrBudget,
                    titrrActionCounts,
                    titrrDurationMs,
                  ),
                  retention,
                ),
              };
              lastR = r;

              if (retention) break;
              if (cancelled()) {
                lastR = { ...r, state: asCancelledRunState(r.state) };
                break;
              }
              if (r.state.status === 'aborted') break;

              if (r.state.status !== 'done') {
                // Preserve useful partial work before the shared sandbox is removed.
                titrrAnnotation = `producer ${r.state.status}; partial capture attempted`;
                await captureTitrrProposal({ isPartial: true });
                const captureOutcome = failedCaptureOutcome(
                  r.state,
                  lastR?.proposalOutcome,
                  'engine-failed-no-diff',
                );
                if (lastR && captureOutcome) {
                  lastR = {
                    ...lastR,
                    proposalOutcome: captureOutcome,
                    state: { ...lastR.state, proposalOutcome: captureOutcome },
                  };
                }
                break;
              }

              if (
                delegationScope?.resultContract?.requireDiff === true &&
                runStateHasKnownEmptyDiff(r.state)
              ) {
                const retryBudgetExceeded = overBudget(
                  titrrUsage,
                  titrrBudget,
                );
                if (isLastAttempt || retryBudgetExceeded) {
                  titrrAnnotation = retryBudgetExceeded
                    ? `required diff missing - budget exceeded after attempt ${titrrAttempt}`
                    : `required diff missing after ${titrrAttempt} attempt(s)`;
                  await captureTitrrProposal();
                  break;
                }
                titrrGoal = requiredDiffRetryGoal(goal, titrrAttempt, titrrMax);
                emit(sink, {
                  kind: 'retry',
                  text: `[TITRR] required diff missing - retry attempt ${titrrAttempt + 1}/${titrrMax}`,
                });
                continue;
              }

              // Run the repo's test command inside the shared sandbox worktree.
              // titrrTestRun returns null when no test command is detected →
              // skip the test step entirely and proceed to propose (graceful degrade).
              // M140: realTestLoop flag (default true). When false, behave as if no
              // test command was found — skip test execution entirely (reversible flag).
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- m140 pins this exact source text
              const realTestLoop = (cfg.foundry as any)?.realTestLoop ?? true;
              const testRoot = titrrSandbox?.worktreePath ?? cwd;
              if (realTestLoop) {
                emit(sink, {
                  kind: 'log',
                  text: `[TITRR] attempt ${titrrAttempt}/${titrrMax}: running tests in ${testRoot}`,
                });
              }
              titrrResult = realTestLoop ? await titrrTestRun(testRoot, cfg, opts.signal) : null;
              if (cancelled()) {
                lastR = { ...lastR, state: asCancelledRunState(lastR.state) };
                break;
              }

              if (titrrResult === null) {
                // No test command detected — annotate and stop early.
                titrrAnnotation = 'tests: not detected (skipped)';
                await captureTitrrProposal();
                break;
              }

              if (titrrResult.ok) {
                titrrAnnotation = `tests: pass (attempt ${titrrAttempt})`;
                await captureTitrrProposal();
                break;
              }

              // Tests failed. If this was the last attempt, annotate and exit.
              if (isLastAttempt) {
                titrrAnnotation = `tests: still failing after ${titrrAttempt} attempt(s)`;
                await captureTitrrProposal({ isPartial: true, forceGateBlockReason: titrrAnnotation });
                break;
              }

              // Budget check before re-invoking.
              if (overBudget(titrrUsage, titrrBudget)) {
                titrrAnnotation = `tests: still failing — budget exceeded after attempt ${titrrAttempt}`;
                await captureTitrrProposal({ isPartial: true, forceGateBlockReason: titrrAnnotation });
                break;
              }

              // Prepare a repair goal with the failure output as context.
              const failureSummary = titrrResult.output.slice(0, TITRR_OUTPUT_CAP);
              titrrGoal =
                `${goal}\n\n[TITRR repair ${titrrAttempt}/${titrrMax - 1}]\n` +
                `The change failed these tests:\n${failureSummary}\n` +
                `Fix the code so all tests pass.`;
              emit(sink, {
                kind: 'retry',
                text: `[TITRR] tests failed — repair attempt ${titrrAttempt + 1}/${titrrMax}`,
              });
            }
          } finally {
            // Unconfirmed process closure quarantines the shared worktree for
            // orphan recovery; removing it here could race a surviving child.
            if (titrrSandbox && !sandboxRetentionFrom(lastR)) {
              try { wtMod.removeSandbox(titrrSandbox); } catch { /* idempotent */ }
              titrrSandbox = null;
            }
          }

          if (!lastR) {
            const cancelledState = newCancelledRunState(goal, opts, engine, 'external');
            saveRun(cancelledState);
            return cancelledState;
          }
          const finalR = cancelled()
            ? { ...lastR, state: asCancelledRunState(lastR.state) }
            : lastR;

          // Annotate the RunState result with the TITRR outcome.
          if (titrrAnnotation) {
            finalR.state.result = finalR.state.result
              ? `[TITRR: ${titrrAnnotation}]\n${finalR.state.result}`
              : `[TITRR: ${titrrAnnotation}]`;
          }

          emit(sink, {
            kind: finalR.state.status === 'done' ? 'task-done' : 'log',
            text: finalR.proposalId
              ? `engine "${engine}" → inbox proposal ${finalR.proposalId} [${titrrAnnotation || 'titrr'}]`
              : `engine "${engine}" ${finalR.state.status}`,
          });
          saveRun(finalR.state);
          return finalR.state;
        }

        const id = opts.runId ?? generateRunId();
        const now = new Date().toISOString();
        const delegatedState: RunState = {
          id,
          goal,
          engine,
          provider: 'external',
          createdAt: now,
          updatedAt: now,
          budget: {
            maxTokens: opts.budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
            maxSteps: opts.budget?.maxSteps ?? DEFAULT_MAX_STEPS,
            allowCloud: opts.allowCloud ?? false,
          },
          usage: newUsage(),
          tasks: [],
          steps: [],
          status: 'running',
          ...(delegationScopeSummary ? { delegationScope: delegationScopeSummary } : {}),
        };

        // spawnEngine: applies withToolEnv(cfg) + phantom-exec when enabled.
        // M236: now async (streaming spawn + stall monitor).
        const engineResult = await spawnEngine(cmd, cfg, {
          ...(opts.signal ? { signal: opts.signal } : {}),
        });

        // Preserve any usage parsed from partial engine output even when the
        // subprocess was cancelled before producing a successful result.
        if (engineResult.usage) {
          delegatedState.usage.tokensIn = engineResult.usage.tokensIn;
          delegatedState.usage.tokensOut = engineResult.usage.tokensOut;
          delegatedState.usage.steps = 1;
          delegatedState.usage.estCostUsd = estCostUsd(engine, engineResult.usage.tokensIn, engineResult.usage.tokensOut);
        }

        if (cancelled() || engineResult.terminationReason === 'cancelled') {
          const cancelledState = asCancelledRunState(delegatedState);
          saveRun(cancelledState);
          return cancelledState;
        }

        if (!engineResult.ok) {
          const errMsg = engineResult.error ?? 'unknown error';
          process.stderr.write(`[ashlr run] engine "${engine}" failed: ${errMsg}\n`);
          emit(sink, { kind: 'log', text: `engine "${engine}" failed: ${errMsg}` });
          delegatedState.status = 'failed';
          delegatedState.result = `Engine "${engine}" failed: ${errMsg}`;
          delegatedState.updatedAt = new Date().toISOString();
          saveRun(delegatedState);
          return delegatedState;
        }

        delegatedState.status = 'done';
        delegatedState.result = engineResult.output;
        delegatedState.updatedAt = new Date().toISOString();
        emit(sink, { kind: 'task-done', text: `engine "${engine}" completed` });
        saveRun(delegatedState);
        return delegatedState;
      }
    }
  }

  // Suppress unused-import warning for withToolEnv (still used by engines.ts indirectly;
  // kept here for the M10 env-bridge contract — callers outside this file use it too).
  void withToolEnv;

  // -- M19: Spend governance check (advisory; block only when govAction==='block') --
  // Read the --over-budget flag the same way noMemory/noCapture are read: as an
  // extended property on opts (not yet in the typed RunOptions interface).
  const overBudgetFlag = (opts as RunOptions & { overBudget?: boolean }).overBudget === true;
  const govBlock = await checkGovernance(cfg, overBudgetFlag);
  if (govBlock !== null) {
    const now = new Date().toISOString();
    const blockState: RunState = {
      id: opts.runId ?? generateRunId(),
      goal,
      engine: 'builtin',
      provider: 'none',
      createdAt: now,
      updatedAt: now,
      budget: {
        maxTokens: opts.budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
        maxSteps: opts.budget?.maxSteps ?? DEFAULT_MAX_STEPS,
        allowCloud: opts.allowCloud ?? false,
      },
      usage: newUsage(),
      tasks: [],
      steps: [],
      status: 'failed',
      result: govBlock,
      ...(delegationScopeSummary ? { delegationScope: delegationScopeSummary } : {}),
    };
    process.stderr.write(`[ashlr run] ${govBlock}\n`);
    return blockState;
  }

  // -- Budget / parallel defaults ----------------------------------------------
  const allowCloud = opts.allowCloud ?? false;
  const budget = {
    maxTokens: opts.budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSteps: opts.budget?.maxSteps ?? DEFAULT_MAX_STEPS,
    allowCloud,
  };
  const parallel = Math.max(1, opts.parallel ?? DEFAULT_PARALLEL);

  // -- Resolve provider client -------------------------------------------------
  // M226b: when cloud is allowed, plan + synthesise with the FRONTIER strategist
  // (cfg.foundry.strategistModel, e.g. claude-opus-4-8) instead of the default
  // local client. getActiveClient only PERMITS cloud via allowCloud; passing the
  // strategist model SELECTS it — otherwise the planner/synthesis calls hit local
  // Ollama, time out, and fall back to degraded plans (blocking goal advancement).
  // Flag-off (no allowCloud) keeps the prior default client byte-identical.
  // M226c: claude-opus-4-8 is NOT a reachable chat client (no Anthropic API key —
  // the claude engine is a CLI spawn, not a chat provider; getActiveClient sends
  // unknown models to Ollama → HTTP 404 → degraded local fallback plans). The
  // reachable FRONTIER chat provider is NVIDIA NIM-hosted Kimi K2
  // (nvidia_nim_kimi: NVIDIA_NIM_API_KEY, OpenAI-compatible, defaults to
  // moonshotai/kimi-k2.6). Route planner+synthesis there under allowCloud so goal
  // milestones are frontier-planned. Flag-off (no allowCloud) keeps the local default.
  const client = await getActiveClient(
    cfg,
    allowCloud
      ? { allowCloud, provider: 'nvidia_nim_kimi' }
      : { allowCloud },
  );

  // -- Load or create RunState -------------------------------------------------
  let state: RunState;

  if (opts.resumeId) {
    const existing = loadRun(opts.resumeId);
    if (!existing) {
      throw new Error(`Run "${opts.resumeId}" not found in ${runsDir()}`);
    }
    // Already-complete run: do NOT redo work. Re-running synthesis would
    // double-count usage, append duplicate steps, and re-POST Pulse. Return the
    // loaded state unchanged so `--resume <id>` on a finished run is a no-op.
    if (existing.status === 'done' && existing.result) {
      process.stderr.write(
        `[ashlr run] run ${existing.id} is already complete — nothing to resume\n`,
      );
      return existing;
    }

    state = {
      ...existing,
      status: 'running',
      terminationReason: undefined,
      updatedAt: new Date().toISOString(),
    };
    inheritPersistenceSnapshot(existing, state);
    // Reset tasks that should re-run with the (presumably larger) new budget:
    //  - 'running': were mid-flight when the previous invocation stopped.
    //  - interruption failures: tasks marked by either cancellation or the
    //    legacy budget-abort sentinel. Genuine model failures are left as-is
    //    so we don't loop on a deterministically-failing task.
    for (const task of state.tasks) {
      if (
        task.status === 'running' ||
        (task.status === 'failed' &&
          (task.error === ABORT_TASK_ERROR || task.error === CANCELLED_TASK_ERROR))
      ) {
        task.status = 'pending';
        task.error = undefined;
      }
    }
    saveRun(state);
    process.stderr.write(`[ashlr run] resumed run ${state.id} (${state.tasks.length} tasks)\n`);
  } else {
    const id = opts.runId ?? generateRunId();
    const now = new Date().toISOString();
    state = {
      id,
      goal,
      engine,
      provider: client.id,
      createdAt: now,
      updatedAt: now,
      budget,
      usage: newUsage(),
      tasks: [],
      steps: [],
      status: 'running',
      ...(delegationScopeSummary ? { delegationScope: delegationScopeSummary } : {}),
    };
    saveRun(state);
  }

  const reserveRunModelStep = (
    taskId: string,
    kind: Extract<RunStep['kind'], 'plan' | 'model' | 'synthesize'>,
    summary: string,
    providerForCost: string,
  ): ModelStepReservation | undefined => {
    if (
      cancelled() ||
      state.usage.steps >= budget.maxSteps ||
      state.usage.tokensIn + state.usage.tokensOut >= budget.maxTokens
    ) {
      return undefined;
    }

    const step: RunStep = {
      ts: new Date().toISOString(),
      taskId,
      kind,
      summary,
      usage: { ...newUsage(), steps: 1 },
    };
    state.usage.steps += 1;
    state.steps.push(step);
    state.updatedAt = step.ts;
    saveRun(state);

    let finalized = false;
    return {
      finalize(finalSummary, usage) {
        if (finalized) return;
        finalized = true;
        const tokensIn = usage?.tokensIn ?? 0;
        const tokensOut = usage?.tokensOut ?? 0;
        state.usage.tokensIn += tokensIn;
        state.usage.tokensOut += tokensOut;
        state.usage.estCostUsd += estCostUsd(providerForCost, tokensIn, tokensOut);
        step.summary = finalSummary;
        step.usage = { tokensIn, tokensOut, steps: 1, estCostUsd: 0 };
        state.updatedAt = new Date().toISOString();
        cliOnStep?.(step, state.tasks);
        saveRun(state);
      },
    };
  };

  const taskStepAuthority = (taskId: string, providerForCost: string): ReserveModelStep =>
    () => reserveRunModelStep(taskId, 'model', 'Model call reserved.', providerForCost);

  const verificationClient = (base: ProviderClient, taskId: string): ProviderClient => ({
    id: base.id,
    supportsTools: base.supportsTools,
    ...(base.model ? { model: base.model } : {}),
    chat: async (messages, chatTools, signal) => {
      const reservation = reserveRunModelStep(
        taskId,
        'model',
        'Verification model call reserved.',
        base.id,
      );
      if (!reservation) throw new Error('Run step budget exhausted before model verification.');
      try {
        const result = await base.chat(messages, chatTools, signal ?? opts.signal);
        reservation.finalize('Verification model call complete.', result.usage);
        return result;
      } catch (err) {
        reservation.finalize(
          cancelled() ? 'Verification model call attempted and cancelled.' : 'Verification model call failed.',
          reportedModelUsage(err),
        );
        throw err;
      }
    },
  });

  // -- Tool wiring (optional) --------------------------------------------------
  // Default: spec-only gateway tools (exactly today's behavior). With
  // opts.engineer, the hub loop gets an EXECUTABLE, sandboxed surface: native
  // tools (with fn) + downstream specs + engineering tools (read/glob/grep +
  // sandboxed write/edit, and with allowBash also bash). All writes/exec are
  // confined to a throwaway git worktree; the captured diff is routed to the
  // approval inbox at the end — nothing reaches the live tree unapproved.
  let tools: unknown[] | undefined;
  let activeSandbox: Sandbox | null = null;
  let sandboxModule: typeof import('../sandbox/worktree.js') | null = null;
  let engCtx: EngineerContext | undefined;
  if (opts.tools !== false && client.supportsTools) {
    if (opts.engineer === true) {
      // M226: opts.cwd can arrive as a FILE path when a milestone names a file
      // (e.g. "src/core/goals/store.ts"). git worktree/-C requires a DIRECTORY,
      // so fall back to its dirname rather than crashing with "Not a directory".
      const sourceRepo = (() => {
        if (opts.cwd && path.isAbsolute(opts.cwd) && fs.existsSync(opts.cwd)) {
          try {
            return fs.statSync(opts.cwd).isDirectory()
              ? opts.cwd
              : path.dirname(opts.cwd);
          } catch {
            return process.cwd();
          }
        }
        return process.cwd();
      })();
      try {
        sandboxModule = await import('../sandbox/worktree.js');
        activeSandbox = sandboxModule.createSandbox(sourceRepo);
        engCtx = {
          workspaceRoot: activeSandbox.worktreePath,
          sourceRepo,
          allowWrite: true,
          allowExec: opts.allowBash === true,
        };
        const gateway = await loadGatewayTools(cfg).catch(() => [] as unknown[]);
        const nativeNames = new Set(listNativeTools().map((t) => t.name));
        const downstreamOnly = gateway.filter(
          (t) =>
            !nativeNames.has(
              (t as { function?: { name?: string } }).function?.name ?? '',
            ),
        );
        tools = [
          ...buildNativeToolSpecsWithFn(),
          ...downstreamOnly,
          ...buildEngineerToolSpecs(engCtx),
        ];
        process.stderr.write(
          `[ashlr run] --engineer: sandboxed tools active in ${activeSandbox.worktreePath}` +
            `${engCtx.allowExec ? ' (bash enabled)' : ''}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[ashlr run] --engineer unavailable (${msg}) — enroll the repo (ashlr enroll) ` +
            `and clear the kill switch; continuing with read-only gateway tools\n`,
        );
        activeSandbox = null;
        sandboxModule = null;
        engCtx = undefined;
        try {
          tools = await loadGatewayTools(cfg);
        } catch {
          tools = undefined;
        }
      }
    } else {
      try {
        tools = await loadGatewayTools(cfg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ashlr run] tool gateway unavailable (${msg}) — continuing tool-free\n`);
        tools = undefined;
      }
    }
  }

  // M42: capture the sandbox diff into the approval inbox + tear down. Idempotent
  // and best-effort — never throws, called on every runGoal exit path.
  const finalizeEngineer = (): void => {
    if (!activeSandbox || !sandboxModule) return;
    const sb = activeSandbox;
    const wt = sandboxModule;
    activeSandbox = null;
    try {
      if (opts.signal?.aborted || state.status === 'aborted' || state.terminationReason === 'cancelled') {
        return;
      }
      const diff = wt.sandboxDiff(sb);
      if (diff.files > 0 && diff.patch.trim().length > 0) {
        try {
          const proposalDelegationScope = summarizeDelegationScope(
            normalizeDelegationScope(
              {
                ...delegationScope,
                origin: delegationScope?.origin ?? 'run',
                sourceRepo: sb.sourceRepo,
                executionRoot: sb.worktreePath,
                runId: state.id,
                resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
              },
              { objective: goal, budget },
            ),
          );
          const proposal = selectInboxStore(cfg).create({
            repo: sb.sourceRepo,
            origin: 'agent',
            kind: 'patch',
            title: `engineer run: ${goal.slice(0, 80)}`,
            summary:
              `Sandboxed --engineer run produced ${diff.files} file(s) ` +
              `(+${diff.insertions}/-${diff.deletions}). Review before applying.`,
            diff: scrubSecrets(diff.patch),
            sandboxId: sb.id,
            workItemId: opts.workItemId,
            ...(opts.workItemGenerationId ? { workItemGenerationId: opts.workItemGenerationId } : {}),
            workSource: opts.workSource,
            runId: state.id,
            ...(proposalDelegationScope ? { delegationScope: proposalDelegationScope } : {}),
          });
          process.stderr.write(
            `[ashlr run] engineer diff → inbox proposal ${proposal.id} ` +
              `(${diff.files} files); review with 'ashlr inbox'\n`,
          );
        } catch (err) {
          process.stderr.write(`[ashlr run] could not file engineer proposal: ${String(err)}\n`);
        }
      }
    } catch {
      // diff capture best-effort
    } finally {
      try {
        wt.removeSandbox(sb);
      } catch {
        // removal is idempotent
      }
    }
  };

  // M42: guarantee sandbox teardown + diff capture on EVERY exit path, including
  // a throw from planning/synthesis. finalizeEngineer is idempotent and a no-op
  // when no sandbox is active, so this is safe for non-engineer runs too.
  try {
  // M41: resolve once — gates adaptive prompts for planning AND every task.
  const adaptivePrompts = adaptivePromptsEnabled(cfg);

  // -- M16/M7: Genome memory injection (best-effort, bounded, local-only) ------
  // M16: prefer a synthesized playbook over raw recall when playbookOnRun is on.
  // Falls back to the existing raw-recall block on any playbook failure.
  // Skipped when: noMemory is set, cfg disables injection, or this is a resume
  // with existing tasks (context was already embedded in those task goals).
  let memoryContext = '';
  const injectOnRun = cfg.genome?.injectOnRun ?? true;
  if (!noMemory && injectOnRun && state.tasks.length === 0) {
    // Only attempt playbook injection when genome is explicitly configured and
    // playbookOnRun is not disabled. When cfg.genome is absent there is nothing
    // to recall, and the playbook module makes local Ollama fetch calls even on
    // an empty recall — which would interfere with scripted fetch mocks in tests
    // and add unnecessary latency in unconfigured environments.
    const playbookOnRun = cfg.genome != null && cfg.genome.playbookOnRun !== false;
    let playbookInjected = false;

    if (playbookOnRun) {
      try {
        // Dynamic import: tolerates the module being absent (pre-M16 build).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pbMod = await import('../genome/playbook.js') as any;
        if (
          typeof pbMod.buildPlaybook === 'function' &&
          typeof pbMod.playbookText === 'function'
        ) {
          const playbook = await pbMod.buildPlaybook(goal, cfg);
          const pbText: string = pbMod.playbookText(playbook, GENOME_INJECT_CHAR_CAP);
          if (pbText && pbText.length > 0) {
            memoryContext = pbText;
            playbookInjected = true;
            process.stderr.write(
              `[ashlr run] genome: injecting ${memoryContext.length} chars of playbook context\n`,
            );
          }
        }
      } catch {
        // Playbook module absent or failed — fall through to raw recall below.
      }
    }

    if (!playbookInjected) {
      // M7 fallback: raw recall injection.
      memoryContext = await buildMemoryBlock(goal, cfg);
      if (memoryContext.length > 0) {
        process.stderr.write(
          `[ashlr run] genome: injecting ${memoryContext.length} chars of memory context\n`,
        );
      }
    }
  }

  let aborted = false;
  let cancelledAbort = false;

  // -- Plan (unless resuming with existing tasks) ------------------------------
  if (state.tasks.length === 0) {
    const planReservation = reserveRunModelStep(
      '__plan__',
      'plan',
      'Planning model call reserved.',
      client.id,
    );
    if (!planReservation) {
      aborted = true;
      cancelledAbort = cancelled();
    } else {
      let planTokensIn = 0;
      let planTokensOut = 0;
      const tasks = await planGoal(
        goal,
        client,
        (u) => {
          planTokensIn = u.tokensIn;
          planTokensOut = u.tokensOut;
        },
        memoryContext || undefined,
        adaptivePrompts,
        opts.signal,
      );
      state.tasks = tasks;
      planReservation.finalize(
        cancelled()
          ? 'Planning model call attempted and cancelled.'
          : `Planned ${tasks.length} task(s): ${tasks.map((t) => t.id).join(', ')}`,
        { tokensIn: planTokensIn, tokensOut: planTokensOut },
      );
      if (cancelled()) {
        aborted = true;
        cancelledAbort = true;
      }
    }
  }

  // -- DAG execution loop ------------------------------------------------------
  while (!allTerminal(state.tasks) && !aborted) {
    if (cancelled()) {
      aborted = true;
      cancelledAbort = true;
      break;
    }
    // Check global budget before picking next batch
    if (overBudget(state.usage, budget)) {
      aborted = true;
      break;
    }

    const ready = readyTasks(state.tasks);
    if (ready.length === 0) {
      // No ready tasks but not all terminal — means some tasks have deps on
      // failed/skipped tasks. Mark them skipped.
      const pendingBlocked = state.tasks.filter((t) => t.status === 'pending');
      if (pendingBlocked.length > 0) {
        for (const t of pendingBlocked) {
          t.status = 'skipped';
          t.error = 'Dependency failed or was skipped';
        }
        state.updatedAt = new Date().toISOString();
        saveRun(state);
      }
      break;
    }

    // Run up to `parallel` tasks concurrently
    const batch = ready.slice(0, parallel);

    // Mark them running before spawning
    for (const task of batch) {
      task.status = 'running';
    }
    state.updatedAt = new Date().toISOString();
    saveRun(state);

    if (cancelled()) {
      aborted = true;
      cancelledAbort = true;
      break;
    }

    // Run the batch in parallel; each task must not crash the whole run
    await Promise.all(
      batch.map(async (task) => {
        try {
          // M11: emit task-start event.
          emit(sink, { kind: 'task-start', taskId: task.id, text: task.goal });

          // M15: Choose route for this task (local-first; cloud only when
          // allowCloud + escalation reason + key present). Best-effort — falls
          // back to the run-level client when router is unavailable.
          //
          // M227: when allowCloud is true, bypass routeTask's escalation-reason
          // gate (which requires lastReason !== 'none' to pick a cloud route) and
          // build the frontier client directly — same provider selection as the
          // planner/synthesis client above (nvidia_nim_kimi, NVIDIA_NIM_API_KEY,
          // moonshotai/kimi-k2.6). routeTask with lastReason:'none' always returns
          // local because chooseRoute requires an escalation signal; this means
          // every per-task execution was hitting local-coder even when the user
          // explicitly opted in with allowCloud. Flag-off (no allowCloud) keeps
          // the prior routeTask path byte-identical — no change to local behavior.
          // Safety: engine:'builtin' is still forced in runner.ts; this only
          // affects which CHAT CLIENT is used inside the builtin agent loop.
          let taskClient: ProviderClient;
          let taskDecision: RouteDecision;
          if (allowCloud) {
            taskClient = await getActiveClient(cfg, { allowCloud: true, provider: 'nvidia_nim_kimi' });
            taskDecision = {
              provider: 'nvidia_nim_kimi',
              model: process.env['NVIDIA_NIM_MODEL'] ?? 'moonshotai/kimi-k2.6',
              tier: 'cloud',
              reason: 'allowCloud: frontier task execution (M227)',
            };
          } else {
            ({ client: taskClient, decision: taskDecision } = await routeTask(
              task.goal,
              cfg,
              { allowCloud: false, attempt: 1, lastReason: 'none' },
              client,
            ));
          }

          emit(sink, {
            kind: 'log',
            taskId: task.id,
            text: `route: ${taskDecision.provider}/${taskDecision.model} [${taskDecision.tier}] — ${taskDecision.reason}`,
          });

          // Build per-task onStep callback (single-writer invariant preserved).
          // M15: cost attribution uses the provider that actually served EACH step.
          // We ACCUMULATE cost incrementally (+= this step's tokens priced at this
          // step's provider) rather than recomputing estCostUsd over the cumulative
          // run-wide totals at the current provider. Recomputing-from-cumulative is
          // wrong for mixed local+cloud runs: it would re-price an earlier local
          // task's tokens at a later cloud escalation's rates (over-charging), or
          // re-price an earlier cloud task's tokens at $0 when a later step is local
          // (erasing real spend). Incremental accumulation keeps local steps at $0
          // regardless of any later cloud escalation, and prices cloud escalations
          // on only the tokens they served.
          const makeTaskOnStep = (providerForCost: string) => (step: RunStep): void => {
            state.steps.push(step);
            // SINGLE-WRITER INVARIANT: orchestrator is the only mutator of state.usage.
            if (step.usage) {
              state.usage.tokensIn += step.usage.tokensIn;
              state.usage.tokensOut += step.usage.tokensOut;
              state.usage.steps += step.usage.steps;
              state.usage.estCostUsd += estCostUsd(
                providerForCost,
                step.usage.tokensIn,
                step.usage.tokensOut,
              );
            }
            state.updatedAt = new Date().toISOString();
            cliOnStep?.(step, state.tasks);
            saveRun(state);
          };

          let taskOnStep = makeTaskOnStep(taskDecision.provider);

          // M11: Retry policy — bounded, budget-aware.
          // We retry on transient/tool failures only; hard budget stops are not retryable.
          const RETRY_POLICY = { maxAttempts: 2, baseDelayMs: 500 };

          const isRetryable = (err: unknown): boolean => {
            if (cancelled()) return false;
            // Don't retry if budget is already exhausted.
            if (overBudget(state.usage, budget)) return false;
            // Retry on network/transient errors (not on deterministic task failures).
            if (err instanceof Error) {
              const msg = err.message.toLowerCase();
              return (
                msg.includes('network') ||
                msg.includes('timeout') ||
                msg.includes('econnrefused') ||
                msg.includes('fetch') ||
                msg.includes('socket')
              );
            }
            return false;
          };

          await withRetry(
            async (attempt) => {
              if (attempt > 1) {
                emit(sink, {
                  kind: 'retry',
                  taskId: task.id,
                  text: `attempt ${attempt} of ${RETRY_POLICY.maxAttempts}`,
                });
                // Reset task state for re-run on retry.
                task.status = 'running';
                task.result = undefined;
                task.error = undefined;
              }

              // M20: bounded self-heal for OOM/rate-limit on model calls.
              // Opt-out: ASHLR_NO_HEAL skips the wrapper entirely.
              const noHeal = process.env['ASHLR_NO_HEAL'] === '1';

              const runWithHeal = async (healAttempt: number): Promise<void> => {
                // On heal attempt > 1 with a 'model-downgrade' event the client
                // was already logged via onHeal; chooseRoute will pick a smaller
                // model on the next routeTask call if the outer attempt increments,
                // so we just re-run with the current client here (the heal retry
                // is bounded by policy.maxRestarts and stays fully local).
                if (healAttempt > 1) {
                  // Re-route to a smaller local model for the downgrade attempt.
                  // Best-effort: fall back to existing taskClient on any error.
                  try {
                    const { client: smallerClient } = await routeTask(
                      task.goal,
                      cfg,
                      { allowCloud: false, attempt: healAttempt, lastReason: 'none' },
                      taskClient,
                    );
                    task.status = 'running';
                    task.result = undefined;
                    task.error = undefined;
                    await runTask(task, smallerClient, {
                      tools,
                      budget,
                      usage: state.usage,
                      sink,
                      adaptivePrompts,
                      onStep: makeTaskOnStep(smallerClient.id),
                      reserveModelStep: taskStepAuthority(task.id, smallerClient.id),
                      ...(opts.signal ? { signal: opts.signal } : {}),
                    });
                    return;
                  } catch {
                    // Fall through to original client below.
                  }
                }

                await runTask(task, taskClient, {
                  tools,
                  budget,
                  usage: state.usage,
                  sink,
                  adaptivePrompts,
                  onStep: taskOnStep,
                  reserveModelStep: taskStepAuthority(task.id, taskClient.id),
                  ...(opts.signal ? { signal: opts.signal } : {}),
                });
              };

              if (noHeal) {
                await runTask(task, taskClient, {
                  tools,
                  budget,
                  usage: state.usage,
                  sink,
                  adaptivePrompts,
                  onStep: taskOnStep,
                  reserveModelStep: taskStepAuthority(task.id, taskClient.id),
                  ...(opts.signal ? { signal: opts.signal } : {}),
                });
              } else {
                const healPolicy = defaultHealPolicy();
                await withHeal(
                  runWithHeal,
                  healPolicy,
                  (event: HealEvent) => {
                    emit(sink, {
                      kind: 'log',
                      taskId: task.id,
                      text: `[self-heal] ${event.kind} attempt ${event.attempt}: ${event.detail}`,
                    });
                    process.stderr.write(
                      `[ashlr run] self-heal(${event.kind}) task ${task.id} attempt ${event.attempt}: ${event.detail}\n`,
                    );
                  },
                  allowCloud,
                ).catch((healErr: unknown) => {
                  // withHeal exhausted — re-throw so the outer withRetry sees it.
                  throw healErr;
                });
              }

              // If runTask set status to failed, surface as a throw so withRetry
              // can decide whether to retry (only on retryable errors).
              if (task.status === 'failed') {
                const errMsg = task.error ?? 'task failed';
                // Only transient errors get retried; model/parsing errors do not.
                // We check if the error looks retryable before throwing.
                if (isRetryable(new Error(errMsg))) {
                  throw new Error(errMsg);
                }
                // Non-retryable failure: don't throw (withRetry would still catch
                // and re-throw since isRetryable returns false). Fall through.
              }
            },
            RETRY_POLICY,
            isRetryable,
          ).catch((err) => {
            // withRetry exhausted all attempts or got a non-retryable error.
            // task.status is already 'failed' (set by runTask); just ensure error is set.
            if (task.status !== 'failed') {
              task.status = 'failed';
              task.error = err instanceof Error ? err.message : String(err);
            }
          });

          // M15: On task failure, attempt ONE escalated routed retry.
          // Escalation is gated by: allowCloud AND escalate.onFailure AND !overBudget.
          // chooseRoute enforces the additional cloud-key check; if it returns a
          // local route again (key absent, allowCloud false, etc.) we just stay local.
          if (
            task.status === 'failed' &&
            !cancelled() &&
            allowCloud &&
            (cfg.models.escalate?.onFailure ?? false) &&
            !overBudget(state.usage, budget)
          ) {
            const { client: escalatedClient, decision: escalatedDecision } = await routeTask(
              task.goal,
              cfg,
              { allowCloud, attempt: 2, lastReason: 'task-failed' },
              client,
            );

            // Only actually escalate if chooseRoute returned a DIFFERENT (cloud)
            // route AND buildRoutedClient was able to construct a client for that
            // cloud provider. If the cloud client could not be built (key absent,
            // cloud completions unimplemented), buildRoutedClient falls back to a
            // LOCAL client whose .id is the local provider — in that case we must
            // NOT print "escalating to cloud" or charge cloud rates. Cost is
            // attributed by the ACTUAL client.id, never the intended provider.
            const cloudEscalated =
              escalatedDecision.tier === 'cloud' &&
              escalatedClient.id === escalatedDecision.provider;
            if (cloudEscalated) {
              emit(sink, {
                kind: 'retry',
                taskId: task.id,
                text: `escalating to cloud: ${escalatedDecision.provider}/${escalatedDecision.model} — ${escalatedDecision.reason}`,
              });

              task.status = 'running';
              task.result = undefined;
              task.error = undefined;

              // Attribute cost to the ACTUAL serving client (cloud here).
              taskOnStep = makeTaskOnStep(escalatedClient.id);

              await runTask(task, escalatedClient, {
                tools,
                budget,
                usage: state.usage,
                sink,
                adaptivePrompts,
                onStep: taskOnStep,
                reserveModelStep: taskStepAuthority(task.id, escalatedClient.id),
                ...(opts.signal ? { signal: opts.signal } : {}),
              }).catch((err) => {
                if (task.status !== 'failed') {
                  task.status = 'failed';
                  task.error = err instanceof Error ? err.message : String(err);
                }
              });
            }
            // If escalation could not reach cloud (still local / cloud client
            // unbuildable), leave task.status as 'failed' — no further action,
            // no misleading cloud event, no cloud cost.
          }

          // M11/M43: structured verify + bounded verify→repair loop. Skip once
          // over budget (a budget abort can annotate a 'done' result the
          // heuristic would flag as a false-positive fail).
          if (task.status === 'done' && !cancelled() && !overBudget(state.usage, budget)) {
            const maxRepairs = Math.max(0, opts.maxRepairs ?? (engCtx?.allowExec ? 2 : 1)); // flag-off parity: plain run = 1 retry; engineer runs get up to 2 bounded repairs
            // Single source for the verify options (avoids drift between the
            // initial verify and the in-loop re-verify).
            const verifyOpts = {
              model: verifyModel,
              workspaceRoot: engCtx?.workspaceRoot,
              allowExec: engCtx?.allowExec ?? false,
              cfg,
              ...(opts.signal ? { signal: opts.signal } : {}),
            };
            let verifyClient = taskClient;
            let verdict = await verifyTaskStructured(
              task,
              verificationClient(verifyClient, task.id),
              budget,
              { ...state.usage },
              verifyOpts,
            );
            emit(sink, { kind: 'verify', taskId: task.id, text: verdict.reason, data: verdict });

            let repair = 0;
            while (!verdict.ok && repair < maxRepairs && !cancelled() && !overBudget(state.usage, budget)) {
              repair++;
              // M15: verify-failed escalation — may return a cloud route when
              // allowCloud + escalate.onFailure + key present; otherwise local.
              const { client: retryClient, decision: retryDecision } = await routeTask(
                task.goal,
                cfg,
                { allowCloud, attempt: repair + 1, lastReason: 'verify-failed' },
                taskClient,
              );
              const escalatingToCloud =
                retryDecision.tier === 'cloud' && retryClient.id === retryDecision.provider;
              verifyClient = retryClient;

              emit(sink, {
                kind: 'retry',
                taskId: task.id,
                text: escalatingToCloud
                  ? `verify failed (${verdict.reason}) — cloud repair ${repair}/${maxRepairs}: ${retryDecision.provider}`
                  : `verify failed (${verdict.reason}) — repair ${repair}/${maxRepairs}`,
              });

              // Feed the concrete failure back to the same task (shared id keeps
              // persistence/onStep stable; the canonical goal stays in state).
              const repairGoal =
                `${task.goal}\n\n[VERIFY FAILED — repair ${repair}/${maxRepairs}]\n` +
                (verdict.command ? `Command: ${verdict.command}\n` : '') +
                (verdict.failure ? `Output:\n${verdict.failure}` : verdict.reason);
              const repairTask: RunTask = { ...task, goal: repairGoal };
              task.status = 'running';
              task.result = undefined;
              task.error = undefined;

              await runTask(repairTask, retryClient, {
                tools,
                budget,
                usage: state.usage,
                sink,
                adaptivePrompts,
                onStep: makeTaskOnStep(retryClient.id),
                reserveModelStep: taskStepAuthority(task.id, retryClient.id),
                ...(opts.signal ? { signal: opts.signal } : {}),
              });
              // Copy the execution outcome back onto the canonical task.
              task.status = repairTask.status;
              task.result = repairTask.result;
              task.error = repairTask.error;
              task.usage = repairTask.usage;

              if ((task.status as string) !== 'done') break;

              verdict = await verifyTaskStructured(
                task,
                verificationClient(verifyClient, task.id),
                budget,
                { ...state.usage },
                verifyOpts,
              );
              emit(sink, { kind: 'verify', taskId: task.id, text: verdict.reason, data: verdict });
            }

            if (!verdict.ok && (task.status as string) === 'done') {
              // Still failing (or budget exhausted): annotate but keep 'done'.
              task.result = `[needs-attention: ${verdict.reason}]\n${task.result ?? ''}`;
            }

            // M171: headless browser verification — fold render+console-error
            // evidence into the verify outcome for web repos.
            // repoRoot: the source repo on disk (not the sandbox worktree). The
            // engineer sandbox's sourceRepo is opts.cwd when set and valid, else cwd.
            const repoRoot: string =
              opts.cwd && path.isAbsolute(opts.cwd) && fs.existsSync(opts.cwd)
                ? opts.cwd
                : process.cwd();
            //
            // Guard: only when cfg.foundry?.browserVerify === true AND the repo
            // looks like a web app. When the flag is off (default) or the repo
            // is not a web app this block is completely skipped — byte-identical
            // to pre-M171 behaviour.
            //
            // Outcomes:
            //   skipped (no driver / not-web) → NEUTRAL; verdict unchanged.
            //   renderOk===false OR consoleErrors>0 → mark task needs-attention.
            //   clean pass → append screenshot + console-error evidence to result
            //                so the judge sees the proof.
            if (
              !cancelled() &&
              (cfg.foundry as { browserVerify?: boolean } | undefined)?.browserVerify === true &&
              isWebApp(repoRoot)
            ) {
              const bvResult = await verifyInBrowser(
                repoRoot,
                cfg,
                opts.signal ? { signal: opts.signal } : undefined,
              );
              if (bvResult.aborted || cancelled()) return;
              const folded = foldBrowserVerify(task.result, bvResult);

              if (folded !== null) {
                // Non-neutral outcome — update task.result and emit a log event.
                const isFail = !bvResult.renderOk || bvResult.consoleErrors.length > 0;
                task.result = folded;
                emit(sink, {
                  kind: 'log',
                  taskId: task.id,
                  text: isFail
                    ? `[M171] browser verify FAIL — ${bvResult.consoleErrors.length > 0 ? `${bvResult.consoleErrors.length} console error(s)` : 'render failed'}`
                    : `[M171] browser verify PASS — ${bvResult.detail}`,
                });
              }
              // skipped (folded===null) → neutral; no annotation, no emit.
            }
          }

          // M15: latency-threshold escalation (cfg.models.escalate?.latencyMs).
          // Latency is tracked by checking whether the task took longer than
          // the configured threshold. We use task.usage.steps as a proxy:
          // if the task completed but the run-level elapsed since task-start
          // is not directly available here, we record the threshold check as
          // informational only — the latency escalation path is a stub that
          // emits a log event when cfg.models.escalate.latencyMs is set and
          // the task usage steps are unusually high (>= TASK_STEP_CAP / 2).
          // Full wall-clock latency tracking can be wired in a follow-up.
          if (
            task.status === 'done' &&
            allowCloud &&
            cfg.models.escalate?.latencyMs !== undefined &&
            (task.usage?.steps ?? 0) >= 10 // heuristic: many steps → slow task
          ) {
            emit(sink, {
              kind: 'log',
              taskId: task.id,
              text: `[M15] task completed with ${task.usage?.steps ?? 0} steps; latency threshold ${cfg.models.escalate.latencyMs}ms configured (cloud escalation on latency available when re-running with --allow-cloud)`,
            });
          }

          // M11: emit task-done (or failed) event.
          if (task.status === 'done') {
            emit(sink, { kind: 'task-done', taskId: task.id, text: task.goal });
          } else {
            emit(sink, {
              kind: 'log',
              taskId: task.id,
              text: `task ${task.id} ${task.status}: ${task.error ?? ''}`,
            });
          }
        } catch (err) {
          // Defensive: runTask should handle its own errors, but catch any leak
          const msg = err instanceof Error ? err.message : String(err);
          task.status = 'failed';
          task.error = `Unexpected orchestrator error: ${msg}`;
          process.stderr.write(`[ashlr run] task ${task.id} crashed unexpectedly: ${msg}\n`);
        }
      }),
    );

    state.updatedAt = new Date().toISOString();
    saveRun(state);

    if (cancelled()) {
      aborted = true;
      cancelledAbort = true;
    } else if (overBudget(state.usage, budget)) {
      aborted = true;
    }
    if (aborted) break;
  }

  // -- Abort: mark remaining pending/running tasks as aborted ------------------
  if (aborted) {
    for (const task of state.tasks) {
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'failed';
        task.error = cancelledAbort ? CANCELLED_TASK_ERROR : ABORT_TASK_ERROR;
      }
    }
    state.status = 'aborted';
    if (cancelledAbort) {
      state.result = 'Run cancelled.';
      state.terminationReason = 'cancelled';
    }
    state.updatedAt = new Date().toISOString();
    saveRun(state);

    // M19: Emit telemetry (best-effort, opt-in). Awaited so the local sink is
    // flushed before the process exits; bounded + fully caught, never throws.
    await fireEmitRun(state, cfg);

    // M16: Auto-capture on abort path (fire-and-forget).
    const noCaptureAbort = (opts as RunOptions & { noCapture?: boolean }).noCapture === true;
    if (!noCaptureAbort && !cancelledAbort) {
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const capMod = await import('../genome/capture.js') as any;
          if (typeof capMod.captureFromRun === 'function') {
            capMod.captureFromRun(state, cfg);
          }
        } catch {
          // Never surface capture errors to the caller.
        }
      })();
    }

    return state;
  }

  // -- Synthesize final answer -------------------------------------------------
  const doneTasks = state.tasks.filter((t) => t.status === 'done' && t.result);
  let synthResult: string;
  const synthReservation = doneTasks.length > 0
    ? reserveRunModelStep(
        '__synthesize__',
        'synthesize',
        'Synthesis model call reserved.',
        client.id,
      )
    : undefined;
  if (!synthReservation) {
    synthResult =
      doneTasks.length > 0
        ? doneTasks.map((t) => `[${t.id}] ${t.result ?? ''}`).join('\n')
        : 'No tasks completed successfully — no result to synthesize.';
    if (doneTasks.length > 0) {
      process.stderr.write(
        `[ashlr run] budget reached — skipping model synthesis, using concatenated task results\n`,
      );
    }
  } else {
    const synth = await synthesize(goal, state.tasks, client, opts.signal);
    synthResult = synth.content;
    synthReservation.finalize(
      synth.failed
        ? cancelled()
          ? 'Synthesis model call attempted and cancelled.'
          : 'Synthesis model call failed; used concatenated fallback.'
        : 'Synthesis complete',
      synth.usage,
    );
  }

  if (cancelled()) {
    for (const task of state.tasks) {
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'failed';
        task.error = CANCELLED_TASK_ERROR;
      }
    }
    state.status = 'aborted';
    state.result = 'Run cancelled.';
    state.terminationReason = 'cancelled';
    state.updatedAt = new Date().toISOString();
    saveRun(state);
    await fireEmitRun(state, cfg);
    return state;
  }

  state.result = synthResult;

  // Determine final status
  const failedCount = state.tasks.filter((t) => t.status === 'failed').length;
  state.status = failedCount === state.tasks.length ? 'failed' : 'done';
  state.updatedAt = new Date().toISOString();
  saveRun(state);

  // -- M19: Emit telemetry (best-effort, opt-in) ------------------------------
  // Awaited so the local sink is flushed before the process exits; bounded +
  // fully caught, never throws.
  await fireEmitRun(state, cfg);

  // -- M16: Auto-capture (fire-and-forget, never throws, never blocks) ---------
  // Read noCapture via extended property (same pattern as noMemory above).
  const noCapture = (opts as RunOptions & { noCapture?: boolean }).noCapture === true;
  if (!noCapture) {
    // Wrap in void + try to guarantee fire-and-forget with zero blocking.
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capMod = await import('../genome/capture.js') as any;
        if (typeof capMod.captureFromRun === 'function') {
          capMod.captureFromRun(state, cfg);
        }
      } catch {
        // Never surface capture errors to the caller.
      }
    })();
  }

  return state;
  } finally {
    finalizeEngineer();
  }
}

// ---------------------------------------------------------------------------
// Gateway tool loading (optional)
// ---------------------------------------------------------------------------

/**
 * Attempt to load aggregated tools from the MCP gateway as a client.
 * Returns the tool list (OpenAI-style tool specs) or throws on failure.
 * Used only when opts.tools !== false AND client.supportsTools.
 */
async function loadGatewayTools(cfg: AshlrConfig): Promise<unknown[]> {
  // Lazy-import MCP SDK to keep startup fast when tools are disabled
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  // Resolve the ashlr binary path from the config tools map, or fall back to PATH
  const ashlrBin = cfg.tools?.['ashlr'] ?? 'ashlr';

  const transport = new StdioClientTransport({
    command: ashlrBin,
    args: ['mcp'],
    stderr: 'ignore',
  });

  const mcpClient = new Client(
    { name: 'ashlr-orchestrator', version: '0.1.0' },
    { capabilities: {} },
  );

  // Connect with a 10s timeout
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    await mcpClient.connect(transport);
    clearTimeout(timer);

    const listed = await mcpClient.listTools({}, { timeout: 10_000 });

    // Convert MCP tool specs to OpenAI-style function specs for the provider
    const tools = (listed.tools ?? []).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? t.name,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
    }));

    // Close client after fetching — tools are passed as static specs to the model
    try { await mcpClient.close(); } catch { /* ignore */ }

    return tools;
  } catch (err) {
    clearTimeout(timer);
    try { await mcpClient.close(); } catch { /* ignore */ }
    throw err;
  }
}
