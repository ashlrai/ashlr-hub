/** Runner/admission/codec integration with in-memory storage and inert subprocesses.
 * This is not filesystem durability or native process-settlement evidence. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { ManifestRecord, UniverseRecord } from '../src/core/universe/store.js';
import type { ImmutablePrivateRecordStoreConfig } from '../src/core/util/immutable-private-record-store.js';
import type { BuiltinTrialCustodyRecord } from '../src/core/universe/builtin-trial-custody.js';
import type { VerifySubprocessResult } from '../src/core/run/verify-commands.js';
import type { UniverseRunOptions } from '../src/core/universe/types.js';

const memory = vi.hoisted(() => ({
  manifests: new Map<string, ManifestRecord>(), records: new Map<string, UniverseRecord[]>(),
  custody: new Map<string, string[]>(), removed: [] as string[],
  failWrite: undefined as 'intent' | 'settlement' | undefined,
  failAfterIntent: false,
  afterIntent: undefined as (() => void) | undefined,
  dispatches: 0,
}));
vi.mock('node:fs', async original => ({ ...await original<object>(), existsSync: () => true,
  mkdirSync: vi.fn(), rmSync: (path: string) => { memory.removed.push(path); } }));
vi.mock('../src/core/fleet/local-store-lock.js', () => ({
  acquireLocalStoreLock: (path: string) => ({ path }),
  acquireLocalStoreLockWithOutcome: (path: string) => ({ state: 'acquired', lock: { path } }),
  ownsLocalStoreLock: () => true, releaseLocalStoreLock: vi.fn(), verifiedProcessStartRef: () => 'inert-owner',
}));
vi.mock('../src/core/universe/artifacts.js', async original => ({ ...await original<object>(),
  artifactDigest: () => 'a'.repeat(64), copyArtifact: () => 'a'.repeat(64), freezeArtifact: vi.fn(),
  privateDirectory: (path: string) => path, inspectPrivateDirectory: (path: string) => path,
  ensureUniverseRoot: (path: string) => path, executable: (command: string[]) => command,
}));
vi.mock('../src/core/universe/store.js', async original => ({ ...await original<object>(),
  manifestRecord: (path: string) => memory.manifests.get(path),
  assertComparatorUnchanged: vi.fn(), readRecords: (path: string) => structuredClone(memory.records.get(path) ?? []),
  appendRecord: (path: string, record: UniverseRecord) => {
    memory.records.set(path, [...memory.records.get(path) ?? [], structuredClone(record)]);
  },
  projectUniverse: (path: string) => ({ sourceState: 'healthy', reasons: [], elites: [],
    runs: (memory.records.get(path) ?? []).filter(row => row.kind === 'final').map(row => row.run) }),
}));
vi.mock('../src/core/util/immutable-private-record-store.js', () => ({
  readImmutablePrivateRecords: (config: ImmutablePrivateRecordStoreConfig<BuiltinTrialCustodyRecord>) => {
    const bytes = memory.custody.get(config.rootPath);
    const codec = config.codecForRead()!;
    const records = (bytes ?? []).map(text => codec.parse(JSON.parse(text)));
    if (records.some(row => row === null)) throw new Error('Invalid in-memory custody fixture');
    return { records, sourcePresent: bytes !== undefined, sourceState: bytes ? 'healthy' : 'missing', complete: true };
  },
  writeImmutablePrivateRecord: (config: ImmutablePrivateRecordStoreConfig<BuiltinTrialCustodyRecord>,
    record: BuiltinTrialCustodyRecord, options: { prepublish: () => boolean }) => {
    const codec = config.codecForWrite()!;
    const bytes = codec.serialize(record);
    if (!codec.parse(JSON.parse(bytes))) throw new Error('Invalid in-memory custody fixture');
    if (!options.prepublish()) return 'failed';
    if (memory.failWrite === record.kind) throw new Error('Injected custody publication failure');
    memory.custody.set(config.rootPath, [...memory.custody.get(config.rootPath) ?? [], bytes]);
    if (memory.failAfterIntent && record.kind === 'intent') throw new Error('Lost intent publication acknowledgment');
    if (record.kind === 'intent') memory.afterIntent?.();
    return 'recorded';
  },
}));
vi.mock('../src/core/universe/campaign-store.js', () => ({ assertCampaignSeedEvaluatorsSettled: vi.fn() }));
vi.mock('../src/core/universe/preparation-measurement-capture-store.js', () => ({ assertPreparationMeasurementsSettled: vi.fn() }));
vi.mock('../src/core/universe/campaign-seed-context.js', () => ({ readCampaignSeedContext: () => undefined }));
vi.mock('../src/core/universe/model-candidate.js', () => ({ generateModelCandidate: vi.fn() }));
vi.mock('../src/core/run/verify-commands.js', () => ({ runVerifySubprocessAsync: vi.fn() }));
vi.mock('../src/core/universe/fixed-evaluator.js', () => ({
  confinedUniverseArgv: (argv: string[]) => argv, runFixedUniverseEvaluator: vi.fn(),
}));

import { runUniverse, runUniverseOwned } from '../src/core/universe/runner.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';
import { runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import { readBuiltinTrialCustody } from '../src/core/universe/builtin-trial-custody.js';

const ROOT = '/inert-trial-custody';
const evaluator = vi.mocked(runFixedUniverseEvaluator);
const worker = vi.mocked(runVerifySubprocessAsync);
const response = (patch: Partial<VerifySubprocessResult> = {}): VerifySubprocessResult => ({
  stdout: '{"passed":true,"score":999,"metrics":{"checks":19}}', stderr: '', exitCode: 0, signal: null,
  timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed', ...patch,
});
function fixture(id = 'fixture', builtin = true, variants = 1, parallel = 1) {
  const directory = join(ROOT, 'universes', id);
  const manifest: ManifestRecord = { id: 'manifest', kind: 'manifest', manifestDigest: 'b'.repeat(64),
    comparatorDigest: 'c'.repeat(64), evaluationBuiltinDigest: 'd'.repeat(64),
    evaluationCommand: ['inert-evaluator'], evaluationExecutableDigest: 'e'.repeat(64),
    seedArtifact: { path: join(directory, 'seed'), digest: 'a'.repeat(64), revision: 'f'.repeat(40) },
    manifest: { schemaVersion: 1, id, name: 'Inert fixture', objective: 'Exercise custody',
      seed: { repo: '/inert-seed', revision: 'f'.repeat(40) }, metric: { name: 'checks', direction: 'maximize', minImprovement: 1 },
      budget: { maxTrials: variants, maxParallel: parallel, maxDurationMs: 60_000, trialTimeoutMs: 30_000 },
      evaluation: builtin ? { builtin: 'preparation-measurement-v1', timeoutMs: 10_000 } : { command: ['inert-evaluator'], timeoutMs: 10_000 },
      variants: Array.from({ length: variants }, (_, index) => ({ id: `variant-${index}`, niche: 'checks',
        hypothesis: 'Controlled candidate', command: ['inert-worker'] })),
    } };
  memory.manifests.set(directory, manifest);
  return { directory, execute: (options: UniverseRunOptions = {}) => runUniverse(id, { root: ROOT, ...options }), rows: () => readBuiltinTrialCustody(directory) };
}
beforeEach(() => {
  vi.clearAllMocks(); memory.manifests.clear(); memory.records.clear(); memory.custody.clear();
  memory.removed.length = 0; memory.failWrite = undefined; memory.failAfterIntent = false; memory.dispatches = 0;
  memory.afterIntent = undefined;
  worker.mockResolvedValue(response());
  evaluator.mockImplementation(async (...args) => { args[9]?.(); memory.dispatches++; return response(); });
});

describe('built-in trial runner custody (inert runtime)', () => {
  it.each(['unconfirmed', 'throw'] as const)('retains %s dispatch, rejects another same-Universe run, and leaves a different Universe available', async mode => {
    const f = fixture();
    evaluator.mockImplementationOnce(async (...args) => {
      args[9]?.(); memory.dispatches++;
      if (mode === 'throw') throw new Error('Lost evaluator response after dispatch');
      return response({ processGroupSettlement: 'unconfirmed' });
    });
    const result = await f.execute();
    expect(result.status).toBe('failed');
    expect(result.trials).toHaveLength(1);
    expect(result.trials[0]).toMatchObject({ score: null, metrics: {}, selected: false });
    expect(f.rows().map(row => row.kind)).toEqual(['intent']);
    expect(memory.removed).not.toContain(f.rows()[0]!.intent.scratchPath);
    await expect(f.execute()).rejects.toThrow('unresolved built-in trial evaluator');
    expect(memory.dispatches).toBe(1); expect(worker).toHaveBeenCalledTimes(1);
    const independent = await fixture('independent').execute();
    expect(independent.status).toBe('completed'); expect(independent.trials[0]?.selected).toBe(true);
    expect(memory.dispatches).toBe(2);
  });

  it('does not dispatch or delete uncertain publication scratch when intent publication fails', async () => {
    const f = fixture(); memory.failWrite = 'intent';
    const result = await f.execute();
    expect(memory.dispatches).toBe(0);
    expect(result.trials[0]).toMatchObject({ score: null, selected: false });
    expect(result.trials[0]?.error).toContain('publication failure');
    expect(memory.removed).toEqual([]); expect(f.rows()).toEqual([]);
  });

  it('fences another generation under the same still-owned execution lease', async () => {
    fixture();
    evaluator.mockImplementationOnce(async (...args) => {
      args[9]?.(); memory.dispatches++; return response({ processGroupSettlement: 'unconfirmed' });
    });
    await withUniverseExecution('fixture', { root: ROOT }, async lock => {
      const result = await runUniverseOwned('fixture', { root: ROOT }, lock);
      expect(result.status).toBe('failed');
      await expect(runUniverseOwned('fixture', { root: ROOT }, lock)).rejects.toThrow('unresolved built-in trial evaluator');
      expect(memory.dispatches).toBe(1); expect(worker).toHaveBeenCalledTimes(1);
    });
  });

  it.each([undefined, []])('refuses missing or malformed process settlement (%j)', async settlement => {
    const f = fixture();
    evaluator.mockImplementationOnce(async (...args) => {
      args[9]?.(); memory.dispatches++;
      return response({ processGroupSettlement: settlement as VerifySubprocessResult['processGroupSettlement'] });
    });
    const result = await f.execute();
    expect(result.status).toBe('failed'); expect(result.trials[0]).toMatchObject({ score: null, metrics: {}, selected: false });
    expect(f.rows().map(row => row.kind)).toEqual(['intent']); expect(memory.removed).toEqual([]);
    await expect(f.execute()).rejects.toThrow('unresolved built-in trial evaluator');
  });

  it('retains the intent and scratch when confirmed settlement cannot be published', async () => {
    const f = fixture(); memory.failWrite = 'settlement';
    const result = await f.execute();
    expect(memory.dispatches).toBe(1); expect(f.rows().map(row => row.kind)).toEqual(['intent']);
    expect(result.status).toBe('failed'); expect(result.trials[0]).toMatchObject({ score: null, selected: false });
    expect(memory.removed).toEqual([]);
    memory.failWrite = undefined;
    await expect(f.execute()).rejects.toThrow('unresolved built-in trial evaluator');
    expect(memory.dispatches).toBe(1);
  });

  it('holds a published intent whose acknowledgment failed without dispatching the evaluator', async () => {
    const f = fixture(); memory.failAfterIntent = true;
    const result = await f.execute();
    expect(memory.dispatches).toBe(0); expect(result.status).toBe('failed');
    expect(f.rows().map(row => row.kind)).toEqual(['intent']); expect(memory.removed).toEqual([]);
    memory.failAfterIntent = false;
    await expect(f.execute()).rejects.toThrow('unresolved built-in trial evaluator');
    expect(memory.dispatches).toBe(0);
  });

  it('refuses a stop that arrives at the final dispatch hook before publishing or launching', async () => {
    const f = fixture(); let stopped = false;
    evaluator.mockImplementationOnce(async (...args) => {
      stopped = true; args[9]?.(); memory.dispatches++; return response();
    });
    const result = await f.execute({ isExecutionStopped: () => stopped });
    expect(memory.dispatches).toBe(0); expect(f.rows()).toEqual([]);
    expect(result.trials[0]).toMatchObject({ score: null, selected: false });
    expect(result.trials[0]?.error).toContain('stopped before dispatch');
  });

  it('retains published intent and refuses dispatch when stop arrives during publication', async () => {
    const f = fixture(); let stopped = false;
    memory.afterIntent = () => { stopped = true; };
    const result = await f.execute({ isExecutionStopped: () => stopped });
    expect(memory.dispatches).toBe(0); expect(result.status).toBe('failed');
    expect(result.trials[0]).toMatchObject({ score: null, selected: false });
    expect(f.rows().map(row => row.kind)).toEqual(['intent']); expect(memory.removed).toEqual([]);
    await expect(f.execute()).rejects.toThrow('unresolved built-in trial evaluator');
  });

  it.each([
    ['known not-started', { processGroupSettlement: 'not-started', exitCode: -1, error: 'Not launched' }],
    ['not-started with forged successful output', { processGroupSettlement: 'not-started' }],
    ['confirmed failure', { exitCode: 1 }], ['malformed output', { stdout: 'not-json' }],
  ] satisfies Array<[string, Partial<VerifySubprocessResult>]>)('settles %s and permits another run without promoting a score', async (_name, patch) => {
    const f = fixture(); evaluator.mockImplementationOnce(async (...args) => { args[9]?.(); memory.dispatches++; return response(patch); });
    const result = await f.execute();
    expect(result.trials[0]).toMatchObject({ score: null, selected: false });
    expect(f.rows().map(row => row.kind)).toEqual(['intent', 'settlement']);
    expect(memory.removed).toContain(f.rows()[0]!.intent.scratchPath);
    expect((await f.execute()).status).toBe('completed'); expect(memory.dispatches).toBe(2);
  });

  it('accepts a never-started preflight refusal without requiring an intent', async () => {
    const f = fixture(); evaluator.mockResolvedValueOnce(response({ processGroupSettlement: 'not-started', exitCode: -1, error: 'Preflight refused' }));
    const result = await f.execute();
    expect(result.trials[0]).toMatchObject({ score: null, selected: false });
    expect(f.rows()).toEqual([]); expect(memory.removed).toHaveLength(1);
    expect((await f.execute()).status).toBe('completed');
  });

  it('aborts siblings but awaits their drain before returning and never starts the next batch', async () => {
    const f = fixture('fixture', true, 3, 2);
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    let releaseSibling!: () => void;
    const sibling = new Promise<void>(resolve => { releaseSibling = resolve; });
    let bothDispatched!: () => void;
    const dispatched = new Promise<void>(resolve => { bothDispatched = resolve; });
    let aborted!: () => void;
    const abortObserved = new Promise<void>(resolve => { aborted = resolve; });
    evaluator.mockImplementation(async (...args) => {
      args[9]?.(); memory.dispatches++;
      if (memory.dispatches === 1) { await first; return response({ processGroupSettlement: 'unconfirmed' }); }
      args[6]!.addEventListener('abort', () => aborted(), { once: true });
      bothDispatched(); await sibling;
      return response({ cancelled: true, exitCode: -1 });
    });
    let finished = false;
    const running = f.execute().finally(() => { finished = true; });
    await dispatched; releaseFirst(); await abortObserved;
    expect(finished).toBe(false); expect(memory.dispatches).toBe(2);
    releaseSibling(); const result = await running;
    expect(result.status).toBe('failed'); expect(worker).toHaveBeenCalledTimes(2);
    expect(result.trials).toHaveLength(2); expect(result.trials.every(trial => !trial.selected && trial.score === null)).toBe(true);
    const rows = f.rows(); expect(rows.filter(row => row.kind === 'intent')).toHaveLength(2);
    expect(rows.filter(row => row.kind === 'settlement')).toHaveLength(1);
    expect(memory.removed).toHaveLength(1);
    await expect(f.execute()).rejects.toThrow('unresolved built-in trial evaluator');
  });

  it('does not change legacy command evaluator settlement requirements or create builtin custody', async () => {
    const f = fixture('legacy', false);
    evaluator.mockResolvedValue(response({ processGroupSettlement: 'unconfirmed' }));
    const result = await f.execute();
    expect(result.status).toBe('completed'); expect(result.trials[0]).toMatchObject({ score: 999, selected: true });
    expect(evaluator.mock.calls[0]![8]).toBe(false); expect(evaluator.mock.calls[0]![9]).toBeUndefined();
    expect(f.rows()).toEqual([]); expect(memory.removed).toHaveLength(1);
  });
});
