import type { ResourceEngineeringRecipe } from './engineering-preparation-types.js';
import type { ResourceConsoleEngineeringEnrollment } from './console-engineering-types.js';

/** Private host configuration. Recipe authority is never supplied by a browser. */
export interface ResourceConsoleEngineeringPreparationConfig {
  schemaVersion: 1;
  outputRoot: string;
  resourceRuntime: string;
  profiles: Array<{ id: string; label: string; acceptance: string; recipe: ResourceEngineeringRecipe }>;
}
/** IDs max 64 ASCII identifier characters; name 120 and objective 4000 UTF-8 bytes. */
export interface ResourceConsoleEngineeringObjective {
  id: string; profileId: string; name: string; objective: string;
}
export interface ResourceConsoleEngineeringProfile {
  id: string; label: string; acceptance: string; projectId: string; seedRevision: string;
  metric: ResourceEngineeringRecipe['metric'];
  files: string[]; contextFiles: string[]; allowedWorkerIds: string[];
  trialBudget: ResourceEngineeringRecipe['trialBudget'];
  campaignBudget: ResourceEngineeringRecipe['campaignBudget'];
}
export interface ResourceConsoleEngineeringObjectivePlan {
  schemaVersion: 1; status: 'planned'; id: string; profileId: string; profileDigest: string;
  name: string; objective: string; projectId: string; planDigest: string;
  seedRevision: string; branch: string; acceptance: string;
  metric: ResourceEngineeringRecipe['metric'];
  files: string[]; contextFiles: string[]; allowedWorkerIds: string[];
  trialBudget: ResourceEngineeringRecipe['trialBudget'];
  campaignBudget: ResourceEngineeringRecipe['campaignBudget'];
  executionStarted: false; providerContacted: false;
}
export interface ResourceConsoleEngineeringObjectivePrepared {
  plan: ResourceConsoleEngineeringObjectivePlan;
  enrollment: ResourceConsoleEngineeringEnrollment;
  disposition: 'created' | 'replayed';
  /** Present only for the host-enabled prepare-to-queue policy; not proof of execution. */
  automaticAdmission?: { state: 'admitted' | 'unavailable'; supervisionId: string };
}
