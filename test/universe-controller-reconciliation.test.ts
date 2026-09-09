import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import { appendPortfolioControllerEvent, foldPortfolioController, portfolioControllerDirectory,
  readPortfolioControllerEvents } from '../src/core/universe/portfolio-controller-store.js';
import * as records from '../src/core/util/immutable-private-record-store.js';

const hooks = vi.hoisted(() => ({ readiness: vi.fn(), run: vi.fn(), campaign: vi.fn(), plan: vi.fn(),
  proof: vi.fn(), deliveryProof: vi.fn(), preflight: vi.fn(), deliver: vi.fn(), deliveries: vi.fn(), universe: vi.fn(), manifest: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.readiness }));
vi.mock('../src/core/universe/campaign-dispatch.js', () => ({ readCompletedUniverseCampaignDispatch: hooks.proof }));
vi.mock('../src/core/universe/campaign-delivery-recovery.js', () => ({ readCompletedCampaignDelivery: hooks.deliveryProof }));
vi.mock('../src/core/universe/campaign.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign.js')>(), runUniverseCampaignOwned: hooks.run,
}));
vi.mock('../src/core/universe/campaign-store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(), readUniverseCampaign: hooks.campaign, campaignUniverse: hooks.universe,
}));
vi.mock('../src/core/universe/store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/store.js')>(), manifestRecord: hooks.manifest,
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
const INITIAL = 'b'.repeat(64);
const FINAL = 'c'.repeat(64);
const UUID = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { for (const hook of Object.values(hooks)) hook.mockReset(); hooks.proof.mockReturnValue(null); hooks.deliveryProof.mockReturnValue(null); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

// Campaign execution/projections are synthetic; controller ledger, leases and
// capacity accounting are real private IO. Native dispatch proof has its own suite.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'controller-reconciliation-'))); scratch.push(root);
  mkdirSync(join(root, 'universes'), { mode: 0o700 });
  mkdirSync(join(root, 'universes', 'universe-a'), { mode: 0o700 });
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'controller',
    tasks: [{ campaignId: 'a', dependsOn: [] }], maxParallel: 1, maxDurationMs: 10_000 };
  let campaign = { fixture: 'a', state: 'ready' } as unknown as UniverseCampaignSummary;
  let readiness: UniverseCampaignReadiness = { schemaVersion: 1, readinessScope: 'recorded-campaign-evidence',
    campaignId: 'a', universeId: 'universe-a', sourceState: 'healthy', observedState: 'ready', disposition: 'startable',
    reasonCode: 'never-started', automaticAction: 'run', resourceRuntimeRequired: false, recordsDigest: INITIAL,
    sampledAt: new Date().toISOString(), expectedIdentity: { universeId: 'universe-a', definitionDigest: HASH,
      manifestDigest: HASH, comparatorDigest: HASH, summaryDigest: digest(canonical(campaign)) } };
  hooks.readiness.mockImplementation(() => structuredClone(readiness));
  hooks.campaign.mockImplementation(() => structuredClone(campaign));
  hooks.plan.mockImplementation(() => ({ sourceState: 'healthy', definition, topologicalOrder: ['a'],
    nodes: [{ campaignId: 'a', campaign: structuredClone(campaign) }] }));
  hooks.preflight.mockImplementation(() => ({ repo: '/synthetic/repo', campaign: structuredClone(campaign) }));
  hooks.deliveries.mockReturnValue({ sourceState: 'healthy', deliveries: [] });
  hooks.run.mockRejectedValue(new Error('synthetic lost response'));
  const finish = () => {
    campaign = { fixture: 'a', state: 'completed' } as unknown as UniverseCampaignSummary;
    readiness = { ...readiness, observedState: 'completed', automaticAction: 'none', recordsDigest: FINAL,
      expectedIdentity: { ...readiness.expectedIdentity!, summaryDigest: digest(canonical(campaign)) } };
    return structuredClone(campaign);
  };
  const options = { root };
  const directory = portfolioControllerDirectory('controller', options);
  return { root, options, directory, definition, finish,
    events: () => readPortfolioControllerEvents(directory),
    requireRuntime: () => { readiness.resourceRuntimeRequired = true; } };
}

