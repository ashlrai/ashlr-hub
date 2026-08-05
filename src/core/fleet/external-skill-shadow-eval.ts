import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/;
const POLICY_VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MIN_RANDOMIZATION_KEY_BYTES = 32;
const MIN_COMPLETE_PAIRS = 8;
const MAX_TRIAL_PAIRS = 128;
const MAX_TRIAL_RECEIPTS = MAX_TRIAL_PAIRS * 4;
const PROTOCOL = 'external-skill-shadow-v1' as const;
const ZERO_DIGEST = '0'.repeat(64);
const RECEIPT_KEYS = [
  'arm',
  'assignmentDigest',
  'attestation',
  'campaignDigest',
  'evidenceDigest',
  'executionEnvelopeDigest',
  'exposure',
  'exposureReceiptDigest',
  'outcome',
  'pairId',
  'protocol',
  'resultDigest',
  'schemaVersion',
  'skillContentHash',
  'verifierContractDigest',
] as const;
const PLAN_KEYS = [
  'assignments',
  'attestation',
  'authority',
  'campaignDigest',
  'minimumCompletePairs',
  'packDigest',
  'policyEligible',
  'policyVersion',
  'promotionEligible',
  'protocol',
  'randomizationCommitment',
  'schemaVersion',
] as const;
const PAIR_KEYS = [
  'caseDigest',
  'executionEnvelopeDigest',
  'fixtureDigest',
  'pairId',
  'runs',
  'skillContentHash',
  'verifierContractDigest',
] as const;
const RUN_KEYS = ['arm', 'assignmentDigest', 'orderPropensity', 'ordinal'] as const;
const EVALUATION_INPUT_KEYS = [
  'attestationKey',
  'campaignClosed',
  'plan',
  'receipts',
  'sourceComplete',
] as const;

export type ExternalSkillTrialArm = 'skill' | 'no-skill';

export interface ExternalSkillTrialCaseInput {
  skillContentHash: string;
  caseDigest: string;
  fixtureDigest: string;
  verifierContractDigest: string;
  executionEnvelopeDigest: string;
}

export interface ExternalSkillTrialPlanInput {
  packDigest: string;
  policyVersion: string;
  randomizationKey: Uint8Array;
  attestationKey: Uint8Array;
  cases: ExternalSkillTrialCaseInput[];
}

export interface ExternalSkillTrialRunAssignment {
  arm: ExternalSkillTrialArm;
  ordinal: 1 | 2;
  assignmentDigest: string;
  orderPropensity: 0.5;
}

export interface ExternalSkillTrialPairAssignment {
  pairId: string;
  skillContentHash: string;
  caseDigest: string;
  fixtureDigest: string;
  verifierContractDigest: string;
  executionEnvelopeDigest: string;
  runs: [ExternalSkillTrialRunAssignment, ExternalSkillTrialRunAssignment];
}

export interface ExternalSkillTrialPlan {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authority: 'observation-only';
  policyEligible: false;
  promotionEligible: false;
  campaignDigest: string;
  packDigest: string;
  policyVersion: string;
  randomizationCommitment: string;
  minimumCompletePairs: typeof MIN_COMPLETE_PAIRS;
  assignments: ExternalSkillTrialPairAssignment[];
  attestation: string;
}

export interface ExternalSkillTrialOutcomeReceipt {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  campaignDigest: string;
  pairId: string;
  assignmentDigest: string;
  arm: ExternalSkillTrialArm;
  exposure: 'skill-mounted' | 'no-skill-confirmed';
  skillContentHash: string | null;
  exposureReceiptDigest: string;
  verifierContractDigest: string;
  executionEnvelopeDigest: string;
  resultDigest: string;
  evidenceDigest: string;
  outcome: 'passed' | 'failed';
  attestation: string;
}

