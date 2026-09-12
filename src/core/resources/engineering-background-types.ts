import type { createResourceConsoleEngineeringPreparation, ResourceConsoleEngineeringPreparationOwner } from './console-engineering-preparation.js';
import type { createResourceConsoleEngineeringSuccessors } from './console-engineering-successors.js';
import type { ResourceEngineeringSuccessorCoordinatorSnapshot } from './engineering-successor-coordinator-types.js';
import type { ResourceConsoleEngineeringSupervisor } from './console-engineering-supervisor.js';

export type EngineeringBackgroundPreparation = Omit<Parameters<typeof createResourceConsoleEngineeringPreparation>[0], 'owner'>;
export type EngineeringBackgroundSuccessors = Omit<Parameters<typeof createResourceConsoleEngineeringSuccessors>[0],
  'preparation' | 'supervision' | 'supervisor' | 'readAdmissionEvidence' | 'isClosing' | 'signal' | 'onLifecycle'>;
export const ENGINEERING_BACKGROUND_HOST_METHODS = [
  'owner.catalog', 'owner.snapshot', 'owner.checkRegistration', 'owner.register',
  'supervision.snapshot', 'supervision.admit', 'supervision.isExecutionStopped',
  'supervisor.projectFileBinding', 'supervisor.projectExecutionBinding', 'readAdmissionEvidence', 'isClosing',
] as const;
export type EngineeringBackgroundHostMethod = typeof ENGINEERING_BACKGROUND_HOST_METHODS[number];
export type EngineeringBackgroundHost = Record<EngineeringBackgroundHostMethod, (...args: unknown[]) => unknown>;
export interface EngineeringBackground {
  profiles(projectId: string): Promise<ReturnType<ResourceConsoleEngineeringPreparationOwner['profiles']>>;
  check(input: unknown): Promise<ReturnType<ResourceConsoleEngineeringPreparationOwner['check']>>;
  prepare(input: unknown): Promise<ReturnType<ResourceConsoleEngineeringPreparationOwner['prepare']>>;
  prepareAutomatically(...args: Parameters<ResourceConsoleEngineeringPreparationOwner['prepareAutomatically']>): Promise<ReturnType<ResourceConsoleEngineeringPreparationOwner['prepareAutomatically']>>;
  pendingAutomaticAdmissions(...args: Parameters<ResourceConsoleEngineeringPreparationOwner['pendingAutomaticAdmissions']>): Promise<ReturnType<ResourceConsoleEngineeringPreparationOwner['pendingAutomaticAdmissions']>>;
  configureSuccessors(input: EngineeringBackgroundSuccessors, supervision: ResourceConsoleEngineeringSupervisor,
    readAdmissionEvidence: Parameters<typeof createResourceConsoleEngineeringSuccessors>[0]['readAdmissionEvidence']): Promise<void>;
  start(): Promise<void>;
  snapshot(): Promise<ResourceEngineeringSuccessorCoordinatorSnapshot>;
  close(): Promise<void>;
}
