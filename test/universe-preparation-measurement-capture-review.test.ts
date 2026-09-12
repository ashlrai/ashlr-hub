/** Independent custody decoder/admission regressions; all storage and locks mocked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImmutablePrivateRecordCodec, ImmutablePrivateRecordStoreConfig } from '../src/core/util/immutable-private-record-store.js';
import type { PreparationCaptureRecord } from '../src/core/universe/preparation-measurement-capture-store.js';
import type { PreparationMeasurementCaptureIntent, PreparationMeasurementCaptureReceipt } from '../src/core/universe/preparation-measurement-capture-types.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), acquire: vi.fn(), release: vi.fn(), seedGuard: vi.fn() }));
vi.mock('../src/core/util/immutable-private-record-store.js', () => ({ readImmutablePrivateRecords: mocks.read, writeImmutablePrivateRecord: mocks.write }));
vi.mock('../src/core/fleet/local-store-lock.js', () => ({ acquireLocalStoreLockWithOutcome: mocks.acquire,
  releaseLocalStoreLock: mocks.release, ownsLocalStoreLock: vi.fn(() => true) }));
vi.mock('../src/core/universe/campaign-store.js', () => ({ assertCampaignSeedEvaluatorsSettled: mocks.seedGuard }));
vi.mock('../src/core/universe/artifacts.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/universe/artifacts.js')>(), inspectPrivateDirectory: (path: string) => path,
}));
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireUniverseExecution } from '../src/core/universe/execution.js';
import { assertPreparationMeasurementsSettled, projectPreparationCapture, readPreparationCaptureRecords } from '../src/core/universe/preparation-measurement-capture-store.js';

const root = '/private/capture-fixture', directory = `${root}/universes/seed`;
function intent(): PreparationMeasurementCaptureIntent {
  const git = { path: '/Library/Developer/CommandLineTools/usr/bin/git', digest: 'e'.repeat(64) };
  return { schemaVersion: 1, captureId: 'capture', universeId: 'seed', startedAt: '2026-09-12T12:00:00.000Z',
    deadlineAt: '2026-09-12T12:00:01.000Z', timeoutMs: 1000, manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64),
    artifact: { path: `${directory}/seed`, digest: 'c'.repeat(64), revision: 'd'.repeat(40) },
    evaluator: { id: 'preparation-measurement-v1', digest: 'f'.repeat(64), executableDigest: 'a'.repeat(64),
      command: ['/private/node', '/private/preparation-verification.mjs'],
      files: [{ name: 'preparation-verification.mjs', path: '/private/preparation-verification.mjs', digest: 'b'.repeat(64) }],
      tools: [git], git } };
}
function receipt(parent = intent()): PreparationMeasurementCaptureReceipt {
  return { schemaVersion: 1, intentDigest: digest(canonical(parent)), finishedAt: '2026-09-12T12:00:00.500Z',
    durationMs: 500, outcome: 'failed', reason: 'execution-failed', processGroupSettlement: 'group-exit-confirmed',
    identityVerified: true, report: null };
}
function records(result: PreparationMeasurementCaptureReceipt | null = null): PreparationCaptureRecord[] {
  const parent = intent();
  return [{ id: 'capture.intent', kind: 'intent', intent: parent, receipt: null },
    ...(result ? [{ id: 'capture.receipt', kind: 'receipt' as const, intent: parent, receipt: result }] : [])];
}
function validReport(): NonNullable<PreparationMeasurementCaptureReceipt['report']> {
  const stdout = JSON.stringify({ schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1',
    checksPassed: false, metrics: { correctness_checks: 0 }, workflows: [],
    diagnostics: [{ code: 'FIXTURE_SETUP_FAILED', message: 'Private fixture detail' }] }) + '\n';
  return { stdout, sha256: digest(stdout), bytes: Buffer.byteLength(stdout), checksPassed: false };
}
let codec: ImmutablePrivateRecordCodec<PreparationCaptureRecord>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockImplementation((config: ImmutablePrivateRecordStoreConfig<PreparationCaptureRecord>) => {
    codec = config.codecForRead()!;
    return { sourceState: 'healthy', sourcePresent: true, complete: true, records: [] };
  });
  mocks.acquire.mockImplementation((path: string) => ({ state: 'acquired', lock: { path, token: 'owned' } }));
  mocks.release.mockReturnValue(true);
  readPreparationCaptureRecords(directory);
});

describe('independent diagnostic capture receipt codec', () => {
  it('accepts the explicit closed diagnostic allowance at 1,800,000 ms', () => {
    const parent = { ...intent(), timeoutMs: 1_800_000, deadlineAt: '2026-09-12T12:30:00.000Z' };
    const input = { id: 'capture.intent', kind: 'intent', intent: parent, receipt: null };
    expect(codec.parse(input)).toEqual(input);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('rejects an allowance above 1,800,000 ms even with a matching deadline', () => {
    const parent = { ...intent(), timeoutMs: 1_800_001, deadlineAt: '2026-09-12T12:30:00.001Z' };
    expect(codec.parse({ id: 'capture.intent', kind: 'intent', intent: parent, receipt: null })).toBeNull();
  });
  it.each(['2026-09-12T12:29:59.999Z', '2026-09-12T12:30:00.001Z'])(
    'refuses a deadline inconsistent with the recorded allowance: %s', deadlineAt => {
      const parent = { ...intent(), timeoutMs: 1_800_000, deadlineAt };
      expect(codec.parse({ id: 'capture.intent', kind: 'intent', intent: parent, receipt: null })).toBeNull();
    });
  it('does not extend the larger allowance to another evaluator identity', () => {
    const parent = { ...intent(), timeoutMs: 1_800_000, deadlineAt: '2026-09-12T12:30:00.000Z' };
    const input = { id: 'capture.intent', kind: 'intent', receipt: null,
      intent: { ...parent, evaluator: { ...parent.evaluator, id: 'another-evaluator' } } };
    expect(codec.parse(input)).toBeNull();
  });
  it('retains exact valid failed-report bytes without creating score evidence', () => {
    const report = validReport(), input = records({ ...receipt(), report })[1]!;
    expect(codec.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
    const result = projectPreparationCapture([records()[0]!, input], 'capture');
    expect(result).toMatchObject({ scope: 'diagnostic-only', state: 'recorded', receipt: { outcome: 'failed', report } });
    expect(result.receipt).not.toHaveProperty('score');
    expect(result.receipt!.report).not.toBe(report);
  });
  it.each(['not-started', 'group-exit-confirmed', 'unconfirmed'])('rejects JSON-array settlement coercion %s', settlement => {
    const input = records(receipt())[1]!;
    expect(codec.parse({ ...input, receipt: { ...input.receipt, processGroupSettlement: [settlement] } })).toBeNull();
  });
  it.each(['intent', 'receipt'])('rejects JSON-array record kind coercion %s', kind => {
    const input = kind === 'intent' ? records()[0]! : records(receipt())[1]!;
    expect(codec.parse({ ...input, kind: [kind] })).toBeNull();
  });
  it('rejects a receipt predating its intent but permits completion exactly at start', () => {
    const input = records(receipt())[1]!;
    expect(codec.parse({ ...input, receipt: { ...input.receipt, finishedAt: '2026-09-12T11:59:59.999Z' } })).toBeNull();
    expect(codec.parse({ ...input, receipt: { ...input.receipt, finishedAt: input.intent.startedAt, durationMs: 0 } })).not.toBeNull();
  });
  it.each([{ bytes: 0 }, { sha256: 'a'.repeat(64) }, { checksPassed: true }, { stdout: 'not-json' }])('rejects altered report evidence %j', patch => {
    const input = records(receipt())[1]!;
    expect(codec.parse({ ...input, receipt: { ...input.receipt, report: { ...validReport(), ...patch } } })).toBeNull();
  });
  it.each([{ identityVerified: false }, { processGroupSettlement: 'not-started' }, { processGroupSettlement: 'unconfirmed' }, { report: null }])(
    'refuses a captured claim lacking verified settled report evidence %j', patch => {
      const input = records(receipt())[1]!;
      expect(codec.parse({ ...input, receipt: { ...receipt(), outcome: 'captured', reason: null, report: validReport(), ...patch } })).toBeNull();
    });
  it('requires held/unconfirmed to agree in both directions', () => {
    const input = records(receipt())[1]!;
    expect(codec.parse({ ...input, receipt: { ...receipt(), processGroupSettlement: 'unconfirmed' } })).toBeNull();
    expect(codec.parse({ ...input, receipt: { ...receipt(), outcome: 'held', reason: 'settlement-unconfirmed' } })).toBeNull();
  });
});

describe('same-Universe pending diagnostic ownership fence', () => {
  function readRows(rows: PreparationCaptureRecord[]) {
    mocks.read.mockImplementation((config: ImmutablePrivateRecordStoreConfig<PreparationCaptureRecord>) => ({
      sourceState: 'healthy', sourcePresent: true, complete: true,
      records: config.rootPath === `${directory}/preparation-measurements` ? rows : [],
    }));
  }
  it.each(['intent-only', 'held-receipt'] as const)('holds %s, releases refused lease and permits another Universe', kind => {
    const rows = records(kind === 'held-receipt' ? { ...receipt(), outcome: 'held', reason: 'settlement-unconfirmed', processGroupSettlement: 'unconfirmed' } : null);
    readRows(rows);
    expect(() => acquireUniverseExecution('seed', { root })).toThrow(/unresolved evaluator/);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith({ path: `${directory}/.execution.lock`, token: 'owned' });
    expect(acquireUniverseExecution('other', { root })).toMatchObject({ state: 'acquired' });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(projectPreparationCapture(rows, 'capture')).toMatchObject({ state: 'held' });
  });
  it.each(['failed', 'cancelled', 'timed-out'] as const)('does not hold ordinary admission for settled %s', outcome => {
    const reason = outcome === 'failed' ? 'execution-failed' : outcome === 'cancelled' ? 'cancelled' : 'deadline-reached';
    readRows(records({ ...receipt(), outcome, reason }));
    expect(() => assertPreparationMeasurementsSettled(directory)).not.toThrow();
    expect(acquireUniverseExecution('seed', { root })).toMatchObject({ state: 'acquired' });
    expect(mocks.release).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('leaves confirmed not-started receipts settled without calling any execution operation', () => {
    readRows(records({ ...receipt(), processGroupSettlement: 'not-started', identityVerified: false }));
    expect(() => assertPreparationMeasurementsSettled(directory)).not.toThrow();
    expect(mocks.acquire).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('does not treat a partial or corrupt store as absent', () => {
    mocks.read.mockReturnValue({ sourceState: 'degraded', sourcePresent: true, complete: false, records: [] });
    expect(() => acquireUniverseExecution('seed', { root })).toThrow(/evidence unavailable/);
    expect(mocks.release).toHaveBeenCalledOnce(); expect(mocks.write).not.toHaveBeenCalled();
  });
});
