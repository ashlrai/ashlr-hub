/**
 * Live tick hooks — V3.10 Track B unit U5 (SPEC-310B §3; contract:
 * daemon/tick-hooks.ts).
 *
 * The TickHooks a resident daemon runs with while a STANDING SESSION is open
 * (runDaemon installs them after `openStandingSession` succeeds; every other
 * run keeps DEFAULT_TICK_HOOKS, i.e. master's tick). What they add:
 *
 *   effectiveConfig — the grant's overlay (authority/effective-config.ts
 *                     `applyStandingOverlay`), then every dispatch forced
 *                     through the standing router: the M247 gateway and the
 *                     M255 concurrent planner are switched off, because they
 *                     route around `hooks.route` / `hooks.seatAllows`.
 *   beforeTick      — once per tick, all the I/O the synchronous hooks need:
 *                     the standing policy, repo holds, the authority ledger
 *                     (open PRs, rejects, reverts), backpressure, presence,
 *                     the local runtime, the Leader's lane directives, the
 *                     budget clamped to the grant, the post-merge watch pass,
 *                     parked-task release and insight ingestion. Returns the
 *                     paused repos, lane caps and any production hold.
 *   route           — fleet/dispatch-router.ts over that context.
 *   seatAllows      — the lane must be in the grant and open, the seat(s)
 *                     behind it must have headroom under the clamped budget,
 *                     and subscription engines still pass master's
 *                     `subscriptionAllows` (the hooks only ever TIGHTEN).
 *   afterDispatch   — the runtime journal ("why this seat", parked items),
 *                     and the fleet task's status.
 *   afterLanding    — the journal, and the post-merge watch registration.
 *
 * Cross-unit wiring added at integration (3.10 B+C, INT1):
 *   - U6 mirrors: every tick syncs the stage's mirrors first (a mirror that
 *     is not current pauses its repo) and reconciles autonomous enrollment
 *     to exactly the grant's repo list when the plan is non-empty.
 *   - U4 holds: expired holds are swept (throttled); a hold store that cannot
 *     be read still fails closed.
 *   - B-U8 Leader: `leaderTick` runs each tick (bounded; a due memo runs in
 *     the background) BEFORE the directives are read, and the directives are
 *     clamped by the grant (`clampLeaderDirectives`).
 *   - B-U9 harness: the canary is checked every tick, the active harness is
 *     read once per tick (its producer prompt reaches dispatch through
 *     `dispatchHarness`, its version is journaled with each dispatch so a G3
 *     verdict credits the right version), queued experiments run in idle or
 *     overnight windows, and its routing weights (Leader › harness ›
 *     BASELINE_HARNESS_CONFIG.routing) set the best-of-N threshold and
 *     tilt the dispatch router's seat ranking.
 *   - U7 engines: `bestOfNPlan` = planAutonomousBestOfN over this tick's
 *     lanes; the grant's engines filter `allowedBackends` (nim, kimi and the
 *     per-token xAI API never reach a standing tick).
 *   - B-U1: the ledger head is read per tick and a throw (a broken chain)
 *     holds production; seats resolve through `standingSeatFor`.
 *   - U3 (R3b): a beforeTick that observes KILL revokes every ARMED host
 *     merge (`revokeArmedMerges`), once per KILL episode (retried while a
 *     revocation reports failures) — see `revokeMergesOnKill` below.
 *
 * FAIL CLOSED everywhere: a context that is missing (beforeTick did not run or
 * failed) holds every item; an unreadable source holds production with a
 * sentence naming it. Nothing here raises authority — the grant, the gates
 * and the ledger are other units'; this module only decides what runs WITHIN
 * them, and when.
 *
 * Every dependency is injectable (`LiveHooksDeps`) so the whole tick can be
 * exercised in a HOME-isolated test with no seat, no GitHub and no model.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AshlrConfig, EngineId, EngineTier, WorkItem } from '../types.js';
import type { DaemonActivationCapability } from '../daemon/activation-permit.js';
import type { MintStandingTickResult, StandingSession } from '../authority/capability.js';
import type {
  BeforeTickResult,
  SeatAllowsOptions,
  TickHookContext,
  TickHooks,
  TickRouteDecision,
} from '../daemon/tick-hooks.js';
import type {
  EffectivePolicy,
  LedgerEntry,
  LedgerHead,
  LedgerReadOptions,
  LedgerReadResult,
} from '../authority/types.js';
import { applyStandingOverlay, clampBudgetPolicy, currentStandingPolicy, standingSeatFor } from '../authority/effective-config.js';
import { revokeArmedMerges, type MergeRevocationOutcome } from '../authority/clamp.js';
import { currentLedgerHead, readLedger } from '../authority/ledger.js';
import { loadBudgetPolicy, readCapacitySnapshot, recordShadowDecision, type CapacitySnapshot } from '../routing/budget-store.js';
import { assessSeat, type SeatCapacity } from '../routing/headroom.js';
import { effectiveSeatPolicy } from '../routing/policy.js';
import type { BudgetPolicy } from '../routing/types.js';
import type { ReasoningInsight } from '../reasoning/types.js';
import type { LeaderDirectivesV1 } from '../vision/leader-types.js';
import type { HarnessConfigV1 } from '../learn/harness-types.js';
import {
  BASELINE_HARNESS_CONFIG,
  BASELINE_VERSION_ID,
  activeHarness,
  checkHarnessCanary,
  recordHarnessOutcome,
} from '../learn/harness-registry.js';
import type { AutonomousBestOfNPlan } from '../run/best-of-n-policy.js';
import type { MirrorTickPreparation } from './mirrors.js';
import { overnightRunInProgress } from '../daemon/overnight-status.js';
import { readLeaderDirectives } from '../vision/leader-apply.js';
import { killSwitchOn, listEnrolled } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { scrubSecrets } from '../util/scrub.js';
import { LOCAL_FLEET_ENGINE, localFleetEnabled } from '../daemon/local-fleet.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import { engineInstalled } from '../run/engines.js';
import { routeBackend, type RouteDecision } from './router.js';
import { subscriptionAllows, isSubscriptionEngine, type SubscriptionAllowResult } from './subscription-usage.js';
import { listRepoHolds, setRepoHold, sweepExpiredRepoHolds } from './quarantine.js';
import {
  advancePostMergeWatches,
  registerLanding,
  type PostMergeWatchPassResult,
  type RegisterLandingResult,
} from './post-merge-watch.js';
import {
  DEFAULT_LOCAL_CONTEXT_TOKENS,
  FLEET_LOCAL_SEAT_ID,
  PRESENCE_WINDOW_MS,
  anyFanoutCandidate,
  clampLeaderDirectives,
  fleetLaneOf,
  laneOfSeat,
  laneStates,
  planLanes,
  planFanoutReserve,
  planStandingBestOfN,
  resolveLaneEngines,
  resolveRoutingWeights,
  routingRequestFor,
  routeWorkItem,
  type DispatchRoute,
  type DispatchRouterContext,
  type LanePlan,
  type OperatorPresence,
  type RouteDemotion,
} from './dispatch-router.js';
import type { HarnessRoutingWeights } from '../learn/harness-types.js';
import {
  awaitsVerification,
  emptyBackpressureState,
  evaluateBackpressure,
  fleetPrKey,
  loadBackpressureState,
  openFleetPrRefsFromLedger,
  outcomeEventsFromLedger,
  prStateFromMergeState,
  reconcileOpenFleetPrs,
  saveBackpressureState,
  type BackpressureStateV1,
  type ObservedPrState,
  type OpenFleetPrRef,
  type OutcomeEvent,
} from './backpressure.js';
import {
  enqueueInsightTasks,
  fleetTaskIdOfItem,
  fleetTaskWorkItems,
  mergeFleetTaskItems,
  readTaskQueue,
  recordTaskDispatch,
  releaseParkedTasks,
  type TaskDispatchUpdate,
  type TaskQueueRead,
} from './task-source.js';
import {
  appendJournal,
  proposalHarnessIndex,
  proposalRouteIndex,
  readJournalSince,
  writeTickState,
  type FleetJournalRecord,
  type FleetTickStateV1,
  type HeldItemRecord,
} from './fleet-runtime-journal.js';
import { repoIdentityOfPath, resolveRepoLabel } from './repo-identity.js';
import { FLEET_ENGINES, type DispatchOutcome, type FleetEngine, type LandingRecord, type RepoHold, type RepoHoldChange, type SetRepoHoldRequest } from './fleet-types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface LocalRuntimeReading {
  /** Can a local agent run at all? null = unknown. */
  reachable: boolean | null;
  /** Serving slots (llama-server), null when unknown / not a slotted runtime. */
  slots: number | null;
  /** Context tokens of ONE slot; null when unknown. */
  contextPerSlot: number | null;
  detail: string;
}

/** What reconciling autonomous enrollment (U6) did this tick. */
export interface EnrollmentReconcile {
  /** false ⇒ the plan was empty and nothing was touched. */
  changed: boolean;
  enrolled: string[];
  unenrolled: string[];
  /** Per-path failures, scrubbed sentences. */
  errors: string[];
}

/** The harness version dispatch runs with this tick (B-U9). */
export interface TickHarness {
  /** null = the compiled baseline (no version adopted). */
  versionId: string | null;
  config: HarnessConfigV1;
}

