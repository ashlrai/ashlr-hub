import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ branchCommit: null as string | null, commit: null as string | null, failCreate: false,
  failIntent: false, failReceipt: false, abortAfterCommit: null as AbortController | null, abortBeforeGuard: null as AbortController | null }));
const mocks = vi.hoisted(() => ({ readEvaluation: vi.fn(), settled: vi.fn(), comparator: vi.fn(), owned: vi.fn(), createRef: vi.fn() }));

vi.mock('../src/core/util/immutable-private-record-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/immutable-private-record-store.js')>();
  return { ...actual, writeImmutablePrivateRecord: (config: Parameters<typeof actual.writeImmutablePrivateRecord>[0],
    value: Parameters<typeof actual.writeImmutablePrivateRecord>[1]) => {
    if ((value as { kind?: string }).kind === 'intent' && state.failIntent) return 'failed';
    if ((value as { kind?: string }).kind === 'receipt' && state.failReceipt) return 'failed';
    return actual.writeImmutablePrivateRecord(config, value);
  } };
});
vi.mock('../src/core/universe/execution.js', () => ({
  withUniverseExecution: async (_id: string, _options: unknown, action: (lock: object) => unknown) => action({}),
  assertUniverseExecution: mocks.owned,
}));
vi.mock('../src/core/universe/integration-evaluate.js', () => ({
  validateUniverseIntegrationEvaluationRequest: (value: unknown) => value,
  readUniverseIntegrationEvaluation: mocks.readEvaluation,
  assertUniverseIntegrationEvaluationsSettled: mocks.settled,
}));
vi.mock('../src/core/universe/artifacts.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/universe/artifacts.js')>(), defaultUniverseRoot: () => '/private/root',
  readArtifactSnapshot: vi.fn(() => ({ digest: 'd'.repeat(64), entries: [{ path: 'value.txt', data: Buffer.from('value'), executable: false }] })),
}));
vi.mock('../src/core/universe/store.js', () => ({
  universePath: (root: string, id: string) => `${root}/universes/${id}`,
  manifestRecord: vi.fn(() => ({ manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64),
    manifest: { seed: { repo: '/repo', revision: 'c'.repeat(40) } } })),
  projectUniverse: vi.fn(() => ({ sourceState: 'healthy', activeRun: null })), assertComparatorUnchanged: mocks.comparator,
}));
vi.mock('../src/core/universe/delivery.js', () => ({ validUniverseDeliveryBranch: (value: unknown) => typeof value === 'string' && value.startsWith('codex/') }));
vi.mock('../src/core/universe/delivery-git.js', () => ({
  deliveryGit: vi.fn(() => {
    const base = 'c'.repeat(40); const baseTree = 'e'.repeat(40); const tree = 'f'.repeat(40);
    return {
      invoke: vi.fn(), writeTree: vi.fn(() => tree), treeDigest: vi.fn(() => 'd'.repeat(64)),
      entries: vi.fn((oid: string) => oid === baseTree ? [] : [{ path: 'value.txt', oid: '2'.repeat(40), executable: false }]),
      oid: vi.fn((args: string[], input?: Buffer) => {
        const value = args.at(-1)!;
        if (value === `${base}^{tree}`) return baseTree;
        if (value === `${base}^{commit}`) return base;
        if (value === `${state.commit}^{tree}`) return tree;
        if (value === `${state.commit}^{commit}`) return state.commit!;
        if (args[0] === 'hash-object') {
          state.commit = require('node:crypto').createHash('sha1').update(`commit ${input!.length}\0`).update(input!).digest('hex');
          return state.commit;
        }
        return value.replace(/\^\{(?:commit|tree)\}$/, '');
      }),
      text: vi.fn(() => `${state.commit} ${base}`), ref: vi.fn(() => state.branchCommit), assertNotCheckedOut: vi.fn(),
      createRef: mocks.createRef.mockImplementation(async (_branch: string, target: string, guard: () => void) => {
        state.abortBeforeGuard?.abort(); guard(); if (state.failCreate) throw new Error('transaction unavailable'); state.branchCommit = target; state.abortAfterCommit?.abort();
      }),
    };
  }),
}));

