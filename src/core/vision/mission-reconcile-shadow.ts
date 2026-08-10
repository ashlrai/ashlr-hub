/**
 * Read-only, observation-only mission reconciliation suggestions.
 *
 * The caller owns receipt authentication and current-source reads. This module
 * re-verifies the receipt with the existing read-only provenance key and accepts
 * normalized preview candidates,
 * then deterministically describes at most one action that existing policy
 * would create. It has no persistence, lock, planning, or execution authority.
 */

import { createHash } from 'node:crypto';

import {
  verifyMissionObservationReceipt,
  type MissionObservationReceiptV1,
} from './mission-receipt.js';

export const MISSION_RECONCILE_SUGGESTION_PROTOCOL = 'mission-reconcile-suggestion-v1' as const;
export const MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES = 24;
export const MAX_MISSION_RECONCILE_ACTIVE_GOAL_THRESHOLD = 1_000;

const SHA256_RE = /^[a-f0-9]{64}$/;
const NODE_KEY_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;

const SUGGESTION_KEYS = new Set([
  'schemaVersion', 'protocol', 'recordType', 'mode', 'authority',
  'planningAuthority', 'executionAuthority', 'proposalAuthority', 'agentAuthority',
  'mergeAuthority', 'releaseAuthority', 'deployAuthority', 'publicationAuthority',
  'externalMutationAuthority', 'budgetAuthority', 'learningAuthority', 'policyEligible',
  'basis', 'bounds', 'decision', 'effects', 'basisDigest', 'suggestionId', 'suggestionDigest',
]);
const BASIS_KEYS = new Set([
  'missionReceiptId', 'missionReceiptDigest', 'missionReceiptSnapshotDigest',
  'briefingDigest', 'graphDigest', 'missionKey', 'currentEnrollmentSourceDigest',
  'currentGoalSourceDigest', 'currentProposalSourceDigest', 'activeGoalThreshold',
]);
const BOUNDS_KEYS = new Set([
  'maxSuggestions', 'maxGoalCreations', 'previewCandidateLimit', 'activeGoalThreshold',
]);
const DECISION_KEYS = new Set(['disposition', 'reason', 'nodeKey', 'graphOrder']);
const EFFECT_KEYS = new Set([
  'goals', 'milestones', 'repositories', 'agents', 'proposals', 'merges',
  'releases', 'deployments', 'publications', 'externalMutations', 'policy', 'budgets',
]);

export type MissionReconcileMode = 'off' | 'shadow';

export type MissionReconcilePreviewHoldReason =
  | 'briefing-goal-cap'
  | 'goal-focus-cap'
  | 'duplicate-existing-goal'
  | 'goal-id-collision'
  | 'target-not-enrolled'
  | 'target-ambiguous'
  | 'target-invalid'
  | 'dependency-blocked'
  | 'human-gate-required'
  | 'mission-graph-invalid'
  | 'mission-reconcile-cap';

export type MissionReconcileShadowSkipReason =
  | 'mode-off'
  | 'receipt-missing'
  | 'receipt-invalid'
  | 'receipt-source-degraded'
  | 'receipt-binding-mismatch'
  | 'briefing-source-degraded'
  | 'enrollment-source-degraded'
  | 'goal-source-degraded'
  | 'proposal-source-degraded'
  | 'preview-invalid';

export type MissionReconcileShadowHoldReason =
  | MissionReconcilePreviewHoldReason
  | 'no-ready-node';

export type MissionReconcileShadowReason =
  | 'would-create'
  | MissionReconcileShadowHoldReason
  | MissionReconcileShadowSkipReason;

export interface MissionReconcileNormalizedSource {
  /** Missing is an authoritative empty source only when complete is true. */
  state: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  digest: string;
}

export interface MissionReconcilePreviewCandidate {
  /** Stable position in the validated ecosystem mission graph. */
  graphOrder: number;
  nodeKey: string;
  kind: 'work' | 'human-gate';
  disposition: 'create' | 'skip';
  reason: 'ready' | MissionReconcilePreviewHoldReason;
}

