import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { captureUniversePreparationMeasurement, readUniversePreparationMeasurementCapture } from '../src/core/universe/preparation-measurement-capture.js';
import { assertPreparationMeasurementsSettled, readPreparationCaptureRecords } from '../src/core/universe/preparation-measurement-capture-store.js';
import type { PreparationCaptureRecord } from '../src/core/universe/preparation-measurement-capture-store.js';
import { runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';
import { assertComparatorUnchanged, manifestRecord } from '../src/core/universe/store.js';
import { resolveBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
import { assertUniverseExecution, withUniverseExecution } from '../src/core/universe/execution.js';
import { writeImmutablePrivateRecord } from '../src/core/util/immutable-private-record-store.js';
import { readKillSwitch } from '../src/core/sandbox/policy.js';
import type { ManifestRecord } from '../src/core/universe/store.js';
import type { InstalledBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
import type { VerifySubprocessResult } from '../src/core/run/verify-commands.js';
import type { ImmutablePrivateRecordStoreConfig } from '../src/core/util/immutable-private-record-store.js';

const memory = vi.hoisted(() => ({ stores: new Map<string, unknown[]>(), reads: 0, writes: 0, readFault: false }));
vi.mock('../src/core/universe/artifacts.js', async original => ({ ...await original<object>(),
  inspectPrivateDirectory: vi.fn((path: string) => path), privateDirectory: vi.fn((path: string) => path), artifactDigest: vi.fn(() => 'd'.repeat(64)) }));
vi.mock('../src/core/universe/store.js', () => ({ manifestRecord: vi.fn(), assertComparatorUnchanged: vi.fn() }));
vi.mock('../src/core/universe/builtin-evaluator-registry.js', () => ({ resolveBuiltinEvaluator: vi.fn() }));
vi.mock('../src/core/universe/fixed-evaluator.js', () => ({ runFixedUniverseEvaluator: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', () => ({ readKillSwitch: vi.fn() }));
vi.mock('../src/core/universe/execution.js', () => ({ assertUniverseExecution: vi.fn(), withUniverseExecution: vi.fn() }));
vi.mock('../src/core/util/immutable-private-record-store.js', () => ({
  readImmutablePrivateRecords: vi.fn((config: ImmutablePrivateRecordStoreConfig<unknown>) => {
    memory.reads++;
    if (memory.readFault) return { sourceState: 'degraded', sourcePresent: true, complete: false, records: [] };
    const rows = memory.stores.get(config.rootPath);
    if (!rows) return { sourceState: 'missing', sourcePresent: false, complete: false, records: [] };
    const parsed = rows.map(row => config.codecForRead()!.parse(structuredClone(row)));
    return { sourceState: parsed.includes(null) ? 'degraded' : 'healthy', sourcePresent: true, complete: !parsed.includes(null), records: parsed };
  }),
  writeImmutablePrivateRecord: vi.fn((config: ImmutablePrivateRecordStoreConfig<unknown>, value: unknown, options: { prepublish(): boolean }) => {
    memory.writes++;
    const codec = config.codecForWrite()!, serialized = codec.serialize(value);
    const parsed = codec.parse(JSON.parse(serialized));
    if (!parsed || Buffer.byteLength(serialized) > config.maxRecordBytes) return 'invalid';
    options.prepublish(); options.prepublish(); options.prepublish();
    const rows = memory.stores.get(config.rootPath) ?? [];
    const old = rows.find(row => codec.recordId(row) === codec.recordId(parsed));
    if (old) return codec.equivalent(old, parsed) ? 'replayed' : 'conflicted';
    memory.stores.set(config.rootPath, [...rows, structuredClone(parsed)]); return 'recorded';
  }),
}));
const request = { root: '/private/capture', universeId: 'sample', captureId: 'first' };
const directory = '/private/capture/universes/sample';
const store = `${directory}/preparation-measurements`;
let record: ManifestRecord;
let installed: InstalledBuiltinEvaluator;
const output = () => '  ' + JSON.stringify({ schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1',
  checksPassed: false, metrics: { correctness_checks: 3 }, workflows: [],
  diagnostics: [{ code: 'CANDIDATE_BEHAVIOR_FAILED', message: 'Fixed checks refused.' }] }) + '\n\n';
function result(patch: Partial<VerifySubprocessResult> = {}): VerifySubprocessResult {
  return { stdout: output(), stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false,
    processGroupSettlement: 'group-exit-confirmed', ...patch };
}
beforeEach(() => {
  vi.clearAllMocks(); memory.stores.clear(); memory.reads = 0; memory.writes = 0; memory.readFault = false;
  vi.mocked(assertUniverseExecution).mockReset();
  installed = { id: 'preparation-measurement-v1', digest: 'a'.repeat(64), executableDigest: 'b'.repeat(64), command: ['/fixed/node', '/fixed/main.mjs'],
    files: [{ name: 'preparation-verification.mjs', path: '/fixed/main.mjs', digest: 'c'.repeat(64) }],
    tools: [{ path: '/fixed/git', digest: 'e'.repeat(64) }], git: { path: '/fixed/git', digest: 'e'.repeat(64) } };
  record = { id: 'manifest', kind: 'manifest', manifest: { id: 'sample', evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: 1000 } } as ManifestRecord['manifest'],
    manifestDigest: 'f'.repeat(64), comparatorDigest: '1'.repeat(64), seedArtifact: { path: `${directory}/seed`, digest: 'd'.repeat(64), revision: '2'.repeat(40) },
    evaluationBuiltinDigest: installed.digest, evaluationExecutableDigest: installed.executableDigest, evaluationCommand: installed.command };
  vi.mocked(manifestRecord).mockImplementation(() => structuredClone(record));
  vi.mocked(resolveBuiltinEvaluator).mockImplementation(() => structuredClone(installed));
  vi.mocked(readKillSwitch).mockReturnValue({ sourceState: 'healthy', state: 'inactive' } as ReturnType<typeof readKillSwitch>);
  vi.mocked(withUniverseExecution).mockImplementation(async (id, _options, operation) => {
    assertPreparationMeasurementsSettled(`/private/capture/universes/${id}`);
    return operation({} as never);
  });
  vi.mocked(runFixedUniverseEvaluator).mockImplementation(async (...args) => { args[9]?.(); return result(); });
});
describe('one-shot diagnostic capture (mocked execution and storage)', () => {
  it('retains a complete checks-satisfied report without manufacturing an evaluation score', async () => {
    const workflows = [
      { name: 'manager', methods: ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'] },
      { name: 'successor', methods: ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'] },
    ].map(row => ({ name: row.name, processes: row.methods.length, blobProcesses: row.methods.length,
      requests: row.methods.map((method, index) => ({ id: index + 1, method, processes: 1, blobProcesses: 1 })) }));
    const metrics = { correctness_checks: 19, verification_processes: 4, workflow_processes: 11, workflow_blob_processes: 11,
      fixture_owned_process_groups: 1, ...Object.fromEntries(['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata']
        .flatMap(key => [[`${key}_processes`, 1], [`${key}_blob_processes`, 1]])) };
    const stdout = JSON.stringify({ schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1',
      checksPassed: true, metrics, workflows, diagnostics: [] }) + '\n';
    vi.mocked(runFixedUniverseEvaluator).mockResolvedValue(result({ stdout }));
    const value = await captureUniversePreparationMeasurement(request);
    expect(value.receipt).toMatchObject({ outcome: 'captured', report: { stdout, checksPassed: true } });
    expect(value.receipt).not.toHaveProperty('score'); expect(value.receipt).not.toHaveProperty('passed');
  });
  it('preserves complete failed diagnostic bytes and exact pins without scoring or generation', async () => {
    const value = await captureUniversePreparationMeasurement(request);
    expect(value.state).toBe('recorded'); expect(value.receipt?.outcome).toBe('captured');
    expect(value.receipt?.report).toEqual({ stdout: output(), sha256: digest(output()), bytes: Buffer.byteLength(output()), checksPassed: false });
    expect(value.intent?.evaluator).toEqual(installed); expect(value.intent?.artifact).toEqual(record.seedArtifact);
    expect(Date.parse(value.intent!.deadlineAt) - Date.parse(value.intent!.startedAt)).toBe(1000);
    expect(value.receipt?.intentDigest).toBe(digest(canonical(value.intent)));
    expect(runFixedUniverseEvaluator).toHaveBeenCalledOnce(); expect(memory.writes).toBe(2);
    expect(runFixedUniverseEvaluator).toHaveBeenCalledWith(expect.anything(), request.root, record.seedArtifact.path, record.seedArtifact.digest,
      `${directory}/preparation-measurement-work/first`, expect.any(Number), expect.any(AbortSignal), {}, true, expect.any(Function));
    expect(() => assertPreparationMeasurementsSettled(directory)).not.toThrow();
  });
  it('replays exact completed facts before ownership/KILL/current evaluator checks even beside another pending attempt', async () => {
    const first = await captureUniversePreparationMeasurement(request);
    const rows = memory.stores.get(store)!;
    const pending = structuredClone(rows[0]) as { id: string; intent: { captureId: string } };
    pending.id = 'pending.intent'; pending.intent.captureId = 'pending'; rows.push(pending);
    vi.mocked(resolveBuiltinEvaluator).mockImplementation(() => { throw new Error('changed'); });
    const writes = memory.writes;
    expect(await captureUniversePreparationMeasurement(request)).toEqual({ ...first, disposition: 'replayed' });
    expect(withUniverseExecution).toHaveBeenCalledOnce(); expect(memory.writes).toBe(writes);
    expect(readUniversePreparationMeasurementCapture(request).receipt).toEqual(first.receipt);
  });
  it('bounds captures before spending another invocation and preserves old read-only replay at capacity', async () => {
    const first = await captureUniversePreparationMeasurement(request);
    const originals = memory.stores.get(store)! as PreparationCaptureRecord[];
    memory.stores.set(store, Array.from({ length: 64 }, (_, index) => originals.map(source => {
      const row = structuredClone(source), captureId = index === 0 ? 'first' : `capture-${index}`;
      row.id = `${captureId}.${row.kind}`; row.intent.captureId = captureId;
      if (row.receipt) row.receipt.intentDigest = digest(canonical(row.intent));
      return row;
    })).flat());
    await expect(captureUniversePreparationMeasurement({ ...request, captureId: 'overflow' })).rejects.toThrow(/capacity/);
    expect(await captureUniversePreparationMeasurement(request)).toEqual({ ...first, disposition: 'replayed' });
    expect(runFixedUniverseEvaluator).toHaveBeenCalledOnce(); expect(memory.writes).toBe(2);
  });
  it.each(['returned', 'thrown'])('holds unresolved %s settlement and refuses a new ID in the same Universe', async mode => {
    vi.mocked(runFixedUniverseEvaluator).mockImplementation(async (...args) => { args[9]?.();
      if (mode === 'thrown') throw new Error('private dispatch error'); return result({ processGroupSettlement: 'unconfirmed' }); });
    const value = await captureUniversePreparationMeasurement(request);
    expect(value.state).toBe('held'); expect(value.receipt?.outcome).toBe('held');
    expect(value.receipt?.report?.stdout ?? null).toBe(mode === 'returned' ? output() : null);
    expect(await captureUniversePreparationMeasurement(request)).toEqual({ ...value, disposition: 'replayed' });
    await expect(captureUniversePreparationMeasurement({ ...request, captureId: 'second' })).rejects.toThrow(/unresolved/);
    expect(() => assertPreparationMeasurementsSettled('/private/capture/universes/other')).not.toThrow();
    expect(runFixedUniverseEvaluator).toHaveBeenCalledOnce();
  });
  it.each([{ stdout: 'not JSON' }, { stdout: output(), outputTruncated: true as const }])('refuses invalid/truncated report while recording settled failure', async patch => {
    vi.mocked(runFixedUniverseEvaluator).mockResolvedValue(result(patch));
    const value = await captureUniversePreparationMeasurement(request);
    expect(value.receipt).toMatchObject({ outcome: 'failed', reason: 'invalid-report', report: null });
    expect(() => assertPreparationMeasurementsSettled(directory)).not.toThrow();
  });
  it('retains valid output on settled process failure', async () => {
    vi.mocked(runFixedUniverseEvaluator).mockResolvedValue(result({ exitCode: 1 }));
    const value = await captureUniversePreparationMeasurement(request);
    expect(value.receipt).toMatchObject({ outcome: 'failed', reason: 'execution-failed', report: { stdout: output() } });
  });
  it('records settled cancellation, retains report and permits later independent capture', async () => {
    const controller = new AbortController();
    vi.mocked(runFixedUniverseEvaluator).mockImplementationOnce(async (...args) => { args[9]?.(); controller.abort(); return result({ cancelled: true }); });
    const value = await captureUniversePreparationMeasurement({ ...request, signal: controller.signal });
    expect(value.receipt).toMatchObject({ outcome: 'cancelled', report: { stdout: output() } });
    await expect(captureUniversePreparationMeasurement({ ...request, captureId: 'second' })).resolves.toMatchObject({ state: 'recorded' });
  });
  it('retains valid output but refuses captured identity after source drift', async () => {
    vi.mocked(runFixedUniverseEvaluator).mockImplementationOnce(async (...args) => { args[9]?.(); record.comparatorDigest = '9'.repeat(64); return result(); });
    const value = await captureUniversePreparationMeasurement(request);
    expect(value.receipt).toMatchObject({ outcome: 'failed', reason: 'integrity-changed', identityVerified: false, report: { stdout: output() } });
  });
  it('checks KILL before creating intent or dispatching', async () => {
    vi.mocked(readKillSwitch).mockReturnValue({ sourceState: 'healthy', state: 'active' } as ReturnType<typeof readKillSwitch>);
    await expect(captureUniversePreparationMeasurement(request)).rejects.toThrow(/stopped/);
    expect(runFixedUniverseEvaluator).not.toHaveBeenCalled(); expect(memory.writes).toBe(0);
  });
  it('refuses pre-aborted new capture without durable intent', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(captureUniversePreparationMeasurement({ ...request, signal: controller.signal })).rejects.toThrow(/stopped/);
    expect(runFixedUniverseEvaluator).not.toHaveBeenCalled(); expect(memory.writes).toBe(0);
  });
  it('does not renew deadline after expensive pre-dispatch work', async () => {
    const dispatch = vi.fn(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(runFixedUniverseEvaluator).mockImplementationOnce(async (...args) => {
      clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      args[9]?.(); dispatch(); return result();
    });
    try {
      const value = await captureUniversePreparationMeasurement(request);
      expect(value.receipt).toMatchObject({ outcome: 'timed-out', reason: 'deadline-reached', processGroupSettlement: 'not-started' });
      expect(dispatch).not.toHaveBeenCalled();
    } finally { clock?.mockRestore(); }
  });
  it('records known settled failure after a definite final publication pin refusal, without rerunning evaluation', async () => {
    vi.mocked(runFixedUniverseEvaluator).mockImplementationOnce(async (...args) => {
      args[9]?.();
      // Post-return pins succeed; the next fresh manifest read is publication.
      vi.mocked(manifestRecord).mockImplementationOnce(() => structuredClone(record)).mockImplementationOnce(() => {
        throw new Error('publication drift');
      });
      return result();
    });
    expect(await captureUniversePreparationMeasurement(request)).toMatchObject({ state: 'recorded',
      receipt: { outcome: 'failed', reason: 'integrity-changed', identityVerified: false, report: { stdout: output() } } });
    expect(() => assertPreparationMeasurementsSettled(directory)).not.toThrow();
    expect(runFixedUniverseEvaluator).toHaveBeenCalledOnce();
  });
  it('does not retry an unclassified storage publication failure', async () => {
    const original = vi.mocked(writeImmutablePrivateRecord).getMockImplementation()!;
    vi.mocked(writeImmutablePrivateRecord).mockImplementationOnce(original).mockReturnValueOnce('failed');
    await expect(captureUniversePreparationMeasurement(request)).rejects.toThrow(/unavailable/);
    expect(vi.mocked(writeImmutablePrivateRecord)).toHaveBeenCalledTimes(2);
    expect(readUniversePreparationMeasurementCapture(request)).toMatchObject({ state: 'held', receipt: null });
    expect(runFixedUniverseEvaluator).toHaveBeenCalledOnce();
  });
  it('does not classify final ownership loss as a retryable pin refusal', async () => {
    vi.mocked(runFixedUniverseEvaluator).mockImplementationOnce(async (...args) => {
      args[9]?.(); let calls = 0;
      vi.mocked(assertUniverseExecution).mockImplementation(() => { if (++calls === 3) throw new Error('ownership lost'); });
      return result();
    });
    await expect(captureUniversePreparationMeasurement(request)).rejects.toThrow(/ownership lost/);
    expect(writeImmutablePrivateRecord).toHaveBeenCalledTimes(2);
    expect(readUniversePreparationMeasurementCapture(request)).toMatchObject({ state: 'held', receipt: null });
  });
  it('does not fall back after a definite refusal when storage still has an incomplete stage', async () => {
    vi.mocked(runFixedUniverseEvaluator).mockImplementationOnce(async (...args) => {
      args[9]?.();
      vi.mocked(manifestRecord).mockImplementationOnce(() => structuredClone(record)).mockImplementationOnce(() => {
        memory.readFault = true; throw new Error('publication drift and leftover stage');
      });
      return result();
    });
    await expect(captureUniversePreparationMeasurement(request)).rejects.toThrow(/unavailable/);
    expect(writeImmutablePrivateRecord).toHaveBeenCalledTimes(2); expect(memory.stores.get(store)).toHaveLength(1);
  });
  it('latches KILL during execution and stops the existing invocation', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(runFixedUniverseEvaluator).mockImplementationOnce(async (...args) => { args[9]?.();
        vi.mocked(readKillSwitch).mockReturnValue({ sourceState: 'healthy', state: 'active' } as ReturnType<typeof readKillSwitch>);
        await new Promise<void>(resolve => args[6].addEventListener('abort', () => resolve(), { once: true }));
        return result({ cancelled: true }); });
      const running = captureUniversePreparationMeasurement(request);
      await vi.advanceTimersByTimeAsync(50);
      expect((await running).receipt?.outcome).toBe('cancelled'); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each([null, undefined, { ...request, unknown: true }, { ...request, root: '/' }, { ...request, captureId: '../bad' }])('rejects malformed options before storage %j', async input => {
    await expect(captureUniversePreparationMeasurement(input as never)).rejects.toThrow(); expect(memory.reads).toBe(0);
  });
  it('rejects getters/proxies without reading them, and does not mutate caller options', async () => {
    const getter = vi.fn();
    await expect(captureUniversePreparationMeasurement({ ...request, get root() { return getter(); } })).rejects.toThrow();
    await expect(captureUniversePreparationMeasurement(new Proxy(request, { getOwnPropertyDescriptor: getter }))).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(memory.reads).toBe(0);
  });
  it('rejects altered persisted report bytes/shape and holds shared admission', async () => {
    await captureUniversePreparationMeasurement(request);
    const row = memory.stores.get(store)![1] as { receipt: { report: { stdout: string } } };
    row.receipt.report.stdout += ' ';
    expect(() => readUniversePreparationMeasurementCapture(request)).toThrow(/unavailable/);
    expect(() => assertPreparationMeasurementsSettled(directory)).toThrow(/unavailable/);
  });
  it('refuses legacy evaluator without dispatch or intent', async () => {
    record.manifest.evaluation = { command: ['/fixed/legacy'], timeoutMs: 1000 };
    await expect(captureUniversePreparationMeasurement(request)).rejects.toThrow(/builtin/); expect(memory.writes).toBe(0);
  });
  it('reads missing capture without creating storage or verifying current executable', () => {
    expect(readUniversePreparationMeasurementCapture(request)).toMatchObject({ state: 'missing', intent: null, receipt: null });
    expect(resolveBuiltinEvaluator).not.toHaveBeenCalled(); expect(assertComparatorUnchanged).not.toHaveBeenCalled(); expect(memory.writes).toBe(0);
    expect(readPreparationCaptureRecords(directory)).toEqual([]);
  });
});
