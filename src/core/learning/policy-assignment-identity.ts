import { createHmac } from 'node:crypto';

export interface PolicyAssignmentUnitIdentity {
  repo: string;
  workItemId: string;
  workSource: string;
  workItemGenerationId: string;
  objectiveHash: string;
  campaignDigest: string;
  eligibilityPopulationDigest: string;
  policyVersion: string;
  learningEpoch: string;
}

/** Shared formula only; callers retain responsibility for canonical validation. */
export function policyAssignmentUnitId(
  key: Buffer,
  input: PolicyAssignmentUnitIdentity,
): string {
  return createHmac('sha256', key).update(JSON.stringify([
    'ashlr:policy-assignment-unit:v1',
    input.repo,
    input.workItemId,
    input.workSource,
    input.workItemGenerationId,
    input.objectiveHash,
    input.campaignDigest,
    input.eligibilityPopulationDigest,
    input.policyVersion,
    input.learningEpoch,
  ]), 'utf8').digest('hex');
}
