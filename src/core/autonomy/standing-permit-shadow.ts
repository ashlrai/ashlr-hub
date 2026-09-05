/**
 * Standing Permit Shadow V1.
 *
 * A pure, inert policy contract for evaluating whether a narrowly scoped
 * standing permit could be eligible. It cannot mint a grant, authorize an
 * execution, inspect credentials, or perform I/O. Authenticated append-only
 * evidence is verified upstream; this layer binds that verification to an
 * exact signer, chain head, scope, posture, and budget before reporting
 * eligibility. Chain canaries validate only the supplied chain: historical
 * replay/rollback detection depends on a separately current minimumSequence
 * and head digest. This module has no historical or operational authority.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const STANDING_PERMIT_SHADOW_PROTOCOL = 'ashlr.standing-permit-shadow.v1' as const;
export const STANDING_PERMIT_EVIDENCE_PROTOCOL = 'ashlr.standing-permit-evidence.v1' as const;
export const STANDING_PERMIT_MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
export const STANDING_PERMIT_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;

const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_EVIDENCE_RECEIPTS = 128;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export type StandingPermitCapabilityV1 =
  | 'workspace-edit'
  | 'model-dispatch'
  | 'source-commit'
  | 'change-proposal'
  | 'source-push'
  | 'host-merge'
  | 'release-promotion'
  | 'production-deploy'
  | 'external-send'
  | 'data-destruction';

export type StandingPermitEffectClassV1 =
  | 'workspace-write'
  | 'provider-call'
  | 'git-commit'
  | 'pull-request'
  | 'git-push'
  | 'merge'
  | 'release'
  | 'deploy'
  | 'external-communication'
  | 'destructive';

export type StandingPermitBlastRadiusV1 =
  | 'sandbox'
  | 'repository'
  | 'ecosystem'
  | 'external'
  | 'production';

export type StandingPermitReversibilityV1 = 'proven' | 'best-effort' | 'irreversible';
export type StandingPermitBudgetUnitV1 = 'tokens' | 'requests' | 'usd-micros' | 'compute-seconds';

export interface StandingPermitBindingsV1 {
  principalDigest: string;
  workloadDigest: string;
  repositoryDigest: string;
  missionDigest: string;
  specDigest: string;
  toolDigest: string;
  environmentDigest: string;
  budgetDigest: string;
  timeWindowDigest: string;
  acceptanceDigest: string;
  rollbackDigest: string;
  revocationPolicyDigest: string;
}

export interface StandingPermitWindowV1 {
  validFrom: string;
  expiresAt: string;
}

export interface StandingPermitBudgetV1 {
  unit: StandingPermitBudgetUnitV1;
  maximumUnits: number;
}

export interface StandingPermitContractInputV1 {
  schemaVersion: 1;
  permitId: string;
  capability: StandingPermitCapabilityV1;
  effectClass: StandingPermitEffectClassV1;
  blastRadius: StandingPermitBlastRadiusV1;
  reversibility: StandingPermitReversibilityV1;
  bindings: StandingPermitBindingsV1;
  window: StandingPermitWindowV1;
  budget: StandingPermitBudgetV1;
  trustedSignerKeyId: string;
  requestedAt: string;
}

export interface StandingPermitContractV1 extends StandingPermitContractInputV1 {
  protocol: typeof STANDING_PERMIT_SHADOW_PROTOCOL;
  mode: 'shadow';
  authority: 'observation-only';
  selfActivating: false;
  policyEligible: false;
  grantAuthority: false;
  executionAuthority: false;
  permitDigest: string;
}

export interface StandingPermitEvidenceReceiptV1 {
  schemaVersion: 1;
  protocol: typeof STANDING_PERMIT_EVIDENCE_PROTOCOL;
  sequence: number;
  previousReceiptDigest: string | null;
  permitDigest: string;
  missionDigest: string;
  specDigest: string;
  killEpochDigest: string;
  revocationEpochDigest: string;
  budgetConsumedUnits: number;
  killSwitchOn: boolean;
  revoked: boolean;
  recordedAt: string;
  signerKeyId: string;
  /** Untrusted format claim; only the injected verifier establishes authenticity. */
  authenticationClaim: 'ed25519-v1';
  appendOnly: true;
  sourceState: 'healthy';
  receiptDigest: string;
}

