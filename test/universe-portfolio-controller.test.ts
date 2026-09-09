import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import { readPortfolioControllerEvents, portfolioControllerDirectory } from '../src/core/universe/portfolio-controller-store.js';
import * as records from '../src/core/util/immutable-private-record-store.js';

const hooks = vi.hoisted(() => ({ readiness: vi.fn(), run: vi.fn(), campaign: vi.fn(), plan: vi.fn(),
  preflight: vi.fn(), deliver: vi.fn(), deliveries: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.readiness }));
vi.mock('../src/core/universe/campaign.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign.js')>(), runUniverseCampaign: hooks.run,
}));
vi.mock('../src/core/universe/campaign-store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(), readUniverseCampaign: hooks.campaign,
}));
vi.mock('../src/core/universe/portfolio-plan.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/portfolio-plan.js')>(), readUniversePortfolioPlan: hooks.plan,
}));
vi.mock('../src/core/universe/campaign-delivery.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-delivery.js')>(),
  preflightUniverseCampaignDelivery: hooks.preflight, deliverCompletedUniverseCampaign: hooks.deliver,
}));
vi.mock('../src/core/universe/delivery.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/delivery.js')>(), readUniverseDeliveries: hooks.deliveries,
}));
import { readUniversePortfolioController, runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';

const scratch: string[] = [];
const HASH = 'a'.repeat(64);
const INITIAL_RECORDS = 'b'.repeat(64);
const FINAL_RECORDS = 'c'.repeat(64);
beforeEach(() => { for (const hook of Object.values(hooks)) hook.mockReset(); });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) writable(join(path, child));
  };
  for (const path of scratch.splice(0)) { writable(path); rmSync(path, { recursive: true, force: true }); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

// Campaign projections and execution below are deliberately synthetic. The
// controller's immutable record store and execution lock remain real private IO.
function fixture(ids = ['a'], maxParallel = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-controller-fault-')));
  scratch.push(root);
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'fault-controller',
    tasks: ids.map((campaignId) => ({ campaignId, dependsOn: [] })), maxParallel, maxDurationMs: 10_000 };
  const summaries = new Map(ids.map((id) => [id, { fixtureId: id, state: 'ready' } as unknown as UniverseCampaignSummary]));
  const readiness = new Map(ids.map((id): [string, UniverseCampaignReadiness] => [id, {
    schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: id, universeId: `universe-${id}`,
    sourceState: 'healthy', observedState: 'ready', disposition: 'startable', reasonCode: 'never-started', automaticAction: 'run',
    resourceRuntimeRequired: false, recordsDigest: INITIAL_RECORDS, sampledAt: new Date().toISOString(),
    expectedIdentity: { universeId: `universe-${id}`, definitionDigest: HASH, manifestDigest: HASH,
      comparatorDigest: HASH, summaryDigest: digest(canonical(summaries.get(id)!)) },
  }]));
  hooks.readiness.mockImplementation((id: string) => structuredClone(readiness.get(id)!));
  hooks.campaign.mockImplementation((id: string) => structuredClone(summaries.get(id)!));
  hooks.plan.mockImplementation(() => ({ schemaVersion: 1, sourceState: 'healthy', definition,
    definitionDigest: digest(canonical(definition)), topologicalOrder: ids,
    nodes: ids.map((id) => ({ campaignId: id, campaign: structuredClone(summaries.get(id)!) })) }));
  hooks.preflight.mockImplementation((id: string) => ({ repo: '/synthetic/repository', campaign: structuredClone(summaries.get(id)!) }));
  hooks.deliveries.mockReturnValue({ sourceState: 'healthy', deliveries: [] });
  const finish = (id: string, state: 'completed' | 'paused' = 'completed') => {
    const summary = { fixtureId: id, state } as unknown as UniverseCampaignSummary;
    summaries.set(id, summary);
    const before = readiness.get(id)!;
    readiness.set(id, { ...before, observedState: state, disposition: state === 'completed' ? 'terminal' : 'owner-held',
      reasonCode: state === 'completed' ? 'campaign-completed' : 'owner-paused', automaticAction: 'none', recordsDigest: FINAL_RECORDS,
      expectedIdentity: { ...before.expectedIdentity!, summaryDigest: digest(canonical(summary)) } });
    return structuredClone(summary);
  };
  hooks.run.mockImplementation(async (id: string) => finish(id));
  const options = { root };
  const events = () => readPortfolioControllerEvents(portfolioControllerDirectory(definition.id, options));
  return { root, definition, options, readiness, summaries, finish, events };
}

