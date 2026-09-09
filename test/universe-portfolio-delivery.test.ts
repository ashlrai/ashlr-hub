import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { UniverseCampaignDefinition, UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniverseCampaignDeliveryPlan } from '../src/core/universe/campaign-delivery.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const hooks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn(), preflight: vi.fn(), deliver: vi.fn() }));
vi.mock('../src/core/universe/campaign-store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(), readUniverseCampaign: hooks.read,
}));
vi.mock('../src/core/universe/campaign.js', () => ({ runUniverseCampaign: hooks.run }));
vi.mock('../src/core/universe/campaign-delivery.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-delivery.js')>(),
  preflightUniverseCampaignDelivery: hooks.preflight, deliverCompletedUniverseCampaign: hooks.deliver,
}));
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
  const events: string[] = [];
  hooks.read.mockImplementation((id: string) => structuredClone(values.get(id)!));
  hooks.preflight.mockImplementation((id: string) => { events.push(`preflight:${id}`);
    return { campaign: structuredClone(values.get(id)!), repo: `/repo/${id}` }; });
  hooks.run.mockImplementation(async (id: string) => {
    events.push(`run:${id}`); const result = { ...values.get(id)!, state: 'completed' as const };
    values.set(id, result); return structuredClone(result);
  });
  const receipt = { status: 'delivered', branch: 'codex/a', commit: 'c'.repeat(40) };
  hooks.deliver.mockImplementation(async (id: string) => {
    events.push(`deliver:${id}`); return { campaign: structuredClone(values.get(id)!), delivery: { status: 'delivered', receipt } };
  });
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'runtime', maxParallel: 2, maxDurationMs: 10000,
    tasks: [{ campaignId: 'a', dependsOn: [] }, { campaignId: 'b', dependsOn: ['a'] }] };
  const deliveryPlan: UniverseCampaignDeliveryPlan = { schemaVersion: 1,
    deliveries: [{ campaignId: 'a', branch: 'codex/a', baseCommit: 'd'.repeat(40) }] };
  return { values, definition, deliveryPlan, events, receipt };
}
beforeEach(() => { for (const hook of Object.values(hooks)) hook.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('portfolio verified local handoffs', () => {
  it('preflights every target before running and gates dependants on delivery', async () => {
    const f = fixture(); f.deliveryPlan.deliveries.push({ campaignId: 'b', branch: 'codex/b', baseCommit: 'd'.repeat(40) });
    const result = await runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan,
      resourceRuntime: '/private/runtime.json' });
    expect(f.events).toEqual(['preflight:a', 'preflight:b', 'run:a', 'deliver:a', 'run:b', 'deliver:b']);
    expect(result.status).toBe('completed');
    expect(result.outcomes.every((value) => value.attempted && value.delivery?.status === 'delivered')).toBe(true);
    expect(hooks.deliver.mock.calls[0]![1]).toMatchObject({ root: '/unused', deadlineMonotonicMs: expect.any(Number),
      expectedIdentity: { summaryDigest: digest(canonical(f.values.get('a'))) } });
    expect(JSON.stringify(result)).not.toContain('/private/');
    expect(hooks.deliver.mock.calls.every(([, options]) => !Object.hasOwn(options, 'resourceRuntime'))).toBe(true);
  });

  it('reconciles completed campaign delivery without invoking its runner', async () => {
    const f = fixture(); f.values.get('a')!.state = 'completed';
    const result = await runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan });
    expect(f.events).toEqual(['preflight:a', 'deliver:a', 'run:b']);
    expect(result.outcomes[0]).toMatchObject({ status: 'completed', attempted: false, delivery: { status: 'delivered' } });
  });

  it.each(['no-strict-improvement', 'campaign-not-completed'] as const)('holds dependants when handoff is %s', async (reason) => {
    const f = fixture();
    hooks.deliver.mockImplementation(async (id: string) => ({ campaign: f.values.get(id), delivery: { status: 'withheld', reason } }));
    const result = await runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan });
    expect(result.status).toBe('incomplete');
    expect(result.outcomes[0]).toMatchObject({ status: 'blocked', attempted: true, campaign: { state: 'completed' },
      delivery: { status: 'withheld', reason } });
    expect(result.outcomes[1]).toMatchObject({ status: 'blocked', attempted: false });
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('retains completed campaign evidence after delivery failure and holds dependants', async () => {
    const f = fixture(); hooks.deliver.mockRejectedValue(new Error('private repository path'));
    const result = await runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan });
    expect(result.status).toBe('incomplete');
    expect(result.outcomes[0]).toMatchObject({ status: 'failed', campaign: { state: 'completed' }, delivery: { status: 'failed' } });
    expect(result.outcomes[1]).toMatchObject({ status: 'blocked', attempted: false });
    expect(JSON.stringify(result)).not.toContain('private repository path');
  });

  it.each(['invalid', 'base', 'collision', 'changed'] as const)('rejects %s preflight before any runner or delivery', async (mode) => {
    const f = fixture(); f.deliveryPlan.deliveries.push({ campaignId: 'b', branch: 'codex/b', baseCommit: 'd'.repeat(40) });
    if (mode === 'invalid') f.deliveryPlan.deliveries[1]!.baseCommit = 'main';
    if (mode === 'base') hooks.preflight.mockImplementation((id: string) => {
      if (id === 'b') throw new Error('Unpinned base'); return { campaign: f.values.get(id), repo: '/a' };
    });
    if (mode === 'collision') {
      f.deliveryPlan.deliveries[1]!.branch = 'codex/a';
      hooks.preflight.mockImplementation((id: string) => ({ campaign: f.values.get(id), repo: '/same' }));
    }
    if (mode === 'changed') hooks.preflight.mockImplementation((id: string) => ({ campaign: { ...f.values.get(id), reason: 'changed' }, repo: '/a' }));
    await expect(runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan })).rejects.toThrow();
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('snapshots delivery intent before source reads can mutate caller options', async () => {
    const f = fixture(); hooks.read.mockImplementationOnce((id: string) => {
      f.deliveryPlan.deliveries[0]!.branch = 'codex/changed'; return structuredClone(f.values.get(id)!);
    });
    await runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan });
    expect(hooks.preflight.mock.calls[0]![1].delivery.branch).toBe('codex/a');
    expect(hooks.deliver.mock.calls[0]![1].delivery.branch).toBe('codex/a');
  });

  it('does not dispatch or deliver when already cancelled', async () => {
    const f = fixture(); f.values.get('a')!.state = 'completed'; const controller = new AbortController(); controller.abort();
    const result = await runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan, signal: controller.signal });
    expect(result.status).toBe('cancelled'); expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
    expect(hooks.preflight).not.toHaveBeenCalled();
    expect(result.outcomes[0]).toMatchObject({ status: 'cancelled', delivery: { status: 'withheld', reason: 'not-attempted' } });
  });

  it.each(['cancelled', 'timed-out'] as const)('stops preflight between targets when %s', async (mode) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = fixture(); const controller = new AbortController();
    f.deliveryPlan.deliveries.push({ campaignId: 'b', branch: 'codex/b', baseCommit: 'd'.repeat(40) });
    hooks.preflight.mockImplementation((id: string) => {
      if (mode === 'cancelled') controller.abort(); else vi.setSystemTime(Date.now() + 11_000);
      return { campaign: f.values.get(id), repo: `/repo/${id}` };
    });
    const result = await runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan, signal: controller.signal });
    expect(result.status).toBe(mode); expect(hooks.preflight).toHaveBeenCalledOnce();
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it.each(['delivered', 'withheld', 'failed'] as const)('keeps a %s ancestor gate through an already-completed intermediate', async (status) => {
    const f = fixture(); f.values.set('c', campaign('c')); f.values.get('b')!.state = 'completed';
    f.definition.tasks.push({ campaignId: 'c', dependsOn: ['b'] });
    let finish!: () => void;
    hooks.deliver.mockImplementation(async (id: string) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      if (status === 'failed') throw new Error('Delivery failed');
      return { campaign: f.values.get(id), delivery: status === 'delivered' ? { status, receipt: f.receipt } :
        { status, reason: 'no-strict-improvement' } };
    });
    const running = runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan });
    await vi.waitFor(() => expect(hooks.deliver).toHaveBeenCalledOnce());
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a']);
    finish(); const result = await running;
    expect(result.outcomes[1]).toMatchObject({ status: 'completed', attempted: false, campaign: { state: 'completed' } });
    expect(result.outcomes[2]).toMatchObject({ status: status === 'delivered' ? 'completed' : 'blocked', attempted: status === 'delivered' });
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(status === 'delivered' ? ['a', 'c'] : ['a']);
  });

  it.each(['cancelled', 'timed-out'] as const)('drains a %s handoff and preserves its returned durable receipt', async (mode) => {
    vi.useFakeTimers(); const f = fixture(); const controller = new AbortController();
    let finished = false;
    hooks.deliver.mockImplementation(async (id: string, options: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => { finished = true; resolve(); }, { once: true }));
      return { campaign: f.values.get(id), delivery: { status: 'delivered', receipt: f.receipt } };
    });
    const running = runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan, signal: controller.signal });
    await vi.waitFor(() => expect(hooks.deliver).toHaveBeenCalledOnce());
    if (mode === 'cancelled') controller.abort(); else await vi.advanceTimersByTimeAsync(10_000);
    const result = await running;
    expect(finished).toBe(true); expect(result.status).toBe(mode);
    expect(result.outcomes[0]).toMatchObject({ status: 'completed', delivery: { status: 'delivered', receipt: f.receipt } });
    expect(result.outcomes[1]).toMatchObject({ status: 'cancelled', attempted: false });
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('accounts for synchronous final delivery overrun while retaining its receipt', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); const f = fixture(); f.definition.tasks.length = 1;
    hooks.deliver.mockImplementation(async (id: string) => {
      vi.setSystemTime(Date.now() + 11_000);
      return { campaign: f.values.get(id), delivery: { status: 'delivered', receipt: f.receipt } };
    });
    const result = await runUniversePortfolio(f.definition, { root: '/unused', deliveryPlan: f.deliveryPlan });
    expect(result.status).toBe('timed-out');
    expect(result.outcomes[0]).toMatchObject({ status: 'completed', delivery: { status: 'delivered' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the no-plan ordering-only result and avoids all delivery reads', async () => {
    const f = fixture(); const result = await runUniversePortfolio(f.definition, { root: '/unused' });
    expect(result.status).toBe('completed'); expect(result.outcomes.every((value) => !Object.hasOwn(value, 'delivery'))).toBe(true);
    expect(hooks.preflight).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });
});
