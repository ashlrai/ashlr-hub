import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import * as store from '../src/core/universe/portfolio-controller-store.js';
import * as locks from '../src/core/fleet/local-store-lock.js';

const hooks = vi.hoisted(() => ({ readiness: vi.fn(), run: vi.fn(), campaign: vi.fn(), plan: vi.fn(), acquire: vi.fn(), proof: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.readiness }));
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
vi.mock('../src/core/universe/campaign-dispatch.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-dispatch.js')>(), readCompletedUniverseCampaignDispatch: hooks.proof,
}));
import { readUniversePortfolioController, runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';

const scratch: string[] = [];
const HASH = 'a'.repeat(64);
beforeEach(() => { for (const hook of Object.values(hooks)) hook.mockReset(); hooks.proof.mockReturnValue(null); });
afterEach(() => {
  vi.restoreAllMocks();
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

// Real controller transactions and immutable history; campaign work/projections
// are fixtures. Separate-process CLI and delivery acceptance lives next door.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-controller-drain-'))); scratch.push(root);
  const ids = ['a', 'b'];
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'drain-controller',
    tasks: ids.map((campaignId) => ({ campaignId, dependsOn: [] })), maxParallel: 1, maxDurationMs: 10_000 };
  const summaries = new Map(ids.map((id) => [id, { fixtureId: id, state: 'ready' } as unknown as UniverseCampaignSummary]));
  const readiness = new Map(ids.map((id): [string, UniverseCampaignReadiness] => [id, {
    schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: id, universeId: `universe-${id}`,
    sourceState: 'healthy', observedState: 'ready', disposition: 'startable', reasonCode: 'never-started', automaticAction: 'run',
    resourceRuntimeRequired: false, recordsDigest: 'b'.repeat(64), sampledAt: new Date().toISOString(),
    expectedIdentity: { universeId: `universe-${id}`, definitionDigest: HASH, manifestDigest: HASH,
      comparatorDigest: HASH, summaryDigest: digest(canonical(summaries.get(id)!)) },
  }]));
  hooks.readiness.mockImplementation((id: string) => structuredClone(readiness.get(id)!));
  hooks.campaign.mockImplementation((id: string) => structuredClone(summaries.get(id)!));
  hooks.plan.mockImplementation(() => ({ schemaVersion: 1, sourceState: 'healthy', definition,
    definitionDigest: digest(canonical(definition)), topologicalOrder: ids,
    nodes: ids.map((id) => ({ campaignId: id, campaign: structuredClone(summaries.get(id)!) })) }));
  const finish = (id: string) => {
    const summary = { fixtureId: id, state: 'completed' } as unknown as UniverseCampaignSummary;
    summaries.set(id, summary);
    const before = readiness.get(id)!;
    readiness.set(id, { ...before, observedState: 'completed', disposition: 'terminal', reasonCode: 'campaign-completed',
      automaticAction: 'none', recordsDigest: 'c'.repeat(64),
      expectedIdentity: { ...before.expectedIdentity!, summaryDigest: digest(canonical(summary)) } });
    return structuredClone(summary);
  };
  hooks.run.mockImplementation(async (id: string) => finish(id));
  const executionLock = { path: '/synthetic/.execution.lock', token: 'fixture', dev: 1n, ino: 1n };
  const originalOwns = locks.ownsLocalStoreLock;
  let executionOwned = true;
  vi.spyOn(locks, 'ownsLocalStoreLock').mockImplementation((lock) => lock === executionLock ? executionOwned : originalOwns(lock));
  hooks.acquire.mockReturnValue({ state: 'acquired', lock: executionLock });
  const options = { root };
  const directory = store.portfolioControllerDirectory(definition.id, options);
  const events = () => store.readPortfolioControllerEvents(directory);
  const control = (action: 'drain' | 'resume', expectedDrainSequence?: number) =>
    store.requestUniversePortfolioControllerControl(definition.id, action, { root, ...(expectedDrainSequence === undefined ? {} : { expectedDrainSequence }) });
  return { root, directory, definition, options, readiness, finish, events, control, executionLock,
    loseExecution: () => { executionOwned = false; } };
}

describe('Durable controller drain execution', () => {
  it.each(['unchanged', 'campaign', 'dependency', 'ownership'] as const)('revalidates %s evidence after final intent transaction contention', async (changed) => {
    const f = fixture();
    f.finish('a');
    f.definition.tasks[1]!.dependsOn = ['a'];
    const entered = deferred<void>();
    let transactionLock: locks.LocalStoreLock | undefined;
    const original = store.appendPortfolioControllerEvent;
    vi.spyOn(store, 'appendPortfolioControllerEvent').mockImplementation((directory, input, options) => {
      if (input.kind === 'intent' && !transactionLock) {
        const acquired = locks.acquireLocalStoreLockWithOutcome(join(f.directory, '.control.lock'), 0,
          { anchorPath: f.directory, exactPrivateStorage: true });
        if (acquired.state !== 'acquired') throw new Error('Could not hold fixture admission transaction');
        transactionLock = acquired.lock;
        entered.resolve();
      }
      return original(directory, input, options);
    });
    const release = vi.spyOn(locks, 'releaseLocalStoreLock');
    const caller = new AbortController();
    const pending = runUniversePortfolioController(f.definition, { ...f.options, signal: caller.signal });
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Controller returned before admission contention'); })]);
      const before = f.events();
      const originalDeadline = readUniversePortfolioController(f.definition.id, f.options).deadlineAt;
      if (changed === 'ownership') f.loseExecution();
      else if (changed !== 'unchanged') {
        const id = changed === 'campaign' ? 'b' : 'a';
        f.readiness.set(id, { ...f.readiness.get(id)!, recordsDigest: 'd'.repeat(64) });
      }
      expect(locks.releaseLocalStoreLock(transactionLock!)).toBe(true);
      const result = await pending;
      expect(result.deadlineAt).toBe(originalDeadline);
      if (changed === 'unchanged') {
        expect(result).toMatchObject({ status: 'completed', sourceState: 'healthy' });
        expect(hooks.run).toHaveBeenCalledExactlyOnceWith('b', expect.any(Object), f.executionLock);
        expect(f.events().filter((row) => row.kind === 'intent')).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ status: 'unavailable', sourceState: changed === 'ownership' ? 'healthy' : 'degraded' });
        expect(hooks.run).not.toHaveBeenCalled();
        expect(f.events()).toEqual(before);
        expect(f.events().some((row) => row.kind === 'intent')).toBe(false);
      }
      expect(release).toHaveBeenCalledWith(f.executionLock);
      expect(existsSync(join(f.directory, '.execution.lock'))).toBe(false);
    } finally {
      caller.abort();
      if (transactionLock && locks.ownsLocalStoreLock(transactionLock)) locks.releaseLocalStoreLock(transactionLock);
      await pending;
    }
  });

  it('acknowledges drain while waiting for Universe ownership without consuming an intent', async () => {
    const f = fixture(); hooks.acquire.mockReturnValue({ state: 'contended', lock: null });
    const pending = runUniversePortfolioController(f.definition, f.options);
    const before = readUniversePortfolioController(f.definition.id, f.options);
    const request = f.control('drain');
    const result = await pending;
    expect(result).toMatchObject({ status: 'drained', sourceState: 'healthy', deadlineAt: before.deadlineAt,
      control: { mode: 'drain', sequence: request.sequence, acknowledgedAt: expect.any(String) } });
    expect(result.outcomes.every((row) => row.state === 'pending' && !row.attempted)).toBe(true);
    expect(f.events().some((row) => row.kind === 'intent')).toBe(false);
    expect(hooks.run).not.toHaveBeenCalled();
    const drained = f.events();
    expect((await runUniversePortfolioController(f.definition, f.options)).status).toBe('drained');
    expect(f.events()).toEqual(drained);
  });

  it('finishes an admitted campaign, retains pending work, and resumes only on exact owner instruction', async () => {
    const f = fixture(); const started = deferred<void>(); const complete = deferred<UniverseCampaignSummary>();
    hooks.run.mockImplementationOnce(() => { started.resolve(); return complete.promise; });
    const pending = runUniversePortfolioController(f.definition, f.options);
    await started.promise;
    const original = readUniversePortfolioController(f.definition.id, f.options);
    const request = f.control('drain');
    expect(readUniversePortfolioController(f.definition.id, f.options)).toMatchObject({ status: 'draining',
      control: { sequence: request.sequence, acknowledgedAt: null } });
    expect(() => f.control('resume', request.sequence)).toThrow();
    complete.resolve(f.finish('a'));
    const drained = await pending;
    expect(drained).toMatchObject({ status: 'drained', deadlineAt: original.deadlineAt });
    expect(drained.outcomes).toMatchObject([{ campaignId: 'a', state: 'completed', attempted: true },
      { campaignId: 'b', state: 'pending', attempted: false }]);
    expect(hooks.run).toHaveBeenCalledOnce();
    const beforeResume = f.events().filter((row) => row.kind === 'intent');
    f.control('resume', request.sequence);
    expect(hooks.run).toHaveBeenCalledOnce();
    expect(f.events().filter((row) => row.kind === 'intent')).toEqual(beforeResume);
    expect(await runUniversePortfolioController(f.definition, f.options)).toMatchObject({ status: 'completed',
      createdAt: original.createdAt, deadlineAt: original.deadlineAt, control: { mode: 'open' } });
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('does not acknowledge an unresolved durable attempt when its local worker promise is gone', async () => {
    const f = fixture();
    hooks.run.mockImplementation(async () => { f.control('drain'); throw new Error('Unknown worker outcome'); });
    const first = await runUniversePortfolioController(f.definition, f.options);
    expect(first).toMatchObject({ status: 'draining', sourceState: 'healthy', control: { acknowledgedAt: null } });
    expect(first.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
    expect(f.events().some((row) => row.kind === 'drained')).toBe(false);
    expect(() => f.control('resume', first.control!.sequence)).toThrow();
    const second = await runUniversePortfolioController(f.definition, f.options);
    expect(second).toMatchObject({ status: 'draining', deadlineAt: first.deadlineAt, control: { acknowledgedAt: null } });
    expect(hooks.run).toHaveBeenCalledOnce();
    expect(f.events().filter((row) => row.kind === 'intent')).toHaveLength(1);
  });

  it('refuses an intent when drain wins the final append race and releases the unused execution lease', async () => {
    const f = fixture();
    const original = store.appendPortfolioControllerEvent;
    let drained = false;
    vi.spyOn(store, 'appendPortfolioControllerEvent').mockImplementation((directory, input, options) => {
      if (input.kind === 'intent' && !drained) { drained = true; f.control('drain'); }
      return original(directory, input, options);
    });
    const release = vi.spyOn(locks, 'releaseLocalStoreLock');
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.status).toBe('drained');
    expect(hooks.run).not.toHaveBeenCalled();
    expect(f.events().some((row) => row.kind === 'intent')).toBe(false);
    expect(release).toHaveBeenCalledWith(f.executionLock);
  });

  it('latches drain for this invocation even when resume arrives after acknowledgement before return', async () => {
    const f = fixture(); hooks.acquire.mockReturnValue({ state: 'contended', lock: null });
    const original = store.appendPortfolioControllerEvent;
    vi.spyOn(store, 'appendPortfolioControllerEvent').mockImplementation((directory, input, options) => {
      const result = original(directory, input, options);
      if (input.kind === 'drained') f.control('resume', input.drainSequence);
      return result;
    });
    const pending = runUniversePortfolioController(f.definition, f.options);
    f.control('drain');
    hooks.acquire.mockReturnValue({ state: 'acquired', lock: f.executionLock });
    expect(await pending).toMatchObject({ status: 'incomplete', control: { mode: 'open' } });
    expect(hooks.run).not.toHaveBeenCalled();
    expect(f.events().some((row) => row.kind === 'intent')).toBe(false);
  });

  it('acknowledges a new drain on already completed work without dispatching or changing completion', async () => {
    const f = fixture();
    const completed = await runUniversePortfolioController(f.definition, f.options);
    const request = f.control('drain');
    const drained = await runUniversePortfolioController(f.definition, f.options);
    expect(drained).toMatchObject({ status: 'completed', deadlineAt: completed.deadlineAt,
      control: { sequence: request.sequence, acknowledgedAt: expect.any(String) } });
    expect(hooks.run).toHaveBeenCalledTimes(2);
    expect(() => f.control('resume', request.sequence)).not.toThrow();
  });

  it('acknowledges an expired pristine drain without renewing its deadline or admitting work', async () => {
    const f = fixture(); f.definition.maxDurationMs = 50;
    for (const readiness of f.readiness.values()) readiness.resourceRuntimeRequired = true;
    const first = await runUniversePortfolioController(f.definition, f.options);
    f.control('drain');
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    const expired = await runUniversePortfolioController(f.definition, f.options);
    expect(expired).toMatchObject({ status: 'timed-out', deadlineAt: first.deadlineAt,
      control: { mode: 'drain', acknowledgedAt: expect.any(String) } });
    expect(hooks.run).not.toHaveBeenCalled();
    expect(f.events().some((row) => row.kind === 'intent')).toBe(false);
  });

  it('waits for a live short transaction during settlement without aborting admitted work', async () => {
    const f = fixture(); const started = deferred<AbortSignal>(); const complete = deferred<UniverseCampaignSummary>();
    hooks.run.mockImplementationOnce((_id: string, options: { signal: AbortSignal }) => { started.resolve(options.signal); return complete.promise; });
    const pending = runUniversePortfolioController(f.definition, f.options);
    const signal = await started.promise;
    const request = f.control('drain');
    const acquired = locks.acquireLocalStoreLockWithOutcome(join(f.directory, '.control.lock'), 0,
      { anchorPath: f.directory, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') throw new Error('Could not hold fixture transaction');
    try {
      complete.resolve(f.finish('a'));
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      expect(signal.aborted).toBe(false);
      expect(hooks.run).toHaveBeenCalledOnce();
    } finally { expect(locks.releaseLocalStoreLock(acquired.lock)).toBe(true); }
    expect(await pending).toMatchObject({ status: 'drained', control: { sequence: request.sequence, acknowledgedAt: expect.any(String) } });
  });

  it.each(['cancelled', 'timed-out'] as const)('%s bounds live transaction waiting at final admission without consuming an intent', async (expectedStatus) => {
    const f = fixture();
    if (expectedStatus === 'timed-out') f.definition.maxDurationMs = 2_000;
    const caller = new AbortController();
    const entered = deferred<void>();
    let transactionLock: locks.LocalStoreLock | undefined;
    const original = store.appendPortfolioControllerEvent;
    vi.spyOn(store, 'appendPortfolioControllerEvent').mockImplementation((directory, input, options) => {
      if (input.kind === 'intent' && !transactionLock) {
        const acquired = locks.acquireLocalStoreLockWithOutcome(join(f.directory, '.control.lock'), 0,
          { anchorPath: f.directory, exactPrivateStorage: true });
        if (acquired.state !== 'acquired') throw new Error('Could not hold fixture admission transaction');
        transactionLock = acquired.lock;
        entered.resolve();
      }
      return original(directory, input, options);
    });
    const release = vi.spyOn(locks, 'releaseLocalStoreLock');
    const pending = runUniversePortfolioController(f.definition, { ...f.options, signal: caller.signal });
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Controller returned before admission contention'); })]);
      const before = f.events();
      const originalDeadline = readUniversePortfolioController(f.definition.id, f.options).deadlineAt;
      const stoppedAt = performance.now();
      if (expectedStatus === 'cancelled') caller.abort();
      const result = await pending;
      expect(result).toMatchObject({ status: expectedStatus, sourceState: 'healthy', deadlineAt: originalDeadline });
      expect(result.reasons).toContain('controller-transaction-wait-exhausted');
      expect(performance.now() - stoppedAt).toBeLessThan(expectedStatus === 'cancelled' ? 1_500 : 4_000);
      expect(result.outcomes.every((row) => row.state === 'pending' && !row.attempted)).toBe(true);
      expect(f.events()).toEqual(before);
      expect(f.events().some((row) => row.kind === 'intent')).toBe(false);
      expect(hooks.run).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(f.executionLock);
      expect(existsSync(join(f.directory, '.execution.lock'))).toBe(false);
      expect(transactionLock && locks.ownsLocalStoreLock(transactionLock)).toBe(true);
    } finally {
      caller.abort();
      if (transactionLock) expect(locks.releaseLocalStoreLock(transactionLock)).toBe(true);
      await pending;
    }
  });
});
