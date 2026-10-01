/**
 * fleet-control.ts — the Fleet control surface's observations and actions
 * (3.15). The HTTP route is verse/fleet-control-api.ts; the wire contract is
 * fleet-control-types.ts; the verdict is the pure fleet-control-model.ts.
 *
 * EVERY CONTROL IS A REAL OPERATION, reusing the one path each already has:
 *   - Pause / Resume → daemon/pause.ts (`~/.ashlr/daemon.paused`): the loop
 *     stops DISPATCHING; runs in flight finish. Nothing else reads it.
 *   - Stop  → authority/clamp.ts `stopAutonomyAndDrain` — the same Stop as the
 *     Command bar and `ashlr authority stop`: KILL armed, every running agent
 *     aborted (this process at once, the daemon's within 2 s), armed merges
 *     revoked. The grant, the switch and the daemon service are left alone.
 *   - Start → the steps Start can take itself, each only when needed: clear
 *     Stop (ledgered first — authority/clamp.ts `clearStop`), resume dispatch,
 *     raise the switch from Off to Autonomous WITHIN the installed grant
 *     (`requestAutonomySwitch`, which refuses past it). What Start cannot do
 *     here comes back as `needs`: the Touch ID grant sheet, or starting the
 *     resident daemon — a native step in the desktop app (fleet_ops.rs), never
 *     a server-side launchctl call.
 *   - Stop ONE run → fleet/run-cancel.ts (the run's lease probe aborts it).
 *   - Interject → fleet engines run headless (no live input channel), so it is
 *     always stop + requeue with Mason's note appended to the task's brief.
 *   - Task edits → fleet/task-source.ts `editTaskAsOperator` / `cancelTask`.
 *   - Goal retarget → goals/store.ts `saveGoal`, to an ENROLLED checkout only.
 *
 * Idempotent: each step checks the current state first and says what it did
 * (`did`); pressing Pause twice pauses once. The answer's `state` is re-read
 * AFTER the action, never predicted.
 *
 * I/O note: this module does small synchronous reads of `~/.ashlr` (sentinels,
 * daemon.json, the lease directory) — never an operator folder, so it cannot
 * trip a macOS privacy prompt on the sidecar's thread.
 */
import { readFile, stat } from 'node:fs/promises';

import type { AuthorityStatusV1 } from '../authority/types.js';
import { daysLeft, buildFleetControlState, type FleetControlInputs } from './fleet-control-model.js';
import type {
  FleetControlAction,
  FleetControlActionResultV1,
  FleetControlQueueV1,
  FleetControlStateV1,
  FleetDaemonServiceState,
  FleetNextAction,
  FleetPlistState,
  FleetRunLogV1,
} from './fleet-control-types.js';
import type { CancelTaskResult, EnqueueTaskResult, FleetTask } from './fleet-types.js';
import { isRunId, requestRunCancel, runCancelRequested, type RequestRunCancelResult } from './run-cancel.js';
import type { TaskOperatorEdit, TaskQueueRead } from './task-source.js';
import { FLEET_ACTIONS, daemonRunning } from './fleet-control-model.js';
import { readTickProgress, describeTickProgress, type DaemonTickProgressRead } from '../daemon/tick-progress.js';
import type { DaemonLivenessV1 } from '../daemon/liveness.js';

// ---------------------------------------------------------------------------
// Dependencies (every one replaceable in tests; defaults load lazily)
// ---------------------------------------------------------------------------

export interface FleetControlDeps {
  now(): number;
  authority(): Promise<AuthorityStatusV1>;
  pause(): { paused: boolean; pausedAt: string | null };
  liveness(): FleetControlInputs['liveness'];
  service(): Promise<{ service: FleetDaemonServiceState; plist: FleetPlistState }>;
  /** Live execution leases (agents running now); null = unknown. */
  working(): number | null;
  spend(): Promise<FleetControlInputs['spend']>;
  hubCheckout(): Promise<string | null>;
  trustRootsCompiled(): boolean;
  // effects
  setPause(paused: boolean): { ok: boolean; changed: boolean; reason: string };
  /** `aborted`: agents told to halt that had not exited when Stop answered (null = unknown). */
  stop(): Promise<{ armed: boolean; reason: string; aborted: number | null }>;
  clearStop(): { ok: boolean; reason: string };
  raiseSwitch(): { ok: boolean; code: string | null; reason: string };
  cancelRun(runId: string, reason: string): RequestRunCancelResult;
  editTask(edit: TaskOperatorEdit): CancelTaskResult;
  cancelTask(taskId: string, reason: string): CancelTaskResult;
  enqueueTask(input: { repo: string; title: string; detail: string }): EnqueueTaskResult;
  tasks(): TaskQueueRead;
  goals(): Promise<FleetControlQueueV1['goals']>;
  retargetGoal(goalId: string, project: string): Promise<{ ok: boolean; reason: string }>;
  enrolledPaths(): Promise<string[]>;
  grantedRepos(): Promise<string[]>;
  readRunLog(runId: string): Promise<Omit<FleetRunLogV1, 'v' | 'runId' | 'stopRequestedAt'>>;
}

