/** Fresh delivered-source proof only; not graph completion, owner custody or launch authority. */
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, readArtifactSnapshot } from '../universe/artifacts.js';
import { campaignUniverse, readUniverseCampaign } from '../universe/campaign-store.js';
import { readCompletedCampaignDelivery } from '../universe/campaign-delivery-recovery.js';
import { decodeUtf8Excerpt } from '../util/utf8-excerpt.js';
import type { createResourceEngineeringPreparationRegistry } from './engineering-preparation-registry.js';
import type { ResourceEngineeringSuccessorSource } from './engineering-preparation-types.js';

export interface ResourceEngineeringDeliveredSource {
  source: ResourceEngineeringSuccessorSource;
  projectId: string;
  commit: string;
  objective: string;
  context: string;
}

/** The registry is the existing host-created capability, never caller-supplied proof callbacks.
 * Each call reconstructs the scoped registration and committed metadata. Callers
 * independently establish completed graph/ownership/settlement before using this
 * source; a verified local delivery alone does not establish those conditions. */
export function readResourceEngineeringDeliveredSource(
  registry: ReturnType<typeof createResourceEngineeringPreparationRegistry>,
  id: string,
  expectedEnrollmentDigest: string,
): ResourceEngineeringDeliveredSource | null {
  try {
    const row = registry.registrations().find(item => item.request.id === id && item.enrollmentDigest === expectedEnrollmentDigest);
    if (!row) return null;
    const verified = registry.committed(row, row.request, true); const enrollment = verified.catalog.enrollments[0];
    if (verified.catalog.enrollments.length !== 1 || !enrollment || enrollment.id !== id ||
        enrollment.host.definition.tasks.length !== 1 || enrollment.host.deliveryPlan.deliveries.length !== 1) return null;
    const campaignId = enrollment.host.definition.tasks[0]!.campaignId;
    const target = enrollment.host.deliveryPlan.deliveries[0]!;
    if (target.campaignId !== campaignId) return null;
    const campaign = readUniverseCampaign(campaignId, { root: enrollment.host.root });
    const receipt = readCompletedCampaignDelivery(campaign, target, { root: enrollment.host.root });
    if (!receipt) return null;
    const universe = campaignUniverse(campaign, { root: enrollment.host.root });
    const trial = universe.runs.find(run => run.id === receipt.runId)?.trials.find(item => item.id === receipt.trialId);
    if (universe.sourceState !== 'healthy' || !trial?.artifact || trial.artifact.digest !== receipt.artifactDigest) return null;
    const artifact = readArtifactSnapshot(trial.artifact.path);
    if (artifact.digest !== receipt.artifactDigest) return null;
    // Stable measured evidence and declared source bytes, not the mutable
    // project checkout or a volatile polling timestamp. Truncation is explicit.
    const seed = campaign.seedEvaluation?.result?.measurement;
    const observed = { metric: universe.manifest.metric, seed: seed ? { passed: seed.passed, score: seed.score } : null,
      delivered: { score: trial.score, deltaFromParent: trial.delta, artifactDigest: receipt.artifactDigest },
      files: [] as Array<{ path: string; text: string; truncated: boolean }>, omittedFiles: 0 };
    const allowed = new Set([...verified.candidate.plan.files, ...verified.candidate.plan.contextFiles]);
    for (const file of artifact.entries.filter(file => allowed.has(file.path))) {
      if (observed.files.length >= 4) { observed.omittedFiles++; continue; }
      try {
        const excerpt = decodeUtf8Excerpt(file.data, 1600);
        const value = excerpt.text;
        if (value.includes('\0')) throw new Error('Binary source');
        const item = { path: file.path, ...excerpt };
        if (Buffer.byteLength(canonical({ ...observed, files: [...observed.files, item] })) > 4096) { observed.omittedFiles++; continue; }
        observed.files.push(item);
      } catch { observed.omittedFiles++; }
    }
    const { campaignId: _campaign, ...delivery } = target;
    const text = canonicalEvidencePackJsonV3({ source: { root: enrollment.host.root, campaignId, expectedDefinitionDigest: campaign.definitionDigest,
      expectedManifestDigest: campaign.manifestDigest, expectedComparatorDigest: campaign.comparatorDigest,
      delivery, expectedDeliveryDigest: digest(canonical(receipt)) }, projectId: enrollment.projectId,
      commit: receipt.commit, objective: row.request.objective, context: canonical(observed) });
    if (text === null || Buffer.byteLength(text) > 1024 * 1024) return null;
    return JSON.parse(text) as ResourceEngineeringDeliveredSource;
  } catch { return null; }
}
