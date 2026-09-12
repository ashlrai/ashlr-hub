import type { UniverseManifest } from '../universe/types.js';
import type { UniverseCampaignDefinition } from '../universe/types.js';
import type { UniverseCampaignDeliveryOrigin, UniverseCampaignDeliverySource } from '../universe/campaign-handoff-types.js';

export interface ResourceEngineeringRecipe {
  schemaVersion: 1; id: string; name: string; objective: string; projectId: string; seedRevision: string;
  metric: UniverseManifest['metric']; evaluation: Extract<UniverseManifest['evaluation'], { command: string[] }>;
  trialBudget: UniverseManifest['budget']; campaignBudget: UniverseCampaignDefinition['budget'];
  generation: { files: string[]; contextFiles: string[]; allowedWorkerIds: string[]; maxOutputTokens: number;
    hypotheses: Array<{ id: string; niche: string; hypothesis: string }> };
  delivery: { branch: string; allowInitialRepair?: true };
  execution: { maxDurationMs: number; constitutionVersion: string; policyEpoch: number };
  supervision: { maxDurationMs: number; pollIntervalMs: number; maxAttemptsPerEnrollment: number };
}
export interface ResourceEngineeringPreparationOptions {
  recipe: unknown; output: string; resourceRuntime: string; workspace: string; projectsFile: string;
}
export interface ResourceEngineeringPreparationPlan {
  schemaVersion: 1; status: 'planned'; scope: 'local-preparation-only'; planDigest: string;
  projectId: string; projectRegistration: 'persisted' | 'would-register'; output: string; enrollmentDigest: string | null;
  executionStarted: false; providerContacted: false;
  paths: { output: string; universeRoot: string; graphRoot: string; manifest: string; campaign: string;
    engineering: string; supervision: string; receipt: string };
  ids: { universeId: string; campaignId: string; enrollmentId: string; graphId: string; controllerId: string };
  seedRevision: string; runtimeDigest: string; poolDigest: string;
}
export interface ResourceEngineeringPreparationReport extends Omit<ResourceEngineeringPreparationPlan, 'status'> {
  status: 'prepared'; disposition: 'created' | 'replayed'; enrollmentDigest: string;
  commissioning: { status: 'configured' | 'held' | 'unavailable'; reasons: string[] };
  consoleArguments: { manual: string[]; automatic: string[] };
}
/** Private host inspection only: verified bundle identity, not commissioning or admission. */
export type ResourceEngineeringPreparationMetadata = Omit<ResourceEngineeringPreparationReport, 'commissioning' | 'consoleArguments'>;

export type ResourceEngineeringSuccessorSource = UniverseCampaignDeliverySource;
export type ResourceEngineeringSuccessorRecipe = Omit<ResourceEngineeringRecipe, 'seedRevision'>;
export interface ResourceEngineeringSuccessorPreparationOptions extends ResourceEngineeringPreparationOptions {
  /** A closed ResourceEngineeringSuccessorRecipe; seedRevision is host-derived from source proof. */
  recipe: unknown;
  source: ResourceEngineeringSuccessorSource;
}
export interface ResourceEngineeringSuccessorPreparationPlan extends ResourceEngineeringPreparationPlan {
  campaignDeliveryOrigin: UniverseCampaignDeliveryOrigin;
}
export interface ResourceEngineeringSuccessorPreparationReport extends ResourceEngineeringPreparationReport {
  campaignDeliveryOrigin: UniverseCampaignDeliveryOrigin;
}
export interface ResourceEngineeringSuccessorPreparationMetadata extends ResourceEngineeringPreparationMetadata {
  campaignDeliveryOrigin: UniverseCampaignDeliveryOrigin;
}
