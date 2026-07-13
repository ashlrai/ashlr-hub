import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { AgentActionEvent, AgentActionRepoScope } from '../fleet/agent-action-ledger.js';
import type {
  CompressionContextSummary,
  EvidenceOutcomeSummary,
  ProductionAttemptShape,
  PromptContextSummary,
  RetrievalContextSummary,
  RouteSnapshot,
  RunEventSummary,
} from '../types.js';
import {
  addProductionAttemptShape,
  classifyProductionAttemptForLearningWithLabel,
  emptyProductionAttemptShape,
} from '../learning/attempt-shape.js';

export type AttentionEvalWindow = '1d' | '7d' | '30d';

export interface AttentionNumericSummary {
  samples: number;
  avg: number | null;
  max: number | null;
}

export interface AttentionCount {
  key: string;
  count: number;
  share: number;
}

export interface AttentionRepoCount {
  repoKey: string;
  repoLabel: string;
  count: number;
  share: number;
}

export interface AttentionEvalReport {
  schemaVersion: 1;
  id: string;
  generatedAt: string;
  window: AttentionEvalWindow;
  windowHours: number;
  eventCount: number;
  latestAt: string | null;
  latestAgeMinutes: number | null;
  source: {
    ledgers: ['agent-actions'];
    limit: number;
    since: string;
    repoScope: AgentActionRepoScope;
    metadataOnly: true;
  };
  repoAttention: {
    repoEventCount: number;
    activeRepos: number;
    topRepoShare: number | null;
    entropy: number;
    verdict: 'quiet' | 'balanced' | 'concentrated';
    topRepos: AttentionRepoCount[];
  };
  contextPressure: {
    samples: number;
    promptBudgetRatio: AttentionNumericSummary;
    contextWindowRatio: AttentionNumericSummary;
    truncationRate: number | null;
    droppedLayerCount: number;
    droppedLayers: AttentionCount[];
    cacheHitRate: number | null;
  };
  retrievalQuality: {
    samples: number;
    hitCount: number;
    injectedHitCount: number;
    injectedChars: number;
    limitHitRate: AttentionNumericSummary;
    candidateHitRate: AttentionNumericSummary;
    topScore: AttentionNumericSummary;
    retrievalSources: AttentionCount[];
  };
  productionYield: {
    attempts: number;
    proposalCreated: number;
    noProposal: number;
    failed: number;
    blocked: number;
    policySuppressed: number;
    diagnosticAttempts: number;
    diagnosticNoProposal: number;
    proposalRate: number | null;
    noProposalRate: number | null;
    diagnosticProposalRate: number | null;
    diagnosticNoProposalRate: number | null;
    attemptShape: ProductionAttemptShape;
  };
  routingCost: {
    spendUsd: number;
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
    durationMs: number;
    byBackend: AttentionCount[];
    byTier: AttentionCount[];
    byModel: AttentionCount[];
    routerPolicyVersions: AttentionCount[];
  };
  evidence: {
    samples: number;
    verificationPassed: number;
    policyAllowed: number;
    policyDenied: number;
    gateCount: number;
    riskClasses: AttentionCount[];
    trustBases: AttentionCount[];
  };
  trajectory: {
    withTrajectoryId: number;
    distinctTrajectories: number;
    learningSources: AttentionCount[];
    labelBases: AttentionCount[];
    learningEpochs: AttentionCount[];
  };
  dataQuality: {
    privacyMode: 'metadata-only';
    repoPathMode: 'basename+sha256-12';
    persistedTextFields: 0;
    contextSummaryEvents: number;
    warnings: string[];
  };
}

export interface BuildAttentionEvalReportOptions {
  window?: AttentionEvalWindow;
  generatedAt?: Date | string;
  limit?: number;
  repoScope?: AgentActionRepoScope;
}

const DEFAULT_WINDOW: AttentionEvalWindow = '1d';
const DEFAULT_LIMIT = 1000;
const WINDOW_HOURS: Record<AttentionEvalWindow, number> = {
  '1d': 24,
  '7d': 7 * 24,
  '30d': 30 * 24,
};

export function attentionWindowHours(window: AttentionEvalWindow): number {
  return WINDOW_HOURS[window];
}

