/**
 * Living End-State portfolio shadow.
 *
 * Pure caller-supplied decision support: no clocks, files, models, providers,
 * persistence, dispatch, or policy effects. Inputs are snapshotted, strictly
 * validated, sorted, and digest-bound before any score or allocation exists.
 */

import { createHash } from 'node:crypto';

export const VALUE_PORTFOLIO_SCHEMA_VERSION = 1 as const;
export const VALUE_PORTFOLIO_PROTOCOL = 'living-end-state-portfolio-shadow-v1' as const;
export const VALUE_PORTFOLIO_SCORING_POLICY = 'product-value-v1' as const;
export const MAX_VALUE_HYPOTHESES = 12;
export const MAX_ACTIVE_VALUE_BETS = 3;
export const MIN_PORTFOLIO_RESERVE_FRACTION = 0.1;
export const MAX_PORTFOLIO_RESERVE_FRACTION = 0.5;
export const MAX_VALUE_BET_FRACTION = 0.4;

const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const KEY_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const MAX_TEXT = 4_000;
const MAX_TOKENS = 1_000_000_000;
const MAX_MINUTES = 525_600;

type Digest = string;
type ProviderKind = 'codex' | 'claude' | 'local';
type CapacityState = 'open' | 'near' | 'unknown' | 'stale' | 'reserved' | 'exhausted';
type AssuranceDepth = 'fast-path' | 'targeted-challenge' | 'deep-review';
type PortfolioDisposition = 'continue' | 'hold' | 'stop';
type PortfolioReason =
  | 'allocated'
  | 'source-incomplete'
  | 'outcome-untrusted'
  | 'outcome-window-open'
  | 'dependency-blocked'
  | 'effective'
  | 'refuted'
  | 'guardrail-breached'
  | 'deadline-reached'
  | 'budget-exhausted'
  | 'inconclusive-limit'
  | 'marginal-value-low'
  | 'portfolio-cap'
  | 'insufficient-capacity';

export interface ValueHypothesisV1 {
  schemaVersion: 1;
  hypothesisId: Digest;
  hypothesisDigest: Digest;
  provenanceDigest: Digest;
  specDigest: Digest;
  missionDigest: Digest;
  missionNodeKey: string;
  producerDigest: Digest;
  claim: string;
  constraints: {
    dependenciesSatisfied: boolean;
    humanGateRequired: boolean;
    reversible: boolean;
    allowedProviders: ProviderKind[];
    shardable: boolean;
    shardPlanDigest: Digest | null;
  };
  frozenOutcome: {
    acceptanceContractDigest: Digest;
    baselineDigest: Digest;
    metric: string;
    unit: string;
    direction: 'increase' | 'decrease';
    effectiveThreshold: number;
    refutationThreshold: number;
    windowStart: string;
    windowEnd: string;
    minimumCausalGrade: 'observational' | 'quasi-experimental' | 'experimental';
  };
  budget: {
    maxTokens: number;
    maxMinutes: number;
    maxAttempts: number;
    maxInconclusiveWindows: number;
    spentTokens: number;
    spentMinutes: number;
    attempts: number;
    inconclusiveWindows: number;
    deadline: string;
    minimumMarginalValue: number;
  };
  factors: {
    productImpact: number;
    informationGain: number;
    strategicLeverage: number;
    ipLeverage: number;
    dependencyUnlock: number;
    probability: number;
    risk: number;
    uncertainty: number;
    estimatedTokens: number;
    estimatedMinutes: number;
    factorSourceDigest: Digest;
  };
  outcomeSource: {
    complete: boolean;
    sourceDigest: Digest;
    evidence: OutcomeEvidenceV1 | null;
  };
}

/** Neutral data format. This tag is not an authentication or truth claim. */
export interface OutcomeEvidenceV1 {
  format: 'outcome-evidence-v1';
  observerDigest: Digest;
  receiptDigest: Digest;
  artifactDigest: Digest;
  deploymentDigest: Digest;
  baselineDigest: Digest;
  acceptanceContractDigest: Digest;
  metric: string;
  value: number;
  observedAt: string;
  windowStart: string;
  windowEnd: string;
  causalGrade: 'observational' | 'quasi-experimental' | 'experimental';
  guardrailBreached: boolean;
}

export interface OutcomeEvidenceVerificationInputV1 {
  evidence: OutcomeEvidenceV1;
  sourceDigest: Digest;
  producerDigest: Digest;
  specDigest: Digest;
  missionDigest: Digest;
}

/**
 * Externally authenticated observer boundary. Implementations must verify the
 * receipt using a trust root outside this pure contract and independently
 * establish that the observer is not the hypothesis producer.
 */
export interface OutcomeEvidenceVerifierV1 {
  verifyOutcomeEvidence(
    input: Readonly<OutcomeEvidenceVerificationInputV1>,
  ): { authenticated: boolean; independentObserver: boolean };
}

export type ValueHypothesisDraftV1 = Omit<ValueHypothesisV1, 'hypothesisId' | 'hypothesisDigest'>;

export interface ResourceEnvelopeV1 {
  schemaVersion: 1;
  sourceComplete: boolean;
  sourceDigest: Digest;
  reserveFraction: number;
  capacity: Array<{
    executionIdentityDigest: Digest;
    provider: ProviderKind;
    state: CapacityState;
    trustedTokens: number;
    trustedMinutes: number;
    resetAt: string | null;
  }>;
}

interface ScoreFactorsV1 {
  productImpact: number;
  informationGain: number;
  strategicLeverage: number;
  ipLeverage: number;
  dependencyUnlock: number;
  probability: number;
  risk: number;
  uncertainty: number;
  tokenCost: number;
  timeCost: number;
  assuranceCost: number;
  expectedProductValue: number;
  grossValue: number;
  totalPenalty: number;
  marginalValue: number;
}

interface PortfolioDecisionV1 {
  hypothesisId: Digest;
  hypothesisDigest: Digest;
  missionNodeKey: string;
  disposition: PortfolioDisposition;
  reason: PortfolioReason;
  effective: boolean | null;
  score: number | null;
  rank: number | null;
  scoreFactors: ScoreFactorsV1 | null;
  assurance: {
    depth: AssuranceDepth;
    tokenObligation: number;
    minuteObligation: number;
  };
  allocation: {
    tokens: number;
    minutes: number;
    inventory: Array<{
      executionIdentityDigest: Digest;
      provider: ProviderKind;
      resetAt: string | null;
      tokens: number;
      minutes: number;
    }>;
  } | null;
}

