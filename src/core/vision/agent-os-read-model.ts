/**
 * Agent OS cockpit read model.
 *
 * This pure projection accepts only self-consistent shadow receipts plus an
 * explicit external verifier. Caller-authored prose is never copied into the
 * public model: labels come from a closed taxonomy and deterministic templates.
 * The verifier authenticates the exact source bundle and outcome receipts; a
 * format marker or recomputed digest alone never establishes truth.
 */

import { createHash } from 'node:crypto';
import {
  digestCapabilityClassV1,
  verifyCapabilitySpectrumShadowV1,
  type CapabilitySpectrumShadowV1,
} from '../fabric/capability-spectrum.js';
import {
  verifyAgentNativeKernelShadowV1,
  type AgentNativeKernelShadowV1,
} from './agent-native-kernel.js';
import {
  MAX_ACTIVE_VALUE_BETS,
  MAX_VALUE_HYPOTHESES,
  verifyPortfolioShadowV1,
  verifyValueHypothesisV1,
  type OutcomeEvidenceVerifierV1,
  type PortfolioShadowV1,
  type ValueHypothesisV1,
} from './value-portfolio.js';

export const AGENT_OS_READ_MODEL_SCHEMA_VERSION = 1 as const;
export const AGENT_OS_READ_MODEL_MAX_AGE_MS = 5 * 60_000;

type EvidenceState = 'complete' | 'pending' | 'incomplete' | 'unknown';
type DisplayLane = 'codex' | 'claude' | 'local';
type Digest = string;

export interface AgentOsReadModelV1 {
  sourceState: 'healthy' | 'degraded' | 'unknown';
  livingEndState: {
    northStar: string;
    currentBottleneck: string;
    revisionLabel: string;
    evidenceState: EvidenceState;
  };
  capabilitySpectrum: Array<{
    lane: DisplayLane;
    label: string;
    state: 'ready' | 'tight' | 'unavailable' | 'unknown';
    headroom: 'ample' | 'usable' | 'tight' | 'none' | 'unknown';
    resetUrgency: 'now' | 'soon' | 'later' | 'none' | 'unknown';
    resetLabel: string;
    allocationLabel: string;
  }>;
  activeValueBets: Array<{
    key: string;
    title: string;
    valueCase: string;
    allocationLabel: string;
    decision: 'continue' | 'observing' | 'hold';
    assurance: 'fast-path' | 'targeted' | 'deep';
    outcome: {
      state: 'pending' | 'effective' | 'refuted' | 'unknown';
      label: string;
    };
    evidence: {
      state: EvidenceState;
      label: string;
    };
  }>;
  nextAction: {
    kind: 'exception' | 'attention' | 'clear';
    title: string;
    reason: string;
    evidenceState: EvidenceState;
  };
}

export interface AgentOsReadModelInputV1 {
  schemaVersion: 1;
  renderedAt: string;
  kernel: AgentNativeKernelShadowV1;
  capabilitySpectrum: CapabilitySpectrumShadowV1;
  portfolio: PortfolioShadowV1;
  hypotheses: ValueHypothesisV1[];
}

export interface AgentOsSourceBundleVerificationInputV1 {
  renderedAt: string;
  kernelCycleDigest: Digest;
  evidenceIndexDigest: Digest;
  capabilityProjectionDigest: Digest;
  portfolioDigest: Digest;
  hypothesisDigests: Digest[];
  outcomeReceiptDigests: Digest[];
}

/**
 * Production implementations must authenticate this exact bundle against an
 * external trust root. The outcome verifier independently authenticates each
 * observer receipt and its independence from the hypothesis producer.
 */
export interface AgentOsReadModelVerifierV1 {
  outcomeEvidenceVerifier: OutcomeEvidenceVerifierV1;
  verifySourceBundle(
    input: Readonly<AgentOsSourceBundleVerificationInputV1>,
  ): { sourceBundleAuthenticated: boolean; evidenceIndexAuthenticated: boolean };
}

export type AgentOsReadModelIssueV1 =
  | 'invalid-input'
  | 'source-verifier-unavailable'
  | 'source-authentication-failed'
  | 'invalid-kernel'
  | 'invalid-capability-spectrum'
  | 'invalid-portfolio'
  | 'invalid-hypothesis'
  | 'basis-mismatch'
  | 'stale-snapshot'
  | 'unknown-source-reference'
  | 'duplicate-source-reference'
  | 'too-many-value-bets';

