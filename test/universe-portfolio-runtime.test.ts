import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { UniverseCampaignDefinition, UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const hooks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/universe/campaign-store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(), readUniverseCampaign: hooks.read,
}));
vi.mock('../src/core/universe/campaign.js', () => ({ runUniverseCampaign: hooks.run }));
import { runUniversePortfolio } from '../src/core/universe/portfolio.js';

function campaign(id: string): UniverseCampaignSummary {
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id, universeId: `universe-${id}`, feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 1000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } };
  return { definition, definitionDigest: digest(canonical(definition)), manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z', state: 'ready', reason: null, startedAt: null, deadlineAt: null, finishedAt: null,
    steps: [], progress: { attempts: 0, completedRuns: 0, interruptedRuns: 0, reservedModelRequests: 0, reportedTokens: 0,
      recordedTokens: 0, usageComplete: true, admissions: 0, improvements: 0, stagnantGenerations: 0 },
    owner: null, sourceState: 'healthy', reasons: [] };
}
function fixture() {
  const values = new Map(['a', 'b'].map((id) => [id, campaign(id)]));
  hooks.read.mockImplementation((id: string) => structuredClone(values.get(id)!));
  const complete = (id: string) => {
    const result = { ...values.get(id)!, state: 'completed' as const };
    values.set(id, result); return structuredClone(result);
  };
  hooks.run.mockImplementation(async (id: string) => complete(id));
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'runtime', maxParallel: 1, maxDurationMs: 10000,
    tasks: [{ campaignId: 'a', dependsOn: [] }, { campaignId: 'b', dependsOn: [] }] };
  return { values, complete, definition };
}
beforeEach(() => { hooks.read.mockReset(); hooks.run.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('portfolio invocation envelope', () => {
  it('captures a resolved root and detached definition before asynchronous work', async () => {
    const f = fixture(); const options = { root: 'relative-store' }; const originalRoot = resolve(options.root);
    hooks.run.mockImplementation(async (id: string) => {
      options.root = '/a-different-store'; f.definition.tasks.length = 0; f.definition.maxParallel = 8;
      return f.complete(id);
    });
    const result = await runUniversePortfolio(f.definition, options);
    expect(result.status).toBe('completed');
    expect(result.plan.definition.tasks.map((task) => task.campaignId)).toEqual(['a', 'b']);
    expect(result.plan.definition.maxParallel).toBe(1);
    expect(hooks.run.mock.calls.map(([, value]) => value.root)).toEqual([originalRoot, originalRoot]);
    expect(hooks.run.mock.calls.every(([, value]) => !Object.hasOwn(value, 'resourceRuntime'))).toBe(true);
    expect(hooks.read.mock.calls.every(([, value]) => value.root === originalRoot)).toBe(true);
  });

  it.each(['planning', 'dispatch'])('captures a private runtime before %s can mutate caller options', async (phase) => {
    const f = fixture();
    const runtime = '/private/operator/resource-runtime.json';
    const changedRuntime = '/private/another/resource-runtime.json';
    const options = { root: '/unused', resourceRuntime: runtime };
    if (phase === 'planning') {
      hooks.read.mockImplementationOnce((id: string) => {
        options.resourceRuntime = changedRuntime;
        return structuredClone(f.values.get(id)!);
      });
    } else {
      hooks.run.mockImplementation(async (id: string) => {
        options.resourceRuntime = changedRuntime;
        return f.complete(id);
      });
    }
    const result = await runUniversePortfolio(f.definition, options);
    expect(result.status).toBe('completed');
    expect(hooks.run.mock.calls.map(([, value]) => value.resourceRuntime)).toEqual([runtime, runtime]);
    expect(hooks.read.mock.calls.every(([, value]) => canonical(value) === canonical({ root: '/unused' }))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/resourceRuntime|\/private\//);
    expect(options.resourceRuntime).toBe(changedRuntime);
  });

  it('preserves the legacy campaign option shape when the runtime is explicitly undefined', async () => {
    const f = fixture();
    const result = await runUniversePortfolio(f.definition, { root: '/unused', resourceRuntime: undefined });
    expect(result.status).toBe('completed');
    for (const [, options] of hooks.run.mock.calls) {
      expect(Object.keys(options).sort()).toEqual(['expectedIdentity', 'root', 'signal']);
    }
    expect(hooks.read.mock.calls.every(([, value]) => canonical(value) === canonical({ root: '/unused' }))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('resourceRuntime');
  });

  it('does not dispatch any campaign when already cancelled', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    const result = await runUniversePortfolio(f.definition, { signal: controller.signal, root: '/unused',
      resourceRuntime: '/private/operator/resource-runtime.json' });
    expect(result.status).toBe('cancelled');
    expect(result.outcomes.every((value) => value.status === 'cancelled' && !value.attempted)).toBe(true);
    expect(hooks.run).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/resourceRuntime|\/private\//);
  });

  it.each(['stopped', 'failed', 'pause-requested', 'stop-requested'] as const)(
    'does not dispatch %s work or its dependants merely because a runtime was supplied', async (state) => {
      const f = fixture(); f.values.set('a', { ...f.values.get('a')!, state });
      f.definition.tasks[1]!.dependsOn = ['a'];
      const result = await runUniversePortfolio(f.definition, { root: '/unused',
        resourceRuntime: '/private/operator/resource-runtime.json' });
      expect(result.status).toBe('incomplete');
      expect(result.outcomes.every((value) => value.status === 'blocked' && !value.attempted)).toBe(true);
      expect(hooks.run).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/resourceRuntime|\/private\//);
    });

  it('checks the deadline in deferred dispatch even before the timer callback runs', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-09-07T00:00:00Z');
    const f = fixture(); f.definition.maxParallel = 2;
    hooks.run.mockImplementation(async (id: string) => {
      // setSystemTime changes wall time without firing scheduled callbacks.
      vi.setSystemTime('2026-09-07T00:00:11Z');
      return f.complete(id);
    });
    const result = await runUniversePortfolio(f.definition, { root: '/unused' });
    expect(result.status).toBe('timed-out');
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(result.outcomes[1]).toMatchObject({ campaignId: 'b', status: 'cancelled', attempted: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resume an acknowledged pause that occurred while queued', async () => {
    const f = fixture();
    hooks.run.mockImplementation(async (id: string) => {
      f.values.set('b', { ...f.values.get('b')!, state: 'paused', finishedAt: new Date().toISOString() });
      return f.complete(id);
    });
    const result = await runUniversePortfolio(f.definition, { root: '/unused' });
    expect(result.status).toBe('incomplete');
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(result.outcomes[1]).toMatchObject({ status: 'blocked', attempted: false, campaign: { state: 'paused' } });
  });
});