export interface PortfolioShadowV1 {
  schemaVersion: 1;
  protocol: typeof VALUE_PORTFOLIO_PROTOCOL;
  recordType: 'value-portfolio';
  mode: 'shadow';
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  agentAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  rollbackAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
  budgetAuthority: false;
  learningAuthority: false;
  policyEligible: false;
  basis: {
    asOf: string;
    specDigest: Digest;
    missionDigest: Digest;
    resourceEnvelopeDigest: Digest;
  };
  bounds: {
    scoringPolicy: typeof VALUE_PORTFOLIO_SCORING_POLICY;
    maxCandidates: typeof MAX_VALUE_HYPOTHESES;
    maxActive: typeof MAX_ACTIVE_VALUE_BETS;
    minimumReserveFraction: typeof MIN_PORTFOLIO_RESERVE_FRACTION;
    maximumBetFraction: typeof MAX_VALUE_BET_FRACTION;
  };
  resources: {
    sourceComplete: boolean;
    usableTokens: number;
    usableMinutes: number;
    reservedTokens: number;
    reservedMinutes: number;
    allocatableTokens: number;
    allocatableMinutes: number;
  };
  decisions: PortfolioDecisionV1[];
  effects: {
    files: false;
    models: false;
    providers: false;
    dispatches: false;
    goals: false;
    proposals: false;
    merges: false;
    releases: false;
    deployments: false;
    rollbacks: false;
    publications: false;
    externalMutations: false;
    budgets: false;
    learning: false;
  };
  basisDigest: Digest;
  portfolioId: Digest;
  portfolioDigest: Digest;
}

export type PortfolioShadowBuildResultV1 =
  | { ok: true; portfolio: PortfolioShadowV1; issues: [] }
  | { ok: false; portfolio: null; issues: string[] };

const DRAFT_KEYS = new Set([
  'schemaVersion', 'provenanceDigest', 'specDigest', 'missionDigest', 'missionNodeKey', 'producerDigest', 'claim',
  'constraints', 'frozenOutcome', 'budget', 'factors', 'outcomeSource',
]);
const HYPOTHESIS_KEYS = new Set([...DRAFT_KEYS, 'hypothesisId', 'hypothesisDigest']);
const CONSTRAINT_KEYS = new Set([
  'dependenciesSatisfied', 'humanGateRequired', 'reversible', 'allowedProviders', 'shardable',
  'shardPlanDigest',
]);
const OUTCOME_KEYS = new Set([
  'acceptanceContractDigest', 'baselineDigest', 'metric', 'unit', 'direction', 'effectiveThreshold',
  'refutationThreshold', 'windowStart', 'windowEnd', 'minimumCausalGrade',
]);
const ACCEPTANCE_CONTRACT_KEYS = new Set([
  'baselineDigest', 'metric', 'unit', 'direction', 'effectiveThreshold', 'refutationThreshold',
  'windowStart', 'windowEnd', 'minimumCausalGrade',
]);
const BUDGET_KEYS = new Set([
  'maxTokens', 'maxMinutes', 'maxAttempts', 'maxInconclusiveWindows', 'spentTokens',
  'spentMinutes', 'attempts', 'inconclusiveWindows', 'deadline', 'minimumMarginalValue',
]);
const FACTOR_KEYS = new Set([
  'productImpact', 'informationGain', 'strategicLeverage', 'ipLeverage',
  'dependencyUnlock', 'probability', 'risk', 'uncertainty', 'estimatedTokens',
  'estimatedMinutes', 'factorSourceDigest',
]);
const SOURCE_KEYS = new Set(['complete', 'sourceDigest', 'evidence']);
const EVIDENCE_KEYS = new Set([
  'format', 'observerDigest', 'receiptDigest', 'artifactDigest', 'deploymentDigest',
  'baselineDigest', 'acceptanceContractDigest', 'metric', 'value', 'observedAt',
  'windowStart', 'windowEnd', 'causalGrade', 'guardrailBreached',
]);
const ENVELOPE_KEYS = new Set([
  'schemaVersion', 'sourceComplete', 'sourceDigest', 'reserveFraction', 'capacity',
]);
const CAPACITY_KEYS = new Set([
  'executionIdentityDigest', 'provider', 'state', 'trustedTokens', 'trustedMinutes', 'resetAt',
]);

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
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

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function digest(value: unknown, domain: string): Digest {
  return createHash('sha256').update(domain, 'utf8').update('\0')
    .update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

const PRIVATE_TEXT_RE = /(?:^|[^A-Za-z0-9])(?:\/(?:Users|home|private|var|tmp|etc)\/|~\/|[A-Za-z]:\\)|\b(?:CODEX_HOME|CLAUDE_CONFIG_DIR|identityRef|accountRef|runtimeLocator)\b/i;
const SECRET_TEXT_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|bearer|access[_-]?token)\s*[:=]\s*\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/i;

function text(value: unknown, maximum = MAX_TEXT): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 &&
    value.length <= maximum && !PRIVATE_TEXT_RE.test(value) && !SECRET_TEXT_RE.test(value);
}

function normalizedDigest(value: unknown): value is Digest {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function clone<T>(value: T): T | null {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return null;
  }
}

/** Canonical digest of every frozen acceptance-contract field. */
export function acceptanceContractDigestV1(value: unknown): Digest | null {
  const snapshot = clone(value);
  const row = record(snapshot);
  if (!row || !exactKeys(row, ACCEPTANCE_CONTRACT_KEYS) ||
    !normalizedDigest(row['baselineDigest']) || !text(row['metric'], 200) ||
    !text(row['unit'], 80) || (row['direction'] !== 'increase' && row['direction'] !== 'decrease') ||
    !finite(row['effectiveThreshold'], -Number.MAX_VALUE, Number.MAX_VALUE) ||
    !finite(row['refutationThreshold'], -Number.MAX_VALUE, Number.MAX_VALUE) ||
    (row['direction'] === 'increase' && row['effectiveThreshold'] <= row['refutationThreshold']) ||
    (row['direction'] === 'decrease' && row['effectiveThreshold'] >= row['refutationThreshold']) ||
    !timestamp(row['windowStart']) || !timestamp(row['windowEnd']) ||
    (row['windowStart'] as string) >= (row['windowEnd'] as string) ||
    !['observational', 'quasi-experimental', 'experimental'].includes(String(row['minimumCausalGrade']))) {
    return null;
  }
  return digest(snapshot, 'ashlr:acceptance-contract:v1');
}

function authenticateOutcomeEvidence(
  verifier: OutcomeEvidenceVerifierV1 | null,
  input: OutcomeEvidenceVerificationInputV1,
): boolean {
  if (!verifier) return false;
  try {
    const result = verifier.verifyOutcomeEvidence(input);
    return result?.authenticated === true && result.independentObserver === true;
  } catch {
    return false;
  }
}

