/** Default-off child scheduler for the observation-only Agent OS compiler. */

import { createHash } from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AshlrConfig, DaemonTick } from '../types.js';
import {
  AGENT_OS_OBSERVER_ATTEMPT_MAX_RECORDS,
  defaultAgentOsObserverAttemptStoreDependenciesV1,
  readAgentOsObserverAttemptReceiptsV1,
  type AgentOsObserverAttemptReceiptV1,
  type AgentOsObserverAttemptStoreDependenciesV1,
} from '../vision/agent-os-observer-attempt-store.js';
import {
  defaultAgentOsSourceBundleStoreDependenciesV1,
  readAgentOsSourceBundleStoreV1,
  type AgentOsSourceBundleStoreReadResultV1,
} from '../vision/agent-os-source-bundle-store.js';
import {
  agentOsSourceTrustPolicyDigestV1,
  type AgentOsSourceTrustPolicyV1,
} from '../vision/agent-os-source-bundle.js';
import {
  defaultAgentOsSnapshotStoreDependenciesV1,
  readAgentOsSnapshotsV1,
  type AgentOsSnapshotReadResultV1,
} from '../vision/agent-os-snapshot-store.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { loadDaemonStateStrict } from './state.js';

const DEFAULT_DEADLINE_MS = 5_000;
const MIN_DEADLINE_MS = 100;
const MAX_DEADLINE_MS = 30_000;
const KILL_CONFIRM_MS = 1_000;
const FUTURE_TOLERANCE_MS = 5_000;
const SOURCE_RETRY_BACKOFF_MS = 60_000;
const SOURCE_RETRY_LIMIT = 3;
const DIGEST_RE = /^[a-f0-9]{64}$/;

export interface ResolvedAgentOsObserverConfigV1 {
  enabled: boolean;
  valid: boolean;
  deadlineMs: number;
  trustPolicy: AgentOsSourceTrustPolicyV1 | null;
  trustPolicyDigest: string | null;
}

export type AgentOsObserverScheduleDispositionV1 =
  | 'scheduled'
  | 'disabled'
  | 'overlap-suppressed'
  | 'already-observed'
  | 'source-retry-backoff'
  | 'source-retry-exhausted'
  | 'invalid-tick'
  | 'configuration-degraded'
  | 'source-missing'
  | 'source-degraded'
  | 'attempt-store-degraded'
  | 'snapshot-store-degraded'
  | 'attempt-capacity-exhausted'
  | 'cancelled'
  | 'spawn-failed';

export type AgentOsObserverAttemptLedgerDecisionV1 =
  | { state: 'missing' }
  | { state: 'source-observed' }
  | { state: 'snapshot-repair-required' }
  | { state: 'snapshot-store-degraded' }
  | { state: 'retry-backoff' }
  | { state: 'retry-exhausted' }
  | { state: 'capacity-exhausted' }
  | {
      state: 'resume-started';
      attemptId: string;
      tickDigest: string;
      tickAt: string;
      deadlineAt: string;
      bundleDigest: string;
    }
  | { state: 'degraded' };

