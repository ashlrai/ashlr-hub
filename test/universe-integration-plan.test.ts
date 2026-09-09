import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitTreeEntry } from '../src/core/universe/delivery-git.js';

const mocks = vi.hoisted(() => ({ readDeliveries: vi.fn(), deliveryGit: vi.fn() }));
vi.mock('../src/core/universe/delivery.js', () => ({ readUniverseDeliveries: mocks.readDeliveries }));
vi.mock('../src/core/universe/delivery-git.js', () => ({ deliveryGit: mocks.deliveryGit }));

import { readUniverseIntegrationPlan, validateUniverseIntegrationDefinition } from '../src/core/universe/integration-plan.js';

const base = 'a'.repeat(40);
const commitA = 'b'.repeat(40);
const commitB = 'c'.repeat(40);
const treeA = 'd'.repeat(40);
const treeB = 'e'.repeat(40);
const deliveryA = '1'.repeat(64);
const deliveryB = '2'.repeat(64);
const oid = (digit: string): string => digit.repeat(40);
const entries = (rows: Array<[string, string, boolean]>): GitTreeEntry[] => rows.map(([path, value, executable]) => ({ path, oid: value, executable }));

function receipt(universeId: string, id: string, commit: string, tree: string, changedFiles: string[] = ['a.txt']) {
  return { schemaVersion: 1 as const, id, universeId, trialId: `trial-${id.slice(0, 4)}`, runId: `run-${id.slice(0, 4)}`,
    niche: 'quality', manifestDigest: 'f'.repeat(64), comparatorDigest: '9'.repeat(64), artifactDigest: '8'.repeat(64),
    repo: '/repo', branch: `codex/${id.slice(0, 6)}`, baseCommit: base, commit, tree, changedFiles, status: 'delivered' as const,
    createdAt: '2026-09-09T00:00:00.000Z', completedAt: '2026-09-09T00:00:01.000Z' };
}
function definition(sources = [
  { universeId: 'universe-a', deliveryId: deliveryA, commit: commitA, tree: treeA },
  { universeId: 'universe-b', deliveryId: deliveryB, commit: commitB, tree: treeB },
], allowedPaths = ['a.txt', 'b.txt']) {
  return { schemaVersion: 1 as const, id: 'compose', target: { repo: '/repo', baseCommit: base, allowedPaths }, sources };
}
function setup(trees: Map<string, GitTreeEntry[]>, reports: Map<string, unknown>): void {
  mocks.readDeliveries.mockImplementation((universeId: string) => reports.get(universeId));
  mocks.deliveryGit.mockImplementation(() => ({
    oid: vi.fn(() => base),
    entries: vi.fn((tree: string) => {
      const value = trees.get(tree);
      if (!value) throw new Error('missing tree');
      return value.map((entry) => ({ ...entry }));
    }),
    invoke: vi.fn((_args: string[], input: string) => Buffer.from(input.trim().split('\n').filter(Boolean)
      .map((value) => `${value} blob 1`).join('\n') + (input.trim() ? '\n' : ''))),
  }));
}

beforeEach(() => { vi.clearAllMocks(); });