describe('Portfolio controller private-ledger fault acceptance', () => {
  it('persists the exact intent before execution and passes raw-history CAS pins', async () => {
    const f = fixture();
    hooks.run.mockImplementation(async (id: string, options) => {
      expect(f.events().at(-1)).toMatchObject({ kind: 'intent', campaignId: id });
      expect(options.expectedIdentity).toEqual({ ...f.readiness.get(id)!.expectedIdentity!, recordsDigest: INITIAL_RECORDS });
      expect(options.resourceRuntime).toBe('/private/synthetic-runtime.json');
      return f.finish(id);
    });
    const result = await runUniversePortfolioController(f.definition, { ...f.options, resourceRuntime: '/private/synthetic-runtime.json' });
    expect(result.status).toBe('completed');
    expect(f.events().at(-1)).toMatchObject({ kind: 'settled', recordsDigest: FINAL_RECORDS });
    expect(JSON.stringify(f.events())).not.toContain('synthetic-runtime');
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('keeps thrown runner work unresolved even if external readiness later says completed', async () => {
    const f = fixture();
    hooks.run.mockRejectedValue(new Error('synthetic failure after possible work'));
    const first = await runUniversePortfolioController(f.definition, f.options);
    expect(first.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
    f.finish('a');
    const second = await runUniversePortfolioController(f.definition, f.options);
    expect(second.status).not.toBe('completed');
    expect(second.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
    expect(hooks.run).toHaveBeenCalledOnce();
    expect(f.events().filter((event) => event.kind === 'settled')).toHaveLength(0);
  });

  it('does not accept a successful return that has no matching recorded campaign outcome', async () => {
    const f = fixture();
    hooks.run.mockResolvedValue({ fixtureId: 'a', state: 'completed' });
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.status).toBe('incomplete');
    expect(result.outcomes[0]?.state).toBe('in-flight');
    expect(f.events().filter((event) => event.kind === 'settled')).toHaveLength(0);
  });

  it('retains an unknown attempt slot instead of dispatching queued siblings on restart', async () => {
    const f = fixture(['a', 'b'], 1);
    hooks.run.mockRejectedValue(new Error('synthetic unsettled call'));
    await runUniversePortfolioController(f.definition, f.options);
    await runUniversePortfolioController(f.definition, f.options);
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(readUniversePortfolioController(f.definition.id, f.options).outcomes.map((item) => item.state)).toEqual(['in-flight', 'pending']);
  });

  it('withholds a required runtime without discovering or persisting a locator', async () => {
    const f = fixture(); f.readiness.get('a')!.resourceRuntimeRequired = true;
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.status).toBe('incomplete');
    expect(result.reasons).toContain('a:resource-runtime-required');
    expect(hooks.run).not.toHaveBeenCalled();
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false);
    expect(JSON.stringify(f.events())).not.toContain('resourceRuntime');
  });

  it('rejects a changed or omitted frozen delivery plan before any effect', async () => {
    const f = fixture(); f.readiness.get('a')!.resourceRuntimeRequired = true;
    const deliveryPlan = { schemaVersion: 1 as const, deliveries: [{ campaignId: 'a', branch: 'codex/first', baseCommit: 'a'.repeat(40) }] };
    await runUniversePortfolioController(f.definition, { ...f.options, deliveryPlan });
    const before = f.events();
    await expect(runUniversePortfolioController(f.definition, f.options)).rejects.toThrow();
    await expect(runUniversePortfolioController(f.definition, { ...f.options,
      deliveryPlan: { ...deliveryPlan, deliveries: [{ ...deliveryPlan.deliveries[0]!, branch: 'codex/changed' }] } })).rejects.toThrow();
    expect(f.events()).toEqual(before);
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('rejects a competing owner and releases the real execution lock after settlement', async () => {
    const f = fixture(); const started = deferred<void>(); const release = deferred<UniverseCampaignSummary>();
    hooks.run.mockImplementation(() => { started.resolve(); return release.promise; });
    const first = runUniversePortfolioController(f.definition, f.options);
    await started.promise;
    try {
      const second = await runUniversePortfolioController(f.definition, f.options);
      expect(second.reasons).toContain('controller-owned');
      expect(hooks.run).toHaveBeenCalledOnce();
    } finally { release.resolve(f.finish('a')); }
    expect((await first).status).toBe('completed');
    expect((await runUniversePortfolioController(f.definition, f.options)).status).toBe('completed');
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('keeps the original deadline across downtime and refuses clock rollback', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
    const f = fixture(); f.readiness.get('a')!.resourceRuntimeRequired = true;
    const first = await runUniversePortfolioController(f.definition, f.options);
    const before = f.events();
    vi.setSystemTime(new Date('2026-09-09T11:59:59.000Z'));
    const rollback = await runUniversePortfolioController(f.definition, f.options);
    expect(rollback.sourceState).toBe('degraded');
    expect(rollback.reasons).toContain('controller-clock-rollback');
    vi.setSystemTime(new Date('2026-09-09T12:00:11.000Z'));
    const expired = await runUniversePortfolioController(f.definition, f.options);
    expect(expired.status).toBe('timed-out');
    expect(expired.deadlineAt).toBe(first.deadlineAt);
    expect(f.events()).toEqual(before);
    expect(hooks.run).not.toHaveBeenCalled();
  });

  it('refuses changed raw record evidence despite an unchanged summary identity', async () => {
    const f = fixture(); let reads = 0;
    hooks.readiness.mockImplementation((id: string) => {
      const value = structuredClone(f.readiness.get(id)!);
      if (++reads > 1) value.recordsDigest = 'f'.repeat(64);
      return value;
    });
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.sourceState).toBe('degraded');
    expect(hooks.run).not.toHaveBeenCalled();
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false);
  });

  it('does not execute when immutable intent persistence fails', async () => {
    const f = fixture(); const write = records.writeImmutablePrivateRecord;
    vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((config, value) => {
      if ((value as { kind?: string }).kind === 'intent') throw new Error('synthetic disk failure');
      return write(config, value);
    });
    await expect(runUniversePortfolioController(f.definition, f.options)).rejects.toThrow();
    expect(hooks.run).not.toHaveBeenCalled();
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false);
  });

  it('aborts and drains owned siblings when settlement persistence fails', async () => {
    const f = fixture(['a', 'b'], 2); const startedB = deferred<void>(); const abortedB = deferred<void>();
    const releaseB = deferred<UniverseCampaignSummary>(); const write = records.writeImmutablePrivateRecord;
    vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((config, value) => {
      const event = value as { kind?: string; outcome?: { campaignId: string } };
      if (event.kind === 'settled' && event.outcome?.campaignId === 'a') throw new Error('synthetic settlement failure');
      return write(config, value);
    });
    hooks.run.mockImplementation(async (id: string, options) => {
      if (id === 'a') { await startedB.promise; return f.finish(id); }
      options.signal.addEventListener('abort', () => abortedB.resolve(), { once: true });
      startedB.resolve(); return releaseB.promise;
    });
    let returned = false;
    const pending = runUniversePortfolioController(f.definition, f.options).then((result) => { returned = true; return result; });
    await abortedB.promise;
    expect(returned).toBe(false);
    releaseB.resolve(f.finish('b'));
    const result = await pending;
    expect(result.status).toBe('unavailable');
    expect(result.reasons).toContain('controller-settlement-persistence-failed');
    expect(result.outcomes.find((item) => item.campaignId === 'a')?.state).toBe('in-flight');
    expect(hooks.run).toHaveBeenCalledTimes(2);
  });

  it('does not call delivery when campaign completion was not durably observed', async () => {
    const f = fixture(); hooks.run.mockResolvedValue({ fixtureId: 'a', state: 'completed' });
    const deliveryPlan = { schemaVersion: 1 as const, deliveries: [{ campaignId: 'a', branch: 'codex/result', baseCommit: 'a'.repeat(40) }] };
    const result = await runUniversePortfolioController(f.definition, { ...f.options, deliveryPlan });
    expect(result.outcomes[0]?.state).toBe('in-flight');
    expect(hooks.deliver).not.toHaveBeenCalled();
  });
});