export interface ExternalSkillTrialOutcomeInput {
  pairId: string;
  arm: ExternalSkillTrialArm;
  exposure: 'skill-mounted' | 'no-skill-confirmed';
  skillContentHash: string | null;
  exposureReceiptDigest: string;
  resultDigest: string;
  evidenceDigest: string;
  outcome: 'passed' | 'failed';
}

export type ExternalSkillTrialEvaluationBlocker =
  | 'invalid-plan'
  | 'invalid-evaluation-input'
  | 'source-incomplete'
  | 'campaign-open'
  | 'incomplete-pairs'
  | 'closed-with-attrition'
  | 'sample-below-minimum'
  | 'invalid-receipts'
  | 'replayed-receipts'
  | 'conflicting-receipts';

export interface ExternalSkillTrialArmProgress {
  arm: ExternalSkillTrialArm;
  assignedRuns: number;
  verifiedRuns: number;
  passes: number | null;
  failures: number | null;
  passRate: number | null;
  marginalConfidence95: { lower: number; upper: number } | null;
}

export interface ExternalSkillTrialEffect {
  completePairs: number;
  skillPassRate: number;
  noSkillPassRate: number;
  absoluteLift: number;
  skillOnlyWins: number;
  noSkillOnlyWins: number;
  ties: number;
  inference: 'descriptive-randomized-paired';
}

export interface ExternalSkillTrialEvaluation {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authority: 'observation-only';
  policyEligible: false;
  promotionEligible: false;
  campaignDigest: string;
  sourceState: 'healthy' | 'degraded';
  gate: 'collecting' | 'ready' | 'withheld';
  minimumCompletePairs: typeof MIN_COMPLETE_PAIRS;
  assignedPairs: number;
  completePairs: number;
  replayedReceipts: number;
  conflictingReceipts: number;
  invalidReceipts: number;
  arms: ExternalSkillTrialArmProgress[];
  effect: ExternalSkillTrialEffect | null;
  blockers: ExternalSkillTrialEvaluationBlocker[];
}

export interface ExternalSkillTrialEvaluationInput {
  plan: ExternalSkillTrialPlan;
  receipts: ExternalSkillTrialOutcomeReceipt[];
  attestationKey: Uint8Array;
  sourceComplete: boolean;
  campaignClosed: boolean;
}

function hashTuple(domain: string, values: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify([domain, ...values]), 'utf8').digest('hex');
}

function asciiCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function hmacTuple(key: Uint8Array, domain: string, values: readonly unknown[]): Buffer {
  return createHmac('sha256', key).update(JSON.stringify([domain, ...values]), 'utf8').digest();
}

