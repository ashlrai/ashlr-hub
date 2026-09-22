/** Real immutable controller records/lease; kernel grant and subordinate effects are inert seams. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as graph from '../src/core/universe/control-graph.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import * as immutable from '../src/core/util/immutable-private-record-store.js';
import * as recovery from '../src/core/universe/controller-lock-recovery.js';
import { appendPortfolioControllerEvent, portfolioControllerDirectory, readPortfolioControllerEvents,
  requestUniversePortfolioControllerControl } from '../src/core/universe/portfolio-controller-store.js';
import type { PortfolioControllerGraphDispatch, PortfolioControllerPin } from '../src/core/universe/portfolio-controller-types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
const hooks = vi.hoisted(() => ({ readiness: vi.fn(), proof: vi.fn(), receipt: vi.fn(), run: vi.fn(),
  plan: vi.fn(), deliver: vi.fn(), deliveries: vi.fn(), acquire: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.readiness }));
vi.mock('../src/core/universe/campaign-dispatch.js', () => ({ readCompletedUniverseCampaignDispatch: hooks.proof }));
vi.mock('../src/core/universe/campaign-delivery-recovery.js', () => ({ readCompletedCampaignDelivery: hooks.receipt }));
vi.mock('../src/core/universe/campaign.js', async original => ({ ...await original<object>(), runUniverseCampaignOwned: hooks.run }));
vi.mock('../src/core/universe/execution.js', async original => ({ ...await original<object>(), acquireUniverseExecution: hooks.acquire }));
vi.mock('../src/core/universe/portfolio-plan.js', async original => ({ ...await original<object>(), readUniversePortfolioPlan: hooks.plan }));
vi.mock('../src/core/universe/campaign-delivery.js', async original => ({ ...await original<object>(), deliverCompletedUniverseCampaign: hooks.deliver }));
vi.mock('../src/core/universe/delivery.js', async original => ({ ...await original<object>(), readUniverseDeliveries: hooks.deliveries }));
import { continueGraphOwnedPortfolioController, runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';

const roots: string[] = [];
const HASH = 'a'.repeat(64), RECORDS = 'b'.repeat(64), FINAL = 'c'.repeat(64);
beforeEach(() => { for (const hook of Object.values(hooks)) hook.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporary() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'controller-pending-'))); roots.push(root); return root; }
function fixture(options: { expired?: boolean; held?: boolean; unlinked?: boolean; unknownB?: boolean } = {}) {
  const root = temporary(); const directory = portfolioControllerDirectory('controller', { root });
  mkdirSync(join(root, 'portfolios'), { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'controller', maxParallel: 1, maxDurationMs: 60_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }, { campaignId: 'campaign-b', dependsOn: ['campaign-a'] }] };
  const link: PortfolioControllerGraphDispatch = { schemaVersion: 1, graphRootDigest: HASH, graphId: 'graph',
    definitionDigest: HASH, nodeId: 'deliver', intentDigest: HASH };
  const deliveryPlan = { schemaVersion: 1 as const, deliveries: ['a', 'b'].map(id => ({ campaignId: `campaign-${id}`,
    branch: `codex/${id}`, baseCommit: 'a'.repeat(40) })) };
  const summaries = new Map(['a', 'b'].map(id => [`campaign-${id}`, { fixtureId: id, state: 'ready' } as unknown as UniverseCampaignSummary]));
  const pins: PortfolioControllerPin[] = ['a', 'b'].map(id => ({ campaignId: `campaign-${id}`, universeId: `universe-${id}`,
    definitionDigest: HASH, manifestDigest: HASH, comparatorDigest: HASH,
    campaignDigest: digest(canonical(summaries.get(`campaign-${id}`))), recordsDigest: RECORDS,
    initialState: options.held && id === 'b' ? 'held' : 'pending',
    dispatch: options.held && id === 'b' ? 'none' : 'campaign', reasonCode: 'never-dispatched' }));
  const readiness = new Map<string, UniverseCampaignReadiness>(pins.map(pin => [pin.campaignId, {
    schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: pin.campaignId, universeId: pin.universeId,
    sourceState: 'healthy', observedState: 'ready', disposition: 'startable', reasonCode: 'never-started',
    automaticAction: 'run', resourceRuntimeRequired: false, recordsDigest: RECORDS, sampledAt: new Date().toISOString(),
    expectedIdentity: { universeId: pin.universeId, definitionDigest: HASH, manifestDigest: HASH,
      comparatorDigest: HASH, summaryDigest: pin.campaignDigest },
  }]));
  const started = Date.now() - (options.expired ? 61_000 : 100);
  const deadlineAt = new Date(started + definition.maxDurationMs).toISOString();
  appendPortfolioControllerEvent(directory, { kind: 'created', at: new Date(started).toISOString(), enrollment: {
    definition, definitionDigest: digest(canonical(definition)), deliveryPlan, pins, deadlineAt,
    ...(options.unlinked ? {} : { graphDispatch: link }),
  } });
  appendPortfolioControllerEvent(directory, { kind: 'intent', at: new Date(started + 1).toISOString(), campaignId: 'campaign-a',
    dispatchId: '11111111-1111-4111-8111-111111111111' });
  const receipts = new Map(['a', 'b'].map(id => [`campaign-${id}`, { status: 'delivered', universeId: `universe-${id}`,
    branch: `codex/${id}`, baseCommit: 'a'.repeat(40) }]));
  const finish = (id: string) => {
    const summary = { fixtureId: id.at(-1), state: 'completed' } as unknown as UniverseCampaignSummary;
    summaries.set(id, summary); const old = readiness.get(id)!;
    readiness.set(id, { ...old, observedState: 'completed', disposition: 'terminal', reasonCode: 'campaign-completed',
      automaticAction: 'none', recordsDigest: FINAL, expectedIdentity: { ...old.expectedIdentity!, summaryDigest: digest(canonical(summary)) } });
    return structuredClone(summary);
  };
  finish('campaign-a');
  if (options.unknownB) {
    appendPortfolioControllerEvent(directory, { kind: 'settled', at: new Date(started + 2).toISOString(), recordsDigest: FINAL,
      outcome: { campaignId: 'campaign-a', state: 'completed', attempted: true, reasonCode: 'completed-dispatch-reconciled',
        campaignDigest: digest(canonical(summaries.get('campaign-a'))), deliveryDigest: digest(canonical(receipts.get('campaign-a'))) } });
    appendPortfolioControllerEvent(directory, { kind: 'intent', at: new Date(started + 3).toISOString(), campaignId: 'campaign-b',
      dispatchId: '22222222-2222-4222-8222-222222222222' });
  }
  hooks.readiness.mockImplementation(id => structuredClone(readiness.get(id)));
  hooks.proof.mockImplementation(id => id === 'campaign-a' ? { campaign: summaries.get(id), recordsDigest: FINAL } : null);
  hooks.receipt.mockImplementation(summary => receipts.get(`campaign-${summary.fixtureId}`));
  hooks.deliveries.mockImplementation(id => ({ sourceState: 'healthy', deliveries: [receipts.get(`campaign-${id.at(-1)}`)] }));
  hooks.plan.mockReturnValue({ sourceState: 'healthy', topologicalOrder: ['campaign-a', 'campaign-b'] });
  hooks.run.mockImplementation(async id => {
    expect(existsSync(join(directory, '.execution.lock'))).toBe(true);
    return finish(id);
  });
  hooks.deliver.mockImplementation(async id => ({ campaign: summaries.get(id), delivery: { status: 'delivered', receipt: receipts.get(id) } }));
  const executionLock = { path: '/synthetic/universe-execution.lock', token: 'fixture', dev: 1n, ino: 1n };
  const owns = locks.ownsLocalStoreLock;
  vi.spyOn(locks, 'ownsLocalStoreLock').mockImplementation(lock => lock === executionLock || owns(lock));
  hooks.acquire.mockReturnValue({ state: 'acquired', lock: executionLock });
  const context = Object.freeze({ fixture: 'kernel-context' }); const abort = new AbortController();
  const authority = { graphDispatch: link, signal: abort.signal, deadlineMonotonicMs: performance.now() + 60_000,
    isExecutionStopped: vi.fn(() => false) };
  const grant = vi.spyOn(graph, 'readGraphContinuationAuthority').mockImplementation((value, binding) =>
    value === context && binding === HASH ? authority : null);
  const runOptions = { root, deliveryPlan };
  return { root, directory, definition, link, context, authority, grant, abort, readiness, deadlineAt,
    options: runOptions, events: () => readPortfolioControllerEvents(directory),
    run: () => continueGraphOwnedPortfolioController(definition, runOptions, context, HASH) };
}

describe('existing graph-owned pending campaign continuation', () => {
  it('acknowledges A then dispatches B once under one controller lease without renewing enrollment', async () => {
    const f = fixture(); const before = f.events(); const acquire = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome');
    const report = await f.run();
    expect(report).toMatchObject({ status: 'completed', sourceState: 'healthy', deadlineAt: f.deadlineAt });
    expect(f.events().slice(0, before.length)).toEqual(before);
    expect(f.events().slice(before.length).map(row => row.kind)).toEqual(['settled', 'observed', 'intent', 'settled']);
    expect(acquire.mock.calls.filter(([path]) => path === join(f.directory, '.execution.lock'))).toHaveLength(1);
    expect(hooks.run).toHaveBeenCalledOnce(); expect(hooks.run.mock.calls[0]?.[0]).toBe('campaign-b');
    expect(hooks.deliver).toHaveBeenCalledOnce();
    const settled = f.events(); expect((await f.run()).status).toBe('completed');
    expect(f.events()).toEqual(settled); expect(hooks.run).toHaveBeenCalledOnce();
  });
  it.each(['copied-context', 'binding', 'revoked'] as const)('refuses %s without reading options or writing records', async kind => {
    const f = fixture(); const before = f.events(); const getter = vi.fn(() => { throw new Error('must not read'); });
    const options = Object.defineProperty({}, 'root', { enumerable: true, get: getter });
    if (kind === 'revoked') f.grant.mockReturnValue(null);
    await expect(continueGraphOwnedPortfolioController(f.definition, options,
      kind === 'copied-context' ? { ...f.context } : f.context, kind === 'binding' ? 'f'.repeat(64) : HASH)).rejects.toThrow('authority');
    expect(getter).not.toHaveBeenCalled(); expect(f.events()).toEqual(before); expect(hooks.proof).not.toHaveBeenCalled();
  });
  it('never creates missing enrollment or parent directories', async () => {
    const f = fixture(); const root = temporary();
    await expect(continueGraphOwnedPortfolioController(f.definition, { ...f.options, root }, f.context, HASH)).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]); expect(hooks.run).not.toHaveBeenCalled();
  });
  it.each([false, true])('does not repair unreadable writer ownership before proving linkage (foreign=%s)', async foreign => {
    const f = fixture(); const repair = vi.spyOn(recovery, 'recoverControllerRecordLock');
    const records = join(f.directory, 'ledger', 'records');
    const bytes = readdirSync(records).sort().map(name => readFileSync(join(records, name), 'utf8'));
    const mutex = join(f.directory, 'ledger', '.records.lock');
    writeFileSync(mutex, 'unreadable fixture mutex', { mode: 0o600 });
    if (foreign) f.authority.graphDispatch = { ...f.link, intentDigest: 'f'.repeat(64) };
    await expect(f.run()).rejects.toThrow('evidence');
    expect(repair).not.toHaveBeenCalled(); expect(readFileSync(mutex, 'utf8')).toBe('unreadable fixture mutex');
    expect(readdirSync(records).sort().map(name => readFileSync(join(records, name), 'utf8'))).toEqual(bytes);
    expect(hooks.proof).not.toHaveBeenCalled(); expect(hooks.run).not.toHaveBeenCalled();
  });
  it.each(['graphRootDigest', 'intentDigest'] as const)('refuses a mismatched %s without acknowledgment', async key => {
    const f = fixture(); const before = f.events(); f.authority.graphDispatch = { ...f.link, [key]: 'f'.repeat(64) };
    await expect(f.run()).rejects.toThrow('enrollment differs'); expect(f.events()).toEqual(before); expect(hooks.proof).not.toHaveBeenCalled();
  });
  it('refuses legacy unlinked enrollment', async () => {
    const unlinked = fixture({ unlinked: true }); const before = unlinked.events();
    await expect(unlinked.run()).rejects.toThrow('enrollment differs'); expect(unlinked.events()).toEqual(before);
    expect(hooks.run).not.toHaveBeenCalled();
  });
  it('preserves ordinary linked standalone execution refusal', async () => {
    const linked = fixture(); const linkedBefore = linked.events();
    await expect(runUniversePortfolioController(linked.definition, linked.options)).rejects.toThrow('cannot resume');
    expect(linked.events()).toEqual(linkedBefore); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('holds unknown descendant intent without replay or metadata changes', async () => {
    const f = fixture({ unknownB: true }); const before = f.events();
    await expect(f.run()).rejects.toThrow('campaign unavailable'); expect(f.events()).toEqual(before);
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });
  it('does not turn held work into pending work', async () => {
    const f = fixture({ held: true }); const before = f.events();
    await expect(f.run()).rejects.toThrow('untouched pending'); expect(f.events()).toEqual(before); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('acknowledges an expired child but never launches its pending descendant', async () => {
    const f = fixture({ expired: true }); const before = f.events();
    expect(await f.run()).toMatchObject({ status: 'timed-out', deadlineAt: f.deadlineAt });
    expect(f.events().slice(before.length).map(row => row.kind)).toEqual(['settled']);
    expect(hooks.run).not.toHaveBeenCalled(); expect(hooks.acquire).not.toHaveBeenCalled();
  });
  it('honors drain while acknowledging completed effects', async () => {
    const f = fixture(); requestUniversePortfolioControllerControl('controller', 'drain', { root: f.root });
    expect(await f.run()).toMatchObject({ status: 'drained', control: { mode: 'drain', acknowledgedAt: expect.any(String) } });
    expect(hooks.run).not.toHaveBeenCalled(); expect(f.events().filter(row => row.kind === 'intent')).toHaveLength(1);
  });
  it('rejects pending campaign evidence drift without admitting a new intent', async () => {
    const f = fixture(); const before = f.events(); f.readiness.get('campaign-b')!.recordsDigest = 'f'.repeat(64);
    expect(await f.run()).toMatchObject({ status: 'unavailable', sourceState: 'degraded' });
    expect(f.events()).toEqual(before); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('rechecks parent authority at final acknowledgment publication', async () => {
    const f = fixture(); const before = f.events(); let staged = 0;
    f.authority.isExecutionStopped.mockImplementation(() => {
      if (readdirSync(join(f.directory, 'ledger', 'staging')).length === 0) return false;
      staged++; return true;
    });
    await expect(f.run()).rejects.toThrow(); expect(staged).toBeGreaterThan(0); expect(f.events()).toEqual(before);
    expect(hooks.run).not.toHaveBeenCalled();
  });
  it('does not dispatch when parent stop changes after the upstream acknowledgment', async () => {
    const f = fixture(); const write = immutable.writeImmutablePrivateRecord;
    vi.spyOn(immutable, 'writeImmutablePrivateRecord').mockImplementation((config, event, options) => {
      const result = write(config, event, options);
      if ((event as { kind?: string }).kind === 'settled') f.authority.isExecutionStopped.mockReturnValue(true);
      return result;
    });
    await expect(f.run()).rejects.toThrow('stopped');
    expect(f.events().map(row => row.kind)).toEqual(['created', 'intent', 'settled']); expect(hooks.run).not.toHaveBeenCalled();
  });
});
