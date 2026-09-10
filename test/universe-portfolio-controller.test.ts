import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import { readPortfolioControllerEvents, portfolioControllerDirectory } from '../src/core/universe/portfolio-controller-store.js';
import * as controllerStore from '../src/core/universe/portfolio-controller-store.js';
import * as records from '../src/core/util/immutable-private-record-store.js';
import * as locks from '../src/core/fleet/local-store-lock.js';

const hooks = vi.hoisted(() => ({ readiness: vi.fn(), run: vi.fn(), campaign: vi.fn(), plan: vi.fn(),
  preflight: vi.fn(), deliver: vi.fn(), deliveries: vi.fn(), acquire: vi.fn(), runtime: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.readiness }));
vi.mock('../src/core/universe/resource-runtime-check.js', () => ({ checkResourceGenerationRuntime: hooks.runtime }));
vi.mock('../src/core/universe/campaign.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign.js')>(), runUniverseCampaignOwned: hooks.run,
}));
vi.mock('../src/core/universe/execution.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/execution.js')>(), acquireUniverseExecution: hooks.acquire,
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
beforeEach(() => { for (const hook of Object.values(hooks)) hook.mockReset(); hooks.runtime.mockReturnValue({ status: 'valid' }); });
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
  const finish = (id: string, state: 'completed' | 'paused' | 'stopped' | 'failed' = 'completed') => {
    const summary = { fixtureId: id, state } as unknown as UniverseCampaignSummary;
    summaries.set(id, summary);
    const before = readiness.get(id)!;
    readiness.set(id, { ...before, observedState: state, disposition: state === 'completed' ? 'terminal' : 'owner-held',
      reasonCode: state === 'completed' ? 'campaign-completed' : 'owner-paused', automaticAction: 'none', recordsDigest: FINAL_RECORDS,
      expectedIdentity: { ...before.expectedIdentity!, summaryDigest: digest(canonical(summary)) } });
    return structuredClone(summary);
  };
  hooks.run.mockImplementation(async (id: string) => finish(id));
  const executionLock = { path: '/synthetic/.execution.lock', token: 'fixture', dev: 1n, ino: 1n };
  const originalOwns = locks.ownsLocalStoreLock;
  vi.spyOn(locks, 'ownsLocalStoreLock').mockImplementation((lock) => lock === executionLock || originalOwns(lock));
  hooks.acquire.mockReturnValue({ state: 'acquired', lock: executionLock });
  const options = { root };
  const events = () => readPortfolioControllerEvents(portfolioControllerDirectory(definition.id, options));
  return { root, definition, options, readiness, summaries, finish, events, executionLock };
}

