/** Actual private coordinator records/locks; proposal adapter and ledger are
 * controlled unit boundaries. Real loopback/Git acceptance is separate. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceEngineeringSuccessorCoordinator, parseResourceEngineeringSuccessorProposal,
  validateResourceEngineeringSuccessorCoordinatorConfig } from '../src/core/resources/engineering-successor-coordinator.js';
import type { ResourceEngineeringSuccessorCoordinatorConfig, ResourceEngineeringSuccessorCoordinatorOptions, ResourceEngineeringSuccessorEvidence } from '../src/core/resources/engineering-successor-coordinator-types.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot } from '../src/core/resources/console-engineering-supervisor-types.js';
import type { ResourceConsoleEngineeringEnrollment } from '../src/core/resources/console-engineering-types.js';
import * as runtime from '../src/core/resources/pool-runtime.js';
import * as capacity from '../src/core/resources/capacity-wait.js';
import * as records from '../src/core/util/immutable-private-record-store.js';

const roots: string[] = [];
const owners: ReturnType<typeof createResourceEngineeringSuccessorCoordinator>[] = [];
afterEach(async () => { await Promise.allSettled(owners.splice(0).map(owner => owner.close())); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: unknown) => digest(canonical(value));
const config: ResourceEngineeringSuccessorCoordinatorConfig = { schemaVersion: 1, supervisionId: 'fleet', profileId: 'fixed', allowedWorkerIds: ['worker'],
  maxOutputTokens: 1000, proposalTimeoutMs: 5000, maxSuccessors: 2, pollIntervalMs: 100 };
const proposal = JSON.stringify({ action: 'propose', name: 'Next useful change', objective: 'Improve the delivered project under the fixed evaluator.' });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'successor-coordinator-'))); roots.push(root);
  const cwd = join(root, 'proposal-workspace'); mkdirSync(cwd, { mode: 0o700 });
  let stopped = false, inPoolLock = false;
  const source: ResourceEngineeringSuccessorEvidence = { enrollmentId: 'source', enrollmentDigest: 'a'.repeat(64), projectId: 'project',
    deliveryDigest: 'b'.repeat(64), commit: 'c'.repeat(40), objective: 'Original measured objective', context: 'Fixed evaluator: value. Delivered value: 1. Only value.json may change.' };
  const state: ResourceConsoleEngineeringSupervisionSnapshot = { schemaVersion: 1, configId: 'fleet', configDigest: 'd'.repeat(64), sourceState: 'healthy',
    state: 'running', deadlineAt: new Date(Date.now() + 60_000).toISOString(), paused: false, revision: 0,
    admission: { maxEnrollments: 3, remainingEnrollments: 2, autoAdmitPrepared: false },
    entries: [{ enrollmentId: 'source', enrollmentDigest: source.enrollmentDigest, state: 'completed', reasons: ['completed'], attempts: 1 }] };
  const pool = { schemaVersion: 1 as const, id: 'pool', workers: [{ id: 'worker', provider: 'local' as const, model: 'fixture', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
  const bindings = [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat' as const, endpoint: 'http://127.0.0.1:9/v1' }];
  const attempts: runtime.ResourceTaskReceipt[] = [];
  const provider = vi.fn();
  const status = vi.spyOn(runtime, 'resourcePoolStatus').mockImplementation(() => ({ attempts }) as ReturnType<typeof runtime.resourcePoolStatus>);
  const run = vi.spyOn(runtime, 'runResourceTask').mockImplementation(async options => {
    inPoolLock = true; try { options.readAdmissionEvidence?.(); } finally { inPoolLock = false; }
    const allowed = options.beforeWorkerDispatch?.() === true;
    if (allowed) provider();
    const receipt: runtime.ResourceTaskReceipt = { schemaVersion: 1, id: options.task.id, taskDigest: hash(options.task), poolDigest: hash({ pool, bindings }),
      workerId: 'worker', capacityKey: 'shared', status: allowed ? 'completed' : 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      outputDigest: allowed ? digest(proposal) : null, inputTokens: allowed ? 10 : null, outputTokens: allowed ? 20 : null,
      reason: allowed ? 'fixture-completed' : 'worker-dispatch-precondition-failed', verifiedAccepted: false };
    attempts.push(receipt); return { receipt, plan: null, replayed: false, output: allowed ? proposal : null };
  });
  const prepare = vi.fn<ResourceEngineeringSuccessorCoordinatorOptions['host']['prepare']>(async input => ({ id: input.id, projectId: source.projectId,
    graphId: input.id, enrollmentDigest: 'e'.repeat(64), objective: input.objective, campaigns: [], budget: { maxParallel: 1, maxDurationMs: 5000 },
    acceptanceScope: 'fixed-evaluator-and-local-branch-only' } satisfies ResourceConsoleEngineeringEnrollment));
  const options: ResourceEngineeringSuccessorCoordinatorOptions = { root, cwd, config, pool, bindings,
    readAdmissionEvidence: () => ({ observations: [], unavailableWorkerIds: [], quotaUnavailableWorkerIds: [] }),
    supervision: { snapshot: () => { expect(inPoolLock).toBe(false); return structuredClone(state); }, admit: vi.fn(input => {
      expect(input.expectedRevision).toBe(state.revision);
      for (const row of input.enrollments) if (!state.entries.some(value => value.enrollmentId === row.enrollmentId)) {
        state.entries.push({ enrollmentId: row.enrollmentId, enrollmentDigest: row.expectedEnrollmentDigest, state: 'waiting', reasons: ['waiting-for-readiness'], attempts: 0 });
        state.admission!.remainingEnrollments--; state.revision++;
      }
      return structuredClone(state);
    }) },
    host: { source: (id, expectedEnrollmentDigest) => { expect(inPoolLock).toBe(false);
      expect(expectedEnrollmentDigest).toBe(state.entries.find(row => row.enrollmentId === id)?.enrollmentDigest);
      return id === source.enrollmentId ? { ...source } : null; },
      prepare, isExecutionStopped: () => stopped || state.paused },
  };
  const create = () => { const owner = createResourceEngineeringSuccessorCoordinator(options); owners.push(owner); return owner; };
  const files = () => { const path = join(root, 'engineering-successors', 'fleet', 'events', 'records');
    return Object.fromEntries(readdirSync(path).sort().map(name => [name, readFileSync(join(path, name), 'utf8')])); };
  return { options, root, source, state, attempts, status, run, provider, prepare, create, files, stop: (value: boolean) => { stopped = value; } };
}
const until = (owner: ReturnType<typeof createResourceEngineeringSuccessorCoordinator>, state: string) =>
  vi.waitFor(() => expect(owner.snapshot().entries[0]?.state).toBe(state), { timeout: 5000, interval: 20 });

describe('bounded engineering successor coordinator', () => {
  it('enrolls without execution, then proposes/prepares/admits once and reopens without another request', async () => {
    const f = fixture(); f.stop(true); const owner = f.create(); expect(f.run).not.toHaveBeenCalled();
    f.stop(false); owner.start(); await until(owner, 'admitted');
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.options.supervision.admit).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0]![0].task.mode).toBe('read-only'); expect(f.attempts).toHaveLength(1);
    expect(JSON.parse(f.run.mock.calls[0]![0].task.prompt).source).toEqual(f.source);
    expect(JSON.stringify(owner.snapshot())).not.toContain(f.source.context);
    const saved = f.files(); const deadline = owner.snapshot().deadlineAt; await owner.close();
    const restarted = f.create(); restarted.start(); await new Promise(resolve => setTimeout(resolve, 150));
    expect(restarted.snapshot().deadlineAt).toBe(deadline); expect(f.files()).toEqual(saved); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it.each(['pause', 'stop'])('records completed proposal facts after %s but does not prepare until resumed', async mode => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async options => { const result = await original(options); if (mode === 'pause') f.state.paused = true; else f.stop(true); return result; });
    const owner = f.create(); owner.start(); await until(owner, 'proposed'); expect(f.prepare).not.toHaveBeenCalled();
    f.state.paused = false; f.stop(false); await until(owner, 'admitted'); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('retains completed output under later source drift but refuses new preparation', async () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async options => { const result = await original(options); f.source.commit = 'f'.repeat(40); return result; });
    const owner = f.create(); owner.start(); await until(owner, 'proposed'); expect(f.prepare).not.toHaveBeenCalled();
    await owner.close(); const restarted = f.create(); restarted.start(); await new Promise(resolve => setTimeout(resolve, 150));
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('holds a lost proposal-result publication after restart instead of charging twice', async () => {
    const f = fixture(); const original = records.writeImmutablePrivateRecord;
    const write = vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((...args) => {
      if ((args[1] as { kind?: string }).kind === 'result') return 'failed'; return original(...args);
    });
    const owner = f.create(); owner.start(); await vi.waitFor(() => expect(f.attempts).toHaveLength(1)); await owner.close(); write.mockRestore();
    const restarted = f.create(); restarted.start(); await new Promise(resolve => setTimeout(resolve, 150));
    expect(restarted.snapshot().entries[0]).toMatchObject({ state: 'held', reason: 'proposal-output-unresolved' });
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rechecks the source after ledger admission and prevents provider contact on drift', async () => {
    const f = fixture(); let reads = 0;
    f.options.readAdmissionEvidence = () => {
      if (++reads === 2) f.source.commit = 'f'.repeat(40);
      return { observations: [], unavailableWorkerIds: [] };
    };
    const owner = f.create(); owner.start(); await vi.waitFor(() => expect(f.attempts).toHaveLength(1));
    expect(f.attempts[0]).toMatchObject({ status: 'failed', reason: 'worker-dispatch-precondition-failed' });
    expect(f.provider).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('avoids duplicate preliminary proof inside the proposal budget but preserves final dispatch proof', async () => {
    const f = fixture(); let admissionWindow = false; let sourceReads = 0; let preliminaryReads = -1; let finalReads = -1;
    const status = f.status.getMockImplementation()!;
    f.status.mockImplementation((...args) => { admissionWindow = true; return status(...args); });
    const source = f.options.host.source;
    f.options.host.source = (id, pin) => { if (admissionWindow) sourceReads++; return source(id, pin); };
    const run = f.run.getMockImplementation()!;
    f.run.mockImplementation(async options => {
      preliminaryReads = sourceReads;
      const result = await run(options);
      finalReads = sourceReads - preliminaryReads; admissionWindow = false;
      return result;
    });
    const owner = f.create(); owner.start(); await until(owner, 'admitted');
    expect(preliminaryReads).toBe(0); expect(finalReads).toBe(1);
    expect(f.provider).toHaveBeenCalledTimes(1); expect(f.attempts).toHaveLength(1);
  });
  it('discloses a live proposal separately from an unrecoverable output', async () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    let finish!: () => void;
    f.run.mockImplementation(async options => { await new Promise<void>(resolve => { finish = resolve; }); return original(options); });
    const owner = f.create(); owner.start(); await vi.waitFor(() => expect(owner.snapshot().entries[0]?.state).toBe('proposing'));
    expect(owner.snapshot().entries[0]?.reason).toBeNull(); finish(); await until(owner, 'admitted');
  });
  it.each(['source-proof', 'final-cheap-guard'] as const)('vetoes provider dispatch when %s exceeds the proposal deadline before its timer fires', async stage => {
    const f = fixture(); let finalProof = false; let clock = performance.now(); let cheapCallsRemaining = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const source = f.options.host.source;
    f.options.host.source = (id, pin) => {
      const value = source(id, pin);
      if (finalProof) {
        if (stage === 'source-proof') clock += config.proposalTimeoutMs + 1;
        else cheapCallsRemaining = 2; // Fresh's trailing guard, then the final dispatch guard.
      }
      return value;
    };
    const stopped = f.options.host.isExecutionStopped;
    f.options.host.isExecutionStopped = () => {
      const value = stopped();
      if (cheapCallsRemaining > 0 && --cheapCallsRemaining === 0) clock += config.proposalTimeoutMs + 1;
      return value;
    };
    const run = f.run.getMockImplementation()!;
    f.run.mockImplementation(async options => { finalProof = true; try { return await run(options); } finally { finalProof = false; } });
    const owner = f.create(); owner.start(); await vi.waitFor(() => expect(f.attempts).toHaveLength(1));
    expect(f.attempts[0]).toMatchObject({ status: 'failed', reason: 'worker-dispatch-precondition-failed' });
    expect(f.provider).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects inherited or accessor constructor options without invoking them', () => {
    const f = fixture(); const getter = vi.fn(() => f.options.root);
    const inherited = Object.create(f.options) as ResourceEngineeringSuccessorCoordinatorOptions;
    expect(() => createResourceEngineeringSuccessorCoordinator(inherited)).toThrow();
    const options = { ...f.options }; Object.defineProperty(options, 'root', { enumerable: true, get: getter });
    expect(() => createResourceEngineeringSuccessorCoordinator(options)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('waits after explicit no-reservation capacity denial using the identical task', async () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async () => ({ receipt: null, replayed: false, output: null,
      plan: { schemaVersion: 1, poolId: 'pool', sampledAt: new Date().toISOString(), nextEligibleAt: null,
        candidates: [], exclusions: [{ workerId: 'worker', reasons: ['concurrency-exhausted'], nextEligibleAt: null }], selectedWorkerId: null } }));
    f.run.mockImplementation(original);
    const wait = vi.spyOn(capacity, 'waitForResourceCapacity').mockResolvedValue({ ready: true, observations: [], unavailableWorkerIds: [] });
    const owner = f.create(); owner.start(); await until(owner, 'admitted');
    expect(wait).toHaveBeenCalledTimes(1); expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[0]![0].task).toEqual(f.run.mock.calls[1]![0].task); expect(f.attempts).toHaveLength(1);
  });
  it.each(['quota', 'throw', 'missing-output', 'wrong-output'])('never retries ambiguous or noncapacity proposal outcome: %s', async mode => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async options => {
      if (mode === 'throw') throw Error('unknown execution');
      if (mode === 'quota') return { receipt: null, replayed: false, output: null,
        plan: { schemaVersion: 1, poolId: 'pool', sampledAt: new Date().toISOString(), nextEligibleAt: null,
          candidates: [], exclusions: [{ workerId: 'worker', reasons: ['quota-reserve-reached'], nextEligibleAt: null }], selectedWorkerId: null } };
      const response = await original(options); return { ...response, output: mode === 'missing-output' ? null : '{"action":"stop"}' };
    });
    const owner = f.create(); owner.start(); await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 250)); expect(f.run).toHaveBeenCalledTimes(1); expect(f.prepare).not.toHaveBeenCalled();
    expect(owner.snapshot().entries[0]?.state).toBe('held');
  });
  it('records stop as a terminal proposal with no successor', async () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async options => { const result = await original(options); const output = '{"action":"stop"}';
      result.receipt!.outputDigest = digest(output); return { ...result, output }; });
    const owner = f.create(); owner.start(); await until(owner, 'stopped'); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects changed policy and duplicate ownership', async () => {
    const f = fixture(); const owner = f.create(); expect(() => f.create()).toThrow(); await owner.close();
    f.options.config = { ...config, maxOutputTokens: 999 }; expect(() => f.create()).toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it('does not renew an expired deadline or create a proposal after restart', async () => {
    const f = fixture(); f.state.deadlineAt = new Date(Date.now() - 1000).toISOString(); f.state.state = 'timed-out';
    const owner = f.create(); owner.start(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(owner.snapshot().state).toBe('timed-out'); expect(f.run).not.toHaveBeenCalled(); expect(owner.snapshot().entries).toEqual([]);
  });
  it('rejects altered receipt evidence before reusing a retained proposal', async () => {
    const f = fixture(); f.prepare.mockRejectedValue(Error('preparation held')); const owner = f.create(); owner.start();
    await until(owner, 'proposed'); await owner.close(); f.attempts[0]!.outputDigest = '0'.repeat(64); f.prepare.mockClear();
    const restarted = f.create(); restarted.start(); await new Promise(resolve => setTimeout(resolve, 150));
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects drifted immutable intent before any restarted effect', async () => {
    const f = fixture(); f.run.mockRejectedValue(Error('unknown')); const owner = f.create(); owner.start();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1)); await owner.close();
    const path = join(f.root, 'engineering-successors', 'fleet', 'events', 'records');
    const name = readdirSync(path).find(value => value.startsWith('intent-'))!;
    const row = JSON.parse(readFileSync(join(path, name), 'utf8')); row.task.prompt = 'changed';
    writeFileSync(join(path, name), canonical(row) + '\n'); expect(() => f.create()).toThrow(); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { ...config, maxSuccessors: 33 }, { ...config, allowedWorkerIds: ['worker', 'worker'] }])('rejects invalid config %#', value => {
    expect(() => validateResourceEngineeringSuccessorCoordinatorConfig(value)).toThrow();
  });
  it.each(['{}', '{"action":"propose","name":"name","objective":"ok","command":"sh"}', '```json\n{}\n```',
    JSON.stringify({ action: 'propose', name: 'name', objective: 'é'.repeat(2001) })])('rejects unbounded or authority-bearing proposal %#', value => {
    expect(() => parseResourceEngineeringSuccessorProposal(value)).toThrow();
  });
});
