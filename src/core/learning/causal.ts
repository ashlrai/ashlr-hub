import type {
  DecisionEntry,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  Proposal,
  RouteSnapshot,
  RunEventSummary,
} from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

export const ROUTER_POLICY_VERSION = 'fleet-router-v1';

type CausalSource = {
  trajectoryId?: string;
  proposalId?: string;
  workItemId?: string;
  itemId?: string;
  runId?: string;
};

type CausalMetadataInput = CausalSource & {
  ts?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
};

const MAX_ID = 240;
const MAX_REASON = 240;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function learningEpochFromTimestamp(ts?: string): string {
  const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
  const date = Number.isFinite(ms) ? new Date(ms) : new Date();
  return date.toISOString().slice(0, 10);
}

export function trajectoryIdFor(input: CausalSource): string | undefined {
  const explicit = boundedText(input.trajectoryId, MAX_ID);
  if (explicit) return explicit;
  const runId = boundedText(input.runId, MAX_ID);
  if (runId) return `run:${runId}`;
  const workId = boundedText(input.workItemId ?? input.itemId, MAX_ID);
  if (workId) return `work:${workId}`;
  const proposalId = boundedText(input.proposalId, MAX_ID);
  return proposalId ? `proposal:${proposalId}` : undefined;
}

export function routeSnapshot(input: RouteSnapshot | undefined): RouteSnapshot | undefined {
  if (!input) return undefined;
  const backend = input.backend === null ? null : boundedText(input.backend, 80);
  const tier = input.tier === null ? null : boundedText(input.tier, 40);
  const model = input.model === null ? null : boundedText(input.model, 160);
  const assignedBy = boundedText(input.assignedBy, 80);
  const reason = boundedText(input.reason, MAX_REASON);
  const routerPolicyVersion = boundedText(input.routerPolicyVersion, 80) ?? ROUTER_POLICY_VERSION;
  return {
    ...(backend !== undefined ? { backend } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(assignedBy ? { assignedBy } : {}),
    ...(reason ? { reason } : {}),
    routerPolicyVersion,
  };
}

export function runEventSummary(input: RunEventSummary | undefined): RunEventSummary | undefined {
  if (!input) return undefined;
  const runId = boundedText(input.runId, MAX_ID);
  const status = boundedText(input.status, 80);
  const outcome = boundedText(input.outcome, 80);
  const proposalId = boundedText(input.proposalId, MAX_ID);
  const diffFiles = finiteNumber(input.diffFiles);
  const diffLines = finiteNumber(input.diffLines);
  const tokensIn = finiteNumber(input.tokensIn);
  const tokensOut = finiteNumber(input.tokensOut);
  const costUsd = finiteNumber(input.costUsd);
  const durationMs = finiteNumber(input.durationMs);
  const proposalCreated = optionalBoolean(input.proposalCreated);
  const cacheHit = optionalBoolean(input.cacheHit);
  return {
    ...(runId ? { runId } : {}),
    ...(status ? { status } : {}),
    ...(outcome ? { outcome } : {}),
    ...(proposalCreated !== undefined ? { proposalCreated } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(diffFiles !== undefined ? { diffFiles } : {}),
    ...(diffLines !== undefined ? { diffLines } : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(cacheHit !== undefined ? { cacheHit } : {}),
  };
}

export function evidenceOutcomeSummary(
  input: EvidenceOutcomeSummary | undefined,
): EvidenceOutcomeSummary | undefined {
  if (!input) return undefined;
  const target = boundedText(input.target, 80);
  const trustBasis = boundedText(input.trustBasis, 80);
  const riskClass = boundedText(input.riskClass, 40);
  const policyAction = boundedText(input.policyAction, 80);
  const policyTier = boundedText(input.policyTier, 80);
  const gateCount = finiteNumber(input.gateCount);
  const verificationPassed = optionalBoolean(input.verificationPassed);
  const policyAllowed = optionalBoolean(input.policyAllowed);
  return {
    ...(target ? { target } : {}),
    ...(trustBasis ? { trustBasis } : {}),
    ...(riskClass ? { riskClass } : {}),
    ...(verificationPassed !== undefined ? { verificationPassed } : {}),
    ...(policyAllowed !== undefined ? { policyAllowed } : {}),
    ...(policyAction ? { policyAction } : {}),
    ...(policyTier ? { policyTier } : {}),
    ...(gateCount !== undefined ? { gateCount } : {}),
  };
}

export function causalMetadata(input: CausalMetadataInput): {
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch: string;
} {
  const rs = routeSnapshot(input.routeSnapshot);
  const summary = runEventSummary(input.runEventSummary);
  const evidence = evidenceOutcomeSummary(input.evidenceOutcome);
  const routerPolicyVersion =
    boundedText(input.routerPolicyVersion, 80) ?? rs?.routerPolicyVersion ?? ROUTER_POLICY_VERSION;
  const learningSource = boundedText(input.learningSource, 80) as LearningSource | undefined;
  const labelBasis = boundedText(input.labelBasis, 80) as LabelBasis | undefined;
  const trajectoryId = trajectoryIdFor(input);
  return {
    ...(trajectoryId ? { trajectoryId } : {}),
    ...(rs ? { routeSnapshot: rs } : {}),
    ...(summary ? { runEventSummary: summary } : {}),
    ...(evidence ? { evidenceOutcome: evidence } : {}),
    ...(learningSource ? { learningSource } : {}),
    ...(labelBasis ? { labelBasis } : {}),
    routerPolicyVersion,
    learningEpoch: boundedText(input.learningEpoch, 40) ?? learningEpochFromTimestamp(input.ts),
  };
}

export function causalMetadataFromProposal(
  proposal: Proposal,
  input: Omit<CausalMetadataInput, 'proposalId' | 'workItemId' | 'runId' | 'trajectoryId'> = {},
): ReturnType<typeof causalMetadata> & {
  workItemId?: string;
  workSource?: Proposal['workSource'];
  runId?: string;
} {
  return {
    ...(proposal.workItemId ? { workItemId: proposal.workItemId } : {}),
    ...(proposal.workSource ? { workSource: proposal.workSource } : {}),
    ...(proposal.runId ? { runId: proposal.runId } : {}),
    ...causalMetadata({
      proposalId: proposal.id,
      workItemId: proposal.workItemId,
      runId: proposal.runId,
      trajectoryId: proposal.trajectoryId,
      routeSnapshot: input.routeSnapshot ?? proposal.routeSnapshot,
      runEventSummary: input.runEventSummary ?? proposal.runEventSummary,
      evidenceOutcome: input.evidenceOutcome ?? proposal.evidenceOutcome,
      routerPolicyVersion: input.routerPolicyVersion ?? proposal.routerPolicyVersion,
      learningEpoch: input.learningEpoch ?? proposal.learningEpoch,
      learningSource: input.learningSource,
      labelBasis: input.labelBasis,
      ts: input.ts ?? proposal.createdAt,
    }),
  };
}

export function normalizeDecisionLearningFields(entry: DecisionEntry): DecisionEntry {
  const meta = causalMetadata({
    proposalId: entry.proposalId,
    workItemId: entry.workItemId,
    runId: entry.runId,
    trajectoryId: entry.trajectoryId,
    routeSnapshot: entry.routeSnapshot,
    runEventSummary: entry.runEventSummary,
    evidenceOutcome: entry.evidenceOutcome,
    learningSource: entry.learningSource ?? 'decision-ledger',
    labelBasis: entry.labelBasis ?? labelBasisForDecision(entry.action),
    routerPolicyVersion: entry.routerPolicyVersion,
    learningEpoch: entry.learningEpoch,
    ts: entry.ts,
  });
  return {
    ...entry,
    ...meta,
  };
}

function labelBasisForDecision(action: DecisionEntry['action']): LabelBasis {
  switch (action) {
    case 'judged':
      return 'judge-verdict';
    case 'merged':
    case 'escalated':
      return 'merge-gate';
    case 'proposed':
      return 'dispatch-outcome';
    case 'verified':
      return 'evidence-policy';
    case 'rejected':
    case 'handoff':
      return 'proposal-status';
    default:
      return 'unknown';
  }
}
