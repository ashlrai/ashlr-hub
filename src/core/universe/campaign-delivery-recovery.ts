import { campaignUniverse } from './campaign-store.js';
import { readUniverseDeliveries, type UniverseDeliveryReceipt } from './delivery.js';
import { manifestRecord, universePath } from './store.js';
import type { UniverseCampaignSummary } from './types.js';

/** Read an already delivered strict campaign improvement; never create or repair a branch. */
export function readCompletedCampaignDelivery(campaign: UniverseCampaignSummary,
  target: { branch: string; baseCommit: string }, options: { root: string }): UniverseDeliveryReceipt | null {
  try {
    if (campaign.sourceState !== 'healthy' || campaign.state !== 'completed') return null;
    const universeId = campaign.definition.universeId;
    const universe = campaignUniverse(campaign, options);
    if (universe.sourceState !== 'healthy' || universe.manifestDigest !== campaign.manifestDigest ||
        universe.comparatorDigest !== campaign.comparatorDigest || universe.manifest.seed.revision !== target.baseCommit) return null;
    const deliveries = readUniverseDeliveries(universeId, options);
    if (deliveries.sourceState !== 'healthy') return null;
    const receipt = deliveries.deliveries.find((row) => row.status === 'delivered' && row.branch === target.branch &&
      row.baseCommit === target.baseCommit && row.universeId === universeId);
    if (!receipt) return null;
    const run = universe.runs.find((row) => row.id === receipt.runId && row.status === 'completed' &&
      row.campaign?.id === campaign.definition.id && row.campaign.definitionDigest === campaign.definitionDigest &&
      campaign.steps.some((step) => step.runId === row.id && step.ordinal === row.campaign!.ordinal));
    const trial = run?.trials.find((row) => row.id === receipt.trialId);
    const parent = trial?.parentTrialId ? universe.runs.flatMap((row) => row.trials).find((row) => row.id === trial.parentTrialId) : undefined;
    const seedDigest = manifestRecord(universePath(options.root, universeId)).seedArtifact.digest;
    // Keep the strict-improvement provenance used by deliverCompletedUniverseCampaign.
    // A healthy same-branch receipt from a different campaign is not our handoff.
    if (!trial?.selected || trial.status !== 'passed' || trial.score === null || trial.delta === null || trial.delta <= 0 ||
        !trial.artifact || trial.artifact.digest !== receipt.artifactDigest || trial.artifact.digest === seedDigest ||
        !parent?.artifact || parent.artifact.digest === trial.artifact.digest) return null;
    return receipt;
  } catch { return null; }
}
