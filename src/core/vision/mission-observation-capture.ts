/**
 * Read-only evidence adapter from complete, evidence-normalized authority
 * snapshots to the deliberately authority-free Mission Receipt V1 input
 * contract. Authenticated merge verification may consult read-only Git
 * authority; this module performs no persistence or external mutation.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import type { Goal, Milestone, Proposal, ProposalVerifyResult, RealizedMergeEvidence } from '../types.js';
import type { ListGoalsDetailedResult } from '../goals/store.js';
import { proposalCompletesGoalMilestone } from '../goals/completion.js';
import type { ProposalsReadResult } from '../inbox/store.js';
import { authenticatedRealizedMergeOf } from '../inbox/realized-merge.js';
import type { EnrollmentRegistrySnapshot } from '../sandbox/policy.js';
import {
  projectEcosystemMissionGraph,
  validateEcosystemMissionGraph,
  type EcosystemMissionGraphV1,
  type MissionNodeObservation,
} from './mission-graph.js';
import {
  missionObservationBriefingDigest,
  type MissionObservationMilestoneInput,
  type MissionObservationNodeInput,
  type MissionObservationReceiptInput,
  type MissionObservationSourceInput,
} from './mission-receipt.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_REPO_BYTES = 4_096;
const MAX_GOALS = 512;
const MAX_PROPOSALS = 4_096;
const MAX_MILESTONES = 512;
const MAX_VERIFICATION_RUNS = 128;
const MAX_VERIFICATION_COMMAND_ARGS = 64;
const MAX_VERIFICATION_COMMAND_ARG_BYTES = 4_096;
const MAX_VERIFICATION_SOURCE_BYTES = 1_024;
const MAX_VERIFICATION_TIMEOUT_MS = 86_400_000;
const MAX_RECORD_CANONICAL_BYTES = 64 * 1024;
const CAPTURE_KEYS = new Set([
  'recordedAt', 'graph', 'briefing', 'briefingQuality', 'enrollment', 'goals', 'proposals',
]);
const BRIEFING_QUALITY_KEYS = new Set(['sourceState', 'sourcePresent', 'complete']);
const VERIFICATION_RUN_KEYS = new Set([
  'id', 'kind', 'cmd', 'cwd', 'timeoutMs', 'required', 'profiles',
]);

export interface MissionBriefingSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
}

export interface MissionObservationCaptureInput {
  recordedAt: string;
  graph: EcosystemMissionGraphV1;
  briefing: unknown;
  briefingQuality: MissionBriefingSourceQuality;
  enrollment: EnrollmentRegistrySnapshot;
  goals: ListGoalsDetailedResult;
  proposals: ProposalsReadResult;
}

export type MissionObservationCaptureFailureReason =
  | 'invalid-input'
  | 'invalid-recorded-at'
  | 'invalid-graph'
  | 'invalid-briefing'
  | 'briefing-source-incomplete'
  | 'enrollment-source-incomplete'
  | 'repository-not-enrolled'
  | 'goal-source-incomplete'
  | 'proposal-source-incomplete'
  | 'inventory-out-of-bounds'
  | 'invalid-goal-evidence'
  | 'invalid-proposal-evidence'
  | 'duplicate-goal-id'
  | 'duplicate-proposal-id'
  | 'ambiguous-mission-goal-binding'
  | 'invalid-mission-goal-binding'
  | 'linked-proposal-missing'
  | 'linked-proposal-repository-mismatch'
  | 'projection-failed'
  | 'projection-evidence-conflict';

export type MissionObservationCaptureResult =
  | { ok: true; receiptInput: MissionObservationReceiptInput }
  | { ok: false; reason: MissionObservationCaptureFailureReason };

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function canonicalJson(value: Canonical): string | null {
  try {
    const json = JSON.stringify(value);
    return Buffer.byteLength(json, 'utf8') <= MAX_RECORD_CANONICAL_BYTES ? json : null;
  } catch {
    return null;
  }
}

function digest(domain: string, value: Canonical): string | null {
  const canonical = canonicalJson(value);
  return canonical === null ? null : createHash('sha256').update(domain).update('\0').update(canonical).digest('hex');
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectionDigest(
  domain: string,
  sourceState: MissionObservationSourceInput['sourceState'],
  recordDigests: readonly string[],
): string {
  const hash = createHash('sha256').update(domain).update('\0').update(sourceState).update('\0');
  for (const item of [...recordDigests].sort(codeUnitCompare)) hash.update(item).update('\n');
  return hash.digest('hex');
}

function boundedString(value: unknown, maxBytes = MAX_IDENTIFIER_BYTES): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!boundedString(value) || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function canonicalRepo(value: unknown): value is string {
  return boundedString(value, MAX_REPO_BYTES) && isAbsolute(value) && resolve(value) === value;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function briefingQualityHealthy(value: unknown): value is MissionBriefingSourceQuality {
  const source = recordOf(value);
  return source !== null && exactKeys(source, BRIEFING_QUALITY_KEYS) && source['sourceState'] === 'healthy' &&
    source['sourcePresent'] === true && source['complete'] === true;
}

function sourceInput(
  sourceState: 'missing' | 'healthy',
  digestValue: string,
): MissionObservationSourceInput {
  return { sourceState, complete: true, digest: digestValue };
}

function enrollmentDigest(snapshot: EnrollmentRegistrySnapshot): { digest: string; repos: Set<string> } | null {
  if (snapshot.state !== 'ready' || !Array.isArray(snapshot.repos) || snapshot.repos.length > MAX_PROPOSALS) return null;
  const repos = new Set<string>();
  for (const repo of snapshot.repos) {
    if (!canonicalRepo(repo) || repos.has(repo)) return null;
    repos.add(repo);
  }
  const value = digest('ashlr:mission-observation:enrollment-source:v1', [...repos].sort(codeUnitCompare));
  return value === null ? null : { digest: value, repos };
}

function validMilestone(milestone: Milestone): boolean {
  return boundedString(milestone.id) && boundedString(milestone.title, 4_000) &&
    boundedString(milestone.detail, 16_000) && Number.isSafeInteger(milestone.order) &&
    new Set(['pending', 'in-progress', 'proposed', 'paused', 'skipped', 'blocked', 'done']).has(milestone.status) &&
    (milestone.specId === null || boundedString(milestone.specId)) &&
    (milestone.swarmId === null || boundedString(milestone.swarmId)) &&
    (milestone.proposalId === null || boundedString(milestone.proposalId)) &&
    canonicalTimestamp(milestone.createdAt) && canonicalTimestamp(milestone.updatedAt);
}

function milestoneEvidenceDigest(milestone: Milestone): string | null {
  if (!validMilestone(milestone)) return null;
  return digest('ashlr:mission-observation:milestone-record:v1', [
    milestone.id, milestone.order, milestone.status, milestone.specId, milestone.swarmId,
    milestone.proposalId, milestone.createdAt, milestone.updatedAt,
  ]);
}

function goalEvidenceDigest(goal: Goal): string | null {
  if (!boundedString(goal.id) || !boundedString(goal.objective, 4_000) ||
    (goal.project !== null && !canonicalRepo(goal.project)) ||
    !new Set(['planning', 'active', 'paused', 'done', 'archived']).has(goal.status) ||
    !Array.isArray(goal.milestones) || goal.milestones.length > MAX_MILESTONES ||
    !canonicalTimestamp(goal.createdAt) || !canonicalTimestamp(goal.updatedAt)) return null;
  const milestoneIds = new Set<string>();
  const milestones: string[] = [];
  for (const milestone of goal.milestones) {
    if (!validMilestone(milestone) || milestoneIds.has(milestone.id)) return null;
    milestoneIds.add(milestone.id);
    const milestoneDigest = milestoneEvidenceDigest(milestone);
    if (milestoneDigest === null) return null;
    milestones.push(milestoneDigest);
  }
  milestones.sort(codeUnitCompare);
  const objectiveDigest = digest('ashlr:mission-observation:goal-objective:v1', goal.objective);
  if (objectiveDigest === null) return null;
  return digest('ashlr:mission-observation:goal-record:v1', [
    goal.id, objectiveDigest, goal.project, goal.status,
    goal.mission === undefined ? null : [
      goal.mission.schemaVersion, goal.mission.graphDigest, goal.mission.missionKey, goal.mission.nodeKey,
    ],
    milestones, goal.createdAt, goal.updatedAt,
  ]);
}

function verificationEvidenceDigest(value: ProposalVerifyResult | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value.passed !== 'boolean') return null;
  if (value.diffHash !== undefined && !SHA256_RE.test(value.diffHash)) return null;
  if (value.baseHead !== undefined && !REVISION_RE.test(value.baseHead)) return null;
  if (value.verifiedAt !== undefined && !canonicalTimestamp(value.verifiedAt)) return null;
  if (value.source !== undefined && !boundedString(value.source, MAX_VERIFICATION_SOURCE_BYTES)) return null;
  if (value.ran !== undefined && (!Array.isArray(value.ran) || value.ran.length > MAX_VERIFICATION_RUNS)) return null;
  const ran: Canonical[] = [];
  for (const entry of value.ran ?? []) {
    const row = recordOf(entry);
    if (row === null || Object.keys(row).some((key) => !VERIFICATION_RUN_KEYS.has(key)) ||
      !new Set(['typecheck', 'lint', 'build', 'test']).has(entry.kind) ||
      !Array.isArray(entry.cmd) || entry.cmd.length < 1 || entry.cmd.length > MAX_VERIFICATION_COMMAND_ARGS ||
      entry.cmd.some((arg) => typeof arg !== 'string' || Buffer.byteLength(arg, 'utf8') > MAX_VERIFICATION_COMMAND_ARG_BYTES) ||
      (entry.id !== undefined && !boundedString(entry.id)) ||
      (entry.cwd !== undefined && !canonicalRepo(entry.cwd)) ||
      (entry.timeoutMs !== undefined && (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1 ||
        entry.timeoutMs > MAX_VERIFICATION_TIMEOUT_MS)) ||
      (entry.required !== undefined && typeof entry.required !== 'boolean') ||
      (entry.profiles !== undefined && (!Array.isArray(entry.profiles) || entry.profiles.length > 3 ||
        new Set(entry.profiles).size !== entry.profiles.length ||
        entry.profiles.some((profile) => !new Set(['quick', 'merge', 'deep']).has(profile))))) return null;
    const commandDigest = digest('ashlr:mission-observation:verification-command:v1', entry.cmd);
    if (commandDigest === null) return null;
    ran.push([
      entry.kind, commandDigest, entry.id ?? null, entry.cwd ?? null, entry.timeoutMs ?? null,
      entry.required ?? null, entry.profiles === undefined ? [] : [...entry.profiles].sort(codeUnitCompare),
    ]);
  }
  return digest('ashlr:mission-observation:verification:v1', [
    value.passed, value.diffHash ?? null, value.baseHead ?? null, value.verifiedAt ?? null,
    value.source ?? null, ran,
  ]);
}

function mergeEvidenceDigest(evidence: RealizedMergeEvidence | null): string | null {
  if (evidence === null) return null;
  return evidence.source === 'local-default-branch'
    ? digest('ashlr:mission-observation:realized-merge:v1', [
      evidence.source, evidence.base, evidence.baseBeforeOid, evidence.proposalHeadOid,
      evidence.mergeCommitOid, evidence.observedAt, evidence.proposalId ?? null,
      evidence.diffHash ?? null, evidence.intentAttestation ?? null, evidence.attestation ?? null,
    ])
    : digest('ashlr:mission-observation:realized-merge:v1', [
      evidence.source, evidence.provider, evidence.prUrl, evidence.branch, evidence.base,
      evidence.expectedHeadOid, evidence.mergeCommitOid, evidence.mergedAt,
      evidence.reconciliation.observedAt, evidence.reconciliation.attestation,
    ]);
}

interface ProposalEvidence {
  proposal: Proposal;
  sourceDigest: string;
  verificationDigest: string | null;
  merge: RealizedMergeEvidence | null;
  mergeDigest: string | null;
}

function proposalEvidence(proposal: Proposal): ProposalEvidence | null {
  if (!boundedString(proposal.id) || (proposal.repo !== null && !canonicalRepo(proposal.repo)) ||
    !new Set(['pending', 'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed']).has(proposal.status) ||
    !canonicalTimestamp(proposal.createdAt) || (proposal.diffHash !== undefined && !SHA256_RE.test(proposal.diffHash))) return null;
  const verificationDigest = verificationEvidenceDigest(proposal.verifyResult);
  if (proposal.verifyResult !== undefined && verificationDigest === null) return null;
  const merge = authenticatedRealizedMergeOf(proposal);
  const mergeDigest = mergeEvidenceDigest(merge);
  if (merge !== null && mergeDigest === null) return null;
  const sourceDigest = digest('ashlr:mission-observation:proposal-record:v1', [
    proposal.id, proposal.repo, proposal.status, proposal.diffHash ?? null,
    verificationDigest, mergeDigest, proposal.createdAt,
  ]);
  return sourceDigest === null ? null : { proposal, sourceDigest, verificationDigest, merge, mergeDigest };
}

function completeGoalInventory(value: ListGoalsDetailedResult): 'missing' | 'healthy' | null {
  if (!Array.isArray(value.goals) || value.complete !== true || value.unreadableFiles !== 0 ||
    value.limitExceeded !== false || !validCount(value.scannedFiles) || value.scannedFiles !== value.goals.length) return null;
  if (value.sourceState === 'missing' && value.sourcePresent === false && value.goals.length === 0) return 'missing';
  return value.sourceState === 'healthy' && value.sourcePresent === true ? 'healthy' : null;
}

function completeProposalInventory(value: ProposalsReadResult): 'missing' | 'healthy' | null {
  if (!Array.isArray(value.proposals) || !Array.isArray(value.stopReasons) || value.complete !== true ||
    value.stopReasons.length !== 0 || value.invalidFiles !== 0 || value.unreadableFiles !== 0 ||
    !validCount(value.filesDiscovered) || !validCount(value.filesRead) || !validCount(value.bytesRead) ||
    value.filesDiscovered !== value.filesRead || value.filesRead !== value.proposals.length) return null;
  if (value.sourceState === 'missing' && value.sourcePresent === false && value.proposals.length === 0 &&
    value.bytesRead === 0) return 'missing';
  return value.sourceState === 'healthy' && value.sourcePresent === true ? 'healthy' : null;
}

function missionGoalForNode(goals: readonly Goal[], graph: EcosystemMissionGraphV1, nodeKey: string): Goal | null | 'ambiguous' {
  const matches = goals.filter((goal) => goal.mission?.schemaVersion === 1 &&
    goal.mission.graphDigest === graph.graphDigest && goal.mission.missionKey === graph.missionKey &&
    goal.mission.nodeKey === nodeKey);
  return matches.length > 1 ? 'ambiguous' : matches[0] ?? null;
}

function observedState(goal: Goal | null, milestones: readonly MissionObservationMilestoneInput[]): MissionNodeObservation['state'] | undefined {
  if (goal === null) return undefined;
  const required = milestones.filter((milestone) => milestone.status !== 'skipped');
  if (required.length > 0 && required.every((milestone) => milestone.proposalStatus === 'applied' &&
    milestone.verificationPassed && milestone.realizedMergeDigest !== null)) return 'realized';
  if (milestones.some((milestone) => milestone.status === 'blocked' || milestone.proposalStatus === 'failed')) return 'failed';
  if (milestones.some((milestone) => milestone.status === 'proposed' || milestone.proposalId !== null)) return 'proposed';
  return 'active';
}

/** Capture a replay-stable, evidence-only receipt input or an explicit fail-closed reason. */
export function captureMissionObservation(
  input: MissionObservationCaptureInput,
): MissionObservationCaptureResult {
  try {
    const inputRecord = recordOf(input);
    if (inputRecord === null || !exactKeys(inputRecord, CAPTURE_KEYS)) return { ok: false, reason: 'invalid-input' };
    if (!canonicalTimestamp(input.recordedAt)) return { ok: false, reason: 'invalid-recorded-at' };
    if (validateEcosystemMissionGraph(input.graph).length > 0) return { ok: false, reason: 'invalid-graph' };
    const briefingDigest = missionObservationBriefingDigest(input.briefing);
    if (briefingDigest === null) return { ok: false, reason: 'invalid-briefing' };
    if (!briefingQualityHealthy(input.briefingQuality)) return { ok: false, reason: 'briefing-source-incomplete' };

    const enrollment = enrollmentDigest(input.enrollment);
    if (enrollment === null) return { ok: false, reason: 'enrollment-source-incomplete' };
    if (input.graph.nodes.some((node) => node.kind === 'work' && (node.repo === null || !enrollment.repos.has(node.repo)))) {
      return { ok: false, reason: 'repository-not-enrolled' };
    }
    const goalSourceState = completeGoalInventory(input.goals);
    if (goalSourceState === null) return { ok: false, reason: 'goal-source-incomplete' };
    const proposalSourceState = completeProposalInventory(input.proposals);
    if (proposalSourceState === null) return { ok: false, reason: 'proposal-source-incomplete' };
    if (input.goals.goals.length > MAX_GOALS || input.proposals.proposals.length > MAX_PROPOSALS) {
      return { ok: false, reason: 'inventory-out-of-bounds' };
    }
    let totalMilestones = 0;
    for (const goal of input.goals.goals) {
      if (!Array.isArray(goal.milestones)) continue;
      totalMilestones += goal.milestones.length;
      if (totalMilestones > MAX_MILESTONES) return { ok: false, reason: 'inventory-out-of-bounds' };
    }

    const goalDigestById = new Map<string, string>();
    for (const goal of input.goals.goals) {
      if (goalDigestById.has(goal.id)) return { ok: false, reason: 'duplicate-goal-id' };
      const goalDigest = goalEvidenceDigest(goal);
      if (goalDigest === null) return { ok: false, reason: 'invalid-goal-evidence' };
      goalDigestById.set(goal.id, goalDigest);
    }
    const proposalById = new Map<string, ProposalEvidence>();
    for (const proposal of input.proposals.proposals) {
      if (proposalById.has(proposal.id)) return { ok: false, reason: 'duplicate-proposal-id' };
      const evidence = proposalEvidence(proposal);
      if (evidence === null) return { ok: false, reason: 'invalid-proposal-evidence' };
      proposalById.set(proposal.id, evidence);
    }

    const nodesWithoutProjection: Array<Omit<MissionObservationNodeInput, 'status' | 'blockedBy'>> = [];
    const observations: MissionNodeObservation[] = [];
    for (const node of input.graph.nodes) {
      if (node.kind === 'human-gate') {
        nodesWithoutProjection.push({ nodeKey: node.key, kind: node.kind, goalId: null, goalRecordDigest: null, milestones: [] });
        continue;
      }
      const conflictingBinding = input.goals.goals.some((candidate) => candidate.mission !== undefined &&
        candidate.mission.nodeKey === node.key &&
        (candidate.mission.graphDigest === input.graph.graphDigest || candidate.mission.missionKey === input.graph.missionKey) &&
        (candidate.mission.schemaVersion !== 1 || candidate.mission.graphDigest !== input.graph.graphDigest ||
          candidate.mission.missionKey !== input.graph.missionKey));
      if (conflictingBinding) return { ok: false, reason: 'invalid-mission-goal-binding' };
      const goal = missionGoalForNode(input.goals.goals, input.graph, node.key);
      if (goal === 'ambiguous') return { ok: false, reason: 'ambiguous-mission-goal-binding' };
      if (goal !== null && (goal.project !== node.repo || goal.objective !== node.objective)) {
        return { ok: false, reason: 'invalid-mission-goal-binding' };
      }
      const milestones: MissionObservationMilestoneInput[] = [];
      for (const milestone of goal?.milestones ?? []) {
        const linked = milestone.proposalId === null ? null : proposalById.get(milestone.proposalId);
        if (milestone.proposalId !== null && linked === undefined) return { ok: false, reason: 'linked-proposal-missing' };
        if (linked && linked.proposal.repo !== node.repo) return { ok: false, reason: 'linked-proposal-repository-mismatch' };
        const complete = linked !== null && linked !== undefined && linked.merge !== null &&
          proposalCompletesGoalMilestone(linked.proposal);
        milestones.push({
          milestoneId: milestone.id,
          status: milestone.status,
          proposalId: linked?.proposal.id ?? null,
          proposalStatus: linked?.proposal.status ?? null,
          verificationPassed: complete,
          verificationDigest: complete ? linked!.verificationDigest : null,
          mergeSource: complete ? linked!.merge!.source : null,
          exactRevision: complete ? linked!.merge!.mergeCommitOid : null,
          realizedMergeDigest: complete ? linked!.mergeDigest : null,
        });
      }
      const state = observedState(goal, milestones);
      if (state !== undefined) observations.push({ nodeKey: node.key, state });
      nodesWithoutProjection.push({
        nodeKey: node.key,
        kind: node.kind,
        goalId: goal?.id ?? null,
        goalRecordDigest: goal === null ? null : goalDigestById.get(goal.id)!,
        milestones,
      });
    }

    const projected = projectEcosystemMissionGraph(input.graph, observations);
    if (!projected.ok) return { ok: false, reason: 'projection-failed' };
    const projectionByKey = new Map(projected.projection.nodes.map((node) => [node.key, node]));
    const nodes: MissionObservationNodeInput[] = nodesWithoutProjection.map((node) => {
      const projection = projectionByKey.get(node.nodeKey)!;
      return { ...node, status: projection.status, blockedBy: projection.blockedBy };
    });
    if (nodes.some((node) => node.kind === 'work' && node.status !== 'complete' &&
      node.milestones.filter((milestone) => milestone.status !== 'skipped').length > 0 &&
      node.milestones.filter((milestone) => milestone.status !== 'skipped').every((milestone) =>
        milestone.proposalStatus === 'applied' && milestone.verificationPassed && milestone.realizedMergeDigest !== null))) {
      return { ok: false, reason: 'projection-evidence-conflict' };
    }

    const goalSourceDigest = collectionDigest(
      'ashlr:mission-observation:goal-source:v1',
      goalSourceState,
      [...goalDigestById.values()],
    );
    const proposalSourceDigest = collectionDigest(
      'ashlr:mission-observation:proposal-source:v1',
      proposalSourceState,
      [...proposalById.values()].map((entry) => entry.sourceDigest),
    );
    return {
      ok: true,
      receiptInput: {
        recordedAt: input.recordedAt,
        captureKind: 'explicit-reconcile',
        missionKey: input.graph.missionKey,
        graphDigest: input.graph.graphDigest,
        briefing: input.briefing,
        briefingSource: sourceInput('healthy', briefingDigest),
        enrollmentSource: sourceInput('healthy', enrollment.digest),
        goalSource: sourceInput(goalSourceState, goalSourceDigest),
        proposalSource: sourceInput(proposalSourceState, proposalSourceDigest),
        nodes,
      },
    };
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
}
