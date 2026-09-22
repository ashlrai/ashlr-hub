import type { UniverseCampaignDeliveryTarget } from './campaign-delivery.js';

/** Exact completed campaign publication, not integration acceptance or execution authority. */
export interface UniverseCampaignDeliverySource {
  root: string;
  campaignId: string;
  expectedDefinitionDigest: string;
  expectedManifestDigest: string;
  expectedComparatorDigest: string;
  delivery: UniverseCampaignDeliveryTarget;
  expectedDeliveryDigest: string;
}

/** Stored atomically with a distinct successor manifest; no trial scores are inherited. */
export interface UniverseCampaignDeliveryOrigin {
  schemaVersion: 1;
  requestDigest: string;
  sourceRootDigest: string;
  campaignId: string;
  universeId: string;
  definitionDigest: string;
  manifestDigest: string;
  comparatorDigest: string;
  deliveryDigest: string;
  deliveryId: string;
  runId: string;
  trialId: string;
  repo: string;
  commit: string;
  tree: string;
  artifactDigest: string;
}