function assertKey(key: Uint8Array, field: string): void {
  if (!(key instanceof Uint8Array) || key.byteLength < MIN_RANDOMIZATION_KEY_BYTES) {
    throw new TypeError(`${field} must contain at least 32 bytes`);
  }
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function assertDigest(value: string, field: string): void {
  if (!SHA256_RE.test(value)) throw new TypeError(`invalid ${field}`);
}

function assertCase(input: ExternalSkillTrialCaseInput): void {
  assertDigest(input.skillContentHash, 'skillContentHash');
  assertDigest(input.caseDigest, 'caseDigest');
  assertDigest(input.fixtureDigest, 'fixtureDigest');
  assertDigest(input.verifierContractDigest, 'verifierContractDigest');
  assertDigest(input.executionEnvelopeDigest, 'executionEnvelopeDigest');
}

function assignmentDigest(
  campaignDigest: string,
  pairId: string,
  arm: ExternalSkillTrialArm,
  ordinal: 1 | 2,
): string {
  return hashTuple('ashlr:external-skill-trial-assignment:v1', [
    campaignDigest,
    pairId,
    arm,
    ordinal,
    0.5,
  ]);
}

function campaignDigestFor(
  packDigest: string,
  policyVersion: string,
  randomizationCommitment: string,
  identities: readonly Pick<ExternalSkillTrialPairAssignment,
    | 'pairId'
    | 'skillContentHash'
    | 'caseDigest'
    | 'fixtureDigest'
    | 'verifierContractDigest'
    | 'executionEnvelopeDigest'>[],
): string {
  return hashTuple('ashlr:external-skill-trial-campaign:v1', [
    PROTOCOL,
    packDigest,
    policyVersion,
    randomizationCommitment,
    identities.map((entry) => [
      entry.pairId,
      entry.skillContentHash,
      entry.caseDigest,
      entry.fixtureDigest,
      entry.verifierContractDigest,
      entry.executionEnvelopeDigest,
    ]),
  ]);
}

function planAttestation(plan: Omit<ExternalSkillTrialPlan, 'attestation'>, key: Uint8Array): string {
  return hmacTuple(key, 'ashlr:external-skill-trial-plan-attestation:v1', [
    plan.schemaVersion,
    plan.protocol,
    plan.authority,
    plan.policyEligible,
    plan.promotionEligible,
    plan.campaignDigest,
    plan.packDigest,
    plan.policyVersion,
    plan.randomizationCommitment,
    plan.minimumCompletePairs,
    plan.assignments.map((pair) => [
      pair.pairId,
      pair.skillContentHash,
      pair.caseDigest,
      pair.fixtureDigest,
      pair.verifierContractDigest,
      pair.executionEnvelopeDigest,
      pair.runs.map((run) => [
        run.arm,
        run.ordinal,
        run.assignmentDigest,
        run.orderPropensity,
      ]),
    ]),
  ]).toString('hex');
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => !Object.hasOwn(descriptor, 'value'),
  )) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isDensePlainArray(value: unknown, minimum: number, maximum: number): value is unknown[] {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum
    || value.length > maximum
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function validPlan(plan: ExternalSkillTrialPlan, key: Uint8Array): boolean {
  try {
    assertKey(key, 'attestationKey');
    if (typeof plan !== 'object' || plan === null || Array.isArray(plan) || !hasExactKeys(plan, PLAN_KEYS)) {
      return false;
    }
    if (plan.schemaVersion !== 1
      || plan.protocol !== PROTOCOL
      || plan.authority !== 'observation-only'
      || plan.policyEligible !== false
      || plan.promotionEligible !== false
      || plan.minimumCompletePairs !== MIN_COMPLETE_PAIRS
      || !SHA256_RE.test(plan.packDigest)
      || !SHA256_RE.test(plan.campaignDigest)
      || !SHA256_RE.test(plan.randomizationCommitment)
      || !SHA256_RE.test(plan.attestation)
      || !POLICY_VERSION_RE.test(plan.policyVersion)
      || !isDensePlainArray(plan.assignments, MIN_COMPLETE_PAIRS, MAX_TRIAL_PAIRS)) return false;

    const pairIds = new Set<string>();
    const caseDigests = new Set<string>();
    const skillHashes = new Set<string>();
    let priorPairId = '';
    for (const pair of plan.assignments) {
      if (typeof pair !== 'object' || pair === null || Array.isArray(pair) || !hasExactKeys(pair, PAIR_KEYS)) {
        return false;
      }
      for (const digest of [
        pair.pairId,
        pair.skillContentHash,
        pair.caseDigest,
        pair.fixtureDigest,
        pair.verifierContractDigest,
        pair.executionEnvelopeDigest,
      ]) if (!SHA256_RE.test(digest)) return false;
      const wantedPairId = hashTuple('ashlr:external-skill-trial-pair:v1', [
        plan.packDigest,
        pair.skillContentHash,
        pair.caseDigest,
        pair.fixtureDigest,
        pair.verifierContractDigest,
        pair.executionEnvelopeDigest,
      ]);
      if (!safeDigestEqual(pair.pairId, wantedPairId)
        || pairIds.has(pair.pairId)
        || caseDigests.has(pair.caseDigest)
        || (priorPairId !== '' && asciiCompare(priorPairId, pair.pairId) >= 0)
        || !isDensePlainArray(pair.runs, 2, 2)) return false;
      pairIds.add(pair.pairId);
      caseDigests.add(pair.caseDigest);
      skillHashes.add(pair.skillContentHash);
      priorPairId = pair.pairId;
      const arms = new Set<ExternalSkillTrialArm>();
      for (let index = 0; index < pair.runs.length; index += 1) {
        const run = pair.runs[index]!;
        if (typeof run !== 'object' || run === null || Array.isArray(run) || !hasExactKeys(run, RUN_KEYS)) {
          return false;
        }
        const ordinal = (index + 1) as 1 | 2;
        if ((run.arm !== 'skill' && run.arm !== 'no-skill')
          || arms.has(run.arm)
          || run.ordinal !== ordinal
          || run.orderPropensity !== 0.5
          || !safeDigestEqual(
            run.assignmentDigest,
            assignmentDigest(plan.campaignDigest, pair.pairId, run.arm, ordinal),
          )) return false;
        arms.add(run.arm);
      }
    }
    if (skillHashes.size !== 1) return false;
    const wantedCampaign = campaignDigestFor(
      plan.packDigest,
      plan.policyVersion,
      plan.randomizationCommitment,
      plan.assignments,
    );
    if (!safeDigestEqual(plan.campaignDigest, wantedCampaign)) return false;
    const { attestation, ...unsigned } = plan;
    return safeDigestEqual(attestation, planAttestation(unsigned, key));
  } catch {
    return false;
  }
}

/**
 * Freeze metadata-only paired assignments before any execution begins.
 * The randomization key is committed but never included in the returned plan.
 */
export function buildExternalSkillTrialPlan(input: ExternalSkillTrialPlanInput): ExternalSkillTrialPlan {
  assertDigest(input.packDigest, 'packDigest');
  if (!POLICY_VERSION_RE.test(input.policyVersion)) throw new TypeError('invalid policyVersion');
  assertKey(input.randomizationKey, 'randomizationKey');
  assertKey(input.attestationKey, 'attestationKey');
  if (input.randomizationKey.byteLength === input.attestationKey.byteLength
    && timingSafeEqual(Buffer.from(input.randomizationKey), Buffer.from(input.attestationKey))) {
    throw new TypeError('randomizationKey and attestationKey must be distinct');
  }
  if (input.cases.length < MIN_COMPLETE_PAIRS || input.cases.length > MAX_TRIAL_PAIRS) {
    throw new RangeError(`cases must contain ${MIN_COMPLETE_PAIRS}-${MAX_TRIAL_PAIRS} entries`);
  }

  const identities = input.cases.map((entry) => {
    assertCase(entry);
    const pairId = hashTuple('ashlr:external-skill-trial-pair:v1', [
      input.packDigest,
      entry.skillContentHash,
      entry.caseDigest,
      entry.fixtureDigest,
      entry.verifierContractDigest,
      entry.executionEnvelopeDigest,
    ]);
    return {
      pairId,
      skillContentHash: entry.skillContentHash,
      caseDigest: entry.caseDigest,
      fixtureDigest: entry.fixtureDigest,
      verifierContractDigest: entry.verifierContractDigest,
      executionEnvelopeDigest: entry.executionEnvelopeDigest,
    };
  }).sort((left, right) => asciiCompare(left.pairId, right.pairId));
  if (new Set(identities.map((entry) => entry.pairId)).size !== identities.length) {
    throw new TypeError('duplicate trial pair');
  }
  if (new Set(identities.map((entry) => entry.caseDigest)).size !== identities.length) {
    throw new TypeError('duplicate logical trial case');
  }
  if (new Set(identities.map((entry) => entry.skillContentHash)).size !== 1) {
    throw new TypeError('trial campaign must contain exactly one skill');
  }

  const randomizationCommitment = hashTuple('ashlr:external-skill-trial-randomization:v1', [
    Buffer.from(input.randomizationKey).toString('hex'),
  ]);
  const campaignDigest = campaignDigestFor(
    input.packDigest,
    input.policyVersion,
    randomizationCommitment,
    identities,
  );
  const assignments = identities.map((entry): ExternalSkillTrialPairAssignment => {
    const skillFirst = (hmacTuple(
      input.randomizationKey,
      'ashlr:external-skill-trial-arm-order:v1',
      [campaignDigest, entry.pairId],
    )[0]! & 1) === 0;
    const orderedArms: [ExternalSkillTrialArm, ExternalSkillTrialArm] = skillFirst
      ? ['skill', 'no-skill']
      : ['no-skill', 'skill'];
    const runs = orderedArms.map((arm, index): ExternalSkillTrialRunAssignment => {
      const ordinal = (index + 1) as 1 | 2;
      return {
        arm,
        ordinal,
        assignmentDigest: assignmentDigest(campaignDigest, entry.pairId, arm, ordinal),
        orderPropensity: 0.5,
      };
    }) as [ExternalSkillTrialRunAssignment, ExternalSkillTrialRunAssignment];
    return { ...entry, runs };
  });

  const unsigned: Omit<ExternalSkillTrialPlan, 'attestation'> = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    policyEligible: false,
    promotionEligible: false,
    campaignDigest,
    packDigest: input.packDigest,
    policyVersion: input.policyVersion,
    randomizationCommitment,
    minimumCompletePairs: MIN_COMPLETE_PAIRS,
    assignments,
  };
  return { ...unsigned, attestation: planAttestation(unsigned, input.attestationKey) };
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function invalidEvaluation(
  blocker: 'invalid-plan' | 'invalid-evaluation-input',
  campaignDigest = ZERO_DIGEST,
  invalidReceipts = 0,
): ExternalSkillTrialEvaluation {
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    policyEligible: false,
    promotionEligible: false,
    campaignDigest: SHA256_RE.test(campaignDigest) ? campaignDigest : ZERO_DIGEST,
    sourceState: 'degraded',
    gate: 'withheld',
    minimumCompletePairs: MIN_COMPLETE_PAIRS,
    assignedPairs: 0,
    completePairs: 0,
    replayedReceipts: 0,
    conflictingReceipts: 0,
    invalidReceipts,
    arms: (['skill', 'no-skill'] as const).map((arm) => ({
      arm,
      assignedRuns: 0,
      verifiedRuns: 0,
      passes: null,
      failures: null,
      passRate: null,
      marginalConfidence95: null,
    })),
    effect: null,
    blockers: [blocker],
  };
}