function parseHypothesis(
  value: unknown,
  draft: boolean,
  verifier: OutcomeEvidenceVerifierV1 | null,
): ValueHypothesisV1 | ValueHypothesisDraftV1 | null {
  const snapshot = clone(value);
  const row = record(snapshot);
  const expected = draft ? DRAFT_KEYS : HYPOTHESIS_KEYS;
  if (!row || !exactKeys(row, expected) || row['schemaVersion'] !== 1 ||
    !normalizedDigest(row['specDigest']) || !normalizedDigest(row['missionDigest']) ||
    !KEY_RE.test(String(row['missionNodeKey'])) || !normalizedDigest(row['producerDigest']) ||
    !text(row['claim'])) return null;
  const constraints = record(row['constraints']);
  const outcome = record(row['frozenOutcome']);
  const budget = record(row['budget']);
  const factors = record(row['factors']);
  const source = record(row['outcomeSource']);
  if (!constraints || !exactKeys(constraints, CONSTRAINT_KEYS) ||
    !normalizedDigest(row['provenanceDigest']) ||
    typeof constraints['dependenciesSatisfied'] !== 'boolean' ||
    typeof constraints['humanGateRequired'] !== 'boolean' ||
    typeof constraints['reversible'] !== 'boolean' || typeof constraints['shardable'] !== 'boolean' ||
    !Array.isArray(constraints['allowedProviders']) || constraints['allowedProviders'].length < 1 ||
    constraints['allowedProviders'].length > 3 ||
    constraints['allowedProviders'].some((entry) => !['codex', 'claude', 'local'].includes(String(entry))) ||
    new Set(constraints['allowedProviders']).size !== constraints['allowedProviders'].length ||
    (constraints['shardable'] === true && !normalizedDigest(constraints['shardPlanDigest'])) ||
    (constraints['shardable'] === false && constraints['shardPlanDigest'] !== null) ||
    !outcome || !exactKeys(outcome, OUTCOME_KEYS) ||
    !normalizedDigest(outcome['acceptanceContractDigest']) ||
    !normalizedDigest(outcome['baselineDigest']) || !text(outcome['metric'], 200) ||
    !text(outcome['unit'], 80) || (outcome['direction'] !== 'increase' && outcome['direction'] !== 'decrease') ||
    !finite(outcome['effectiveThreshold'], -Number.MAX_VALUE, Number.MAX_VALUE) ||
    !finite(outcome['refutationThreshold'], -Number.MAX_VALUE, Number.MAX_VALUE) ||
    (outcome['direction'] === 'increase' && outcome['effectiveThreshold'] <= outcome['refutationThreshold']) ||
    (outcome['direction'] === 'decrease' && outcome['effectiveThreshold'] >= outcome['refutationThreshold']) ||
    !timestamp(outcome['windowStart']) || !timestamp(outcome['windowEnd']) ||
    (outcome['windowStart'] as string) >= (outcome['windowEnd'] as string) ||
    !['observational', 'quasi-experimental', 'experimental'].includes(String(outcome['minimumCausalGrade'])) ||
    !budget || !exactKeys(budget, BUDGET_KEYS) || !integer(budget['maxTokens'], 1, MAX_TOKENS) ||
    !integer(budget['maxMinutes'], 1, MAX_MINUTES) || !integer(budget['maxAttempts'], 1, 1_000) ||
    !integer(budget['maxInconclusiveWindows'], 1, 100) ||
    !integer(budget['spentTokens'], 0, MAX_TOKENS) || !integer(budget['spentMinutes'], 0, MAX_MINUTES) ||
    !integer(budget['attempts'], 0, 1_000) || !integer(budget['inconclusiveWindows'], 0, 100) ||
    !timestamp(budget['deadline']) || (budget['deadline'] as string) < (outcome['windowEnd'] as string) ||
    !finite(budget['minimumMarginalValue'], 0, 1) ||
    !factors || !exactKeys(factors, FACTOR_KEYS)) return null;
  const { acceptanceContractDigest: _acceptanceDigest, ...acceptanceContract } = outcome;
  if (outcome['acceptanceContractDigest'] !== acceptanceContractDigestV1(acceptanceContract)) return null;
  for (const key of ['productImpact', 'informationGain', 'strategicLeverage', 'ipLeverage',
    'dependencyUnlock', 'probability', 'risk', 'uncertainty']) {
    if (!finite(factors[key], 0, 1)) return null;
  }
  if (!integer(factors['estimatedTokens'], 1, MAX_TOKENS) ||
    !integer(factors['estimatedMinutes'], 1, MAX_MINUTES) ||
    !normalizedDigest(factors['factorSourceDigest']) ||
    !source || !exactKeys(source, SOURCE_KEYS) || typeof source['complete'] !== 'boolean' ||
    !normalizedDigest(source['sourceDigest'])) return null;
  if (source['evidence'] !== null) {
    const evidence = record(source['evidence']);
    if (!evidence || !exactKeys(evidence, EVIDENCE_KEYS) ||
      evidence['format'] !== 'outcome-evidence-v1' ||
      !normalizedDigest(evidence['observerDigest']) || !normalizedDigest(evidence['receiptDigest']) ||
      !normalizedDigest(evidence['artifactDigest']) || !normalizedDigest(evidence['deploymentDigest']) ||
      !normalizedDigest(evidence['baselineDigest']) ||
      !normalizedDigest(evidence['acceptanceContractDigest']) ||
      !text(evidence['metric'], 200) || !finite(evidence['value'], -Number.MAX_VALUE, Number.MAX_VALUE) ||
      !timestamp(evidence['observedAt']) || !timestamp(evidence['windowStart']) ||
      !timestamp(evidence['windowEnd']) ||
      !['observational', 'quasi-experimental', 'experimental'].includes(String(evidence['causalGrade'])) ||
      typeof evidence['guardrailBreached'] !== 'boolean' || source['complete'] !== true ||
      evidence['acceptanceContractDigest'] !== outcome['acceptanceContractDigest'] ||
      evidence['baselineDigest'] !== outcome['baselineDigest'] ||
      evidence['metric'] !== outcome['metric'] || evidence['windowStart'] !== outcome['windowStart'] ||
      evidence['windowEnd'] !== outcome['windowEnd']) return null;
    if (!authenticateOutcomeEvidence(verifier, {
      evidence: evidence as unknown as OutcomeEvidenceV1,
      sourceDigest: source['sourceDigest'] as string,
      producerDigest: row['producerDigest'] as string,
      specDigest: row['specDigest'] as string,
      missionDigest: row['missionDigest'] as string,
    })) return null;
  }
  if (!draft && (!normalizedDigest(row['hypothesisId']) || !normalizedDigest(row['hypothesisDigest']))) return null;
  (constraints['allowedProviders'] as ProviderKind[]).sort(compareText);
  return snapshot as ValueHypothesisV1 | ValueHypothesisDraftV1;
}

function hypothesisIdentityPayload(value: ValueHypothesisDraftV1): unknown {
  return {
    provenanceDigest: value.provenanceDigest,
    specDigest: value.specDigest,
    missionDigest: value.missionDigest,
    missionNodeKey: value.missionNodeKey,
    producerDigest: value.producerDigest,
    claim: value.claim,
    frozenOutcome: value.frozenOutcome,
  };
}

