import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ readDelivery: vi.fn(), settled: vi.fn() }));
vi.mock('../src/core/universe/integration-delivery.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/integration-delivery.js')>(), readUniverseIntegrationDelivery: mocks.readDelivery,
}));
vi.mock('../src/core/universe/integration-evaluate.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/integration-evaluate.js')>(), assertUniverseIntegrationEvaluationsSettled: mocks.settled,
}));

import { artifactDigest, canonical, digest, materializeSeed } from '../src/core/universe/artifacts.js';
import { initUniverse, initUniverseWithIntegrationOrigin, manifestRecord, projectUniverse } from '../src/core/universe/store.js';
import { handoffUniverseIntegration, validateUniverseIntegrationHandoffRequest } from '../src/core/universe/integration-handoff.js';
import type { UniverseIntegrationHandoffRequest, UniverseIntegrationOrigin } from '../src/core/universe/integration-handoff-types.js';
import type { UniverseIntegrationDeliveryEvidence, UniverseIntegrationDeliveryReceipt } from '../src/core/universe/integration-delivery-types.js';
import type { UniverseManifest } from '../src/core/universe/types.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';

const roots: string[] = [];
beforeEach(() => { mocks.readDelivery.mockReset(); mocks.settled.mockReset(); });
afterEach(() => {
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-integration-handoff-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'value.txt'), 'before\n');
  writeFileSync(join(repo, 'evaluate.mjs'), 'throw new Error("registration must not execute an evaluator");\n');
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q']); git(['add', '.']);
  const commit = (): string => {
    git(['-c', 'user.name=Universe Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  const base = commit();
  const acceptance: UniverseManifest = { schemaVersion: 1, id: 'acceptance', name: 'Acceptance', objective: 'Evaluate explicitly',
    seed: { repo, revision: base }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 5_000, trialTimeoutMs: 1_000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1_000 },
    variants: [{ id: 'variant', niche: 'default', hypothesis: 'Explicit worker', command: [process.execPath, 'evaluate.mjs'] }] };
  initUniverse(acceptance, { root });
  const accepted = manifestRecord(join(root, 'universes', acceptance.id));
  writeFileSync(join(repo, 'value.txt'), 'delivered\n'); git(['add', '.']); const delivered = commit();
  const tree = git(['rev-parse', `${delivered}^{tree}`]);
  const seedDigest = materializeSeed({ repo, revision: delivered }, join(root, 'measured-artifact'));
  const downstream: UniverseManifest = { ...acceptance, id: 'downstream', name: 'Downstream', objective: 'A fresh objective', seed: { repo, revision: delivered } };
  const request: UniverseIntegrationHandoffRequest = { schemaVersion: 1, expectedDeliveryDigest: 'a'.repeat(64), downstream,
    delivery: { schemaVersion: 1, branch: 'codex/combined', maxDurationMs: 10_000, expectedEvaluationDigest: 'b'.repeat(64),
      evaluation: { schemaVersion: 1, id: 'evaluation', expectedCompositionDigest: 'c'.repeat(64), maxDurationMs: 10_000,
        acceptance: { universeId: acceptance.id, manifestDigest: accepted.manifestDigest, comparatorDigest: accepted.comparatorDigest },
        integration: { schemaVersion: 1, id: 'integration', target: { repo, baseCommit: base, allowedPaths: ['value.txt'] },
          sources: [{ universeId: 'upstream-a', deliveryId: 'd'.repeat(64), commit: delivered, tree },
            { universeId: 'upstream-b', deliveryId: 'e'.repeat(64), commit: delivered, tree }] } } } };
  const receipt: UniverseIntegrationDeliveryReceipt = { schemaVersion: 1, id: 'f'.repeat(64), requestDigest: '1'.repeat(64),
    evaluationRequestDigest: '2'.repeat(64), evaluationResultDigest: 'b'.repeat(64), universeId: acceptance.id, evaluationId: 'evaluation',
    manifestDigest: accepted.manifestDigest, comparatorDigest: accepted.comparatorDigest, compositionDigest: 'c'.repeat(64),
    artifactDigest: seedDigest, repo, branch: request.delivery.branch, baseCommit: base, commit: delivered, tree,
    changedFiles: ['value.txt'], status: 'delivered', createdAt: '2026-09-09T00:00:00.000Z', completedAt: '2026-09-09T00:00:01.000Z' };
  const evidence: UniverseIntegrationDeliveryEvidence = { request: request.delivery, receipt, receiptDigest: request.expectedDeliveryDigest };
  mocks.readDelivery.mockImplementation(() => structuredClone(evidence));
  const directory = join(root, 'universes', downstream.id);
  const origin: UniverseIntegrationOrigin = { schemaVersion: 1,
    requestDigest: digest(canonical({ domain: 'universe-integration-handoff-request-v1', request })), deliveryDigest: evidence.receiptDigest,
    deliveryId: receipt.id, acceptanceUniverseId: acceptance.id, evaluationId: receipt.evaluationId,
    repo, commit: delivered, tree, artifactDigest: seedDigest };
  return { root, repo, request, accepted, evidence, origin, directory, git };
}

describe('Universe integration downstream registration', () => {
  it('registers provenance atomically and replays without inherited trials or evaluator execution', async () => {
    const f = fixture(); const head = f.git(['rev-parse', 'HEAD']);
    const first = await handoffUniverseIntegration(f.request, { root: f.root });
    expect(first).toMatchObject({ status: 'registered', targetUniverseId: 'downstream', origin: f.origin,
      seedArtifactDigest: f.evidence.receipt.artifactDigest });
    expect(first.comparatorDigest).not.toBe(f.accepted.comparatorDigest);
    expect(await handoffUniverseIntegration(f.request, { root: f.root })).toEqual(first);
    const stored = manifestRecord(f.directory);
    expect(stored.integrationOrigin).toEqual(f.origin);
    expect(projectUniverse(f.directory)).toMatchObject({ sourceState: 'healthy', runs: [], elites: [], activeRun: null });
    expect(readdirSync(join(f.directory, 'ledger', 'records'))).toEqual(['manifest.json']);
    expect(artifactDigest(join(f.directory, 'seed'))).toBe(f.evidence.receipt.artifactDigest);
    expect(readFileSync(join(f.directory, 'seed', 'value.txt'), 'utf8')).toBe('delivered\n');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(f.git(['status', '--porcelain'])).toBe('');
  });

  it.each(['acceptance', 'upstream-a', 'upstream-b'])('rejects source identity %s before reading delivery', async (id) => {
    const f = fixture(); f.request.downstream.id = id;
    await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/distinct downstream/);
    expect(mocks.readDelivery).not.toHaveBeenCalled();
  });

  it.each(['pending', 'unchanged'] as const)('refuses %s delivery without target registration', async (status) => {
    const f = fixture(); f.evidence.receipt.status = status;
    await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/pinned completed delivery/);
    expect(existsSync(f.directory)).toBe(false);
  });

  it('refuses digest, seed commit and repository mismatches without writing a destination', async () => {
    const f = fixture();
    for (const request of [
      { ...f.request, expectedDeliveryDigest: '0'.repeat(64) },
      { ...f.request, downstream: { ...f.request.downstream, seed: { ...f.request.downstream.seed, revision: f.evidence.receipt.baseCommit } } },
      { ...f.request, downstream: { ...f.request.downstream, seed: { ...f.request.downstream.seed, repo: `${f.repo}/other` } } },
    ]) await expect(handoffUniverseIntegration(request, { root: f.root })).rejects.toThrow();
    expect(existsSync(f.directory)).toBe(false);
  });

  it('refuses existing plain registration and a different handoff identity', async () => {
    const f = fixture(); initUniverse(f.request.downstream, { root: f.root });
    await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/origin differs/);
    const g = fixture(); await handoffUniverseIntegration(g.request, { root: g.root });
    g.request.delivery.maxDurationMs += 1;
    await expect(handoffUniverseIntegration(g.request, { root: g.root })).rejects.toThrow(/origin differs/);
  });

  it('retains a partial seed when source changes before publication and refuses automatic recovery', async () => {
    const f = fixture(); mocks.readDelivery.mockImplementationOnce(() => structuredClone(f.evidence))
      .mockImplementationOnce(() => { throw new Error('delivery drifted'); });
    await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/delivery drifted/);
    expect(existsSync(join(f.directory, 'seed'))).toBe(true);
    expect(existsSync(join(f.directory, 'ledger'))).toBe(false);
    await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/Interrupted initialization/);
  });

  it('refuses a delivered digest that differs from the materialized committed seed', async () => {
    const f = fixture(); f.evidence.receipt.artifactDigest = '0'.repeat(64);
    await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/seed differs from delivered artifact/);
    expect(existsSync(join(f.directory, 'ledger'))).toBe(false);
  });

  it('withholds while acceptance execution is owned or evaluation settlement is unresolved', async () => {
    const f = fixture();
    await withUniverseExecution('acceptance', { root: f.root }, async () => {
      await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/execution owner/);
    });
    mocks.settled.mockImplementation(() => { throw new Error('evaluation unresolved'); });
    await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/evaluation unresolved/);
    expect(existsSync(f.directory)).toBe(false);
  });

  it('captures caller intent and rejects invalid closed shapes without invoking accessors', () => {
    const f = fixture(); const copied = validateUniverseIntegrationHandoffRequest(f.request);
    f.request.downstream.name = 'Changed later'; expect(copied.downstream.name).toBe('Downstream');
    for (const invalid of [{ ...f.request, unexpected: true }, { ...f.request, expectedDeliveryDigest: 'bad' },
      { ...f.request, schemaVersion: 2 }, { ...f.request, downstream: { ...f.request.downstream, budget: {} } }]) {
      expect(() => validateUniverseIntegrationHandoffRequest(invalid)).toThrow();
    }
    const getter = vi.fn(() => f.request.delivery);
    const value = { ...f.request }; Object.defineProperty(value, 'delivery', { enumerable: true, get: getter });
    expect(() => validateUniverseIntegrationHandoffRequest(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});

describe('Atomic integration provenance in the Universe manifest', () => {
  it('preserves plain initialization, including idempotent replay', () => {
    const f = fixture();
    expect(initUniverse(f.request.downstream, { root: f.root })).toEqual(f.request.downstream);
    expect(initUniverse(f.request.downstream, { root: f.root })).toEqual(f.request.downstream);
    expect(manifestRecord(f.directory).integrationOrigin).toBeUndefined();
  });

  it.each(['requestDigest', 'deliveryDigest', 'deliveryId', 'artifactDigest', 'commit', 'tree', 'repo', 'acceptanceUniverseId', 'evaluationId'] as const)(
    'rejects invalid origin %s before initialization', (key) => {
    const f = fixture(); const origin = { ...f.origin, [key]: 'INVALID' };
    expect(() => initUniverseWithIntegrationOrigin(f.request.downstream, origin, () => {}, { root: f.root })).toThrow(/Invalid Universe integration origin/);
    expect(existsSync(f.directory)).toBe(false);
  });

  it.each(['scalar', 'promise', 'thenable'] as const)('refuses a non-void %s source guard before manifest publication', async (kind) => {
    const f = fixture();
    const guard = () => kind === 'scalar' ? false : kind === 'promise' ? Promise.reject(new Error('deferred failure')) : { then: (resolve: (value: boolean) => void) => resolve(true) };
    expect(() => initUniverseWithIntegrationOrigin(f.request.downstream, f.origin, guard, { root: f.root })).toThrow(/synchronously/);
    await Promise.resolve();
    expect(existsSync(join(f.directory, 'ledger'))).toBe(false);
  });

  it.each(['artifactDigest', 'commit', 'repo'] as const)('rejects persisted origin %s inconsistent with the manifest seed', async (key) => {
    const f = fixture(); await handoffUniverseIntegration(f.request, { root: f.root });
    const file = join(f.directory, 'ledger', 'records', 'manifest.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.integrationOrigin[key] = key === 'repo' ? `${f.repo}/other` : key === 'commit' ? '0'.repeat(40) : '0'.repeat(64);
    chmodSync(file, 0o600); writeFileSync(file, `${canonical(stored)}\n`);
    expect(() => manifestRecord(f.directory)).toThrow(/evidence unavailable/);
  });

  it('refuses replay when the frozen seed is modified after registration', async () => {
    const f = fixture(); await handoffUniverseIntegration(f.request, { root: f.root });
    const file = join(f.directory, 'seed', 'value.txt'); chmodSync(file, 0o600); writeFileSync(file, 'tampered\n');
    await expect(handoffUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/comparator changed/);
  });
});
