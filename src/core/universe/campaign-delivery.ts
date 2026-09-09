import { resolve } from 'node:path';
import { defaultUniverseRoot } from './artifacts.js';
import { runUniverseCampaign } from './campaign.js';
import { campaignUniverse, readUniverseCampaign } from './campaign-store.js';
import { deliverUniverseEliteOwned, readUniverseDeliveries, validUniverseDeliveryBranch,
  type UniverseDeliveryReceipt } from './delivery.js';
import { withUniverseExecution } from './execution.js';
import { manifestRecord, universePath } from './store.js';
import type { UniverseCampaignSummary, UniverseRunOptions } from './types.js';

export interface UniverseCampaignDeliveryOptions extends UniverseRunOptions {
  /** Explicit invocation intent, separate from the frozen experiment/campaign definitions. */
  delivery: { branch: string; baseCommit: string };
}
export interface UniverseCampaignDeliveryResult {
  campaign: UniverseCampaignSummary;
  delivery: { status: 'delivered'; receipt: UniverseDeliveryReceipt } |
    { status: 'withheld'; reason: 'campaign-not-completed' | 'cancelled' | 'no-strict-improvement' };
}

/** Run within the existing budget, then materialize one measured improvement locally.
 * This never merges, pushes, checks out a branch, or changes supervisor semantics.
 * Repeating an invocation reuses the evidence-bound branch receipt, not a new commit.
 */
export async function runUniverseCampaignAndDeliver(id: string,
  options: UniverseCampaignDeliveryOptions): Promise<UniverseCampaignDeliveryResult> {
  const { branch, baseCommit } = options.delivery;
  if (!validUniverseDeliveryBranch(branch) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) {
    throw new Error('Campaign delivery requires a codex/ branch and exact pinned base commit');
  }
  const store = { root: resolve(options.root ?? defaultUniverseRoot()) };
  const initial = readUniverseCampaign(id, store);
  const universeId = initial.definition.universeId;
  const directory = universePath(store.root, universeId);
  if (initial.sourceState !== 'healthy' || campaignUniverse(initial, store).manifest.seed.revision !== baseCommit) {
    throw new Error('Campaign delivery base must match the healthy experiment pinned seed');
  }
  const expectedIdentity = { universeId, definitionDigest: initial.definitionDigest,
    manifestDigest: initial.manifestDigest, comparatorDigest: initial.comparatorDigest };
  const campaign = await runUniverseCampaign(id, { ...store, signal: options.signal,
    resourceRuntime: options.resourceRuntime, expectedIdentity });
  if (options.signal?.aborted) return { campaign, delivery: { status: 'withheld', reason: 'cancelled' } };
  if (campaign.state !== 'completed') return { campaign, delivery: { status: 'withheld', reason: 'campaign-not-completed' } };
  return withUniverseExecution(universeId, store, async (lock) => {
    const current = readUniverseCampaign(id, store);
    const universe = campaignUniverse(current, store);
    if (current.sourceState !== 'healthy' || current.state !== 'completed' ||
        current.definition.universeId !== universeId || current.definitionDigest !== expectedIdentity.definitionDigest ||
        current.manifestDigest !== expectedIdentity.manifestDigest || current.comparatorDigest !== expectedIdentity.comparatorDigest ||
        universe.manifest.seed.revision !== baseCommit) throw new Error('Campaign delivery evidence changed after execution');
    if (options.signal?.aborted) return { campaign: current, delivery: { status: 'withheld', reason: 'cancelled' } };
    const seedDigest = manifestRecord(directory).seedArtifact.digest;
    const allTrials = new Map(universe.runs.flatMap((run) => run.trials).map((trial) => [trial.id, trial]));
    const trials = universe.runs.flatMap((run) => run.status === 'completed' &&
      run.campaign?.id === id && run.campaign.definitionDigest === current.definitionDigest &&
      current.steps.some((step) => step.runId === run.id && step.ordinal === run.campaign!.ordinal)
      ? run.trials.filter((trial) => {
        const parent = trial.parentTrialId ? allTrials.get(trial.parentTrialId) : undefined;
        return trial.selected && trial.status === 'passed' && trial.score !== null && trial.delta !== null && trial.delta > 0 &&
          trial.artifact && trial.artifact.digest !== seedDigest && parent?.artifact && trial.artifact.digest !== parent.artifact.digest;
      }) : []);
    const prior = readUniverseDeliveries(universeId, store);
    if (prior.sourceState === 'degraded') throw new Error('Campaign delivery ledger is degraded');
    const existing = prior.deliveries.find((receipt) => receipt.branch === branch);
    if (existing && (existing.baseCommit !== baseCommit || !trials.some((trial) => trial.id === existing.trialId))) {
      throw new Error('Campaign delivery branch belongs to different or non-improving evidence');
    }
    // Existing receipts remain replayable even after a later campaign replaces the elite.
    const direction = universe.manifest.metric.direction === 'maximize' ? -1 : 1;
    const selected = existing ? trials.find((trial) => trial.id === existing.trialId) : trials
      .filter((trial) => universe.elites.some((elite) => elite.trialId === trial.id))
      .sort((a, b) => direction * (a.score! - b.score!) || a.id.localeCompare(b.id))[0];
    if (!selected) return { campaign: current, delivery: { status: 'withheld', reason: 'no-strict-improvement' } };
    const receipt = await deliverUniverseEliteOwned(universeId, { ...store, trialId: selected.id, branch, signal: options.signal }, lock);
    if (receipt.status !== 'delivered') throw new Error('Campaign delivery did not produce a changed local branch');
    return { campaign: current, delivery: { status: 'delivered', receipt } };
  });
}