export interface StandingPermitCurrentPostureV1 {
  killSwitchOn: boolean;
  revoked: boolean;
  killEpochDigest: string;
  revocationEpochDigest: string;
  observedAt: string;
  evidenceHeadDigest: string;
}

export interface StandingPermitEvaluationInputV1 {
  schemaVersion: 1;
  evaluatedAt: string;
  permit: StandingPermitContractV1;
  currentBindings: StandingPermitBindingsV1;
  request: {
    capability: StandingPermitCapabilityV1;
    effectClass: StandingPermitEffectClassV1;
    requestedBudgetUnits: number;
  };
  evidence: {
    sourceComplete: boolean;
    /** Sequence of the first supplied receipt; may be greater than one. */
    baseSequence: number;
    /** Authenticated predecessor outside this bounded suffix, or null at genesis. */
    basePreviousReceiptDigest: string | null;
    receipts: StandingPermitEvidenceReceiptV1[];
  };
  currentPosture: StandingPermitCurrentPostureV1;
}

/**
 * Independently current evidence anchor. It is never trusted by shape or
 * marker alone: the injected verifier capability must authenticate it.
 */
export interface StandingPermitCurrentEvidenceAnchorV1 {
  schemaVersion: 1;
  permitDigest: string;
  baseSequence: number;
  basePreviousReceiptDigest: string | null;
  headReceiptDigest: string;
  headSequence: number;
  minimumSequence: number;
  observedAt: string;
}

export interface StandingPermitEvidenceVerifierV1 {
  verifyReceipt(receipt: Readonly<StandingPermitEvidenceReceiptV1>): boolean;
  verifyCurrentAnchor(anchor: Readonly<StandingPermitCurrentEvidenceAnchorV1>): boolean;
}

export interface StandingPermitEvaluationDependenciesV1 {
  verifier: StandingPermitEvidenceVerifierV1 | null;
  currentAnchor: StandingPermitCurrentEvidenceAnchorV1 | null;
}

export type StandingPermitCanaryNameV1 =
  | 'scope'
  | 'expiry'
  | 'replay'
  | 'fork-rollback'
  | 'budget'
  | 'mission-spec'
  | 'evidence-health'
  | 'reversibility-blast-radius'
  | 'signer'
  | 'bound-contract';

export interface StandingPermitCanaryResultV1 {
  name: StandingPermitCanaryNameV1;
  passed: boolean;
  reason: string | null;
}

export interface StandingPermitEvaluationV1 {
  schemaVersion: 1;
  protocol: typeof STANDING_PERMIT_SHADOW_PROTOCOL;
  mode: 'shadow';
  authority: 'observation-only';
  permitDigest: string | null;
  evaluatedAt: string;
  eligibility: {
    criteriaSatisfied: boolean;
    blockers: string[];
    eligibilityDigest: string;
  };
  grant: {
    requested: false;
    granted: false;
    grantDigest: null;
  };
  execution: {
    requested: false;
    authorized: false;
    performed: false;
    executionReceiptDigest: null;
  };
  canaries: StandingPermitCanaryResultV1[];
  authorityBits: {
    policy: false;
    grant: false;
    execution: false;
    merge: false;
    release: false;
    deploy: false;
    rollback: false;
    externalMutation: false;
    budget: false;
  };
  effects: {
    files: false;
    models: false;
    providers: false;
    commits: false;
    pushes: false;
    proposals: false;
    merges: false;
    releases: false;
    deployments: false;
    rollbacks: false;
    externalCommunications: false;
    destructiveMutations: false;
    budgets: false;
  };
  evaluationDigest: string;
}