function wilson95(successes: number, total: number): { lower: number; upper: number } {
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { lower: rounded(Math.max(0, center - margin)), upper: rounded(Math.min(1, center + margin)) };
}

function receiptFingerprint(receipt: ExternalSkillTrialOutcomeReceipt): string {
  return receipt.attestation;
}

function receiptAttestation(
  receipt: Omit<ExternalSkillTrialOutcomeReceipt, 'attestation'>,
  key: Uint8Array,
): string {
  return hmacTuple(key, 'ashlr:external-skill-trial-outcome-attestation:v1', [
    receipt.schemaVersion,
    receipt.protocol,
    receipt.campaignDigest,
    receipt.pairId,
    receipt.assignmentDigest,
    receipt.arm,
    receipt.exposure,
    receipt.skillContentHash,
    receipt.exposureReceiptDigest,
    receipt.verifierContractDigest,
    receipt.executionEnvelopeDigest,
    receipt.resultDigest,
    receipt.evidenceDigest,
    receipt.outcome,
  ]).toString('hex');
}

/** Host-side attestation after an authorized runner verifies exposure and evidence. */
export function attestExternalSkillTrialOutcome(
  plan: ExternalSkillTrialPlan,
  input: ExternalSkillTrialOutcomeInput,
  attestationKey: Uint8Array,
): ExternalSkillTrialOutcomeReceipt {
  if (!validPlan(plan, attestationKey)) throw new TypeError('invalid trial plan');
  const pair = plan.assignments.find((entry) => entry.pairId === input.pairId);
  const run = pair?.runs.find((entry) => entry.arm === input.arm);
  if (!pair || !run) throw new TypeError('unknown trial assignment');
  assertDigest(input.exposureReceiptDigest, 'exposureReceiptDigest');
  assertDigest(input.resultDigest, 'resultDigest');
  assertDigest(input.evidenceDigest, 'evidenceDigest');
  if (input.outcome !== 'passed' && input.outcome !== 'failed') throw new TypeError('invalid outcome');
  const exposureValid = input.arm === 'skill'
    ? input.exposure === 'skill-mounted' && input.skillContentHash === pair.skillContentHash
    : input.exposure === 'no-skill-confirmed' && input.skillContentHash === null;
  if (!exposureValid) throw new TypeError('invalid trial exposure');
  const unsigned: Omit<ExternalSkillTrialOutcomeReceipt, 'attestation'> = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    campaignDigest: plan.campaignDigest,
    pairId: pair.pairId,
    assignmentDigest: run.assignmentDigest,
    arm: input.arm,
    exposure: input.exposure,
    skillContentHash: input.skillContentHash,
    exposureReceiptDigest: input.exposureReceiptDigest,
    verifierContractDigest: pair.verifierContractDigest,
    executionEnvelopeDigest: pair.executionEnvelopeDigest,
    resultDigest: input.resultDigest,
    evidenceDigest: input.evidenceDigest,
    outcome: input.outcome,
  };
  return { ...unsigned, attestation: receiptAttestation(unsigned, attestationKey) };
}

