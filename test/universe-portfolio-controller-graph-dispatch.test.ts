/** Real private controller storage; campaign projections and execution are inert fixtures. */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { PortfolioControllerGraphDispatch } from '../src/core/universe/portfolio-controller-types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
const hooks = vi.hoisted(() => ({ readiness: vi.fn(), plan: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.readiness }));
vi.mock('../src/core/universe/portfolio-plan.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/portfolio-plan.js')>(), readUniversePortfolioPlan: hooks.plan,
}));
vi.mock('../src/core/universe/campaign.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign.js')>(), runUniverseCampaignOwned: hooks.run,
}));
import { runUniversePortfolioController, readUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { foldPortfolioController, portfolioControllerDirectory, readPortfolioControllerEvents,
  validatePortfolioControllerGraphDispatch } from '../src/core/universe/portfolio-controller-store.js';

const roots: string[] = [];
const link = (): PortfolioControllerGraphDispatch => ({ schemaVersion: 1, graphRootDigest: 'a'.repeat(64),
  graphId: 'Graph-A', definitionDigest: 'b'.repeat(64), nodeId: 'Deliver_1', intentDigest: 'c'.repeat(64) });
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(state: 'ready' | 'completed' = 'completed') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'controller-graph-link-'))); roots.push(root);
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'linked-controller',
    tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 10_000 };
  const campaign = { fixtureId: 'campaign', state };
  hooks.plan.mockReturnValue({ sourceState: 'healthy', nodes: [{ campaignId: 'campaign', campaign }] });
  hooks.readiness.mockReturnValue({ sourceState: 'healthy', observedState: state, disposition: state === 'completed' ? 'terminal' : 'startable',
    automaticAction: state === 'completed' ? 'none' : 'run', reasonCode: state === 'completed' ? 'campaign-completed' : 'never-started', recordsDigest: 'd'.repeat(64),
    expectedIdentity: { universeId: 'fixture-universe', definitionDigest: 'e'.repeat(64), manifestDigest: 'f'.repeat(64),
      comparatorDigest: '0'.repeat(64), summaryDigest: digest(canonical(campaign)) } });
  return { root, definition,
    events: () => readPortfolioControllerEvents(portfolioControllerDirectory(definition.id, { root })) };
}