export type AgentOsReadModelBuildResultV1 =
  | { ok: true; snapshot: AgentOsReadModelV1; snapshotDigest: Digest; issues: [] }
  | { ok: false; snapshot: null; snapshotDigest: null; issues: AgentOsReadModelIssueV1[] };

const INPUT_KEYS = new Set([
  'schemaVersion', 'renderedAt', 'kernel', 'capabilitySpectrum', 'portfolio', 'hypotheses',
]);
const DISPLAY_LANES: readonly DisplayLane[] = ['codex', 'claude', 'local'];
const LANE_LABELS: Readonly<Record<DisplayLane, string>> = Object.freeze({
  codex: 'Codex',
  claude: 'Claude',
  local: 'Local models',
});
const MODEL_CLASS_LABEL: Readonly<Record<DisplayLane, string>> = Object.freeze({
  codex: 'codex',
  claude: 'claude',
  local: 'local-coder',
});

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[String(key)];
      return !descriptor || !descriptor.enumerable || !('value' in descriptor);
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function fail(issue: AgentOsReadModelIssueV1): AgentOsReadModelBuildResultV1 {
  return { ok: false, snapshot: null, snapshotDigest: null, issues: [issue] };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function snapshotReceiptDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update('ashlr:agent-os-read-model:snapshot:v1', 'utf8')
    .update('\0').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function decisionState(decision: PortfolioShadowV1['decisions'][number]): 'continue' | 'observing' | 'hold' {
  if (decision.reason === 'outcome-window-open') return 'observing';
  return decision.disposition === 'continue' ? 'continue' : 'hold';
}

function assuranceState(
  value: PortfolioShadowV1['decisions'][number]['assurance']['depth'],
): 'fast-path' | 'targeted' | 'deep' {
  return value === 'targeted-challenge' ? 'targeted' : value === 'deep-review' ? 'deep' : 'fast-path';
}

function outcomeState(
  decision: PortfolioShadowV1['decisions'][number],
  hypothesis: ValueHypothesisV1,
): 'pending' | 'effective' | 'refuted' | 'unknown' {
  if (decision.reason === 'effective' && decision.effective === true) return 'effective';
  if (decision.reason === 'refuted' && decision.effective === false) return 'refuted';
  if (decision.disposition === 'stop') return 'unknown';
  return hypothesis.outcomeSource.complete ? 'pending' : 'unknown';
}

function outcomeEvidenceState(hypothesis: ValueHypothesisV1): EvidenceState {
  if (!hypothesis.outcomeSource.complete) return 'incomplete';
  return hypothesis.outcomeSource.evidence === null ? 'pending' : 'complete';
}

const UNKNOWN_CAPABILITY_REASONS = new Set<CapabilitySpectrumShadowV1['inventory'][number]['reason']>([
  'source-degraded', 'observation-missing', 'observation-stale', 'observation-future', 'invalid-reset',
]);

function derivedCapabilityState(
  resources: CapabilitySpectrumShadowV1['inventory'],
  asOfMs: number,
): Pick<AgentOsReadModelV1['capabilitySpectrum'][number], 'state' | 'headroom' | 'resetUrgency'> {
  const hasUnknownSource = resources.some((resource) => UNKNOWN_CAPABILITY_REASONS.has(resource.reason));
  const available = resources.filter((resource) => resource.state === 'available');
  const state = hasUnknownSource
    ? 'unknown' as const
    : available.length === 0
      ? 'unavailable' as const
      : available.length !== resources.length || available.some((resource) => resource.reason === 'trusted-near')
        ? 'tight' as const
        : 'ready' as const;
  const totalTrusted = resources.reduce((sum, resource) => sum + resource.trustedUnits, 0);
  const totalMaximum = resources.reduce((sum, resource) => sum + resource.maxUnits, 0);
  const ratio = totalMaximum === 0 ? 0 : totalTrusted / totalMaximum;
  const headroom = hasUnknownSource
    ? 'unknown' as const
    : ratio === 0
      ? 'none' as const
      : ratio <= 0.25
        ? 'tight' as const
        : ratio <= 0.75
          ? 'usable' as const
          : 'ample' as const;
  const resetTimes = resources
    .map((resource) => resource.resetAt === null ? null : Date.parse(resource.resetAt))
    .filter((resetAt): resetAt is number => resetAt !== null)
    .sort((left, right) => left - right);
  const earliestReset = resetTimes[0];
  const resetUrgency = hasUnknownSource
    ? 'unknown' as const
    : earliestReset === undefined
      ? 'none' as const
      : earliestReset - asOfMs <= 15 * 60_000
        ? 'now' as const
        : earliestReset - asOfMs <= 2 * 60 * 60_000
          ? 'soon' as const
          : 'later' as const;
  return { state, headroom, resetUrgency };
}

function resetLabel(urgency: AgentOsReadModelV1['capabilitySpectrum'][number]['resetUrgency']): string {
  return {
    now: 'Reset due now',
    soon: 'Reset due soon',
    later: 'Reset later',
    none: 'No reset scheduled',
    unknown: 'Reset state unavailable',
  }[urgency];
}

function capacityLabel(headroom: AgentOsReadModelV1['capabilitySpectrum'][number]['headroom']): string {
  return {
    ample: 'Ample authenticated capacity',
    usable: 'Usable authenticated capacity',
    tight: 'Tight authenticated capacity',
    none: 'No authenticated capacity',
    unknown: 'Capacity evidence unavailable',
  }[headroom];
}

function outcomeLabel(state: AgentOsReadModelV1['activeValueBets'][number]['outcome']['state']): string {
  return {
    pending: 'Outcome observation pending',
    effective: 'Outcome threshold met',
    refuted: 'Outcome thesis refuted',
    unknown: 'Outcome unavailable',
  }[state];
}

function evidenceLabel(state: EvidenceState): string {
  return {
    complete: 'Observer evidence authenticated',
    pending: 'Observer evidence pending',
    incomplete: 'Observer evidence incomplete',
    unknown: 'Observer evidence unavailable',
  }[state];
}

function valueCase(decision: 'continue' | 'observing' | 'hold'): string {
  return {
    continue: 'Portfolio evidence supports bounded continuation.',
    observing: 'The frozen outcome observation window remains open.',
    hold: 'Portfolio constraints currently hold this value bet.',
  }[decision];
}

function allocationLabel(decision: 'continue' | 'observing' | 'hold'): string {
  return {
    continue: 'Bounded allocation active',
    observing: 'Observation in progress',
    hold: 'No active allocation',
  }[decision];
}

function sourceBundleAuthenticated(
  verifier: AgentOsReadModelVerifierV1,
  input: AgentOsSourceBundleVerificationInputV1,
): boolean {
  try {
    const result = verifier.verifySourceBundle(input);
    return result?.sourceBundleAuthenticated === true && result.evidenceIndexAuthenticated === true;
  } catch {
    return false;
  }
}

function nextAction(
  sourceHealthy: boolean,
  decisions: readonly PortfolioShadowV1['decisions'][number][],
): AgentOsReadModelV1['nextAction'] {
  if (!sourceHealthy) return {
    kind: 'exception',
    title: 'Resolve incomplete source evidence',
    reason: 'One or more required source observations are incomplete.',
    evidenceState: 'incomplete',
  };
  if (decisions.some((decision) => decision.reason === 'outcome-window-open')) return {
    kind: 'attention',
    title: 'Observe the frozen outcome window',
    reason: 'No effectiveness decision is valid before the bound observation window closes.',
    evidenceState: 'pending',
  };
  if (decisions.some((decision) => decision.allocation !== null)) return {
    kind: 'clear',
    title: 'Continue the bounded value bet',
    reason: 'Authenticated portfolio evidence supports the current bounded allocation.',
    evidenceState: 'complete',
  };
  return {
    kind: 'attention',
    title: 'Review held value bets',
    reason: 'No bounded value bet is currently allocation-ready.',
    evidenceState: 'complete',
  };
}

function bottleneck(
  sourceHealthy: boolean,
  decisions: readonly PortfolioShadowV1['decisions'][number][],
): string {
  if (!sourceHealthy) return 'Required source evidence is incomplete.';
  if (decisions.some((decision) => decision.reason === 'outcome-window-open')) {
    return 'Outcome evidence is awaiting its frozen observation window.';
  }
  if (!decisions.some((decision) => decision.allocation !== null)) {
    return 'No value bet is currently allocation-ready.';
  }
  return 'No authenticated blocking exception is active.';
}

/** Build an inert, externally authenticated cockpit projection. */
export function buildAgentOsReadModelV1(
  value: unknown,
  verifier: AgentOsReadModelVerifierV1 | null = null,
): AgentOsReadModelBuildResultV1 {
  try {
    const input = record(value);
    if (!input || !exactKeys(input, INPUT_KEYS) || input['schemaVersion'] !== 1 ||
      !timestamp(input['renderedAt']) || !Array.isArray(input['hypotheses']) ||
      input['hypotheses'].length > MAX_VALUE_HYPOTHESES) return fail('invalid-input');
    if (!verifier || typeof verifier.verifySourceBundle !== 'function' ||
      !verifier.outcomeEvidenceVerifier ||
      typeof verifier.outcomeEvidenceVerifier.verifyOutcomeEvidence !== 'function') {
      return fail('source-verifier-unavailable');
    }
    const kernel = verifyAgentNativeKernelShadowV1(input['kernel']);
    if (!kernel) return fail('invalid-kernel');
    const spectrum = verifyCapabilitySpectrumShadowV1(input['capabilitySpectrum']);
    if (!spectrum) return fail('invalid-capability-spectrum');
    const portfolio = verifyPortfolioShadowV1(input['portfolio']);
    if (!portfolio) return fail('invalid-portfolio');
    const hypotheses = input['hypotheses'].map((hypothesis) =>
      verifyValueHypothesisV1(hypothesis, verifier.outcomeEvidenceVerifier));
    if (hypotheses.some((item) => item === null)) return fail('invalid-hypothesis');
    const verifiedHypotheses = hypotheses as ValueHypothesisV1[];

    const asOf = kernel.basis.asOf;
    if (portfolio.basis.asOf !== asOf || spectrum.asOf !== asOf ||
      portfolio.basis.specDigest !== kernel.basis.specDigest ||
      portfolio.basis.missionDigest !== kernel.basis.missionDigest ||
      portfolio.portfolioDigest !== kernel.basis.portfolioDigest ||
      spectrum.executionIdentityModelDigest !== kernel.basis.executionIdentityModelDigest ||
      spectrum.resourceEnvelopeDigest !== kernel.basis.resourceDigest) return fail('basis-mismatch');
    const renderedAtMs = Date.parse(input['renderedAt'] as string);
    const asOfMs = Date.parse(asOf);
    if (renderedAtMs < asOfMs || renderedAtMs - asOfMs > AGENT_OS_READ_MODEL_MAX_AGE_MS) {
      return fail('stale-snapshot');
    }

    const decisions = new Map(portfolio.decisions.map((decision) => [decision.hypothesisDigest, decision]));
    const hypothesisByDigest = new Map<string, ValueHypothesisV1>();
    for (const hypothesis of verifiedHypotheses) {
      if (hypothesisByDigest.has(hypothesis.hypothesisDigest)) return fail('duplicate-source-reference');
      if (hypothesis.specDigest !== kernel.basis.specDigest || hypothesis.missionDigest !== kernel.basis.missionDigest ||
        !decisions.has(hypothesis.hypothesisDigest)) return fail('unknown-source-reference');
      hypothesisByDigest.set(hypothesis.hypothesisDigest, hypothesis);
    }
    if (hypothesisByDigest.size !== decisions.size) return fail('unknown-source-reference');
    for (const decision of portfolio.decisions) {
      if (!['effective', 'refuted', 'guardrail-breached'].includes(decision.reason)) continue;
      const hypothesis = hypothesisByDigest.get(decision.hypothesisDigest);
      // verifyValueHypothesisV1 above accepted an evidence-bearing hypothesis
      // only after the injected verifier authenticated the observer receipt
      // and independently established the observer/producer separation.
      if (!hypothesis?.outcomeSource.evidence) return fail('source-authentication-failed');
    }

    const activeDecisions = portfolio.decisions
      .filter((decision) => decision.allocation !== null || decision.reason === 'outcome-window-open');
    if (activeDecisions.length > MAX_ACTIVE_VALUE_BETS) return fail('too-many-value-bets');
    const sourceVerification: AgentOsSourceBundleVerificationInputV1 = {
      renderedAt: input['renderedAt'] as string,
      kernelCycleDigest: kernel.cycleDigest,
      evidenceIndexDigest: kernel.basis.evidenceDigest,
      capabilityProjectionDigest: spectrum.projectionDigest,
      portfolioDigest: portfolio.portfolioDigest,
      hypothesisDigests: verifiedHypotheses.map((hypothesis) => hypothesis.hypothesisDigest).sort(),
      outcomeReceiptDigests: verifiedHypotheses.flatMap((hypothesis) =>
        hypothesis.outcomeSource.evidence ? [hypothesis.outcomeSource.evidence.receiptDigest] : []).sort(),
    };
    if (!sourceBundleAuthenticated(verifier, sourceVerification)) return fail('source-authentication-failed');

    const rank = new Map(portfolio.decisions.map((item) => [item.hypothesisDigest, item.rank ?? Number.MAX_SAFE_INTEGER]));
    const orderedActiveDecisions = [...activeDecisions].sort((left, right) =>
      (rank.get(left.hypothesisDigest)! - rank.get(right.hypothesisDigest)!) ||
      left.hypothesisDigest.localeCompare(right.hypothesisDigest));
    const activeValueBets = orderedActiveDecisions.map((decision, index) => {
      const hypothesis = hypothesisByDigest.get(decision.hypothesisDigest)!;
      const projectedDecision = decisionState(decision);
      const projectedOutcome = outcomeState(decision, hypothesis);
      const projectedEvidence = outcomeEvidenceState(hypothesis);
      return {
        key: hypothesis.hypothesisDigest,
        title: `Value bet ${index + 1}`,
        valueCase: valueCase(projectedDecision),
        allocationLabel: allocationLabel(projectedDecision),
        decision: projectedDecision,
        assurance: assuranceState(decision.assurance.depth),
        outcome: { state: projectedOutcome, label: outcomeLabel(projectedOutcome) },
        evidence: { state: projectedEvidence, label: evidenceLabel(projectedEvidence) },
      };
    });

    const capabilitySpectrum = DISPLAY_LANES.map((lane) => {
      const classDigest = digestCapabilityClassV1('model', MODEL_CLASS_LABEL[lane]);
      const resources = classDigest === null
        ? []
        : spectrum.inventory.filter((item) => item.kind === 'model' && item.classDigest === classDigest);
      const derived = derivedCapabilityState(resources, asOfMs);
      return {
        lane,
        label: LANE_LABELS[lane],
        ...derived,
        resetLabel: resetLabel(derived.resetUrgency),
        allocationLabel: capacityLabel(derived.headroom),
      };
    });
    const displaySourcesKnown = capabilitySpectrum.every((lane) =>
      lane.state !== 'unknown' && lane.headroom !== 'unknown' && lane.resetUrgency !== 'unknown') &&
      activeValueBets.every((bet) => bet.outcome.state !== 'unknown' && bet.evidence.state !== 'unknown' &&
        bet.evidence.state !== 'incomplete');
    const sourceHealthy = kernel.lifecycle !== 'degraded' && spectrum.projectionState === 'healthy' &&
      portfolio.resources.sourceComplete && kernel.sources.evidenceComplete && displaySourcesKnown;
    const snapshot: AgentOsReadModelV1 = {
      sourceState: sourceHealthy ? 'healthy' : 'degraded',
      livingEndState: {
        northStar: 'Convert governed engineering capacity into durable customer value.',
        currentBottleneck: bottleneck(sourceHealthy, portfolio.decisions),
        revisionLabel: 'Current mission basis',
        evidenceState: sourceHealthy ? 'complete' : 'incomplete',
      },
      capabilitySpectrum,
      activeValueBets,
      nextAction: nextAction(sourceHealthy, portfolio.decisions),
    };
    return {
      ok: true,
      snapshot,
      snapshotDigest: snapshotReceiptDigest({
        schemaVersion: AGENT_OS_READ_MODEL_SCHEMA_VERSION,
        sourceVerification,
        snapshot,
      }),
      issues: [],
    };
  } catch {
    return fail('invalid-input');
  }
}