export interface LiveHooksDeps {
  now(): number;
  standingPolicy(): EffectivePolicy | null;
  applyOverlay(cfg: AshlrConfig, policy: EffectivePolicy): AshlrConfig;
  /**
   * The A9 policy clamped to the grant. `knownSeatIds` = every seat this tick
   * routes over: B-U1's clamp only reaches seats stored in the policy, named
   * in the grant, or passed here, so an unnamed seat would otherwise keep its
   * mode default (the router's grant check still refuses it — this keeps the
   * "why this seat" record honest too).
   */
  clampBudget(policy: BudgetPolicy, standing: Pick<EffectivePolicy, 'spend'>, knownSeatIds: readonly string[]): BudgetPolicy;
  loadBudget(): BudgetPolicy;
  capacitySnapshot(): CapacitySnapshot | null;
  probeLocalRuntime(cfg: AshlrConfig, snapshot: CapacitySnapshot | null): Promise<LocalRuntimeReading>;
  presence(nowMs: number): Promise<OperatorPresence>;
  directives(): LeaderDirectivesV1 | null;
  listHolds(nowMs: number): RepoHold[];
  setHold(req: SetRepoHoldRequest): RepoHoldChange;
  readLedger(opts: LedgerReadOptions): Promise<LedgerReadResult>;
  ledgerHead(): LedgerHead | null;
  listEnrolled(): string[];
  repoIdentity(path: string): string | null;
  /** Proposals waiting for verification in the enrolled repos; null = unknown. */
  waitingVerify(enrolled: readonly string[]): Promise<number | null>;
  /**
   * Review c5: the observed state of fleet PRs the ledger says are open, keyed
   * by `fleetPrKey` — from the fleet's merge state (terminal there wins), else
   * GitHub (cached). A PR absent from the map, or null, is unknown.
   */
  observeFleetPrs(refs: readonly OpenFleetPrRef[], nowMs: number): Promise<Map<string, ObservedPrState>>;
  /**
   * F2 `recordReserveBreaches` (authority/reserve-breach.ts): compare fresh
   * capacity with the grant's seat floors and ledger any breach. Called once
   * per standing tick, after dispatch. Returns rows written.
   */
  recordReserveBreaches(input: { capacity: unknown; policy: EffectivePolicy; now?: Date; usedSeatIds?: readonly string[] }): Promise<number>;
  installed(engine: EngineId, cfg: AshlrConfig): boolean;
  tierOf(engine: EngineId, cfg: AshlrConfig): EngineTier | null;
  subscriptionAllows(engine: EngineId, opts: { maxPercent: number; autonomous: true }): SubscriptionAllowResult;
  isSubscriptionEngine(engine: EngineId): boolean;
  legacyRoute(item: WorkItem, cfg: AshlrConfig): RouteDecision;
  localFleetEngine(cfg: AshlrConfig): EngineId | null;
  readTasks(): TaskQueueRead;
  releaseTasks(nowMs: number): number;
  recordTask(taskId: string, update: TaskDispatchUpdate, nowMs: number): unknown;
  enqueueInsights(insights: readonly ReasoningInsight[], repoOf: (label: string) => string | null, nowMs: number): number;
  insights(): Promise<ReasoningInsight[]>;
  advanceWatch(signal?: AbortSignal): Promise<PostMergeWatchPassResult>;
  registerLanding(record: LandingRecord): RegisterLandingResult;
  writeTick(state: FleetTickStateV1): boolean;
  appendJournal(record: FleetJournalRecord): boolean;
  readJournalSince(sinceMs: number): Promise<FleetJournalRecord[]>;
  loadBackpressure(): BackpressureStateV1;
  saveBackpressure(state: BackpressureStateV1): void;
  shadow(input: Parameters<typeof recordShadowDecision>[0]): boolean;
  audit(entry: { action: string; repo: string | null; summary: string; result: 'ok' | 'refused' | 'error' }): void;
  /** U6 `prepareMirrorsForTick`: create / reset the stage's mirrors. */
  prepareMirrors(policy: EffectivePolicy): Promise<MirrorTickPreparation>;
  /** U6 `reconcileAutonomousEnrollment`, applied only when its plan is non-empty. */
  reconcileEnrollment(policy: EffectivePolicy, enrolled: readonly string[]): Promise<EnrollmentReconcile>;
  /** U4 `sweepExpiredRepoHolds`. */
  sweepHolds(nowMs: number): { swept: number; error: string | null };
  /** B-U8 `leaderTick(await loadDefaultLeaderRunDeps(cfg))`. */
  leaderTick(cfg: AshlrConfig): Promise<void>;
  /** B-U9 `activeHarness()` (baseline when none is adopted). */
  harness(): TickHarness;
  /** B-U9 `checkHarnessCanary()`. */
  checkCanary(nowMs: number): void;
  /** B-U9 `recordHarnessOutcome` — one verification verdict for one version. */
  recordHarnessOutcome(input: { passed: boolean; versionId: string | null; at: string }): boolean;
  /** B-U9 `runNextExperiment` — a one-line outcome, or null when nothing was queued; runs in the background. */
  runExperiment(opts: { fleetQueueDepth: () => number; signal: AbortSignal }): Promise<string | null>;
  /** Is an overnight window running (daemon/overnight-status.ts)? */
  overnightActive(): boolean;
  /** Is ~/.ashlr/KILL on? (sandbox/policy.ts `killSwitchOn`) */
  killActive(): boolean;
  /** authority/clamp.ts `revokeArmedMerges` — Stop's companion; never throws. */
  revokeArmedMerges(reason: string): Promise<MergeRevocationOutcome>;
}

/** How far back the ledger / journal are read for backpressure and route joins. */
export const LIVE_HOOKS_EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Insights are turned into tasks at most this often. */
export const INSIGHT_INGEST_INTERVAL_MS = 6 * 60 * 60_000;
/** Engine install probes (PATH / endpoint) are reused this long. */
const INSTALL_PROBE_TTL_MS = 60_000;
/** Presence is re-probed at most this often. */
const PRESENCE_TTL_MS = 60_000;
/** Expired repo holds are swept at most this often (the hold reads already ignore them). */
export const HOLD_SWEEP_INTERVAL_MS = 10 * 60_000;
/**
 * The Leader's tick is bounded: it applies due class-B actions and grades
 * moves inline, and STARTS a due memo in the background — but a wedged
 * source must not hold the fleet tick hostage.
 */
export const LEADER_TICK_TIMEOUT_MS = 15_000;
/** An idle / overnight tick asks the experiment queue at most this often. */
export const EXPERIMENT_POLL_INTERVAL_MS = 5 * 60_000;
/** In-memory dedupe of credited verification verdicts (the ledger read is seq-based; this only guards re-reads). */
const MAX_REMEMBERED_VERDICTS = 5_000;
/**
 * learn/experiments.ts EXPERIMENT_SLOTS (idle 2 / fleetBusy 1), restated so
 * this module does not load the experiment runner statically; a test pins
 * the two together.
 */
export const EXPERIMENT_LOCAL_SLOTS_IDLE = 2;
export const EXPERIMENT_LOCAL_SLOTS_BUSY = 1;

/** Resolve `promise`, or 'timeout' after `ms` (the promise keeps running). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout('timeout'), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const LEDGER_KINDS: LedgerReadOptions['kinds'] = [
  'merge:landed',
  'revert:landed',
  'gate:result',
  'gate:would-merge',
  'pr:opened',
  'pr:closed',
  'pr:reopened',
];

// ---------------------------------------------------------------------------
// Default (production) dependencies
// ---------------------------------------------------------------------------

async function probeLocalRuntimeDefault(cfg: AshlrConfig, snapshot: CapacitySnapshot | null): Promise<LocalRuntimeReading> {
  if (localFleetEnabled(cfg)) {
    try {
      const { probeLlamaRuntime } = await import('../local-runtime/llama/health.js');
      const reading = await probeLlamaRuntime({ timeoutMs: 1_500 });
      return {
        reachable: reading.state === 'up',
        slots: reading.slots.configured,
        contextPerSlot: reading.contextPerSlot,
        detail: `llama-server ${reading.state}${reading.slots.configured !== null ? ` with ${reading.slots.configured} slot(s)` : ''}`,
      };
    } catch {
      return { reachable: null, slots: null, contextPerSlot: null, detail: 'the local runtime probe failed' };
    }
  }
  // Ollama (local-coder / builtin): the Verse snapshot's local seats carry the
  // windows the operator's local models advertise. The smallest one binds.
  const windows = (snapshot?.seats ?? [])
    .filter((s) => s.engine === 'local' && typeof s.contextWindow === 'number')
    .map((s) => s.contextWindow as number);
  return {
    reachable: null,
    slots: null,
    contextPerSlot: windows.length > 0 ? Math.min(...windows) : null,
    detail: 'local models via Ollama (no slotted runtime)',
  };
}

/**
 * Presence (SPEC-310B §3): a live Verse turn, or a Claude Code transcript
 * modified in the last 15 minutes. Bounded walk with early exit; an error
 * while looking is "unknown" (treated as present), a clean look that finds
 * nothing is "absent".
 */
export async function probeOperatorPresence(nowMs: number, opts: { home?: string; maxEntries?: number } = {}): Promise<OperatorPresence> {
  const home = opts.home ?? homedir();
  const maxEntries = opts.maxEntries ?? 6_000;
  // 1. A live Verse turn.
  try {
    const raw = JSON.parse(await readFile(join(home, '.ashlr', 'verse', 'running.json'), 'utf8')) as { entries?: unknown };
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const kind = e['kind'] ?? 'turn';
      if (kind !== 'turn' || typeof e['pid'] !== 'number') continue;
      try {
        process.kill(e['pid'] as number, 0);
        return { present: true, reason: 'A Verse chat turn is running.', evidenceAt: new Date(nowMs).toISOString() };
      } catch {
        // That turn's process is gone.
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return { present: null, reason: 'The Verse turn registry could not be read.', evidenceAt: null };
    }
  }
  // 2. A fresh Claude Code transcript.
  const root = join(home, '.claude', 'projects');
  let visited = 0;
  let newest = 0;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > 5 || visited >= maxEntries) return false;
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0 && (err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw err;
    }
    // Recently touched directories first: an active session usually lives in one.
    const dirs: { path: string; mtime: number }[] = [];
    for (const entry of names) {
      if (++visited > maxEntries) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        try {
          dirs.push({ path, mtime: (await stat(path)).mtimeMs });
        } catch { /* vanished */ }
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const mtime = (await stat(path)).mtimeMs;
          newest = Math.max(newest, mtime);
          if (nowMs - mtime <= PRESENCE_WINDOW_MS) return true;
        } catch { /* vanished */ }
      }
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs) {
      if (await walk(d.path, depth + 1)) return true;
    }
    return false;
  };
  try {
    if (await walk(root, 0)) {
      return { present: true, reason: 'Claude Code was active in the last 15 minutes.', evidenceAt: new Date(nowMs).toISOString() };
    }
  } catch {
    return { present: null, reason: 'Claude Code activity could not be read.', evidenceAt: null };
  }
  if (visited >= maxEntries) {
    return { present: null, reason: 'Too many Claude Code transcripts to check within bounds.', evidenceAt: null };
  }
  return {
    present: false,
    reason: 'No live Verse turn and no Claude Code activity in the last 15 minutes.',
    evidenceAt: newest > 0 ? new Date(newest).toISOString() : null,
  };
}

/**
 * Review c1: only proposals the VERIFIER will actually reach count. A pending
 * proposal parked at G0 / G1 (owner lane) / G2 (over the stage caps), or one
 * with a fleet PR, is never verified while it sits there — counting it held
 * production for the whole fleet on work nothing would verify (see
 * backpressure.ts `awaitsVerification`).
 */
async function waitingVerifyDefault(enrolled: readonly string[]): Promise<number | null> {
  try {
    const { listProposalsDetailed } = await import('../inbox/store.js');
    const mergeState = await import('./fleet-merge-state.js');
    const read = listProposalsDetailed({ status: 'pending' });
    if (read.sourceState === 'degraded' || !read.complete) return null;
    const paths = new Set(enrolled.map((p) => resolve(p)));
    return read.proposals.filter((p) => {
      if (p.repo === null || !paths.has(resolve(p.repo)) || p.verifyResult !== undefined) return false;
      // No filename-safe key ⇒ the standing pass skips it, so it is never verified.
      const key = mergeState.proposalStateKey(p.id);
      return key !== null && awaitsVerification(mergeState.readFleetMergeState(key));
    }).length;
  } catch {
    return null;
  }
}

/** A GitHub PR-state read is reused this long (the merge pass itself re-polls owner-lane PRs every 10 min). */
export const PR_STATE_CACHE_TTL_MS = 10 * 60_000;
/** GitHub PR reads per tick at most (3 open per repo is the cap, so this is rarely binding). */
export const PR_STATE_READS_PER_TICK = 12;
/** One GitHub PR read never holds the tick longer than this. */
const PR_STATE_READ_TIMEOUT_MS = 10_000;
const MAX_PR_STATE_CACHE = 500;
const prStateCache = new Map<string, { atMs: number; state: Exclude<ObservedPrState, null> }>();

/**
 * Review c5 (production): terminal merge state first (the standing pass polls
 * GitHub and records a human merge / close there, but never ledgers it), then
 * GitHub through the fleet App client (host-merge `readPr`), cached. Unknown
 * stays null — `reconcileOpenFleetPrs` bounds how long that counts.
 */
