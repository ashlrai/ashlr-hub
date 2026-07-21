/**
 * Autonomy evidence packs are the durable "why this was safe" record for
 * autonomous engineering actions. They intentionally sit beside the existing
 * merge gate: the gate still enforces safety, while this module turns its
 * scattered observations into one auditable artifact.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';

import type {
  AutoMergeTrustBasis,
  EngineTier,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  RouteSnapshot,
  RunEventSummary,
  Proposal,
  ProposalBrowserVerifyEvidence,
  ProposalVerifyResult,
  VisualGroundingEvidence,
} from '../types.js';
import {
  canonicalEvidencePackJsonV3,
  EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM,
  hashDiff,
  sealedEvidencePackDigestV3,
  signEvidencePackPayloadV3,
  verifyEvidencePackPayloadV3,
  verifySealedEvidencePackDigestV3,
  type ProvenanceVerdict,
} from '../foundry/provenance.js';
import { causalMetadata } from '../learning/causal.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  assurePrivateStoragePath,
  type PrivateStorageKind,
  type PrivateStorageMode,
} from '../util/private-storage.js';

export const READY_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1000;
export const READY_EVIDENCE_MAX_FUTURE_SKEW_MS = 60 * 1000;

const MAX_EVIDENCE_FILES = 2_048;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

export type AutonomyTarget = 'proposal' | 'branch' | 'main' | 'preview' | 'production';

export interface AutonomyGateEvidence {
  ok: boolean;
  detail: string;
}

export interface AutonomyRemoteProtectionEvidence extends AutonomyGateEvidence {
  live: true;
  nameWithOwner: string;
  repositoryId: string;
  branch: string;
  baseHead: string;
  observedAt: string;
  requirements: string[];
  requiredChecks: string[];
  requiredCheckBindings: Array<{ context: string; appId: string | null }>;
  policySources: Array<'classic' | 'ruleset'>;
  policyHash: string;
}

export interface AutonomyDiffEvidence {
  hash?: string;
  files: string[];
  changedLines: number;
}

export interface AutonomyVerificationEvidence {
  passed: boolean;
  detail: string;
  commandKinds: string[];
  baseBranch?: string;
  baseHead?: string;
  verifierAuthoritySnapshotVersion?: 1;
  verifierAuthorityObjectFormat?: 'sha1' | 'sha256';
  baseTreeOid?: string;
  candidateTreeOid?: string;
  authoritySnapshotDigest?: string;
  diffHash?: string;
  verifiedAt?: string;
  source?: ProposalVerifyResult['source'];
  browser?: ProposalBrowserVerifyEvidence;
}

export interface AutonomyEvidencePackFields {
  generatedAt: string;
  proposal: {
    id: string;
    repo: string | null;
    kind: Proposal['kind'];
    status: Proposal['status'];
    origin: Proposal['origin'];
    title: string;
    createdAt: string;
  };
  producer: {
    engineModel?: string;
    engineTier?: EngineTier;
  };
  diff: AutonomyDiffEvidence;
  target: AutonomyTarget;
  trustBasis: AutoMergeTrustBasis;
  remotePreferred: boolean;
  riskClass: 'low' | 'medium' | 'high';
  gates: {
    authority: AutonomyGateEvidence;
    provenance: AutonomyGateEvidence;
    verification: AutonomyGateEvidence;
    risk: AutonomyGateEvidence;
    scope: AutonomyGateEvidence;
    manager?: AutonomyGateEvidence;
    selfTarget?: AutonomyGateEvidence;
    edv?: AutonomyGateEvidence;
    remoteProtection?: AutonomyRemoteProtectionEvidence;
  };
  verification: AutonomyVerificationEvidence;
  policy?: {
    tier: string;
    action: string;
    allowed: boolean;
    reason: string;
  };
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
}

export interface AutonomyEvidencePackLegacy extends AutonomyEvidencePackFields {
  version: 1 | 2;
}

/**
 * V3 stays flat so observational consumers can read the same metadata fields.
 * payloadDigest covers this payload, signature MACs that digest, and
 * sealedPackDigest covers the resulting signed pack while excluding only itself.
 */
export interface AutonomyEvidencePackV3Payload extends AutonomyEvidencePackFields {
  version: 3;
}

export interface SignedAutonomyEvidencePackV3 extends AutonomyEvidencePackV3Payload {
  payloadDigest: string;
  signatureAlgorithm: typeof EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM;
  signingKeyId: string;
  signature: string;
  sealedPackDigest: string;
}

export type AutonomyEvidencePackV3 = SignedAutonomyEvidencePackV3;
export type AutonomyEvidencePack = AutonomyEvidencePackLegacy | SignedAutonomyEvidencePackV3;

export interface BuildAutonomyEvidenceInput {
  proposal: Proposal;
  target: AutonomyTarget;
  trustBasis: AutoMergeTrustBasis;
  remotePreferred?: boolean;
  riskClass: 'low' | 'medium' | 'high';
  authority: AutonomyGateEvidence;
  provenance: AutonomyGateEvidence;
  verification: AutonomyVerificationEvidence;
  risk: AutonomyGateEvidence;
  scope: AutonomyGateEvidence;
  manager?: AutonomyGateEvidence;
  selfTarget?: AutonomyGateEvidence;
  edv?: AutonomyGateEvidence;
  remoteProtection?: AutonomyRemoteProtectionEvidence;
}

export interface AutonomyEvidenceSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  unreadableFiles: number;
  limitExceeded: boolean;
}

export interface AutonomyEvidencePacksReadResult extends AutonomyEvidenceSourceQuality {
  packs: AutonomyEvidencePack[];
}

export type AutonomyEvidencePackList = AutonomyEvidencePack[] & {
  sourceQuality?: AutonomyEvidenceSourceQuality;
};

export function evidenceDir(): string {
  const home = homedir();
  if (!isAbsolute(home)) throw new Error('evidence storage requires an absolute home directory');
  return join(home, '.ashlr', 'evidence');
}

export function evidencePath(proposalId: string): string {
  if (!/^[\w.-]+$/.test(proposalId)) {
    throw new Error(`Invalid proposal id: ${JSON.stringify(proposalId)}`);
  }
  return join(evidenceDir(), `${proposalId}.json`);
}

export function summarizeDiff(diff: string | undefined): AutonomyDiffEvidence {
  const body = diff ?? '';
  const files = new Set<string>();
  let changedLines = 0;
  const addPath = (raw: string): void => {
    let p = raw.trim().split('\t')[0];
    if (p === '/dev/null') return;
    if (p.startsWith('b/') || p.startsWith('a/')) p = p.slice(2);
    if (p) files.add(p);
  };
  const addDiffGitPaths = (line: string): void => {
    const rest = line.slice('diff --git '.length).trim();
    const bIndex = rest.lastIndexOf(' b/');
    if (rest.startsWith('a/') && bIndex > 0) {
      addPath(rest.slice(0, bIndex));
      addPath(rest.slice(bIndex + 1));
      return;
    }
    const [left, ...right] = rest.split(/\s+/);
    if (left) addPath(left);
    if (right.length > 0) addPath(right.join(' '));
  };

  for (const line of body.split('\n')) {
    if (line.startsWith('diff --git ')) {
      addDiffGitPaths(line);
      continue;
    }
    if (line.startsWith('+++ ')) {
      addPath(line.slice(4));
      continue;
    }
    if (line.startsWith('--- ')) {
      addPath(line.slice(4));
      continue;
    }
    if (line.startsWith('rename from ')) {
      addPath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      addPath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) changedLines++;
  }

  return { files: [...files], changedLines };
}

export function buildAutonomyEvidencePack(input: BuildAutonomyEvidenceInput): AutonomyEvidencePackLegacy {
  const { proposal } = input;
  const diff = summarizeDiff(proposal.diff);
  const evidenceOutcome: EvidenceOutcomeSummary = {
    target: input.target,
    trustBasis: input.trustBasis,
    riskClass: input.riskClass,
    verificationPassed: input.verification.passed,
    gateCount: Object.values({
      authority: input.authority,
      provenance: input.provenance,
      verification: input.verification,
      risk: input.risk,
      scope: input.scope,
      manager: input.manager,
      selfTarget: input.selfTarget,
      edv: input.edv,
      remoteProtection: input.remoteProtection,
    }).filter(Boolean).length,
  };
  const causal = causalMetadata({
    proposalId: proposal.id,
    workItemId: proposal.workItemId,
    runId: proposal.runId,
    trajectoryId: proposal.trajectoryId,
    routeSnapshot: proposal.routeSnapshot,
    runEventSummary: proposal.runEventSummary,
    evidenceOutcome,
    learningSource: 'autonomy-evidence',
    labelBasis: 'evidence-policy',
    routerPolicyVersion: proposal.routerPolicyVersion,
    learningEpoch: proposal.learningEpoch,
    ts: proposal.createdAt,
  });
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    proposal: {
      id: proposal.id,
      repo: proposal.repo,
      kind: proposal.kind,
      status: proposal.status,
      origin: proposal.origin,
      title: proposal.title,
      createdAt: proposal.createdAt,
    },
    producer: {
      ...(proposal.engineModel ? { engineModel: proposal.engineModel } : {}),
      ...(proposal.engineTier ? { engineTier: proposal.engineTier } : {}),
    },
    diff: {
      ...diff,
      ...(proposal.diffHash ? { hash: proposal.diffHash } : {}),
    },
    target: input.target,
    trustBasis: input.trustBasis,
    remotePreferred: input.remotePreferred === true,
    riskClass: input.riskClass,
    gates: {
      authority: input.authority,
      provenance: input.provenance,
      verification: { ok: input.verification.passed, detail: input.verification.detail },
      risk: input.risk,
      scope: input.scope,
      ...(input.manager ? { manager: input.manager } : {}),
      ...(input.selfTarget ? { selfTarget: input.selfTarget } : {}),
      ...(input.edv ? { edv: input.edv } : {}),
      ...(input.remoteProtection ? { remoteProtection: input.remoteProtection } : {}),
    },
    verification: copyVerificationEvidence(input.verification),
    ...causal,
  };
}