export function createValueHypothesisV1(
  value: unknown,
  verifier: OutcomeEvidenceVerifierV1 | null = null,
): ValueHypothesisV1 | null {
  const draft = parseHypothesis(value, true, verifier) as ValueHypothesisDraftV1 | null;
  if (!draft) return null;
  const hypothesisId = digest(hypothesisIdentityPayload(draft), 'ashlr:value-hypothesis:id:v1');
  const unsigned = { ...draft, hypothesisId };
  return {
    ...unsigned,
    hypothesisDigest: digest(unsigned, 'ashlr:value-hypothesis:v1'),
  };
}

export function verifyValueHypothesisV1(
  value: unknown,
  verifier: OutcomeEvidenceVerifierV1 | null = null,
): ValueHypothesisV1 | null {
  const parsed = parseHypothesis(value, false, verifier) as ValueHypothesisV1 | null;
  if (!parsed) return null;
  const { hypothesisId: _id, hypothesisDigest: _digest, ...draft } = parsed;
  const rebuilt = createValueHypothesisV1(draft, verifier);
  return rebuilt && rebuilt.hypothesisId === parsed.hypothesisId &&
    rebuilt.hypothesisDigest === parsed.hypothesisDigest ? rebuilt : null;
}

function parseEnvelope(value: unknown): ResourceEnvelopeV1 | null {
  const snapshot = clone(value);
  const row = record(snapshot);
  if (!row || !exactKeys(row, ENVELOPE_KEYS) || row['schemaVersion'] !== 1 ||
    typeof row['sourceComplete'] !== 'boolean' || !normalizedDigest(row['sourceDigest']) ||
    !finite(row['reserveFraction'], MIN_PORTFOLIO_RESERVE_FRACTION, MAX_PORTFOLIO_RESERVE_FRACTION) ||
    !Array.isArray(row['capacity']) || row['capacity'].length > 32) return null;
  const capacity = clone(row['capacity']);
  if (!capacity || capacity.some((entry) => {
    const item = record(entry);
    return !item || !exactKeys(item, CAPACITY_KEYS) ||
      !normalizedDigest(item['executionIdentityDigest']) ||
      !['codex', 'claude', 'local'].includes(String(item['provider'])) ||
      !['open', 'near', 'unknown', 'stale', 'reserved', 'exhausted'].includes(String(item['state'])) ||
      !integer(item['trustedTokens'], 0, MAX_TOKENS) || !integer(item['trustedMinutes'], 0, MAX_MINUTES) ||
      (item['resetAt'] !== null && !timestamp(item['resetAt']));
  })) return null;
  const seen = new Set<string>();
  for (const item of capacity as ResourceEnvelopeV1['capacity']) {
    if (seen.has(item.executionIdentityDigest)) return null;
    seen.add(item.executionIdentityDigest);
  }
  return {
    schemaVersion: 1,
    sourceComplete: row['sourceComplete'] as boolean,
    sourceDigest: row['sourceDigest'] as string,
    reserveFraction: row['reserveFraction'] as number,
    capacity: capacity as ResourceEnvelopeV1['capacity'],
  };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assurance(hypothesis: ValueHypothesisV1): PortfolioDecisionV1['assurance'] {
  const exposure = Math.max(hypothesis.factors.risk, hypothesis.factors.uncertainty,
    hypothesis.constraints.reversible ? 0 : 0.8);
  const depth: AssuranceDepth = exposure >= 0.75
    ? 'deep-review'
    : exposure >= 0.45 ? 'targeted-challenge' : 'fast-path';
  const fraction = depth === 'deep-review' ? 0.2 : depth === 'targeted-challenge' ? 0.1 : 0;
  return {
    depth,
    tokenObligation: Math.ceil(hypothesis.factors.estimatedTokens * fraction),
    minuteObligation: Math.ceil(hypothesis.factors.estimatedMinutes * fraction),
  };
}

function score(hypothesis: ValueHypothesisV1, obligation: PortfolioDecisionV1['assurance']): ScoreFactorsV1 {
  const factors = hypothesis.factors;
  const tokenCost = Math.min(1, (factors.estimatedTokens + obligation.tokenObligation) / 1_000_000);
  const timeCost = Math.min(1, (factors.estimatedMinutes + obligation.minuteObligation) / 480);
  const assuranceCost = Math.max(
    obligation.tokenObligation / Math.max(1, factors.estimatedTokens),
    obligation.minuteObligation / Math.max(1, factors.estimatedMinutes),
  );
  // product-value-v1: probability applies only to product impact. Information
  // gain and option/IP leverage retain value even when the product bet fails.
  const expectedProductValue = factors.probability * factors.productImpact * 0.4;
  const grossValue = expectedProductValue + factors.informationGain * 0.25 +
    factors.strategicLeverage * 0.15 + factors.ipLeverage * 0.12 +
    factors.dependencyUnlock * 0.08;
  const totalPenalty = factors.risk * 0.1 + tokenCost * 0.05 + timeCost * 0.05 +
    assuranceCost * 0.05;
  const marginalValue = round(Math.max(0, Math.min(1, grossValue - totalPenalty)));
  return {
    productImpact: factors.productImpact,
    informationGain: factors.informationGain,
    strategicLeverage: factors.strategicLeverage,
    ipLeverage: factors.ipLeverage,
    dependencyUnlock: factors.dependencyUnlock,
    probability: factors.probability,
    risk: factors.risk,
    uncertainty: factors.uncertainty,
    tokenCost: round(tokenCost),
    timeCost: round(timeCost),
    assuranceCost: round(assuranceCost),
    expectedProductValue: round(expectedProductValue),
    grossValue: round(grossValue),
    totalPenalty: round(totalPenalty),
    marginalValue,
  };
}

function trustedOutcome(
  hypothesis: ValueHypothesisV1,
  asOf: string,
): { trusted: boolean; observing: boolean; effective: boolean | null; refuted: boolean; guardrail: boolean } {
  const source = hypothesis.outcomeSource;
  if (!source.complete) {
    return { trusted: false, observing: false, effective: null, refuted: false, guardrail: false };
  }
  if (!source.evidence) {
    return { trusted: true, observing: false, effective: null, refuted: false, guardrail: false };
  }
  const evidence = source.evidence;
  const causalRanks = { observational: 0, 'quasi-experimental': 1, experimental: 2 } as const;
  const frozen = hypothesis.frozenOutcome;
  const trusted = evidence.observerDigest !== hypothesis.producerDigest &&
    evidence.acceptanceContractDigest === frozen.acceptanceContractDigest &&
    evidence.baselineDigest === frozen.baselineDigest &&
    evidence.metric === frozen.metric && evidence.windowStart === frozen.windowStart &&
    evidence.windowEnd === frozen.windowEnd && evidence.observedAt >= frozen.windowStart &&
    evidence.observedAt <= asOf &&
    causalRanks[evidence.causalGrade] >= causalRanks[frozen.minimumCausalGrade];
  if (!trusted) {
    return { trusted: false, observing: false, effective: null, refuted: false, guardrail: false };
  }
  if (evidence.guardrailBreached) {
    return { trusted: true, observing: false, effective: null, refuted: false, guardrail: true };
  }
  if (asOf < frozen.windowEnd || evidence.observedAt < frozen.windowEnd) {
    return { trusted: true, observing: true, effective: null, refuted: false, guardrail: false };
  }
  const effective = hypothesis.frozenOutcome.direction === 'increase'
    ? evidence.value >= hypothesis.frozenOutcome.effectiveThreshold
    : evidence.value <= hypothesis.frozenOutcome.effectiveThreshold;
  const refuted = hypothesis.frozenOutcome.direction === 'increase'
    ? evidence.value <= hypothesis.frozenOutcome.refutationThreshold
    : evidence.value >= hypothesis.frozenOutcome.refutationThreshold;
  return { trusted: true, observing: false, effective, refuted, guardrail: false };
}

interface CandidateDecision {
  decision: PortfolioDecisionV1;
  demandTokens: number;
  demandMinutes: number;
}

function evaluateHypothesis(hypothesis: ValueHypothesisV1, asOf: string): CandidateDecision {
  const requiredAssurance = assurance(hypothesis);
  const demandTokens = hypothesis.factors.estimatedTokens + requiredAssurance.tokenObligation;
  const demandMinutes = hypothesis.factors.estimatedMinutes + requiredAssurance.minuteObligation;
  const base = {
    hypothesisId: hypothesis.hypothesisId,
    hypothesisDigest: hypothesis.hypothesisDigest,
    missionNodeKey: hypothesis.missionNodeKey,
    rank: null,
    assurance: requiredAssurance,
    allocation: null,
  };
  const terminal = (
    disposition: PortfolioDisposition,
    reason: PortfolioReason,
    effective: boolean | null,
    scoreFactors: ScoreFactorsV1 | null = null,
  ): CandidateDecision => ({
    demandTokens,
    demandMinutes,
    decision: {
      ...base,
      disposition,
      reason,
      effective,
      score: scoreFactors?.marginalValue ?? null,
      scoreFactors,
    },
  });
  const outcome = trustedOutcome(hypothesis, asOf);
  if (!hypothesis.outcomeSource.complete) return terminal('hold', 'source-incomplete', null);
  if (!outcome.trusted) return terminal('hold', 'outcome-untrusted', null);
  if (outcome.guardrail) return terminal('stop', 'guardrail-breached', false);
  if (outcome.observing) return terminal('hold', 'outcome-window-open', null);
  if (outcome.effective === true) return terminal('stop', 'effective', true);
  if (outcome.refuted) return terminal('stop', 'refuted', false);
  if (asOf >= hypothesis.budget.deadline) return terminal('stop', 'deadline-reached', null);
  if (hypothesis.budget.spentTokens + demandTokens > hypothesis.budget.maxTokens ||
    hypothesis.budget.spentMinutes + demandMinutes > hypothesis.budget.maxMinutes ||
    hypothesis.budget.attempts >= hypothesis.budget.maxAttempts) {
    return terminal('stop', 'budget-exhausted', null);
  }
  if (hypothesis.budget.inconclusiveWindows >= hypothesis.budget.maxInconclusiveWindows) {
    return terminal('stop', 'inconclusive-limit', null);
  }
  if (!hypothesis.constraints.dependenciesSatisfied) return terminal('hold', 'dependency-blocked', null);
  const scoreFactors = score(hypothesis, requiredAssurance);
  if (scoreFactors.marginalValue < hypothesis.budget.minimumMarginalValue) {
    return terminal('stop', 'marginal-value-low', null, scoreFactors);
  }
  return terminal('continue', 'insufficient-capacity', null, scoreFactors);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function envelopeDigest(envelope: ResourceEnvelopeV1): Digest {
  return digest({
    ...envelope,
    capacity: [...envelope.capacity].sort((left, right) =>
      compareText(left.executionIdentityDigest, right.executionIdentityDigest)),
  }, 'ashlr:resource-envelope:v1');
}

/** Strictly snapshots and verifies a resource envelope without consulting any runtime source. */
export function verifyResourceEnvelopeV1(value: unknown): ResourceEnvelopeV1 | null {
  return parseEnvelope(value);
}

/** Returns the canonical resource-envelope digest used by portfolio basis receipts. */
export function digestResourceEnvelopeV1(value: unknown): string | null {
  const envelope = parseEnvelope(value);
  return envelope ? envelopeDigest(envelope) : null;
}

function usableCapacity(envelope: ResourceEnvelopeV1, asOf: string): ResourceEnvelopeV1['capacity'] {
  if (!envelope.sourceComplete) return [];
  return envelope.capacity.filter((item) =>
    (item.state === 'open' || item.state === 'near') && item.trustedTokens > 0 &&
    item.trustedMinutes > 0 && (item.resetAt === null || item.resetAt > asOf))
    .sort((left, right) => {
      if (left.resetAt === right.resetAt) {
        return compareText(left.executionIdentityDigest, right.executionIdentityDigest);
      }
      if (left.resetAt === null) return 1;
      if (right.resetAt === null) return -1;
      return compareText(left.resetAt, right.resetAt);
    });
}

function allocateInventory(
  capacity: ResourceEnvelopeV1['capacity'],
  remaining: Map<string, { tokens: number; minutes: number }>,
  tokens: number,
  minutes: number,
  allowedProviders: readonly ProviderKind[],
  shardable: boolean,
): NonNullable<PortfolioDecisionV1['allocation']>['inventory'] | null {
  const eligible = capacity.filter((item) => allowedProviders.includes(item.provider));
  if (!shardable) {
    const item = eligible.find((candidate) => {
      const available = remaining.get(candidate.executionIdentityDigest)!;
      return available.tokens >= tokens && available.minutes >= minutes;
    });
    if (!item) return null;
    const available = remaining.get(item.executionIdentityDigest)!;
    available.tokens -= tokens;
    available.minutes -= minutes;
    return [{
      executionIdentityDigest: item.executionIdentityDigest,
      provider: item.provider,
      resetAt: item.resetAt,
      tokens,
      minutes,
    }];
  }
  let tokensNeeded = tokens;
  let minutesNeeded = minutes;
  const inventory: NonNullable<PortfolioDecisionV1['allocation']>['inventory'] = [];
  for (const item of eligible) {
    const available = remaining.get(item.executionIdentityDigest)!;
    const takeTokens = Math.min(tokensNeeded, available.tokens);
    const takeMinutes = Math.min(minutesNeeded, available.minutes);
    if (takeTokens === 0 && takeMinutes === 0) continue;
    inventory.push({
      executionIdentityDigest: item.executionIdentityDigest,
      provider: item.provider,
      resetAt: item.resetAt,
      tokens: takeTokens,
      minutes: takeMinutes,
    });
    tokensNeeded -= takeTokens;
    minutesNeeded -= takeMinutes;
    if (tokensNeeded === 0 && minutesNeeded === 0) break;
  }
  if (tokensNeeded > 0 || minutesNeeded > 0) return null;
  for (const used of inventory) {
    const available = remaining.get(used.executionIdentityDigest)!;
    available.tokens -= used.tokens;
    available.minutes -= used.minutes;
  }
  return inventory;
}

export function buildPortfolioShadowV1(
  value: unknown,
  verifier: OutcomeEvidenceVerifierV1 | null = null,
): PortfolioShadowBuildResultV1 {
  const snapshot = clone(value);
  const input = record(snapshot);
  const inputKeys = new Set(['schemaVersion', 'asOf', 'specDigest', 'missionDigest', 'resourceEnvelope', 'hypotheses']);
  if (!input || !exactKeys(input, inputKeys) || input['schemaVersion'] !== 1 ||
    !timestamp(input['asOf']) || !normalizedDigest(input['specDigest']) ||
    !normalizedDigest(input['missionDigest']) || !Array.isArray(input['hypotheses']) ||
    input['hypotheses'].length > MAX_VALUE_HYPOTHESES) {
    return { ok: false, portfolio: null, issues: ['invalid-input'] };
  }
  const envelope = parseEnvelope(input['resourceEnvelope']);
  const hypotheses = input['hypotheses'].map((hypothesis) => verifyValueHypothesisV1(hypothesis, verifier));
  if (!envelope || hypotheses.some((entry) => entry === null)) {
    return { ok: false, portfolio: null, issues: ['invalid-input'] };
  }
  const normalized = hypotheses as ValueHypothesisV1[];
  normalized.sort((left, right) => compareText(left.hypothesisId, right.hypothesisId));
  const seenIds = new Set<string>();
  const seenNodes = new Set<string>();
  for (const hypothesis of normalized) {
    if (hypothesis.specDigest !== input['specDigest'] || hypothesis.missionDigest !== input['missionDigest']) {
      return { ok: false, portfolio: null, issues: ['hypothesis-binding-mismatch'] };
    }
    if (seenIds.has(hypothesis.hypothesisId) || seenNodes.has(hypothesis.missionNodeKey)) {
      return { ok: false, portfolio: null, issues: ['duplicate-hypothesis'] };
    }
    seenIds.add(hypothesis.hypothesisId);
    seenNodes.add(hypothesis.missionNodeKey);
  }

  const asOf = input['asOf'] as string;
  const capacity = usableCapacity(envelope, asOf);
  const usableTokens = capacity.reduce((sum, item) => sum + item.trustedTokens, 0);
  const usableMinutes = capacity.reduce((sum, item) => sum + item.trustedMinutes, 0);
  const reservedTokens = Math.ceil(usableTokens * envelope.reserveFraction);
  const reservedMinutes = Math.ceil(usableMinutes * envelope.reserveFraction);
  const allocatableTokens = Math.max(0, usableTokens - reservedTokens);
  const allocatableMinutes = Math.max(0, usableMinutes - reservedMinutes);
  const perBetTokens = Math.floor(usableTokens * MAX_VALUE_BET_FRACTION);
  const perBetMinutes = Math.floor(usableMinutes * MAX_VALUE_BET_FRACTION);
  const candidates = normalized.map((hypothesis) => evaluateHypothesis(hypothesis, asOf));
  const ranked = candidates.filter((candidate) => candidate.decision.disposition === 'continue')
    .sort((left, right) => (right.decision.score! - left.decision.score!) ||
      compareText(left.decision.hypothesisId, right.decision.hypothesisId));
  ranked.forEach((candidate, index) => { candidate.decision.rank = index + 1; });

  let portfolioTokens = allocatableTokens;
  let portfolioMinutes = allocatableMinutes;
  let active = 0;
  const remaining = new Map(capacity.map((item) => [item.executionIdentityDigest, {
    tokens: item.trustedTokens,
    minutes: item.trustedMinutes,
  }]));
  for (const candidate of ranked) {
    if (active >= MAX_ACTIVE_VALUE_BETS) {
      candidate.decision.disposition = 'hold';
      candidate.decision.reason = 'portfolio-cap';
      continue;
    }
    if (candidate.demandTokens > perBetTokens || candidate.demandMinutes > perBetMinutes ||
      candidate.demandTokens > portfolioTokens || candidate.demandMinutes > portfolioMinutes) {
      candidate.decision.disposition = 'hold';
      candidate.decision.reason = 'insufficient-capacity';
      continue;
    }
    const hypothesis = normalized.find((entry) => entry.hypothesisId === candidate.decision.hypothesisId)!;
    const inventory = allocateInventory(
      capacity, remaining, candidate.demandTokens, candidate.demandMinutes,
      hypothesis.constraints.allowedProviders, hypothesis.constraints.shardable,
    );
    if (!inventory) {
      candidate.decision.disposition = 'hold';
      candidate.decision.reason = 'insufficient-capacity';
      continue;
    }
    portfolioTokens -= candidate.demandTokens;
    portfolioMinutes -= candidate.demandMinutes;
    active += 1;
    candidate.decision.reason = 'allocated';
    candidate.decision.allocation = {
      tokens: candidate.demandTokens,
      minutes: candidate.demandMinutes,
      inventory,
    };
  }

  const resourceEnvelopeDigest = envelopeDigest(envelope);
  const basis = {
    asOf,
    specDigest: input['specDigest'] as string,
    missionDigest: input['missionDigest'] as string,
    resourceEnvelopeDigest,
  };
  const basisDigest = digest(basis, 'ashlr:value-portfolio:basis:v1');
  const portfolioId = digest([
    VALUE_PORTFOLIO_SCORING_POLICY, basisDigest,
    ...normalized.map((hypothesis) => hypothesis.hypothesisDigest),
  ], 'ashlr:value-portfolio:id:v1');
  const unsigned: Omit<PortfolioShadowV1, 'portfolioDigest'> = {
    schemaVersion: 1,
    protocol: VALUE_PORTFOLIO_PROTOCOL,
    recordType: 'value-portfolio',
    mode: 'shadow',
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    agentAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    rollbackAuthority: false,
    publicationAuthority: false,
    externalMutationAuthority: false,
    budgetAuthority: false,
    learningAuthority: false,
    policyEligible: false,
    basis,
    bounds: {
      scoringPolicy: VALUE_PORTFOLIO_SCORING_POLICY,
      maxCandidates: MAX_VALUE_HYPOTHESES,
      maxActive: MAX_ACTIVE_VALUE_BETS,
      minimumReserveFraction: MIN_PORTFOLIO_RESERVE_FRACTION,
      maximumBetFraction: MAX_VALUE_BET_FRACTION,
    },
    resources: {
      sourceComplete: envelope.sourceComplete,
      usableTokens,
      usableMinutes,
      reservedTokens,
      reservedMinutes,
      allocatableTokens,
      allocatableMinutes,
    },
    decisions: candidates.map((candidate) => candidate.decision)
      .sort((left, right) => compareText(left.hypothesisId, right.hypothesisId)),
    effects: {
      files: false,
      models: false,
      providers: false,
      dispatches: false,
      goals: false,
      proposals: false,
      merges: false,
      releases: false,
      deployments: false,
      rollbacks: false,
      publications: false,
      externalMutations: false,
      budgets: false,
      learning: false,
    },
    basisDigest,
    portfolioId,
  };
  return {
    ok: true,
    issues: [],
    portfolio: {
      ...unsigned,
      portfolioDigest: digest(unsigned, 'ashlr:value-portfolio:v1'),
    },
  };
}

const PORTFOLIO_KEYS = new Set([
  'schemaVersion', 'protocol', 'recordType', 'mode', 'authority', 'planningAuthority',
  'executionAuthority', 'proposalAuthority', 'agentAuthority', 'mergeAuthority',
  'releaseAuthority', 'deployAuthority', 'rollbackAuthority', 'publicationAuthority',
  'externalMutationAuthority', 'budgetAuthority', 'learningAuthority', 'policyEligible',
  'basis', 'bounds', 'resources', 'decisions', 'effects', 'basisDigest', 'portfolioId',
  'portfolioDigest',
]);
const BASIS_KEYS = new Set(['asOf', 'specDigest', 'missionDigest', 'resourceEnvelopeDigest']);
const BOUNDS_KEYS = new Set([
  'scoringPolicy', 'maxCandidates', 'maxActive', 'minimumReserveFraction', 'maximumBetFraction',
]);
const RESOURCE_KEYS = new Set([
  'sourceComplete', 'usableTokens', 'usableMinutes', 'reservedTokens', 'reservedMinutes',
  'allocatableTokens', 'allocatableMinutes',
]);
const DECISION_KEYS = new Set([
  'hypothesisId', 'hypothesisDigest', 'missionNodeKey', 'disposition', 'reason', 'effective',
  'score', 'rank', 'scoreFactors', 'assurance', 'allocation',
]);
const SCORE_KEYS = new Set([
  'productImpact', 'informationGain', 'strategicLeverage', 'ipLeverage', 'dependencyUnlock',
  'probability', 'risk', 'uncertainty', 'tokenCost', 'timeCost', 'assuranceCost',
  'expectedProductValue', 'grossValue', 'totalPenalty', 'marginalValue',
]);
const ASSURANCE_KEYS = new Set(['depth', 'tokenObligation', 'minuteObligation']);
const ALLOCATION_KEYS = new Set(['tokens', 'minutes', 'inventory']);
const INVENTORY_KEYS = new Set([
  'executionIdentityDigest', 'provider', 'resetAt', 'tokens', 'minutes',
]);
const EFFECT_KEYS = new Set([
  'files', 'models', 'providers', 'dispatches', 'goals', 'proposals', 'merges', 'releases',
  'deployments', 'rollbacks', 'publications', 'externalMutations', 'budgets', 'learning',
]);
const REASONS = new Set<PortfolioReason>([
  'allocated', 'source-incomplete', 'outcome-untrusted', 'outcome-window-open', 'dependency-blocked',
  'effective', 'refuted', 'guardrail-breached', 'deadline-reached',
  'budget-exhausted', 'inconclusive-limit', 'marginal-value-low', 'portfolio-cap',
  'insufficient-capacity',
]);

function validDecision(value: unknown): boolean {
  const row = record(value);
  if (!row || !exactKeys(row, DECISION_KEYS) || !normalizedDigest(row['hypothesisId']) ||
    !normalizedDigest(row['hypothesisDigest']) || !KEY_RE.test(String(row['missionNodeKey'])) ||
    !['continue', 'hold', 'stop'].includes(String(row['disposition'])) ||
    !REASONS.has(row['reason'] as PortfolioReason) ||
    (row['effective'] !== null && typeof row['effective'] !== 'boolean') ||
    (row['score'] !== null && !finite(row['score'], 0, 1)) ||
    (row['rank'] !== null && !integer(row['rank'], 1, MAX_VALUE_HYPOTHESES))) return false;
  const assuranceRow = record(row['assurance']);
  if (!assuranceRow || !exactKeys(assuranceRow, ASSURANCE_KEYS) ||
    !['fast-path', 'targeted-challenge', 'deep-review'].includes(String(assuranceRow['depth'])) ||
    !integer(assuranceRow['tokenObligation'], 0, MAX_TOKENS) ||
    !integer(assuranceRow['minuteObligation'], 0, MAX_MINUTES)) return false;
  if (row['scoreFactors'] !== null) {
    const scoreRow = record(row['scoreFactors']);
    if (!scoreRow || !exactKeys(scoreRow, SCORE_KEYS) ||
      Object.values(scoreRow).some((entry) => !finite(entry, 0, 1))) return false;
  }
  if (row['allocation'] !== null) {
    const allocation = record(row['allocation']);
    if (!allocation || !exactKeys(allocation, ALLOCATION_KEYS) ||
      !integer(allocation['tokens'], 1, MAX_TOKENS) || !integer(allocation['minutes'], 1, MAX_MINUTES) ||
      !Array.isArray(allocation['inventory']) || allocation['inventory'].length === 0) return false;
    for (const rawItem of allocation['inventory']) {
      const item = record(rawItem);
      if (!item || !exactKeys(item, INVENTORY_KEYS) ||
        !normalizedDigest(item['executionIdentityDigest']) ||
        !['codex', 'claude', 'local'].includes(String(item['provider'])) ||
        (item['resetAt'] !== null && !timestamp(item['resetAt'])) ||
        !integer(item['tokens'], 0, MAX_TOKENS) || !integer(item['minutes'], 0, MAX_MINUTES)) return false;
    }
  }
  const allocated = row['disposition'] === 'continue' && row['reason'] === 'allocated' &&
    row['allocation'] !== null && row['score'] !== null && row['rank'] !== null;
  if ((row['allocation'] !== null || row['disposition'] === 'continue') && !allocated) return false;
  if (row['scoreFactors'] !== null && row['score'] !== (row['scoreFactors'] as Record<string, unknown>)['marginalValue']) {
    return false;
  }
  if ((row['reason'] === 'effective') !== (row['effective'] === true) ||
    (!['refuted', 'guardrail-breached'].includes(String(row['reason']))) !==
      (row['effective'] !== false)) {
    return false;
  }
  return true;
}

/** Strictly verifies shape, all-false authority/effects, and content digests. */
export function verifyPortfolioShadowV1(value: unknown): PortfolioShadowV1 | null {
  const snapshot = clone(value);
  const row = record(snapshot);
  if (!row || !exactKeys(row, PORTFOLIO_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== VALUE_PORTFOLIO_PROTOCOL || row['recordType'] !== 'value-portfolio' ||
    row['mode'] !== 'shadow' || row['authority'] !== 'observation-only') return null;
  for (const key of ['planningAuthority', 'executionAuthority', 'proposalAuthority',
    'agentAuthority', 'mergeAuthority', 'releaseAuthority', 'deployAuthority',
    'rollbackAuthority', 'publicationAuthority', 'externalMutationAuthority',
    'budgetAuthority', 'learningAuthority', 'policyEligible']) {
    if (row[key] !== false) return null;
  }
  const basis = record(row['basis']);
  const bounds = record(row['bounds']);
  const resources = record(row['resources']);
  const effects = record(row['effects']);
  if (!basis || !exactKeys(basis, BASIS_KEYS) || !timestamp(basis['asOf']) ||
    !normalizedDigest(basis['specDigest']) || !normalizedDigest(basis['missionDigest']) ||
    !normalizedDigest(basis['resourceEnvelopeDigest']) || !bounds || !exactKeys(bounds, BOUNDS_KEYS) ||
    bounds['scoringPolicy'] !== VALUE_PORTFOLIO_SCORING_POLICY ||
    bounds['maxCandidates'] !== MAX_VALUE_HYPOTHESES || bounds['maxActive'] !== MAX_ACTIVE_VALUE_BETS ||
    bounds['minimumReserveFraction'] !== MIN_PORTFOLIO_RESERVE_FRACTION ||
    bounds['maximumBetFraction'] !== MAX_VALUE_BET_FRACTION || !resources ||
    !exactKeys(resources, RESOURCE_KEYS) || typeof resources['sourceComplete'] !== 'boolean' ||
    !effects || !exactKeys(effects, EFFECT_KEYS) || Object.values(effects).some((entry) => entry !== false) ||
    !Array.isArray(row['decisions']) || row['decisions'].length > MAX_VALUE_HYPOTHESES ||
    row['decisions'].some((entry) => !validDecision(entry))) return null;
  for (const key of RESOURCE_KEYS) {
    if (key === 'sourceComplete') continue;
    const maximum = key.includes('Minutes') ? MAX_MINUTES * 32 : MAX_TOKENS * 32;
    if (!integer(resources[key], 0, maximum)) return null;
  }
  const usableTokens = resources['usableTokens'] as number;
  const usableMinutes = resources['usableMinutes'] as number;
  const reservedTokens = resources['reservedTokens'] as number;
  const reservedMinutes = resources['reservedMinutes'] as number;
  const allocatableTokens = resources['allocatableTokens'] as number;
  const allocatableMinutes = resources['allocatableMinutes'] as number;
  if (reservedTokens + allocatableTokens !== usableTokens ||
    reservedMinutes + allocatableMinutes !== usableMinutes ||
    reservedTokens < Math.ceil(usableTokens * MIN_PORTFOLIO_RESERVE_FRACTION) ||
    reservedMinutes < Math.ceil(usableMinutes * MIN_PORTFOLIO_RESERVE_FRACTION) ||
    reservedTokens > Math.ceil(usableTokens * MAX_PORTFOLIO_RESERVE_FRACTION) ||
    reservedMinutes > Math.ceil(usableMinutes * MAX_PORTFOLIO_RESERVE_FRACTION) ||
    (resources['sourceComplete'] === false && (usableTokens !== 0 || usableMinutes !== 0))) return null;

  const decisions = row['decisions'] as PortfolioDecisionV1[];
  const allocated = decisions.filter((decision) => decision.allocation !== null);
  const ids = decisions.map((decision) => decision.hypothesisId);
  const nodes = decisions.map((decision) => decision.missionNodeKey);
  const ranks = decisions.flatMap((decision) => decision.rank === null ? [] : [decision.rank]);
  const ranked = decisions.filter((decision) => decision.rank !== null)
    .sort((left, right) => left.rank! - right.rank!);
  const allocatedTokens = allocated.reduce((sum, decision) => sum + decision.allocation!.tokens, 0);
  const allocatedMinutes = allocated.reduce((sum, decision) => sum + decision.allocation!.minutes, 0);
  if (ids.some((id, index) => index > 0 && compareText(ids[index - 1]!, id) >= 0) ||
    new Set(ids).size !== ids.length || new Set(nodes).size !== nodes.length ||
    new Set(ranks).size !== ranks.length || allocated.length > MAX_ACTIVE_VALUE_BETS ||
    ranked.some((decision, index) => decision.rank !== index + 1 || decision.score === null ||
      (index > 0 && (ranked[index - 1]!.score! < decision.score! ||
        (ranked[index - 1]!.score === decision.score &&
          compareText(ranked[index - 1]!.hypothesisId, decision.hypothesisId) > 0)))) ||
    allocatedTokens > allocatableTokens || allocatedMinutes > allocatableMinutes ||
    allocated.some((decision) => decision.allocation!.tokens > Math.floor(usableTokens * MAX_VALUE_BET_FRACTION) ||
      decision.allocation!.minutes > Math.floor(usableMinutes * MAX_VALUE_BET_FRACTION) ||
      decision.allocation!.inventory.reduce((sum, item) => sum + item.tokens, 0) !== decision.allocation!.tokens ||
      decision.allocation!.inventory.reduce((sum, item) => sum + item.minutes, 0) !== decision.allocation!.minutes)) {
    return null;
  }
  if (!normalizedDigest(row['basisDigest']) || !normalizedDigest(row['portfolioId']) ||
    !normalizedDigest(row['portfolioDigest'])) return null;
  const expectedBasisDigest = digest(basis, 'ashlr:value-portfolio:basis:v1');
  if (row['basisDigest'] !== expectedBasisDigest) return null;
  const expectedPortfolioId = digest([
    VALUE_PORTFOLIO_SCORING_POLICY, expectedBasisDigest,
    ...[...decisions].sort((left, right) => compareText(left.hypothesisId, right.hypothesisId))
      .map((decision) => decision.hypothesisDigest),
  ], 'ashlr:value-portfolio:id:v1');
  if (row['portfolioId'] !== expectedPortfolioId) return null;
  const cloned = clone(row) as Record<string, unknown> | null;
  if (!cloned) return null;
  const portfolioDigest = cloned['portfolioDigest'];
  delete cloned['portfolioDigest'];
  return portfolioDigest === digest(cloned, 'ashlr:value-portfolio:v1')
    ? clone(row) as unknown as PortfolioShadowV1
    : null;
}