export type StandingPermitContractBuildResultV1 =
  | { ok: true; permit: StandingPermitContractV1; issues: [] }
  | { ok: false; permit: null; issues: string[] };

const CAPABILITY_EFFECT = new Map<StandingPermitCapabilityV1, StandingPermitEffectClassV1>([
  ['workspace-edit', 'workspace-write'],
  ['model-dispatch', 'provider-call'],
  ['source-commit', 'git-commit'],
  ['change-proposal', 'pull-request'],
  ['source-push', 'git-push'],
  ['host-merge', 'merge'],
  ['release-promotion', 'release'],
  ['production-deploy', 'deploy'],
  ['external-send', 'external-communication'],
  ['data-destruction', 'destructive'],
]);
const CAPABILITIES = new Set(CAPABILITY_EFFECT.keys());
const EFFECT_CLASSES = new Set(CAPABILITY_EFFECT.values());
const BLAST_RADII = new Set<StandingPermitBlastRadiusV1>([
  'sandbox', 'repository', 'ecosystem', 'external', 'production',
]);
const REVERSIBILITY = new Set<StandingPermitReversibilityV1>(['proven', 'best-effort', 'irreversible']);
const BUDGET_UNITS = new Set<StandingPermitBudgetUnitV1>(['tokens', 'requests', 'usd-micros', 'compute-seconds']);
const SAFE_STANDING_BLAST = new Set<StandingPermitBlastRadiusV1>(['sandbox', 'repository']);
const STANDING_ELIGIBLE_CAPABILITIES = new Set<StandingPermitCapabilityV1>([
  'workspace-edit', 'model-dispatch',
]);

const CONTRACT_INPUT_KEYS = new Set([
  'schemaVersion', 'permitId', 'capability', 'effectClass', 'blastRadius', 'reversibility',
  'bindings', 'window', 'budget', 'trustedSignerKeyId', 'requestedAt',
]);
const CONTRACT_KEYS = new Set([
  ...CONTRACT_INPUT_KEYS, 'protocol', 'mode', 'authority', 'selfActivating', 'policyEligible',
  'grantAuthority', 'executionAuthority', 'permitDigest',
]);
const BINDING_KEYS = new Set([
  'principalDigest', 'workloadDigest', 'repositoryDigest', 'missionDigest', 'specDigest',
  'toolDigest', 'environmentDigest', 'budgetDigest', 'timeWindowDigest', 'acceptanceDigest',
  'rollbackDigest', 'revocationPolicyDigest',
]);
const WINDOW_KEYS = new Set(['validFrom', 'expiresAt']);
const BUDGET_KEYS = new Set(['unit', 'maximumUnits']);
const RECEIPT_KEYS = new Set([
  'schemaVersion', 'protocol', 'sequence', 'previousReceiptDigest', 'permitDigest', 'missionDigest',
  'specDigest', 'killEpochDigest', 'revocationEpochDigest', 'budgetConsumedUnits', 'killSwitchOn',
  'revoked', 'recordedAt', 'signerKeyId', 'authenticationClaim', 'appendOnly', 'sourceState', 'receiptDigest',
]);
const CURRENT_ANCHOR_KEYS = new Set([
  'schemaVersion', 'permitDigest', 'baseSequence', 'basePreviousReceiptDigest', 'headReceiptDigest',
  'headSequence', 'minimumSequence', 'observedAt',
]);