const HUB = 'ashlrai/ashlr-hub';

async function defaultService(): Promise<{ service: FleetDaemonServiceState; plist: FleetPlistState }> {
  let service: FleetDaemonServiceState = 'unknown';
  let plist: FleetPlistState = 'unknown';
  try {
    const svc = await import('../daemon/service.js');
    const { daemonServiceInstallOptions } = await import('../daemon/service-config.js');
    const { loadConfigReadOnly } = await import('../config.js');
    const { plistBudgetUsd } = await import('../authority/resident.js');
    const status = svc.serviceStatusCached();
    service = status.running ? 'running'
      : status.registrationState === 'absent' ? 'absent'
        : status.runtimeState === 'ready' ? 'loaded'
          : status.runtimeState === 'stopped' || status.runtimeState === 'disabled' ? 'not-loaded'
            : 'unknown';
    // Drift by BUDGET, not byte-for-byte: this process may be the desktop's
    // single-file sidecar, whose own executable path would make every plist
    // look different from what `resident start` (the npm CLI) writes. The
    // budget is the documented trap (docs/RESIDENT-RUNTIME.md "Plist budget").
    const opts = daemonServiceInstallOptions(loadConfigReadOnly(), { autostart: true });
    const def = svc.generateServiceDefinition(opts);
    let installed: string | null = null;
    try {
      installed = await readFile(def.filePath, 'utf8');
    } catch (error) {
      installed = (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : '';
    }
    if (installed === null) plist = 'absent';
    else if (installed === '') plist = 'unknown';
    else {
      const got = plistBudgetUsd(installed);
      plist = got === null ? 'unknown' : got === (opts.budget ?? null) ? 'current' : 'drifted';
    }
  } catch {
    // unknown stays unknown
  }
  return { service, plist };
}

// The ashlr-hub checkout the custody helper is built from (tools/custody).
// FULLY ASYNC on purpose: enrolled checkouts often live under ~/Desktop or
// ~/Documents, and a synchronous read there from the sidecar's thread can
// freeze it on a macOS privacy prompt (#518). Cached five minutes.
const HUB_CHECKOUT_TTL_MS = 5 * 60_000;
let hubCheckoutCache: { at: number; value: string | null } | null = null;

async function readSmallAsync(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function gitConfigTextAsync(repoPath: string): Promise<string | null> {
  const { join, isAbsolute, resolve } = await import('node:path');
  const dotGit = join(repoPath, '.git');
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    return null;
  }
  if (info.isDirectory()) return readSmallAsync(join(dotGit, 'config'));
  const pointer = await readSmallAsync(dotGit);
  const match = pointer ? /^gitdir:\s*(.+)$/mu.exec(pointer) : null;
  if (!match) return null;
  const gitdir = isAbsolute(match[1]!.trim()) ? match[1]!.trim() : resolve(repoPath, match[1]!.trim());
  const common = await readSmallAsync(join(gitdir, 'commondir'));
  return readSmallAsync(join(common ? resolve(gitdir, common.trim()) : gitdir, 'config'));
}

async function findHubCheckout(): Promise<string | null> {
  const { originUrlFromConfig, nameWithOwnerFromRemote, fleetMirrorsDir } = await import('./repo-identity.js');
  const { resolve, dirname } = await import('node:path');
  const mirrors = resolve(fleetMirrorsDir());
  for (const path of await defaultEnrolledPaths()) {
    if (resolve(dirname(path)) === mirrors) continue; // the fleet's own clones
    try {
      await stat(`${path}/scripts/install-custody.sh`);
      await stat(`${path}/tools/custody/Package.swift`);
    } catch {
      continue;
    }
    const text = await gitConfigTextAsync(path);
    const url = text ? originUrlFromConfig(text) : null;
    if (url && nameWithOwnerFromRemote(url)?.toLowerCase() === HUB) return path;
  }
  return null;
}

async function hubCheckoutCached(): Promise<string | null> {
  const now = Date.now();
  if (hubCheckoutCache && now - hubCheckoutCache.at < HUB_CHECKOUT_TTL_MS) return hubCheckoutCache.value;
  let value: string | null = null;
  try {
    value = await findHubCheckout();
  } catch {
    value = null;
  }
  hubCheckoutCache = { at: now, value };
  return value;
}

async function defaultEnrolledPaths(): Promise<string[]> {
  const { readEnrollmentRegistry } = await import('../sandbox/policy.js');
  const registry = readEnrollmentRegistry();
  return registry.state === 'ready' ? [...registry.repos] : [];
}

export function defaultFleetControlDeps(): FleetControlDeps {
  return {
    now: () => Date.now(),
    authority: async () => (await (await import('../verse/authority-api.js')).buildAuthorityStatus()).status,
    pause: () => {
      // Lazy require-free: pause.ts is tiny and already loaded by the server.
      return pauseRead();
    },
    liveness: () => livenessRead(),
    service: defaultService,
    working: () => workingRead(),
    spend: async () => {
      try {
        const { loadDaemonState } = await import('../daemon/state.js');
        const { daemonServiceInstallOptions } = await import('../daemon/service-config.js');
        const { loadConfigReadOnly } = await import('../config.js');
        const state = loadDaemonState();
        const today = new Date().toISOString().slice(0, 10);
        const todayUsd = state.todayDate === null ? null : state.todayDate === today ? state.todaySpentUsd : 0;
        const cap = daemonServiceInstallOptions(loadConfigReadOnly()).budget ?? null;
        return { todayUsd, capUsd: cap };
      } catch {
        return { todayUsd: null, capUsd: null };
      }
    },
    hubCheckout: () => hubCheckoutCached(),
    trustRootsCompiled: () => trustRootsRead(),
    setPause: (paused) => pauseWrite(paused),
    stop: async () => {
      const { stopAutonomyAndDrain } = await import('../authority/clamp.js');
      const { invalidateStandingPolicyCache } = await import('../authority/effective-config.js');
      const result = await stopAutonomyAndDrain({ actor: 'mason', reason: 'Stop pressed in the Fleet tab', drainMs: 0, waitMs: 0 });
      invalidateStandingPolicyCache();
      const live = result.liveExecutionLeases;
      return { armed: result.armed, reason: result.reason, aborted: typeof live === 'number' ? live : null };
    },
    clearStop: () => clearStopWrite(),
    raiseSwitch: () => raiseSwitchWrite(),
    cancelRun: (runId, reason) => requestRunCancel(runId, reason),
    editTask: (edit) => taskSource().editTaskAsOperator(edit),
    cancelTask: (taskId, reason) => taskSource().cancelTask({ taskId, reason, actor: 'mason' }),
    enqueueTask: (input) => taskSource().enqueueTask({
      repo: input.repo,
      source: 'manual',
      title: input.title,
      detail: input.detail,
      difficulty: 'medium',
      value: 4,
      requestedBy: 'mason',
    }),
    tasks: () => taskSource().readTaskQueue(),
    goals: async () => {
      const { listGoals } = await import('../goals/store.js');
      return listGoals()
        .filter((goal) => goal.status !== 'done' && goal.status !== 'archived')
        .slice(0, 100)
        .map((goal) => ({ id: goal.id, objective: goal.objective.slice(0, 300), status: goal.status, project: goal.project, missionBound: goal.mission !== undefined }));
    },
    retargetGoal: async (goalId, project) => {
      const { loadGoal, saveGoal } = await import('../goals/store.js');
      const { isEnrolledAsync } = await import('../sandbox/policy.js');
      const { expandHomePrefix } = await import('../verse/path-guard.js');
      const { resolve } = await import('node:path');
      project = resolve(expandHomePrefix(project));
      const goal = loadGoal(goalId);
      if (!goal) return { ok: false, reason: `No goal ${goalId} exists.` };
      if (goal.mission !== undefined) return { ok: false, reason: 'That goal is bound to a signed mission; change its repo in the mission instead.' };
      if (!(await isEnrolledAsync(project))) return { ok: false, reason: 'A goal can only target an enrolled repo.' };
      if (goal.project === project) return { ok: true, reason: 'already targets that repo' };
      const saved = saveGoal({ ...goal, project, updatedAt: new Date().toISOString() });
      return saved ? { ok: true, reason: 'retargeted' } : { ok: false, reason: 'The goal could not be saved (another writer holds it); try again.' };
    },
    enrolledPaths: defaultEnrolledPaths,
    grantedRepos: async () => {
      const status = (await (await import('../verse/authority-api.js')).buildAuthorityStatus()).status;
      return status.grant.repos.map((repo) => repo.nameWithOwner);
    },
    readRunLog: defaultRunLog,
  };
}

// The synchronous defaults are bound lazily through a module cache so the
// first request pays the import once and the pure paths stay import-free.
type PauseModule = typeof import('../daemon/pause.js');
type LivenessModule = typeof import('../daemon/liveness.js');
type LeaseModule = typeof import('../sandbox/execution-leases.js');
type TaskModule = typeof import('./task-source.js');
let modules: { pause: PauseModule; liveness: LivenessModule; leases: LeaseModule; tasks: TaskModule; trust: boolean; clamp: typeof import('../authority/clamp.js'); eff: typeof import('../authority/effective-config.js') } | null = null;

/** Load the synchronous dependencies once (called by the route before any sync default runs). */
export async function preloadFleetControlModules(): Promise<void> {
  if (modules) return;
  const [pause, liveness, leases, tasks, trust, clamp, eff] = await Promise.all([
    import('../daemon/pause.js'),
    import('../daemon/liveness.js'),
    import('../sandbox/execution-leases.js'),
    import('./task-source.js'),
    import('../authority/trust-roots.js'),
    import('../authority/clamp.js'),
    import('../authority/effective-config.js'),
  ]);
  modules = { pause, liveness, leases, tasks, trust: trust.STANDING_GRANT_TRUST_ROOTS.length > 0, clamp, eff };
}

function loaded(): NonNullable<typeof modules> {
  if (!modules) throw new Error('fleet control modules are not loaded yet');
  return modules;
}

function pauseRead(): { paused: boolean; pausedAt: string | null } {
  const read = loaded().pause.readDaemonPause();
  // Unreadable counts as paused, exactly as the loop reads it.
  return { paused: read.state !== 'running', pausedAt: read.record?.pausedAt ?? null };
}

function pauseWrite(paused: boolean): { ok: boolean; changed: boolean; reason: string } {
  const m = loaded().pause;
  const result = paused ? m.pauseDaemon('verse-control-plane') : m.resumeDaemon('verse-control-plane');
  return { ok: result.ok, changed: result.changed, reason: result.reason };
}

/** A reused PID or completed tick record must never make an idle fleet look busy. */
export function projectFleetControlTickProgress(live: DaemonLivenessV1, tick: DaemonTickProgressRead | null, nowMs: number): FleetControlStateV1['daemon']['tickProgress'] {
  if (live.state !== 'alive' || live.alive !== true || live.pid === null || !tick || tick.progress.pid !== live.pid
    || live.recorded.running !== true || live.recorded.pid !== live.pid || !Number.isFinite(nowMs)) return null;
  const started = Date.parse(live.recorded.startedAt ?? '');
  const completed = Date.parse(live.recorded.lastTickAt ?? '');
  const tickAt = Date.parse(tick.progress.tickStartedAt);
  const phaseAt = Date.parse(tick.progress.phaseStartedAt);
  if (!Number.isFinite(started) || !Number.isFinite(tickAt) || !Number.isFinite(phaseAt)
    || tickAt < started || phaseAt < tickAt || phaseAt > nowMs
    || (Number.isFinite(completed) && tickAt <= completed)) return null;
  return { phase: tick.progress.phase, detail: tick.progress.detail,
    tickStartedAt: tick.progress.tickStartedAt, phaseStartedAt: tick.progress.phaseStartedAt,
    summary: describeTickProgress(tick) };
}

function livenessRead(): FleetControlInputs['liveness'] {
  const live = loaded().liveness.probeDaemonLiveness();
  const nowMs = Date.now();
  const tickProgress = live.state === 'alive' && live.pid !== null
    ? projectFleetControlTickProgress(live, readTickProgress({ expectPid: live.pid, nowMs }), nowMs) : null;
  return { state: live.state, pid: live.pid, lastTickAt: live.recorded.lastTickAt, reason: live.reason,
    ...(tickProgress ? { tickProgress } : {}) };
}

function workingRead(): number | null {
  const census = loaded().leases.censusExecutionLeases();
  return census.unknown > 0 && census.leases.length === 0 ? null : census.leases.length;
}

function trustRootsRead(): boolean {
  return loaded().trust;
}

function clearStopWrite(): { ok: boolean; reason: string } {
  const m = loaded();
  const result = m.clamp.clearStop({ actor: 'mason', reason: 'Start pressed in the Fleet tab', waitMs: 0 });
  m.eff.invalidateStandingPolicyCache();
  return { ok: result.ok, reason: result.ok ? 'Stop cleared' : result.reason };
}

function raiseSwitchWrite(): { ok: boolean; code: string | null; reason: string } {
  const result = loaded().eff.requestAutonomySwitch('autonomous', 'mason', 'Start pressed in the Fleet tab');
  return result.ok ? { ok: true, code: null, reason: 'switched to Autonomous' } : { ok: false, code: result.code, reason: result.reason };
}

function taskSource(): TaskModule {
  return loaded().tasks;
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

const LOG_TAIL_BYTES = 64 * 1024;
const LOG_MAX_LINES = 400;
const LOG_LINE_CHARS = 2_000;

async function defaultRunLog(runId: string): Promise<Omit<FleetRunLogV1, 'v' | 'runId' | 'stopRequestedAt'>> {
  const streaming = await import('../run/streaming.js');
  const { scrubSecrets } = await import('../util/scrub.js');
  const path = streaming.runStreamFilePath(runId);
  if (!path) return { available: false, reason: 'That run id has no output stream.', lines: [], truncated: false };
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return {
      available: false,
      reason: 'No output was kept for this run. Live run output is captured only with foundry.runOutputPersistence.enabled in config (it is off by default, for privacy).',
      lines: [],
      truncated: false,
    };
  }
  const offset = Math.max(0, size - LOG_TAIL_BYTES);
  const chunk = streaming.readRunStreamChunk(runId, offset);
  if (!chunk) return { available: false, reason: 'The run output could not be read safely.', lines: [], truncated: false };
  const text = chunk.bytes.toString('utf8');
  const raw = text.split('\n');
  if (offset > 0) raw.shift(); // a partial first line
  const lines: FleetRunLogV1['lines'] = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { kind?: unknown; text?: unknown; ts?: unknown; data?: unknown };
      const body = typeof event.text === 'string' ? event.text : event.data !== undefined ? JSON.stringify(event.data) : '';
      if (!body) continue;
      lines.push({ ts: typeof event.ts === 'string' ? event.ts : null, kind: typeof event.kind === 'string' ? event.kind : 'log', text: scrubSecrets(body).slice(0, LOG_LINE_CHARS) });
    } catch {
      lines.push({ ts: null, kind: 'log', text: scrubSecrets(line).slice(0, LOG_LINE_CHARS) });
    }
  }
  const truncated = offset > 0 || lines.length > LOG_MAX_LINES;
  return { available: true, reason: null, lines: lines.slice(-LOG_MAX_LINES), truncated };
}

