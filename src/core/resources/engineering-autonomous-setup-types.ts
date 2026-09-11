import type { ResourceEngineeringRecipe } from './engineering-preparation-types.js';
import type { ResourceEngineeringSuccessorCoordinatorConfig } from './engineering-successor-coordinator-types.js';

export interface ResourceEngineeringAutonomousSetupPolicy {
  schemaVersion: 1; id: string; profileId: string; label: string; acceptance: string;
  maxEnrollments: number; maxConcurrent: number; autoAdmitPrepared?: true;
  successors: Omit<ResourceEngineeringSuccessorCoordinatorConfig, 'schemaVersion' | 'supervisionId' | 'profileId'>;
}
export interface ResourceEngineeringAutonomousSetupOptions {
  recipe: ResourceEngineeringRecipe | unknown; policy: ResourceEngineeringAutonomousSetupPolicy | unknown;
  /** Existing private directory: empty for first setup, never an arbitrary overwrite target. */
  output: string; resourceRuntime: string; workspace: string; projectsFile: string;
}
export interface ResourceEngineeringAutonomousSetupPlan {
  schemaVersion: 1; status: 'planned'; scope: 'local-autonomous-setup-only'; planDigest: string;
  output: string; projectId: string; seedRevision: string; initialEnrollmentDigest: string | null;
  executionStarted: false; providerContacted: false;
  paths: { profiles: string; supervision: string; successors: string; intent: string; receipt: string; initialBundle: string; registration: string };
  holds: string[];
}
export interface ResourceEngineeringAutonomousSetupReport extends Omit<ResourceEngineeringAutonomousSetupPlan, 'status' | 'initialEnrollmentDigest'> {
  status: 'prepared'; disposition: 'created' | 'replayed'; initialEnrollmentDigest: string;
  consoleArguments: string[];
}