function plainRecord(value: unknown): Record<string, unknown> | null {
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

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function equalDigest(left: string, right: string): boolean {
  return digest(left) && digest(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function hash(domain: string, value: unknown): string {
  const canonicalJson = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : 'null';
    if (Array.isArray(item)) return `[${item.map(canonicalJson).join(',')}]`;
    if (typeof item === 'object') {
      const row = item as Record<string, unknown>;
      return `{${Object.keys(row).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
    }
    return 'null';
  };
  return createHash('sha256').update(domain, 'utf8').update('\n', 'utf8')
    .update(canonicalJson(value), 'utf8').digest('hex');
}

function validBindings(value: unknown): value is StandingPermitBindingsV1 {
  const row = plainRecord(value);
  return row !== null && exactKeys(row, BINDING_KEYS) &&
    [...BINDING_KEYS].every((key) => digest(row[key]));
}

export function digestStandingPermitWindowV1(window: StandingPermitWindowV1): string {
  return hash('ashlr.standing-permit.window.v1', window);
}

export function digestStandingPermitBudgetV1(budget: StandingPermitBudgetV1): string {
  return hash('ashlr.standing-permit.budget.v1', budget);
}

function permitPayload(permit: Omit<StandingPermitContractV1, 'permitDigest'>): unknown {
  return permit;
}

export function createStandingPermitContractV1(value: unknown): StandingPermitContractBuildResultV1 {
  const row = plainRecord(value);
  const issues: string[] = [];
  if (!row || !exactKeys(row, CONTRACT_INPUT_KEYS)) return { ok: false, permit: null, issues: ['invalid-input'] };
  const window = plainRecord(row['window']);
  const budget = plainRecord(row['budget']);
  if (row['schemaVersion'] !== 1) issues.push('invalid-schema-version');
  if (typeof row['permitId'] !== 'string' || !ID_RE.test(row['permitId'])) issues.push('invalid-permit-id');
  if (!CAPABILITIES.has(row['capability'] as StandingPermitCapabilityV1)) issues.push('invalid-capability');
  if (!EFFECT_CLASSES.has(row['effectClass'] as StandingPermitEffectClassV1)) issues.push('invalid-effect-class');
  if (CAPABILITY_EFFECT.get(row['capability'] as StandingPermitCapabilityV1) !== row['effectClass']) {
    issues.push('capability-effect-mismatch');
  }
  if (!BLAST_RADII.has(row['blastRadius'] as StandingPermitBlastRadiusV1)) issues.push('invalid-blast-radius');
  if (!REVERSIBILITY.has(row['reversibility'] as StandingPermitReversibilityV1)) issues.push('invalid-reversibility');
  if (!validBindings(row['bindings'])) issues.push('invalid-bindings');
  if (!window || !exactKeys(window, WINDOW_KEYS) || !canonicalTimestamp(window['validFrom']) ||
    !canonicalTimestamp(window['expiresAt'])) issues.push('invalid-window');
  if (!budget || !exactKeys(budget, BUDGET_KEYS) ||
    !BUDGET_UNITS.has(budget['unit'] as StandingPermitBudgetUnitV1) ||
    !Number.isSafeInteger(budget['maximumUnits']) || Number(budget['maximumUnits']) < 1) {
    issues.push('invalid-budget');
  }
  if (!digest(row['trustedSignerKeyId'])) issues.push('invalid-signer-key-id');
  if (!canonicalTimestamp(row['requestedAt'])) issues.push('invalid-request-time');
  if (window && canonicalTimestamp(window['validFrom']) && canonicalTimestamp(window['expiresAt'])) {
    const start = Date.parse(window['validFrom']);
    const end = Date.parse(window['expiresAt']);
    if (end <= start || end - start > STANDING_PERMIT_MAX_VALIDITY_MS) issues.push('invalid-validity-range');
    if (canonicalTimestamp(row['requestedAt']) && Date.parse(row['requestedAt']) > start) {
      issues.push('window-precedes-request');
    }
  }
  if (validBindings(row['bindings']) && window && exactKeys(window, WINDOW_KEYS) &&
    canonicalTimestamp(window['validFrom']) && canonicalTimestamp(window['expiresAt']) &&
    row['bindings'].timeWindowDigest !== digestStandingPermitWindowV1(window as unknown as StandingPermitWindowV1)) {
    issues.push('time-window-digest-mismatch');
  }
  if (validBindings(row['bindings']) && budget && exactKeys(budget, BUDGET_KEYS) &&
    BUDGET_UNITS.has(budget['unit'] as StandingPermitBudgetUnitV1) && Number.isSafeInteger(budget['maximumUnits']) &&
    row['bindings'].budgetDigest !== digestStandingPermitBudgetV1(budget as unknown as StandingPermitBudgetV1)) {
    issues.push('budget-digest-mismatch');
  }
  if (issues.length > 0) return { ok: false, permit: null, issues: [...new Set(issues)].sort() };

  const permitWithoutDigest: Omit<StandingPermitContractV1, 'permitDigest'> = {
    schemaVersion: 1,
    protocol: STANDING_PERMIT_SHADOW_PROTOCOL,
    mode: 'shadow',
    authority: 'observation-only',
    selfActivating: false,
    policyEligible: false,
    grantAuthority: false,
    executionAuthority: false,
    permitId: row['permitId'] as string,
    capability: row['capability'] as StandingPermitCapabilityV1,
    effectClass: row['effectClass'] as StandingPermitEffectClassV1,
    blastRadius: row['blastRadius'] as StandingPermitBlastRadiusV1,
    reversibility: row['reversibility'] as StandingPermitReversibilityV1,
    bindings: row['bindings'] as unknown as StandingPermitBindingsV1,
    window: row['window'] as unknown as StandingPermitWindowV1,
    budget: row['budget'] as unknown as StandingPermitBudgetV1,
    trustedSignerKeyId: row['trustedSignerKeyId'] as string,
    requestedAt: row['requestedAt'] as string,
  };
  const permit: StandingPermitContractV1 = {
    ...permitWithoutDigest,
    permitDigest: hash('ashlr.standing-permit.contract.v1', permitPayload(permitWithoutDigest)),
  };
  return { ok: true, permit, issues: [] };
}

export function verifyStandingPermitContractV1(value: unknown): value is StandingPermitContractV1 {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, CONTRACT_KEYS) || row['protocol'] !== STANDING_PERMIT_SHADOW_PROTOCOL ||
    row['mode'] !== 'shadow' || row['authority'] !== 'observation-only' || row['selfActivating'] !== false ||
    row['policyEligible'] !== false || row['grantAuthority'] !== false || row['executionAuthority'] !== false ||
    !digest(row['permitDigest'])) return false;
  const input = Object.fromEntries([...CONTRACT_INPUT_KEYS].map((key) => [key, row[key]]));
  const rebuilt = createStandingPermitContractV1(input);
  return rebuilt.ok && equalDigest(rebuilt.permit.permitDigest, row['permitDigest']);
}

export function digestStandingPermitEvidenceReceiptV1(
  value: Omit<StandingPermitEvidenceReceiptV1, 'receiptDigest'>,
): string {
  return hash('ashlr.standing-permit.evidence-receipt.v1', value);
}

function validEvidenceReceipt(value: unknown): value is StandingPermitEvidenceReceiptV1 {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, RECEIPT_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== STANDING_PERMIT_EVIDENCE_PROTOCOL || !Number.isSafeInteger(row['sequence']) ||
    Number(row['sequence']) < 1 || (row['previousReceiptDigest'] !== null && !digest(row['previousReceiptDigest'])) ||
    !digest(row['permitDigest']) || !digest(row['missionDigest']) || !digest(row['specDigest']) ||
    !digest(row['killEpochDigest']) || !digest(row['revocationEpochDigest']) ||
    !Number.isSafeInteger(row['budgetConsumedUnits']) || Number(row['budgetConsumedUnits']) < 0 ||
    typeof row['killSwitchOn'] !== 'boolean' || typeof row['revoked'] !== 'boolean' ||
    !canonicalTimestamp(row['recordedAt']) || !digest(row['signerKeyId']) ||
    row['authenticationClaim'] !== 'ed25519-v1' || row['appendOnly'] !== true ||
    row['sourceState'] !== 'healthy' || !digest(row['receiptDigest'])) return false;
  const { receiptDigest, ...unsigned } = row as unknown as StandingPermitEvidenceReceiptV1;
  return equalDigest(receiptDigest, digestStandingPermitEvidenceReceiptV1(unsigned));
}

function validCurrentAnchor(value: unknown): value is StandingPermitCurrentEvidenceAnchorV1 {
  const row = plainRecord(value);
  return row !== null && exactKeys(row, CURRENT_ANCHOR_KEYS) && row['schemaVersion'] === 1 &&
    digest(row['permitDigest']) && digest(row['headReceiptDigest']) &&
    Number.isSafeInteger(row['baseSequence']) && Number(row['baseSequence']) >= 1 &&
    (row['baseSequence'] === 1 ? row['basePreviousReceiptDigest'] === null : digest(row['basePreviousReceiptDigest'])) &&
    Number.isSafeInteger(row['headSequence']) && Number(row['headSequence']) >= 1 &&
    Number(row['baseSequence']) <= Number(row['headSequence']) &&
    Number.isSafeInteger(row['minimumSequence']) && Number(row['minimumSequence']) >= 1 &&
    Number(row['minimumSequence']) <= Number(row['headSequence']) && canonicalTimestamp(row['observedAt']);
}

function receiptAuthenticated(
  verifier: StandingPermitEvidenceVerifierV1 | null | undefined,
  receipt: StandingPermitEvidenceReceiptV1,
): boolean {
  if (!verifier || typeof verifier.verifyReceipt !== 'function') return false;
  try {
    return verifier.verifyReceipt(receipt) === true;
  } catch {
    return false;
  }
}

function anchorAuthenticated(
  verifier: StandingPermitEvidenceVerifierV1 | null | undefined,
  anchor: StandingPermitCurrentEvidenceAnchorV1,
): boolean {
  if (!verifier || typeof verifier.verifyCurrentAnchor !== 'function') return false;
  try {
    return verifier.verifyCurrentAnchor(anchor) === true;
  } catch {
    return false;
  }
}

function sameBindings(left: StandingPermitBindingsV1, right: StandingPermitBindingsV1): boolean {
  return [...BINDING_KEYS].every((key) => equalDigest(left[key as keyof StandingPermitBindingsV1], right[key as keyof StandingPermitBindingsV1]));
}

function canary(name: StandingPermitCanaryNameV1, passed: boolean, reason: string): StandingPermitCanaryResultV1 {
  return { name, passed, reason: passed ? null : reason };
}

const FALSE_AUTHORITY = Object.freeze({
  policy: false, grant: false, execution: false, merge: false, release: false, deploy: false,
  rollback: false, externalMutation: false, budget: false,
});
const FALSE_EFFECTS = Object.freeze({
  files: false, models: false, providers: false, commits: false, pushes: false, proposals: false,
  merges: false, releases: false, deployments: false, rollbacks: false,
  externalCommunications: false, destructiveMutations: false, budgets: false,
});

export function evaluateStandingPermitCanariesV1(
  input: StandingPermitEvaluationInputV1,
  dependencies: StandingPermitEvaluationDependenciesV1 = { verifier: null, currentAnchor: null },
): StandingPermitEvaluationV1 {
  const now = canonicalTimestamp(input?.evaluatedAt) ? Date.parse(input.evaluatedAt) : Number.NaN;
  const permitValid = verifyStandingPermitContractV1(input?.permit);
  const permit = permitValid ? input.permit : null;
  const receipts = Array.isArray(input?.evidence?.receipts) && input.evidence.receipts.length <= MAX_EVIDENCE_RECEIPTS
    ? input.evidence.receipts : [];
  const structurallyValid = receipts.length > 0 && receipts.every(validEvidenceReceipt);
  const latest = structurallyValid ? receipts[receipts.length - 1] ?? null : null;
  const baseSequence = input?.evidence?.baseSequence;
  const basePreviousReceiptDigest = input?.evidence?.basePreviousReceiptDigest;
  const suffixBasisValid = Number.isSafeInteger(baseSequence) && baseSequence >= 1 &&
    baseSequence <= Number.MAX_SAFE_INTEGER - receipts.length &&
    (baseSequence === 1 ? basePreviousReceiptDigest === null : digest(basePreviousReceiptDigest));
  const anchor = validCurrentAnchor(dependencies?.currentAnchor) ? dependencies.currentAnchor : null;
  const anchorVerified = anchor !== null && anchorAuthenticated(dependencies?.verifier, anchor);
  const receiptsAuthenticated = structurallyValid && receipts.every((receipt) =>
    receiptAuthenticated(dependencies?.verifier, receipt));

  const chainValid = structurallyValid && suffixBasisValid && receipts.every((receipt, index) =>
    receipt.sequence === baseSequence + index &&
    (index === 0
      ? (basePreviousReceiptDigest === null
          ? receipt.previousReceiptDigest === null
          : equalDigest(receipt.previousReceiptDigest ?? '', basePreviousReceiptDigest))
      : equalDigest(receipt.previousReceiptDigest ?? '', receipts[index - 1]?.receiptDigest ?? '')) &&
    (index === 0 || Date.parse(receipt.recordedAt) >= Date.parse(receipts[index - 1]?.recordedAt ?? '')) &&
    (index === 0 || receipt.budgetConsumedUnits >= (receipts[index - 1]?.budgetConsumedUnits ?? Number.MAX_SAFE_INTEGER)));
  const noDuplicateReceipts = new Set(receipts.map((receipt) => receipt.receiptDigest)).size === receipts.length;
  const signerMatches = permit !== null && receiptsAuthenticated && receipts.every((receipt) =>
    equalDigest(receipt.signerKeyId, permit.trustedSignerKeyId));
  const boundToPermit = permit !== null && structurallyValid && receipts.every((receipt) =>
    equalDigest(receipt.permitDigest, permit.permitDigest));
  const postureMatches = latest !== null &&
    equalDigest(latest.receiptDigest, input.currentPosture?.evidenceHeadDigest ?? '') &&
    equalDigest(latest.killEpochDigest, input.currentPosture?.killEpochDigest ?? '') &&
    equalDigest(latest.revocationEpochDigest, input.currentPosture?.revocationEpochDigest ?? '') &&
    latest.killSwitchOn === input.currentPosture?.killSwitchOn && latest.revoked === input.currentPosture?.revoked &&
    latest.recordedAt === input.currentPosture?.observedAt;
  const evidenceCurrent = latest !== null && Number.isFinite(now) &&
    now - Date.parse(latest.recordedAt) <= STANDING_PERMIT_EVIDENCE_MAX_AGE_MS &&
    Date.parse(latest.recordedAt) - now <= MAX_FUTURE_SKEW_MS && anchor !== null &&
    now - Date.parse(anchor.observedAt) <= STANDING_PERMIT_EVIDENCE_MAX_AGE_MS &&
    Date.parse(anchor.observedAt) - now <= MAX_FUTURE_SKEW_MS;
  const replayFree = permit !== null && latest !== null && anchor !== null && anchorVerified &&
    equalDigest(anchor.permitDigest, permit.permitDigest) &&
    anchor.baseSequence === baseSequence &&
    (anchor.basePreviousReceiptDigest === null
      ? basePreviousReceiptDigest === null
      : equalDigest(anchor.basePreviousReceiptDigest, basePreviousReceiptDigest ?? '')) &&
    equalDigest(anchor.headReceiptDigest, latest.receiptDigest) && anchor.headSequence === latest.sequence &&
    latest.sequence >= anchor.minimumSequence && postureMatches;
  const budgetValid = permit !== null && latest !== null &&
    Number.isSafeInteger(input.request?.requestedBudgetUnits) && input.request.requestedBudgetUnits >= 0 &&
    latest.budgetConsumedUnits <= permit.budget.maximumUnits &&
    input.request.requestedBudgetUnits <= permit.budget.maximumUnits - latest.budgetConsumedUnits;
  const missionSpecValid = permit !== null && latest !== null && validBindings(input.currentBindings) &&
    equalDigest(input.currentBindings.missionDigest, permit.bindings.missionDigest) &&
    equalDigest(input.currentBindings.specDigest, permit.bindings.specDigest) &&
    equalDigest(latest.missionDigest, permit.bindings.missionDigest) &&
    equalDigest(latest.specDigest, permit.bindings.specDigest);
  const scopeValid = permit !== null && STANDING_ELIGIBLE_CAPABILITIES.has(permit.capability) &&
    input.request?.capability === permit.capability &&
    input.request?.effectClass === permit.effectClass && CAPABILITY_EFFECT.get(permit.capability) === permit.effectClass;
  const windowValid = permit !== null && Number.isFinite(now) && now >= Date.parse(permit.window.validFrom) &&
    now < Date.parse(permit.window.expiresAt);
  const lowRisk = permit !== null && permit.reversibility === 'proven' && SAFE_STANDING_BLAST.has(permit.blastRadius);
  const contractBound = permit !== null && validBindings(input.currentBindings) &&
    sameBindings(input.currentBindings, permit.bindings) && boundToPermit;
  const evidenceHealthy = Boolean(input.evidence?.sourceComplete) && receiptsAuthenticated && anchorVerified &&
    chainValid && noDuplicateReceipts && postureMatches && replayFree && evidenceCurrent;
  const postureClear = latest !== null && latest.killSwitchOn === false && latest.revoked === false &&
    input.currentPosture?.killSwitchOn === false && input.currentPosture?.revoked === false;

  const canaries: StandingPermitCanaryResultV1[] = [
    canary('scope', scopeValid, 'capability-effect-scope-mismatch'),
    canary('expiry', windowValid, 'permit-not-current'),
    canary('replay', replayFree, 'evidence-head-replayed-or-stale'),
    // Supplied-chain continuity only. Cross-read replay protection is the
    // separate replay canary's external sequence floor + current head binding.
    canary('fork-rollback', chainValid && noDuplicateReceipts, 'supplied-chain-discontinuity-or-counter-regression'),
    canary('budget', budgetValid, 'budget-limit-exceeded'),
    canary('mission-spec', missionSpecValid, 'mission-or-spec-changed'),
    canary('evidence-health', evidenceHealthy && postureClear, postureClear ? 'evidence-degraded' : 'kill-or-revocation-active'),
    canary('reversibility-blast-radius', lowRisk, 'effect-not-proven-reversible-or-blast-radius-too-high'),
    canary('signer', signerMatches, 'trusted-signer-mismatch'),
    canary('bound-contract', contractBound, 'contract-binding-mismatch'),
  ];
  const blockers = canaries.filter((item) => !item.passed).map((item) => item.reason as string).sort();
  const eligibilityBasis = {
    permitDigest: permit?.permitDigest ?? null,
    evaluatedAt: input?.evaluatedAt ?? '',
    canaries,
  };
  const eligibilityDigest = hash('ashlr.standing-permit.eligibility.v1', eligibilityBasis);
  const withoutEvaluationDigest: Omit<StandingPermitEvaluationV1, 'evaluationDigest'> = {
    schemaVersion: 1,
    protocol: STANDING_PERMIT_SHADOW_PROTOCOL,
    mode: 'shadow',
    authority: 'observation-only',
    permitDigest: permit?.permitDigest ?? null,
    evaluatedAt: input?.evaluatedAt ?? '',
    eligibility: { criteriaSatisfied: blockers.length === 0, blockers, eligibilityDigest },
    grant: { requested: false, granted: false, grantDigest: null },
    execution: { requested: false, authorized: false, performed: false, executionReceiptDigest: null },
    canaries,
    authorityBits: { ...FALSE_AUTHORITY },
    effects: { ...FALSE_EFFECTS },
  };
  return {
    ...withoutEvaluationDigest,
    evaluationDigest: hash('ashlr.standing-permit.evaluation.v1', withoutEvaluationDigest),
  };
}
