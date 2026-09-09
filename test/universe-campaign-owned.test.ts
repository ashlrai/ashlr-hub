import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownsLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireUniverseExecution, withUniverseExecution } from '../src/core/universe/execution.js';
import { campaignDirectory, initUniverseCampaign, readCampaignEvents, readUniverseCampaign } from '../src/core/universe/campaign-store.js';
import { runUniverseCampaign, runUniverseCampaignOwned } from '../src/core/universe/campaign.js';
import type { UniverseRun, UniverseSummary } from '../src/core/universe/types.js';

const hooks = vi.hoisted(() => ({ universe: undefined as UniverseSummary | undefined, run: vi.fn() }));
vi.mock('../src/core/universe/store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/store.js')>(),
  projectUniverse: () => structuredClone(hooks.universe!),
}));
vi.mock('../src/core/universe/runner.js', () => ({ runUniverseOwned: hooks.run }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); hooks.run.mockReset(); hooks.universe = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-campaign-owned-'))); roots.push(root);
  mkdirSync(join(root, 'universes', 'fixture'), { recursive: true, mode: 0o700 });
  hooks.universe = { manifest: { schemaVersion: 1, id: 'fixture', name: 'Owned campaign fixture', objective: 'Test retained ownership',
    seed: { repo: '/unused/fixture', revision: 'a'.repeat(40) }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 10_000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'change', niche: 'value', hypothesis: 'Test fixture output', command: ['node', 'worker.mjs'] }] },
  manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), runs: [], elites: [], activeRun: null,
  sourceState: 'healthy', reasons: [] };
  const initial = initUniverseCampaign({ schemaVersion: 1, id: 'campaign', universeId: 'fixture', feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
  hooks.run.mockImplementation(async (_id: string, options: { runId: string; campaign: UniverseRun['campaign'] }) => {
    const run: UniverseRun = { id: options.runId, universeId: 'fixture', generation: 1,
      manifestDigest: initial.manifestDigest, comparatorDigest: initial.comparatorDigest,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'completed', campaign: options.campaign,
      trials: [{ id: 'trial', variantId: 'change', niche: 'value', parentTrialId: null, status: 'failed', score: null,
        metrics: {}, artifact: null, durationMs: 1, delta: null, selected: false }], durationMs: 1, tokensUsed: null, costUsd: null };
    hooks.universe!.runs.push(run); return run;
  });
  const directory = campaignDirectory('campaign', { root });
  return { root, initial, directory, events: () => readCampaignEvents(directory),
    expectedIdentity: { universeId: 'fixture', definitionDigest: initial.definitionDigest, manifestDigest: initial.manifestDigest,
      comparatorDigest: initial.comparatorDigest, summaryDigest: digest(canonical(initial)), recordsDigest: digest(canonical(readCampaignEvents(directory))) } };
}

// Private ledger and ownership are real. The Universe projection and generation
// are synthetic so this seam never executes evaluators, providers, or native agents.
describe('campaign execution with an already acquired experiment lease', () => {
  it('returns typed live contention without touching campaign history', async () => {
    const f = fixture(); const before = f.events();
    const acquired = acquireUniverseExecution('fixture', f);
    expect(acquired.state).toBe('acquired');
    if (acquired.state !== 'acquired') throw new Error('Fixture lease unavailable');
    try {
      expect(acquireUniverseExecution('fixture', f).state).toBe('contended');
      await expect(runUniverseCampaign('campaign', f)).rejects.toThrow('Universe already has an active execution owner');
      expect(f.events()).toEqual(before); expect(hooks.run).not.toHaveBeenCalled();
    } finally { releaseLocalStoreLock(acquired.lock); }
    await expect(withUniverseExecution('fixture', f, async () => true)).resolves.toBe(true);
  });

  it('uses the exact caller lease for generation and leaves release to that caller', async () => {
    const f = fixture(); const acquired = acquireUniverseExecution('fixture', f);
    if (acquired.state !== 'acquired') throw new Error('Fixture lease unavailable');
    try {
      const dispatchId = '11111111-1111-4111-8111-111111111111';
      expect((await runUniverseCampaignOwned('campaign', { ...f, dispatchId }, acquired.lock)).state).toBe('completed');
      expect(hooks.run).toHaveBeenCalledOnce(); expect(hooks.run.mock.calls[0]![2]).toBe(acquired.lock);
      expect(ownsLocalStoreLock(acquired.lock)).toBe(true);
      expect(f.events().filter((row) => row.kind === 'started' || row.kind === 'settled'))
        .toEqual([expect.objectContaining({ kind: 'started', dispatchId }), expect.objectContaining({ kind: 'settled', dispatchId })]);
      const before = f.events();
      // Public terminal no-op keeps its established behavior without acquiring.
      expect((await runUniverseCampaign('campaign', { root: f.root })).state).toBe('completed');
      expect(f.events()).toEqual(before);
    } finally { releaseLocalStoreLock(acquired.lock); }
    expect(ownsLocalStoreLock(acquired.lock)).toBe(false);
  });

  it.each(['other-universe', 'other-root', 'released'] as const)('rejects %s ownership before any campaign mutation', async (mode) => {
    const f = fixture(); const before = f.events();
    let root = f.root; let universeId = 'fixture';
    if (mode === 'other-universe') {
      universeId = 'other'; mkdirSync(join(root, 'universes', universeId), { mode: 0o700 });
    } else if (mode === 'other-root') {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-other-owner-'))); roots.push(root);
      mkdirSync(join(root, 'universes', universeId), { recursive: true, mode: 0o700 });
    }
    const acquired = acquireUniverseExecution(universeId, { root });
    if (acquired.state !== 'acquired') throw new Error('Fixture lease unavailable');
    try {
      if (mode === 'released') releaseLocalStoreLock(acquired.lock);
      await expect(runUniverseCampaignOwned('campaign', f, acquired.lock)).rejects.toThrow('Universe execution ownership lost');
      expect(f.events()).toEqual(before); expect(hooks.run).not.toHaveBeenCalled();
    } finally { releaseLocalStoreLock(acquired.lock); }
  });

  it('rejects a stale lease even for a terminal campaign', async () => {
    const f = fixture(); await runUniverseCampaign('campaign', f);
    const acquired = acquireUniverseExecution('fixture', f);
    if (acquired.state !== 'acquired') throw new Error('Fixture lease unavailable');
    releaseLocalStoreLock(acquired.lock);
    const before = f.events();
    await expect(runUniverseCampaignOwned('campaign', { root: f.root }, acquired.lock)).rejects.toThrow('Universe execution ownership lost');
    expect(f.events()).toEqual(before); expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('retains exact enrollment and malformed dispatch checks for owned callers', async () => {
    const f = fixture(); const before = f.events();
    const acquired = acquireUniverseExecution('fixture', f);
    if (acquired.state !== 'acquired') throw new Error('Fixture lease unavailable');
    try {
      await expect(runUniverseCampaignOwned('campaign', { ...f, dispatchId: 'invalid' }, acquired.lock))
        .rejects.toThrow('Invalid campaign dispatch identity');
      await expect(runUniverseCampaignOwned('campaign', { ...f, expectedIdentity: { ...f.expectedIdentity, recordsDigest: 'f'.repeat(64) } }, acquired.lock))
        .rejects.toThrow('Campaign evidence changed after portfolio admission');
      expect(readUniverseCampaign('campaign', f)).toEqual(f.initial);
      expect(f.events()).toEqual(before); expect(hooks.run).not.toHaveBeenCalled();
      expect(ownsLocalStoreLock(acquired.lock)).toBe(true);
    } finally { releaseLocalStoreLock(acquired.lock); }
  });
});