function copyVisualEvidence(input: VisualGroundingEvidence): VisualGroundingEvidence {
  return {
    status: input.status,
    provider: input.provider,
    boxCount: input.boxCount,
    boxes: input.boxes.map((box) => ({
      x1: box.x1,
      y1: box.y1,
      x2: box.x2,
      y2: box.y2,
      scale: box.scale,
      ...(box.label ? { label: box.label } : {}),
      ...(typeof box.confidence === 'number' ? { confidence: box.confidence } : {}),
    })),
    ...(input.image
      ? {
          image: {
            bytes: input.image.bytes,
            sha256: input.image.sha256,
          },
        }
      : {}),
    detail: input.detail,
  };
}

function copyBrowserEvidence(input: ProposalBrowserVerifyEvidence): ProposalBrowserVerifyEvidence {
  return {
    ok: input.ok,
    renderOk: input.renderOk,
    consoleErrorCount: input.consoleErrorCount,
    screenshotCaptured: input.screenshotCaptured,
    detail: input.detail,
    ...(input.visualGrounding ? { visualGrounding: copyVisualEvidence(input.visualGrounding) } : {}),
  };
}

function copyVerificationEvidence(input: AutonomyVerificationEvidence): AutonomyVerificationEvidence {
  return {
    passed: input.passed,
    detail: input.detail,
    commandKinds: [...input.commandKinds],
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.baseHead ? { baseHead: input.baseHead } : {}),
    ...(input.verifierAuthoritySnapshotVersion !== undefined
      ? { verifierAuthoritySnapshotVersion: input.verifierAuthoritySnapshotVersion }
      : {}),
    ...(input.verifierAuthorityObjectFormat
      ? { verifierAuthorityObjectFormat: input.verifierAuthorityObjectFormat }
      : {}),
    ...(input.baseTreeOid ? { baseTreeOid: input.baseTreeOid } : {}),
    ...(input.candidateTreeOid ? { candidateTreeOid: input.candidateTreeOid } : {}),
    ...(input.authoritySnapshotDigest ? { authoritySnapshotDigest: input.authoritySnapshotDigest } : {}),
    ...(input.diffHash ? { diffHash: input.diffHash } : {}),
    ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.browser ? { browser: copyBrowserEvidence(input.browser) } : {}),
  };
}

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hasOnlyKeys(record: JsonRecord, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const PROPOSAL_KINDS = new Set([
  'patch', 'pr', 'deploy', 'note', 'desktop-action', 'browser-action',
]);
const PROPOSAL_STATUSES = new Set([
  'pending', 'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed',
]);
const PROPOSAL_ORIGINS = new Set(['backlog', 'swarm', 'manual', 'agent']);
const ENGINE_TIERS = new Set(['local', 'mid', 'frontier']);
const AUTONOMY_TARGETS = new Set(['proposal', 'branch', 'main', 'preview', 'production']);
const TRUST_BASES = new Set(['tier', 'verification', 'evidence']);
const RISK_CLASSES = new Set(['low', 'medium', 'high']);
const VERIFY_COMMAND_KINDS = new Set(['typecheck', 'lint', 'build', 'test']);
const VERIFY_SOURCES = new Set(['auto-merge', 'auto-merge-preflight', 'manual']);
const POLICY_TIERS = new Set(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
const POLICY_ACTIONS = new Set([
  'escalate-human', 'propose-only', 'apply-local-branch', 'open-ready-pr',
  'merge-main', 'deploy-preview', 'deploy-prod',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA1_OID_RE = /^[0-9a-f]{40}$/;
const SHA256_OID_RE = /^[0-9a-f]{64}$/;

const VERIFIER_AUTHORITY_FIELDS = [
  'verifierAuthoritySnapshotVersion',
  'verifierAuthorityObjectFormat',
  'baseTreeOid',
  'candidateTreeOid',
  'authoritySnapshotDigest',
] as const;

type VerifierAuthorityTupleState = 'absent' | 'complete' | 'invalid';
type VerifierAuthorityMetadata = Pick<ProposalVerifyResult,
  | 'verifierAuthoritySnapshotVersion'
  | 'verifierAuthorityObjectFormat'
  | 'baseTreeOid'
  | 'candidateTreeOid'
  | 'authoritySnapshotDigest'>;

function verifierAuthorityTupleState(record: JsonRecord): VerifierAuthorityTupleState {
  const present = VERIFIER_AUTHORITY_FIELDS.filter((field) => record[field] !== undefined).length;
  if (present === 0) return 'absent';
  if (present !== VERIFIER_AUTHORITY_FIELDS.length ||
    record['verifierAuthoritySnapshotVersion'] !== 1) return 'invalid';
  const objectFormat = record['verifierAuthorityObjectFormat'];
  const oidPattern = objectFormat === 'sha1'
    ? SHA1_OID_RE
    : objectFormat === 'sha256'
      ? SHA256_OID_RE
      : null;
  return oidPattern &&
    typeof record['baseTreeOid'] === 'string' && oidPattern.test(record['baseTreeOid']) &&
    typeof record['candidateTreeOid'] === 'string' && oidPattern.test(record['candidateTreeOid']) &&
    typeof record['authoritySnapshotDigest'] === 'string' &&
    SHA256_RE.test(record['authoritySnapshotDigest'])
    ? 'complete'
    : 'invalid';
}

/** Exact, fail-closed authority binding used by evidence authorization paths. */
export function verifierAuthorityBindingsMatch(
  left: VerifierAuthorityMetadata | undefined,
  right: VerifierAuthorityMetadata | undefined,
): boolean {
  if (!left || !right) return false;
  const leftRecord = left as unknown as JsonRecord;
  const rightRecord = right as unknown as JsonRecord;
  return verifierAuthorityTupleState(leftRecord) === 'complete' &&
    verifierAuthorityTupleState(rightRecord) === 'complete' &&
    VERIFIER_AUTHORITY_FIELDS.every((field) => leftRecord[field] === rightRecord[field]);
}
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/;

function enumString(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}

function boundedNonEmptyString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function boundedTrimmedString(value: unknown, maxBytes: number): value is string {
  return boundedNonEmptyString(value, maxBytes) && value === value.trim() && !value.includes('\0');
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function uniqueBoundedStrings(value: unknown, maxItems: number, maxBytes: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems &&
    value.every((entry) => boundedNonEmptyString(entry, maxBytes)) &&
    new Set(value).size === value.length;
}

function strictGateEvidence(value: unknown): value is AutonomyGateEvidence {
  const record = jsonRecord(value);
  return record !== null && hasOnlyKeys(record, ['ok', 'detail']) &&
    typeof record['ok'] === 'boolean' && boundedNonEmptyString(record['detail'], 16 * 1024);
}

function strictRemoteProtectionEvidence(value: unknown): value is AutonomyRemoteProtectionEvidence {
  if (!isLiveRemoteProtectionEvidence(value)) return false;
  const record = value as unknown as JsonRecord;
  if (!hasOnlyKeys(record, [
    'ok', 'detail', 'live', 'nameWithOwner', 'repositoryId', 'branch', 'baseHead',
    'observedAt', 'requirements', 'requiredChecks', 'requiredCheckBindings',
    'policySources', 'policyHash',
  ]) || !boundedTrimmedString(record['nameWithOwner'], 512) ||
    !/^[^/\s]+\/[^/\s]+$/.test(record['nameWithOwner']) ||
    !boundedNonEmptyString(record['repositoryId'], 256) ||
    !boundedTrimmedString(record['branch'], 256) ||
    typeof record['baseHead'] !== 'string' || !GIT_OID_RE.test(record['baseHead']) ||
    !canonicalTimestamp(record['observedAt']) ||
    !uniqueBoundedStrings(record['requirements'], 100, 256) ||
    !uniqueBoundedStrings(record['requiredChecks'], 100, 256) ||
    !uniqueBoundedStrings(record['policySources'], 2, 16) ||
    typeof record['policyHash'] !== 'string' || !SHA256_RE.test(record['policyHash'])) return false;
  const bindings = record['requiredCheckBindings'] as unknown[];
  const identities = new Set<string>();
  return bindings.length <= 100 && bindings.every((entry) => {
    const binding = jsonRecord(entry);
    if (binding === null || !hasOnlyKeys(binding, ['context', 'appId']) ||
      !boundedTrimmedString(binding['context'], 256) ||
      (binding['appId'] !== null && (typeof binding['appId'] !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(binding['appId'])))) return false;
    const identity = `${binding['context']}\0${binding['appId'] ?? ''}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

function strictVisualEvidence(value: unknown): boolean {
  const record = jsonRecord(value);
  const statuses = new Set(['ok', 'blocked', 'skipped', 'no-boxes', 'failed']);
  const providers = new Set(['locateanything-http', 'generic-openai-vision', 'disabled']);
  if (!record || !hasOnlyKeys(record, [
    'status', 'provider', 'boxCount', 'boxes', 'image', 'detail',
  ]) || !enumString(record['status'], statuses) || !enumString(record['provider'], providers) ||
    !nonNegativeInteger(record['boxCount']) || !Array.isArray(record['boxes']) ||
    record['boxes'].length > 64 || record['boxCount'] !== record['boxes'].length ||
    !boundedNonEmptyString(record['detail'], 16 * 1024)) return false;
  if (!record['boxes'].every((entry) => {
    const box = jsonRecord(entry);
    return box !== null && hasOnlyKeys(box, [
      'x1', 'y1', 'x2', 'y2', 'scale', 'label', 'confidence',
    ]) && finiteNumber(box['x1']) && box['x1'] >= 0 && box['x1'] <= 1_000 &&
      finiteNumber(box['y1']) && box['y1'] >= 0 && box['y1'] <= 1_000 &&
      finiteNumber(box['x2']) && box['x2'] >= box['x1'] && box['x2'] <= 1_000 &&
      finiteNumber(box['y2']) && box['y2'] >= box['y1'] && box['y2'] <= 1_000 &&
      box['scale'] === 'normalized-1000' && optionalString(box['label']) &&
      (box['label'] === undefined || boundedNonEmptyString(box['label'], 1_024)) &&
      (box['confidence'] === undefined || (finiteNumber(box['confidence']) &&
        box['confidence'] >= 0 && box['confidence'] <= 1));
  })) return false;
  if (record['image'] === undefined) return true;
  const image = jsonRecord(record['image']);
  return image !== null && hasOnlyKeys(image, ['bytes', 'sha256']) &&
    nonNegativeInteger(image['bytes']) && typeof image['sha256'] === 'string' &&
    SHA256_RE.test(image['sha256']);
}

function strictBrowserEvidence(value: unknown): boolean {
  const record = jsonRecord(value);
  return record !== null && hasOnlyKeys(record, [
    'ok', 'renderOk', 'consoleErrorCount', 'screenshotCaptured', 'detail', 'visualGrounding',
  ]) && typeof record['ok'] === 'boolean' && typeof record['renderOk'] === 'boolean' &&
    nonNegativeInteger(record['consoleErrorCount']) &&
    typeof record['screenshotCaptured'] === 'boolean' &&
    boundedNonEmptyString(record['detail'], 16 * 1024) &&
    (record['visualGrounding'] === undefined || strictVisualEvidence(record['visualGrounding']));
}

function strictRouteSnapshot(value: unknown): boolean {
  const record = jsonRecord(value);
  return record !== null && hasOnlyKeys(record, [
    'backend', 'tier', 'model', 'assignedBy', 'reason', 'routerPolicyVersion',
    'selectedSkillIds', 'skillPolicyVersion', 'skillMode',
  ]) && (record['backend'] === undefined || record['backend'] === null || typeof record['backend'] === 'string') &&
    (record['tier'] === undefined || record['tier'] === null || typeof record['tier'] === 'string') &&
    (record['model'] === undefined || record['model'] === null || typeof record['model'] === 'string') &&
    optionalString(record['assignedBy']) && optionalString(record['reason']) &&
    optionalString(record['routerPolicyVersion']) &&
    (record['selectedSkillIds'] === undefined || stringArray(record['selectedSkillIds'])) &&
    optionalString(record['skillPolicyVersion']) && optionalString(record['skillMode']);
}

const RUN_ACTION_COUNT_KEYS = [
  'sandboxCreated', 'spawnAttempts', 'transientRetries', 'proposalCaptureAttempts',
  'completenessGateRuns', 'verifyRepairAttempts', 'modelSteps', 'toolSteps', 'totalSteps',
  'diffFiles', 'diffLines', 'proposalCreated', 'proposalBlocked', 'proposalDisabled',
] as const;

function strictNumberSummary(value: unknown, allowed: readonly string[]): boolean {
  const record = jsonRecord(value);
  return record !== null && hasOnlyKeys(record, allowed) &&
    Object.values(record).every((entry) => entry === undefined || finiteNumber(entry));
}

function strictContextSummary(value: unknown): boolean {
  const record = jsonRecord(value);
  if (!record || !hasOnlyKeys(record, ['prompt', 'retrieval', 'compression'])) return false;
  const prompt = record['prompt'];
  if (prompt !== undefined) {
    const p = jsonRecord(prompt);
    if (!p || !hasOnlyKeys(p, [
      'role', 'profileId', 'contextWindowTokens', 'providerPromptTokens', 'estimatedPromptTokens',
      'promptCharCap', 'assembledSystemChars', 'promptBudgetRatio', 'contextWindowRatio',
      'layersIncluded', 'toolCount', 'cacheHit',
    ]) || !optionalString(p['role']) || !optionalString(p['profileId']) ||
      (p['layersIncluded'] !== undefined && !stringArray(p['layersIncluded'])) ||
      (p['cacheHit'] !== undefined && typeof p['cacheHit'] !== 'boolean') ||
      !Object.entries(p).every(([key, entry]) =>
        ['role', 'profileId', 'layersIncluded', 'cacheHit'].includes(key) || finiteNumber(entry))) return false;
  }
  const retrieval = record['retrieval'];
  if (retrieval !== undefined) {
    const r = jsonRecord(retrieval);
    if (!r || !hasOnlyKeys(r, [
      'source', 'requestedLimit', 'corpusEntries', 'candidateCount', 'hitCount',
      'injectedHitCount', 'limitHitRate', 'candidateHitRate', 'methodCounts',
      'topScore', 'injectedChars',
    ]) || !optionalString(r['source']) ||
      !Object.entries(r).every(([key, entry]) => {
        if (key === 'source') return true;
        if (key === 'methodCounts') {
          return entry === undefined || strictNumberSummary(entry, ['keyword', 'embedding']);
        }
        return finiteNumber(entry);
      })) return false;
  }
  const compression = record['compression'];
  if (compression !== undefined) {
    const c = jsonRecord(compression);
    if (!c || !hasOnlyKeys(c, [
      'source', 'strategy', 'inputChars', 'outputChars', 'maxChars', 'droppedChars',
      'compressionRatio', 'truncated', 'droppedLayers',
    ]) || !optionalString(c['source']) || !optionalString(c['strategy']) ||
      (c['truncated'] !== undefined && typeof c['truncated'] !== 'boolean') ||
      (c['droppedLayers'] !== undefined && !stringArray(c['droppedLayers'])) ||
      !Object.entries(c).every(([key, entry]) =>
        ['source', 'strategy', 'truncated', 'droppedLayers'].includes(key) || finiteNumber(entry))) return false;
  }
  return true;
}

function strictRunEventSummary(value: unknown): boolean {
  const record = jsonRecord(value);
  return record !== null && hasOnlyKeys(record, [
    'runId', 'status', 'outcome', 'proposalCreated', 'proposalId', 'diffFiles', 'diffLines',
    'tokensIn', 'tokensOut', 'costUsd', 'durationMs', 'cacheHit', 'contextSummary', 'actionCounts',
  ]) && optionalString(record['runId']) && optionalString(record['status']) &&
    optionalString(record['outcome']) && optionalString(record['proposalId']) &&
    (record['proposalCreated'] === undefined || typeof record['proposalCreated'] === 'boolean') &&
    (record['cacheHit'] === undefined || typeof record['cacheHit'] === 'boolean') &&
    ['diffFiles', 'diffLines', 'tokensIn', 'tokensOut', 'costUsd', 'durationMs']
      .every((key) => record[key] === undefined || finiteNumber(record[key])) &&
    (record['contextSummary'] === undefined || strictContextSummary(record['contextSummary'])) &&
    (record['actionCounts'] === undefined || strictNumberSummary(record['actionCounts'], RUN_ACTION_COUNT_KEYS));
}

function strictEvidenceOutcome(value: unknown): boolean {
  const record = jsonRecord(value);
  return record !== null && hasOnlyKeys(record, [
    'target', 'trustBasis', 'riskClass', 'verificationPassed', 'policyAllowed',
    'policyAction', 'policyTier', 'gateCount',
  ]) && optionalString(record['target']) && optionalString(record['trustBasis']) &&
    optionalString(record['riskClass']) && optionalString(record['policyAction']) &&
    optionalString(record['policyTier']) &&
    (record['verificationPassed'] === undefined || typeof record['verificationPassed'] === 'boolean') &&
    (record['policyAllowed'] === undefined || typeof record['policyAllowed'] === 'boolean') &&
    (record['gateCount'] === undefined || nonNegativeInteger(record['gateCount']));
}

const EVIDENCE_PAYLOAD_KEYS = [
  'version', 'generatedAt', 'proposal', 'producer', 'diff', 'target', 'trustBasis',
  'remotePreferred', 'riskClass', 'gates', 'verification', 'policy', 'trajectoryId',
  'routeSnapshot', 'runEventSummary', 'evidenceOutcome', 'learningSource', 'labelBasis',
  'routerPolicyVersion', 'learningEpoch',
] as const;

function strictEvidencePackV3Payload(value: unknown): value is AutonomyEvidencePackV3Payload {
  if (canonicalEvidencePackJsonV3(value) === null) return false;
  const record = jsonRecord(value);
  if (!record || !hasOnlyKeys(record, EVIDENCE_PAYLOAD_KEYS) || record['version'] !== 3 ||
    !canonicalTimestamp(record['generatedAt'])) return false;

  const proposal = jsonRecord(record['proposal']);
  if (!proposal || !hasOnlyKeys(proposal, [
    'id', 'repo', 'kind', 'status', 'origin', 'title', 'createdAt',
  ]) || typeof proposal['id'] !== 'string' || !PROPOSAL_ID_RE.test(proposal['id']) ||
    (proposal['repo'] !== null && (!boundedNonEmptyString(proposal['repo'], 4_096) ||
      !isAbsolute(proposal['repo']) || proposal['repo'].includes('\0'))) ||
    !enumString(proposal['kind'], PROPOSAL_KINDS) ||
    !enumString(proposal['status'], PROPOSAL_STATUSES) ||
    !enumString(proposal['origin'], PROPOSAL_ORIGINS) ||
    !boundedNonEmptyString(proposal['title'], 4_096) ||
    !canonicalTimestamp(proposal['createdAt']) ||
    Date.parse(proposal['createdAt']) > Date.parse(record['generatedAt'] as string)) return false;

  const producer = jsonRecord(record['producer']);
  if (!producer || !hasOnlyKeys(producer, ['engineModel', 'engineTier']) ||
    (producer['engineModel'] !== undefined && !boundedNonEmptyString(producer['engineModel'], 512)) ||
    (producer['engineTier'] !== undefined && !enumString(producer['engineTier'], ENGINE_TIERS))) return false;

  const diff = jsonRecord(record['diff']);
  if (!diff || !hasOnlyKeys(diff, ['hash', 'files', 'changedLines']) ||
    (diff['hash'] !== undefined && (typeof diff['hash'] !== 'string' || !SHA256_RE.test(diff['hash']))) ||
    !uniqueBoundedStrings(diff['files'], 4_096, 4_096) ||
    !nonNegativeInteger(diff['changedLines'])) return false;

  const gates = jsonRecord(record['gates']);
  if (!gates || !hasOnlyKeys(gates, [
    'authority', 'provenance', 'verification', 'risk', 'scope', 'manager',
    'selfTarget', 'edv', 'remoteProtection',
  ]) || !['authority', 'provenance', 'verification', 'risk', 'scope']
    .every((key) => strictGateEvidence(gates[key])) ||
    !['manager', 'selfTarget', 'edv']
      .every((key) => gates[key] === undefined || strictGateEvidence(gates[key])) ||
    (gates['remoteProtection'] !== undefined && !strictRemoteProtectionEvidence(gates['remoteProtection']))) return false;

  const verification = jsonRecord(record['verification']);
  if (!verification || !hasOnlyKeys(verification, [
    'passed', 'detail', 'commandKinds', 'baseBranch', 'baseHead', 'diffHash',
    'verifiedAt', 'source', 'browser', ...VERIFIER_AUTHORITY_FIELDS,
  ]) || typeof verification['passed'] !== 'boolean' ||
    !boundedNonEmptyString(verification['detail'], 16 * 1024) ||
    !Array.isArray(verification['commandKinds']) || verification['commandKinds'].length > 100 ||
    !(verification['commandKinds'] as unknown[]).every((kind) =>
      typeof kind === 'string' && VERIFY_COMMAND_KINDS.has(kind)) ||
    (verification['baseBranch'] !== undefined && !boundedTrimmedString(verification['baseBranch'], 256)) ||
    (verification['baseHead'] !== undefined && (typeof verification['baseHead'] !== 'string' ||
      !GIT_OID_RE.test(verification['baseHead'])) ) ||
    (verification['diffHash'] !== undefined && (typeof verification['diffHash'] !== 'string' ||
      !SHA256_RE.test(verification['diffHash']))) ||
    (verification['verifiedAt'] !== undefined && !canonicalTimestamp(verification['verifiedAt'])) ||
    (verification['source'] !== undefined && !enumString(verification['source'], VERIFY_SOURCES)) ||
    (verification['browser'] !== undefined && !strictBrowserEvidence(verification['browser']))) return false;
  const verifierAuthorityState = verifierAuthorityTupleState(verification);
  if (verifierAuthorityState === 'invalid') return false;
  if (diff['hash'] !== undefined && verification['diffHash'] !== undefined &&
    diff['hash'] !== verification['diffHash']) return false;
  if (verification['verifiedAt'] !== undefined &&
    Date.parse(verification['verifiedAt'] as string) > Date.parse(record['generatedAt'] as string)) return false;
  if (gates['verification'] && (gates['verification'] as JsonRecord)['ok'] !== verification['passed']) {
    return false;
  }
  if (verification['passed'] === true && (
    verification['baseBranch'] === undefined || verification['baseHead'] === undefined ||
    verification['diffHash'] === undefined || verification['verifiedAt'] === undefined ||
    verification['source'] === undefined || diff['hash'] !== verification['diffHash'] ||
    Date.parse(proposal['createdAt'] as string) > Date.parse(verification['verifiedAt'] as string)
  )) return false;

  const policy = record['policy'];
  if (policy !== undefined) {
    const p = jsonRecord(policy);
    if (!p || !hasOnlyKeys(p, ['tier', 'action', 'allowed', 'reason']) ||
      !enumString(p['tier'], POLICY_TIERS) || !enumString(p['action'], POLICY_ACTIONS) ||
      typeof p['allowed'] !== 'boolean' || !boundedNonEmptyString(p['reason'], 16 * 1024)) return false;
    if (p['allowed'] === false && (p['tier'] !== 'T0' || p['action'] !== 'escalate-human')) return false;
    if (p['allowed'] === true) {
      const allowedTuple =
        (record['target'] === 'proposal' && p['tier'] === 'T1' && p['action'] === 'propose-only') ||
        (record['target'] === 'branch' && record['remotePreferred'] === false &&
          p['tier'] === 'T2' && p['action'] === 'apply-local-branch') ||
        (record['target'] === 'branch' && record['remotePreferred'] === true &&
          p['tier'] === 'T3' && p['action'] === 'open-ready-pr') ||
        (record['target'] === 'main' && p['tier'] === 'T4' && p['action'] === 'merge-main') ||
        (record['target'] === 'preview' && p['tier'] === 'T5' && p['action'] === 'deploy-preview');
      if (!allowedTuple || verification['passed'] !== true ||
        Object.values(gates).some((gate) => (gate as JsonRecord)['ok'] !== true)) return false;
      if (record['trustBasis'] === 'evidence' && verifierAuthorityState !== 'complete') return false;
    }
  }

  if (!enumString(record['target'], AUTONOMY_TARGETS) ||
    !enumString(record['trustBasis'], TRUST_BASES) ||
    typeof record['remotePreferred'] !== 'boolean' ||
    !enumString(record['riskClass'], RISK_CLASSES) ||
    !(optionalString(record['trajectoryId']) && optionalString(record['learningSource']) &&
      optionalString(record['labelBasis']) && optionalString(record['routerPolicyVersion']) &&
      optionalString(record['learningEpoch']) &&
      (record['routeSnapshot'] === undefined || strictRouteSnapshot(record['routeSnapshot'])) &&
      (record['runEventSummary'] === undefined || strictRunEventSummary(record['runEventSummary'])) &&
      (record['evidenceOutcome'] === undefined || strictEvidenceOutcome(record['evidenceOutcome'])))) return false;

  if (record['learningEpoch'] !== undefined &&
    (typeof record['learningEpoch'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record['learningEpoch']))) {
    return false;
  }

  if (record['evidenceOutcome'] !== undefined) {
    const outcome = record['evidenceOutcome'] as JsonRecord;
    const presentGateCount = Object.values(gates).length;
    if (outcome['target'] !== record['target'] || outcome['trustBasis'] !== record['trustBasis'] ||
      outcome['riskClass'] !== record['riskClass'] ||
      outcome['verificationPassed'] !== verification['passed'] ||
      outcome['gateCount'] !== presentGateCount) return false;
    if (policy !== undefined) {
      const p = policy as JsonRecord;
      if (outcome['policyAllowed'] !== p['allowed'] || outcome['policyAction'] !== p['action'] ||
        outcome['policyTier'] !== p['tier']) return false;
    } else if (outcome['policyAllowed'] !== undefined || outcome['policyAction'] !== undefined ||
      outcome['policyTier'] !== undefined) {
      return false;
    }
  }

  if (policy !== undefined) {
    const p = policy as JsonRecord;
    if (p['allowed'] === true && p['action'] === 'merge-main') {
      const requiredGates = ['authority', 'provenance', 'verification', 'risk', 'scope'];
      if (record['target'] !== 'main' ||
        (proposal['kind'] !== 'patch' && proposal['kind'] !== 'pr') ||
        (proposal['status'] !== 'pending' && proposal['status'] !== 'approved') ||
        diff['hash'] === undefined ||
        (diff['files'] as string[]).length === 0 || diff['changedLines'] === 0 ||
        verification['passed'] !== true ||
        (record['trustBasis'] === 'evidence' && (verification['commandKinds'] as string[]).length === 0) ||
        verification['baseBranch'] === undefined || verification['baseHead'] === undefined ||
        verification['diffHash'] !== diff['hash'] || verification['verifiedAt'] === undefined ||
        verification['source'] === undefined ||
        !requiredGates.every((key) => (gates[key] as JsonRecord)['ok'] === true)) return false;
      if (record['trustBasis'] === 'evidence') {
        const remote = jsonRecord(gates['remoteProtection']);
        if (verifierAuthorityState !== 'complete' || record['remotePreferred'] !== true || !remote ||
          remote['branch'] !== verification['baseBranch'] ||
          remote['baseHead'] !== verification['baseHead'] ||
          verification['source'] === 'manual' ||
          Date.parse(remote['observedAt'] as string) < Date.parse(verification['verifiedAt'] as string) ||
          Date.parse(remote['observedAt'] as string) > Date.parse(record['generatedAt'] as string)) return false;
        const checks = remote['requiredChecks'] as string[];
        const bindings = remote['requiredCheckBindings'] as Array<{ context: string }>;
        if (checks.length === 0 || bindings.length === 0 ||
          JSON.stringify([...checks].sort()) !==
            JSON.stringify([...bindings.map((binding) => binding.context)].sort())) return false;
      }
    }
  }
  return true;
}

function withoutFields(record: JsonRecord, omitted: readonly string[]): JsonRecord {
  const omittedSet = new Set(omitted);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !omittedSet.has(key)));
}

export function verifyAutonomyEvidencePackV3(value: unknown): ProvenanceVerdict {
  try {
    const record = jsonRecord(value);
    if (!record || record['version'] !== 3) {
      return { ok: false, reason: 'legacy evidence packs are unsigned observational evidence' };
    }
    if (canonicalEvidencePackJsonV3(value) === null || !hasOnlyKeys(record, [
      ...EVIDENCE_PAYLOAD_KEYS, 'payloadDigest', 'signatureAlgorithm', 'signingKeyId',
      'signature', 'sealedPackDigest',
    ])) {
      return { ok: false, reason: 'invalid or unknown evidence pack v3 fields' };
    }
    const payload = withoutFields(record, [
      'payloadDigest', 'signatureAlgorithm', 'signingKeyId', 'signature', 'sealedPackDigest',
    ]);
    if (!strictEvidencePackV3Payload(payload)) {
      return { ok: false, reason: 'invalid or unknown evidence pack v3 payload fields' };
    }
    const signatureVerdict = verifyEvidencePackPayloadV3(
      payload,
      record['payloadDigest'],
      record['signature'],
      record['signatureAlgorithm'],
      record['signingKeyId'],
    );
    if (!signatureVerdict.ok) return signatureVerdict;
    const signedPack = withoutFields(record, ['sealedPackDigest']);
    return verifySealedEvidencePackDigestV3(signedPack, record['sealedPackDigest']);
  } catch (error) {
    return {
      ok: false,
      reason: `evidence pack v3 verify error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function sealAutonomyEvidencePackV3(
  pack: AutonomyEvidencePackLegacy,
): SignedAutonomyEvidencePackV3 | null {
  try {
    if (!isAutonomyEvidencePackLegacy(pack)) return null;
    const payload = { ...pack, version: 3 } as AutonomyEvidencePackV3Payload;
    if (!strictEvidencePackV3Payload(payload)) return null;
    const signedPayload = signEvidencePackPayloadV3(payload);
    if (!signedPayload) return null;
    const signedPack = { ...payload, ...signedPayload };
    const sealedPackDigest = sealedEvidencePackDigestV3(signedPack);
    if (!sealedPackDigest) return null;
    const sealed = { ...signedPack, sealedPackDigest } as SignedAutonomyEvidencePackV3;
    return verifyAutonomyEvidencePackV3(sealed).ok ? sealed : null;
  } catch {
    return null;
  }
}

export function buildSignedAutonomyEvidencePackV3(
  input: BuildAutonomyEvidenceInput,
): SignedAutonomyEvidencePackV3 | null {
  const rawDiff = input.proposal.diff ?? '';
  const derivedDiffHash = hashDiff(rawDiff);
  if ((rawDiff.length > 0 && input.proposal.diffHash === undefined) ||
    (input.proposal.diffHash !== undefined && input.proposal.diffHash !== derivedDiffHash) ||
    (input.verification.diffHash !== undefined && input.verification.diffHash !== derivedDiffHash)) {
    return null;
  }
  const pack = buildAutonomyEvidencePack(input);
  if (rawDiff.length > 0) pack.diff.hash = derivedDiffHash;
  return sealAutonomyEvidencePackV3(pack);
}

interface EvidenceDirectoryEntry {
  path: string;
  fd?: number;
  snapshot: BigIntStats;
  privateDirectory: boolean;
  exactSnapshot: boolean;
}

interface EvidenceDirectoryAuthority {
  entries: EvidenceDirectoryEntry[];
  evidence: EvidenceDirectoryEntry;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
}

function ownedByCurrentUser(stat: BigIntStats): boolean {
  return process.platform === 'win32' || typeof process.getuid !== 'function' ||
    stat.uid === BigInt(process.getuid());
}

function safeEvidenceDirectory(stat: BigIntStats, privateDirectory: boolean): boolean {
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat)) return false;
  if (process.platform === 'win32') return true;
  const unsafeMask = privateDirectory ? 0o077n : 0o022n;
  return (stat.mode & unsafeMask) === 0n;
}

function safeEvidenceFile(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n &&
    ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077n) === 0n);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameDirectorySecurity(left, right) && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameDirectorySecurity(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameDirectorySnapshot(left, right) && left.size === right.size;
}

function assureWindowsEvidencePath(
  path: string,
  kind: PrivateStorageKind,
  mode: PrivateStorageMode,
): void {
  if (process.platform !== 'win32') return;
  const assurance = assurePrivateStoragePath(path, kind, mode, { anchorPath: homedir() });
  if (!assurance.ok) {
    throw new Error(`unsafe Windows evidence ${kind}: ${path} (${assurance.reason})`);
  }
}

function closeEvidenceDirectoryAuthority(authority: EvidenceDirectoryAuthority | undefined): void {
  if (!authority) return;
  for (const entry of [...authority.entries].reverse()) {
    if (entry.fd !== undefined) {
      try { closeSync(entry.fd); } catch { /* best effort */ }
    }
  }
}

function assertEvidenceDirectoryAuthority(
  authority: EvidenceDirectoryAuthority,
  exactSnapshot: boolean,
): void {
  for (const entry of authority.entries) {
    const namedBefore = lstatSync(entry.path, { bigint: true });
    if (entry.exactSnapshot) {
      assureWindowsEvidencePath(entry.path, 'directory', 'inspect-existing');
    }
    const named = lstatSync(entry.path, { bigint: true });
    const held = entry.fd === undefined ? named : fstatSync(entry.fd, { bigint: true });
    if (!safeEvidenceDirectory(held, entry.privateDirectory) ||
      !sameDirectorySnapshot(namedBefore, named) ||
      !safeEvidenceDirectory(named, entry.privateDirectory) ||
      !sameDirectorySecurity(entry.snapshot, held) ||
      !sameDirectorySecurity(entry.snapshot, named) ||
      (exactSnapshot && entry.exactSnapshot &&
        (!sameDirectorySnapshot(entry.snapshot, held) ||
          !sameDirectorySnapshot(entry.snapshot, named)))) {
      throw new Error(`evidence directory authority changed: ${entry.path}`);
    }
  }
}

function refreshEvidenceDirectorySnapshot(
  entries: EvidenceDirectoryEntry[],
  changedEntry: EvidenceDirectoryEntry,
): void {
  for (const entry of entries) {
    const namedBefore = lstatSync(entry.path, { bigint: true });
    if (entry.exactSnapshot) {
      assureWindowsEvidencePath(entry.path, 'directory', 'inspect-existing');
    }
    const named = lstatSync(entry.path, { bigint: true });
    const held = entry.fd === undefined ? named : fstatSync(entry.fd, { bigint: true });
    const unchanged = entry !== changedEntry;
    if (!safeEvidenceDirectory(held, entry.privateDirectory) ||
      !sameDirectorySnapshot(namedBefore, named) ||
      !safeEvidenceDirectory(named, entry.privateDirectory) ||
      !sameIdentity(entry.snapshot, held) || !sameIdentity(entry.snapshot, named) ||
      !sameDirectorySnapshot(held, named) ||
      (unchanged && entry.exactSnapshot &&
        (!sameDirectorySnapshot(entry.snapshot, held) ||
          !sameDirectorySnapshot(entry.snapshot, named)))) {
      throw new Error(`evidence directory authority changed: ${entry.path}`);
    }
  }
  changedEntry.snapshot = changedEntry.fd === undefined
    ? lstatSync(changedEntry.path, { bigint: true })
    : fstatSync(changedEntry.fd, { bigint: true });
}

function openEvidenceDirectoryAuthority(create: boolean): EvidenceDirectoryAuthority {
  const home = homedir();
  const paths = [home, join(home, '.ashlr'), evidenceDir()];
  const entries: EvidenceDirectoryEntry[] = [];
  try {
    for (const [index, path] of paths.entries()) {
      let created = false;
      if (create && index > 0) {
        try {
          mkdirSync(path, { mode: 0o700 });
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        if (created && entries.length > 0) {
          refreshEvidenceDirectorySnapshot(entries, entries[entries.length - 1]!);
        } else if (entries.length > 0) {
          assertEvidenceDirectoryAuthority(
            { entries, evidence: entries[entries.length - 1]! },
            true,
          );
        }
      }
      const privateDirectory = index === paths.length - 1;
      const before = lstatSync(path, { bigint: true });
      const allowPrivateModeMigration = create && privateDirectory;
      if (!safeEvidenceDirectory(before, allowPrivateModeMigration ? false : privateDirectory)) {
        throw new Error(`unsafe evidence directory: ${path}`);
      }
      if (index > 0) {
        assureWindowsEvidencePath(
          path,
          'directory',
          created ? 'secure-created' : 'inspect-existing',
        );
      }
      const fd = process.platform === 'win32'
        ? undefined
        : openSync(path, fsConstants.O_RDONLY | directoryFlag() | noFollowFlag());
      let opened = fd === undefined
        ? lstatSync(path, { bigint: true })
        : fstatSync(fd, { bigint: true });
      if (!safeEvidenceDirectory(opened, allowPrivateModeMigration ? false : privateDirectory) ||
        !sameIdentity(before, opened)) {
        if (fd !== undefined) closeSync(fd);
        throw new Error(`evidence directory changed while opening: ${path}`);
      }
      if (create && privateDirectory && process.platform !== 'win32' &&
        (opened.mode & 0o777n) !== 0o700n) {
        fchmodSync(fd!, 0o700);
        opened = fstatSync(fd!, { bigint: true });
        const named = lstatSync(path, { bigint: true });
        if (!safeEvidenceDirectory(opened, true) || !safeEvidenceDirectory(named, true) ||
          !sameIdentity(opened, named)) {
          closeSync(fd!);
          throw new Error(`evidence directory mode changed unsafely: ${path}`);
        }
      }
      entries.push({
        path,
        ...(fd === undefined ? {} : { fd }),
        snapshot: opened,
        privateDirectory,
        exactSnapshot: index > 0,
      });
      assertEvidenceDirectoryAuthority({ entries, evidence: entries[entries.length - 1]! }, false);
    }
    const authority = { entries, evidence: entries[entries.length - 1]! };
    assertEvidenceDirectoryAuthority(authority, true);
    return authority;
  } catch (error) {
    if (entries.length > 0) {
      closeEvidenceDirectoryAuthority({ entries, evidence: entries[entries.length - 1]! });
    }
    throw error;
  }
}

function removeExactTemporary(
  path: string | undefined,
  identity: BigIntStats | undefined,
  authority: EvidenceDirectoryAuthority | undefined,
): void {
  if (!path || !identity || !authority) return;
  try {
    assertEvidenceDirectoryAuthority(authority, false);
    assureWindowsEvidencePath(path, 'file', 'inspect-existing');
    const named = lstatSync(path, { bigint: true });
    if (safeEvidenceFile(named) && sameIdentity(identity, named)) unlinkSync(path);
  } catch {
    // Never remove a replacement or traverse a rebound directory during cleanup.
  }
}

function scanJsonString(raw: string, cursor: { index: number }): string {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < raw.length) {
    const char = raw[cursor.index]!;
    if (char === '\\') {
      cursor.index += 2;
      continue;
    }
    cursor.index += 1;
    if (char === '"') return JSON.parse(raw.slice(start, cursor.index)) as string;
  }
  throw new SyntaxError('unterminated JSON string');
}

function jsonHasDuplicateObjectKeys(raw: string): boolean {
  const cursor = { index: 0 };
  let duplicate = false;
  const skipWhitespace = (): void => {
    while (/\s/u.test(raw[cursor.index] ?? '')) cursor.index += 1;
  };
  const scanValue = (): void => {
    skipWhitespace();
    const char = raw[cursor.index];
    if (char === '"') {
      scanJsonString(raw, cursor);
      return;
    }
    if (char === '{') {
      cursor.index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[cursor.index] === '}') {
        cursor.index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (raw[cursor.index] !== '"') throw new SyntaxError('JSON object key expected');
        const key = scanJsonString(raw, cursor);
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        skipWhitespace();
        if (raw[cursor.index] !== ':') throw new SyntaxError('JSON object colon expected');
        cursor.index += 1;
        scanValue();
        skipWhitespace();
        if (raw[cursor.index] === '}') {
          cursor.index += 1;
          return;
        }
        if (raw[cursor.index] !== ',') throw new SyntaxError('JSON object separator expected');
        cursor.index += 1;
      }
    }
    if (char === '[') {
      cursor.index += 1;
      skipWhitespace();
      if (raw[cursor.index] === ']') {
        cursor.index += 1;
        return;
      }
      for (;;) {
        scanValue();
        skipWhitespace();
        if (raw[cursor.index] === ']') {
          cursor.index += 1;
          return;
        }
        if (raw[cursor.index] !== ',') throw new SyntaxError('JSON array separator expected');
        cursor.index += 1;
      }
    }
    const start = cursor.index;
    while (cursor.index < raw.length && !/[\s,}\]]/u.test(raw[cursor.index]!)) cursor.index += 1;
    if (cursor.index === start) throw new SyntaxError('JSON value expected');
  };
  scanValue();
  skipWhitespace();
  if (cursor.index !== raw.length) throw new SyntaxError('unexpected JSON transport bytes');
  return duplicate;
}

function serializedEvidencePack(pack: AutonomyEvidencePack): string | null {
  if (pack.version === 3) {
    const canonical = canonicalEvidencePackJsonV3(pack);
    return canonical === null ? null : `${canonical}\n`;
  }
  return `${JSON.stringify(pack, null, 2)}\n`;
}

function parseEvidencePackTransport(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  if (jsonHasDuplicateObjectKeys(raw)) throw new SyntaxError('duplicate JSON object key');
  const record = jsonRecord(parsed);
  if (record?.['version'] === 3) {
    const canonical = canonicalEvidencePackJsonV3(parsed);
    if (canonical === null || raw !== `${canonical}\n`) {
      throw new SyntaxError('non-canonical evidence pack v3 transport');
    }
  }
  return parsed;
}

export function persistAutonomyEvidencePack(pack: AutonomyEvidencePack): boolean {
  let authority: EvidenceDirectoryAuthority | undefined;
  let fd: number | undefined;
  let temporaryPath: string | undefined;
  let destinationPath: string | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let published = false;
  let committed = false;
  try {
    if (!isAutonomyEvidencePack(pack)) return false;
    const serialized = serializedEvidencePack(pack);
    if (serialized === null || Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_FILE_BYTES) {
      return false;
    }
    authority = openEvidenceDirectoryAuthority(true);
    const dir = authority.evidence.path;
    const dest = evidencePath(pack.proposal.id);
    destinationPath = dest;
    temporaryPath = join(
      dir,
      `${pack.proposal.id}.json.${process.pid}.${randomBytes(16).toString('hex')}.tmp`,
    );
    fd = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
    temporaryIdentity = fstatSync(fd, { bigint: true });
    assureWindowsEvidencePath(temporaryPath, 'file', 'secure-created');
    const openedEmpty = fstatSync(fd, { bigint: true });
    const namedEmpty = lstatSync(temporaryPath, { bigint: true });
    if (!safeEvidenceFile(temporaryIdentity) || temporaryIdentity.size !== 0n ||
      !safeEvidenceFile(openedEmpty) || openedEmpty.size !== 0n ||
      !safeEvidenceFile(namedEmpty) || !sameIdentity(temporaryIdentity, openedEmpty) ||
      !sameFileSnapshot(openedEmpty, namedEmpty)) {
      throw new Error('unsafe evidence temporary');
    }
    refreshEvidenceDirectorySnapshot(authority.entries, authority.evidence);
    assertEvidenceDirectoryAuthority(authority, true);

    const bytes = Buffer.from(serialized, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error('evidence write made no progress');
      offset += written;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    assureWindowsEvidencePath(temporaryPath, 'file', 'inspect-existing');
    const openedWritten = fstatSync(fd, { bigint: true });
    const namedWritten = lstatSync(temporaryPath, { bigint: true });
    if (!safeEvidenceFile(openedWritten) || !safeEvidenceFile(namedWritten) ||
      !sameIdentity(temporaryIdentity, openedWritten) ||
      !sameFileSnapshot(openedWritten, namedWritten) ||
      openedWritten.size !== BigInt(bytes.length)) {
      throw new Error('evidence temporary changed while writing');
    }
    assertEvidenceDirectoryAuthority(authority, true);

    renameSync(temporaryPath, dest);
    published = true;
    assureWindowsEvidencePath(dest, 'file', 'inspect-existing');
    const installed = lstatSync(dest, { bigint: true });
    const openedInstalled = fstatSync(fd, { bigint: true });
    if (!safeEvidenceFile(installed) || !safeEvidenceFile(openedInstalled) ||
      !sameIdentity(openedWritten, installed) || openedWritten.size !== installed.size ||
      !sameFileSnapshot(installed, openedInstalled)) {
      throw new Error('published evidence identity changed');
    }
    refreshEvidenceDirectorySnapshot(authority.entries, authority.evidence);
    assertEvidenceDirectoryAuthority(authority, true);
    for (const entry of [...authority.entries].reverse()) {
      fsyncDirectory(entry.path, {
        expectedIdentity: { dev: entry.snapshot.dev, ino: entry.snapshot.ino },
      });
    }
    assureWindowsEvidencePath(dest, 'file', 'inspect-existing');
    const durableInstalled = lstatSync(dest, { bigint: true });
    const durableOpened = fstatSync(fd, { bigint: true });
    if (!safeEvidenceFile(durableInstalled) || !safeEvidenceFile(durableOpened) ||
      !sameFileSnapshot(durableInstalled, durableOpened) ||
      !sameIdentity(temporaryIdentity, durableInstalled)) {
      throw new Error('published evidence changed during directory durability');
    }
    assertEvidenceDirectoryAuthority(authority, true);
    committed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (published && !committed && fd !== undefined) {
      try {
        ftruncateSync(fd, 0);
        fsyncSync(fd);
      } catch { /* cleanup below remains exact and best effort */ }
    }
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (!committed) {
      removeExactTemporary(
        published ? destinationPath : temporaryPath,
        temporaryIdentity,
        authority,
      );
    }
    closeEvidenceDirectoryAuthority(authority);
  }
}

function isGateEvidence(value: unknown): value is AutonomyGateEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const gate = value as Record<string, unknown>;
  return typeof gate['ok'] === 'boolean' && typeof gate['detail'] === 'string';
}

export function isLiveRemoteProtectionEvidence(value: unknown): value is AutonomyRemoteProtectionEvidence {
  if (!isGateEvidence(value) || !value.ok) return false;
  const record = value as unknown as Record<string, unknown>;
  return record['live'] === true &&
    typeof record['nameWithOwner'] === 'string' && record['nameWithOwner'].length > 0 &&
    typeof record['repositoryId'] === 'string' && record['repositoryId'].length > 0 &&
    typeof record['branch'] === 'string' && record['branch'].length > 0 &&
    typeof record['baseHead'] === 'string' && /^[0-9a-f]{40}$/i.test(record['baseHead']) &&
    typeof record['observedAt'] === 'string' && Number.isFinite(Date.parse(record['observedAt'])) &&
    Array.isArray(record['requirements']) && record['requirements'].every((item) => typeof item === 'string') &&
    Array.isArray(record['requiredChecks']) && record['requiredChecks'].every((item) => typeof item === 'string') &&
    Array.isArray(record['requiredCheckBindings']) && record['requiredCheckBindings'].every((item) => {
      const binding = item !== null && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : null;
      return binding !== null && typeof binding['context'] === 'string' &&
        (binding['appId'] === null || typeof binding['appId'] === 'string');
    }) &&
    Array.isArray(record['policySources']) && record['policySources'].every((item) => item === 'classic' || item === 'ruleset') &&
    typeof record['policyHash'] === 'string' && /^[0-9a-f]{64}$/.test(record['policyHash']);
}

function isAutonomyEvidencePackLegacy(value: unknown): value is AutonomyEvidencePackLegacy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const proposal = v['proposal'];
  const diff = v['diff'];
  const gates = v['gates'];
  const verification = v['verification'];
  const policy = v['policy'];
  const proposalRecord = proposal as Record<string, unknown> | null;
  const diffRecord = diff as Record<string, unknown> | null;
  const gatesRecord = gates as Record<string, unknown> | null;
  const verificationRecord = verification as Record<string, unknown> | null;
  return (
    (v['version'] === 1 || v['version'] === 2) &&
    typeof v['generatedAt'] === 'string' &&
    proposal !== null &&
    typeof proposal === 'object' &&
    !Array.isArray(proposal) &&
    typeof proposalRecord?.['id'] === 'string' &&
    typeof proposalRecord['status'] === 'string' &&
    typeof proposalRecord['kind'] === 'string' &&
    diff !== null &&
    typeof diff === 'object' &&
    !Array.isArray(diff) &&
    Array.isArray(diffRecord?.['files']) &&
    diffRecord['files'].every((file) => typeof file === 'string') &&
    typeof diffRecord['changedLines'] === 'number' &&
    gates !== null &&
    typeof gates === 'object' &&
    !Array.isArray(gates) &&
    isGateEvidence(gatesRecord?.['authority']) &&
    isGateEvidence(gatesRecord?.['provenance']) &&
    isGateEvidence(gatesRecord?.['verification']) &&
    isGateEvidence(gatesRecord?.['risk']) &&
    isGateEvidence(gatesRecord?.['scope']) &&
    (gatesRecord?.['remoteProtection'] === undefined ||
      (v['version'] === 1
        ? isGateEvidence(gatesRecord['remoteProtection'])
        : isLiveRemoteProtectionEvidence(gatesRecord['remoteProtection']))) &&
    verification !== null &&
    typeof verification === 'object' &&
    !Array.isArray(verification) &&
    typeof verificationRecord?.['passed'] === 'boolean' &&
    typeof verificationRecord['detail'] === 'string' &&
    Array.isArray(verificationRecord['commandKinds']) &&
    verificationRecord['commandKinds'].every((kind) => typeof kind === 'string') &&
    (policy === undefined || (
      policy !== null &&
      typeof policy === 'object' &&
      !Array.isArray(policy) &&
      typeof (policy as Record<string, unknown>)['allowed'] === 'boolean' &&
      typeof (policy as Record<string, unknown>)['action'] === 'string'
    ))
  );
}

function isAutonomyEvidencePack(value: unknown): value is AutonomyEvidencePack {
  return isAutonomyEvidencePackLegacy(value) || verifyAutonomyEvidencePackV3(value).ok;
}

function timestampsAreFresh(pack: AutonomyEvidencePack, nowMs: number, maxAgeMs: number): boolean {
  const generatedMs = Date.parse(pack.generatedAt);
  const verifiedMs = Date.parse(pack.verification.verifiedAt ?? '');
  if (!Number.isFinite(generatedMs) || !Number.isFinite(verifiedMs)) return false;
  if (generatedMs > nowMs + READY_EVIDENCE_MAX_FUTURE_SKEW_MS) return false;
  if (verifiedMs > nowMs + READY_EVIDENCE_MAX_FUTURE_SKEW_MS) return false;
  if (generatedMs < nowMs - maxAgeMs || verifiedMs < nowMs - maxAgeMs) return false;
  return generatedMs + READY_EVIDENCE_MAX_FUTURE_SKEW_MS >= verifiedMs;
}

/** Fail-closed binding check for evidence used by daemon scheduling. */
export function evidencePackMatchesLiveProposal(
  pack: AutonomyEvidencePack,
  proposal: Proposal,
  opts: { nowMs?: number; maxAgeMs?: number } = {},
): boolean {
  if (pack.version !== 3 || !verifyAutonomyEvidencePackV3(pack).ok) return false;
  const verify = proposal.verifyResult;
  const currentDiffHash = hashDiff(proposal.diff ?? '');
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = typeof opts.maxAgeMs === 'number' && Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0
    ? opts.maxAgeMs
    : READY_EVIDENCE_MAX_AGE_MS;
  const requiredGates = [
    pack.gates.authority,
    pack.gates.provenance,
    pack.gates.verification,
    pack.gates.risk,
    pack.gates.scope,
    pack.gates.manager,
    pack.gates.selfTarget,
    pack.gates.edv,
    pack.gates.remoteProtection,
  ].filter((gate): gate is AutonomyGateEvidence => gate !== undefined);

  return (
    proposal.status === 'pending' &&
    pack.proposal.id === proposal.id &&
    pack.proposal.status === 'pending' &&
    pack.proposal.repo === proposal.repo &&
    pack.proposal.kind === proposal.kind &&
    pack.proposal.origin === proposal.origin &&
    pack.proposal.createdAt === proposal.createdAt &&
    pack.producer.engineModel === proposal.engineModel &&
    pack.producer.engineTier === proposal.engineTier &&
    pack.target === 'main' &&
    pack.trustBasis === 'evidence' &&
    pack.policy?.allowed === true &&
    pack.policy.action === 'merge-main' &&
    pack.verification.passed === true &&
    pack.verification.commandKinds.length > 0 &&
    (pack.trustBasis !== 'evidence' || isLiveRemoteProtectionEvidence(pack.gates.remoteProtection)) &&
    requiredGates.every((gate) => gate.ok) &&
    typeof proposal.diffHash === 'string' &&
    proposal.diffHash === currentDiffHash &&
    pack.diff.hash === currentDiffHash &&
    pack.verification.diffHash === currentDiffHash &&
    verify?.passed === true &&
    verify.diffHash === currentDiffHash &&
    typeof verify.baseBranch === 'string' &&
    verify.baseBranch.length > 0 &&
    pack.verification.baseBranch === verify.baseBranch &&
    typeof verify.baseHead === 'string' &&
    verify.baseHead.length > 0 &&
    pack.verification.baseHead === verify.baseHead &&
    verifierAuthorityBindingsMatch(pack.verification, verify) &&
    typeof verify.source === 'string' &&
    verify.source.length > 0 &&
    pack.verification.source === verify.source &&
    pack.verification.verifiedAt === verify.verifiedAt &&
    timestampsAreFresh(pack, nowMs, maxAgeMs)
  );
}

export function readAutonomyEvidencePack(proposalId: string): AutonomyEvidencePack | null {
  const result = readAutonomyEvidencePacksDetailed(MAX_EVIDENCE_FILES);
  if (result.sourceState !== 'healthy' || !result.complete) return null;
  return result.packs.find((pack) => pack.proposal.id === proposalId) ?? null;
}

function emptyEvidenceRead(
  sourceState: AutonomyEvidenceSourceQuality['sourceState'],
  overrides: Partial<AutonomyEvidencePacksReadResult> = {},
): AutonomyEvidencePacksReadResult {
  return {
    packs: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
    limitExceeded: false,
    ...overrides,
  };
}

type StableEvidenceRead =
  | { state: 'ok'; raw: string; bytes: number }
  | { state: 'invalid' }
  | { state: 'unreadable' }
  | { state: 'limit-exceeded' };

function readStableEvidenceFile(
  path: string,
  remainingBytes: number,
  authority: EvidenceDirectoryAuthority,
): StableEvidenceRead {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path, { bigint: true });
    if (!safeEvidenceFile(pathBefore) || pathBefore.size > BigInt(MAX_EVIDENCE_FILE_BYTES)) {
      return { state: 'invalid' };
    }
    if (pathBefore.size > BigInt(remainingBytes)) return { state: 'limit-exceeded' };
    assertEvidenceDirectoryAuthority(authority, true);
    assureWindowsEvidencePath(path, 'file', 'inspect-existing');
    const pathAssured = lstatSync(path, { bigint: true });
    if (!safeEvidenceFile(pathAssured) || !sameFileSnapshot(pathBefore, pathAssured)) {
      return { state: 'invalid' };
    }

    fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!safeEvidenceFile(openedBefore) || !sameFileSnapshot(pathAssured, openedBefore)) {
      return { state: 'invalid' };
    }
    const size = Number(openedBefore.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const pathAfterBeforeAssurance = lstatSync(path, { bigint: true });
    assureWindowsEvidencePath(path, 'file', 'inspect-existing');
    const pathAfter = lstatSync(path, { bigint: true });
    assertEvidenceDirectoryAuthority(authority, true);
    if (offset !== size || !safeEvidenceFile(openedAfter) || !safeEvidenceFile(pathAfter) ||
      !sameFileSnapshot(pathAfterBeforeAssurance, pathAfter) ||
      !sameFileSnapshot(openedBefore, openedAfter) ||
      !sameFileSnapshot(openedAfter, pathAfter)) {
      return { state: 'invalid' };
    }
    return {
      state: 'ok',
      raw: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      bytes: size,
    };
  } catch {
    return { state: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* read health already fails closed */ }
    }
  }
}

