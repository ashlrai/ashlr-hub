/**
 * Observation-only eligibility projection for recursive fleet learning.
 *
 * The projection records why an attempt is or is not ready for learning without
 * granting policy authority. Identities are host-keyed digests; raw prompts,
 * rationale, diffs, process output, environment, paths, and file contents never
 * enter the schema.
 */

import { createHash, createHmac } from 'node:crypto';
import type { TrajectoryRecord, TrajectoryTerminalOutcome } from '../autonomy/trajectory-records.js';
import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import type {
  PostMergePopulationMemberV2,
  PostMergePopulationV2,
} from '../fleet/post-merge-population-v2.js';

export const LEARNING_ELIGIBILITY_POLICY_VERSION = 'learning-eligibility-v1' as const;
const MAX_MEMBERS = 4_096;
const DIGEST_RE = /^[a-f0-9]{64}$/;

export type LearningEligibilityRefusalCode =
  | 'trajectory-source-incomplete'
  | 'decision-source-incomplete'
  | 'agent-action-source-incomplete'
  | 'proposal-not-produced'
  | 'proposal-observation-missing'
  | 'verification-failed'
  | 'verification-missing'
  | 'decision-missing'
  | 'terminal-pending'
  | 'terminal-failed'
  | 'terminal-rejected'
  | 'protected-merge-unproven'
  | 'post-merge-adverse'
  | 'post-merge-inconclusive'
  | 'post-merge-unobserved'
  | 'denominator-incomplete'
  | 'selection-propensity-unavailable';

export interface LearningEligibilityStagesV1 {
  dispatch: 'observed';
  proposal: 'observed' | 'not-produced' | 'missing';
  verification: 'passed' | 'failed' | 'missing';
  decision: 'observed' | 'missing';
  terminal: 'protected-merge' | 'rejected' | 'other';
  postMerge: 'adverse' | 'inconclusive' | 'unobserved';
}

export interface LearningEligibilityMemberV1 {
  subjectDigest: string;
  proposalDigest?: string;
  terminalOutcome: TrajectoryTerminalOutcome;
  stages: LearningEligibilityStagesV1;
  selectionPropensityAvailable: boolean;
  refusalCodes: LearningEligibilityRefusalCode[];
  policyEligible: false;
  recursiveLearningEligible: false;
}

export interface LearningEligibilityProjectionV1 {
  schemaVersion: 1;
  authority: 'observation-only';
  policyVersion: typeof LEARNING_ELIGIBILITY_POLICY_VERSION;
  learningEpoch: string;
  policyEligible: false;
  recursiveLearningEligible: false;
  denominatorComplete: false;
  sourceComplete: boolean;
  selectionPropensityAvailable: boolean;
  evaluated: number;
  refusalCounts: Partial<Record<LearningEligibilityRefusalCode, number>>;
  candidateSetDigest: string;
  members: LearningEligibilityMemberV1[];
}

export interface LearningEligibilityProjectionInput {
  records: readonly TrajectoryRecord[];
  population?: PostMergePopulationV2;
  trajectorySourceComplete: boolean;
  learningEpoch: string;
  maxMembers?: number;
}

export type LearningEligibilityProjectionResult =
  | { ok: true; projection: LearningEligibilityProjectionV1 }
  | { ok: false; reason: 'identity-key-unavailable' | 'invalid-input' | 'source-limit' | 'duplicate-subject' };

interface LearningEligibilityDependencies {
  identityKey: () => Buffer | null;
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hmac(key: Buffer, domain: string, value: string): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value])).digest('hex');
}

function identityOf(record: TrajectoryRecord): string {
  return record.trajectoryId ?? record.runId ?? record.id;
}

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function sourceComplete(record: TrajectoryRecord): {
  decision: boolean;
  agentAction: boolean;
} {
  const decision = record.decisionSourceQuality === undefined ||
    (record.decisionSourceQuality.sourceState !== 'degraded' && record.decisionSourceQuality.complete);
  const agentAction = record.agentActionSourceQuality === undefined ||
    (record.agentActionSourceQuality.sourceState !== 'degraded' && record.agentActionSourceQuality.complete);
  return { decision, agentAction };
}

function hasRecordedSelectionPropensity(record: TrajectoryRecord): boolean {
  // A raw trajectory observation is outcome-time metadata, not proof that a
  // randomized assignment was durably recorded before execution. Keep the
  // learning projection unavailable until the receipt-qualified join exists.
  void record;
  return false;
}