/**
 * `state:verified` declares the caller's source-quality result. The planner
 * still cryptographically verifies the supplied receipt using the read-only
 * receipt verifier, so a structurally similar assertion cannot unlock output.
 */
export type MissionReconcileReceiptEvidence =
  | { state: 'verified'; receipt: MissionObservationReceiptV1 }
  | { state: 'missing' | 'invalid' | 'source-degraded'; receipt: null };

export interface MissionReconcileCurrentPreview {
  missionKey: string;
  graphDigest: string;
  briefingDigest: string;
  briefingSource: MissionReconcileNormalizedSource;
  enrollmentSource: MissionReconcileNormalizedSource;
  goalSource: MissionReconcileNormalizedSource;
  proposalSource: MissionReconcileNormalizedSource;
  activeGoalThreshold: number;
  candidates: readonly MissionReconcilePreviewCandidate[];
}

export interface MissionReconcileShadowPlanInput {
  mode: unknown;
  receiptEvidence: MissionReconcileReceiptEvidence;
  current: MissionReconcileCurrentPreview;
}

export interface MissionReconcileSuggestionBasisV1 {
  missionReceiptId: string;
  missionReceiptDigest: string;
  missionReceiptSnapshotDigest: string;
  briefingDigest: string;
  graphDigest: string;
  missionKey: string;
  currentEnrollmentSourceDigest: string;
  currentGoalSourceDigest: string;
  currentProposalSourceDigest: string;
  activeGoalThreshold: number;
}

export interface MissionReconcileSuggestionV1 {
  schemaVersion: 1;
  protocol: typeof MISSION_RECONCILE_SUGGESTION_PROTOCOL;
  recordType: 'mission-reconcile-suggestion';
  mode: 'shadow';
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  agentAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
  budgetAuthority: false;
  learningAuthority: false;
  policyEligible: false;
  basis: MissionReconcileSuggestionBasisV1;
  bounds: {
    maxSuggestions: 1;
    maxGoalCreations: 0;
    previewCandidateLimit: typeof MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES;
    activeGoalThreshold: number;
  };
  decision: {
    disposition: 'would-create' | 'hold';
    reason: 'would-create' | MissionReconcileShadowHoldReason;
    nodeKey: string | null;
    graphOrder: number | null;
  };
  effects: {
    goals: false;
    milestones: false;
    repositories: false;
    agents: false;
    proposals: false;
    merges: false;
    releases: false;
    deployments: false;
    publications: false;
    externalMutations: false;
    policy: false;
    budgets: false;
  };
  basisDigest: string;
  suggestionId: string;
  suggestionDigest: string;
}