export interface AgentOsObserverChildResultV1 {
  outcome: 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'degraded-stuck';
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ScheduledAgentOsObserverV1 {
  disposition: AgentOsObserverScheduleDispositionV1;
  attemptId: string | null;
  tickDigest: string | null;
  sourceState: AgentOsSourceBundleStoreReadResultV1['sourceState'] | 'not-read';
  sourceStopReasons: readonly string[];
  completion: Promise<AgentOsObserverChildResultV1>;
  cancel: () => void;
}

/** Process-local visibility only. Durable truth remains in source/snapshot/attempt stores. */
export interface AgentOsObserverSchedulerStatusV1 {
  durable: false;
  active: boolean;
  lastDisposition: AgentOsObserverScheduleDispositionV1 | null;
  lastAttemptId: string | null;
  lastTickDigest: string | null;
  sourceState: ScheduledAgentOsObserverV1['sourceState'];
  sourceStopReasons: readonly string[];
  childOutcome: AgentOsObserverChildResultV1['outcome'] | null;
}

interface ChildHandle {
  pid?: number;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ScheduleAgentOsObserverOptionsV1 {
  tick: DaemonTick;
  config: AshlrConfig;
  signal?: AbortSignal;
  deps?: {
    now?: () => number;
    killSwitchOn?: () => boolean;
    readSource?: (
      trustPolicy: AgentOsSourceTrustPolicyV1,
    ) => AgentOsSourceBundleStoreReadResultV1;
    attemptState?: (
      attemptId: string,
      tickDigest: string,
      tickAt: string,
      bundleDigest: string,
      nowMs: number,
    ) => AgentOsObserverAttemptLedgerDecisionV1;
    spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildHandle;
    setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
    invocation?: (args: readonly string[]) => { command: string; args: string[] };
  };
}

let active: ScheduledAgentOsObserverV1 | null = null;
let latestStatus: AgentOsObserverSchedulerStatusV1 = Object.freeze({
  durable: false,
  active: false,
  lastDisposition: null,
  lastAttemptId: null,
  lastTickDigest: null,
  sourceState: 'not-read',
  sourceStopReasons: Object.freeze([]),
  childOutcome: null,
});

export function readAgentOsObserverSchedulerStatusV1(): AgentOsObserverSchedulerStatusV1 {
  return { ...latestStatus, sourceStopReasons: [...latestStatus.sourceStopReasons] };
}

function publishStatus(
  scheduled: ScheduledAgentOsObserverV1,
  isActive: boolean,
  childOutcome: AgentOsObserverChildResultV1['outcome'] | null = null,
): ScheduledAgentOsObserverV1 {
  latestStatus = Object.freeze({
    durable: false,
    active: isActive,
    lastDisposition: scheduled.disposition,
    lastAttemptId: scheduled.attemptId,
    lastTickDigest: scheduled.tickDigest,
    sourceState: scheduled.sourceState,
    sourceStopReasons: Object.freeze([...scheduled.sourceStopReasons]),
    childOutcome,
  });
  return scheduled;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolveAgentOsObserverConfigV1(config: AshlrConfig): ResolvedAgentOsObserverConfigV1 {
  try {
    const raw = config.daemon?.agentOsObserver;
    if (raw?.enabled !== true) {
      return { enabled: false, valid: true, deadlineMs: DEFAULT_DEADLINE_MS, trustPolicy: null, trustPolicyDigest: null };
    }
    const deadlineMs = Number.isSafeInteger(raw.deadlineMs) && raw.deadlineMs! >= MIN_DEADLINE_MS &&
      raw.deadlineMs! <= MAX_DEADLINE_MS
      ? raw.deadlineMs!
      : DEFAULT_DEADLINE_MS;
    const trustPolicy = record(raw.trustPolicy) ? raw.trustPolicy as AgentOsSourceTrustPolicyV1 : null;
    const trustPolicyDigest = trustPolicy ? agentOsSourceTrustPolicyDigestV1(trustPolicy) : null;
    const valid = raw.deadlineMs === undefined || deadlineMs === raw.deadlineMs;
    return {
      enabled: true,
      valid: valid && trustPolicyDigest !== null && trustPolicy!.keys.length > 0,
      deadlineMs,
      trustPolicy,
      trustPolicyDigest,
    };
  } catch {
    return { enabled: true, valid: false, deadlineMs: DEFAULT_DEADLINE_MS, trustPolicy: null, trustPolicyDigest: null };
  }
}

function canonicalize(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite tick field');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('cyclic tick');
    ancestors.add(value);
    try { return value.map((entry) => canonicalize(entry, ancestors)); }
    finally { ancestors.delete(value); }
  }
  const row = record(value);
  if (!row || ancestors.has(row)) throw new Error('invalid tick field');
  ancestors.add(row);
  try {
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonicalize(row[key], ancestors)]));
  } finally {
    ancestors.delete(row);
  }
}

export function agentOsDurableTickDigestV1(tick: DaemonTick): string | null {
  try {
    const tickAt = Date.parse(tick.ts);
    if (!Number.isFinite(tickAt) || new Date(tickAt).toISOString() !== tick.ts) return null;
    return createHash('sha256')
      .update('ashlr:agent-os-observer:durable-tick:v1\0', 'utf8')
      .update(JSON.stringify(canonicalize(tick)), 'utf8')
      .digest('hex');
  } catch {
    return null;
  }
}