export async function readFleetRunLog(runId: string, deps: FleetControlDeps): Promise<FleetRunLogV1> {
  const stopRequestedAt = runCancelRequested(runId)?.requestedAt ?? null;
  const log = await deps.readRunLog(runId);
  return { v: 1, runId, ...log, stopRequestedAt };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function readFleetControlState(deps: FleetControlDeps): Promise<FleetControlStateV1> {
  const nowMs = deps.now();
  const [authority, service, spend, hubCheckout] = await Promise.all([deps.authority(), deps.service(), deps.spend(), deps.hubCheckout()]);
  const pause = deps.pause();
  const g = authority.grant;
  const rollout = authority.rollout as { stageId?: string; stageIndex?: number; stageCount?: number } | null;
  const inputs: FleetControlInputs = {
    nowMs,
    grant: {
      state: g.state,
      seq: g.grantSeq,
      repos: g.repos.map((repo) => repo.nameWithOwner),
      engines: [...g.engines],
      expiresAt: g.expiresAt,
      daysLeft: g.state === 'active' ? daysLeft(g.expiresAt, nowMs) : null,
      stageId: rollout?.stageId ?? null,
      stageIndex: typeof rollout?.stageIndex === 'number' ? rollout.stageIndex : null,
      stageCount: typeof rollout?.stageCount === 'number' ? rollout.stageCount : null,
      switch: authority.switch,
      effectiveSwitch: authority.effectiveSwitch,
      maxSwitchWithoutGrant: authority.maxSwitchWithoutGrant,
      reason: g.reason,
    },
    custody: { installed: authority.custody.installed, keyInitialized: authority.custody.keyInitialized, hubCheckout },
    trustRootsCompiled: deps.trustRootsCompiled(),
    kill: authority.kill,
    paused: pause.paused,
    pausedAt: pause.pausedAt,
    liveness: deps.liveness(),
    service: service.service,
    plist: service.plist,
    working: deps.working(),
    spend,
  };
  return buildFleetControlState(inputs);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export class FleetControlError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

const ACTION_KEYS: Readonly<Record<FleetControlAction['action'], readonly string[]>> = Object.freeze({
  start: ['action'],
  pause: ['action'],
  resume: ['action'],
  stop: ['action'],
  'stop-run': ['action', 'runId', 'reason', 'taskId'],
  interject: ['action', 'note', 'runId', 'taskId', 'repo', 'title'],
  'task-edit': ['action', 'taskId', 'value', 'repo'],
  'task-cancel': ['action', 'taskId'],
  'goal-retarget': ['action', 'goalId', 'project'],
});

const TASK_ID_RE = /^[a-f0-9-]{36}$/u;
const GOAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NAME_WITH_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;

function invalid(message: string): FleetControlError {
  return new FleetControlError(400, 'VERSE_INVALID', message);
}

function optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw invalid(`${key} must be text of at most ${max} characters`);
  return value;
}

/** PURE-ish: validate an untrusted body into one action (throws FleetControlError 400). */
export function parseFleetControlAction(body: Record<string, unknown>): FleetControlAction {
  const action = body['action'];
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_KEYS, action)) {
    throw invalid(`action must be one of: ${Object.keys(ACTION_KEYS).join(', ')}`);
  }
  const allowed = ACTION_KEYS[action as FleetControlAction['action']];
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw invalid(`unknown key for ${action}: ${key}`);
  switch (action) {
    case 'start':
    case 'pause':
    case 'resume':
    case 'stop':
      return { action };
    case 'stop-run': {
      if (!isRunId(body['runId']) || String(body['runId']).startsWith('task:') || String(body['runId']).startsWith('held:')) throw invalid('runId must be a running run id');
      const taskId = optionalText(body, 'taskId', 36);
      if (taskId !== undefined && !TASK_ID_RE.test(taskId)) throw invalid('taskId must be a task id');
      const reason = optionalText(body, 'reason', 300);
      return { action, runId: body['runId'] as string, ...(reason !== undefined ? { reason } : {}), ...(taskId !== undefined ? { taskId } : {}) };
    }
    case 'interject': {
      const note = optionalText(body, 'note', 1_000);
      if (!note || !note.trim()) throw invalid('note is required');
      const runId = body['runId'];
      if (runId !== undefined && (!isRunId(runId) || String(runId).startsWith('held:'))) throw invalid('runId must be a run id');
      const taskId = optionalText(body, 'taskId', 36);
      if (taskId !== undefined && !TASK_ID_RE.test(taskId)) throw invalid('taskId must be a task id');
      const repo = optionalText(body, 'repo', 140);
      if (repo !== undefined && !NAME_WITH_OWNER_RE.test(repo)) throw invalid('repo must be owner/name');
      const title = optionalText(body, 'title', 200);
      if (taskId === undefined && (repo === undefined || title === undefined)) throw invalid('interject needs taskId, or repo and title to queue a follow-up');
      return {
        action,
        note,
        ...(runId !== undefined ? { runId: runId as string } : {}),
        ...(taskId !== undefined ? { taskId } : {}),
        ...(repo !== undefined ? { repo } : {}),
        ...(title !== undefined ? { title } : {}),
      };
    }
    case 'task-edit': {
      const taskId = body['taskId'];
      if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) throw invalid('taskId must be a task id');
      const value = body['value'];
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5)) throw invalid('value must be a whole number from 1 to 5');
      const repo = optionalText(body, 'repo', 140);
      if (repo !== undefined && !NAME_WITH_OWNER_RE.test(repo)) throw invalid('repo must be owner/name');
      if (value === undefined && repo === undefined) throw invalid('task-edit needs value or repo');
      return { action, taskId, ...(value !== undefined ? { value } : {}), ...(repo !== undefined ? { repo } : {}) };
    }
    case 'task-cancel': {
      const taskId = body['taskId'];
      if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) throw invalid('taskId must be a task id');
      return { action, taskId };
    }
    default: {
      const goalId = body['goalId'];
      const project = body['project'];
      if (typeof goalId !== 'string' || !GOAL_ID_RE.test(goalId)) throw invalid('goalId must be a goal id');
      // `~/…` is how the public JSON spells this user's home (sanitizePublicJson).
      if (typeof project !== 'string' || !(project.startsWith('/') || project.startsWith('~/')) || project.length > 1_024 || project.includes('\0')) throw invalid('project must be an absolute path');
      return { action: 'goal-retarget', goalId, project };
    }
  }
}