describe('Portfolio controller private-ledger fault acceptance', () => {
  it('projects topology from its persisted enrollment in declared order without aliasing caller arrays', async () => {
    const f = fixture(['c', 'a', 'b']);
    f.definition.tasks[0]!.dependsOn = ['b']; f.definition.tasks[2]!.dependsOn = ['a'];
    for (const id of ['a', 'b', 'c']) f.finish(id);
    const result = await runUniversePortfolioController(f.definition, f.options);
    const expected = [
      { campaignId: 'c', dependsOn: ['b'], prerequisites: ['b'] },
      { campaignId: 'a', dependsOn: [], prerequisites: [] },
      { campaignId: 'b', dependsOn: ['a'], prerequisites: ['a'] },
    ];
    expect(result.topology).toEqual(expected);
    const before = JSON.stringify(f.events());
    f.definition.tasks[0]!.dependsOn = []; result.topology![0]!.dependsOn.push('a');
    result.topology![0]!.prerequisites.push('a');
    expect(readUniversePortfolioController(f.definition.id, f.options).topology).toEqual(expected);
    expect(JSON.stringify(f.events())).toBe(before);
    expect(hooks.run).not.toHaveBeenCalled();
  });

  it('projects transitive planned delivery prerequisites beyond a precompleted intermediate', async () => {
    const f = fixture(['a', 'b', 'c']);
    f.definition.tasks[1]!.dependsOn = ['a']; f.definition.tasks[2]!.dependsOn = ['b'];
    f.finish('a', 'paused'); f.finish('b');
    const options = { ...f.options, deliveryPlan: { schemaVersion: 1 as const,
      deliveries: [{ campaignId: 'a', branch: 'codex/topology', baseCommit: 'a'.repeat(40) }] } };
    const result = await runUniversePortfolioController(f.definition, options);
    expect(result.topology).toEqual([
      { campaignId: 'a', dependsOn: [], prerequisites: [] },
      { campaignId: 'b', dependsOn: ['a'], prerequisites: ['a'] },
      { campaignId: 'c', dependsOn: ['b'], prerequisites: ['b', 'a'] },
    ]);
    expect(result.outcomes).toMatchObject([
      { campaignId: 'a', state: 'held' }, { campaignId: 'b', state: 'completed' },
      { campaignId: 'c', state: 'held', reasonCode: 'dependency-held' },
    ]);
    expect(readUniversePortfolioController(f.definition.id, f.options).topology).toEqual(result.topology);
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('settles a delivery-only post-intent cancellation without pretending the campaign was attempted', async () => {
    const f = fixture(['a', 'b']); f.finish('a'); f.definition.tasks[1]!.dependsOn = ['a'];
    f.readiness.get('a')!.resourceRuntimeRequired = true;
    hooks.runtime.mockReturnValue({ status: 'invalid', checks: [{ code: 'runtime', status: 'failed' }] });
    const deliveryPlan = { schemaVersion: 1 as const,
      deliveries: [{ campaignId: 'a', branch: 'codex/not-started', baseCommit: 'a'.repeat(40) }] };
    const caller = new AbortController(); const original = controllerStore.appendPortfolioControllerEvent;
    vi.spyOn(controllerStore, 'appendPortfolioControllerEvent').mockImplementation((directory, input, options) => {
      const next = original(directory, input, options);
      if (input.kind === 'intent') caller.abort();
      return next;
    });
    const result = await runUniversePortfolioController(f.definition, { ...f.options, deliveryPlan, signal: caller.signal, resourceRuntime: '/private/runtime.json' });
    expect(result).toMatchObject({ status: 'cancelled', sourceState: 'healthy', outcomes: [
      { campaignId: 'a', state: 'held', attempted: false, reasonCode: 'dispatch-not-started', deliveryDigest: null },
      { campaignId: 'b', state: 'held', attempted: false, reasonCode: 'dependency-held' },
    ] });
    expect(hooks.acquire).not.toHaveBeenCalled();
    expect(hooks.run).not.toHaveBeenCalled();
    expect(hooks.deliver).not.toHaveBeenCalled();
    expect(hooks.runtime).not.toHaveBeenCalled();
    const evidence = f.events().filter((event) => event.kind !== 'observed');
    const restarted = await runUniversePortfolioController(f.definition, { ...f.options, deliveryPlan });
    expect(restarted).toMatchObject({ deadlineAt: result.deadlineAt, outcomes: result.outcomes });
    expect(f.events().filter((event) => event.kind !== 'observed')).toEqual(evidence);
    expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('leaves a known pre-call cancellation unresolved if its held receipt cannot be persisted', async () => {
    const f = fixture(); const caller = new AbortController(); const original = controllerStore.appendPortfolioControllerEvent;
    vi.spyOn(controllerStore, 'appendPortfolioControllerEvent').mockImplementation((directory, input, options) => {
      if (input.kind === 'settled') throw new Error('Fixture no-start receipt storage unavailable');
      const next = original(directory, input, options);
      if (input.kind === 'intent') caller.abort();
      return next;
    });
    const result = await runUniversePortfolioController(f.definition, { ...f.options, signal: caller.signal });
    expect(result).toMatchObject({ status: 'cancelled', outcomes: [
      { state: 'in-flight', attempted: true, reasonCode: 'reconciliation-required' },
    ] });
    expect(f.events().some((event) => event.kind === 'settled')).toBe(false);
    expect(hooks.run).not.toHaveBeenCalled();
    const restarted = await runUniversePortfolioController(f.definition, f.options);
    expect(restarted).toMatchObject({ deadlineAt: result.deadlineAt, outcomes: result.outcomes });
    expect(hooks.run).not.toHaveBeenCalled();
    expect(f.events().some((event) => event.kind === 'settled')).toBe(false);
  });

  it('rechecks a delivery-only campaign after final intent contention before any handoff', async () => {
    const f = fixture(); f.finish('a');
    const deliveryPlan = { schemaVersion: 1 as const,
      deliveries: [{ campaignId: 'a', branch: 'codex/recheck', baseCommit: 'a'.repeat(40) }] };
    const directory = portfolioControllerDirectory(f.definition.id, f.options);
    const entered = deferred<void>();
    let transactionLock: locks.LocalStoreLock | undefined;
    const original = controllerStore.appendPortfolioControllerEvent;
    vi.spyOn(controllerStore, 'appendPortfolioControllerEvent').mockImplementation((target, input, options) => {
      if (input.kind === 'intent' && !transactionLock) {
        const acquired = locks.acquireLocalStoreLockWithOutcome(join(directory, '.control.lock'), 0,
          { anchorPath: directory, exactPrivateStorage: true });
        if (acquired.state !== 'acquired') throw new Error('Could not hold fixture admission transaction');
        transactionLock = acquired.lock; entered.resolve();
      }
      return original(target, input, options);
    });
    const caller = new AbortController();
    const pending = runUniversePortfolioController(f.definition, { ...f.options, deliveryPlan, signal: caller.signal });
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Controller returned before admission contention'); })]);
      const before = f.events();
      const deadlineAt = readUniversePortfolioController(f.definition.id, f.options).deadlineAt;
      f.readiness.get('a')!.recordsDigest = 'd'.repeat(64);
      expect(locks.releaseLocalStoreLock(transactionLock!)).toBe(true);
      expect(await pending).toMatchObject({ status: 'unavailable', sourceState: 'degraded', deadlineAt });
      expect(hooks.acquire).not.toHaveBeenCalled();
      expect(hooks.run).not.toHaveBeenCalled();
      expect(hooks.deliver).not.toHaveBeenCalled();
      expect(f.events()).toEqual(before);
      expect(f.events().some((event) => event.kind === 'intent')).toBe(false);
    } finally {
      caller.abort();
      if (transactionLock && locks.ownsLocalStoreLock(transactionLock)) locks.releaseLocalStoreLock(transactionLock);
      await pending;
    }
  });

  it('waits for pristine observed ownership with pinned state and no polling records', async () => {
    const f = fixture(); const readiness = f.readiness.get('a')!;
    Object.assign(readiness, { disposition: 'owned', reasonCode: 'owner-active', automaticAction: 'none' });
    const running = runUniversePortfolioController(f.definition, f.options);
    const before = f.events();
    expect(readUniversePortfolioController(f.definition.id, f.options).outcomes[0]).toMatchObject({
      state: 'pending', attempted: false, reasonCode: 'waiting-for-universe-owner',
    });
    expect(hooks.acquire).not.toHaveBeenCalled(); expect(hooks.run).not.toHaveBeenCalled();
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect(f.events()).toEqual(before);
    Object.assign(readiness, { disposition: 'startable', reasonCode: 'never-started', automaticAction: 'run' });
    expect((await running).status).toBe('completed');
    expect(hooks.run).toHaveBeenCalledOnce();
    expect(hooks.run.mock.calls[0]?.[1].expectedIdentity.recordsDigest).toBe(INITIAL_RECORDS);
  });

  it('does not consume a slot while lease contention blocks an independent sibling', async () => {
    const f = fixture(['a', 'b']);
    hooks.acquire.mockImplementation((id: string) => id === 'universe-a' && hooks.run.mock.calls.length === 0
      ? { state: 'contended', lock: null } : { state: 'acquired', lock: f.executionLock });
    expect((await runUniversePortfolioController(f.definition, f.options)).status).toBe('completed');
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['b', 'a']);
    expect(f.events().filter((event) => event.kind === 'observed')).toHaveLength(1);
  });

  it('does not poll campaign evidence while only admitted workers are active', async () => {
    const f = fixture(); const started = deferred<void>(); const release = deferred<UniverseCampaignSummary>();
    hooks.run.mockImplementation(() => { started.resolve(); return release.promise; });
    const running = runUniversePortfolioController(f.definition, f.options);
    await started.promise;
    hooks.readiness.mockClear();
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      expect(hooks.readiness).not.toHaveBeenCalled();
    } finally { release.resolve(f.finish('a')); }
    expect((await running).status).toBe('completed');
  });

  it.each(['unavailable', 'throws'] as const)('refuses %s ownership without a durable intent', async (state) => {
    const f = fixture();
    hooks.acquire.mockImplementation(() => { if (state === 'throws') throw new Error('unavailable fixture'); return { state, lock: null }; });
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.status).toBe('unavailable');
    expect(result.reasons).toContain('campaign-execution-ownership-unavailable');
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false); expect(hooks.run).not.toHaveBeenCalled();
  });

  it('cancels contention waiting promptly without consuming intent or renewing restart allowance', async () => {
    const f = fixture(); const controller = new AbortController();
    hooks.acquire.mockReturnValue({ state: 'contended', lock: null });
    const running = runUniversePortfolioController(f.definition, { ...f.options, signal: controller.signal });
    const before = f.events(); controller.abort();
    const cancelled = await running;
    expect(cancelled.status).toBe('cancelled'); expect(f.events()).toEqual(before);
    hooks.acquire.mockReturnValue({ state: 'acquired', lock: f.executionLock });
    const resumed = await runUniversePortfolioController(f.definition, f.options);
    expect(resumed).toMatchObject({ status: 'completed', deadlineAt: cancelled.deadlineAt, createdAt: cancelled.createdAt });
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('stops at the original deadline while contended without an intent', async () => {
    const f = fixture(); f.definition.maxDurationMs = 50;
    hooks.acquire.mockReturnValue({ state: 'contended', lock: null });
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.status).toBe('timed-out');
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false); expect(hooks.run).not.toHaveBeenCalled();
  });

  it('rejects changed raw history under the acquired lease and releases it before intent', async () => {
    const f = fixture(); const release = vi.spyOn(locks, 'releaseLocalStoreLock');
    hooks.acquire.mockImplementation(() => {
      f.readiness.get('a')!.recordsDigest = 'f'.repeat(64);
      return { state: 'acquired', lock: f.executionLock };
    });
    expect((await runUniversePortfolioController(f.definition, f.options)).status).toBe('unavailable');
    expect(release).toHaveBeenCalledWith(f.executionLock);
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false); expect(hooks.run).not.toHaveBeenCalled();
  });

  it('releases acquired ownership when cancellation arrives before intent', async () => {
    const f = fixture(); const controller = new AbortController(); const release = vi.spyOn(locks, 'releaseLocalStoreLock');
    hooks.acquire.mockImplementation(() => {
      controller.abort(); return { state: 'acquired', lock: f.executionLock };
    });
    expect((await runUniversePortfolioController(f.definition, { ...f.options, signal: controller.signal })).status).toBe('cancelled');
    expect(release).toHaveBeenCalledWith(f.executionLock);
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false); expect(hooks.run).not.toHaveBeenCalled();
  });

  it('rechecks delivered dependency evidence after acquiring campaign ownership', async () => {
    const f = fixture(['a', 'b']); f.finish('a'); f.definition.tasks[1]!.dependsOn = ['a'];
    const release = vi.spyOn(locks, 'releaseLocalStoreLock');
    hooks.acquire.mockImplementation(() => {
      f.readiness.get('a')!.recordsDigest = 'f'.repeat(64);
      return { state: 'acquired', lock: f.executionLock };
    });
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.status).toBe('unavailable'); expect(result.reasons).toContain('controller-dependency-evidence-changed');
    expect(release).toHaveBeenCalledWith(f.executionLock);
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false); expect(hooks.run).not.toHaveBeenCalled();
  });

  it('retains unresolved intent and releases ownership if the owned runner throws', async () => {
    const f = fixture(); const release = vi.spyOn(locks, 'releaseLocalStoreLock');
    hooks.run.mockRejectedValue(new Error('synthetic failure'));
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
    expect(release).toHaveBeenCalledWith(f.executionLock); expect(hooks.run).toHaveBeenCalledOnce();
  });

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

  it.each([
    ['owner-paused', 'paused', 'owner-held'],
    ['campaign-stopped', 'stopped', 'terminal'],
    ['campaign-failed', 'failed', 'terminal'],
    ['resource-withheld', 'paused', 'resource-withheld'],
    ['resource-outcome-ambiguous', 'paused', 'recovery-required'],
    ['usage-unavailable', 'paused', 'attention-required'],
    ['request-budget-exhausted', 'paused', 'budget-exhausted'],
    ['duration-budget-exhausted', 'paused', 'budget-exhausted'],
  ] as const)('persists verified %s without replaying held work or changing graph scheduling', async (reasonCode, state, disposition) => {
    const f = fixture(['a', 'b', 'c']);
    f.definition.tasks[1]!.dependsOn = ['a'];
    const options = { ...f.options, deliveryPlan: { schemaVersion: 1 as const,
      deliveries: [{ campaignId: 'a', branch: 'codex/held', baseCommit: 'a'.repeat(40) }] } };
    hooks.run.mockImplementation(async (id: string) => {
      if (id !== 'a') return f.finish(id);
      const summary = f.finish(id, state);
      Object.assign(f.readiness.get(id)!, { reasonCode, disposition });
      return summary;
    });
    const first = await runUniversePortfolioController(f.definition, options);
    expect(first).toMatchObject({ sourceState: 'healthy', status: 'incomplete', outcomes: [
      { campaignId: 'a', state: 'held', attempted: true, reasonCode, deliveryDigest: null },
      { campaignId: 'b', state: 'held', attempted: false, reasonCode: 'dependency-held' },
      { campaignId: 'c', state: 'completed', attempted: true, reasonCode: 'campaign-completed' },
    ] });
    const readback = readUniversePortfolioController(f.definition.id, f.options);
    expect(readback.outcomes).toEqual(first.outcomes);
    const settled = f.events().filter((event) => event.kind === 'settled');
    expect(settled.find((event) => event.outcome.campaignId === 'a')).toMatchObject({
      recordsDigest: FINAL_RECORDS, outcome: { state: 'held', reasonCode },
    });
    const restarted = await runUniversePortfolioController(f.definition, options);
    expect(restarted).toMatchObject({ status: 'incomplete', sourceState: 'healthy',
      deadlineAt: first.deadlineAt, createdAt: first.createdAt, outcomes: first.outcomes });
    expect(f.events().filter((event) => event.kind === 'settled')).toEqual(settled);
    expect(f.events().filter((event) => event.kind === 'intent').map((event) => event.campaignId)).toEqual(['a', 'c']);
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a', 'c']);
    expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('keeps completed budget outcomes completed rather than treating a reason as a hold', async () => {
    const f = fixture(['a', 'b']); f.definition.tasks[1]!.dependsOn = ['a'];
    hooks.run.mockImplementation(async (id: string) => {
      const summary = f.finish(id);
      if (id === 'a') {
        summary.reason = 'Campaign duration budget exhausted';
        f.summaries.set(id, summary);
        f.readiness.get(id)!.expectedIdentity!.summaryDigest = digest(canonical(summary));
      }
      return summary;
    });
    const first = await runUniversePortfolioController(f.definition, f.options);
    expect(first.status).toBe('completed');
    expect(first.outcomes[0]).toMatchObject({ state: 'completed', reasonCode: 'campaign-completed' });
    const before = f.events();
    expect((await runUniversePortfolioController(f.definition, f.options)).outcomes).toEqual(first.outcomes);
    expect(f.events()).toEqual(before);
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('keeps delivery refusal as the reason for an otherwise completed campaign', async () => {
    const f = fixture();
    const options = { ...f.options, deliveryPlan: { schemaVersion: 1 as const,
      deliveries: [{ campaignId: 'a', branch: 'codex/withheld', baseCommit: 'a'.repeat(40) }] } };
    hooks.deliver.mockImplementation(async (id: string) => ({ campaign: structuredClone(f.summaries.get(id)!),
      delivery: { status: 'withheld', reason: 'synthetic-delivery-refusal' } }));
    const first = await runUniversePortfolioController(f.definition, options);
    expect(first.outcomes[0]).toMatchObject({ state: 'held', reasonCode: 'delivery-withheld', deliveryDigest: null });
    expect(readUniversePortfolioController(f.definition.id, f.options).outcomes).toEqual(first.outcomes);
    const settled = f.events().filter((event) => event.kind === 'settled');
    expect((await runUniversePortfolioController(f.definition, options)).outcomes).toEqual(first.outcomes);
    expect(f.events().filter((event) => event.kind === 'settled')).toEqual(settled);
    expect(hooks.run).toHaveBeenCalledOnce(); expect(hooks.deliver).toHaveBeenCalledOnce();
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
    expect(hooks.runtime).not.toHaveBeenCalled();
  });

  it('keeps invalid-runtime campaigns pending without intents while independent work completes', async () => {
    const f = fixture(['a', 'b', 'c']);
    f.readiness.get('a')!.resourceRuntimeRequired = true; f.readiness.get('c')!.resourceRuntimeRequired = true;
    hooks.runtime.mockReturnValue({ status: 'invalid', checks: [{ code: 'bindings', status: 'failed' }] });
    const result = await runUniversePortfolioController(f.definition, { ...f.options, resourceRuntime: '/private/runtime.json' });
    expect(result.status).toBe('incomplete');
    expect(result.outcomes.map((row) => row.state)).toEqual(['pending', 'completed', 'pending']);
    expect(result.reasons).toEqual(expect.arrayContaining(['a:resource-runtime-invalid:bindings', 'c:resource-runtime-invalid:bindings']));
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['b']); expect(hooks.runtime).toHaveBeenCalledOnce();
    expect(f.events().filter((event) => event.kind === 'intent').map((event) => event.campaignId)).toEqual(['b']);
    expect(JSON.stringify(f.events())).not.toMatch(/resource-runtime-invalid|runtime\.json/);
    expect(f.readiness.get('a')!.observedState).toBe('ready');
  });

  it('rechecks invalid configuration on a new invocation without rewriting prior pins or deadlines', async () => {
    const f = fixture(); f.readiness.get('a')!.resourceRuntimeRequired = true;
    hooks.runtime.mockReturnValueOnce({ status: 'invalid', checks: [{ code: 'runtime', status: 'failed' }] }).mockReturnValue({ status: 'valid' });
    const first = await runUniversePortfolioController(f.definition, { ...f.options, resourceRuntime: '/private/runtime.json' });
    const firstRecord = f.events()[0];
    expect(first.outcomes[0]).toMatchObject({ state: 'pending', attempted: false });
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false);
    const second = await runUniversePortfolioController(f.definition, { ...f.options, resourceRuntime: '/private/runtime.json' });
    expect(second.status).toBe('completed'); expect(second.deadlineAt).toBe(first.deadlineAt);
    expect(f.events()[0]).toEqual(firstRecord); expect(hooks.run).toHaveBeenCalledOnce(); expect(hooks.runtime).toHaveBeenCalledTimes(2);
  });

  it('does not gate valid configuration on a zero-capacity observation', async () => {
    const f = fixture(['a', 'b']); for (const report of f.readiness.values()) report.resourceRuntimeRequired = true;
    hooks.runtime.mockReturnValue({ status: 'valid', counts: { eligibleWorkers: 0 }, warnings: ['quota-refresh-not-configured'] });
    const result = await runUniversePortfolioController(f.definition, { ...f.options, resourceRuntime: '/private/runtime.json' });
    expect(result.status).toBe('completed'); expect(hooks.run).toHaveBeenCalledTimes(2); expect(hooks.runtime).toHaveBeenCalledOnce();
  });

  it.each(['cancelled', 'queued-cancel', 'timed-out'] as const)('rechecks %s after synchronous resource preflight before recording an intent', async (status) => {
    const f = fixture(); f.readiness.get('a')!.resourceRuntimeRequired = true;
    const controller = new AbortController(); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    hooks.runtime.mockImplementation(() => {
      if (status === 'cancelled') controller.abort();
      else if (status === 'queued-cancel') setImmediate(() => controller.abort());
      else now = 10_001;
      return { status: 'valid' };
    });
    const result = await runUniversePortfolioController(f.definition, { ...f.options, resourceRuntime: '/private/runtime.json', signal: controller.signal });
    expect(result.status).toBe(status === 'queued-cancel' ? 'cancelled' : status); expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.acquire).not.toHaveBeenCalled();
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false);
    expect(result.outcomes[0]).toMatchObject({ state: 'pending', attempted: false });
  });

  it.each(['completed', 'non-resource', 'cancelled'] as const)('bypasses runtime preflight for %s campaigns', async (state) => {
    const f = fixture(); const controller = new AbortController();
    f.readiness.get('a')!.resourceRuntimeRequired = state !== 'non-resource';
    if (state === 'completed') f.finish('a'); if (state === 'cancelled') controller.abort();
    await runUniversePortfolioController(f.definition, { ...f.options, resourceRuntime: '/private/runtime.json', signal: controller.signal });
    expect(hooks.runtime).not.toHaveBeenCalled();
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
    const f = fixture(); const write = records.writeImmutablePrivateRecord; const release = vi.spyOn(locks, 'releaseLocalStoreLock');
    vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((config, value) => {
      if ((value as { kind?: string }).kind === 'intent') throw new Error('synthetic disk failure');
      return write(config, value);
    });
    await expect(runUniversePortfolioController(f.definition, f.options)).rejects.toThrow();
    expect(hooks.run).not.toHaveBeenCalled();
    expect(f.events().some((event) => event.kind === 'intent')).toBe(false);
    expect(release).toHaveBeenCalledWith(f.executionLock);
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