describe('strict Universe integration planning', () => {
  it('rejects malformed definitions before any delivery or Git observation', () => {
    expect(() => validateUniverseIntegrationDefinition({ ...definition(), sources: definition().sources.slice(0, 1) })).toThrow(/two to eight/);
    expect(() => validateUniverseIntegrationDefinition({ ...definition(), target: { ...definition().target, allowedPaths: ['../unsafe'] } })).toThrow(/allowed paths/);
    expect(() => validateUniverseIntegrationDefinition({ ...definition(), sources: [{ ...definition().sources[0], universeId: 4 }, definition().sources[1]] })).toThrow(/source pins/);
    expect(() => validateUniverseIntegrationDefinition({ ...definition(), extra: true })).toThrow(/exact/);
    expect(mocks.readDeliveries).not.toHaveBeenCalled();
    expect(mocks.deliveryGit).not.toHaveBeenCalled();
  });

  it('derives an ordered disjoint overlay from verified trees and caches a shared-Universe report', () => {
    const first = receipt('universe-a', deliveryA, commitA, treeA, ['wrong.txt']);
    const second = receipt('universe-a', deliveryB, commitB, treeB, ['also-wrong.txt']);
    setup(new Map([
      [base, entries([['seed.txt', oid('0'), false]])],
      [treeA, entries([['seed.txt', oid('0'), false], ['a.txt', oid('1'), false]])],
      [treeB, entries([['seed.txt', oid('0'), false], ['b.txt', oid('2'), true]])],
    ]), new Map([['universe-a', { sourceState: 'healthy', reasons: [], deliveries: [first, second] }]]));
    const result = readUniverseIntegrationPlan(definition([
      { universeId: 'universe-a', deliveryId: deliveryA, commit: commitA, tree: treeA },
      { universeId: 'universe-a', deliveryId: deliveryB, commit: commitB, tree: treeB },
    ]));
    expect(mocks.readDeliveries).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sourceState: 'healthy', compositionReady: true, conflicts: [],
      entries: [{ path: 'a.txt', oid: oid('1'), executable: false, sourceDeliveryIds: [deliveryA] },
        { path: 'b.txt', oid: oid('2'), executable: true, sourceDeliveryIds: [deliveryB] }] });
    expect(result.sources.map((source) => source.changedPathCount)).toEqual([1, 1]);
    expect(result.sources.every((source) => source.receiptDigest !== null)).toBe(true);
    expect(result.compositionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows identical edits but reports divergent same-path overlays as healthy evidence conflicts', () => {
    const first = receipt('universe-a', deliveryA, commitA, treeA);
    const second = receipt('universe-b', deliveryB, commitB, treeB);
    const reports = new Map([['universe-a', { sourceState: 'healthy', reasons: [], deliveries: [first] }],
      ['universe-b', { sourceState: 'healthy', reasons: [], deliveries: [second] }]]);
    setup(new Map([[base, entries([])], [treeA, entries([['a.txt', oid('1'), false]])], [treeB, entries([['a.txt', oid('1'), false]])]]), reports);
    expect(readUniverseIntegrationPlan(definition()).compositionReady).toBe(true);
    setup(new Map([[base, entries([])], [treeA, entries([['a.txt', oid('1'), false]])], [treeB, entries([['a.txt', oid('2'), false]])]]), reports);
    const conflict = readUniverseIntegrationPlan(definition());
    expect(conflict).toMatchObject({ sourceState: 'healthy', compositionReady: false, compositionDigest: null,
      conflicts: [{ code: 'path-conflict', paths: ['a.txt'], sourceDeliveryIds: [deliveryA, deliveryB] }] });
    setup(new Map([[base, entries([])], [treeA, entries([['a.txt', oid('1'), false]])], [treeB, entries([['a.txt', oid('1'), true]])]]), reports);
    expect(readUniverseIntegrationPlan(definition())).toMatchObject({ compositionReady: false,
      conflicts: [{ code: 'path-conflict', paths: ['a.txt'], sourceDeliveryIds: [deliveryA, deliveryB] }] });
  });

  it('rejects delete-versus-edit and file-directory overlays without choosing a winner', () => {
    const first = receipt('universe-a', deliveryA, commitA, treeA);
    const second = receipt('universe-b', deliveryB, commitB, treeB);
    const reports = new Map([['universe-a', { sourceState: 'healthy', reasons: [], deliveries: [first] }],
      ['universe-b', { sourceState: 'healthy', reasons: [], deliveries: [second] }]]);
    setup(new Map([[base, entries([['shared', oid('0'), false]])], [treeA, entries([])],
      [treeB, entries([['shared', oid('1'), false]])]]), reports);
    expect(readUniverseIntegrationPlan(definition(undefined, ['shared']))).toMatchObject({ compositionReady: false,
      conflicts: [{ code: 'path-conflict', paths: ['shared'] }] });
    setup(new Map([[base, entries([])], [treeA, entries([['folder', oid('1'), false]])],
      [treeB, entries([['folder/child.txt', oid('2'), false]])]]), reports);
    expect(readUniverseIntegrationPlan(definition(undefined, ['folder', 'folder/child.txt'])).conflicts)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'file-directory-conflict', paths: ['folder', 'folder/child.txt'] })]));
  });

  it('detects case-fold and Unicode-equivalent final path aliases, including directory segments', () => {
    const first = receipt('universe-a', deliveryA, commitA, treeA);
    const second = receipt('universe-b', deliveryB, commitB, treeB);
    const reports = new Map([['universe-a', { sourceState: 'healthy', reasons: [], deliveries: [first] }],
      ['universe-b', { sourceState: 'healthy', reasons: [], deliveries: [second] }]]);
    setup(new Map([[base, entries([])], [treeA, entries([['Foo/a.txt', oid('1'), false]])],
      [treeB, entries([['foo/b.txt', oid('2'), false]])]]), reports);
    expect(readUniverseIntegrationPlan(definition(undefined, ['Foo/a.txt', 'foo/b.txt'])).conflicts)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'case-fold-conflict', paths: ['Foo', 'foo'] })]));
    setup(new Map([[base, entries([])], [treeA, entries([['café.txt', oid('1'), false]])],
      [treeB, entries([['café.txt', oid('2'), false]])]]), reports);
    expect(() => readUniverseIntegrationPlan(definition(undefined, ['café.txt', 'café.txt']))).toThrow(/allowed paths/);
  });

  it('withholds a recipe when reports, pins, trees, or allowlists cannot be verified without exposing raw errors', () => {
    const first = receipt('universe-a', deliveryA, commitA, treeA);
    const second = receipt('universe-b', deliveryB, commitB, treeB);
    setup(new Map([[base, entries([])], [treeA, entries([['outside.txt', oid('1'), false]])], [treeB, entries([['b.txt', oid('2'), false]])]]),
      new Map([['universe-a', { sourceState: 'degraded', reasons: ['/private/error'], deliveries: [first] }],
        ['universe-b', { sourceState: 'healthy', reasons: [], deliveries: [{ ...second, commit: oid('7') }] }]]));
    const result = readUniverseIntegrationPlan(definition());
    expect(result).toMatchObject({ sourceState: 'degraded', compositionReady: false, compositionDigest: null });
    expect(JSON.stringify(result)).not.toContain('/private/error');
    expect(result.reasons).toEqual(expect.arrayContaining(['source-delivery-unavailable', 'source-delivery-pin-mismatch']));
  });

  it('bounds aggregate final bytes through one batch check and handles a missing source report', () => {
    const first = receipt('universe-a', deliveryA, commitA, treeA);
    const second = receipt('universe-b', deliveryB, commitB, treeB);
    const reports = new Map([['universe-a', { sourceState: 'healthy', reasons: [], deliveries: [first] }],
      ['universe-b', { sourceState: 'healthy', reasons: [], deliveries: [second] }]]);
    setup(new Map([[base, entries([])], [treeA, entries([['a.txt', oid('1'), false]])], [treeB, entries([['b.txt', oid('2'), false]])]]), reports);
    const original = mocks.deliveryGit.getMockImplementation()!;
    mocks.deliveryGit.mockImplementation((repo: string) => ({ ...original(repo),
      invoke: vi.fn((_args: string[], input: string) => Buffer.from(input.trim().split('\n').filter(Boolean)
        .map((value) => `${value} blob 40000000`).join('\n') + '\n')) }));
    expect(readUniverseIntegrationPlan(definition())).toMatchObject({ sourceState: 'degraded', compositionReady: false,
      compositionDigest: null, reasons: expect.arrayContaining(['final-tree-byte-limit-exceeded']) });
    setup(new Map([[base, entries([])], [treeA, entries([['a.txt', oid('1'), false]])], [treeB, entries([['b.txt', oid('2'), false]])]]),
      new Map([['universe-a', { sourceState: 'healthy', reasons: [], deliveries: [first] }]]));
    expect(readUniverseIntegrationPlan(definition())).toMatchObject({ sourceState: 'degraded', compositionReady: false,
      reasons: expect.arrayContaining(['source-delivery-unavailable']) });
  });

  it('coalesces identical deletions to an empty tree without a blob query', () => {
    const reports = new Map([
      ['universe-a', { sourceState: 'healthy', reasons: [], deliveries: [receipt('universe-a', deliveryA, commitA, treeA)] }],
      ['universe-b', { sourceState: 'healthy', reasons: [], deliveries: [receipt('universe-b', deliveryB, commitB, treeB)] }],
    ]);
    setup(new Map([[base, entries([['a.txt', oid('0'), false]])], [treeA, []], [treeB, []]]), reports);
    const plan = readUniverseIntegrationPlan(definition());
    expect(plan).toMatchObject({ sourceState: 'healthy', compositionReady: true,
      entries: [{ path: 'a.txt', oid: null, executable: null, sourceDeliveryIds: [deliveryA, deliveryB] }] });
    expect(mocks.deliveryGit.mock.results[0]!.value.invoke).not.toHaveBeenCalled();
  });
});