function verificationStage(record: TrajectoryRecord): LearningEligibilityStagesV1['verification'] {
  const values = [
    record.evidenceOutcome?.verificationPassed,
    ...record.timeline
      .filter((event) => event.kind === 'evidence')
      .map((event) => event.evidence?.verificationPassed),
  ].filter((value): value is boolean => typeof value === 'boolean');
  if (values.includes(false)) return 'failed';
  if (values.includes(true)) return 'passed';
  return 'missing';
}

function proposalStage(record: TrajectoryRecord): LearningEligibilityStagesV1['proposal'] {
  if (record.terminalOutcome === 'no-proposal') return 'not-produced';
  return record.coverage.proposal ? 'observed' : 'missing';
}

function memberByProposal(
  population: PostMergePopulationV2 | undefined,
): ReadonlyMap<string, PostMergePopulationMemberV2> | null {
  if (!population) return new Map();
  if (population.schemaVersion !== 2 || population.authority !== 'observation-only' ||
    population.policyEligible !== false || population.denominatorComplete !== false ||
    !Array.isArray(population.members) || population.members.length > MAX_MEMBERS) return null;
  const result = new Map<string, PostMergePopulationMemberV2>();
  for (const member of population.members) {
    if (!member || !DIGEST_RE.test(member.memberId) || !DIGEST_RE.test(member.repoDigest) ||
      !DIGEST_RE.test(member.proposalDigest) || !DIGEST_RE.test(member.mergeDigest) ||
      !DIGEST_RE.test(member.evidenceDigest) ||
      (member.classification !== 'adverse' && member.classification !== 'inconclusive') ||
      result.has(member.proposalDigest)) return null;
    result.set(member.proposalDigest, member);
  }
  return result;
}

function terminalStage(
  terminalOutcome: TrajectoryTerminalOutcome,
  populationMember: PostMergePopulationMemberV2 | undefined,
): LearningEligibilityStagesV1['terminal'] {
  if (terminalOutcome === 'rejected') return 'rejected';
  if (terminalOutcome === 'merged' && populationMember) return 'protected-merge';
  return 'other';
}

function refusalCodes(
  input: {
    record: TrajectoryRecord;
    stages: LearningEligibilityStagesV1;
    trajectorySourceComplete: boolean;
    decisionSourceComplete: boolean;
    agentActionSourceComplete: boolean;
    denominatorComplete: boolean;
    selectionPropensityAvailable: boolean;
  },
): LearningEligibilityRefusalCode[] {
  const codes = new Set<LearningEligibilityRefusalCode>();
  if (!input.trajectorySourceComplete) codes.add('trajectory-source-incomplete');
  if (!input.decisionSourceComplete) codes.add('decision-source-incomplete');
  if (!input.agentActionSourceComplete) codes.add('agent-action-source-incomplete');
  if (input.stages.proposal === 'not-produced') codes.add('proposal-not-produced');
  if (input.stages.proposal === 'missing') codes.add('proposal-observation-missing');
  if (input.stages.verification === 'failed') codes.add('verification-failed');
  if (input.stages.verification === 'missing') codes.add('verification-missing');
  if (input.stages.decision === 'missing') codes.add('decision-missing');
  if (input.record.terminalOutcome === 'pending' || input.record.terminalOutcome === 'unknown') {
    codes.add('terminal-pending');
  }
  if (input.record.terminalOutcome === 'failed' || input.record.terminalOutcome === 'cancelled') {
    codes.add('terminal-failed');
  }
  if (input.stages.terminal === 'rejected') codes.add('terminal-rejected');
  if (input.record.terminalOutcome === 'merged' && input.stages.terminal !== 'protected-merge') {
    codes.add('protected-merge-unproven');
  }
  if (input.stages.postMerge === 'adverse') codes.add('post-merge-adverse');
  if (input.stages.postMerge === 'inconclusive') codes.add('post-merge-inconclusive');
  if (input.stages.postMerge === 'unobserved' && input.record.terminalOutcome === 'merged') {
    codes.add('post-merge-unobserved');
  }
  if (!input.denominatorComplete) codes.add('denominator-incomplete');
  if (!input.selectionPropensityAvailable) codes.add('selection-propensity-unavailable');
  return [...codes].sort();
}