function validReceiptShape(receipt: ExternalSkillTrialOutcomeReceipt): boolean {
  try {
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return false;
    if (!hasExactKeys(receipt, RECEIPT_KEYS)) return false;
    return receipt.schemaVersion === 1
      && receipt.protocol === PROTOCOL
      && SHA256_RE.test(receipt.campaignDigest)
      && SHA256_RE.test(receipt.pairId)
      && SHA256_RE.test(receipt.assignmentDigest)
      && (receipt.arm === 'skill' || receipt.arm === 'no-skill')
      && (receipt.exposure === 'skill-mounted' || receipt.exposure === 'no-skill-confirmed')
      && (receipt.skillContentHash === null || SHA256_RE.test(receipt.skillContentHash))
      && SHA256_RE.test(receipt.exposureReceiptDigest)
      && SHA256_RE.test(receipt.verifierContractDigest)
      && SHA256_RE.test(receipt.executionEnvelopeDigest)
      && SHA256_RE.test(receipt.resultDigest)
      && SHA256_RE.test(receipt.evidenceDigest)
      && (receipt.outcome === 'passed' || receipt.outcome === 'failed')
      && SHA256_RE.test(receipt.attestation);
  } catch {
    return false;
  }
}

/**
 * Evaluate only complete, actually exposed, deterministically verified pairs.
 * Any identity ambiguity withholds the entire effect instead of dropping rows.
 */