export function readAutonomyEvidencePacksDetailed(limit = 50): AutonomyEvidencePacksReadResult {
  let authority: EvidenceDirectoryAuthority | undefined;
  try {
    const dir = evidenceDir();
    if (!existsSync(dir)) return emptyEvidenceRead('missing');
    authority = openEvidenceDirectoryAuthority(false);
    assertEvidenceDirectoryAuthority(authority, true);
    const files: string[] = [];
    const handle = opendirSync(dir);
    try {
      let physicalEntries = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physicalEntries++;
        if (physicalEntries > MAX_EVIDENCE_FILES) {
          return emptyEvidenceRead('degraded', { complete: false, limitExceeded: true });
        }
        if (entry.name.endsWith('.json')) files.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    assertEvidenceDirectoryAuthority(authority, true);
    files.sort().reverse();
    const result = emptyEvidenceRead('healthy', { sourcePresent: true });
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    const proposalIds = new Set<string>();
    for (const file of files) {
      const loaded = readStableEvidenceFile(
        join(dir, file),
        MAX_EVIDENCE_BYTES - result.bytesRead,
        authority,
      );
      if (loaded.state === 'limit-exceeded') {
        result.limitExceeded = true;
        result.complete = false;
        break;
      }
      if (loaded.state === 'unreadable') {
        result.unreadableFiles++;
        continue;
      }
      if (loaded.state === 'invalid') {
        result.invalidFiles++;
        continue;
      }
      result.bytesRead += loaded.bytes;
      result.filesRead++;
      try {
        const parsed = parseEvidencePackTransport(loaded.raw);
        if (
          isAutonomyEvidencePack(parsed) &&
          file === `${parsed.proposal.id}.json` &&
          !proposalIds.has(parsed.proposal.id)
        ) {
          proposalIds.add(parsed.proposal.id);
          result.packs.push(parsed);
        } else result.invalidFiles++;
      } catch {
        result.invalidFiles++;
      }
    }
    assertEvidenceDirectoryAuthority(authority, true);
    if (result.invalidFiles > 0 || result.unreadableFiles > 0 || !result.complete) {
      result.sourceState = 'degraded';
      result.complete = false;
    }
    result.packs.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
    result.packs = result.packs.slice(0, cap);
    return result;
  } catch {
    return emptyEvidenceRead('degraded', { complete: false, unreadableFiles: 1 });
  } finally {
    closeEvidenceDirectoryAuthority(authority);
  }
}

export function listAutonomyEvidencePacks(limit = 50): AutonomyEvidencePackList {
  const result = readAutonomyEvidencePacksDetailed(limit);
  const packs = result.packs as AutonomyEvidencePackList;
  Object.defineProperty(packs, 'sourceQuality', {
    value: {
      sourceState: result.sourceState,
      sourcePresent: result.sourcePresent,
      complete: result.complete,
      filesRead: result.filesRead,
      bytesRead: result.bytesRead,
      invalidFiles: result.invalidFiles,
      unreadableFiles: result.unreadableFiles,
      limitExceeded: result.limitExceeded,
    } satisfies AutonomyEvidenceSourceQuality,
    enumerable: false,
  });
  return packs;
}
