/** Real private metadata/locks; subordinate proof values are deliberately inert. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { appendPortfolioControllerEvent, portfolioControllerDirectory, readPortfolioControllerEvents } from '../src/core/universe/portfolio-controller-store.js';
import type { PortfolioControllerGraphDispatch } from '../src/core/universe/portfolio-controller-types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import * as engineering from '../src/core/universe/firm-engineering-control-handler.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import { runControlGraph, type ControlGraphDefinition } from '../src/core/universe/control-graph.js';
const hooks = vi.hoisted(() => ({ proof: vi.fn(), delivery: vi.fn(), readiness: vi.fn(), deliveries: vi.fn() }));
vi.mock('../src/core/universe/campaign-dispatch.js', () => ({ readCompletedUniverseCampaignDispatch: hooks.proof }));
vi.mock('../src/core/universe/campaign-delivery-recovery.js', () => ({ readCompletedCampaignDelivery: hooks.delivery }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.readiness }));
vi.mock('../src/core/universe/delivery.js', async original => ({ ...await original<object>(), readUniverseDeliveries: hooks.deliveries }));
import { reconcileGraphControllerDispatch } from '../src/core/universe/graph-controller-reconciliation.js';

const roots: string[] = [];
const HASH = 'a'.repeat(64), RECORDS = 'b'.repeat(64), FINAL = 'c'.repeat(64);
beforeEach(() => { for (const hook of Object.values(hooks)) hook.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporary() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-controller-review-'))); roots.push(root); return root; }
function fixture() {
  const root = temporary(); const directory = portfolioControllerDirectory('controller', { root });
  mkdirSync(join(root, 'portfolios'), { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'controller',
    tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 1_000 };
  const graphDispatch: PortfolioControllerGraphDispatch = { schemaVersion: 1, graphRootDigest: HASH,
    graphId: 'graph', definitionDigest: HASH, nodeId: 'deliver', intentDigest: HASH };
  const deliveryPlan = { schemaVersion: 1 as const, deliveries: [{ campaignId: 'campaign', branch: 'codex/fixture', baseCommit: 'a'.repeat(40) }] };
  const pins = [{ campaignId: 'campaign', universeId: 'universe', definitionDigest: HASH, manifestDigest: HASH, comparatorDigest: HASH }];
  const started = Date.now() - 10_000; const deadlineAt = new Date(started + 1_000).toISOString();
  appendPortfolioControllerEvent(directory, { kind: 'created', at: new Date(started).toISOString(), enrollment: {
    definition, definitionDigest: digest(canonical(definition)), deliveryPlan, graphDispatch, deadlineAt,
    pins: [{ ...pins[0]!, campaignDigest: HASH, recordsDigest: RECORDS, initialState: 'pending', dispatch: 'campaign', reasonCode: 'never-dispatched' }],
  } });
  appendPortfolioControllerEvent(directory, { kind: 'intent', at: new Date(started + 1).toISOString(), campaignId: 'campaign',
    dispatchId: '11111111-1111-4111-8111-111111111111' });
  const campaign = { fixture: 'completed' }; const receipt = { status: 'delivered', branch: 'codex/fixture', baseCommit: 'a'.repeat(40) };
  hooks.proof.mockReturnValue({ campaign, recordsDigest: FINAL }); hooks.delivery.mockReturnValue(receipt);
  hooks.readiness.mockReturnValue({ sourceState: 'healthy', recordsDigest: FINAL, observedState: 'completed',
    expectedIdentity: { ...pins[0]!, summaryDigest: digest(canonical(campaign)) } });
  hooks.deliveries.mockReturnValue({ sourceState: 'healthy', deliveries: [receipt] });
  const options = { root, definition, deliveryPlan, graphDispatch, pins, checkEnrollment: vi.fn(),
    isExecutionStopped: vi.fn(() => false), deadlineMonotonicMs: performance.now() + 60_000 };
  return { directory, options, deadlineAt, events: () => readPortfolioControllerEvents(directory) };
}

describe('graph-owned receipt-only controller metadata gates', () => {
  it('acknowledges an expired child under a live parent without renewing the original deadline or duplicating records', () => {
    const f = fixture(); const before = f.events();
    expect(reconcileGraphControllerDispatch(f.options)).toMatchObject({ sourceState: 'healthy', status: 'completed', deadlineAt: f.deadlineAt });
    expect(f.events().slice(0, before.length)).toEqual(before);
    expect(f.events().slice(before.length).map(row => row.kind)).toEqual(['settled']);
    expect(hooks.proof).toHaveBeenCalledWith('campaign', expect.objectContaining({
      dispatchId: '11111111-1111-4111-8111-111111111111', recordsDigest: RECORDS,
    }), { root: f.options.root });
    const completed = f.events(); expect(reconcileGraphControllerDispatch(f.options)?.status).toBe('completed'); expect(f.events()).toEqual(completed);
  });
  it.each(['deadline', 'stop', 'throw'] as const)('leaves all metadata unchanged when the parent %s refuses', kind => {
    const f = fixture(); const before = f.events();
    if (kind === 'deadline') f.options.deadlineMonotonicMs = performance.now() - 1;
    else f.options.isExecutionStopped.mockImplementation(() => { if (kind === 'throw') throw new Error('fixture refusal'); return true; });
    expect(reconcileGraphControllerDispatch(f.options)).toBeNull(); expect(f.events()).toEqual(before); expect(hooks.proof).not.toHaveBeenCalled();
  });
  it.each(['graphRootDigest', 'graphId', 'definitionDigest', 'nodeId', 'intentDigest'] as const)('refuses a foreign %s before proof or publication', key => {
    const f = fixture(); const before = f.events();
    f.options.graphDispatch = { ...f.options.graphDispatch, [key]: key.endsWith('Digest') ? 'f'.repeat(64) : 'foreign' };
    expect(reconcileGraphControllerDispatch(f.options)).toBeNull(); expect(f.events()).toEqual(before); expect(hooks.proof).not.toHaveBeenCalled();
  });
  it.each(['stop', 'proof'] as const)('rechecks %s after actual staging immediately before publication', kind => {
    const f = fixture(); const before = f.events(); let finalChecks = 0;
    const staged = () => readdirSync(join(f.directory, 'ledger', 'staging')).length > 0;
    if (kind === 'stop') f.options.isExecutionStopped.mockImplementation(() => { if (!staged()) return false; finalChecks++; return true; });
    else hooks.delivery.mockImplementation(() => {
      if (staged()) { finalChecks++; return null; }
      return { status: 'delivered', branch: 'codex/fixture', baseCommit: 'a'.repeat(40) };
    });
    expect(reconcileGraphControllerDispatch(f.options)).toBeNull(); expect(finalChecks).toBeGreaterThan(0); expect(f.events()).toEqual(before);
  });
  it('withholds success on uncertain execution-lease release without undoing or duplicating durable settlement', () => {
    const f = fixture(); const originalRelease = locks.releaseLocalStoreLock;
    const release = vi.spyOn(locks, 'releaseLocalStoreLock').mockImplementation(lock => {
      const released = originalRelease(lock);
      return lock?.path === join(f.directory, '.execution.lock') ? false : released;
    });
    expect(reconcileGraphControllerDispatch(f.options)).toBeNull();
    expect(f.events().map(row => row.kind)).toEqual(['created', 'intent', 'settled']);
    release.mockRestore(); const settled = f.events();
    expect(reconcileGraphControllerDispatch(f.options)?.status).toBe('completed'); expect(f.events()).toEqual(settled);
  });
});

describe('terminal graph history remains terminal', () => {
  it('never invokes new receipt recovery or execution for an already rejected engineering node', async () => {
    const root = temporary(); const traceKeys = { testKey: Buffer.alloc(32, 19) };
    const run = vi.fn(async () => ({ artifact: 'original-rejection', outcome: 'rejected' as const,
      verifier: { id: 'fixture', verdict: 'fail' as const, independent: true } }));
    const recover = vi.fn(() => ({ artifact: 'must-not-adopt', outcome: 'completed' as const,
      verifier: { id: 'fixture', verdict: 'pass' as const, independent: true } }));
    const handler = { effectClass: 'engineering-portfolio-local-delivery' as const,
      constitutionVersion: 'fixture', policyEpoch: 1, bindingDigest: HASH, run };
    // Inject registration only: this tests kernel state selection, not delivery proof.
    vi.spyOn(engineering, 'isFirmEngineeringControlHandler').mockImplementation(value => value === handler);
    vi.spyOn(engineering, 'firmEngineeringControlRecovery').mockImplementation(value => value === handler ? recover : undefined);
    const graph: ControlGraphDefinition = { schemaVersion: 1, id: 'terminal-rejection', maxConcurrent: 1, maxDurationMs: 60_000,
      nodes: [{ id: 'deliver', kind: 'deliver', requires: [], input: { bindingDigest: HASH, requestDigest: HASH } }] };
    const options = { root, traceKeys, handlers: { deliver: handler } };
    expect((await runControlGraph(graph, options)).nodes[0]?.state).toBe('rejected');
    const records = () => readdirSync(join(root, 'control-graph', 'records')).sort().map(name => readFileSync(join(root, 'control-graph', 'records', name), 'utf8'));
    const before = records();
    expect((await runControlGraph(graph, options)).nodes[0]?.state).toBe('rejected');
    expect(records()).toEqual(before); expect(run).toHaveBeenCalledOnce(); expect(recover).not.toHaveBeenCalled();
  });
});