export function buildLearningEligibilityProjectionV1(
  input: LearningEligibilityProjectionInput,
  deps: LearningEligibilityDependencies = { identityKey: loadExistingProvenanceKeyReadOnly },
): LearningEligibilityProjectionResult {
  const maxMembers = input.maxMembers ?? MAX_MEMBERS;
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1 || maxMembers > MAX_MEMBERS ||
    !Array.isArray(input.records) ||
    typeof input.learningEpoch !== 'string' || input.learningEpoch.length < 1 ||
    input.learningEpoch.length > 128 || containsControlCharacters(input.learningEpoch)) {
    return { ok: false, reason: 'invalid-input' };
  }
  const productionRecords: TrajectoryRecord[] = [];
  for (const record of input.records) {
    if (!record || typeof record !== 'object' || !record.coverage ||
      typeof record.coverage.dispatch !== 'boolean') return { ok: false, reason: 'invalid-input' };
    if (!record.coverage.dispatch) continue;
    productionRecords.push(record);
    if (productionRecords.length > maxMembers) return { ok: false, reason: 'source-limit' };
  }

  let key: Buffer | null;
  try { key = deps.identityKey(); } catch { key = null; }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    return { ok: false, reason: 'identity-key-unavailable' };
  }

  const populationByProposal = memberByProposal(input.population);
  if (!populationByProposal) return { ok: false, reason: 'invalid-input' };
  // V2 populations are intentionally observation-only and denominator-incomplete.
  const denominatorComplete = false;
  const members: LearningEligibilityMemberV1[] = [];
  const seen = new Set<string>();

  for (const record of productionRecords) {
    const identity = identityOf(record);
    if (typeof identity !== 'string' || identity.length < 1 || identity.length > 4_096 ||
      containsControlCharacters(identity) ||
      (record.proposalId !== undefined && (typeof record.proposalId !== 'string' ||
        record.proposalId.length < 1 || record.proposalId.length > 4_096 ||
        containsControlCharacters(record.proposalId)))) return { ok: false, reason: 'invalid-input' };
    const subjectDigest = hmac(key, 'ashlr:learning-eligibility:subject:v1', identity);
    if (seen.has(subjectDigest)) return { ok: false, reason: 'duplicate-subject' };
    seen.add(subjectDigest);
    const proposalDigest = record.proposalId
      ? hmac(key, 'ashlr:post-merge-v2:proposal', record.proposalId)
      : undefined;
    const populationMember = proposalDigest ? populationByProposal.get(proposalDigest) : undefined;
    const source = sourceComplete(record);
    const stages: LearningEligibilityStagesV1 = {
      dispatch: 'observed',
      proposal: proposalStage(record),
      verification: verificationStage(record),
      decision: record.coverage.decision ? 'observed' : 'missing',
      terminal: terminalStage(record.terminalOutcome, populationMember),
      postMerge: populationMember?.classification ?? 'unobserved',
    };
    const selectionPropensityAvailable = hasRecordedSelectionPropensity(record);
    const codes = refusalCodes({
      record,
      stages,
      trajectorySourceComplete: input.trajectorySourceComplete,
      decisionSourceComplete: source.decision,
      agentActionSourceComplete: source.agentAction,
      denominatorComplete,
      selectionPropensityAvailable,
    });
    members.push({
      subjectDigest,
      ...(proposalDigest ? { proposalDigest } : {}),
      terminalOutcome: record.terminalOutcome,
      stages,
      selectionPropensityAvailable,
      refusalCodes: codes,
      policyEligible: false,
      recursiveLearningEligible: false,
    });
  }

  members.sort((left, right) => left.subjectDigest.localeCompare(right.subjectDigest));
  const refusalCounts: Partial<Record<LearningEligibilityRefusalCode, number>> = {};
  for (const member of members) {
    for (const code of member.refusalCodes) refusalCounts[code] = (refusalCounts[code] ?? 0) + 1;
  }
  const sourceCompleteValue = input.trajectorySourceComplete && members.every((member) =>
    !member.refusalCodes.includes('decision-source-incomplete') &&
    !member.refusalCodes.includes('agent-action-source-incomplete'));
  const selectionPropensityAvailable = members.length > 0 &&
    members.every((member) => member.selectionPropensityAvailable);
  const candidateSetDigest = sha([
    LEARNING_ELIGIBILITY_POLICY_VERSION,
    input.learningEpoch,
    sourceCompleteValue,
    denominatorComplete,
    members,
  ]);
  if (!DIGEST_RE.test(candidateSetDigest)) return { ok: false, reason: 'invalid-input' };

  return {
    ok: true,
    projection: {
      schemaVersion: 1,
      authority: 'observation-only',
      policyVersion: LEARNING_ELIGIBILITY_POLICY_VERSION,
      learningEpoch: input.learningEpoch,
      policyEligible: false,
      recursiveLearningEligible: false,
      denominatorComplete: false,
      sourceComplete: sourceCompleteValue,
      selectionPropensityAvailable,
      evaluated: members.length,
      refusalCounts,
      candidateSetDigest,
      members,
    },
  };
}