export type MissionReconcileShadowPlan =
  | {
      disposition: 'would-create';
      reason: 'would-create';
      suggestion: MissionReconcileSuggestionV1;
    }
  | {
      disposition: 'held';
      reason: MissionReconcileShadowHoldReason;
      suggestion: MissionReconcileSuggestionV1;
    }
  | {
      disposition: 'skipped';
      reason: MissionReconcileShadowSkipReason;
      suggestion: null;
    };

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor || !descriptor.enumerable || !('value' in descriptor);
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha(domain: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function sourceComplete(source: MissionReconcileNormalizedSource): boolean {
  return recordOf(source) !== null &&
    (source.state === 'missing' || source.state === 'healthy') &&
    source.complete === true && SHA256_RE.test(source.digest);
}

function receiptBoundaryValid(receipt: MissionObservationReceiptV1): boolean {
  return recordOf(receipt) !== null && receipt.schemaVersion === 1 &&
    receipt.protocol === 'mission-observation-receipt-v1' &&
    receipt.recordType === 'mission-observation' && receipt.authority === 'observation-only' &&
    receipt.planningAuthority === false && receipt.executionAuthority === false &&
    receipt.proposalAuthority === false && receipt.mergeAuthority === false &&
    receipt.releaseAuthority === false && receipt.deployAuthority === false &&
    receipt.externalMutationAuthority === false && receipt.learningAuthority === false &&
    receipt.policyEligible === false && receipt.sourceComplete === true &&
    receipt.captureKind === 'explicit-reconcile' &&
    receipt.humanDecisionEvidenceComplete === false && receipt.outcomeEvidenceComplete === false &&
    SHA256_RE.test(receipt.graphDigest) && SHA256_RE.test(receipt.briefingDigest) &&
    SHA256_RE.test(receipt.snapshotDigest) && SHA256_RE.test(receipt.receiptId) &&
    SHA256_RE.test(receipt.receiptDigest) && NODE_KEY_RE.test(receipt.missionKey);
}

function normalizedCandidate(candidate: MissionReconcilePreviewCandidate): boolean {
  if (!recordOf(candidate) || !Number.isSafeInteger(candidate.graphOrder) ||
    candidate.graphOrder < 0 || candidate.graphOrder >= MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES ||
    !NODE_KEY_RE.test(candidate.nodeKey) ||
    (candidate.kind !== 'work' && candidate.kind !== 'human-gate')) return false;
  if (candidate.disposition === 'create') {
    return candidate.kind === 'work' && candidate.reason === 'ready';
  }
  return candidate.disposition === 'skip' && candidate.reason !== 'ready' &&
    PREVIEW_HOLD_REASONS.has(candidate.reason);
}

const PREVIEW_HOLD_REASONS = new Set<MissionReconcilePreviewHoldReason>([
  'briefing-goal-cap', 'goal-focus-cap', 'duplicate-existing-goal', 'goal-id-collision',
  'target-not-enrolled', 'target-ambiguous', 'target-invalid', 'dependency-blocked',
  'human-gate-required', 'mission-graph-invalid', 'mission-reconcile-cap',
]);

const HOLD_REASONS = new Set<MissionReconcileShadowHoldReason>([
  ...PREVIEW_HOLD_REASONS,
  'no-ready-node',
]);

function normalizedCandidates(
  candidates: readonly MissionReconcilePreviewCandidate[],
): MissionReconcilePreviewCandidate[] | null {
  if (!Array.isArray(candidates) || candidates.length > MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES) {
    return null;
  }
  const output = [...candidates];
  if (output.some((candidate) => !normalizedCandidate(candidate))) return null;
  output.sort((left, right) => left.graphOrder - right.graphOrder ||
    codeUnitCompare(left.nodeKey, right.nodeKey));
  for (let index = 1; index < output.length; index += 1) {
    if (output[index]!.graphOrder === output[index - 1]!.graphOrder ||
      output[index]!.nodeKey === output[index - 1]!.nodeKey) return null;
  }
  return output;
}

function basisPayload(basis: MissionReconcileSuggestionBasisV1): unknown[] {
  return [
    basis.missionReceiptId, basis.missionReceiptDigest, basis.missionReceiptSnapshotDigest,
    basis.briefingDigest, basis.graphDigest, basis.missionKey,
    basis.currentEnrollmentSourceDigest, basis.currentGoalSourceDigest,
    basis.currentProposalSourceDigest, basis.activeGoalThreshold,
  ];
}

type UnsignedSuggestion = Omit<MissionReconcileSuggestionV1, 'suggestionDigest'>;

function suggestionPayload(suggestion: UnsignedSuggestion): unknown[] {
  return [
    suggestion.schemaVersion, suggestion.protocol, suggestion.recordType, suggestion.mode,
    suggestion.authority, suggestion.planningAuthority, suggestion.executionAuthority,
    suggestion.proposalAuthority, suggestion.agentAuthority, suggestion.mergeAuthority,
    suggestion.releaseAuthority, suggestion.deployAuthority, suggestion.publicationAuthority,
    suggestion.externalMutationAuthority, suggestion.budgetAuthority, suggestion.learningAuthority,
    suggestion.policyEligible, basisPayload(suggestion.basis),
    [
      suggestion.bounds.maxSuggestions, suggestion.bounds.maxGoalCreations,
      suggestion.bounds.previewCandidateLimit, suggestion.bounds.activeGoalThreshold,
    ],
    [
      suggestion.decision.disposition, suggestion.decision.reason,
      suggestion.decision.nodeKey, suggestion.decision.graphOrder,
    ],
    Object.values(suggestion.effects), suggestion.basisDigest, suggestion.suggestionId,
  ];
}

function buildSuggestion(
  receipt: MissionObservationReceiptV1,
  current: MissionReconcileCurrentPreview,
  decision: MissionReconcileSuggestionV1['decision'],
): MissionReconcileSuggestionV1 {
  const basis: MissionReconcileSuggestionBasisV1 = {
    missionReceiptId: receipt.receiptId,
    missionReceiptDigest: receipt.receiptDigest,
    missionReceiptSnapshotDigest: receipt.snapshotDigest,
    briefingDigest: current.briefingDigest,
    graphDigest: current.graphDigest,
    missionKey: current.missionKey,
    currentEnrollmentSourceDigest: current.enrollmentSource.digest,
    currentGoalSourceDigest: current.goalSource.digest,
    currentProposalSourceDigest: current.proposalSource.digest,
    activeGoalThreshold: current.activeGoalThreshold,
  };
  const basisDigest = sha('ashlr:mission-reconcile:basis:v1', basisPayload(basis));
  const suggestionId = sha('ashlr:mission-reconcile:suggestion-id:v1', [
    basisDigest, decision.disposition, decision.reason, decision.nodeKey, decision.graphOrder,
  ]);
  const unsigned: UnsignedSuggestion = {
    schemaVersion: 1,
    protocol: MISSION_RECONCILE_SUGGESTION_PROTOCOL,
    recordType: 'mission-reconcile-suggestion',
    mode: 'shadow',
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    agentAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    publicationAuthority: false,
    externalMutationAuthority: false,
    budgetAuthority: false,
    learningAuthority: false,
    policyEligible: false,
    basis,
    bounds: {
      maxSuggestions: 1,
      maxGoalCreations: 0,
      previewCandidateLimit: MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES,
      activeGoalThreshold: current.activeGoalThreshold,
    },
    decision,
    effects: {
      goals: false,
      milestones: false,
      repositories: false,
      agents: false,
      proposals: false,
      merges: false,
      releases: false,
      deployments: false,
      publications: false,
      externalMutations: false,
      policy: false,
      budgets: false,
    },
    basisDigest,
    suggestionId,
  };
  return {
    ...unsigned,
    suggestionDigest: sha('ashlr:mission-reconcile:suggestion:v1', suggestionPayload(unsigned)),
  };
}

/** Resolve only the exact opt-in token. Unknown or malformed values fail closed. */
export function resolveMissionReconcileMode(value: unknown): MissionReconcileMode {
  return value === 'shadow' ? 'shadow' : 'off';
}

/**
 * Produce one deterministic, non-authoritative suggestion from current source
 * evidence. Historical receipt node states never participate in readiness.
 */
export function planMissionReconcileShadow(
  input: MissionReconcileShadowPlanInput,
): MissionReconcileShadowPlan {
  if (resolveMissionReconcileMode(input.mode) !== 'shadow') {
    return { disposition: 'skipped', reason: 'mode-off', suggestion: null };
  }
  if (input.receiptEvidence.state !== 'verified') {
    const reason = input.receiptEvidence.state === 'missing'
      ? 'receipt-missing'
      : input.receiptEvidence.state === 'source-degraded'
        ? 'receipt-source-degraded'
        : 'receipt-invalid';
    return { disposition: 'skipped', reason, suggestion: null };
  }
  const receipt = verifyMissionObservationReceipt(input.receiptEvidence.receipt);
  if (!receipt || !receiptBoundaryValid(receipt)) {
    return { disposition: 'skipped', reason: 'receipt-invalid', suggestion: null };
  }
  const current = input.current;
  if (!sourceComplete(current.briefingSource) ||
    current.briefingSource.digest !== current.briefingDigest) {
    return { disposition: 'skipped', reason: 'briefing-source-degraded', suggestion: null };
  }
  if (!sourceComplete(current.enrollmentSource)) {
    return { disposition: 'skipped', reason: 'enrollment-source-degraded', suggestion: null };
  }
  if (!sourceComplete(current.goalSource)) {
    return { disposition: 'skipped', reason: 'goal-source-degraded', suggestion: null };
  }
  if (!sourceComplete(current.proposalSource)) {
    return { disposition: 'skipped', reason: 'proposal-source-degraded', suggestion: null };
  }
  if (!NODE_KEY_RE.test(current.missionKey) || !SHA256_RE.test(current.graphDigest) ||
    !SHA256_RE.test(current.briefingDigest) || receipt.missionKey !== current.missionKey ||
    receipt.graphDigest !== current.graphDigest || receipt.briefingDigest !== current.briefingDigest) {
    return { disposition: 'skipped', reason: 'receipt-binding-mismatch', suggestion: null };
  }
  if (!Number.isSafeInteger(current.activeGoalThreshold) || current.activeGoalThreshold < 1 ||
    current.activeGoalThreshold > MAX_MISSION_RECONCILE_ACTIVE_GOAL_THRESHOLD) {
    return { disposition: 'skipped', reason: 'preview-invalid', suggestion: null };
  }
  const candidates = normalizedCandidates(current.candidates);
  if (!candidates) {
    return { disposition: 'skipped', reason: 'preview-invalid', suggestion: null };
  }
  const ready = candidates.find((candidate) => candidate.disposition === 'create');
  if (ready) {
    const suggestion = buildSuggestion(receipt, current, {
      disposition: 'would-create',
      reason: 'would-create',
      nodeKey: ready.nodeKey,
      graphOrder: ready.graphOrder,
    });
    return { disposition: 'would-create', reason: 'would-create', suggestion };
  }
  const first = candidates[0];
  const reason = first?.reason === undefined || first.reason === 'ready'
    ? 'no-ready-node'
    : first.reason;
  const suggestion = buildSuggestion(receipt, current, {
    disposition: 'hold',
    reason,
    nodeKey: first?.nodeKey ?? null,
    graphOrder: first?.graphOrder ?? null,
  });
  return { disposition: 'held', reason, suggestion };
}

function parseBasis(value: unknown): MissionReconcileSuggestionBasisV1 | null {
  const row = recordOf(value);
  if (!row || !exactKeys(row, BASIS_KEYS) || typeof row['missionKey'] !== 'string' ||
    !NODE_KEY_RE.test(row['missionKey']) || !Number.isSafeInteger(row['activeGoalThreshold']) ||
    (row['activeGoalThreshold'] as number) < 1 ||
    (row['activeGoalThreshold'] as number) > MAX_MISSION_RECONCILE_ACTIVE_GOAL_THRESHOLD) return null;
  for (const key of BASIS_KEYS) {
    if (key === 'missionKey' || key === 'activeGoalThreshold') continue;
    if (typeof row[key] !== 'string' || !SHA256_RE.test(row[key])) return null;
  }
  return {
    missionReceiptId: row['missionReceiptId'] as string,
    missionReceiptDigest: row['missionReceiptDigest'] as string,
    missionReceiptSnapshotDigest: row['missionReceiptSnapshotDigest'] as string,
    briefingDigest: row['briefingDigest'] as string,
    graphDigest: row['graphDigest'] as string,
    missionKey: row['missionKey'] as string,
    currentEnrollmentSourceDigest: row['currentEnrollmentSourceDigest'] as string,
    currentGoalSourceDigest: row['currentGoalSourceDigest'] as string,
    currentProposalSourceDigest: row['currentProposalSourceDigest'] as string,
    activeGoalThreshold: row['activeGoalThreshold'] as number,
  };
}

/** Strictly reconstruct a canonical all-false suggestion; unknown fields fail closed. */
export function verifyMissionReconcileSuggestion(value: unknown): MissionReconcileSuggestionV1 | null {
  const row = recordOf(value);
  if (!row || !exactKeys(row, SUGGESTION_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== MISSION_RECONCILE_SUGGESTION_PROTOCOL ||
    row['recordType'] !== 'mission-reconcile-suggestion' || row['mode'] !== 'shadow' ||
    row['authority'] !== 'observation-only' || row['planningAuthority'] !== false ||
    row['executionAuthority'] !== false || row['proposalAuthority'] !== false ||
    row['agentAuthority'] !== false || row['mergeAuthority'] !== false ||
    row['releaseAuthority'] !== false || row['deployAuthority'] !== false ||
    row['publicationAuthority'] !== false || row['externalMutationAuthority'] !== false ||
    row['budgetAuthority'] !== false || row['learningAuthority'] !== false ||
    row['policyEligible'] !== false) return null;

  const basis = parseBasis(row['basis']);
  const bounds = recordOf(row['bounds']);
  const decision = recordOf(row['decision']);
  const effects = recordOf(row['effects']);
  if (!basis || !bounds || !exactKeys(bounds, BOUNDS_KEYS) || bounds['maxSuggestions'] !== 1 ||
    bounds['maxGoalCreations'] !== 0 ||
    bounds['previewCandidateLimit'] !== MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES ||
    !Number.isSafeInteger(bounds['activeGoalThreshold']) ||
    (bounds['activeGoalThreshold'] as number) < 1 ||
    (bounds['activeGoalThreshold'] as number) > MAX_MISSION_RECONCILE_ACTIVE_GOAL_THRESHOLD ||
    bounds['activeGoalThreshold'] !== basis.activeGoalThreshold ||
    !decision || !exactKeys(decision, DECISION_KEYS) || !effects || !exactKeys(effects, EFFECT_KEYS) ||
    Object.values(effects).some((effect) => effect !== false)) return null;

  const disposition = decision['disposition'];
  const reason = decision['reason'];
  const nodeKey = decision['nodeKey'];
  const graphOrder = decision['graphOrder'];
  const wouldCreate = disposition === 'would-create' && reason === 'would-create' &&
    typeof nodeKey === 'string' && NODE_KEY_RE.test(nodeKey) && Number.isSafeInteger(graphOrder) &&
    (graphOrder as number) >= 0 && (graphOrder as number) < MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES;
  const hold = disposition === 'hold' && typeof reason === 'string' &&
    HOLD_REASONS.has(reason as MissionReconcileShadowHoldReason) &&
    ((nodeKey === null && graphOrder === null && reason === 'no-ready-node') ||
      (typeof nodeKey === 'string' && NODE_KEY_RE.test(nodeKey) && Number.isSafeInteger(graphOrder) &&
        (graphOrder as number) >= 0 && (graphOrder as number) < MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES));
  if (!wouldCreate && !hold) return null;

  const basisDigest = sha('ashlr:mission-reconcile:basis:v1', basisPayload(basis));
  const suggestionId = sha('ashlr:mission-reconcile:suggestion-id:v1', [
    basisDigest, disposition, reason, nodeKey, graphOrder,
  ]);
  if (row['basisDigest'] !== basisDigest || row['suggestionId'] !== suggestionId ||
    typeof row['suggestionDigest'] !== 'string' || !SHA256_RE.test(row['suggestionDigest'])) return null;

  const unsigned: UnsignedSuggestion = {
    schemaVersion: 1,
    protocol: MISSION_RECONCILE_SUGGESTION_PROTOCOL,
    recordType: 'mission-reconcile-suggestion',
    mode: 'shadow',
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    agentAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    publicationAuthority: false,
    externalMutationAuthority: false,
    budgetAuthority: false,
    learningAuthority: false,
    policyEligible: false,
    basis,
    bounds: {
      maxSuggestions: 1,
      maxGoalCreations: 0,
      previewCandidateLimit: MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES,
      activeGoalThreshold: bounds['activeGoalThreshold'] as number,
    },
    decision: {
      disposition: disposition as 'would-create' | 'hold',
      reason: reason as 'would-create' | MissionReconcileShadowHoldReason,
      nodeKey: nodeKey as string | null,
      graphOrder: graphOrder as number | null,
    },
    effects: {
      goals: false,
      milestones: false,
      repositories: false,
      agents: false,
      proposals: false,
      merges: false,
      releases: false,
      deployments: false,
      publications: false,
      externalMutations: false,
      policy: false,
      budgets: false,
    },
    basisDigest,
    suggestionId,
  };
  const suggestionDigest = sha('ashlr:mission-reconcile:suggestion:v1', suggestionPayload(unsigned));
  return row['suggestionDigest'] === suggestionDigest
    ? { ...unsigned, suggestionDigest }
    : null;
}
