import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImmutablePrivateRecordStoreConfig } from '../src/core/util/immutable-private-record-store.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';

const state = vi.hoisted(() => ({ attempts: [] as unknown[], failReceipt: false, onIntent: undefined as (() => void) | undefined }));
const mocks = vi.hoisted(() => ({
  evaluator: vi.fn(), plan: vi.fn(), assertExecution: vi.fn(), assertComparator: vi.fn(),
}));

vi.mock('../src/core/util/immutable-private-record-store.js', () => ({
  readImmutablePrivateRecords: vi.fn((config: ImmutablePrivateRecordStoreConfig<unknown>) => {
    const records = state.attempts.map((value) => config.codecForRead()!.parse(value));
    return { sourceState: records.includes(null) ? 'degraded' : records.length ? 'healthy' : 'missing',
      complete: !records.includes(null), records };
  }),
  writeImmutablePrivateRecord: vi.fn((config: ImmutablePrivateRecordStoreConfig<unknown>, record: { kind: string }) => {
    if (record.kind === 'receipt' && state.failReceipt) return 'failed';
    const codec = config.codecForWrite()!;
    const raw = JSON.parse(codec.serialize(record));
    if (!codec.parse(raw)) return 'invalid';
    state.attempts.push(raw);
    if (record.kind === 'intent') state.onIntent?.();
    return 'recorded';
  }),
}));
vi.mock('../src/core/universe/execution.js', () => ({
  withUniverseExecution: async (_id: string, _options: unknown, action: (lock: object) => unknown) => action({}),
  assertUniverseExecution: mocks.assertExecution,
}));
vi.mock('../src/core/universe/store.js', () => ({
  manifestRecord: vi.fn(() => ({ manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64),
    manifest: { objective: 'Evaluate this exact candidate', seed: { repo: '/repo', revision: 'c'.repeat(40) }, evaluation: { timeoutMs: 1_000 } },
    seedArtifact: { path: '/tmp/seed', digest: 'd'.repeat(64), revision: 'c'.repeat(40) }, evaluationCommand: ['/bin/true'],
    evaluationExecutableDigest: 'e'.repeat(64) })),
  projectUniverse: vi.fn(() => ({ sourceState: 'healthy', activeRun: null })),
  universePath: (root: string, id: string) => join(root, 'universes', id),
  assertComparatorUnchanged: mocks.assertComparator,
  parseEvaluation: (value: string) => JSON.parse(value),
}));
vi.mock('../src/core/universe/integration-plan.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/universe/integration-plan.js')>(),
  readUniverseIntegrationPlan: mocks.plan,
}));
vi.mock('../src/core/universe/delivery-git.js', () => ({
  deliveryGit: vi.fn(() => ({ entries: vi.fn(() => []), readEntries: vi.fn(() => [
    { path: 'value.txt', data: Buffer.from('combined\n'), executable: false },
  ]) })),
}));
vi.mock('../src/core/universe/fixed-evaluator.js', () => ({
  runFixedUniverseEvaluator: mocks.evaluator,
}));

import { evaluateUniverseIntegration } from '../src/core/universe/integration-evaluate.js';

const roots: string[] = [];
const definition = {
  schemaVersion: 1 as const, id: 'combined', target: { repo: '/repo', baseCommit: 'c'.repeat(40), allowedPaths: ['value.txt'] },
  sources: [
    { universeId: 'source-a', deliveryId: '1'.repeat(64), commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
    { universeId: 'source-b', deliveryId: '2'.repeat(64), commit: 'f'.repeat(40), tree: '0'.repeat(40) },
  ],
};
function request(id = 'request-one') {
  return { schemaVersion: 1 as const, id, integration: definition, expectedCompositionDigest: '9'.repeat(64),
    acceptance: { universeId: 'fixture', manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64) }, maxDurationMs: 5_000 };
}
function readyPlan() {
  return { compositionReady: true, compositionDigest: '9'.repeat(64), entries: [
    { path: 'value.txt', oid: '1'.repeat(40), executable: false, sourceDeliveryIds: ['1'.repeat(64)] },
  ] };
}
function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'universe-integration-evaluate-')));
  mkdirSync(join(value, 'universes', 'fixture'), { recursive: true, mode: 0o700 }); roots.push(value); return value;
}