import { deliverUniverseIntegration, validateUniverseIntegrationDeliveryRequest } from '../src/core/universe/integration-delivery.js';

const evaluation = {
  schemaVersion: 1 as const, id: 'evaluation', integration: {
    schemaVersion: 1 as const, id: 'combined', target: { repo: '/repo', baseCommit: 'c'.repeat(40), allowedPaths: ['value.txt'] },
    sources: [
      { universeId: 'source-a', deliveryId: '1'.repeat(64), commit: '2'.repeat(40), tree: '3'.repeat(40) },
      { universeId: 'source-b', deliveryId: '4'.repeat(64), commit: '5'.repeat(40), tree: '6'.repeat(40) },
    ],
  }, expectedCompositionDigest: '7'.repeat(64), acceptance: { universeId: 'fixture', manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64) },
  maxDurationMs: 10_000,
};
function request(branch = 'codex/integration-result') {
  return { schemaVersion: 1 as const, evaluation, expectedEvaluationDigest: '8'.repeat(64), branch, maxDurationMs: 10_000 };
}
function evidence() {
  return { request: evaluation, result: { schemaVersion: 1 as const, id: 'evaluation', requestDigest: '9'.repeat(64), status: 'passed' as const,
    startedAt: '2026-09-09T00:00:00.000Z', finishedAt: '2026-09-09T00:00:01.000Z', durationMs: 1,
    acceptance: evaluation.acceptance, compositionDigest: evaluation.expectedCompositionDigest, artifactDigest: 'd'.repeat(64),
    artifactPath: '/private/artifact', score: 1, metrics: {}, reason: null }, resultDigest: '8'.repeat(64) };
}
const roots: string[] = [];
function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'universe-integration-delivery-')));
  mkdirSync(join(value, 'universes', 'fixture'), { recursive: true, mode: 0o700 }); roots.push(value); return value;
}
function records(rootPath: string): Array<{ kind: string; receipt: { artifactDigest: string } }> {
  const path = join(rootPath, 'universes', 'fixture', 'integration-deliveries', 'records');
  try { return readdirSync(path).sort().map((name) => JSON.parse(readFileSync(join(path, name), 'utf8'))); } catch { return []; }
}
function makeWritable(path: string): void {
  const stat = lstatSync(path); if (stat.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
}

beforeEach(() => {
  state.branchCommit = null; state.commit = null; state.failCreate = false; state.failIntent = false; state.failReceipt = false;
  state.abortAfterCommit = null; state.abortBeforeGuard = null;
  vi.clearAllMocks(); mocks.readEvaluation.mockReturnValue(evidence());
});
afterEach(() => { for (const value of roots.splice(0)) { makeWritable(value); rmSync(value, { recursive: true, force: true }); } });

describe('Universe integration delivery durable branches', () => {
  it('rejects malformed branch delivery requests before reading evaluation evidence', () => {
    expect(() => validateUniverseIntegrationDeliveryRequest({ ...request(), branch: 'main' })).toThrow(/Invalid/);
    expect(() => validateUniverseIntegrationDeliveryRequest({ ...request(), expectedEvaluationDigest: 'bad' })).toThrow(/Invalid/);
    expect(mocks.readEvaluation).not.toHaveBeenCalled();
  });

  it('withholds all delivery writes when the exact evaluation receipt cannot be read', async () => {
    mocks.readEvaluation.mockImplementation(() => { throw new Error('missing receipt'); });
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow(/missing receipt/);
    expect(records(rootPath)).toEqual([]); expect(mocks.createRef).not.toHaveBeenCalled();
  });

  it('publishes one passing evaluated artifact with durable intent then receipt, without invoking evaluation', async () => {
    const rootPath = root(); const result = await deliverUniverseIntegration(request(), { root: rootPath });
    expect(result).toMatchObject({ status: 'delivered', branch: 'codex/integration-result', artifactDigest: 'd'.repeat(64) });
    expect(records(rootPath).map((row) => row.kind)).toEqual(['intent', 'receipt']); expect(mocks.readEvaluation).toHaveBeenCalled();
  });

  it('retains a pending intent on ref failure and withholds another branch until reconciliation', async () => {
    state.failCreate = true;
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow(/transaction unavailable/);
    expect(records(rootPath).map((row) => row.kind)).toEqual(['intent']);
    state.failCreate = false;
    await expect(deliverUniverseIntegration(request('codex/another-result'), { root: rootPath })).rejects.toThrow(/unresolved branch publication/);
  });

  it('refuses non-passing evaluation evidence before Git plumbing', async () => {
    mocks.readEvaluation.mockReturnValue({ ...evidence(), result: { ...evidence().result, status: 'rejected', reason: 'rejected-by-fixed-evaluator' } });
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow(/passing evaluation/);
    expect(mocks.createRef).not.toHaveBeenCalled(); expect(records(rootPath)).toEqual([]);
  });

  it('rejects a pending intent whose stored evidence no longer matches the evaluation snapshot', async () => {
    state.failCreate = true;
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow(/transaction unavailable/);
    const path = join(rootPath, 'universes', 'fixture', 'integration-deliveries', 'records', readdirSync(join(rootPath, 'universes', 'fixture', 'integration-deliveries', 'records'))[0]!);
    const row = JSON.parse(readFileSync(path, 'utf8')); row.receipt.artifactDigest = 'f'.repeat(64); writeFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    state.failCreate = false;
    await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow();
  });

  it('records settlement after cancellation arrives only after the ref transaction has committed', async () => {
    const controller = new AbortController(); state.abortAfterCommit = controller;
    const rootPath = root(); const result = await deliverUniverseIntegration(request(), { root: rootPath, signal: controller.signal });
    expect(controller.signal.aborted).toBe(true); expect(result.status).toBe('delivered'); expect(records(rootPath)).toHaveLength(2);
  });

  it('does not report a complete delivery when final receipt persistence fails', async () => {
    state.failReceipt = true;
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow(/durably written/);
    expect(state.branchCommit).not.toBeNull(); expect(records(rootPath).map((row) => row.kind)).toEqual(['intent']);
  });

  it('refuses a changed request for an already settled branch instead of advancing it', async () => {
    const rootPath = root(); await deliverUniverseIntegration(request(), { root: rootPath });
    await expect(deliverUniverseIntegration({ ...request(), maxDurationMs: 9_999 }, { root: rootPath })).rejects.toThrow(/already bound/);
    expect(mocks.createRef).toHaveBeenCalledTimes(1);
  });

  it('does not expose a branch when durable intent persistence fails', async () => {
    state.failIntent = true;
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow(/durably written/);
    expect(state.branchCommit).toBeNull(); expect(records(rootPath)).toEqual([]); expect(mocks.createRef).not.toHaveBeenCalled();
  });

  it('reconciles an exact pending intent when its ref exists after a failed final receipt write', async () => {
    state.failReceipt = true;
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow(/durably written/);
    state.failReceipt = false;
    await expect(deliverUniverseIntegration(request(), { root: rootPath })).resolves.toMatchObject({ status: 'delivered' });
    expect(records(rootPath).map((row) => row.kind)).toEqual(['intent', 'receipt']); expect(mocks.createRef).toHaveBeenCalledTimes(1);
  });

  it('retains intent and publishes no branch when abort arrives in the prepared ref guard', async () => {
    const controller = new AbortController(); state.abortBeforeGuard = controller;
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath, signal: controller.signal })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true); expect(state.branchCommit).toBeNull(); expect(records(rootPath).map((row) => row.kind)).toEqual(['intent']);
  });

  it('retains intent and publishes no branch when source evidence drifts in the prepared ref guard', async () => {
    let reads = 0;
    mocks.readEvaluation.mockImplementation(() => {
      reads += 1; return reads >= 3 ? { ...evidence(), resultDigest: '0'.repeat(64) } : evidence();
    });
    const rootPath = root(); await expect(deliverUniverseIntegration(request(), { root: rootPath })).rejects.toThrow(/passing evaluation/);
    expect(state.branchCommit).toBeNull(); expect(records(rootPath).map((row) => row.kind)).toEqual(['intent']);
  });
});