export function agentOsObserverAttemptIdForTickV1(tickDigest: string): string | null {
  if (!DIGEST_RE.test(tickDigest)) return null;
  const value = createHash('sha256')
    .update('ashlr:agent-os-observer:attempt:v1\0', 'utf8')
    .update(tickDigest, 'utf8')
    .digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function defaultReadSource(trustPolicy: AgentOsSourceTrustPolicyV1): AgentOsSourceBundleStoreReadResultV1 {
  const dependencies = defaultAgentOsSourceBundleStoreDependenciesV1();
  if (!dependencies) {
    return {
      sourceState: 'degraded', sourcePresent: false, complete: false, bundles: [], current: null,
      stopReasons: ['invalid-options'], filesRead: 0, bytesRead: 0, invalidFiles: 0, limitExceeded: false,
      authority: 'observation-only', planningAuthority: false, executionAuthority: false,
      proposalAuthority: false, mergeAuthority: false, releaseAuthority: false, deployAuthority: false,
      publicationAuthority: false, externalMutationAuthority: false,
    };
  }
  return readAgentOsSourceBundleStoreV1({ ...dependencies, trustPolicy, clock: () => new Date() });
}

export function readAgentOsObserverAttemptLedgerDecisionV1(
  attemptId: string,
  tickDigest: string,
  tickAt: string,
  bundleDigest: string,
  nowMs: number,
  dependencies: AgentOsObserverAttemptStoreDependenciesV1 | null =
    defaultAgentOsObserverAttemptStoreDependenciesV1('read'),
  readSnapshots: () => AgentOsSnapshotReadResultV1 = () => {
    const snapshotDependencies = defaultAgentOsSnapshotStoreDependenciesV1('read');
    return snapshotDependencies
      ? readAgentOsSnapshotsV1(snapshotDependencies)
      : {
          sourceState: 'degraded', availability: 'unavailable', sourcePresent: false, complete: false,
          envelopes: [], current: null, stopReasons: ['invalid-options'], filesRead: 0, bytesRead: 0,
          invalidFiles: 0, limitExceeded: false, authority: 'observation-only', sameUserTamperResistant: false,
          rollbackProtected: false, historicalAuthority: false, executionAuthority: false,
          proposalAuthority: false, mergeAuthority: false, deployAuthority: false,
          publicationAuthority: false, externalMutationAuthority: false,
        };
  },
  durableTickPresent: (tickDigest: string, tickAt: string) => boolean =
    (expectedDigest, expectedAt) => {
      const loaded = loadDaemonStateStrict();
      return loaded.ok && loaded.state.ticks.some((tick) =>
        tick.ts === expectedAt && tick.reason === 'ok' && tick.dryRun !== true &&
        agentOsDurableTickDigestV1(tick) === expectedDigest);
    },
): AgentOsObserverAttemptLedgerDecisionV1 {
  if (!dependencies || !Number.isFinite(nowMs)) return { state: 'degraded' };
  const read = readAgentOsObserverAttemptReceiptsV1(dependencies, { requireComplete: true });
  if (read.sourceState === 'degraded' || !read.complete) return { state: 'degraded' };

  const exactAttempt = read.records.filter((entry) => entry.attemptId === attemptId);
  if (exactAttempt.some((entry) =>
    entry.initiatingTickDigest !== tickDigest || entry.initiatingTickAt !== tickAt)) {
    return { state: 'degraded' };
  }

  const terminalsByAttempt = new Set(
    read.records.filter((entry) => entry.phase === 'terminal').map((entry) => entry.attemptId),
  );
  const openStarts = read.records.filter((entry): entry is AgentOsObserverAttemptReceiptV1 =>
    entry.phase === 'started' && !terminalsByAttempt.has(entry.attemptId));
  if (openStarts.length > 1) return { state: 'degraded' };
  if (openStarts.length === 1) {
    const start = openStarts[0]!;
    if (!DIGEST_RE.test(start.bundleDigest ?? '')) return { state: 'degraded' };
    try {
      if (!durableTickPresent(start.initiatingTickDigest, start.initiatingTickAt)) {
        return { state: 'degraded' };
      }
    } catch {
      return { state: 'degraded' };
    }
    return {
      state: 'resume-started',
      attemptId: start.attemptId,
      tickDigest: start.initiatingTickDigest,
      tickAt: start.initiatingTickAt,
      deadlineAt: start.deadlineAt,
      bundleDigest: start.bundleDigest!,
    };
  }
  // A durable tick identifies one attempt. Once it has closed over a source,
  // the same tick cannot be reused for a different source binding.
  if (exactAttempt.some((entry) => entry.bundleDigest !== bundleDigest)) {
    return { state: 'degraded' };
  }

  const sourceTerminals = read.records.filter((entry) =>
    entry.phase === 'terminal' && entry.bundleDigest === bundleDigest);
  const retryableTerminals = sourceTerminals.filter((entry) =>
    entry.terminalOutcome === 'source-incomplete' || entry.terminalOutcome === 'source-invalid' ||
    entry.terminalOutcome === 'deadline-before-commit' || entry.terminalOutcome === 'append-failed' ||
    entry.terminalOutcome === 'ambiguous-after-commit');
  const latestFailure = retryableTerminals
    .filter((entry) => entry.completedAt !== null)
    .sort((left, right) => Date.parse(right.completedAt!) - Date.parse(left.completedAt!))[0];
  const failureDecision = (): AgentOsObserverAttemptLedgerDecisionV1 | null => {
    if (retryableTerminals.length >= SOURCE_RETRY_LIMIT) return { state: 'retry-exhausted' };
    if (latestFailure && nowMs < Date.parse(latestFailure.completedAt!) + SOURCE_RETRY_BACKOFF_MS) {
      return { state: 'retry-backoff' };
    }
    if (read.capacityExhausted || read.records.length + 2 > AGENT_OS_OBSERVER_ATTEMPT_MAX_RECORDS) {
      return { state: 'capacity-exhausted' };
    }
    return null;
  };
  const successful = sourceTerminals.filter((entry) =>
    entry.terminalOutcome === 'completed' || entry.terminalOutcome === 'replayed');
  if (successful.length > 0) {
    let snapshots: AgentOsSnapshotReadResultV1;
    try { snapshots = readSnapshots(); } catch { return { state: 'snapshot-store-degraded' }; }
    if (snapshots.sourceState === 'missing' && !snapshots.sourcePresent) {
      return failureDecision() ?? { state: 'snapshot-repair-required' };
    }
    if (snapshots.sourceState !== 'healthy' || !snapshots.complete) {
      return { state: 'snapshot-store-degraded' };
    }
    const coherent = successful.some((receipt) => snapshots.envelopes.some((envelope) =>
      envelope.producerAttemptId === receipt.attemptId &&
      envelope.sourceDigest === receipt.bundleDigest &&
      envelope.payload.snapshotDigest === receipt.snapshotDigest &&
      envelope.envelopeDigest === receipt.snapshotEnvelopeDigest &&
      envelope.sequence === receipt.snapshotEnvelopeSequence));
    return { state: coherent ? 'source-observed' : 'snapshot-store-degraded' };
  }
  return failureDecision() ?? { state: 'missing' };
}

function childRuntimeArgs(): string[] {
  if (!import.meta.url.endsWith('.ts')) return [];
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const arg = process.execArgv[index]!;
    if (arg.startsWith('--import=')) {
      const value = arg.slice('--import='.length);
      if (value === 'tsx' || /\/node_modules\/tsx\/dist\/(?:loader|esm)\.mjs$/u.test(value)) args.push(arg);
    } else if (arg === '--import') {
      const value = process.execArgv[index + 1];
      if (value && (value === 'tsx' || /\/node_modules\/tsx\/dist\/(?:loader|esm)\.mjs$/u.test(value))) {
        args.push(arg, value);
      }
      index += 1;
    }
  }
  return args;
}