export function attentionWindowMs(window: AttentionEvalWindow): number {
  return attentionWindowHours(window) * 60 * 60 * 1000;
}

export function buildAttentionEvalReport(
  events: readonly unknown[],
  opts: BuildAttentionEvalReportOptions = {},
): AttentionEvalReport {
  const window = opts.window ?? DEFAULT_WINDOW;
  const generatedAt = isoTimestamp(opts.generatedAt);
  const generatedMs = Date.parse(generatedAt);
  const sinceMs = generatedMs - attentionWindowMs(window);
  const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;

  const repoCounts = new Map<string, number>();
  const backendCounts = new Map<string, number>();
  const tierCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const routerPolicyCounts = new Map<string, number>();
  const droppedLayerCounts = new Map<string, number>();
  const retrievalSourceCounts = new Map<string, number>();
  const riskClassCounts = new Map<string, number>();
  const trustBasisCounts = new Map<string, number>();
  const learningSourceCounts = new Map<string, number>();
  const labelBasisCounts = new Map<string, number>();
  const learningEpochCounts = new Map<string, number>();
  const trajectoryIds = new Set<string>();

  const promptBudgetRatios: number[] = [];
  const contextWindowRatios: number[] = [];
  const limitHitRates: number[] = [];
  const candidateHitRates: number[] = [];
  const topScores: number[] = [];

  let eventCount = 0;
  let latestAt: string | null = null;
  let contextSummaryEvents = 0;
  let promptCacheSamples = 0;
  let promptCacheHits = 0;
  let compressionSamples = 0;
  let truncations = 0;
  let droppedLayerCount = 0;
  let retrievalSamples = 0;
  let hitCount = 0;
  let injectedHitCount = 0;
  let injectedChars = 0;
  let proposalCreated = 0;
  let noProposal = 0;
  let failed = 0;
  let blocked = 0;
  let policySuppressed = 0;
  let diagnosticAttempts = 0;
  let diagnosticProposalsCreated = 0;
  let diagnosticNoProposal = 0;
  const attemptShape = emptyProductionAttemptShape();
  let spendUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let durationMs = 0;
  let evidenceSamples = 0;
  let verificationPassed = 0;
  let policyAllowed = 0;
  let policyDenied = 0;
  let gateCount = 0;
  let withTrajectoryId = 0;

  for (const raw of events.slice(0, limit)) {
    const event = metadataEvent(raw);
    if (!event) continue;
    eventCount++;
    latestAt = laterIso(latestAt, event.ts);

    if (event.repo) increment(repoCounts, event.repo);

    const route = routeSnapshot(event.routeSnapshot);
    const run = runEventSummary(event.runEventSummary);
    const evidence = evidenceOutcome(event.evidenceOutcome);

    const backend = category(event.backend) ?? category(route?.backend);
    const tier = category(event.tier) ?? category(route?.tier);
    const model = category(event.model) ?? category(route?.model);
    const policyVersion = category(event.routerPolicyVersion) ?? category(route?.routerPolicyVersion);
    if (backend) increment(backendCounts, backend);
    if (tier) increment(tierCounts, tier);
    if (model) increment(modelCounts, model);
    if (policyVersion) increment(routerPolicyCounts, policyVersion);

    const spent = finite(event.spentUsd) ?? finite(run?.costUsd);
    if (spent !== undefined && spent >= 0) spendUsd += spent;
    const inTokens = finite(run?.tokensIn);
    const outTokens = finite(run?.tokensOut);
    const runDuration = finite(event.durationMs) ?? finite(run?.durationMs);
    if (inTokens !== undefined && inTokens >= 0) tokensIn += inTokens;
    if (outTokens !== undefined && outTokens >= 0) tokensOut += outTokens;
    if (runDuration !== undefined && runDuration >= 0) durationMs += runDuration;

    const context = run?.contextSummary;
    if (context && (context.prompt || context.retrieval || context.compression)) contextSummaryEvents++;
    const prompt = promptSummary(context?.prompt);
    if (prompt) {
      pushFinite(promptBudgetRatios, ratio(prompt.promptBudgetRatio));
      pushFinite(contextWindowRatios, ratio(prompt.contextWindowRatio));
      if (typeof prompt.cacheHit === 'boolean') {
        promptCacheSamples++;
        if (prompt.cacheHit) promptCacheHits++;
      }
    }
    const retrieval = retrievalSummary(context?.retrieval);
    if (retrieval) {
      retrievalSamples++;
      hitCount += nonNegative(retrieval.hitCount) ?? 0;
      injectedHitCount += nonNegative(retrieval.injectedHitCount) ?? 0;
      injectedChars += nonNegative(retrieval.injectedChars) ?? 0;
      pushFinite(limitHitRates, ratio(retrieval.limitHitRate));
      pushFinite(candidateHitRates, ratio(retrieval.candidateHitRate));
      pushFinite(topScores, ratio(retrieval.topScore));
      const source = category(retrieval.source);
      if (source) increment(retrievalSourceCounts, source);
    }
    const compression = compressionSummary(context?.compression);
    if (compression) {
      compressionSamples++;
      if (compression.truncated === true) truncations++;
      const dropped = Array.isArray(compression.droppedLayers)
        ? compression.droppedLayers.slice(0, 16)
        : [];
      for (const layer of dropped) {
        const key = category(layer);
        if (!key) continue;
        droppedLayerCount++;
        increment(droppedLayerCounts, key);
      }
    }

    if (isProductionAttempt(event)) {
      const proposalCreatedSignal = run?.proposalCreated === true
        ? true
        : run?.proposalCreated === false
          ? false
          : event.outcome === 'proposal-created'
            ? true
            : event.outcome === 'no-proposal'
              ? false
              : undefined;
      const classification = classifyProductionAttemptForLearningWithLabel({
        outcome: run?.outcome ?? event.outcome,
        proposalCreated: proposalCreatedSignal,
        actionCounts: run?.actionCounts,
        reason: event.reason,
      }, event.learningLabel);
      const cancelled = classification.kind === 'cancelled';
      const produced = proposalCreatedSignal === true;
      if (!cancelled) {
        if (produced) proposalCreated++;
        else if (event.outcome === 'failed' || event.outcome === 'rejected') failed++;
        else if (event.outcome === 'blocked' || event.outcome === 'skipped') blocked++;
        else if (event.outcome === 'no-proposal' || run?.proposalCreated === false) noProposal++;
      }
      if (classification.policySuppressed) policySuppressed++;
      if (classification.diagnosticNoProposal) diagnosticNoProposal++;
      if (classification.diagnosticAttempt) {
        diagnosticAttempts++;
        if (classification.kind === 'proposal-created') diagnosticProposalsCreated++;
      }
      addProductionAttemptShape(attemptShape, classification.attemptShape);
    }

    if (evidence) {
      evidenceSamples++;
      if (evidence.verificationPassed === true) verificationPassed++;
      if (evidence.policyAllowed === true) policyAllowed++;
      if (evidence.policyAllowed === false) policyDenied++;
      gateCount += nonNegative(evidence.gateCount) ?? 0;
      const riskClass = category(evidence.riskClass);
      const trustBasis = category(evidence.trustBasis);
      if (riskClass) increment(riskClassCounts, riskClass);
      if (trustBasis) increment(trustBasisCounts, trustBasis);
    }

    const trajectoryId = category(event.trajectoryId);
    if (trajectoryId) {
      withTrajectoryId++;
      trajectoryIds.add(trajectoryId);
    }
    const learningSource = category(event.learningSource);
    const labelBasis = category(event.labelBasis);
    const learningEpoch = category(event.learningEpoch);
    if (learningSource) increment(learningSourceCounts, learningSource);
    if (labelBasis) increment(labelBasisCounts, labelBasis);
    if (learningEpoch) increment(learningEpochCounts, learningEpoch);
  }

  const repoEventCount = sumCounts(repoCounts);
  const repoTop = topRepoCounts(repoCounts, 8);
  const topRepoShare = repoEventCount > 0 ? roundRatio((repoTop[0]?.count ?? 0) / repoEventCount) : null;
  const attempts = proposalCreated + noProposal + failed + blocked;
  const warnings: string[] = [];
  if (eventCount === 0) warnings.push('no-events');
  if (contextSummaryEvents === 0) warnings.push('no-context-summary-events');
  if (attempts === 0) warnings.push('no-production-attempts');

  return {
    schemaVersion: 1,
    id: `attention-${Date.parse(generatedAt).toString(36)}`,
    generatedAt,
    window,
    windowHours: attentionWindowHours(window),
    eventCount,
    latestAt,
    latestAgeMinutes: latestAt ? roundNumber((generatedMs - Date.parse(latestAt)) / 60_000) : null,
    source: {
      ledgers: ['agent-actions'],
      limit,
      since: new Date(sinceMs).toISOString(),
      repoScope: opts.repoScope ?? 'enrolled-existing',
      metadataOnly: true,
    },
    repoAttention: {
      repoEventCount,
      activeRepos: repoCounts.size,
      topRepoShare,
      entropy: entropy([...repoCounts.values()]),
      verdict: repoVerdict(eventCount, topRepoShare),
      topRepos: repoTop,
    },
    contextPressure: {
      samples: contextSummaryEvents,
      promptBudgetRatio: numericSummary(promptBudgetRatios),
      contextWindowRatio: numericSummary(contextWindowRatios),
      truncationRate: compressionSamples > 0 ? roundRatio(truncations / compressionSamples) : null,
      droppedLayerCount,
      droppedLayers: topCounts(droppedLayerCounts, 8),
      cacheHitRate: promptCacheSamples > 0 ? roundRatio(promptCacheHits / promptCacheSamples) : null,
    },
    retrievalQuality: {
      samples: retrievalSamples,
      hitCount,
      injectedHitCount,
      injectedChars,
      limitHitRate: numericSummary(limitHitRates),
      candidateHitRate: numericSummary(candidateHitRates),
      topScore: numericSummary(topScores),
      retrievalSources: topCounts(retrievalSourceCounts, 8),
    },
    productionYield: {
      attempts,
      proposalCreated,
      noProposal,
      failed,
      blocked,
      policySuppressed,
      diagnosticAttempts,
      diagnosticNoProposal,
      proposalRate: attempts > 0 ? roundRatio(proposalCreated / attempts) : null,
      noProposalRate: attempts > 0 ? roundRatio(noProposal / attempts) : null,
      diagnosticProposalRate: diagnosticAttempts > 0
        ? roundRatio(diagnosticProposalsCreated / diagnosticAttempts)
        : null,
      diagnosticNoProposalRate: diagnosticAttempts > 0 ? roundRatio(diagnosticNoProposal / diagnosticAttempts) : null,
      attemptShape,
    },
    routingCost: {
      spendUsd: roundMoney(spendUsd),
      tokensIn,
      tokensOut,
      totalTokens: tokensIn + tokensOut,
      durationMs,
      byBackend: topCounts(backendCounts, 8),
      byTier: topCounts(tierCounts, 8),
      byModel: topCounts(modelCounts, 8),
      routerPolicyVersions: topCounts(routerPolicyCounts, 8),
    },
    evidence: {
      samples: evidenceSamples,
      verificationPassed,
      policyAllowed,
      policyDenied,
      gateCount,
      riskClasses: topCounts(riskClassCounts, 8),
      trustBases: topCounts(trustBasisCounts, 8),
    },
    trajectory: {
      withTrajectoryId,
      distinctTrajectories: trajectoryIds.size,
      learningSources: topCounts(learningSourceCounts, 8),
      labelBases: topCounts(labelBasisCounts, 8),
      learningEpochs: topCounts(learningEpochCounts, 8),
    },
    dataQuality: {
      privacyMode: 'metadata-only',
      repoPathMode: 'basename+sha256-12',
      persistedTextFields: 0,
      contextSummaryEvents,
      warnings,
    },
  };
}