async function observeFleetPrsDefault(refs: readonly OpenFleetPrRef[], nowMs: number): Promise<Map<string, ObservedPrState>> {
  const out = new Map<string, ObservedPrState>();
  if (refs.length === 0) return out;
  let mergeState: typeof import('./fleet-merge-state.js') | null = null;
  try {
    mergeState = await import('./fleet-merge-state.js');
  } catch {
    mergeState = null;
  }
  const ask: OpenFleetPrRef[] = [];
  for (const ref of refs) {
    const key = fleetPrKey(ref.repo, ref.number);
    let recorded: ObservedPrState = null;
    const stateKey = ref.proposalId && mergeState ? mergeState.proposalStateKey(ref.proposalId) : null;
    if (stateKey && mergeState) {
      try {
        recorded = prStateFromMergeState(mergeState.readFleetMergeState(stateKey), ref.number);
      } catch {
        recorded = null;
      }
    }
    if (recorded === 'closed' || recorded === 'merged') {
      out.set(key, recorded);
      continue;
    }
    const cached = prStateCache.get(key);
    if (cached && nowMs - cached.atMs < PR_STATE_CACHE_TTL_MS) {
      out.set(key, cached.state);
      continue;
    }
    out.set(key, recorded);
    ask.push(ref);
  }
  if (ask.length === 0) return out;
  let host: typeof import('./host-merge.js');
  let hostDeps: ReturnType<typeof host.defaultHostMergeDeps>;
  try {
    host = await import('./host-merge.js');
    hostDeps = host.defaultHostMergeDeps();
  } catch {
    return out;
  }
  await Promise.all(ask.slice(0, PR_STATE_READS_PER_TICK).map(async (ref) => {
    const key = fleetPrKey(ref.repo, ref.number);
    try {
      const live = await withTimeout(host.readPr(ref.repo, ref.number, hostDeps), PR_STATE_READ_TIMEOUT_MS);
      if (live === 'timeout' || typeof live === 'string') return;
      const state: Exclude<ObservedPrState, null> = live.merged ? 'merged' : live.state === 'closed' ? 'closed' : 'open';
      if (prStateCache.size >= MAX_PR_STATE_CACHE) prStateCache.clear();
      prStateCache.set(key, { atMs: nowMs, state });
      out.set(key, state);
    } catch {
      // unknown: stays as recorded (open or null)
    }
  }));
  return out;
}

/** F2's reserve-breach producer, loaded lazily (a missing module is a thrown error the caller audits). */
async function recordReserveBreachesDefault(input: { capacity: unknown; policy: EffectivePolicy; now?: Date; usedSeatIds?: readonly string[] }): Promise<number> {
  const mod = await import('../authority/reserve-breach.js');
  return mod.recordReserveBreaches(input);
}

async function reconcileEnrollmentDefault(policy: EffectivePolicy, enrolled: readonly string[]): Promise<EnrollmentReconcile> {
  const mirrors = await import('./mirrors.js');
  const plan = mirrors.planAutonomousEnrollment(policy, enrolled);
  if (plan.enroll.length === 0 && plan.unenroll.length === 0) {
    return { changed: false, enrolled: [], unenrolled: [], errors: [] };
  }
  const result = await mirrors.reconcileAutonomousEnrollment(policy, { apply: true });
  return {
    changed: true,
    enrolled: result.enrolled,
    unenrolled: result.unenrolled,
    errors: result.errors.map((e) => `${e.path}: ${e.reason}`),
  };
}

async function leaderTickDefault(cfg: AshlrConfig): Promise<void> {
  const leader = await import('../vision/leader.js');
  await leader.leaderTick(await leader.loadDefaultLeaderRunDeps(cfg));
}

function harnessDefault(): TickHarness {
  const version = activeHarness();
  return version ? { versionId: version.id, config: version.config } : { versionId: null, config: BASELINE_HARNESS_CONFIG };
}

async function runExperimentDefault(opts: { fleetQueueDepth: () => number; signal: AbortSignal }): Promise<string | null> {
  const experiments = await import('../learn/experiments.js');
  const result = await experiments.runNextExperiment({ fleetQueueDepth: opts.fleetQueueDepth, signal: opts.signal });
  if (result.ran) return `experiment ${result.ran.id} finished: ${result.ran.verdict ?? result.ran.status}`;
  return result.reason === 'no experiment is queued' ? null : result.reason;
}

async function insightsDefault(): Promise<ReasoningInsight[]> {
  const { computeReasoningDigest } = await import('../reasoning/reasoning-api.js');
  const digest = await computeReasoningDigest(14);
  return digest.insights;
}

export function defaultLiveHooksDeps(): LiveHooksDeps {
  return {
    now: () => Date.now(),
    standingPolicy: () => currentStandingPolicy(),
    applyOverlay: (cfg, policy) => applyStandingOverlay(cfg, policy),
    clampBudget: (policy, standing, knownSeatIds) => clampBudgetPolicy(policy, standing, knownSeatIds),
    loadBudget: () => loadBudgetPolicy(),
    capacitySnapshot: () => readCapacitySnapshot(),
    probeLocalRuntime: probeLocalRuntimeDefault,
    presence: (nowMs) => probeOperatorPresence(nowMs),
    directives: () => readLeaderDirectives(),
    listHolds: (nowMs) => listRepoHolds({ nowMs }),
    setHold: (req) => setRepoHold(req),
    readLedger: (opts) => readLedger(opts),
    ledgerHead: () => currentLedgerHead(),
    listEnrolled: () => listEnrolled(),
    repoIdentity: (path) => repoIdentityOfPath(path),
    waitingVerify: waitingVerifyDefault,
    observeFleetPrs: observeFleetPrsDefault,
    recordReserveBreaches: recordReserveBreachesDefault,
    installed: (engine, cfg) => engineInstalled(engine, cfg),
    tierOf: (engine, cfg) => engineTierOf(engine, cfg),
    subscriptionAllows: (engine, opts) => subscriptionAllows(engine, opts),
    isSubscriptionEngine: (engine) => isSubscriptionEngine(engine),
    legacyRoute: (item, cfg) => routeBackend(item, cfg),
    localFleetEngine: (cfg) => (localFleetEnabled(cfg) ? LOCAL_FLEET_ENGINE : null),
    readTasks: () => readTaskQueue(),
    releaseTasks: (nowMs) => releaseParkedTasks({ nowMs }),
    recordTask: (taskId, update, nowMs) => recordTaskDispatch(taskId, update, { nowMs }),
    enqueueInsights: (insights, repoOf, nowMs) => enqueueInsightTasks(insights, repoOf, { nowMs }),
    insights: insightsDefault,
    advanceWatch: (signal) => advancePostMergeWatches(signal ? { signal } : {}),
    registerLanding: (record) => registerLanding(record),
    writeTick: (state) => writeTickState(state),
    appendJournal: (record) => appendJournal(record),
    readJournalSince: (sinceMs) => readJournalSince(sinceMs),
    loadBackpressure: () => loadBackpressureState(),
    saveBackpressure: (state) => saveBackpressureState(state),
    shadow: (input) => recordShadowDecision(input),
    audit: (entry) => {
      try {
        audit({ action: entry.action, repo: entry.repo, sandboxId: null, summary: entry.summary, result: entry.result });
      } catch { /* audit is best effort */ }
    },
    prepareMirrors: async (policy) => (await import('./mirrors.js')).prepareMirrorsForTick(policy),
    reconcileEnrollment: reconcileEnrollmentDefault,
    sweepHolds: (nowMs) => {
      const swept = sweepExpiredRepoHolds({ nowMs });
      return { swept: swept.swept.length, error: swept.error };
    },
    leaderTick: leaderTickDefault,
    harness: harnessDefault,
    checkCanary: (nowMs) => {
      checkHarnessCanary(new Date(nowMs));
    },
    recordHarnessOutcome: (input) => recordHarnessOutcome({
      passed: input.passed,
      versionId: input.versionId ?? BASELINE_VERSION_ID,
      at: new Date(input.at),
    }).ok,
    runExperiment: runExperimentDefault,
    overnightActive: () => overnightRunInProgress(),
    killActive: () => killSwitchOn(),
    revokeArmedMerges: (reason) => revokeArmedMerges(reason),
  };
}

// ---------------------------------------------------------------------------
// The per-tick context
// ---------------------------------------------------------------------------