export function agentOsObserverChildInvocationV1(args: readonly string[]): { command: string; args: string[] } {
  const entryName = import.meta.url.endsWith('.ts')
    ? './agent-os-observer-child.ts'
    : './agent-os-observer-child.js';
  return {
    command: process.execPath,
    args: [...childRuntimeArgs(), fileURLToPath(new URL(entryName, import.meta.url)), ...args],
  };
}

export function agentOsObserverChildEnvironmentV1(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'ASHLR_HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP'];
  const env: NodeJS.ProcessEnv = { ASHLR_AGENT_OS_OBSERVER_CHILD: '1' };
  for (const key of allowed) {
    const value = source[key];
    if (typeof value !== 'string' || value.length > 8_192 || value.includes('\0')) continue;
    if ((key === 'HOME' || key === 'ASHLR_HOME') && (!isAbsolute(value) || resolve(value) !== value)) continue;
    env[key] = value;
  }
  return env;
}

function inert(
  disposition: AgentOsObserverScheduleDispositionV1,
  attemptId: string | null,
  tickDigest: string | null,
  sourceState: ScheduledAgentOsObserverV1['sourceState'] = 'not-read',
  sourceStopReasons: readonly string[] = [],
): ScheduledAgentOsObserverV1 {
  return publishStatus({
    disposition,
    attemptId,
    tickDigest,
    sourceState,
    sourceStopReasons,
    completion: Promise.resolve({ outcome: 'failed', code: null, signal: null }),
    cancel: () => {},
  }, false);
}

