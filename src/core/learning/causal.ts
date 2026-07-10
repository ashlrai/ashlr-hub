import type {
  CompressionContextSummary,
  DecisionEntry,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  Proposal,
  PromptContextSummary,
  RunActionCounts,
  RetrievalContextSummary,
  RouteSnapshot,
  RunContextSummary,
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
const MAX_SELECTED_SKILLS = 8;
const MAX_SKILL_ID = 160;
const RUN_ACTION_COUNT_KEYS = [
  'sandboxCreated',
  'spawnAttempts',
  'transientRetries',
  'proposalCaptureAttempts',
  'completenessGateRuns',
  'verifyRepairAttempts',
  'modelSteps',
  'toolSteps',
  'totalSteps',
  'diffFiles',
  'diffLines',
  'proposalCreated',
  'proposalBlocked',
  'proposalDisabled',
] as const satisfies readonly (keyof RunActionCounts)[];

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

function nonNegativeNumber(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(n)));
}

function ratio(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined) return undefined;
  return Math.max(0, Math.min(1, Math.round(n * 1_000) / 1_000));
}

function textList(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = boundedText(item, maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : undefined;
}

function promptContextSummary(input: PromptContextSummary | undefined): PromptContextSummary | undefined {
  if (!input) return undefined;
  const role = boundedText(input.role, 40) as PromptContextSummary['role'] | undefined;
  const profileId = boundedText(input.profileId, 80);
  const layersIncluded = textList(input.layersIncluded, 8, 24) as PromptContextSummary['layersIncluded'] | undefined;
  const out: PromptContextSummary = {
    ...(role ? { role } : {}),
    ...(profileId ? { profileId } : {}),
    ...(nonNegativeNumber(input.contextWindowTokens) !== undefined ? { contextWindowTokens: nonNegativeNumber(input.contextWindowTokens) } : {}),
    ...(nonNegativeNumber(input.providerPromptTokens) !== undefined ? { providerPromptTokens: nonNegativeNumber(input.providerPromptTokens) } : {}),
    ...(nonNegativeNumber(input.estimatedPromptTokens) !== undefined ? { estimatedPromptTokens: nonNegativeNumber(input.estimatedPromptTokens) } : {}),
    ...(nonNegativeNumber(input.promptCharCap) !== undefined ? { promptCharCap: nonNegativeNumber(input.promptCharCap) } : {}),
    ...(nonNegativeNumber(input.assembledSystemChars) !== undefined ? { assembledSystemChars: nonNegativeNumber(input.assembledSystemChars) } : {}),
    ...(ratio(input.promptBudgetRatio) !== undefined ? { promptBudgetRatio: ratio(input.promptBudgetRatio) } : {}),
    ...(ratio(input.contextWindowRatio) !== undefined ? { contextWindowRatio: ratio(input.contextWindowRatio) } : {}),
    ...(layersIncluded ? { layersIncluded } : {}),
    ...(nonNegativeNumber(input.toolCount) !== undefined ? { toolCount: nonNegativeNumber(input.toolCount) } : {}),
    ...(optionalBoolean(input.cacheHit) !== undefined ? { cacheHit: optionalBoolean(input.cacheHit) } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function retrievalContextSummary(input: RetrievalContextSummary | undefined): RetrievalContextSummary | undefined {
  if (!input) return undefined;
  const source = boundedText(input.source, 40) as RetrievalContextSummary['source'] | undefined;
  const methodCounts = input.methodCounts
    ? {
        ...(nonNegativeNumber(input.methodCounts.keyword) !== undefined ? { keyword: nonNegativeNumber(input.methodCounts.keyword) } : {}),
        ...(nonNegativeNumber(input.methodCounts.embedding) !== undefined ? { embedding: nonNegativeNumber(input.methodCounts.embedding) } : {}),
      }
    : undefined;
  const out: RetrievalContextSummary = {
    ...(source ? { source } : {}),
    ...(nonNegativeNumber(input.requestedLimit) !== undefined ? { requestedLimit: nonNegativeNumber(input.requestedLimit) } : {}),
    ...(nonNegativeNumber(input.corpusEntries) !== undefined ? { corpusEntries: nonNegativeNumber(input.corpusEntries) } : {}),
    ...(nonNegativeNumber(input.candidateCount) !== undefined ? { candidateCount: nonNegativeNumber(input.candidateCount) } : {}),
    hitCount: nonNegativeNumber(input.hitCount) ?? 0,
    ...(nonNegativeNumber(input.injectedHitCount) !== undefined ? { injectedHitCount: nonNegativeNumber(input.injectedHitCount) } : {}),
    ...(ratio(input.limitHitRate) !== undefined ? { limitHitRate: ratio(input.limitHitRate) } : {}),
    ...(ratio(input.candidateHitRate) !== undefined ? { candidateHitRate: ratio(input.candidateHitRate) } : {}),
    ...(methodCounts && Object.keys(methodCounts).length > 0 ? { methodCounts } : {}),
    ...(nonNegativeNumber(input.topScore) !== undefined ? { topScore: Math.round(nonNegativeNumber(input.topScore)! * 1_000) / 1_000 } : {}),
    ...(nonNegativeNumber(input.injectedChars) !== undefined ? { injectedChars: nonNegativeNumber(input.injectedChars) } : {}),
  };
  return out;
}

function compressionContextSummary(input: CompressionContextSummary | undefined): CompressionContextSummary | undefined {
  if (!input) return undefined;
  const source = boundedText(input.source, 40) as CompressionContextSummary['source'] | undefined;
  const strategy = boundedText(input.strategy, 40) as CompressionContextSummary['strategy'] | undefined;
  const droppedLayers = textList(input.droppedLayers, 8, 40);
  const out: CompressionContextSummary = {
    ...(source ? { source } : {}),
    ...(strategy ? { strategy } : {}),
    ...(nonNegativeNumber(input.inputChars) !== undefined ? { inputChars: nonNegativeNumber(input.inputChars) } : {}),
    ...(nonNegativeNumber(input.outputChars) !== undefined ? { outputChars: nonNegativeNumber(input.outputChars) } : {}),
    ...(nonNegativeNumber(input.maxChars) !== undefined ? { maxChars: nonNegativeNumber(input.maxChars) } : {}),
    ...(nonNegativeNumber(input.droppedChars) !== undefined ? { droppedChars: nonNegativeNumber(input.droppedChars) } : {}),
    ...(ratio(input.compressionRatio) !== undefined ? { compressionRatio: ratio(input.compressionRatio) } : {}),
    ...(optionalBoolean(input.truncated) !== undefined ? { truncated: optionalBoolean(input.truncated) } : {}),
    ...(droppedLayers ? { droppedLayers } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function runContextSummary(input: RunContextSummary | undefined): RunContextSummary | undefined {
  if (!input) return undefined;
  const prompt = promptContextSummary(input.prompt);
  const retrieval = retrievalContextSummary(input.retrieval);
  const compression = compressionContextSummary(input.compression);
  if (!prompt && !retrieval && !compression) return undefined;
  return {
    ...(prompt ? { prompt } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(compression ? { compression } : {}),
  };
}

function runActionCounts(input: RunActionCounts | undefined): RunActionCounts | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const out: RunActionCounts = {};
  for (const key of RUN_ACTION_COUNT_KEYS) {
    const count = nonNegativeInteger(record[key]);
    if (count !== undefined) out[key] = count;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  const selectedSkillIds = textList(input.selectedSkillIds, MAX_SELECTED_SKILLS, MAX_SKILL_ID);
  const skillPolicyVersion = boundedText(input.skillPolicyVersion, 80);
  const skillMode =
    input.skillMode === 'shadow' || input.skillMode === 'active' || input.skillMode === 'disabled'
      ? input.skillMode
      : undefined;
  return {
    ...(backend !== undefined ? { backend } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(assignedBy ? { assignedBy } : {}),
    ...(reason ? { reason } : {}),
    routerPolicyVersion,
    ...(selectedSkillIds ? { selectedSkillIds } : {}),
    ...(skillPolicyVersion ? { skillPolicyVersion } : {}),
    ...(skillMode ? { skillMode } : {}),
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
  const contextSummary = runContextSummary(input.contextSummary);
  const actionCounts = runActionCounts(input.actionCounts);
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
    ...(contextSummary ? { contextSummary } : {}),
    ...(actionCounts ? { actionCounts } : {}),
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
