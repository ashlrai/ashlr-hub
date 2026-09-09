import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
const sources = vi.hoisted(() => ({ universe: vi.fn(), deliveries: vi.fn(), manifest: vi.fn() }));
vi.mock('../src/core/universe/campaign-store.js', () => ({ campaignUniverse: sources.universe }));
vi.mock('../src/core/universe/delivery.js', () => ({ readUniverseDeliveries: sources.deliveries }));
vi.mock('../src/core/universe/store.js', () => ({ manifestRecord: sources.manifest, universePath: () => '/synthetic/universe' }));
import { readCompletedCampaignDelivery } from '../src/core/universe/campaign-delivery-recovery.js';

beforeEach(() => { for (const source of Object.values(sources)) source.mockReset(); });

// Synthetic projections isolate receipt-to-campaign association. Native tests
// separately verify actual Git, evaluator execution and branch-drift detection.
function fixture() {
  const campaign = { sourceState: 'healthy', state: 'completed', definition: { id: 'campaign-a', universeId: 'universe-a' },
    definitionDigest: 'definition', manifestDigest: 'manifest', comparatorDigest: 'comparator',
    steps: [{ runId: 'run-a', ordinal: 2 }] };
  const trial = { id: 'trial-a', parentTrialId: 'parent-a', selected: true, status: 'passed', score: 2, delta: 1,
    artifact: { digest: 'improvement' } };
  const parent = { id: 'parent-a', artifact: { digest: 'parent' } };
  const run = { id: 'run-a', status: 'completed', campaign: { id: 'campaign-a', definitionDigest: 'definition', ordinal: 2 },
    trials: [trial] };
  const universe = { sourceState: 'healthy', manifestDigest: 'manifest', comparatorDigest: 'comparator',
    manifest: { seed: { revision: 'base' } }, runs: [run, { id: 'parent-run', status: 'completed', trials: [parent] }] };
  const receipt = { status: 'delivered', universeId: 'universe-a', branch: 'codex/improvement', baseCommit: 'base',
    runId: 'run-a', trialId: 'trial-a', artifactDigest: 'improvement' };
  const deliveries = { sourceState: 'healthy', deliveries: [receipt] };
  sources.universe.mockReturnValue(universe);
  sources.deliveries.mockReturnValue(deliveries);
  sources.manifest.mockReturnValue({ seedArtifact: { digest: 'seed' } });
  const read = () => readCompletedCampaignDelivery(campaign as unknown as UniverseCampaignSummary,
    { branch: 'codex/improvement', baseCommit: 'base' }, { root: '/synthetic' });
  return { campaign, universe, run, trial, parent, receipt, deliveries, read };
}

describe('Independent existing-delivery recovery provenance', () => {
  it('accepts an already verified strict improvement from the exact campaign run', () => {
    const f = fixture(); expect(f.read()).toEqual(f.receipt);
  });

  it.each([
    ['different campaign', (f: ReturnType<typeof fixture>) => { f.run.campaign.id = 'campaign-other'; }],
    ['different campaign definition', (f: ReturnType<typeof fixture>) => { f.run.campaign.definitionDigest = 'other'; }],
    ['unrecorded campaign ordinal', (f: ReturnType<typeof fixture>) => { f.run.campaign.ordinal = 3; }],
    ['unrecorded campaign run', (f: ReturnType<typeof fixture>) => { f.campaign.steps[0]!.runId = 'other'; }],
    ['different trial', (f: ReturnType<typeof fixture>) => { f.receipt.trialId = 'other'; }],
    ['unselected trial', (f: ReturnType<typeof fixture>) => { f.trial.selected = false; }],
    ['failed evaluation', (f: ReturnType<typeof fixture>) => { f.trial.status = 'failed'; }],
    ['no measured improvement', (f: ReturnType<typeof fixture>) => { f.trial.delta = 0; }],
    ['unchanged seed', (f: ReturnType<typeof fixture>) => { f.trial.artifact.digest = f.receipt.artifactDigest = 'seed'; }],
    ['unchanged parent', (f: ReturnType<typeof fixture>) => { f.parent.artifact.digest = 'improvement'; }],
    ['missing parent', (f: ReturnType<typeof fixture>) => { f.trial.parentTrialId = 'absent'; }],
    ['different receipt artifact', (f: ReturnType<typeof fixture>) => { f.receipt.artifactDigest = 'other'; }],
    ['different base', (f: ReturnType<typeof fixture>) => { f.universe.manifest.seed.revision = 'other'; }],
    ['degraded delivery evidence', (f: ReturnType<typeof fixture>) => { f.deliveries.sourceState = 'degraded'; }],
    ['incomplete delivery', (f: ReturnType<typeof fixture>) => { f.receipt.status = 'pending'; }],
    ['paused campaign', (f: ReturnType<typeof fixture>) => { f.campaign.state = 'paused'; }],
  ] as const)('does not recover %s', (_name, mutate) => {
    const f = fixture(); mutate(f); expect(f.read()).toBeNull();
  });

  it('treats unavailable source evidence as no proof', () => {
    const f = fixture(); sources.universe.mockImplementation(() => { throw new Error('unavailable'); });
    expect(f.read()).toBeNull();
  });
});