function metadataEvent(value: unknown): AgentActionEvent | undefined {
  if (!record(value)) return undefined;
  if (value['schemaVersion'] !== 1) return undefined;
  const ts = typeof value['ts'] === 'string' ? value['ts'] : undefined;
  const kind = typeof value['kind'] === 'string' ? value['kind'] : undefined;
  const outcome = typeof value['outcome'] === 'string' ? value['outcome'] : undefined;
  if (!ts || !kind || !outcome || !Number.isFinite(Date.parse(ts))) return undefined;
  return value as unknown as AgentActionEvent;
}

function isoTimestamp(input: Date | string | undefined): string {
  if (input instanceof Date && Number.isFinite(input.getTime())) return input.toISOString();
  if (typeof input === 'string' && Number.isFinite(Date.parse(input))) {
    return new Date(Date.parse(input)).toISOString();
  }
  return new Date().toISOString();
}

function laterIso(current: string | null, next: string): string {
  if (!current) return next;
  return Date.parse(next) > Date.parse(current) ? next : current;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function routeSnapshot(value: unknown): RouteSnapshot | undefined {
  return record(value) ? value as RouteSnapshot : undefined;
}

function runEventSummary(value: unknown): RunEventSummary | undefined {
  return record(value) ? value as RunEventSummary : undefined;
}

function evidenceOutcome(value: unknown): EvidenceOutcomeSummary | undefined {
  return record(value) ? value as EvidenceOutcomeSummary : undefined;
}

function promptSummary(value: unknown): PromptContextSummary | undefined {
  return record(value) ? value as PromptContextSummary : undefined;
}

function retrievalSummary(value: unknown): RetrievalContextSummary | undefined {
  return record(value) ? value as unknown as RetrievalContextSummary : undefined;
}

function compressionSummary(value: unknown): CompressionContextSummary | undefined {
  return record(value) ? value as CompressionContextSummary : undefined;
}

function category(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const n = finite(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function ratio(value: unknown): number | undefined {
  const n = finite(value);
  if (n === undefined) return undefined;
  return Math.max(0, Math.min(1, n));
}

function pushFinite(out: number[], value: number | undefined): void {
  if (value !== undefined && Number.isFinite(value)) out.push(value);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sumCounts(map: Map<string, number>): number {
  return [...map.values()].reduce((sum, value) => sum + value, 0);
}

function numericSummary(values: number[]): AttentionNumericSummary {
  if (values.length === 0) return { samples: 0, avg: null, max: null };
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    samples: values.length,
    avg: roundRatio(sum / values.length),
    max: roundRatio(Math.max(...values)),
  };
}

function topCounts(map: Map<string, number>, limit: number): AttentionCount[] {
  const total = sumCounts(map);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({
      key,
      count,
      share: total > 0 ? roundRatio(count / total) : 0,
    }));
}

function topRepoCounts(map: Map<string, number>, limit: number): AttentionRepoCount[] {
  const total = sumCounts(map);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || repoLabel(a[0]).localeCompare(repoLabel(b[0])))
    .slice(0, limit)
    .map(([repo, count]) => ({
      repoKey: createHash('sha256').update(repo).digest('hex').slice(0, 12),
      repoLabel: repoLabel(repo),
      count,
      share: total > 0 ? roundRatio(count / total) : 0,
    }));
}

function repoLabel(repo: string): string {
  const normalized = repo.replace(/\\/g, '/');
  const basename = path.posix.basename(normalized) || path.win32.basename(repo) || 'unknown';
  const label = basename.replace(/\s+/g, ' ').trim() || 'unknown';
  return label.length > 80 ? `${label.slice(0, 77)}...` : label;
}

function entropy(counts: number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 0;
  const value = counts.reduce((sum, count) => {
    const p = count / total;
    return p > 0 ? sum - p * Math.log2(p) : sum;
  }, 0);
  return roundNumber(value);
}

function repoVerdict(
  eventCount: number,
  topRepoShare: number | null,
): AttentionEvalReport['repoAttention']['verdict'] {
  if (eventCount === 0 || topRepoShare === null) return 'quiet';
  return topRepoShare >= 0.75 ? 'concentrated' : 'balanced';
}

function isProductionAttempt(event: AgentActionEvent): boolean {
  if (event.kind === 'proposal') return true;
  if (event.kind !== 'dispatch') return false;
  if (event.outcome === 'started') return false;
  if (event.counts?.dispatched === 0) return false;
  return event.action !== 'daemon:drain-select' &&
    event.action !== 'daemon:dispatch-start' &&
    event.action !== 'daemon:dispatch-skip';
}

function roundRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function roundNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}