export function scheduleAgentOsObserverV1(
  options: ScheduleAgentOsObserverOptionsV1,
): ScheduledAgentOsObserverV1 {
  const resolved = resolveAgentOsObserverConfigV1(options.config);
  if (!resolved.enabled) return inert('disabled', null, null);
  if (!resolved.valid || !resolved.trustPolicy || !resolved.trustPolicyDigest) {
    return inert('configuration-degraded', null, null);
  }
  const now = options.deps?.now ?? Date.now;
  let nowMs = Number.NaN;
  try { nowMs = now(); } catch { /* invalid tick result below */ }
  const schedulingStartedAt = performance.now();
  const tickMs = Date.parse(options.tick.ts);
  let tickDigest = agentOsDurableTickDigestV1(options.tick);
  let attemptId = tickDigest ? agentOsObserverAttemptIdForTickV1(tickDigest) : null;
  let tickAt = options.tick.ts;
  if (!Number.isFinite(nowMs) || !Number.isFinite(tickMs) || tickMs > nowMs + FUTURE_TOLERANCE_MS ||
    options.tick.reason !== 'ok' || options.tick.dryRun === true || !tickDigest || !attemptId) {
    return inert('invalid-tick', attemptId, tickDigest);
  }
  const killCheck = options.deps?.killSwitchOn ?? killSwitchOn;
  const killIsOn = (): boolean => {
    try { return killCheck(); } catch { return true; }
  };
  if (options.signal?.aborted || killIsOn()) return inert('cancelled', attemptId, tickDigest);
  if (active) return publishStatus({
    ...active,
    disposition: 'overlap-suppressed',
    cancel: () => {},
  }, true);

  const readSource = options.deps?.readSource ?? defaultReadSource;
  let source: AgentOsSourceBundleStoreReadResultV1;
  try { source = readSource(resolved.trustPolicy); }
  catch { return inert('source-degraded', attemptId, tickDigest); }
  if (source.sourceState === 'missing') {
    return inert('source-missing', attemptId, tickDigest, source.sourceState, source.stopReasons);
  }
  if (source.sourceState !== 'healthy' || !source.complete || !source.current || source.bundles.length === 0) {
    return inert('source-degraded', attemptId, tickDigest, source.sourceState, source.stopReasons);
  }
  let attemptState: AgentOsObserverAttemptLedgerDecisionV1 = { state: 'degraded' };
  try {
    attemptState = (options.deps?.attemptState ?? readAgentOsObserverAttemptLedgerDecisionV1)(
      attemptId,
      tickDigest,
      options.tick.ts,
      source.current.bundleDigest,
      nowMs,
    );
  } catch { /* fail closed as degraded */ }
  if (attemptState.state === 'degraded') {
    return inert('attempt-store-degraded', attemptId, tickDigest, source.sourceState, source.stopReasons);
  }
  if (attemptState.state === 'snapshot-store-degraded') {
    return inert(
      'snapshot-store-degraded', attemptId, tickDigest, source.sourceState,
      [...source.stopReasons, 'snapshot-store-degraded'],
    );
  }
  if (attemptState.state === 'capacity-exhausted') {
    return inert(
      'attempt-capacity-exhausted',
      attemptId,
      tickDigest,
      source.sourceState,
      [...source.stopReasons, 'attempt-capacity-exhausted'],
    );
  }
  if (attemptState.state === 'source-observed') {
    return inert('already-observed', attemptId, tickDigest, source.sourceState, source.stopReasons);
  }
  // A wholly absent snapshot ledger is the one safe regeneration case. The
  // existing attempt budget still bounds repeated repair failure.
  const sourceStopReasons = attemptState.state === 'snapshot-repair-required'
    ? [...source.stopReasons, 'snapshot-repair-required']
    : source.stopReasons;
  if (attemptState.state === 'retry-backoff') {
    return inert(
      'source-retry-backoff', attemptId, tickDigest, source.sourceState,
      [...source.stopReasons, 'source-retry-backoff'],
    );
  }
  if (attemptState.state === 'retry-exhausted') {
    return inert(
      'source-retry-exhausted', attemptId, tickDigest, source.sourceState,
      [...source.stopReasons, 'source-retry-exhausted'],
    );
  }
  let deadlineAt = new Date(nowMs + resolved.deadlineMs).toISOString();
  let expectedBundleDigest = source.current.bundleDigest;
  if (attemptState.state === 'resume-started') {
    attemptId = attemptState.attemptId;
    tickDigest = attemptState.tickDigest;
    tickAt = attemptState.tickAt;
    deadlineAt = attemptState.deadlineAt;
    expectedBundleDigest = attemptState.bundleDigest;
  }
  if (options.signal?.aborted || killIsOn()) {
    return inert('cancelled', attemptId, tickDigest, source.sourceState, sourceStopReasons);
  }

  const spawnChild = options.deps?.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  let child: ChildHandle;
  try {
    const invocation = (options.deps?.invocation ?? agentOsObserverChildInvocationV1)([
      attemptId,
      tickDigest,
      tickAt,
      deadlineAt,
      expectedBundleDigest,
      resolved.trustPolicyDigest,
    ]);
    child = spawnChild(invocation.command, invocation.args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      env: agentOsObserverChildEnvironmentV1(),
    });
  } catch {
    return inert('spawn-failed', attemptId, tickDigest, source.sourceState, sourceStopReasons);
  }
  const scheduleTimeout = options.deps?.setTimeout ?? setTimeout;
  const clearScheduledTimeout = options.deps?.clearTimeout ?? clearTimeout;
  let settle!: (value: AgentOsObserverChildResultV1) => void;
  let settled = false;
  let childErrored = false;
  let requested: 'cancelled' | 'timed-out' | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const completion = new Promise<AgentOsObserverChildResultV1>((resolveCompletion) => { settle = resolveCompletion; });
  const finish = (value: AgentOsObserverChildResultV1): void => {
    if (settled) return;
    settled = true;
    if (deadlineTimer !== null) clearScheduledTimeout(deadlineTimer);
    if (killTimer !== undefined) clearScheduledTimeout(killTimer);
    options.signal?.removeEventListener('abort', cancel);
    if (active === scheduled) active = null;
    publishStatus(scheduled, false, value.outcome);
    settle(value);
  };
  const terminate = (reason: 'cancelled' | 'timed-out'): void => {
    if (settled || requested) return;
    requested = reason;
    try { child.kill('SIGTERM'); } catch { /* bounded hard-kill fallback below */ }
    killTimer = scheduleTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* child may already be gone */ }
      // Sending a signal is not proof of process death. Keep ownership active
      // and completion pending until `close` confirms that stdio/process state
      // is fully released; this blocks overlap after a failed or delayed kill.
      publishStatus(scheduled, true, 'degraded-stuck');
    }, KILL_CONFIRM_MS);
  };
  const cancel = (): void => terminate('cancelled');
  const scheduled: ScheduledAgentOsObserverV1 = {
    disposition: 'scheduled',
    attemptId,
    tickDigest,
    sourceState: source.sourceState,
    sourceStopReasons,
    completion,
    cancel,
  };
  active = scheduled;
  publishStatus(scheduled, true);
  options.signal?.addEventListener('abort', cancel, { once: true });
  child.once('error', () => {
    childErrored = true;
    // ChildProcess can emit `error` for a failed kill as well as failed spawn.
    // Neither proves the process is gone; only `close` releases ownership.
    publishStatus(scheduled, true, 'degraded-stuck');
  });
  child.once('close', (code, signal) => finish({
    outcome: requested ?? (!childErrored && code === 0 ? 'completed' : 'failed'),
    code,
    signal,
  }));
  const remainingDeadlineMs = Math.max(
    1,
    Math.floor(Date.parse(deadlineAt) - nowMs - (performance.now() - schedulingStartedAt)),
  );
  deadlineTimer = scheduleTimeout(() => terminate('timed-out'), remainingDeadlineMs);
  return scheduled;
}
