import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateUniverseCampaignDeliveryPlan } from '../src/core/universe/campaign-delivery.js';
import { superviseUniverseCampaigns } from '../src/core/universe/campaign-supervisor.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';

const hooks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn(), preflight: vi.fn(), deliver: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.read }));
vi.mock('../src/core/universe/campaign.js', () => ({ runUniverseCampaign: hooks.run }));
vi.mock('../src/core/universe/campaign-delivery.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-delivery.js')>(),
  preflightUniverseCampaignDelivery: hooks.preflight, deliverCompletedUniverseCampaign: hooks.deliver,
}));
const row = (campaignId = 'first') => ({ campaignId, branch: `codex/${campaignId}`, baseCommit: 'a'.repeat(40) });
const plan = (ids = ['first']) => ({ schemaVersion: 1 as const, deliveries: ids.map((id) => row(id)) });
const options = () => ({ root: '/private/fixture', maxDurationMs: 5_000, pollIntervalMs: 50 });

function fixture(ids = ['first']) {
  const summaries = new Map(ids.map((id) => [id, { definition: { id, universeId: `universe-${id}` },
    definitionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), state: 'ready', sourceState: 'healthy',
  } as UniverseCampaignSummary]));
  const reports = new Map<string, UniverseCampaignReadiness>(ids.map((id) => [id, {
    schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: id, universeId: `universe-${id}`,
    observedState: 'ready', sourceState: 'healthy', disposition: 'startable', reasonCode: 'never-started', automaticAction: 'run',
    resourceRuntimeRequired: false, expectedIdentity: { universeId: `universe-${id}`, definitionDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), summaryDigest: digest(canonical(summaries.get(id))) },
    recordsDigest: 'e'.repeat(64), sampledAt: new Date().toISOString(),
  }]));
  const finish = (id: string, state: 'completed' | 'paused' = 'completed') => {
    const summary = { ...summaries.get(id)!, state }; summaries.set(id, summary);
    const current = reports.get(id)!;
    reports.set(id, { ...current, observedState: state, disposition: state === 'completed' ? 'terminal' : 'owner-held',
      automaticAction: 'none', reasonCode: state === 'completed' ? 'campaign-completed' : 'owner-paused',
      recordsDigest: 'f'.repeat(64), expectedIdentity: { ...current.expectedIdentity!, summaryDigest: digest(canonical(summary)) } });
    return summary;
  };
  hooks.read.mockImplementation((id: string) => structuredClone(reports.get(id)));
  hooks.preflight.mockImplementation((id: string) => ({ campaign: structuredClone(summaries.get(id)), repo: `/private/repo-${id}` }));
  hooks.run.mockImplementation(async (id: string) => finish(id));
  hooks.deliver.mockImplementation(async (id: string) => ({ campaign: summaries.get(id), delivery: {
    status: 'delivered', receipt: { branch: `codex/${id}`, commit: 'd'.repeat(40) },
  } }));
  return { summaries, reports, finish };
}
beforeEach(() => { for (const hook of Object.values(hooks)) hook.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('closed supervisor delivery plan', () => {
  it.each([null, {}, [], { ...plan(), schemaVersion: 2 }, { ...plan(), extra: true }, { schemaVersion: 1, deliveries: [] },
    { schemaVersion: 1, deliveries: Array(1) }, plan(['unknown']), plan(['first', 'first']),
    { schemaVersion: 1, deliveries: [{ ...row(), branch: 'main' }] },
    { schemaVersion: 1, deliveries: [{ ...row(), baseCommit: 'HEAD' }] },
    { schemaVersion: 1, deliveries: [{ ...row(), ignored: true }] },
  ])('rejects malformed plans before source observation %#', async (deliveryPlan) => {
    await expect(superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan } as never)).rejects.toThrow();
    for (const hook of Object.values(hooks)) expect(hook).not.toHaveBeenCalled();
  });

  it('does not invoke accessors and detaches mutable rows', () => {
    const getter = vi.fn(() => 'first');
    const original = plan();
    const copy = validateUniverseCampaignDeliveryPlan(original, ['first']);
    original.deliveries[0]!.branch = 'codex/changed';
    expect(copy.deliveries[0]!.branch).toBe('codex/first');
    Object.defineProperty(original.deliveries[0], 'campaignId', { get: getter });
    expect(() => validateUniverseCampaignDeliveryPlan(original, ['first'])).toThrow();
    const items = plan(); Object.defineProperty(items.deliveries, '0', { get: getter });
    expect(() => validateUniverseCampaignDeliveryPlan(items, ['first'])).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('supervised terminal delivery handoff', () => {
  it('performs no delivery preflight for a pre-cancelled invocation', async () => {
    fixture();
    const result = await superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan: plan(), signal: AbortSignal.abort() });
    expect(result).toMatchObject({ status: 'cancelled', outcomes: [{ attempted: false, delivery: { reason: 'cancelled' } }] });
    for (const hook of Object.values(hooks)) expect(hook).not.toHaveBeenCalled();
  });

  it('counts synchronous preflight time and stops before inspecting or dispatching the next target', async () => {
    const f = fixture(['first', 'second']); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    hooks.preflight.mockImplementationOnce(() => { now = 5_001; return { campaign: f.summaries.get('first'), repo: '/repo' }; });
    const result = await superviseUniverseCampaigns(['first', 'second'], { ...options(), deliveryPlan: plan(['first', 'second']) });
    expect(result.status).toBe('timed-out');
    expect(hooks.preflight).toHaveBeenCalledOnce(); expect(hooks.read).not.toHaveBeenCalled();
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('processes a queued cancellation between preflight targets before any dispatch', async () => {
    const f = fixture(['first', 'second']); const controller = new AbortController();
    hooks.preflight.mockImplementationOnce(() => {
      setImmediate(() => controller.abort()); return { campaign: f.summaries.get('first'), repo: '/repo' };
    });
    const result = await superviseUniverseCampaigns(['first', 'second'], { ...options(), deliveryPlan: plan(['first', 'second']), signal: controller.signal });
    expect(result.status).toBe('cancelled'); expect(hooks.preflight).toHaveBeenCalledOnce();
    expect(hooks.read).not.toHaveBeenCalled(); expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('preflights all targets, preserves runner CAS, and delivers only after verified completion', async () => {
    fixture(['first', 'second']);
    const result = await superviseUniverseCampaigns(['first', 'second'], { ...options(), deliveryPlan: plan(['first', 'second']) });
    expect(result.status).toBe('completed');
    expect(hooks.preflight.mock.invocationCallOrder[1]).toBeLessThan(hooks.run.mock.invocationCallOrder[0]!);
    expect(hooks.run.mock.calls[0]![1].expectedIdentity.recordsDigest).toBe('e'.repeat(64));
    expect(hooks.deliver.mock.calls[0]![1]).toMatchObject({ delivery: row(), expectedIdentity: { recordsDigest: 'f'.repeat(64) } });
    expect(hooks.deliver.mock.calls[0]![1]).not.toHaveProperty('resourceRuntime');
    expect(result.outcomes.every((outcome) => outcome.attempted && outcome.delivery?.status === 'delivered')).toBe(true);
  });

  it('reconciles completed campaigns without runner or resource runtime and preserves attempted=false', async () => {
    const f = fixture(); f.finish('first'); f.reports.get('first')!.resourceRuntimeRequired = true;
    const result = await superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan: plan() });
    expect(result).toMatchObject({ status: 'completed', outcomes: [{ attempted: false, observedState: 'completed', delivery: { status: 'delivered' } }] });
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).toHaveBeenCalledOnce();
  });

  it('rejects a later invalid base before dispatch or observer callbacks', async () => {
    const f = fixture(['first', 'second']); hooks.preflight.mockImplementationOnce(() => ({ campaign: f.summaries.get('first'), repo: '/repo' }));
    hooks.preflight.mockImplementationOnce(() => { throw new Error('Wrong pinned base'); });
    const onTransition = vi.fn();
    await expect(superviseUniverseCampaigns(['first', 'second'], { ...options(), deliveryPlan: plan(['first', 'second']), onTransition })).rejects.toThrow('Wrong pinned base');
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled(); expect(onTransition).not.toHaveBeenCalled();
  });

  it('rejects duplicate repository/branch destinations', async () => {
    const f = fixture(['first', 'second']); hooks.preflight.mockImplementation((id: string) => ({ campaign: f.summaries.get(id), repo: '/same-repo' }));
    await expect(superviseUniverseCampaigns(['first', 'second'], { ...options(), deliveryPlan: { schemaVersion: 1,
      deliveries: [row(), { ...row('second'), branch: row().branch }] } })).rejects.toThrow(/repeats/);
    expect(hooks.run).not.toHaveBeenCalled();
  });

  it('keeps the Universe slot occupied through delivery before launching another campaign', async () => {
    const f = fixture(['first', 'second']);
    f.summaries.get('second')!.definition.universeId = 'universe-first';
    f.reports.get('second')!.universeId = 'universe-first'; f.reports.get('second')!.expectedIdentity!.universeId = 'universe-first';
    const order: string[] = [];
    hooks.run.mockImplementation(async (id: string) => { order.push(`run:${id}`); return f.finish(id); });
    hooks.deliver.mockImplementation(async (id: string) => {
      order.push(`delivery:${id}`); await new Promise((resolve) => setTimeout(resolve, 10));
      expect(hooks.run).toHaveBeenCalledTimes(id === 'first' ? 1 : 2);
      return { campaign: f.summaries.get(id), delivery: { status: 'withheld', reason: 'no-strict-improvement' } };
    });
    await superviseUniverseCampaigns(['first', 'second'], { ...options(), maxConcurrent: 2, deliveryPlan: plan(['first', 'second']) });
    expect(order).toEqual(['run:first', 'delivery:first', 'run:second', 'delivery:second']);
  });

  it('leaves an owner-held campaign untouched and distinguishes no-improvement from delivery', async () => {
    const f = fixture(['first', 'second']); f.finish('first', 'paused');
    hooks.deliver.mockResolvedValue({ campaign: {}, delivery: { status: 'withheld', reason: 'no-strict-improvement' } });
    const result = await superviseUniverseCampaigns(['first', 'second'], { ...options(), deliveryPlan: plan(['first', 'second']) });
    expect(result.status).toBe('incomplete');
    expect(result.outcomes).toMatchObject([
      { status: 'held', attempted: false, delivery: { status: 'withheld', reason: 'campaign-not-completed' } },
      { status: 'completed', attempted: true, delivery: { status: 'withheld', reason: 'no-strict-improvement' } },
    ]);
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['second']);
  });

  it('retains completed campaign state on delivery failure and retries only the handoff', async () => {
    fixture(); hooks.deliver.mockRejectedValueOnce(new Error('Private branch drift /secret/path'));
    const first = await superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan: plan() });
    expect(first).toMatchObject({ status: 'incomplete', outcomes: [{ status: 'failed', observedState: 'completed', delivery: { status: 'failed' } }] });
    expect(JSON.stringify(first)).not.toContain('/secret/path');
    const second = await superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan: plan() });
    expect(second.outcomes[0]).toMatchObject({ status: 'completed', attempted: false, delivery: { status: 'delivered' } });
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('prevents delivery when cancellation arrives at the handoff transition', async () => {
    fixture(); const controller = new AbortController();
    const result = await superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan: plan(), signal: controller.signal,
      onTransition: (event) => { if (event.status === 'delivering') controller.abort(); } });
    expect(result).toMatchObject({ status: 'cancelled', outcomes: [{ status: 'cancelled', observedState: 'completed', delivery: { status: 'withheld', reason: 'cancelled' } }] });
    expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('reports completed but changed delivery evidence as not-attempted rather than an incomplete campaign', async () => {
    const f = fixture(); f.finish('first');
    const result = await superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan: plan(),
      onTransition: (event) => { if (event.status === 'queued') f.reports.get('first')!.recordsDigest = '0'.repeat(64); } });
    expect(result.outcomes[0]).toMatchObject({ observedState: 'completed', status: 'held', reasonCode: 'evidence-changed',
      delivery: { status: 'withheld', reason: 'not-attempted' } });
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('observes synchronous delivery overruns and preserves an already-settled receipt without dispatching later work', async () => {
    const f = fixture(['first', 'second']); f.finish('first'); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    hooks.deliver.mockImplementation(async (_id, config) => {
      expect(config.deadlineMonotonicMs).toBe(5_000); now = 5_001;
      return { campaign: f.summaries.get('first'), delivery: { status: 'delivered', receipt: { commit: 'd'.repeat(40) } } };
    });
    const result = await superviseUniverseCampaigns(['first', 'second'], { ...options(), deliveryPlan: plan(['first', 'second']) });
    expect(result).toMatchObject({ status: 'timed-out', outcomes: [
      { attempted: false, delivery: { status: 'delivered' } },
      { attempted: false, status: 'cancelled', reasonCode: 'invocation-duration-exhausted' },
    ] });
    expect(hooks.run).not.toHaveBeenCalled();
  });

  it('retains the final delivered receipt when its completion observer exhausts the invocation', async () => {
    const f = fixture(); f.finish('first'); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const result = await superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan: plan(),
      onTransition(event) { if (event.reasonCode === 'delivery-completed') now = 5_001; } });
    expect(result).toMatchObject({ status: 'timed-out', outcomes: [{ campaignId: 'first', attempted: false,
      status: 'completed', reasonCode: 'delivery-completed', delivery: { status: 'delivered',
        receipt: { branch: 'codex/first', commit: 'd'.repeat(40) } } }] });
    expect(hooks.run).not.toHaveBeenCalled();
    expect(hooks.deliver).toHaveBeenCalledOnce();
  });

  it('awaits owned delivery cancellation cleanup before returning', async () => {
    const f = fixture(); f.finish('first'); const controller = new AbortController(); let cleaned = false;
    hooks.deliver.mockImplementation(async (_id, config) => {
      const aborted = new Promise<void>((resolve) => config.signal.addEventListener('abort', () => resolve(), { once: true }));
      controller.abort(); await aborted; await Promise.resolve(); cleaned = true;
      throw new Error('cancelled');
    });
    const result = await superviseUniverseCampaigns(['first'], { ...options(), deliveryPlan: plan(), signal: controller.signal });
    expect(result.status).toBe('cancelled'); expect(cleaned).toBe(true);
    expect(result.outcomes[0]!.delivery).toEqual({ status: 'withheld', reason: 'cancelled' });
  });
});