beforeEach(() => {
  state.attempts = []; state.failReceipt = false; state.onIntent = undefined;
  vi.clearAllMocks(); mocks.plan.mockReturnValue(readyPlan());
  mocks.evaluator.mockResolvedValue({ stdout: JSON.stringify({ passed: true, score: 1, metrics: { cases: 1 } }), stderr: '', exitCode: 0,
    signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' });
});
afterEach(() => {
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (stat.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  };
  for (const value of roots.splice(0)) { writable(value); rmSync(value, { recursive: true, force: true }); }
});

describe('Universe integration evaluation durable fault boundaries', () => {
  it('does not create evidence or materialize after a pre-aborted request', async () => {
    const signal = AbortSignal.abort();
    await expect(evaluateUniverseIntegration(request(), { root: root(), signal })).rejects.toThrow(/cancelled/);
    expect(state.attempts).toEqual([]); expect(mocks.plan).not.toHaveBeenCalled(); expect(mocks.evaluator).not.toHaveBeenCalled();
  });

  it('settles cancellation after durable intent but before evaluator launch', async () => {
    const controller = new AbortController();
    state.onIntent = () => controller.abort();
    await expect(evaluateUniverseIntegration(request(), { root: root(), signal: controller.signal })).resolves.toMatchObject({
      status: 'cancelled', score: null, reason: 'evaluation-cancelled' });
    expect(state.attempts).toHaveLength(2); expect(mocks.evaluator).not.toHaveBeenCalled();
  });

  it('retains only an intent after unconfirmed process-group settlement and holds every new request', async () => {
    mocks.evaluator.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', timedOut: true, cancelled: true,
      processGroupSettlement: 'unconfirmed' });
    const value = root();
    await expect(evaluateUniverseIntegration(request(), { root: value })).rejects.toThrow(/settlement is unresolved/);
    expect(state.attempts).toHaveLength(1); expect((state.attempts[0] as { kind: string }).kind).toBe('intent');
    await expect(evaluateUniverseIntegration(request('request-two'), { root: value })).rejects.toThrow(/unresolved attempt/);
    expect(mocks.evaluator).toHaveBeenCalledTimes(1);
  });

  it('does not treat a settled evaluator result as complete when its receipt cannot be written', async () => {
    state.failReceipt = true;
    const value = root();
    await expect(evaluateUniverseIntegration(request(), { root: value })).rejects.toThrow(/durably written/);
    expect(state.attempts).toHaveLength(1); expect((state.attempts[0] as { kind: string }).kind).toBe('intent');
    await expect(evaluateUniverseIntegration(request('request-two'), { root: value })).rejects.toThrow(/unresolved attempt/);
  });

  it('refuses receipt replay when its delivered-source composition pins no longer verify', async () => {
    const value = root();
    await expect(evaluateUniverseIntegration(request(), { root: value })).resolves.toMatchObject({ status: 'passed' });
    mocks.plan.mockReturnValue({ compositionReady: false, compositionDigest: null, entries: [] });
    await expect(evaluateUniverseIntegration(request(), { root: value })).rejects.toThrow();
    expect(mocks.evaluator).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'unknown'])('retains unresolved intent when strict settlement is %s', async (settlement) => {
    mocks.evaluator.mockResolvedValueOnce({ stdout: '{"passed":true,"score":1,"metrics":{}}', exitCode: 0,
      signal: null, processGroupSettlement: settlement });
    await expect(evaluateUniverseIntegration(request(), { root: root() })).rejects.toThrow(/settlement is unresolved/);
    expect(state.attempts).toHaveLength(1);
  });

  it('records cancellation only after the evaluator resolves its confirmed settlement', async () => {
    const controller = new AbortController();
    let settle!: (value: unknown) => void;
    mocks.evaluator.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const value = root();
    const pending = evaluateUniverseIntegration(request(), { root: value, signal: controller.signal });
    expect(mocks.evaluator).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(state.attempts).toHaveLength(1);
    settle({ stdout: '', exitCode: null, signal: 'SIGTERM', cancelled: true, processGroupSettlement: 'group-exit-confirmed' });
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', score: null, reason: 'evaluation-cancelled' });
    expect(state.attempts).toHaveLength(2);
  });

  it('persists and replays a confirmed timeout without another evaluator invocation', async () => {
    mocks.evaluator.mockResolvedValueOnce({ stdout: '', exitCode: null, signal: 'SIGTERM', timedOut: true,
      processGroupSettlement: 'group-exit-confirmed' });
    const value = root();
    const result = await evaluateUniverseIntegration(request(), { root: value });
    expect(result).toMatchObject({ status: 'timed-out', score: null, artifactPath: null, reason: 'evaluation-timed-out' });
    expect(await evaluateUniverseIntegration(request(), { root: value })).toEqual(result);
    expect(mocks.evaluator).toHaveBeenCalledTimes(1);
  });

  it('does not interpret malformed evaluator text as an unresolved-process sentinel', async () => {
    mocks.evaluator.mockResolvedValueOnce({ stdout: 'unsettled private evaluator output', exitCode: 0, signal: null,
      processGroupSettlement: 'group-exit-confirmed' });
    const result = await evaluateUniverseIntegration(request(), { root: root() });
    expect(result).toMatchObject({ status: 'failed', reason: 'evaluator-failed', score: null, metrics: {} });
    expect(JSON.stringify(state.attempts)).not.toContain('private evaluator output');
    expect(state.attempts).toHaveLength(2);
  });

  it('withholds the measurement when source composition changes during evaluation', async () => {
    mocks.evaluator.mockImplementationOnce(async () => {
      mocks.plan.mockReturnValue({ compositionReady: true, compositionDigest: '8'.repeat(64), entries: [] });
      return { stdout: '{"passed":true,"score":1,"metrics":{}}', exitCode: 0, signal: null,
        processGroupSettlement: 'group-exit-confirmed' };
    });
    await expect(evaluateUniverseIntegration(request(), { root: root() })).resolves.toMatchObject({
      status: 'failed', reason: 'composition-changed', score: null, artifactPath: null });
    expect(state.attempts).toHaveLength(2);
  });

  it('reserves maximum receipt space before materialization or evaluation', async () => {
    const input = request();
    input.integration = { ...definition, target: { ...definition.target,
      allowedPaths: Array.from({ length: 2_400 }, (_, index) => `file-${index}-${'x'.repeat(90)}`) } };
    await expect(evaluateUniverseIntegration(input, { root: root() })).rejects.toThrow(/capacity/);
    expect(state.attempts).toHaveLength(0); expect(mocks.evaluator).not.toHaveBeenCalled();
  });

  it('reserves aggregate evidence space before starting another individually valid request', async () => {
    const value = root();
    const baseline = await evaluateUniverseIntegration(request(), { root: value });
    state.attempts = [];
    const input = { ...request('next-request'), maxDurationMs: 120_000,
      integration: { ...definition, target: { ...definition.target,
        allowedPaths: Array.from({ length: 2_000 }, (_, index) => `file-${index}-${'x'.repeat(90)}`) } } };
    let bytes = 0;
    for (let index = 0; index < 128; index++) {
      const prior = { ...input, id: `prior-${index}` };
      const hash = digest(canonical({ domain: 'universe-integration-evaluation-v1', request: prior }));
      const common = { request: prior, requestDigest: hash, startedAt: baseline.startedAt };
      const pair = [
        { ...common, id: `${hash}.intent`, kind: 'intent', result: null },
        { ...common, id: `${hash}.receipt`, kind: 'receipt', result: { ...baseline, id: prior.id, requestDigest: hash,
          artifactPath: join(value, 'universes', 'fixture', 'integrations', hash, 'artifact') } },
      ];
      const pairBytes = pair.reduce((sum, item) => sum + Buffer.byteLength(`${canonical(item)}\n`), 0);
      if (bytes + pairBytes > 32 * 1024 * 1024) break;
      bytes += pairBytes; state.attempts.push(...pair);
    }
    const count = state.attempts.length;
    expect(count).toBeGreaterThan(0); expect(count).toBeLessThan(256);
    await expect(evaluateUniverseIntegration(input, { root: value })).rejects.toThrow(/capacity/);
    expect(state.attempts).toHaveLength(count); expect(mocks.evaluator).toHaveBeenCalledTimes(1);
  });

  it.each(['orphan', 'acceptance', 'artifact-path', 'status-reason', 'started-at'])('rejects incoherent %s receipt evidence', async (fault) => {
    const value = root();
    await evaluateUniverseIntegration(request(), { root: value });
    const receipt = state.attempts[1] as { startedAt: string; result: {
      acceptance: { manifestDigest: string }; artifactPath: string; reason: string | null;
    } };
    if (fault === 'orphan') state.attempts.shift();
    if (fault === 'acceptance') receipt.result.acceptance.manifestDigest = '0'.repeat(64);
    if (fault === 'artifact-path') receipt.result.artifactPath = '/unrelated/artifact';
    if (fault === 'status-reason') receipt.result.reason = 'evaluator-failed';
    if (fault === 'started-at') receipt.startedAt = '2020-01-01T00:00:00.000Z';
    await expect(evaluateUniverseIntegration(request(), { root: value })).rejects.toThrow(/evidence/);
    expect(mocks.evaluator).toHaveBeenCalledTimes(1);
  });
});
