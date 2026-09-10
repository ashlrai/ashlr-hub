/** Finite, explicitly approved resident queue. The engineering owner alone executes effects. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { readResourceJson } from './pool-runtime.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import type { ResourceConsoleEngineeringOwner } from './console-engineering.js';
import type { ResourceConsoleEngineeringSupervisionConfig, ResourceConsoleEngineeringSupervisionSnapshot } from './console-engineering-supervisor-types.js';
export type { ResourceConsoleEngineeringSupervisionConfig, ResourceConsoleEngineeringSupervisionSnapshot } from './console-engineering-supervisor-types.js';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_STATE_BYTES = 128 * 1024;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' &&
  !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
function fail(code: ConstructorParameters<typeof ResourceSupervisorError>[0], message: string): never { throw new ResourceSupervisorError(code, message); }
function data<T>(value: unknown): T {
  const text = canonicalEvidencePackJsonV3(value);
  if (text === null || Buffer.byteLength(text) > MAX_STATE_BYTES) fail('INVALID_INPUT', 'Invalid engineering supervision data');
  return JSON.parse(text) as T;
}
export function validateResourceConsoleEngineeringSupervisionConfig(value: unknown): ResourceConsoleEngineeringSupervisionConfig {
  const config = data<ResourceConsoleEngineeringSupervisionConfig>(value);
  if (!exact(config, ['schemaVersion', 'id', 'maxDurationMs', 'pollIntervalMs', 'maxConcurrent', 'maxAttemptsPerEnrollment', 'enrollments']) ||
      config.schemaVersion !== 1 || typeof config.id !== 'string' || !ID.test(config.id) ||
      !integer(config.maxDurationMs, 1, 86_400_000) || !integer(config.pollIntervalMs, 100, 60_000) ||
      !integer(config.maxConcurrent, 1, 4) || !integer(config.maxAttemptsPerEnrollment, 1, 16) ||
      !Array.isArray(config.enrollments) || config.enrollments.length < 1 || config.enrollments.length > 32 ||
      config.enrollments.some(row => !exact(row, ['enrollmentId', 'expectedEnrollmentDigest']) ||
        typeof row.enrollmentId !== 'string' || !ID.test(row.enrollmentId) ||
        typeof row.expectedEnrollmentDigest !== 'string' || !HASH.test(row.expectedEnrollmentDigest)) ||
      new Set(config.enrollments.map(row => row.enrollmentId)).size !== config.enrollments.length) {
    fail('INVALID_INPUT', 'Invalid engineering supervision configuration');
  }
  return config;
}

interface DurableState {
  schemaVersion: 1; configDigest: string; createdAt: string; deadlineAt: string; writtenAt: string;
  paused: boolean; revision: number;
  entries: Array<{ enrollmentId: string; enrollmentDigest: string; attempts: number;
    lastEvidenceDigest: string | null; lastOutcome: 'attempting' | 'settled' | 'unavailable' | null }>;
}
export interface ResourceConsoleEngineeringSupervisor {
  snapshot(): ResourceConsoleEngineeringSupervisionSnapshot;
  setPaused(paused: boolean, expectedRevision: number): ResourceConsoleEngineeringSupervisionSnapshot;
  start(): void;
  close(): Promise<void>;
}
export interface ResourceConsoleEngineeringSupervisorOptions {
  owner: ResourceConsoleEngineeringOwner;
  root: string;
  config: ResourceConsoleEngineeringSupervisionConfig;
  signal?: AbortSignal;
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Construction enrolls private metadata/ownership only; start() is the explicit execution boundary. */
export function createResourceConsoleEngineeringSupervisor(options: ResourceConsoleEngineeringSupervisorOptions): ResourceConsoleEngineeringSupervisor {
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['owner', 'root', 'config', 'signal'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key)!, 'value'))) fail('INVALID_INPUT', 'Invalid engineering supervision options');
  const config = validateResourceConsoleEngineeringSupervisionConfig(options.config);
  const configDigest = digest(canonical(config)); const root = options.root; const signal = options.signal;
  if (typeof root !== 'string' || root.length > 4096 || !isAbsolute(root) || resolve(root) !== root || parse(root).root === root ||
      [...root].some(char => { const code = char.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }) ||
      signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT', 'Invalid engineering supervision scope');
  if (signal?.aborted) fail('UNAVAILABLE', 'Engineering supervision startup cancelled');
  const owner = options.owner;
  for (const key of ['catalog', 'snapshot', 'readiness', 'evidenceFingerprint', 'launch', 'awaitSettlement'] as const) {
    const property = owner && Object.getOwnPropertyDescriptor(owner, key);
    if (!property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function') fail('INVALID_INPUT', 'Invalid engineering supervision owner');
  }
  // Capture host methods before any asynchronous invocation or durable enrollment.
  const host = { catalog: owner.catalog.bind(owner), snapshot: owner.snapshot.bind(owner), readiness: owner.readiness.bind(owner),
    evidenceFingerprint: owner.evidenceFingerprint.bind(owner), launch: owner.launch.bind(owner), awaitSettlement: owner.awaitSettlement.bind(owner) };
  const catalog = host.catalog();
  if (config.enrollments.some(row => !catalog.some(value => value.id === row.enrollmentId && value.enrollmentDigest === row.expectedEnrollmentDigest))) {
    fail('CONFLICT', 'Engineering supervision enrollment changed');
  }
  inspectPrivateDirectory(root);
  const parent = join(root, 'engineering-supervision'); const directory = join(parent, config.id);
  for (const path of [parent, directory]) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    inspectPrivateDirectory(path);
  }
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') fail('CONFLICT', 'Engineering supervision is already owned or unavailable');
  const statePath = join(directory, 'state.json');
  let state!: DurableState;
  let persistedDigest: string | null = null;
  let started = false, closing = false, faulted = false;
  let closePromise: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  let deadlineMonotonic = Infinity;
  const active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  let wake: (() => void) | undefined;
  const fault = () => { faulted = true; for (const value of active.values()) value.abort.abort(); wake?.(); };
  const own = () => { if (!ownsLocalStoreLock(acquired.lock)) { fault(); fail('UNAVAILABLE', 'Engineering supervision ownership lost'); } };
  const expired = () => Date.now() >= Date.parse(state.deadlineAt) || performance.now() >= deadlineMonotonic;
  const stopped = () => {
    if (closing || signal?.aborted || faulted || expired()) return true;
    try { own(); if (Date.now() < Date.parse(state.writtenAt)) { fault(); return true; } } catch { return true; }
    return false;
  };
  function persist(next: DurableState): void {
    own(); const temporary = join(directory, `.state-${randomUUID()}.tmp`); let fd: number | undefined;
    try {
      const before = present(statePath) ? digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) : null;
      if (before !== persistedDigest) throw new Error();
      const bytes = Buffer.from(canonical(next) + '\n');
      if (bytes.length > MAX_STATE_BYTES) fail('CAPACITY', 'Engineering supervision state capacity reached');
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      for (let offset = 0; offset < bytes.length;) { const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written < 1) throw new Error(); offset += written; }
      fsyncSync(fd); closeSync(fd); fd = undefined; own();
      const current = present(statePath) ? digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) : null;
      if (current !== persistedDigest) throw new Error();
      renameSync(temporary, statePath); fsyncDirectory(directory); own(); state = next; persistedDigest = digest(canonical(next));
    } catch { fault(); fail('UNAVAILABLE', 'Engineering supervision state unavailable'); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* This invocation's exact temporary path only. */ } }
  }
  try {
    if (present(statePath)) {
      const source = data<DurableState>(readResourceJson(statePath, MAX_STATE_BYTES));
      if (!exact(source, ['schemaVersion', 'configDigest', 'createdAt', 'deadlineAt', 'writtenAt', 'paused', 'revision', 'entries']) ||
          source.schemaVersion !== 1 || source.configDigest !== configDigest || !timestamp(source.createdAt) || !timestamp(source.deadlineAt) ||
          !timestamp(source.writtenAt) || source.writtenAt < source.createdAt || Date.parse(source.deadlineAt) !== Date.parse(source.createdAt) + config.maxDurationMs ||
          typeof source.paused !== 'boolean' || !integer(source.revision, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(source.entries) ||
          source.entries.length !== config.enrollments.length || source.entries.some((row, index) => {
            const expected = config.enrollments[index]!;
            return !exact(row, ['enrollmentId', 'enrollmentDigest', 'attempts', 'lastEvidenceDigest', 'lastOutcome']) ||
              row.enrollmentId !== expected.enrollmentId || row.enrollmentDigest !== expected.expectedEnrollmentDigest ||
              !integer(row.attempts, 0, config.maxAttemptsPerEnrollment) ||
              (row.lastEvidenceDigest !== null && (typeof row.lastEvidenceDigest !== 'string' || !HASH.test(row.lastEvidenceDigest))) ||
              ![null, 'attempting', 'settled', 'unavailable'].includes(row.lastOutcome) ||
              (row.attempts === 0 ? row.lastEvidenceDigest !== null || row.lastOutcome !== null : row.lastEvidenceDigest === null || row.lastOutcome === null);
          })) fail('CONFLICT', 'Engineering supervision configuration or state changed');
      state = source; persistedDigest = digest(canonical(source));
    } else {
      const now = new Date().toISOString();
      persist({ schemaVersion: 1, configDigest, createdAt: now, writtenAt: now,
        deadlineAt: new Date(Date.parse(now) + config.maxDurationMs).toISOString(), paused: false, revision: 0,
        entries: config.enrollments.map(row => ({ enrollmentId: row.enrollmentId, enrollmentDigest: row.expectedEnrollmentDigest,
          attempts: 0, lastEvidenceDigest: null, lastOutcome: null })) });
    }
    deadlineMonotonic = performance.now() + Math.max(0, Date.parse(state.deadlineAt) - Date.now());
    if (Date.now() < Date.parse(state.writtenAt)) fail('UNAVAILABLE', 'Engineering supervision clock moved backwards');
  } catch (error) { releaseLocalStoreLock(acquired.lock); throw error; }

  function project(row: DurableState['entries'][number]): ResourceConsoleEngineeringSupervisionSnapshot['entries'][number] {
    const base = { enrollmentId: row.enrollmentId, enrollmentDigest: row.enrollmentDigest, attempts: row.attempts };
    if (faulted) return { ...base, state: 'unavailable', reasons: ['evidence-unavailable'] };
    try {
      const job = host.snapshot(row.enrollmentId);
      if (job.enrollmentId !== row.enrollmentId || job.enrollmentDigest !== row.enrollmentDigest ||
          !['healthy', 'missing'].includes(job.sourceState) || !['ready', 'running', 'completed', 'incomplete', 'stopped'].includes(job.state)) throw new Error();
      if (job.state === 'completed') return { ...base, state: 'completed', reasons: ['completed'] };
      if (active.has(row.enrollmentId) || job.state === 'running') return { ...base, state: 'running', reasons: ['running'] };
      if (job.cancelled || job.state === 'stopped') return { ...base, state: 'stopped', reasons: ['cancelled'] };
      if (expired() || job.deadlineAt !== null && Date.now() >= Date.parse(job.deadlineAt)) return { ...base, state: 'stopped', reasons: ['deadline-exhausted'] };
      if (closing) return { ...base, state: 'held', reasons: ['supervisor-closed'] };
      if (state.paused) return { ...base, state: 'held', reasons: ['supervisor-paused'] };
      if (!started) return { ...base, state: 'waiting', reasons: ['not-started'] };
      if (row.attempts >= config.maxAttemptsPerEnrollment) return { ...base, state: 'held', reasons: ['attempt-limit'] };
      const ready = host.readiness(row.enrollmentId);
      if (ready.enrollmentId !== row.enrollmentId || ready.enrollmentDigest !== row.enrollmentDigest) throw new Error();
      if (ready.status !== 'ready' || !['launch', 'reconcile', 'continue'].includes(ready.action)) return { ...base, state: 'waiting', reasons: ['waiting-for-readiness'] };
      const fingerprint = host.evidenceFingerprint(row.enrollmentId);
      if (fingerprint === null || !HASH.test(fingerprint)) return { ...base, state: 'unavailable', reasons: ['evidence-unavailable'] };
      if (fingerprint === row.lastEvidenceDigest) return { ...base, state: 'held', reasons: ['unchanged-evidence'] };
      return { ...base, state: 'waiting', reasons: ['waiting-for-readiness'] };
    } catch { return { ...base, state: 'unavailable', reasons: ['evidence-unavailable'] }; }
  }
  function checkpoint(id: string, fingerprint: string | null, outcome: 'attempting' | 'settled' | 'unavailable'): void {
    persist({ ...state, writtenAt: new Date().toISOString(), entries: state.entries.map(row => row.enrollmentId === id ? {
      ...row, attempts: row.attempts + (outcome === 'attempting' ? 1 : 0), lastEvidenceDigest: fingerprint ?? row.lastEvidenceDigest, lastOutcome: outcome,
    } : row) });
  }
  function launch(id: string, fingerprint: string): void {
    checkpoint(id, fingerprint, 'attempting');
    if (stopped()) return;
    const abort = new AbortController();
    const pending = Promise.resolve().then(async () => {
      let outcome: 'settled' | 'unavailable' = 'settled';
      let invoked = false;
      try {
        if (stopped()) return;
        const row = state.entries.find(value => value.enrollmentId === id)!;
        invoked = true;
        host.launch({ enrollmentId: id, expectedEnrollmentDigest: row.enrollmentDigest }, {
          signal: abort.signal, isExecutionStopped: stopped,
        });
      } catch { outcome = 'unavailable'; }
      finally {
        // A throwing launch is not proof that it admitted nothing. Always drain
        // the owner's exact invocation before publishing a checkpoint or closing.
        try { if (invoked) await host.awaitSettlement(id); } catch { outcome = 'unavailable'; fault(); }
        // Publication after the call records its resulting evidence, so its own
        // newly written intent is not mistaken for a later recovery opportunity.
        if (!faulted) {
          try { checkpoint(id, host.evidenceFingerprint(id), outcome); } catch { fault(); }
        }
      }
    }).finally(() => { active.delete(id); wake?.(); });
    active.set(id, { abort, promise: pending });
  }
  async function run(): Promise<void> {
    try {
      while (!stopped()) {
        if (!state.paused) for (const row of state.entries) {
          if (stopped() || state.paused || active.size >= config.maxConcurrent) break;
          if (active.has(row.enrollmentId)) continue;
          const status = project(row);
          if (status.state !== 'waiting' || status.reasons[0] !== 'waiting-for-readiness') continue;
          const ready = host.readiness(row.enrollmentId);
          if (ready.enrollmentId !== row.enrollmentId || ready.enrollmentDigest !== row.enrollmentDigest ||
              ready.status !== 'ready' || !['launch', 'reconcile', 'continue'].includes(ready.action)) continue;
          const fingerprint = host.evidenceFingerprint(row.enrollmentId);
          if (!fingerprint || !HASH.test(fingerprint) || fingerprint === row.lastEvidenceDigest || stopped()) continue;
          launch(row.enrollmentId, fingerprint);
        }
        if (state.entries.every(row => project(row).state === 'completed')) break;
        if (stopped()) break;
        await new Promise<void>(resolveWake => {
          const timer = setTimeout(() => { wake = undefined; resolveWake(); }, Math.max(1, Math.min(config.pollIntervalMs, deadlineMonotonic - performance.now())));
          wake = () => { clearTimeout(timer); wake = undefined; resolveWake(); };
        });
      }
    } catch { fault(); }
    finally {
      if (stopped()) for (const value of active.values()) value.abort.abort();
      await Promise.allSettled([...active.values()].map(value => value.promise));
    }
  }
  const supervisor: ResourceConsoleEngineeringSupervisor = {
    snapshot() {
      // Observing ownership must not abort calls, schedule work, or persist state.
      let unavailable = faulted;
      try { if (!closing && !ownsLocalStoreLock(acquired.lock)) unavailable = true; } catch { unavailable = true; }
      const entries = state.entries.map(row => unavailable ? { enrollmentId: row.enrollmentId, enrollmentDigest: row.enrollmentDigest,
        attempts: row.attempts, state: 'unavailable' as const, reasons: ['evidence-unavailable' as const] } : project(row));
      return { schemaVersion: 1, configId: config.id, configDigest, sourceState: unavailable ? 'degraded' : 'healthy',
        state: unavailable ? 'unavailable' : closing ? 'closed' : entries.every(row => row.state === 'completed') ? 'completed' :
          expired() ? 'timed-out' : state.paused ? 'paused' : started ? 'running' : 'idle',
        deadlineAt: state.deadlineAt, paused: state.paused, revision: state.revision, entries };
    },
    setPaused(paused, expectedRevision) {
      if (typeof paused !== 'boolean' || !integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER)) fail('INVALID_INPUT', 'Invalid engineering supervision pause');
      if (closing || faulted) fail('UNAVAILABLE', 'Engineering supervision unavailable');
      own();
      if (expectedRevision !== state.revision) fail('CONFLICT', 'Engineering supervision pause revision changed');
      if (state.paused !== paused) {
        if (state.revision === Number.MAX_SAFE_INTEGER) fail('CAPACITY', 'Engineering supervision pause revision exhausted');
        persist({ ...state, paused, revision: state.revision + 1, writtenAt: new Date().toISOString() });
      }
      wake?.(); return supervisor.snapshot();
    },
    start() {
      if (closing || faulted) fail('UNAVAILABLE', 'Engineering supervision unavailable');
      if (started) return;
      own(); started = true; loop = run();
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; signal?.removeEventListener('abort', onAbort);
      for (const value of active.values()) value.abort.abort(); wake?.();
      closePromise = (async () => {
        await loop; await Promise.allSettled([...active.values()].map(value => value.promise));
        if (!releaseLocalStoreLock(acquired.lock)) faulted = true;
        if (faulted) fail('UNAVAILABLE', 'Engineering supervision shutdown unavailable');
      })();
      return closePromise;
    },
  };
  function onAbort() { void supervisor.close().catch(() => {}); }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { void supervisor.close(); fail('UNAVAILABLE', 'Engineering supervision startup cancelled'); }
  return supervisor;
}