describe('controller graph dispatch association', () => {
  it('strictly validates and detaches mixed-case graph/node linkage', () => {
    const source = link(); const value = validatePortfolioControllerGraphDispatch(source);
    expect(value).toEqual(source); source.intentDigest = 'd'.repeat(64);
    expect(value.intentDigest).toBe('c'.repeat(64));
  });
  it.each([
    { value: null }, { value: [] }, { value: {} }, { value: { ...link(), schemaVersion: 2 } },
    { value: { ...link(), graphRootDigest: 'not-a-hash' } }, { value: { ...link(), definitionDigest: 'B'.repeat(64) } },
    { value: { ...link(), graphId: '../graph' } }, { value: { ...link(), nodeId: '' } },
    { value: { ...link(), intentDigest: null } }, { value: { ...link(), authority: true } },
  ])('refuses nonclosed or malformed linkage %#', ({ value }) => {
    expect(() => validatePortfolioControllerGraphDispatch(value)).toThrow('Invalid controller graph dispatch');
  });
  it('never invokes field getters during validation', () => {
    let invoked = 0; const value = { ...link(), get intentDigest() { invoked++; return 'c'.repeat(64); } };
    expect(() => validatePortfolioControllerGraphDispatch(value)).toThrow(); expect(invoked).toBe(0);
  });
  it('stores linkage only in the immutable created enrollment and snapshots caller mutations', async () => {
    const f = fixture(); const value = link();
    const pending = runUniversePortfolioController(f.definition, { root: f.root, requireNewEnrollment: true, graphDispatch: value });
    value.graphRootDigest = 'd'.repeat(64); expect((await pending).status).toBe('completed');
    const created = f.events()[0]!; expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('Expected creation');
    expect(created.enrollment.graphDispatch).toEqual(link());
    expect(f.events().slice(1).every((event) => !Object.hasOwn(event, 'graphDispatch'))).toBe(true);
    expect(readUniversePortfolioController(f.definition.id, { root: f.root }).sourceState).toBe('healthy');
    expect(hooks.run).not.toHaveBeenCalled();
  });
  it('refuses exact linked completed-controller reentry while pure inspection remains available', async () => {
    const f = fixture(); await runUniversePortfolioController(f.definition, { root: f.root, requireNewEnrollment: true, graphDispatch: link() });
    const before = canonical(f.events());
    await expect(runUniversePortfolioController(f.definition, { root: f.root, graphDispatch: link() })).rejects.toThrow('receipt-only');
    expect(readUniversePortfolioController(f.definition.id, { root: f.root }).status).toBe('completed');
    expect(canonical(f.events())).toBe(before); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('preserves omitted and explicitly undefined legacy fresh-enrollment options', async () => {
    const f = fixture(); expect((await runUniversePortfolioController(f.definition,
      { root: f.root, requireNewEnrollment: undefined })).status).toBe('completed');
    const first = f.events()[0]!; if (first.kind !== 'created') throw new Error('Expected creation');
    expect(first.enrollment).not.toHaveProperty('graphDispatch');
    expect(hooks.run).not.toHaveBeenCalled();
  });
  it.each([false, true])('reclaims a dead record writer before strict reading, without authorizing linked reentry: %s', async (linked) => {
    const f = fixture();
    await runUniversePortfolioController(f.definition, { root: f.root,
      ...(linked ? { requireNewEnrollment: true, graphDispatch: link() } : {}) });
    const before = canonical(f.events());
    const directory = portfolioControllerDirectory(f.definition.id, { root: f.root });
    const lockPath = join(directory, 'ledger', '.records.lock');
    // A real child acquires the production mutex and exits without releasing it.
    // No fabricated PID/start-reference or mocked ownership/recovery is involved.
    const moduleUrl = new URL('../src/core/fleet/local-store-lock.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      `import { acquireLocalStoreLockWithOutcome } from ${JSON.stringify(moduleUrl)};
       const result = acquireLocalStoreLockWithOutcome(${JSON.stringify(lockPath)}, 0,
         { anchorPath: ${JSON.stringify(directory)}, exactPrivateStorage: true });
       if (result.state !== 'acquired') process.exit(1);`],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 });
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(lockPath)).toBe(true);
    expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => f.events()).toThrow();
    const resumed = runUniversePortfolioController(f.definition, { root: f.root });
    if (linked) await expect(resumed).rejects.toThrow('receipt-only');
    else expect((await resumed).status).toBe('completed');
    expect(existsSync(lockPath)).toBe(false);
    expect(canonical(f.events())).toBe(before);
    expect(hooks.run).not.toHaveBeenCalled();
  });
  it.each(['graphRootDigest', 'intentDigest', 'definitionDigest', 'graphId', 'nodeId'] as const)('refuses a changed %s with no new records or dispatch', async (field) => {
    const f = fixture(); await runUniversePortfolioController(f.definition, { root: f.root, requireNewEnrollment: true, graphDispatch: link() });
    const before = canonical(f.events()); const changed = { ...link(), [field]: field.endsWith('Digest') ? 'd'.repeat(64) : 'Other' };
    await expect(runUniversePortfolioController(f.definition, { root: f.root, graphDispatch: changed })).rejects.toThrow('receipt-only');
    expect(canonical(f.events())).toBe(before); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('refuses an unlinked caller for a linked controller without changing its history', async () => {
    const f = fixture(); await runUniversePortfolioController(f.definition, { root: f.root, requireNewEnrollment: true, graphDispatch: link() });
    const before = canonical(f.events());
    await expect(runUniversePortfolioController(f.definition, { root: f.root })).rejects.toThrow('receipt-only');
    expect(canonical(f.events())).toBe(before); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('keeps legacy enrollment absent and never backfills a graph association', async () => {
    const f = fixture(); expect((await runUniversePortfolioController(f.definition, { root: f.root })).status).toBe('completed');
    const first = f.events()[0]!; if (first.kind !== 'created') throw new Error('Expected creation');
    expect(first.enrollment).not.toHaveProperty('graphDispatch');
    const before = canonical(f.events());
    await expect(runUniversePortfolioController(f.definition, { root: f.root, requireNewEnrollment: true, graphDispatch: link() })).rejects.toThrow('new controller enrollment');
    expect(canonical(f.events())).toBe(before);
    expect((await runUniversePortfolioController(f.definition, { root: f.root })).status).toBe('completed');
    expect(hooks.run).not.toHaveBeenCalled();
  });
  it('cannot launch a pending linked controller with a copied link but no original graph deadline or owner guard', async () => {
    const f = fixture('ready');
    const initial = await runUniversePortfolioController(f.definition, { root: f.root, requireNewEnrollment: true,
      graphDispatch: link(), isExecutionStopped: () => true });
    expect(initial.outcomes[0]!.state).toBe('pending'); const before = canonical(f.events());
    await expect(runUniversePortfolioController(f.definition, { root: f.root, graphDispatch: link() })).rejects.toThrow('receipt-only');
    await expect(runUniversePortfolioController(f.definition, { root: f.root })).rejects.toThrow('receipt-only');
    await expect(runUniversePortfolioController(f.definition, { root: f.root, graphDispatch: link(), requireNewEnrollment: true }))
      .rejects.toThrow('new controller enrollment');
    expect(canonical(f.events())).toBe(before); expect(hooks.run).not.toHaveBeenCalled();
    expect(readUniversePortfolioController(f.definition.id, { root: f.root }).sourceState).toBe('healthy');
  });
  it('refuses a new linked controller without explicit fresh enrollment before creating storage', async () => {
    const f = fixture(); await expect(runUniversePortfolioController(f.definition, { root: f.root, graphDispatch: link() }))
      .rejects.toThrow('explicit fresh enrollment');
    expect(readdirSync(f.root)).toEqual([]); expect(hooks.plan).not.toHaveBeenCalled(); expect(hooks.run).not.toHaveBeenCalled();
  });
  it.each(['graphDispatch', 'requireNewEnrollment'] as const)('refuses a %s option getter before storage or callback effects', async (field) => {
    const f = fixture(); let invoked = 0; const options = { root: f.root, graphDispatch: link(), requireNewEnrollment: true };
    Object.defineProperty(options, field, { enumerable: true, get() { invoked++; return field === 'graphDispatch' ? link() : true; } });
    await expect(runUniversePortfolioController(f.definition, options)).rejects.toThrow('Invalid controller');
    expect(invoked).toBe(0); expect(readdirSync(f.root)).toEqual([]); expect(hooks.plan).not.toHaveBeenCalled();
  });
  it('refuses inherited association without evaluating an inherited getter', async () => {
    const f = fixture(); let invoked = 0;
    const options = Object.assign(Object.create({ get graphDispatch() { invoked++; return link(); } }), { root: f.root });
    await expect(runUniversePortfolioController(f.definition, options)).rejects.toThrow('Invalid controller graph dispatch option');
    expect(invoked).toBe(0); expect(readdirSync(f.root)).toEqual([]);
  });
  it('fails closed when persisted linkage is malformed while legacy records still fold', async () => {
    const f = fixture(); await runUniversePortfolioController(f.definition, { root: f.root, requireNewEnrollment: true, graphDispatch: link() });
    const records = f.events(); const created = records[0]!; if (created.kind !== 'created') throw new Error('Expected creation');
    Object.assign(created.enrollment.graphDispatch!, { extra: 'not-accepted' });
    expect(() => foldPortfolioController(records)).toThrow('history is invalid');
    // Absence is valid legacy syntax, not proof of association with any graph.
    delete created.enrollment.graphDispatch;
    expect(() => foldPortfolioController(records)).not.toThrow();
  });
});