describe('Controller completed-dispatch recovery', () => {
  it('persists a UUID before execution and passes that exact identity to the runner', async () => {
    const f = fixture();
    hooks.run.mockImplementation(async (_id, options) => {
      const intent = f.events().at(-1)!;
      expect(intent).toMatchObject({ kind: 'intent', campaignId: 'a', dispatchId: options.dispatchId });
      expect(options.dispatchId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      return f.finish();
    });
    expect((await runUniversePortfolioController(f.definition, f.options)).status).toBe('completed');
    expect(hooks.proof).not.toHaveBeenCalled();
  });

  it('settles proven lost responses without replaying workers or delivering branches', async () => {
    const f = fixture(); await runUniversePortfolioController(f.definition, f.options);
    const intent = f.events().find((row) => row.kind === 'intent')!;
    hooks.proof.mockReturnValue({ campaign: f.finish(), recordsDigest: FINAL });
    const recovered = await runUniversePortfolioController(f.definition, f.options);
    expect(recovered.status).toBe('completed');
    expect(recovered.outcomes[0]?.reasonCode).toBe('completed-dispatch-reconciled');
    expect(hooks.proof).toHaveBeenCalledWith('a', expect.objectContaining({ dispatchId: intent.kind === 'intent' ? intent.dispatchId : null,
      intentAt: intent.at, recordsDigest: INITIAL }), f.options);
    expect(hooks.run).toHaveBeenCalledOnce(); expect(hooks.deliver).not.toHaveBeenCalled();
    await runUniversePortfolioController(f.definition, f.options);
    expect(f.events().filter((row) => row.kind === 'settled')).toHaveLength(1);
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('keeps unmatched completion unresolved and leaves status entirely read-only', async () => {
    const f = fixture(); await runUniversePortfolioController(f.definition, f.options); f.finish();
    const before = f.events();
    expect(readUniversePortfolioController('controller', f.options).outcomes[0]?.state).toBe('in-flight');
    expect(hooks.proof).not.toHaveBeenCalled(); expect(f.events()).toEqual(before);
    expect((await runUniversePortfolioController(f.definition, f.options)).outcomes[0]?.state).toBe('in-flight');
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('never assigns a new identity to legacy unresolved intent', async () => {
    const f = fixture(); f.requireRuntime(); await runUniversePortfolioController(f.definition, f.options);
    appendPortfolioControllerEvent(f.directory, { kind: 'intent', campaignId: 'a', at: new Date().toISOString() });
    hooks.proof.mockReturnValue({ campaign: f.finish(), recordsDigest: FINAL });
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.outcomes[0]?.state).toBe('in-flight'); expect(hooks.proof).not.toHaveBeenCalled();
    expect(hooks.run).not.toHaveBeenCalled();
  });

  it('collects completed evidence after the persisted deadline without renewing it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
    const f = fixture(); const first = await runUniversePortfolioController(f.definition, f.options);
    hooks.proof.mockReturnValue({ campaign: f.finish(), recordsDigest: FINAL });
    vi.setSystemTime(new Date('2026-09-09T12:00:11.000Z'));
    const result = await runUniversePortfolioController(f.definition, f.options);
    expect(result.status).toBe('completed'); expect(result.deadlineAt).toBe(first.deadlineAt);
    expect(hooks.run).toHaveBeenCalledOnce(); expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('preserves the intent on settlement persistence failure and retries proof, not workers', async () => {
    const f = fixture(); await runUniversePortfolioController(f.definition, f.options);
    hooks.proof.mockReturnValue({ campaign: f.finish(), recordsDigest: FINAL });
    const write = records.writeImmutablePrivateRecord;
    const spy = vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((config, event) => {
      if ((event as { kind?: string }).kind === 'settled') throw new Error('synthetic disk failure');
      return write(config, event);
    });
    const failed = await runUniversePortfolioController(f.definition, f.options);
    expect(failed.status).toBe('unavailable'); expect(failed.reasons).toContain('controller-reconciliation-persistence-failed');
    expect(failed.outcomes[0]?.state).toBe('in-flight'); spy.mockRestore();
    expect((await runUniversePortfolioController(f.definition, f.options)).status).toBe('completed');
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('withholds required missing delivery without attempting branch creation', async () => {
    const f = fixture(); const deliveryPlan = { schemaVersion: 1 as const,
      deliveries: [{ campaignId: 'a', branch: 'codex/a', baseCommit: 'a'.repeat(40) }] };
    const options = { ...f.options, deliveryPlan };
    await runUniversePortfolioController(f.definition, options);
    hooks.proof.mockReturnValue({ campaign: f.finish(), recordsDigest: FINAL });
    const result = await runUniversePortfolioController(f.definition, options);
    expect(result.outcomes[0]?.state).toBe('in-flight');
    expect(result.reasons).toContain('a:reconciliation-delivery-unavailable');
    expect(hooks.deliver).not.toHaveBeenCalled(); expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('requires a healthy existing campaign-specific delivery and pins its receipt', async () => {
    const f = fixture(); const deliveryPlan = { schemaVersion: 1 as const,
      deliveries: [{ campaignId: 'a', branch: 'codex/a', baseCommit: 'a'.repeat(40) }] };
    const options = { ...f.options, deliveryPlan }; await runUniversePortfolioController(f.definition, options);
    hooks.proof.mockReturnValue({ campaign: f.finish(), recordsDigest: FINAL });
    const receipt = { status: 'delivered', branch: 'codex/a', baseCommit: 'a'.repeat(40), fixture: 'receipt' };
    hooks.deliveryProof.mockReturnValue(receipt); hooks.deliveries.mockReturnValue({ sourceState: 'healthy', deliveries: [receipt] });
    const result = await runUniversePortfolioController(f.definition, options);
    expect(result.status).toBe('completed'); expect(result.outcomes[0]?.deliveryDigest).toBe(digest(canonical(receipt)));
    expect(hooks.deliver).not.toHaveBeenCalled();
  });

  it('rejects malformed, duplicate, and delivery-only dispatch identities in the ledger', async () => {
    const f = fixture(); await runUniversePortfolioController(f.definition, f.options);
    const created = structuredClone(f.events()[0]!);
    if (created.kind !== 'created') throw new Error('Expected synthetic registration');
    const event = { kind: 'intent' as const, campaignId: 'a', dispatchId: UUID, sequence: 1, id: '00000001', at: created.at };
    for (const dispatchId of ['', 'not-a-uuid', undefined, null]) {
      expect(() => foldPortfolioController([created, { ...event, dispatchId } as typeof event])).toThrow();
    }
    created.enrollment.definition.tasks.push({ campaignId: 'b', dependsOn: [] });
    created.enrollment.definition.maxParallel = 2;
    created.enrollment.definitionDigest = digest(canonical(created.enrollment.definition));
    created.enrollment.pins.push({ ...created.enrollment.pins[0]!, campaignId: 'b', universeId: 'universe-b' });
    expect(() => foldPortfolioController([created, event, { ...event, campaignId: 'b', sequence: 2, id: '00000002' }])).toThrow();
    created.enrollment.deliveryPlan = { schemaVersion: 1, deliveries: [{ campaignId: 'a', branch: 'codex/a', baseCommit: 'a'.repeat(40) }] };
    created.enrollment.pins[0]!.dispatch = 'delivery';
    expect(() => foldPortfolioController([created, event])).toThrow();
  });
});

describe('Read-only campaign delivery provenance', () => {
  it('does not mistake another campaign, unchanged artifact, or degraded branch for this campaign delivery', async () => {
    const { readCompletedCampaignDelivery } = await vi.importActual<typeof import('../src/core/universe/campaign-delivery-recovery.js')>(
      '../src/core/universe/campaign-delivery-recovery.js');
    const campaign = { sourceState: 'healthy', state: 'completed', definition: { id: 'a', universeId: 'universe-a' },
      definitionDigest: HASH, manifestDigest: HASH, comparatorDigest: HASH, steps: [{ runId: 'run', ordinal: 1 }] } as UniverseCampaignSummary;
    const target = { branch: 'codex/a', baseCommit: 'a'.repeat(40) };
    const receipt = { ...target, status: 'delivered', universeId: 'universe-a', runId: 'run', trialId: 'trial', artifactDigest: 'changed' };
    const trial = { id: 'trial', selected: true, status: 'passed', score: 2, delta: 1, parentTrialId: 'parent', artifact: { digest: 'changed' } };
    const run = { id: 'run', status: 'completed', campaign: { id: 'a', definitionDigest: HASH, ordinal: 1 }, trials: [trial] };
    hooks.universe.mockReturnValue({ sourceState: 'healthy', manifestDigest: HASH, comparatorDigest: HASH,
      manifest: { seed: { revision: target.baseCommit } }, runs: [{ id: 'parent-run', trials: [{ id: 'parent', artifact: { digest: 'parent' } }] }, run] });
    hooks.manifest.mockReturnValue({ seedArtifact: { digest: 'seed' } });
    hooks.deliveries.mockReturnValue({ sourceState: 'healthy', deliveries: [receipt] });
    const options = { root: '/synthetic/root' };
    expect(readCompletedCampaignDelivery(campaign, target, options)).toEqual(receipt);
    run.campaign.id = 'different'; expect(readCompletedCampaignDelivery(campaign, target, options)).toBeNull(); run.campaign.id = 'a';
    trial.delta = 0; expect(readCompletedCampaignDelivery(campaign, target, options)).toBeNull(); trial.delta = 1;
    trial.artifact.digest = 'seed'; expect(readCompletedCampaignDelivery(campaign, target, options)).toBeNull(); trial.artifact.digest = 'changed';
    hooks.deliveries.mockReturnValue({ sourceState: 'degraded', deliveries: [receipt] });
    expect(readCompletedCampaignDelivery(campaign, target, options)).toBeNull(); expect(hooks.deliver).not.toHaveBeenCalled();
  });
});