/** Apply one action as Mason and read the state back. */
export async function applyFleetControlAction(action: FleetControlAction, deps: FleetControlDeps): Promise<FleetControlActionResultV1> {
  const did: string[] = [];
  let needs: FleetNextAction | null = null;
  let mode: FleetControlActionResultV1['mode'];
  switch (action.action) {
    case 'pause': {
      const r = deps.setPause(true);
      if (!r.ok) throw new FleetControlError(503, 'pause-failed', `Pause could not be written: ${r.reason}`);
      if (r.changed) did.push('Paused dispatch — runs in flight finish, nothing new starts.');
      break;
    }
    case 'resume': {
      const r = deps.setPause(false);
      if (!r.ok) throw new FleetControlError(503, 'resume-failed', `Resume could not be written: ${r.reason}`);
      if (r.changed) did.push('Resumed dispatch.');
      break;
    }
    case 'stop': {
      const before = await deps.authority();
      if (!before.kill) {
        const r = await deps.stop();
        if (!r.armed) throw new FleetControlError(503, 'stop-failed', `Stop could not be armed: ${r.reason}`);
        did.push(r.aborted !== null && r.aborted > 0 ? `Stopped — ${r.aborted} agent${r.aborted === 1 ? ' is' : 's are'} winding down; nothing new runs.` : 'Stopped — nothing runs.');
      }
      break;
    }
    case 'start': {
      const before = await deps.authority();
      const g = before.grant;
      if (g.state === 'none' || g.state === 'revoked' || g.state === 'invalid') {
        needs = FLEET_ACTIONS.grant;
        break;
      }
      if (g.state === 'expired' || g.state === 'paused') {
        needs = FLEET_ACTIONS.reapprove;
        break;
      }
      // Validate authority before touching Stop or dispatch pause. Only Off is
      // raised: Propose is a running mode Mason chose on purpose.
      if (before.switch === 'off') {
        const r = deps.raiseSwitch();
        if (r.ok) did.push('Switched to Autonomous.');
        else if (r.code === 'grant-required') {
          needs = FLEET_ACTIONS.grant;
          break;
        } else throw new FleetControlError(409, r.code ?? 'switch-failed', r.reason);
      }
      // Raising the switch re-evaluates the grant internally. Read it again
      // before removing either safety clamp in case authority changed meanwhile.
      const current = await deps.authority();
      if (current.grant.state !== 'active') {
        needs = current.grant.state === 'expired' || current.grant.state === 'paused'
          ? FLEET_ACTIONS.reapprove : FLEET_ACTIONS.grant;
        break;
      }
      if (current.kill) {
        const r = deps.clearStop();
        if (!r.ok) throw new FleetControlError(409, 'clear-stop-failed', `Stop could not be cleared: ${r.reason}`);
        did.push('Cleared Stop.');
      }
      if (deps.pause().paused) {
        const r = deps.setPause(false);
        if (!r.ok) throw new FleetControlError(503, 'resume-failed', `Resume could not be written: ${r.reason}`);
        if (r.changed) did.push('Resumed dispatch.');
      }
      if (!daemonRunning({ liveness: deps.liveness(), service: (await deps.service()).service })) needs = FLEET_ACTIONS.residentStart;
      break;
    }
    case 'stop-run': {
      const r = deps.cancelRun(action.runId, action.reason ?? 'stopped from the Fleet tab');
      if (!r.ok) throw new FleetControlError(409, 'stop-run-failed', r.reason);
      did.push(r.already ? 'That run was already asked to stop.' : 'Asked the run to stop — it halts within a few seconds.');
      if (action.taskId) {
        const t = deps.editTask({ taskId: action.taskId, requeue: false, note: `stopped by you: ${action.reason ?? 'from the Fleet tab'}` });
        if (t.ok) did.push('Noted on its task.');
      }
      break;
    }
    case 'interject': {
      // No fleet engine takes input mid-run (they run headless), so steering
      // is always: stop the run, put the note in the brief, queue it again.
      if (!action.taskId) {
        const granted = (await deps.grantedRepos()).map((r) => r.toLowerCase());
        if (!granted.includes(action.repo!.toLowerCase())) throw new FleetControlError(409, 'repo-not-granted', `${action.repo} is not in the standing grant, so the fleet cannot work on it.`);
      }
      mode = action.runId ? 'stop-and-requeue' : 'requeue';
      if (action.runId && !action.runId.startsWith('task:')) {
        const r = deps.cancelRun(action.runId, `interjected: ${action.note.slice(0, 200)}`);
        if (!r.ok) throw new FleetControlError(409, 'stop-run-failed', r.reason);
        did.push('Stopped the run.');
      }
      if (action.taskId) {
        const t = deps.editTask({ taskId: action.taskId, note: action.note, requeue: true });
        if (!t.ok) throw new FleetControlError(409, 'task-edit-failed', t.reason);
        did.push('Added your note to its brief and put it back in the queue.');
      } else {
        const q = deps.enqueueTask({ repo: action.repo!, title: `Follow-up: ${action.title!}`.slice(0, 200), detail: `Mason interjected on a run of "${action.title!}":\n\n${action.note}` });
        if (!q.ok) throw new FleetControlError(409, 'enqueue-failed', q.reason);
        did.push(q.deduped ? 'A follow-up with this note is already queued.' : 'Queued a follow-up task carrying your note.');
      }
      break;
    }
    case 'task-edit': {
      if (action.repo !== undefined) {
        const granted = (await deps.grantedRepos()).map((r) => r.toLowerCase());
        if (!granted.includes(action.repo.toLowerCase())) throw new FleetControlError(409, 'repo-not-granted', `${action.repo} is not in the standing grant, so the fleet cannot work on it.`);
      }
      const r = deps.editTask({ taskId: action.taskId, ...(action.value !== undefined ? { value: action.value } : {}), ...(action.repo !== undefined ? { repo: action.repo } : {}) });
      if (!r.ok) throw new FleetControlError(409, 'task-edit-failed', r.reason);
      if (action.value !== undefined) did.push(`Priority set to ${action.value} of 5.`);
      if (action.repo !== undefined) did.push(`Retargeted to ${action.repo}.`);
      break;
    }
    case 'task-cancel': {
      const r = deps.cancelTask(action.taskId, 'cancelled from the Fleet tab');
      if (!r.ok) throw new FleetControlError(409, 'task-cancel-failed', r.reason);
      did.push('Cancelled the task.');
      break;
    }
    case 'goal-retarget': {
      const r = await deps.retargetGoal(action.goalId, action.project);
      if (!r.ok) throw new FleetControlError(409, 'goal-retarget-failed', r.reason);
      if (r.reason === 'retargeted') did.push('Retargeted the goal.');
      break;
    }
  }
  const state = await readFleetControlState(deps);
  return { ok: true, action: action.action, did, needs, ...(mode ? { mode } : {}), state };
}

