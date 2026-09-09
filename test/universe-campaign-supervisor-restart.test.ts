import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { campaignDirectory, initUniverseCampaign, readCampaignEvents, readUniverseCampaign } from '../src/core/universe/campaign-store.js';
import { superviseUniverseCampaigns } from '../src/core/universe/campaign-supervisor.js';
import type { UniverseRun, UniverseSummary } from '../src/core/universe/types.js';

const hooks = vi.hoisted(() => ({ universes: new Map<string, UniverseSummary>(), run: vi.fn() }));
vi.mock('../src/core/universe/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/universe/store.js')>();
  return { ...actual, projectUniverse: (directory: string) => {
    const universe = hooks.universes.get(basename(directory));
    if (!universe) throw new Error('Unknown fixture Universe');
    return structuredClone(universe);
  } };
});
vi.mock('../src/core/universe/runner.js', () => ({ runUniverseOwned: hooks.run }));

const roots: string[] = [];
afterEach(() => {
  hooks.universes.clear(); hooks.run.mockReset(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function enroll(root: string, id: string): void {
  mkdirSync(join(root, 'universes', id), { recursive: true, mode: 0o700 });
  hooks.universes.set(id, {
    manifest: { schemaVersion: 1, id, name: 'Restart fixture', objective: 'Preserve completed and interrupted work across foreground invocations',
      seed: { repo: '/unused/fixture', revision: 'a'.repeat(40) },
      metric: { name: 'checks', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 1_000 },
      evaluation: { command: ['node', 'unused-evaluator.mjs'], timeoutMs: 1_000 },
      variants: [{ id: 'change', niche: 'correctness', hypothesis: 'Exercise campaign lifecycle', command: ['node', 'unused-worker.mjs'] }] },
    manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64),
    runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [],
  });
  initUniverseCampaign({ schemaVersion: 1, id, universeId: id, feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 0,
      maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
}

// Real campaign ledgers, readiness, admission and leases; candidate execution and
// its Universe projection are fixtures. This is not an OS reboot/provider test.
describe('foreground supervisor reinvocation after interrupted work', () => {
  it('retains prior results and budgets while dispatching only newly enrolled ready work', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-supervisor-restart-'))); roots.push(root);
    enroll(root, 'finished'); enroll(root, 'interrupted');
    const controller = new AbortController();
    const contact = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider contact'));
    hooks.run.mockImplementation(async (id: string, options: { runId: string; campaign: UniverseRun['campaign']; signal: AbortSignal }) => {
      const universe = hooks.universes.get(id)!;
      // Cancellation occurs only after the campaign has durably reserved its
      // step. The real campaign runner must settle it before supervision returns.
      if (id === 'interrupted') controller.abort();
      const interrupted = options.signal.aborted;
      const run: UniverseRun = { id: options.runId, universeId: id, generation: universe.runs.length + 1,
        manifestDigest: universe.manifestDigest, comparatorDigest: universe.comparatorDigest,
        campaign: options.campaign, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        status: interrupted ? 'interrupted' : 'completed', durationMs: 1, tokensUsed: null, costUsd: null,
        trials: interrupted ? [] : [{ id: `trial-${id}`, variantId: 'change', niche: 'correctness', parentTrialId: null,
          status: 'failed', score: null, metrics: {}, artifact: null, durationMs: 1, delta: null, selected: false }] };
      universe.runs.push(run);
      return run;
    });
    const options = { root, maxDurationMs: 5_000, pollIntervalMs: 50 };
    const first = await superviseUniverseCampaigns(['finished', 'interrupted'], { ...options, signal: controller.signal });
    expect(first.status).toBe('cancelled');
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['finished', 'interrupted']);
    const finished = readUniverseCampaign('finished', { root });
    const interrupted = readUniverseCampaign('interrupted', { root });
    expect(finished).toMatchObject({ state: 'completed', sourceState: 'healthy', progress: { attempts: 1, completedRuns: 1 } });
    expect(interrupted).toMatchObject({ state: 'paused', sourceState: 'healthy', owner: null,
      progress: { attempts: 1, interruptedRuns: 1 } });
    expect(interrupted.deadlineAt).not.toBeNull();
    const recorded = ['finished', 'interrupted'].map((id) => readCampaignEvents(campaignDirectory(id, { root })));

    enroll(root, 'new-work'); hooks.run.mockClear();
    const second = await superviseUniverseCampaigns(['finished', 'interrupted', 'new-work'], options);
    expect(second.status).toBe('incomplete');
    expect(second.outcomes).toMatchObject([
      { campaignId: 'finished', status: 'completed', attempted: false },
      { campaignId: 'interrupted', status: 'held', attempted: false, reasonCode: 'run-incomplete' },
      { campaignId: 'new-work', status: 'completed', attempted: true },
    ]);
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['new-work']);
    expect(readUniverseCampaign('finished', { root })).toEqual(finished);
    expect(readUniverseCampaign('interrupted', { root })).toEqual(interrupted);
    expect(['finished', 'interrupted'].map((id) => readCampaignEvents(campaignDirectory(id, { root })))).toEqual(recorded);
    expect(contact).not.toHaveBeenCalled();
  });
});