export function evaluateExternalSkillTrial(
  input: ExternalSkillTrialEvaluationInput,
): ExternalSkillTrialEvaluation {
  let snapshot: ExternalSkillTrialEvaluationInput;
  try {
    snapshot = structuredClone(input);
    if (typeof snapshot !== 'object'
      || snapshot === null
      || Array.isArray(snapshot)
      || !hasExactKeys(snapshot, EVALUATION_INPUT_KEYS)
      || typeof snapshot.sourceComplete !== 'boolean'
      || typeof snapshot.campaignClosed !== 'boolean'
      || !isDensePlainArray(snapshot.receipts, 0, MAX_TRIAL_RECEIPTS)) {
      return invalidEvaluation('invalid-evaluation-input');
    }
    assertKey(snapshot.attestationKey, 'attestationKey');
  } catch {
    return invalidEvaluation('invalid-evaluation-input');
  }
  if (!validPlan(snapshot.plan, snapshot.attestationKey)) {
    return invalidEvaluation(
      'invalid-plan',
      typeof snapshot.plan?.campaignDigest === 'string' ? snapshot.plan.campaignDigest : ZERO_DIGEST,
      snapshot.receipts.length,
    );
  }
  const expected = new Map<string, {
    pair: ExternalSkillTrialPairAssignment;
    run: ExternalSkillTrialRunAssignment;
  }>();
  for (const pair of snapshot.plan.assignments) {
    for (const run of pair.runs) expected.set(`${pair.pairId}:${run.arm}`, { pair, run });
  }

  const accepted = new Map<string, ExternalSkillTrialOutcomeReceipt>();
  let invalidReceipts = 0;
  let replayedReceipts = 0;
  let conflictingReceipts = 0;
  for (const receipt of snapshot.receipts) {
    const key = `${receipt?.pairId}:${receipt?.arm}`;
    const wanted = expected.get(key);
    const structurallyValid = validReceiptShape(receipt);
    const exposureValid = receipt?.arm === 'skill'
      ? receipt.exposure === 'skill-mounted'
        && receipt.skillContentHash === wanted?.pair.skillContentHash
      : receipt?.exposure === 'no-skill-confirmed' && receipt.skillContentHash === null;
    const identityValid = wanted !== undefined
      && receipt.campaignDigest === snapshot.plan.campaignDigest
      && receipt.assignmentDigest === wanted.run.assignmentDigest
      && receipt.verifierContractDigest === wanted.pair.verifierContractDigest
      && receipt.executionEnvelopeDigest === wanted.pair.executionEnvelopeDigest;
    const attestationValid = structurallyValid && (() => {
      const { attestation, ...unsigned } = receipt;
      return safeDigestEqual(
        attestation,
        receiptAttestation(unsigned, snapshot.attestationKey),
      );
    })();
    if (!structurallyValid
      || !identityValid
      || !exposureValid
      || !attestationValid) {
      invalidReceipts += 1;
      continue;
    }
    const prior = accepted.get(key);
    if (prior) {
      if (receiptFingerprint(prior) === receiptFingerprint(receipt)) replayedReceipts += 1;
      else conflictingReceipts += 1;
      continue;
    }
    accepted.set(key, receipt);
  }

  const exposureDigests = new Map<string, string>();
  const evidenceDigests = new Map<string, string>();
  const resultDigests = new Map<string, { key: string; outcome: 'passed' | 'failed' }>();
  for (const [key, receipt] of accepted) {
    for (const [digest, seen] of [
      [receipt.exposureReceiptDigest, exposureDigests],
      [receipt.evidenceDigest, evidenceDigests],
    ] as const) {
      const priorKey = seen.get(digest);
      if (priorKey !== undefined && priorKey !== key) invalidReceipts += 1;
      else seen.set(digest, key);
    }
    const priorResult = resultDigests.get(receipt.resultDigest);
    if (priorResult !== undefined && priorResult.key !== key && priorResult.outcome !== receipt.outcome) {
      invalidReceipts += 1;
    } else if (priorResult === undefined) {
      resultDigests.set(receipt.resultDigest, { key, outcome: receipt.outcome });
    }
  }
  for (const pair of snapshot.plan.assignments) {
    const skill = accepted.get(`${pair.pairId}:skill`);
    const noSkill = accepted.get(`${pair.pairId}:no-skill`);
    if (!skill || !noSkill) continue;
    if (skill.exposureReceiptDigest === noSkill.exposureReceiptDigest
      || (skill.resultDigest === noSkill.resultDigest && skill.outcome !== noSkill.outcome)
      || (skill.evidenceDigest === noSkill.evidenceDigest && skill.outcome !== noSkill.outcome)) {
      invalidReceipts += 1;
    }
  }

  const complete = snapshot.plan.assignments.flatMap((pair) => {
    const skill = accepted.get(`${pair.pairId}:skill`);
    const noSkill = accepted.get(`${pair.pairId}:no-skill`);
    return skill && noSkill ? [{ skill, noSkill }] : [];
  });
  const completePairs = complete.length;
  const blockers: ExternalSkillTrialEvaluationBlocker[] = [];
  if (snapshot.sourceComplete !== true) blockers.push('source-incomplete');
  if (invalidReceipts > 0) blockers.push('invalid-receipts');
  if (replayedReceipts > 0) blockers.push('replayed-receipts');
  if (conflictingReceipts > 0) blockers.push('conflicting-receipts');
  if (completePairs < snapshot.plan.assignments.length) {
    blockers.push('incomplete-pairs');
    blockers.push(snapshot.campaignClosed ? 'closed-with-attrition' : 'campaign-open');
  } else if (completePairs < MIN_COMPLETE_PAIRS) {
    blockers.push('sample-below-minimum');
  }
  const integrityWithheld = blockers.some((blocker) => blocker !== 'campaign-open' && blocker !== 'incomplete-pairs');
  const gate: ExternalSkillTrialEvaluation['gate'] = integrityWithheld
    ? 'withheld'
    : blockers.length > 0
      ? 'collecting'
      : 'ready';

  const progress = (arm: ExternalSkillTrialArm): ExternalSkillTrialArmProgress => {
    const rows = [...accepted.values()].filter((receipt) => receipt.arm === arm);
    const exposeOutcomes = gate === 'ready';
    const passes = rows.filter((receipt) => receipt.outcome === 'passed').length;
    return {
      arm,
      assignedRuns: snapshot.plan.assignments.length,
      verifiedRuns: rows.length,
      passes: exposeOutcomes ? passes : null,
      failures: exposeOutcomes ? rows.length - passes : null,
      passRate: exposeOutcomes ? rounded(passes / rows.length) : null,
      marginalConfidence95: exposeOutcomes ? wilson95(passes, rows.length) : null,
    };
  };
  const arms = (['skill', 'no-skill'] as const).map(progress);
  let effect: ExternalSkillTrialEffect | null = null;
  if (gate === 'ready') {
    const skillPasses = complete.filter(({ skill }) => skill.outcome === 'passed').length;
    const noSkillPasses = complete.filter(({ noSkill }) => noSkill.outcome === 'passed').length;
    const skillOnlyWins = complete.filter(({ skill, noSkill }) => (
      skill.outcome === 'passed' && noSkill.outcome === 'failed'
    )).length;
    const noSkillOnlyWins = complete.filter(({ skill, noSkill }) => (
      skill.outcome === 'failed' && noSkill.outcome === 'passed'
    )).length;
    effect = {
      completePairs,
      skillPassRate: rounded(skillPasses / completePairs),
      noSkillPassRate: rounded(noSkillPasses / completePairs),
      absoluteLift: rounded((skillPasses - noSkillPasses) / completePairs),
      skillOnlyWins,
      noSkillOnlyWins,
      ties: completePairs - skillOnlyWins - noSkillOnlyWins,
      inference: 'descriptive-randomized-paired',
    };
  }

  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    policyEligible: false,
    promotionEligible: false,
    campaignDigest: snapshot.plan.campaignDigest,
    sourceState: snapshot.sourceComplete === true ? 'healthy' : 'degraded',
    gate,
    minimumCompletePairs: MIN_COMPLETE_PAIRS,
    assignedPairs: snapshot.plan.assignments.length,
    completePairs,
    replayedReceipts,
    conflictingReceipts,
    invalidReceipts,
    arms,
    effect,
    blockers,
  };
}