// ---------------------------------------------------------------------------
// Queue (tasks + goals to edit)
// ---------------------------------------------------------------------------

export async function readFleetControlQueue(deps: FleetControlDeps): Promise<FleetControlQueueV1> {
  const read = deps.tasks();
  const reasons: string[] = [];
  const tasks: FleetControlQueueV1['tasks'] = [];
  if (read.ok) {
    for (const task of read.tasks as FleetTask[]) {
      if (task.status !== 'queued' && task.status !== 'parked' && task.status !== 'dispatched') continue;
      tasks.push({ id: task.id, repo: task.repo, title: task.title, status: task.status, value: task.value, source: task.source, updatedAt: task.updatedAt });
    }
  } else reasons.push(read.reason);
  tasks.sort((a, b) => b.value - a.value || a.updatedAt.localeCompare(b.updatedAt));
  let goals: FleetControlQueueV1['goals'] = [];
  try {
    goals = await deps.goals();
  } catch {
    reasons.push('the goals could not be read');
  }
  const [paths, repos] = await Promise.all([deps.enrolledPaths().catch(() => []), deps.grantedRepos().catch(() => [])]);
  return { v: 1, tasks: tasks.slice(0, 200), goals, targets: { paths, repos }, reason: reasons.length ? reasons.join('; ') : null };
}