interface TickContext {
  nowMs: number;
  cfg: AshlrConfig;
  policy: EffectivePolicy;
  router: DispatchRouterContext;
  lanes: Record<FleetEngine, LanePlan>;
  capacity: SeatCapacity[];
  budget: BudgetPolicy;
  enrolled: string[];
  pathOfRepo: Map<string, string>;
  routeCache: Map<string, DispatchRoute>;
  /** Title / source of every item routed this tick (DispatchOutcome carries neither). */
  itemInfo: Map<string, { title: string; source: string }>;
  held: HeldItemRecord[];
  fleetItems: WorkItem[];
  tickState: FleetTickStateV1;
  /** The harness dispatch runs with this tick (read once, after the canary check). */
  harness: TickHarness;
  /** Leader › harness › baseline routing weights (seat ranking λ + best-of-N threshold). */
  routing: HarnessRoutingWeights;
  /** Fleet task id → attempts so far (best-of-N's "already failed once"). */
  taskAttempts: Map<string, number>;
  /**
   * Review c9: Codex seats the Leader's class-B directive switched on in THIS
   * tick's budget (Mason's stored budget still has them off). The final seat
   * gate judges them against the tick's budget, as the router did.
   */
  directiveSeats: Set<string>;
  /**
   * Review c15: extra lane turns best-of-N fan-outs may still take this tick
   * (slots held back from the pool's lane caps in beforeTick). Decremented as
   * plans reserve them; never refunded within the tick (no finish signal
   * reaches the hooks, and every turn ends with the tick).
   */
  fanoutBudget: Record<FleetEngine, number>;
  /** Seats this tick's dispatches actually ran on (reserve-breach attribution). */
  usedSeats: Set<string>;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function describeError(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** Enrolled path's display label when it has no GitHub identity. */
function dirLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The fleet seat for the local runtime, in the router's SeatCapacity terms. */
function localSeat(reading: LocalRuntimeReading): SeatCapacity {
  return {
    seatId: FLEET_LOCAL_SEAT_ID,
    engine: 'local',
    label: 'Local fleet',
    free: true,
    windows: [],
    signedOut: false,
    reachable: reading.reachable,
    // WHY a default instead of null: a null window makes the router skip the
    // fit check, which would let an item too big for a 64k slot land on it.
    contextWindow: reading.contextPerSlot ?? DEFAULT_LOCAL_CONTEXT_TOKENS,
    observedAt: null,
    spentTodayUsd: null,
  };
}

/**
 * Codex lanes turned on by the Leader (a class-B action after the reset) mean
 * the Codex seats the GRANT enables may be used even though Mason's budget
 * default has Codex off (routing/policy.ts MODE_DEFAULTS). Only the grant's
 * own `enabled` flag and its reserve floors remain — clampBudgetPolicy has
 * already applied them.
 */
function applyCodexDirective(
  budget: BudgetPolicy,
  capacity: readonly SeatCapacity[],
  policy: EffectivePolicy,
  directives: LeaderDirectivesV1 | null,
): { budget: BudgetPolicy; enabledSeats: Set<string> } {
  const enabledSeats = new Set<string>();
  if (directives?.codexEnabled !== true || !policy.engines.includes('codex')) return { budget, enabledSeats };
  const seats = { ...budget.seats };
  for (const seat of capacity) {
    if (seat.engine !== 'codex') continue;
    const grant = standingSeatFor(policy.spend, seat.seatId);
    if (!grant?.enabled) continue;
    const current = effectiveSeatPolicy(budget, seat.seatId, 'codex');
    if (current.enabled) continue;
    seats[seat.seatId] = { ...current, enabled: true, reservePercent: Math.max(current.reservePercent, grant.reserveFloorPercent) };
    enabledSeats.add(seat.seatId);
  }
  return { budget: enabledSeats.size > 0 ? { ...budget, seats } : budget, enabledSeats };
}

/**
 * B-U1: the standing overlay does not rewrite `allowedBackends`, so a backend
 * outside the grant's engines (nim, kimi, the per-token xAI API, ashlrcode —
 * anything that is not one of the grant's fleet lanes) would still be a
 * candidate for every code path that reads the list directly (explicit
 * best-of-N candidates, quota fallbacks). Filtering it here keeps a standing
 * tick to exactly the engines the grant names. An empty result stays empty:
 * nothing is dispatchable, which is the fail-closed answer.
 */
export function grantAllowedBackends(
  allowed: readonly string[] | undefined,
  policy: Pick<EffectivePolicy, 'engines'>,
  cfg?: AshlrConfig,
): string[] {
  return (allowed ?? ['builtin']).filter((engine) => {
    const lane = fleetLaneOf(engine, cfg);
    return lane !== null && policy.engines.includes(lane);
  });
}

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

export interface LiveTickHooks extends TickHooks {
  /** Dispatchable fleet tasks projected into WorkItems (this tick). */
  fleetWorkItems(): WorkItem[];
  /**
   * The scanned backlog with this tick's dispatchable fleet tasks merged in
   * (stable score order — fleet/task-source.ts mergeFleetTaskItems). loop.ts
   * calls this on every backlog refresh of a standing tick.
   */
  standingBacklog(items: WorkItem[]): WorkItem[];
  /** The last tick's state, for tests and diagnostics. */
  lastTickState(): FleetTickStateV1 | null;
  /**
   * B-U9: the harness this tick's producers run with — its version (null =
   * baseline) and the producer prompt overlay loop.ts appends to the goal.
   * null when no tick context is ready (then nothing dispatches anyway).
   */
  dispatchHarness(): { versionId: string | null; producerPrompt: string | null } | null;
  /**
   * U7: the autonomous best-of-N plan for an item this tick already routed
   * (`hooks.route`). null = no plan (no context, or the item was not routed
   * here) — the loop then dispatches one candidate, never falls back to the
   * config's own best-of-N. `maxPercent` is what the loop passes the seat gate.
   */
  bestOfNPlan(item: WorkItem, opts: SeatAllowsOptions): AutonomousBestOfNPlan | null;
  /**
   * B-U9: credit G3 verification verdicts (ledger `gate:result` rows) to the
   * harness version each proposal's dispatch ran with. Returns how many were
   * recorded. Never throws.
   */
  recordVerdicts(rows: readonly LedgerEntry[]): Promise<number>;
  /**
   * Stop background work this session started (a running experiment). Called
   * when standing authority is withdrawn and when the session closes.
   */
  stopBackground(reason: string): void;
  /**
   * Once per standing tick, AFTER its dispatches: re-read capacity and let
   * F2's `recordReserveBreaches` ledger any seat whose usage crossed the
   * grant's reserve floor / session ceiling (the rollout's `reserveBreaches`
   * criterion and regress-on-breach read those rows). Returns rows written;
   * 0 for a dry run, a tick with no context, or a second call for the same
   * tick. Never throws (a failure is audited).
   */
  afterStandingTick(): Promise<number>;
}

export interface CreateLiveTickHooksOptions {
  deps?: Partial<LiveHooksDeps>;
  /** Bound on the Leader's per-tick work (default LEADER_TICK_TIMEOUT_MS). */
  leaderTimeoutMs?: number;
}

/** Build the live hooks for one resident standing session. */
export function createLiveTickHooks(options: CreateLiveTickHooksOptions = {}): LiveTickHooks {
  const deps: LiveHooksDeps = { ...defaultLiveHooksDeps(), ...(options.deps ?? {}) };
  const leaderTimeoutMs = options.leaderTimeoutMs ?? LEADER_TICK_TIMEOUT_MS;
  let ctx: TickContext | null = null;
  let overlayError: string | null = null;
  let lastState: FleetTickStateV1 | null = null;
  let lastInsightIngestMs = 0;
  let harnessKnownThisTick = false;
  let presenceCache: { atMs: number; value: OperatorPresence } | null = null;
  const installCache = new Map<string, { atMs: number; value: boolean }>();
  let lastHoldSweepMs = Number.NEGATIVE_INFINITY;
  let leaderInFlight: Promise<unknown> | null = null;
  let experiment: { controller: AbortController; promise: Promise<void> } | null = null;
  let lastExperimentPollMs = Number.NEGATIVE_INFINITY;
  let lastFleetQueueDepth = 0;
  /**
   * Size of the merged standing backlog (scanned items + fleet tasks) the
   * loop last asked for; null until it has. Review c15: the experiment
   * runner's "idle" must see scanned work too, not only the fleet task queue.
   */
  let lastBacklogDepth: number | null = null;
  /** Items the loop may still dispatch this tick, by id (fan-out prediction for the NEXT tick's reserve). */
  let lastBacklogItems: WorkItem[] = [];
  /** Plans already made this tick (a repeated ask for one item must not charge its lanes twice). */
  const plannedThisTick = new Map<string, AutonomousBestOfNPlan>();
  /** The tick context whose reserve breaches were already recorded. */
  let breachCheckedFor: TickContext | null = null;
  /** Proposal id → harness version its dispatch ran with (this process). */
  const harnessOfProposal = new Map<string, string | null>();
  const creditedVerdicts = new Set<string>();
  /** True once this KILL episode's armed merges were revoked cleanly; reset when KILL clears. */
  let killMergesRevoked = false;

  /**
   * U3 (INT2 left this to U5): a tick that observes KILL revokes every ARMED
   * host merge at the protocol level. WHY here as well as in Stop/Revoke: KILL
   * can be armed by a path that does not revoke (a bare `ashlr stop`, an older
   * binary, a soft kill whose revocation failed, the sentinel written by
   * hand), and this daemon is the process that would otherwise consume a
   * merge it armed. The consume step already refuses under KILL; this removes
   * the authority itself. Lowering, so an unreadable KILL counts as ON.
   * WHY once per episode: the revocation audits a row every call, and a
   * stopped fleet keeps ticking for days — a clean pass is not repeated until
   * KILL clears and is armed again; a pass with failures is retried next tick.
   */
  const revokeMergesOnKill = async (): Promise<void> => {
    let killOn: boolean;
    try {
      killOn = deps.killActive();
    } catch {
      killOn = true;
    }
    if (!killOn) {
      killMergesRevoked = false;
      return;
    }
    if (killMergesRevoked) return;
    let outcome: MergeRevocationOutcome;
    try {
      outcome = await deps.revokeArmedMerges('KILL observed by the standing tick');
    } catch (err) {
      outcome = { revoked: 0, failed: [describeError(err)] };
    }
    killMergesRevoked = outcome.failed.length === 0;
    deps.audit({
      action: 'daemon:kill-merge-revoke',
      repo: null,
      summary: outcome.failed.length === 0
        ? `KILL observed: revoked ${outcome.revoked} armed fleet merge(s)`
        : `KILL observed: revoked ${outcome.revoked} armed fleet merge(s); ${outcome.failed.length} could not be revoked (retried next tick; KILL still blocks their consume): ${outcome.failed.slice(0, 3).join('; ')}`,
      result: outcome.failed.length === 0 ? 'ok' : 'error',
    });
  };

  const stopExperiment = (reason: string): void => {
    const running = experiment;
    if (!running) return;
    running.controller.abort();
    deps.audit({ action: 'daemon:experiment', repo: null, summary: `experiment runner stopped: ${reason}`, result: 'ok' });
  };

  /**
   * Run the next queued experiment in the background (B-U9: idle or overnight
   * windows only). One at a time; the runner reads the live fleet queue depth
   * before each pair and narrows itself to one local slot while work waits.
   */
  const maybeStartExperiment = (nowMs: number, window: string): void => {
    if (experiment || nowMs - lastExperimentPollMs < EXPERIMENT_POLL_INTERVAL_MS) return;
    lastExperimentPollMs = nowMs;
    const controller = new AbortController();
    let run: Promise<string | null>;
    try {
      run = deps.runExperiment({ fleetQueueDepth: () => lastFleetQueueDepth, signal: controller.signal });
    } catch (err) {
      run = Promise.reject(err);
    }
    const promise = run
      .then((outcome) => {
        if (outcome !== null) deps.audit({ action: 'daemon:experiment', repo: null, summary: `${window}: ${outcome}`, result: 'ok' });
      })
      .catch((err) => {
        deps.audit({ action: 'daemon:experiment', repo: null, summary: `${window}: the experiment runner failed (${describeError(err)})`, result: 'error' });
      })
      .finally(() => {
        if (experiment?.controller === controller) experiment = null;
      });
    experiment = { controller, promise };
  };

  const installed = (engine: EngineId, cfg: AshlrConfig, nowMs: number): boolean => {
    const hit = installCache.get(engine);
    if (hit && nowMs - hit.atMs < INSTALL_PROBE_TTL_MS) return hit.value;
    let value = false;
    try {
      value = deps.installed(engine, cfg);
    } catch {
      value = false;
    }
    installCache.set(engine, { atMs: nowMs, value });
    return value;
  };

  const heldResult = (reason: string, enrolled: readonly string[]): BeforeTickResult => ({
    pausedRepos: [...enrolled],
    laneCaps: Object.fromEntries(FLEET_ENGINES.map((lane) => [lane, 0])) as Partial<Record<FleetEngine, number>>,
    holdProduction: reason,
  });

  const noContextRoute = (item: WorkItem, cfg: AshlrConfig): TickRouteDecision => {
    let legacy: RouteDecision;
    try {
      legacy = deps.legacyRoute(item, cfg);
    } catch {
      legacy = { backend: 'builtin' as EngineId, tier: 'local', reason: 'legacy route unavailable' };
    }
    return {
      ...legacy,
      seatDecision: null,
      hold: {
        kind: 'park',
        reason: 'No standing tick context is ready (beforeTick did not complete), so nothing is dispatched.',
        nextEligibleAt: null,
      },
    };
  };

  const hooks: LiveTickHooks = {
    effectiveConfig(cfg: AshlrConfig): AshlrConfig {
      overlayError = null;
      let policy: EffectivePolicy | null = null;
      try {
        policy = deps.standingPolicy();
      } catch (err) {
        overlayError = `The standing policy could not be read (${describeError(err)}).`;
      }
      let out = cfg;
      if (policy) {
        try {
          out = deps.applyOverlay(cfg, policy);
        } catch (err) {
          // Without the overlay (claim integrity, confinement, clamped caps)
          // standing work must not run: beforeTick holds production.
          overlayError = `The standing config overlay is unavailable (${describeError(err)}).`;
          out = cfg;
        }
      }
      // Route every dispatch through hooks.route / hooks.seatAllows: the
      // gateway and the concurrent planner choose backends on their own.
      const foundry = out.foundry ?? {};
      const fabric = (foundry.fabric ?? {}) as Record<string, unknown>;
      return {
        ...out,
        foundry: {
          ...foundry,
          ...(policy
            ? { allowedBackends: grantAllowedBackends(foundry.allowedBackends as readonly string[] | undefined, policy, out) as typeof foundry.allowedBackends }
            : {}),
          fabric: { ...fabric, gateway: false, concurrentDispatch: false, gatewayShadow: false } as typeof foundry.fabric,
        },
      };
    },

    async beforeTick(hookCtx: TickHookContext): Promise<BeforeTickResult> {
      ctx = null;
      const nowMs = hookCtx.nowMs;
      // First, before anything can hold or return early: a KILL (which also
      // makes the standing policy null below) revokes armed merges. Runs in a
      // dry run too — revoking only lowers authority and never touches GitHub.
      await revokeMergesOnKill();
      let enrolled: string[] = [];
      try {
        enrolled = deps.listEnrolled();
      } catch {
        enrolled = [];
      }
      const finish = (result: BeforeTickResult, state: FleetTickStateV1): BeforeTickResult => {
        lastState = state;
        deps.writeTick(state);
        deps.audit({
          action: 'daemon:standing-tick',
          repo: null,
          summary: result.holdProduction
            ? `standing tick: production held — ${result.holdProduction}`
            : `standing tick: lanes ${state.lanes.map((l) => `${l.lane}=${l.slots}`).join(' ')}; `
              + `${result.pausedRepos.length} repo(s) paused; ledger head ${state.ledgerHead ? `#${state.ledgerHead.seq}` : 'none'}`,
          result: result.holdProduction ? 'refused' : 'ok',
        });
        return result;
      };
      const emptyState = (reason: string, presence: OperatorPresence): FleetTickStateV1 => ({
        v: 1,
        at: new Date(nowMs).toISOString(),
        capabilityKind: hookCtx.capabilityKind,
        dryRun: hookCtx.dryRun,
        standing: null,
        lanes: laneStates(
          Object.fromEntries(FLEET_ENGINES.map((lane) => [lane, { lane, slots: 0, capReason: reason }])) as Record<FleetEngine, LanePlan>,
          {},
        ),
        presence,
        holdProduction: reason,
        pausedRepos: [],
        waitingVerify: null,
        openPrsByRepo: null,
        ledgerHead: null,
        held: [],
        watch: { available: false, reason: null },
      });
      const unknownPresence: OperatorPresence = { present: null, reason: 'Not probed this tick.', evidenceAt: null };

      let policy: EffectivePolicy | null = null;
      try {
        policy = deps.standingPolicy();
      } catch {
        policy = null;
      }
      if (!policy) {
        const reason = 'The standing grant is not in force (switched off, stopped, revoked, paused or expired).';
        stopExperiment(reason);
        return finish(heldResult(reason, enrolled), emptyState(reason, unknownPresence));
      }
      if (overlayError) return finish(heldResult(overlayError, enrolled), emptyState(overlayError, unknownPresence));
      const cfg = hookCtx.cfg;

      // ── Expired holds (U4) ───────────────────────────────────────────────
      // Reads already ignore an expired hold; the sweep ledgers its clearing
      // so the record shows when a quarantine / cooldown ended.
      if (nowMs - lastHoldSweepMs >= HOLD_SWEEP_INTERVAL_MS) {
        lastHoldSweepMs = nowMs;
        try {
          const swept = deps.sweepHolds(nowMs);
          if (swept.error) {
            deps.audit({ action: 'daemon:repo-holds', repo: null, summary: `expired holds could not be swept: ${swept.error}`, result: 'error' });
          }
        } catch (err) {
          deps.audit({ action: 'daemon:repo-holds', repo: null, summary: `expired holds could not be swept: ${describeError(err)}`, result: 'error' });
        }
      }

      // ── Mirrors + enrollment (U6) ────────────────────────────────────────
      // Every mirror the stage names is reset to origin/<base> BEFORE anything
      // is selected or merged this tick; one that is not current pauses its
      // repo (stale code is never dispatched). Enrollment is then made exactly
      // the grant's repo list — only when the plan says something changes.
      let mirrorProblem: string | null = null;
      const mirrorPaused: { path: string; repo: string; reason: string }[] = [];
      if (!hookCtx.dryRun) {
        try {
          const prep = await deps.prepareMirrors(policy);
          for (const failed of prep.failed) {
            if (!failed.path) continue;
            mirrorPaused.push({ path: failed.path, repo: failed.nameWithOwner, reason: `Its mirror is not current (${failed.reason}).` });
          }
          for (const path of prep.pausedRepoPaths) {
            if (!mirrorPaused.some((m) => resolve(m.path) === resolve(path))) {
              mirrorPaused.push({ path, repo: dirLabel(path), reason: 'Its mirror is not current.' });
            }
          }
        } catch (err) {
          mirrorProblem = `The fleet mirrors could not be prepared (${describeError(err)}), so no repo is known to be current.`;
        }
        if (mirrorProblem === null) {
          try {
            const reconciled = await deps.reconcileEnrollment(policy, enrolled);
            if (reconciled.changed) {
              deps.audit({
                action: 'daemon:autonomous-enrollment',
                repo: null,
                summary: `enrollment reconciled to the grant: +${reconciled.enrolled.length} −${reconciled.unenrolled.length}`
                  + (reconciled.errors.length > 0 ? `; ${reconciled.errors.length} failed (${reconciled.errors[0]})` : ''),
                result: reconciled.errors.length > 0 ? 'error' : 'ok',
              });
              try {
                enrolled = deps.listEnrolled();
              } catch {
                enrolled = [];
              }
            }
          } catch (err) {
            deps.audit({ action: 'daemon:autonomous-enrollment', repo: null, summary: `enrollment could not be reconciled: ${describeError(err)}`, result: 'error' });
          }
        }
      }

      // ── Leader (B-U8) ────────────────────────────────────────────────────
      // Before the directives are read: this is what applies class-B actions
      // whose veto window elapsed and grades moves. A due memo starts in the
      // background inside leaderTick; the tick itself is bounded here.
      if (!hookCtx.dryRun && leaderInFlight === null) {
        const leaderRun = (async () => deps.leaderTick(cfg))();
        leaderInFlight = leaderRun.finally(() => {
          leaderInFlight = null;
        }).catch(() => undefined);
        try {
          const outcome = await withTimeout(leaderRun, leaderTimeoutMs);
          if (outcome === 'timeout') {
            deps.audit({ action: 'daemon:leader-tick', repo: null, summary: `the Leader tick exceeded ${leaderTimeoutMs} ms; the fleet tick continues without waiting`, result: 'error' });
          }
        } catch (err) {
          // The Leader is an input to the tick, never a reason to hold it.
          deps.audit({ action: 'daemon:leader-tick', repo: null, summary: `the Leader tick failed: ${describeError(err)}`, result: 'error' });
        }
      }

      // ── Repo identity ────────────────────────────────────────────────────
      const repoOfPath = new Map<string, string | null>();
      const pathOfRepo = new Map<string, string>();
      for (const path of enrolled) {
        let nwo: string | null = null;
        try {
          nwo = deps.repoIdentity(path);
        } catch {
          nwo = null;
        }
        repoOfPath.set(resolve(path), nwo);
        if (nwo) pathOfRepo.set(nwo.toLowerCase(), path);
      }
      const policyRepos = policy.repos.map((r) => r.nameWithOwner);

      // ── Holds ────────────────────────────────────────────────────────────
      let holds: RepoHold[];
      try {
        holds = deps.listHolds(nowMs);
      } catch (err) {
        const reason = `Repo holds could not be read (${describeError(err)}), so no repo is known to be clear.`;
        return finish(heldResult(reason, enrolled), emptyState(reason, unknownPresence));
      }

      // ── Evidence: ledger + journal ──────────────────────────────────────
      const sinceMs = nowMs - LIVE_HOOKS_EVIDENCE_WINDOW_MS;
      let entries: LedgerEntry[] = [];
      let ledgerOk = false;
      let ledgerProblem: string | null = null;
      try {
        const read = await deps.readLedger({ sinceAt: new Date(sinceMs).toISOString(), kinds: LEDGER_KINDS });
        if (read.chain === 'broken') {
          ledgerProblem = `The authority ledger chain is broken${read.brokenAtSeq !== null ? ` at #${read.brokenAtSeq}` : ''}.`;
        } else {
          entries = read.entries;
          ledgerOk = true;
        }
      } catch (err) {
        ledgerProblem = `The authority ledger could not be read (${describeError(err)}).`;
      }
      let journalRows: FleetJournalRecord[] = [];
      try {
        journalRows = await deps.readJournalSince(sinceMs);
      } catch {
        journalRows = [];
      }
      const routeIndex = proposalRouteIndex(journalRows);
      const outcomes: OutcomeEvent[] = ledgerOk ? outcomeEventsFromLedger(entries, (id) => routeIndex.get(id) ?? null) : [];
      let ledgerHead: { seq: number; hash: string } | null = null;
      try {
        const head = deps.ledgerHead();
        ledgerHead = head ? { seq: head.seq, hash: head.hash } : null;
      } catch (err) {
        // B-U1: currentLedgerHead throws exactly when the chain is broken — a
        // broken chain halts everything until a new grant (SPEC-310B §1).
        ledgerHead = null;
        ledgerProblem ??= `The authority ledger head could not be read (${describeError(err)}).`;
      }

      // ── Backpressure ─────────────────────────────────────────────────────
      let waitingVerify: number | null = null;
      try {
        waitingVerify = await deps.waitingVerify(enrolled);
      } catch {
        waitingVerify = null;
      }
      let bpState: BackpressureStateV1;
      try {
        bpState = deps.loadBackpressure();
      } catch {
        bpState = emptyBackpressureState();
      }
      // Review c5: the ledger never hears about a PR Mason merged or closed
      // on GitHub, so its open set is reconciled with observed PR state
      // before the per-repo cap can pause anything.
      let openPrs: Record<string, number> | null = null;
      if (ledgerOk) {
        const refs = openFleetPrRefsFromLedger(entries);
        let observed = new Map<string, ObservedPrState>();
        if (refs.length > 0) {
          try {
            observed = await deps.observeFleetPrs(refs, nowMs);
          } catch {
            observed = new Map();
          }
        }
        openPrs = reconcileOpenFleetPrs(refs, observed, nowMs);
      }
      const bp = evaluateBackpressure({
        nowMs,
        repos: policyRepos,
        openPrsByRepo: openPrs,
        waitingVerify,
        outcomes,
        holds,
        state: bpState,
      });
      for (const cooldown of bp.cooldowns) {
        try {
          const change = deps.setHold({
            repo: cooldown.repo,
            kind: 'cooldown',
            hold: { reason: cooldown.reason, until: cooldown.until },
            actor: 'backpressure',
          });
          if (change.ok && change.after) holds = [...holds.filter((h) => !(h.repo === change.after!.repo && h.kind === 'cooldown')), change.after];
          else holds = [...holds, { v: 1, repo: cooldown.repo, kind: 'cooldown', reason: cooldown.reason, since: new Date(nowMs).toISOString(), until: cooldown.until, setBy: 'backpressure', landingId: null }];
        } catch {
          // A cooldown that could not be stored still pauses this tick (below).
          holds = [...holds, { v: 1, repo: cooldown.repo, kind: 'cooldown', reason: cooldown.reason, since: new Date(nowMs).toISOString(), until: cooldown.until, setBy: 'backpressure', landingId: null }];
        }
      }
      try {
        deps.saveBackpressure(bp.nextState);
      } catch {
        // Demotions still apply to this tick from memory.
      }

      // ── Post-merge watch (U4) ────────────────────────────────────────────
      let watchAvailable = true;
      let watchReason: string | null = null;
      let watchHold: string | null = null;
      try {
        const pass = await deps.advanceWatch();
        if (!pass.ok) {
          watchHold = `The post-merge watch could not run (${pass.reason ?? 'no reason given'}); production holds until it can.`;
          watchReason = pass.reason;
        } else if (pass.softKilled) {
          watchHold = `The post-merge watch armed a global stop: ${pass.escalations[0] ?? 'escalation'}.`;
        }
      } catch (err) {
        watchAvailable = false;
        watchReason = describeError(err);
        watchHold = `The post-merge watch failed (${watchReason}); production holds until it can run.`;
      }

      // ── Paused repos ─────────────────────────────────────────────────────
      const pausedReasons = new Map<string, { repo: string; reason: string }>();
      const pause = (path: string, repo: string, reason: string): void => {
        if (!pausedReasons.has(resolve(path))) pausedReasons.set(resolve(path), { repo, reason });
      };
      for (const m of mirrorPaused) pause(m.path, m.repo, m.reason);
      for (const path of enrolled) {
        const nwo = repoOfPath.get(resolve(path)) ?? null;
        if (nwo === null) {
          pause(path, dirLabel(path), 'It has no GitHub origin the grant can be checked against.');
          continue;
        }
        if (!policyRepos.some((r) => r.toLowerCase() === nwo.toLowerCase())) {
          pause(path, nwo, "It is not in the grant's current rollout stage.");
          continue;
        }
        const active = holds.filter((h) => h.repo.toLowerCase() === nwo.toLowerCase());
        if (active.length > 0) {
          pause(path, nwo, `On ${active.map((h) => h.kind).join(' + ')}: ${active[0]!.reason}`);
          continue;
        }
        const bpReason = Object.entries(bp.pausedRepos).find(([repo]) => repo.toLowerCase() === nwo.toLowerCase())?.[1];
        if (bpReason) pause(path, nwo, bpReason);
      }

      // ── Seats, budget, lanes ─────────────────────────────────────────────
      let snapshot: CapacitySnapshot | null = null;
      try {
        snapshot = deps.capacitySnapshot();
      } catch {
        snapshot = null;
      }
      let local: LocalRuntimeReading;
      try {
        local = await deps.probeLocalRuntime(cfg, snapshot);
      } catch {
        local = { reachable: null, slots: null, contextPerSlot: null, detail: 'the local runtime probe failed' };
      }
      const capacity: SeatCapacity[] = [
        ...(snapshot?.seats ?? []).filter((s) => s.engine !== 'local'),
        localSeat(local),
      ];
      let presence: OperatorPresence;
      if (presenceCache && nowMs - presenceCache.atMs < PRESENCE_TTL_MS) {
        presence = presenceCache.value;
      } else {
        try {
          presence = await deps.presence(nowMs);
        } catch {
          presence = { present: null, reason: 'Presence could not be probed.', evidenceAt: null };
        }
        presenceCache = { atMs: nowMs, value: presence };
      }
      let directives: LeaderDirectivesV1 | null = null;
      try {
        // B-U8: honour codexEnabled only while the grant lists codex, and the
        // grok lane count only while it lists grok-cli.
        directives = clampLeaderDirectives(deps.directives(), policy);
      } catch {
        directives = null;
      }
      let budget: BudgetPolicy | null = null;
      let budgetProblem: string | null = null;
      let directiveSeats = new Set<string>();
      try {
        const applied = applyCodexDirective(
          deps.clampBudget(deps.loadBudget(), policy, capacity.map((s) => s.seatId)),
          capacity,
          policy,
          directives,
        );
        budget = applied.budget;
        directiveSeats = applied.enabledSeats;
      } catch (err) {
        budgetProblem = `The budget could not be clamped to the grant (${describeError(err)}).`;
      }
      const allowed = cfg.foundry?.allowedBackends ?? ['builtin'];
      const laneEngines = resolveLaneEngines({
        allowedBackends: allowed as readonly string[],
        installed: (engine) => installed(engine, cfg, nowMs),
        localFleetEngine: deps.localFleetEngine(cfg),
        cfg,
      });
      const lanes = planLanes({
        policy,
        directives,
        presence,
        localServingSlots: local.slots,
        engineUnavailable: laneEngines.unavailable,
      });
      if (local.reachable === false && lanes.local.slots > 0) {
        lanes.local = { lane: 'local', slots: 0, capReason: `The local runtime is not reachable (${local.detail}).` };
      }

      // ── Fleet tasks ──────────────────────────────────────────────────────
      try {
        deps.releaseTasks(nowMs);
      } catch { /* the queue read below reports trouble */ }
      if (nowMs - lastInsightIngestMs >= INSIGHT_INGEST_INTERVAL_MS) {
        lastInsightIngestMs = nowMs;
        try {
          const insights = await Promise.race([
            deps.insights(),
            new Promise<ReasoningInsight[]>((resolveTimeout) => {
              const timer = setTimeout(() => resolveTimeout([]), 5_000);
              (timer as { unref?: () => void }).unref?.();
            }),
          ]);
          deps.enqueueInsights(insights, (label) => {
            const nwo = resolveRepoLabel(label, enrolled);
            return nwo && policyRepos.some((r) => r.toLowerCase() === nwo.toLowerCase()) ? nwo : null;
          }, nowMs);
        } catch {
          // Insights are an input, never a reason to hold the fleet.
        }
      }
      const shipRate = (repo: string): number | null => {
        const events = outcomes.filter((e) => e.repo.toLowerCase() === repo.toLowerCase());
        if (events.length === 0) return null;
        const ok = events.filter((e) => e.kind === 'success').length;
        // Laplace-smoothed: two events cannot claim 0% or 100%.
        return (ok + 1) / (events.length + 2);
      };
      let fleetItems: WorkItem[] = [];
      const taskAttempts = new Map<string, number>();
      try {
        const queue = deps.readTasks();
        if (queue.ok) {
          for (const task of queue.tasks) taskAttempts.set(task.id, task.attempts);
          fleetItems = fleetTaskWorkItems(queue.tasks, (nwo) => pathOfRepo.get(nwo.toLowerCase()) ?? null, { nowMs, shipRateOf: shipRate });
        }
      } catch {
        fleetItems = [];
      }

      // ── Harness (B-U9) ───────────────────────────────────────────────────
      // The canary first: a rollback it decides changes which version is
      // active, and this tick must dispatch with the version that is.
      try {
        deps.checkCanary(nowMs);
      } catch { /* the canary is re-checked next tick and after every outcome */ }
      let harness: TickHarness = { versionId: null, config: BASELINE_HARNESS_CONFIG };
      let harnessKnown = true;
      try {
        harness = deps.harness();
      } catch {
        // Baseline config is the safe dispatch default; the verdicts of this
        // tick's runs are not credited to any version (unknown which ran).
        harnessKnown = false;
      }
      const routing = resolveRoutingWeights(
        BASELINE_HARNESS_CONFIG.routing,
        harness.config.routing ?? null,
        directives?.routerTuning ?? null,
      );

      // ── Production hold ──────────────────────────────────────────────────
      const holdProduction = ledgerProblem
        ?? mirrorProblem
        ?? budgetProblem
        ?? watchHold
        ?? bp.holdProduction;

      // ── Experiments (B-U9): idle or overnight windows only ──────────────
      // Review c15: "idle" means no work at all — the scanned backlog the
      // loop dispatches too (last seen via standingBacklog), not only the
      // fleet task queue — and unknown backlog is not idle.
      lastFleetQueueDepth = Math.max(fleetItems.length, lastBacklogDepth ?? 0) + (waitingVerify ?? 0);
      if (!hookCtx.dryRun && holdProduction === null && lanes.local.slots > 0) {
        let overnight = false;
        try {
          overnight = deps.overnightActive();
        } catch {
          overnight = false;
        }
        const idle = fleetItems.length === 0 && lastBacklogDepth === 0 && waitingVerify === 0;
        if (idle || overnight) maybeStartExperiment(nowMs, overnight ? 'overnight window' : 'idle fleet');
      }
      // A running experiment's local turns are local turns: they come out of
      // the lane before the pool sees it. The runner narrows itself to
      // EXPERIMENT_SLOTS.fleetBusy (1) while work waits, idle (2) otherwise;
      // a pair already in flight when work arrives finishes first (bounded
      // overlap of one turn, stated rather than hidden).
      if (experiment && lanes.local.slots > 0) {
        const width = lastFleetQueueDepth > 0 ? EXPERIMENT_LOCAL_SLOTS_BUSY : EXPERIMENT_LOCAL_SLOTS_IDLE;
        const left = Math.max(0, lanes.local.slots - width);
        lanes.local = { lane: 'local', slots: left, capReason: `A harness experiment is using ${lanes.local.slots - left} local slot(s).` };
      }

      // ── Best-of-N reserve (review c15) ──────────────────────────────────
      // Held back from the pool's lane caps only when some item this tick
      // (fleet tasks, or the backlog the loop last dispatched from) could
      // fan out; fan-outs spend only this reserve, so lane caps hold.
      const fanoutPlausible = lanes.local.slots > 0 && anyFanoutCandidate(
        [...fleetItems, ...lastBacklogItems],
        routing.bonThreshold,
        (item) => {
          const taskId = fleetTaskIdOfItem(item);
          return taskId ? taskAttempts.get(taskId) ?? 0 : 0;
        },
      );
      const fanoutReserve = planFanoutReserve(lanes, fanoutPlausible);

      const demotions: RouteDemotion[] = bp.nextState.demotions;
      const pausedList = [...pausedReasons.values()];
      const state: FleetTickStateV1 = {
        v: 1,
        at: new Date(nowMs).toISOString(),
        capabilityKind: hookCtx.capabilityKind,
        dryRun: hookCtx.dryRun,
        standing: { grantId: policy.grantId, stageId: policy.rollout.stageId, switch: policy.switch },
        lanes: laneStates(lanes, {}),
        presence,
        holdProduction,
        pausedRepos: pausedList,
        waitingVerify,
        openPrsByRepo: openPrs,
        ledgerHead,
        held: [],
        watch: { available: watchAvailable, reason: watchReason },
      };

      if (budget === null) {
        return finish(heldResult(holdProduction ?? 'The budget is unavailable.', enrolled), state);
      }

      ctx = {
        nowMs,
        cfg,
        policy,
        router: {
          nowMs,
          policy,
          budget,
          capacity,
          lanes,
          laneEngines: laneEngines.engines,
          demotions,
          // The λ weights used to reach only best-of-N (bonThreshold); the
          // seat ranking now reads them too (routing/router.ts seatScore).
          weights: routing,
          repoOf: (path) => repoOfPath.get(resolve(path)) ?? (() => {
            try {
              return deps.repoIdentity(path);
            } catch {
              return null;
            }
          })(),
          tierOf: (engine) => {
            try {
              return deps.tierOf(engine, cfg);
            } catch {
              return null;
            }
          },
          cfg,
        },
        lanes,
        capacity,
        budget,
        enrolled,
        pathOfRepo,
        routeCache: new Map(),
        itemInfo: new Map(),
        held: [],
        fleetItems,
        tickState: state,
        harness: harnessKnown ? harness : { versionId: null, config: BASELINE_HARNESS_CONFIG },
        routing,
        taskAttempts,
        directiveSeats,
        fanoutBudget: { ...fanoutReserve },
        usedSeats: new Set(),
      };
      plannedThisTick.clear();
      harnessKnownThisTick = harnessKnown;

      const pausedPaths = pausedList.length === 0 ? [] : enrolled.filter((p) => pausedReasons.has(resolve(p)));
      // U6: a mirror that is not current is paused by path even if it is not
      // (yet) enrolled, exactly as prepareMirrorsForTick reports it.
      for (const m of mirrorPaused) {
        if (!pausedPaths.some((p) => resolve(p) === resolve(m.path))) pausedPaths.push(m.path);
      }
      return finish({
        pausedRepos: pausedPaths,
        // The pool gets each lane minus the best-of-N reserve (review c15).
        laneCaps: Object.fromEntries(FLEET_ENGINES.map((lane) => [lane, Math.max(0, lanes[lane].slots - fanoutReserve[lane])])) as Partial<Record<FleetEngine, number>>,
        holdProduction,
      }, state);
    },

    route(item: WorkItem, cfg: AshlrConfig): TickRouteDecision {
      const current = ctx;
      if (!current) return noContextRoute(item, cfg);
      if (!current.itemInfo.has(item.id)) current.itemInfo.set(item.id, { title: item.title, source: item.source });
      const cached = current.routeCache.get(item.id);
      let decision: DispatchRoute;
      if (cached) {
        decision = cached;
      } else {
        let legacy: RouteDecision;
        try {
          legacy = deps.legacyRoute(item, cfg);
        } catch {
          legacy = { backend: 'builtin' as EngineId, tier: 'local', reason: 'legacy route unavailable' };
        }
        decision = routeWorkItem(item, legacy, { ...current.router, cfg });
        current.routeCache.set(item.id, decision);
        if (decision.seatDecision) {
          try {
            deps.shadow({
              source: 'daemon',
              request: routingRequestFor(item),
              decision: decision.seatDecision,
              actual: decision.hold ? null : { engine: decision.backend, seatId: decision.seatDecision.seatId },
            });
          } catch { /* shadow logging never affects dispatch */ }
        }
      }
      return {
        backend: decision.backend,
        tier: decision.tier,
        ...(decision.model ? { model: decision.model } : {}),
        reason: decision.reason,
        seatDecision: decision.seatDecision,
        hold: decision.hold,
      };
    },

    seatAllows(engine: EngineId, opts: SeatAllowsOptions): SubscriptionAllowResult {
      const current = ctx;
      if (!current) {
        return { allowed: false, reason: 'No standing tick context is ready, so no seat is allowed.' };
      }
      const lane = fleetLaneOf(engine, current.cfg);
      if (lane === null) {
        return { allowed: false, reason: `${engine} is not a fleet lane under the standing grant (per-token APIs and agents whose spend cannot be read never are).` };
      }
      if (!current.policy.engines.includes(lane)) {
        return { allowed: false, reason: `The grant's current rollout stage does not include ${lane}.` };
      }
      const plan = current.lanes[lane];
      if (plan.slots <= 0) return { allowed: false, reason: plan.capReason ?? `The ${lane} lane has no slots this tick.` };

      // The seats behind the lane: every one the CLI might hit must have
      // headroom (the fleet cannot choose which account a CLI signs in with).
      const seats = current.capacity.filter((s) => laneOfSeat(s) === lane);
      if (seats.length === 0) return { allowed: false, reason: `No ${lane} seat is known, so no usage can be checked.` };
      for (const seat of seats) {
        const grant = standingSeatFor(current.policy.spend, seat.seatId);
        if (!grant || !grant.enabled) {
          return { allowed: false, reason: `Seat ${seat.seatId} is not usable under the grant.` };
        }
        if (!grant.roles.includes('producer')) {
          return { allowed: false, reason: `Seat ${seat.seatId} has no producer role in the grant.` };
        }
        const assessed = assessSeat(seat, effectiveSeatPolicy(current.budget, seat.seatId, seat.engine), { nowMs: current.nowMs });
        if (!assessed.headroom.eligibleForAutonomy) {
          return {
            allowed: false,
            reason: `Seat ${seat.seatId} is held back by the ${current.budget.mode} budget: ${lowerFirst(assessed.headroom.reasons[0] ?? 'not eligible')}`,
          };
        }
      }
      // Review c9: a Codex seat the Leader's class-B directive switched on
      // exists only in THIS tick's budget. Master's gate re-reads Mason's
      // stored budget (Codex off in every mode by default) and would refuse
      // it every tick while the router kept choosing it — so for those seats
      // the gate's remaining job, the window ceiling, is applied here against
      // the tick's budget (the seat's eligibility was just assessed above).
      if (lane === 'codex' && seats.some((seat) => current.directiveSeats.has(seat.seatId))) {
        for (const seat of seats) {
          const assessed = assessSeat(seat, effectiveSeatPolicy(current.budget, seat.seatId, seat.engine), { nowMs: current.nowMs });
          const used = Math.max(assessed.headroom.sessionUsedPercent ?? 0, assessed.headroom.weeklyUsedPercent ?? 0);
          if (used >= opts.maxPercent) {
            return { allowed: false, reason: `${engine} seat ${seat.seatId} window ${Math.round(used)}% used (max ${opts.maxPercent}%)` };
          }
        }
        return { allowed: true, reason: `${engine} (${lane}) was enabled by the Leader after its reset and has headroom under the ${current.budget.mode} budget.` };
      }
      // Master's subscription window gate still applies to claude / codex
      // (it only ever narrows). grok-cli is judged on its seat above: the
      // M80 reader has no Grok signal and would refuse it as "unknown".
      if (lane === 'claude-cli' || lane === 'codex') {
        let subscription = false;
        try {
          subscription = deps.isSubscriptionEngine(engine);
        } catch {
          subscription = true;
        }
        if (subscription) {
          const verdict = deps.subscriptionAllows(engine, { maxPercent: opts.maxPercent, autonomous: true });
          if (!verdict.allowed) return verdict;
        }
      }
      return { allowed: true, reason: `${engine} (${lane}) is open under the standing grant with headroom on its seat${seats.length === 1 ? '' : 's'}.` };
    },

    async afterDispatch(outcome: DispatchOutcome): Promise<void> {
      const current = ctx;
      const cached = current?.routeCache.get(outcome.itemId) ?? null;
      const taskId = fleetTaskIdOfItem({ id: outcome.itemId });
      const repoNwo = current?.router.repoOf(outcome.repoPath) ?? null;
      const info = current?.itemInfo.get(outcome.itemId) ?? null;
      const title = info?.title ?? outcome.itemId;
      const hold = !outcome.dispatched ? cached?.hold ?? null : null;
      deps.appendJournal({
        v: 1,
        type: 'dispatch',
        at: outcome.at,
        itemId: outcome.itemId,
        taskId,
        runId: outcome.runId,
        repo: repoNwo ?? dirLabel(outcome.repoPath),
        title,
        source: info?.source ?? 'unknown',
        backend: outcome.backend,
        model: outcome.model,
        lane: outcome.lane,
        seatId: outcome.seatId ?? (outcome.dispatched ? cached?.seatDecision?.seatId ?? null : null),
        dispatched: outcome.dispatched,
        skipReason: outcome.skipReason,
        proposalId: outcome.proposalId,
        spentUsd: outcome.spentUsd,
        seatDecision: cached?.seatDecision ?? null,
        hold,
        // Only a tick that knew its harness may attribute the run to one.
        ...(current && harnessKnownThisTick ? { harnessVersionId: current.harness.versionId } : {}),
      });
      const ranOn = outcome.seatId ?? (outcome.dispatched ? cached?.seatDecision?.seatId ?? null : null);
      if (current && outcome.dispatched && ranOn) current.usedSeats.add(ranOn);
      if (current && harnessKnownThisTick && outcome.dispatched && outcome.proposalId) {
        harnessOfProposal.set(outcome.proposalId, current.harness.versionId);
      }
      if (current && hold) {
        const record: HeldItemRecord = {
          itemId: outcome.itemId,
          repo: repoNwo ?? dirLabel(outcome.repoPath),
          title,
          hold,
          seatDecision: cached?.seatDecision ?? null,
          at: outcome.at,
        };
        current.held.push(record);
        current.tickState = { ...current.tickState, held: [...current.held] };
        lastState = current.tickState;
        deps.writeTick(current.tickState);
      }
      if (taskId) {
        const nowMs = current?.nowMs ?? deps.now();
        let update: TaskDispatchUpdate | null = null;
        if (outcome.dispatched) {
          update = outcome.proposalId
            ? { kind: 'produced', proposalId: outcome.proposalId }
            : { kind: 'no-result', reason: outcome.skipReason ?? 'the dispatch produced no proposal' };
        } else if (hold) {
          // A park with no known reopening is retried next tick (stays queued);
          // a split waits for someone to slice it (parked, no date).
          if (hold.kind === 'split' || hold.nextEligibleAt !== null) {
            update = { kind: 'held', reason: hold.reason, parkedUntil: hold.kind === 'split' ? null : hold.nextEligibleAt };
          }
        }
        if (update) {
          try {
            deps.recordTask(taskId, update, nowMs);
          } catch { /* the task is retried next tick */ }
        }
      }
    },

    async afterLanding(record: LandingRecord): Promise<void> {
      deps.appendJournal({
        v: 1,
        type: 'landing',
        at: record.landedAt,
        landingId: record.id,
        kind: record.kind,
        repo: record.repo,
        prNumber: record.prNumber,
        proposalId: record.proposalId,
      });
      let registered: RegisterLandingResult;
      try {
        registered = deps.registerLanding(record);
      } catch (err) {
        registered = { ok: false, reason: describeError(err) };
      }
      if (!registered.ok) {
        // The watch re-discovers landings from the ledger each pass, so this
        // is recoverable — but it is said out loud.
        deps.audit({
          action: 'daemon:post-merge-watch',
          repo: record.repo,
          summary: `landing ${record.id} could not be registered for its post-merge watch: ${registered.reason}`,
          result: 'error',
        });
      }
    },

    fleetWorkItems(): WorkItem[] {
      return ctx ? [...ctx.fleetItems] : [];
    },

    standingBacklog(items: WorkItem[]): WorkItem[] {
      const merged = ctx && ctx.fleetItems.length > 0 ? mergeFleetTaskItems(items, ctx.fleetItems) : items;
      // Review c15: remembered for the experiment runner's idle check and
      // queue depth, and for the next tick's best-of-N reserve prediction.
      lastBacklogDepth = merged.length;
      lastBacklogItems = merged.slice(0, 500);
      lastFleetQueueDepth = Math.max(lastFleetQueueDepth, merged.length);
      return merged;
    },

    lastTickState(): FleetTickStateV1 | null {
      return lastState;
    },

    dispatchHarness(): { versionId: string | null; producerPrompt: string | null } | null {
      const current = ctx;
      if (!current) return null;
      const prompt = current.harness.config.prompts?.producer;
      return {
        versionId: current.harness.versionId,
        producerPrompt: typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : null,
      };
    },

    bestOfNPlan(item: WorkItem, opts: SeatAllowsOptions): AutonomousBestOfNPlan | null {
      const current = ctx;
      if (!current) return null;
      const route = current.routeCache.get(item.id);
      if (!route) return null;
      const already = plannedThisTick.get(item.id);
      if (already) return already;
      const engines = current.router.laneEngines;
      const allows = (engine: EngineId | null): boolean => {
        if (engine === null) return false;
        try {
          return hooks.seatAllows(engine, opts).allowed;
        } catch {
          return false;
        }
      };
      const taskId = fleetTaskIdOfItem(item);
      try {
        const plan = planStandingBestOfN({
          item,
          route,
          lanes: current.lanes,
          laneEngines: engines,
          mode: current.budget.mode,
          weights: current.routing,
          priorFailures: taskId ? current.taskAttempts.get(taskId) ?? 0 : 0,
          grokAllowed: allows(engines['grok-cli']),
          claudeAllowed: allows(engines['claude-cli']),
          // Review c15: candidates beyond the item's own pool slot spend the
          // tick's reserve; what one plan takes, the next cannot.
          fanoutBudget: current.fanoutBudget,
          cfg: current.cfg,
        });
        for (const lane of FLEET_ENGINES) {
          current.fanoutBudget[lane] = Math.max(0, current.fanoutBudget[lane] - plan.laneCharge[lane]);
        }
        const { laneCharge: _charged, ...out } = plan;
        plannedThisTick.set(item.id, out);
        return out;
      } catch {
        return null;
      }
    },

    async recordVerdicts(rows: readonly LedgerEntry[]): Promise<number> {
      let recorded = 0;
      let journalIndex: Map<string, string | null> | null = null;
      for (const row of rows) {
        if (row.kind !== 'gate:result') continue;
        const gate = row.data;
        if (gate.gate !== 'G3' || (gate.verdict !== 'pass' && gate.verdict !== 'refuse')) continue;
        const key = `${gate.proposalId}@${gate.headSha ?? ''}`;
        if (creditedVerdicts.has(key)) continue;
        let version: string | null | undefined = harnessOfProposal.has(gate.proposalId)
          ? harnessOfProposal.get(gate.proposalId)
          : undefined;
        if (version === undefined) {
          if (journalIndex === null) {
            try {
              journalIndex = proposalHarnessIndex(await deps.readJournalSince(deps.now() - LIVE_HOOKS_EVIDENCE_WINDOW_MS));
            } catch {
              journalIndex = new Map();
            }
          }
          version = journalIndex.has(gate.proposalId) ? journalIndex.get(gate.proposalId)! : undefined;
        }
        // Not a harness-attributed standing dispatch: no evidence for any version.
        if (version === undefined) continue;
        if (creditedVerdicts.size >= MAX_REMEMBERED_VERDICTS) creditedVerdicts.clear();
        creditedVerdicts.add(key);
        try {
          if (deps.recordHarnessOutcome({ passed: gate.verdict === 'pass', versionId: version, at: gate.at })) recorded += 1;
        } catch { /* the canary waits for evidence rather than failing the tick */ }
      }
      return recorded;
    },

    stopBackground(reason: string): void {
      stopExperiment(reason);
    },

    async afterStandingTick(): Promise<number> {
      const current = ctx;
      if (!current || current.tickState.dryRun || breachCheckedFor === current) return 0;
      breachCheckedFor = current;
      // The LIVE policy: a grant revoked during the tick has no floors to breach.
      let policy: EffectivePolicy | null;
      try {
        policy = deps.standingPolicy();
      } catch {
        policy = null;
      }
      if (!policy) return 0;
      // Fresh capacity: the point is what this tick's dispatches spent.
      let capacity: CapacitySnapshot | null;
      try {
        capacity = deps.capacitySnapshot();
      } catch {
        capacity = null;
      }
      try {
        return await deps.recordReserveBreaches({
          capacity,
          policy,
          now: new Date(deps.now()),
          // The seats this tick KNOWS it used, on top of the routing log F2 reads.
          ...(current.usedSeats.size > 0 ? { usedSeatIds: [...current.usedSeats] } : {}),
        });
      } catch (err) {
        deps.audit({
          action: 'daemon:reserve-breach',
          repo: null,
          summary: `reserve breaches could not be checked after the tick: ${describeError(err)}`,
          result: 'error',
        });
        return 0;
      }
    },
  };
  return hooks;
}

// ---------------------------------------------------------------------------
// The standing run (what runDaemon holds while a standing session is open)
// ---------------------------------------------------------------------------

export type StandingMintResult =
  | { ok: true; capability: DaemonActivationCapability }
  | { ok: false; reason: string };

export interface StandingRun {
  /** The CURRENT session (it changes when a closed session is reopened). */
  readonly sessionId: string;
  readonly grantId: string;
  readonly hooks: LiveTickHooks;
  /**
   * This tick's single-use `resident-standing` capability. B-U1 re-verifies
   * everything (grant, expiry, host, surface digest, revocation, KILL, switch,
   * ledger chain, confinement) on every call; any failure is a refusal and
   * the tick does not run. Never throws.
   */
  mint(): StandingMintResult;
  /** The ledger head seq right now: −1 when the ledger is empty, null when it cannot be read. */
  headSeq(): number | null;
  /** Landing / gate rows appended after `afterSeq`, oldest first. [] when unknown. Never throws. */
  rowsSince(afterSeq: number | null): Promise<LedgerEntry[]>;
  /** Run `afterLanding` for every merge / revert landing in `rows`. Returns how many. Never throws. */
  notifyLandings(rows: readonly LedgerEntry[]): Promise<number>;
  /**
   * Everything a tick's new ledger rows feed back: landings to `afterLanding`
   * (the post-merge watch) and G3 verification verdicts to the harness
   * canary (`recordVerdicts`). runDaemon calls this exactly once after every
   * standing tick, so it is also where the post-dispatch reserve-breach
   * check runs (`hooks.afterStandingTick`). Never throws.
   */
  notifyLedgerRows(rows: readonly LedgerEntry[]): Promise<{ landings: number; verdicts: number; reserveBreaches: number }>;
  /**
   * Resolves once the restricted-judge credential source is registered.
   * runDaemon awaits it before the first tick: a judge call that ran before
   * registration would take the pre-3.10 path (Mason's own CLI login) and
   * spend the reserve the grant protects. Never rejects.
   */
  ready(): Promise<void>;
  /**
   * Close the session on the record (B-U1 `closeStandingSession`) when the
   * daemon stops: later mints for it are refused, and the ledger shows the
   * session ended instead of leaving it open forever. Idempotent; never throws.
   */
  close(): void;
}

export const STANDING_RUN_LEDGER_KINDS: NonNullable<LedgerReadOptions['kinds']> = [
  'merge:landed',
  'revert:landed',
  'gate:result',
  'post-merge:result',
];

/** B-U1's refusal for a session this process does not hold open. */
export const UNKNOWN_SESSION_REASON = 'unknown or closed standing session';

/**
 * The restricted-judge credential wiring (U7 `setJudgeCredentialSource`,
 * U2 `claudeToken`). Injected so tests never touch the process-wide judge
 * source or the custody helper.
 */
export interface JudgeCredentialWiring {
  set(source: ((engine: 'claude') => Promise<Readonly<Record<string, string>> | null>) | null): void;
  claudeToken(): Promise<{ token: string }>;
  /** Is a standing policy in force right now (read per call, never cached here)? */
  standing(): boolean;
}

export interface CreateStandingRunInput {
  session: StandingSession;
  mint: (session: StandingSession) => MintStandingTickResult;
  /** B-U1 closeStandingSession; absent = nothing to record at close. */
  close?: (session: StandingSession) => void;
  /**
   * B-U1 openStandingSession for the same config. When a mint is refused as
   * "unknown or closed standing session" the run opens a fresh session once
   * and mints again; any other refusal is final for that tick.
   */
  reopen?: () => { ok: true; session: StandingSession } | { ok: false; reason: string };
  /** Absent = the production wiring (fleet/manager.ts + authority/custody-client.ts). */
  judgeCredentials?: JudgeCredentialWiring | null;
  hooks?: LiveTickHooks;
  deps?: Partial<Pick<LiveHooksDeps, 'readLedger' | 'ledgerHead'>>;
}

async function defaultJudgeCredentialWiring(): Promise<JudgeCredentialWiring> {
  // No manager module ⇒ no judge can run at all, so there is nothing to wire.
  const manager = await import('./manager.js');
  // A custody client that cannot load must still REFUSE standing judge calls
  // (a throwing source), never leave them on Mason's personal login.
  let custody: typeof import('../authority/custody-client.js') | null = null;
  try {
    custody = await import('../authority/custody-client.js');
  } catch {
    custody = null;
  }
  return {
    set: (source) => manager.setJudgeCredentialSource(source),
    claudeToken: () => (custody ? custody.claudeToken() : Promise.reject(new Error('the custody client is unavailable'))),
    standing: () => {
      try {
        return currentStandingPolicy() !== null;
      } catch {
        return false;
      }
    },
  };
}

/**
 * U7: while a standing policy is in force, restricted Claude judge calls run
 * on the claude-a token from custody — never on Mason's personal CLI login
 * (that would spend the reserve the grant protects). Outside a standing
 * policy the source answers null (no override), which is what interactive
 * `ashlr manager` runs use. A custody failure throws, and a throwing source
 * REFUSES the judge call (manager.ts) — it never falls back silently.
 */
export function judgeCredentialSourceFor(wiring: JudgeCredentialWiring): (engine: 'claude') => Promise<Readonly<Record<string, string>> | null> {
  return async () => (wiring.standing() ? { CLAUDE_CODE_OAUTH_TOKEN: (await wiring.claudeToken()).token } : null);
}

export function createStandingRun(input: CreateStandingRunInput): StandingRun {
  const hooks = input.hooks ?? createLiveTickHooks();
  const readLedgerDep = input.deps?.readLedger ?? ((opts: LedgerReadOptions) => readLedger(opts));
  const ledgerHeadDep = input.deps?.ledgerHead ?? (() => currentLedgerHead());
  let session = input.session;
  let closed = false;

  // Judge credentials: registered for the life of the session, cleared on close.
  let judgeWiring: JudgeCredentialWiring | null = null;
  let judgeReady: Promise<void> | null = null;
  if (input.judgeCredentials !== null) {
    const install = (wiring: JudgeCredentialWiring): void => {
      if (closed) return;
      judgeWiring = wiring;
      try {
        wiring.set(judgeCredentialSourceFor(wiring));
      } catch { /* judge calls then use the pre-3.10 path; G6 still needs a seat */ }
    };
    if (input.judgeCredentials) install(input.judgeCredentials);
    else judgeReady = defaultJudgeCredentialWiring().then(install, () => undefined);
  }

  const mintOnce = (): MintStandingTickResult | { ok: false; reason: string } => {
    try {
      return input.mint(session);
    } catch (err) {
      return { ok: false, reason: `the standing capability could not be minted (${describeError(err)})` };
    }
  };

  return {
    get sessionId(): string {
      return session.sessionId;
    },
    get grantId(): string {
      return session.grantId;
    },
    hooks,
    mint(): StandingMintResult {
      let minted = mintOnce();
      if (!minted.ok && minted.reason === UNKNOWN_SESSION_REASON && !closed && input.reopen) {
        // B-U1: a session this process no longer holds is replaced, not
        // retried forever — the new one is re-verified from scratch.
        try {
          const reopened = input.reopen();
          if (reopened.ok) {
            session = reopened.session;
            minted = mintOnce();
          } else {
            minted = { ok: false, reason: `the standing session could not be reopened: ${reopened.reason}` };
          }
        } catch (err) {
          minted = { ok: false, reason: `the standing session could not be reopened (${describeError(err)})` };
        }
      }
      if (!minted.ok) {
        // Authority withdrawn: nothing this session started keeps spending.
        try {
          hooks.stopBackground(`standing authority withdrawn: ${minted.reason}`);
        } catch { /* best effort */ }
        return { ok: false, reason: minted.reason };
      }
      return { ok: true, capability: minted.capability };
    },
    headSeq(): number | null {
      try {
        return ledgerHeadDep()?.seq ?? -1;
      } catch {
        return null;
      }
    },
    async rowsSince(afterSeq: number | null): Promise<LedgerEntry[]> {
      if (afterSeq === null) return [];
      try {
        const read = await readLedgerDep({ sinceSeq: afterSeq + 1, kinds: STANDING_RUN_LEDGER_KINDS });
        return read.entries;
      } catch {
        return [];
      }
    },
    async notifyLandings(rows: readonly LedgerEntry[]): Promise<number> {
      let count = 0;
      for (const row of rows) {
        if (row.kind !== 'merge:landed' && row.kind !== 'revert:landed') continue;
        try {
          await hooks.afterLanding(row.data);
          count += 1;
        } catch {
          // afterLanding failures are logged by the hook; never fail the loop.
        }
      }
      return count;
    },
    async ready(): Promise<void> {
      await judgeReady;
    },
    async notifyLedgerRows(rows: readonly LedgerEntry[]): Promise<{ landings: number; verdicts: number; reserveBreaches: number }> {
      const landings = await this.notifyLandings(rows);
      let verdicts = 0;
      try {
        verdicts = await hooks.recordVerdicts(rows);
      } catch {
        verdicts = 0;
      }
      let reserveBreaches = 0;
      try {
        reserveBreaches = typeof hooks.afterStandingTick === 'function' ? await hooks.afterStandingTick() : 0;
      } catch {
        reserveBreaches = 0;
      }
      return { landings, verdicts, reserveBreaches };
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        hooks.stopBackground('the standing session closed');
      } catch { /* best effort */ }
      const clearJudge = (): void => {
        try {
          judgeWiring?.set(null);
        } catch { /* best effort */ }
      };
      clearJudge();
      // A default wiring still loading installs nothing once closed (install
      // checks `closed`); clear again after it settles for good measure.
      void judgeReady?.then(clearJudge);
      try {
        input.close?.(session);
      } catch {
        // Best effort: a session that could not be closed on the record is
        // still dead — this process no longer mints for it.
      }
    },
  };
}
