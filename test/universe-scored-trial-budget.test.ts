/** Runner/admission/codec integration with in-memory storage and inert subprocesses.
 * This is not filesystem durability or native process-settlement evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
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
  dispatches: 0, elapsed: 0,
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
  confinedUniverseArgv: vi.fn((argv: string[]) => argv), runFixedUniverseEvaluator: vi.fn(),
}));

import { assertComparatorUnchanged, validateUniverseManifest } from '../src/core/universe/store.js';
import { canonical } from '../src/core/universe/artifacts.js';
import { generateModelCandidate } from '../src/core/universe/model-candidate.js';
import { newGenerationReceipt } from '../src/core/universe/generation.js';
import { RUN_DEADLINE_BEFORE_SELECTION, runUniverse, runUniverseOwned } from '../src/core/universe/runner.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';
import { confinedUniverseArgv, runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import { readBuiltinTrialCustody } from '../src/core/universe/builtin-trial-custody.js';

const ROOT = '/inert-scored-trial-budget';
const evaluator = vi.mocked(runFixedUniverseEvaluator);
const worker = vi.mocked(runVerifySubprocessAsync);
const response = (patch: Partial<VerifySubprocessResult> = {}): VerifySubprocessResult => ({
  stdout: '{"passed":true,"score":999,"metrics":{"preparation_processes":999}}', stderr: '', exitCode: 0, signal: null,
  timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed', ...patch,
});
function fixture(id = 'fixture', builtin = true, variants = 1, parallel = 1) {
  const directory = join(ROOT, 'universes', id);
  const manifest: ManifestRecord = { id: 'manifest', kind: 'manifest', manifestDigest: 'b'.repeat(64),
    comparatorDigest: 'c'.repeat(64), evaluationBuiltinDigest: 'd'.repeat(64),
    evaluationCommand: ['inert-evaluator'], evaluationExecutableDigest: 'e'.repeat(64),
    seedArtifact: { path: join(directory, 'seed'), digest: 'a'.repeat(64), revision: 'f'.repeat(40) },
    manifest: { schemaVersion: 1, id, name: 'Inert fixture', objective: 'Exercise custody',
      seed: { repo: '/inert-seed', revision: 'f'.repeat(40) }, metric: { name: 'preparation_processes', direction: 'minimize', minImprovement: 1 },
      budget: { maxTrials: variants, maxParallel: parallel, maxDurationMs: 7_200_000, trialTimeoutMs: 2_700_000, workerTimeoutMs: 300_000 },
      evaluation: builtin ? { builtin: 'preparation-process-score-v1', timeoutMs: 1_800_000 } : { command: ['inert-evaluator'], timeoutMs: 10_000 },
      variants: Array.from({ length: variants }, (_, index) => ({ id: `variant-${index}`, niche: 'checks',
        hypothesis: 'Controlled candidate', command: ['inert-worker'] })),
    } };
  memory.manifests.set(directory, manifest);
  return { record: manifest, directory, execute: (options: UniverseRunOptions = {}) => runUniverse(id, { root: ROOT, ...options }), rows: () => readBuiltinTrialCustody(directory) };
}
beforeEach(() => {
  vi.clearAllMocks(); memory.manifests.clear(); memory.records.clear(); memory.custody.clear();
  vi.mocked(assertComparatorUnchanged).mockReset();
  vi.mocked(confinedUniverseArgv).mockImplementation(argv => argv);
  memory.removed.length = 0; memory.failWrite = undefined; memory.failAfterIntent = false; memory.dispatches = 0;
  memory.afterIntent = undefined; memory.elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => 1000 + memory.elapsed);
  vi.spyOn(Date, 'now').mockImplementation(() => Date.parse('2026-09-12T12:00:00.000Z') + memory.elapsed);
  worker.mockResolvedValue(response());
  evaluator.mockImplementation(async (...args) => { args[9]?.(); memory.dispatches++; return response(); });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('explicit scored trial budgets (inert runtime)', () => {
  it('accepts both upper bounds while leaving omitted legacy manifest bytes unchanged', () => {
    const f = fixture(), manifest = f.record.manifest;
    manifest.budget.workerTimeoutMs = 900_000;
    expect(validateUniverseManifest(manifest)).toEqual(manifest);
    delete manifest.budget.workerTimeoutMs; manifest.budget.trialTimeoutMs = 900_000;
    manifest.evaluation = { command: ['inert-evaluator'], timeoutMs: 900_000 };
    const before = canonical(manifest);
    expect(canonical(validateUniverseManifest(manifest))).toBe(before);
    expect(validateUniverseManifest(manifest).budget).not.toHaveProperty('workerTimeoutMs');
  });
  it.each([
    ['worker too long', { workerTimeoutMs: 900_001 }], ['trial too long', { trialTimeoutMs: 2_700_001 }],
    ['zero worker', { workerTimeoutMs: 0 }], ['fractional worker', { workerTimeoutMs: 1.5 }],
    ['worker exceeds trial', { workerTimeoutMs: 900_000, trialTimeoutMs: 800_000 }],
    ['evaluator exceeds trial', { trialTimeoutMs: 1_799_999 }],
    ['undefined worker', { workerTimeoutMs: undefined }],
  ])('refuses %s', (_name, patch) => {
    const manifest = fixture().record.manifest;
    expect(() => validateUniverseManifest({ ...manifest, budget: { ...manifest.budget, ...patch } })).toThrow();
  });
  it.each(['command', 'measurement', 'omitted'])('does not silently extend %s trial budgets', mode => {
    const manifest = fixture().record.manifest;
    if (mode === 'command') manifest.evaluation = { command: ['inert-evaluator'], timeoutMs: 900_000 };
    if (mode === 'measurement') manifest.evaluation = { builtin: 'preparation-measurement-v1', timeoutMs: 1_800_000 };
    if (mode === 'omitted') delete manifest.budget.workerTimeoutMs;
    expect(() => validateUniverseManifest(manifest)).toThrow();
  });
  it('refuses a worker accessor without invoking it', () => {
    const manifest = fixture().record.manifest, get = vi.fn(() => 300_000);
    Object.defineProperty(manifest.budget, 'workerTimeoutMs', { enumerable: true, get });
    expect(() => validateUniverseManifest(manifest)).toThrow(); expect(get).not.toHaveBeenCalled();
  });
  it.each([{ name: 'other' }, { direction: 'maximize' }, { minImprovement: 0 },
    { minImprovement: 0.5 }, { minImprovement: Number.MAX_SAFE_INTEGER + 1 }])('pins scored metric semantics %j', patch => {
    const manifest = fixture().record.manifest;
    expect(() => validateUniverseManifest({ ...manifest, metric: { ...manifest.metric, ...patch } })).toThrow();
  });
  it('allows the scored evaluator ceiling without a split worker budget, but never above it', () => {
    const manifest = fixture().record.manifest;
    delete manifest.budget.workerTimeoutMs; manifest.budget.trialTimeoutMs = 900_000;
    expect(validateUniverseManifest(manifest)).toEqual(manifest);
    expect(() => validateUniverseManifest({ ...manifest, evaluation: { ...manifest.evaluation, timeoutMs: 1_800_001 } })).toThrow();
  });
  it('gives only the worker cap to generation and evaluates beyond minute fifteen', async () => {
    const f = fixture();
    worker.mockImplementationOnce(async (_argv, options) => {
      expect(options.timeoutMs).toBe(300_000); memory.elapsed = 200_000; return response();
    });
    evaluator.mockImplementationOnce(async (...args) => {
      expect(args[5]).toBe(1_800_000); args[9]?.(); memory.dispatches++;
      memory.elapsed = 1_500_000; return response();
    });
    const result = await f.execute();
    expect(result.trials[0]).toMatchObject({ status: 'passed', score: 999, selected: true });
    expect(f.rows().map(row => row.kind)).toEqual(['intent', 'settlement']);
    expect(f.rows()[0]!.intent.evaluatorId).toBe('preparation-process-score-v1');
  });
  it('passes only the worker cap to model generation without contacting a model', async () => {
    const f = fixture();
    const config = { kind: 'local-chat' as const, endpoint: 'http://127.0.0.1:11434', model: 'inert',
      files: ['index.ts'], maxOutputTokens: 10 };
    f.record.manifest.variants = [{ id: 'variant-0', niche: 'checks', hypothesis: 'Inert', generation: config }];
    vi.mocked(generateModelCandidate).mockImplementationOnce(async (_config, options) => {
      expect(options.timeoutMs).toBe(300_000);
      memory.elapsed = 300_000;
      return { ...newGenerationReceipt(config), status: 'succeeded', requestStarted: true };
    });
    const result = await f.execute();
    expect(result.trials[0]).toMatchObject({ status: 'timed-out', score: null, selected: false });
    expect(worker).not.toHaveBeenCalled(); expect(evaluator).not.toHaveBeenCalled();
  });
  it('refuses an apparently successful worker at its deadline before any evaluator custody', async () => {
    const f = fixture();
    worker.mockImplementationOnce(async () => { memory.elapsed = 300_000; return response(); });
    const result = await f.execute();
    expect(result.trials[0]).toMatchObject({ status: 'timed-out', score: null, selected: false });
    expect(evaluator).not.toHaveBeenCalled(); expect(f.rows()).toEqual([]);
  });
  it('refuses worker dispatch when confinement construction exhausts its original cap', async () => {
    const f = fixture();
    vi.mocked(confinedUniverseArgv).mockImplementationOnce(argv => { memory.elapsed = 300_000; return argv; });
    expect((await f.execute()).trials[0]).toMatchObject({ status: 'timed-out', score: null, selected: false });
    expect(worker).not.toHaveBeenCalled(); expect(evaluator).not.toHaveBeenCalled();
  });
  it('propagates the original worker deadline into the model dispatch guard after slow parent proof', async () => {
    const f = fixture(); let slow = false;
    const config = { kind: 'local-chat' as const, endpoint: 'http://127.0.0.1:11434', model: 'inert',
      files: ['index.ts'], maxOutputTokens: 10 };
    f.record.manifest.variants = [{ id: 'variant-0', niche: 'checks', hypothesis: 'Inert', generation: config }];
    vi.mocked(generateModelCandidate).mockImplementationOnce(async (_config, options) => {
      expect(options.isExecutionStopped?.()).toBe(false);
      slow = true;
      expect(options.isExecutionStopped?.()).toBe(true);
      return { ...newGenerationReceipt(config), status: 'cancelled', requestStarted: false };
    });
    const result = await f.execute({ isExecutionStopped: () => { if (slow) memory.elapsed = 300_000; return false; } });
    expect(result.trials[0]).toMatchObject({ selected: false, score: null, generation: { requestStarted: false } });
    expect(evaluator).not.toHaveBeenCalled();
  });
  it('retains omitted shared-budget arithmetic for legacy execution', async () => {
    const f = fixture('legacy', false);
    delete f.record.manifest.budget.workerTimeoutMs; f.record.manifest.budget.trialTimeoutMs = 900_000;
    f.record.manifest.evaluation = { command: ['inert-evaluator'], timeoutMs: 900_000 };
    worker.mockImplementationOnce(async (_argv, options) => {
      expect(options.timeoutMs).toBe(900_000); memory.elapsed = 200_000; return response();
    });
    evaluator.mockImplementationOnce(async (...args) => {
      expect(args[5]).toBe(700_000); expect(args[9]).toBeUndefined(); return response();
    });
    expect((await f.execute()).trials[0]).toMatchObject({ status: 'passed', selected: true });
    expect(f.rows()).toEqual([]);
  });
  it.each(['trial', 'evaluator', 'parent-stop'] as const)('withholds a settled valid score after %s expiry', async cause => {
    const f = fixture(); let stopped = false;
    if (cause === 'trial') f.record.manifest.budget.trialTimeoutMs = 1_800_000;
    evaluator.mockImplementationOnce(async (...args) => {
      args[9]?.(); memory.dispatches++;
      if (cause === 'parent-stop') stopped = true;
      else memory.elapsed = 1_800_000;
      return response();
    });
    const result = await f.execute({ isExecutionStopped: () => stopped });
    expect(result.trials[0]).toMatchObject({ score: null, metrics: {}, selected: false,
      status: cause === 'parent-stop' ? 'cancelled' : 'timed-out' });
    expect(f.rows().map(row => row.kind)).toEqual(['intent', 'settlement']);
  });
  it('clips evaluation to the original run deadline without renewal', async () => {
    const f = fixture(); f.record.manifest.budget.maxDurationMs = 1_000_000;
    worker.mockImplementationOnce(async () => { memory.elapsed = 200_000; return response(); });
    evaluator.mockImplementationOnce(async (...args) => {
      expect(args[5]).toBe(800_000); args[9]?.(); memory.elapsed = 1_000_000; return response();
    });
    expect((await f.execute()).trials[0]).toMatchObject({ status: 'timed-out', selected: false, score: null });
  });
  it('clips to an original campaign deadline and never redispatches a resumed reserved run', async () => {
    fixture();
    const options = { root: ROOT, runId: '12345678-1234-4234-8234-123456789abc', deadlineMs: Date.now() + 500_000 };
    worker.mockImplementationOnce(async () => { memory.elapsed = 200_000; return response(); });
    evaluator.mockImplementationOnce(async (...args) => {
      expect(args[5]).toBe(300_000); args[9]?.(); memory.elapsed = 500_000; return response();
    });
    await withUniverseExecution('fixture', { root: ROOT }, async lock => {
      const result = await runUniverseOwned('fixture', options, lock);
      expect(result.trials[0]).toMatchObject({ score: null, selected: false });
      expect(await runUniverseOwned('fixture', options, lock)).toEqual(result);
    });
    expect(evaluator).toHaveBeenCalledOnce(); expect(worker).toHaveBeenCalledOnce();
  });
  it('does not dispatch after expensive preflight crosses the evaluator deadline', async () => {
    const f = fixture();
    evaluator.mockImplementationOnce(async (...args) => {
      memory.elapsed = 1_800_000; args[9]?.(); memory.dispatches++; return response();
    });
    expect((await f.execute()).trials[0]).toMatchObject({ score: null, selected: false });
    expect(memory.dispatches).toBe(0); expect(f.rows()).toEqual([]);
  });
  it('does not select a winner when final comparator proof crosses the original run deadline', async () => {
    const f = fixture(); f.record.manifest.budget.maxDurationMs = 1_000_000;
    vi.mocked(assertComparatorUnchanged).mockImplementation(() => {
      if (memory.dispatches > 0) memory.elapsed = 1_000_000;
    });
    const result = await f.execute();
    expect(result.status).toBe('failed');
    expect(result.trials[0]).toMatchObject({ selected: false });
    expect(result.error).toBe(RUN_DEADLINE_BEFORE_SELECTION);
    expect(f.rows().map(row => row.kind)).toEqual(['intent', 'settlement']);
  });
  it('holds scored custody after a lost response and never renews by replay', async () => {
    const f = fixture();
    evaluator.mockImplementationOnce(async (...args) => { args[9]?.(); throw new Error('Unconfirmed scored dispatch'); });
    expect((await f.execute()).trials[0]).toMatchObject({ score: null, selected: false });
    expect(f.rows().map(row => row.kind)).toEqual(['intent']); expect(memory.removed).toEqual([]);
    await expect(f.execute()).rejects.toThrow('unresolved built-in trial evaluator');
    expect(evaluator).toHaveBeenCalledOnce();
  });
});
