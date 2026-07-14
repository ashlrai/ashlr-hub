import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath, assurePrivateStoragePaths } from '../util/private-storage.js';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
} from './local-store-lock.js';

const SCHEMA_VERSION = 1 as const;
const RECORD_DOMAIN = 'ashlr:automerge-canary-revision:v1';
const SUMMARY_DOMAIN = 'ashlr:automerge-canary-terminal-summary:v1';
const OBSERVATION_DOMAIN = 'ashlr:automerge-canary-observer:observation:v1';
const ZERO_ATTESTATION = '0'.repeat(64);
const SHA256_RE = /^[a-f0-9]{64}$/;
const OID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BLOCKER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const REVISION_NAME_RE = /^\.epoch-v1-([0-9a-f-]{36})-(\d{4})\.json$/;
const SUMMARY_NAME_RE = /^\.terminal-v1-(\d{4})-([0-9a-f-]{36})\.json$/;
const PUBLICATION_CANDIDATE_RE = /^\.controller-publish-v1-[0-9a-f-]{36}\.candidate$/;
const SIGNING_KEY_NAME = '.controller-signing.key';
const SIGNING_KEY_BYTES = 32;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_SUMMARY_BYTES = 2 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_256;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_SHADOW_FILES = 1_024;
const MAX_SHADOW_LINES = 100_000;
const LOCK_WAIT_MS = 2_000;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const O_DIRECTORY = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;

export const AUTOMERGE_CANARY_ENFORCE_SUPPORTED = false as const;
export const AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH = 64;
export const AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS = 32;

export type AutoMergeCanaryShadowState = 'shadow' | 'halt-requested' | 'halted';

export interface AutoMergeCanaryRepositoryV1 {
  repositoryId: string;
  fetchDestinationDigest: string;
  pushDestinationDigest: string;
  baseRefDigest: string;
  baseOid: string;
  headOid: string;
}

export interface AutoMergeCanaryBudgetsV1 {
  maxAdmissions: number;
  maxMerges: number;
  maxInFlight: number;
  minMergeIntervalMs: number;
  leaseDurationMs: number;
  observationDurationMs: number;
}

export interface AutoMergeCanaryCountersV1 {
  admissions: number;
  merges: number;
  inFlight: number;
  rollbacks: number;
}

export interface AutoMergeCanaryShadowCountersV1 {
  attempts: number;
  eligible: number;
  rejected: number;
  bindingMismatches: number;
  inspectionErrors: number;
  casRetries: number;
}

export type AutoMergeCanaryShadowOutcome =
  | 'eligible'
  | 'rejected'
  | 'binding-mismatch'
  | 'inspection-error';

export type AutoMergeCanaryShadowMismatchField =
  | 'repositoryId'
  | 'fetchDestinationDigest'
  | 'pushDestinationDigest'
  | 'baseRefDigest'
  | 'baseOid'
  | 'headOid'
  | 'policyDigest'
  | 'configDigest'
  | 'classifierDigest'
  | 'pathDigest';

export interface AutoMergeCanaryShadowEvidenceV1 {
  observationDigest: string;
  observedAt: string;
  outcome: AutoMergeCanaryShadowOutcome;
  mismatchFields: AutoMergeCanaryShadowMismatchField[];
  repositoryId: string;
  fetchDestinationDigest: string;
  pushDestinationDigest: string;
  baseRefDigest: string;
  baseOid: string | null;
  headOid: string | null;
  policyDigest: string;
  configDigest: string;
  classifierDigest: string;
  treeOid: string | null;
  fileCount: number;
  lineCount: number;
  reasonDigest: string;
  pathDigest: string | null;
}

export interface AutoMergeCanaryShadowObservationInput extends AutoMergeCanaryShadowEvidenceV1 {
  /** One observer may report the single CAS retry that preceded this successful append. */
  casRetries: 0 | 1;
}

export interface AutoMergeCanaryLeaseV1 {
  holderDigest: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
}

export interface AutoMergeCanaryObservationV1 {
  startedAt: string | null;
  deadlineAt: string | null;
  completedAt: string | null;
}

export interface AutoMergeCanaryPendingEffectV1 {
  kind: 'shadow-observation' | 'halt-shadow';
  effectDigest: string;
  requestedAt: string;
}

export interface AutoMergeCanaryBlockerV1 {
  code: string;
  severity: 'warning' | 'critical';
  since: string;
}

export interface AutoMergeCanaryStateV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  epochId: string;
  revision: number;
  previousAttestation: string;
  mode: 'shadow';
  state: AutoMergeCanaryShadowState;
  repository: AutoMergeCanaryRepositoryV1;
  policyDigest: string;
  configDigest: string;
  classifierDigest: string;
  pathDigest: string;
  budgets: AutoMergeCanaryBudgetsV1;
  counters: AutoMergeCanaryCountersV1;
  shadowCounters: AutoMergeCanaryShadowCountersV1;
  lastShadowEvidence: AutoMergeCanaryShadowEvidenceV1 | null;
  lease: AutoMergeCanaryLeaseV1;
  observation: AutoMergeCanaryObservationV1;
  activatedAt: string;
  updatedAt: string;
  clockHighWater: string;
  pendingEffect: AutoMergeCanaryPendingEffectV1 | null;
  blocker: AutoMergeCanaryBlockerV1 | null;
  attestation: string;
}

export interface AutoMergeCanaryTerminalSummaryV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  recordType: 'automerge-canary-terminal';
  sequence: number;
  epochId: string;
  terminalRevision: number;
  terminalState: 'halted';
  activatedAt: string;
  terminalAt: string;
  terminalAttestation: string;
  previousSummaryAttestation: string;
  attestation: string;
}

export interface AutoMergeCanaryActivationInput {
  mode?: 'shadow' | 'enforce';
  repository: AutoMergeCanaryRepositoryV1;
  policyDigest: string;
  configDigest: string;
  classifierDigest: string;
  pathDigest: string;
  budgets: AutoMergeCanaryBudgetsV1;
}

export interface AutoMergeCanaryCas {
  epochId: string;
  revision: number;
  attestation: string;
}

export interface AutoMergeCanaryRevisionUpdate {
  state?: AutoMergeCanaryShadowState;
  counters?: AutoMergeCanaryCountersV1;
  lease?: AutoMergeCanaryLeaseV1;
  observation?: AutoMergeCanaryObservationV1;
  pendingEffect?: AutoMergeCanaryPendingEffectV1 | null;
  blocker?: AutoMergeCanaryBlockerV1 | null;
}

export type AutoMergeCanaryDiagnostic =
  | 'storage-unsafe'
  | 'key-unavailable'
  | 'invalid-record'
  | 'invalid-summary'
  | 'revision-conflict'
  | 'revision-gap'
  | 'chain-broken'
  | 'epoch-conflict'
  | 'terminal-conflict'
  | 'future-time'
  | 'lease-expired'
  | 'observation-overdue'
  | 'capacity-exceeded';

export interface AutoMergeCanaryReadResult {
  enforceSupported: false;
  sourceState: 'missing' | 'healthy' | 'degraded';
  severity: 'none' | 'critical';
  status: 'inactive' | 'shadow' | 'halt-requested' | 'halted' | 'critical';
  active: boolean;
  state: AutoMergeCanaryStateV1 | null;
  revisions: AutoMergeCanaryStateV1[];
  terminalEpochs: AutoMergeCanaryTerminalSummaryV1[];
  diagnostics: AutoMergeCanaryDiagnostic[];
  limitExceeded: boolean;
}

export type AutoMergeCanaryWriteResult =
  | { ok: true; state: AutoMergeCanaryStateV1; clockRollbackDetected: boolean }
  | { ok: false; reason: 'enforce-unsupported' | 'invalid' | 'conflict' | 'capacity' | 'degraded' | 'unavailable' };

interface StoreDirectory {
  path: string;
  dev: number;
  ino: number;
}

interface StableBytes {
  bytes: Buffer;
  dev: number;
  ino: number;
}

interface ReadOptions {
  now?: Date;
}

interface WriteOptions extends ReadOptions {
  epochId?: string;
}

const RECORD_KEYS = [
  'activatedAt', 'attestation', 'blocker', 'budgets', 'classifierDigest', 'clockHighWater',
  'configDigest', 'counters', 'epochId', 'lastShadowEvidence', 'lease', 'mode', 'observation',
  'pathDigest', 'pendingEffect', 'policyDigest', 'previousAttestation', 'repository', 'revision',
  'schemaVersion', 'shadowCounters', 'state', 'updatedAt',
].sort();
const REPOSITORY_KEYS = [
  'baseOid', 'baseRefDigest', 'fetchDestinationDigest', 'headOid', 'pushDestinationDigest',
  'repositoryId',
].sort();
const BUDGET_KEYS = [
  'leaseDurationMs', 'maxAdmissions', 'maxInFlight', 'maxMerges', 'minMergeIntervalMs',
  'observationDurationMs',
].sort();
const COUNTER_KEYS = ['admissions', 'inFlight', 'merges', 'rollbacks'].sort();
const SHADOW_COUNTER_KEYS = [
  'attempts', 'bindingMismatches', 'casRetries', 'eligible', 'inspectionErrors', 'rejected',
].sort();
const SHADOW_EVIDENCE_KEYS = [
  'baseOid', 'baseRefDigest', 'classifierDigest', 'configDigest', 'fetchDestinationDigest',
  'fileCount', 'headOid', 'lineCount', 'mismatchFields', 'observationDigest', 'observedAt',
  'outcome', 'pathDigest', 'policyDigest', 'pushDestinationDigest', 'reasonDigest',
  'repositoryId', 'treeOid',
].sort();
const SHADOW_OBSERVATION_INPUT_KEYS = [...SHADOW_EVIDENCE_KEYS, 'casRetries'].sort();
const SHADOW_MISMATCH_FIELDS: AutoMergeCanaryShadowMismatchField[] = [
  'repositoryId', 'fetchDestinationDigest', 'pushDestinationDigest', 'baseRefDigest',
  'baseOid', 'headOid', 'policyDigest', 'configDigest', 'classifierDigest', 'pathDigest',
];
const LEASE_KEYS = ['acquiredAt', 'expiresAt', 'holderDigest'].sort();
const OBSERVATION_KEYS = ['completedAt', 'deadlineAt', 'startedAt'].sort();
const PENDING_KEYS = ['effectDigest', 'kind', 'requestedAt'].sort();
const BLOCKER_KEYS = ['code', 'severity', 'since'].sort();
const SUMMARY_KEYS = [
  'activatedAt', 'attestation', 'epochId', 'previousSummaryAttestation', 'recordType',
  'schemaVersion', 'sequence', 'terminalAt', 'terminalAttestation', 'terminalRevision',
  'terminalState',
].sort();
const UPDATE_KEYS = ['blocker', 'counters', 'lease', 'observation', 'pendingEffect', 'state'].sort();

function stateRoot(): string {
  const configured = process.env.ASHLR_HOME;
  if (configured === undefined) return resolve(join(homedir(), '.ashlr'));
  if (configured.length === 0 || configured.length > 1_024 ||
    [...configured].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    !isAbsolute(configured) || resolve(configured) !== configured) {
    throw new Error('ASHLR_HOME must be canonical and absolute');
  }
  return configured;
}

export function automergeCanaryStoreDirectory(): string {
  return join(stateRoot(), 'fleet', 'automerge-canary');
}

export function automergeCanaryStoreLockPath(): string {
  return join(automergeCanaryStoreDirectory(), '.controller.lock');
}

export function automergeCanarySigningKeyPath(): string {
  return join(automergeCanaryStoreDirectory(), SIGNING_KEY_NAME);
}

function owned(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function privateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privatePublicationFile(stat: Stats, links: 1 | 2): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === links && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return sameNode(left, right) && left.size === right.size && left.mode === right.mode &&
    left.uid === right.uid && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === expected.join(',');
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function equalDigest(left: string, right: string): boolean {
  if (!digest(left) || !digest(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(domain: string, value: unknown, key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function unsignedState(state: AutoMergeCanaryStateV1): Omit<AutoMergeCanaryStateV1, 'attestation'> {
  const { attestation: _attestation, ...unsigned } = state;
  return unsigned;
}

function unsignedSummary(
  summary: AutoMergeCanaryTerminalSummaryV1,
): Omit<AutoMergeCanaryTerminalSummaryV1, 'attestation'> {
  const { attestation: _attestation, ...unsigned } = summary;
  return unsigned;
}

function strictRepository(value: unknown): value is AutoMergeCanaryRepositoryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, REPOSITORY_KEYS) && digest(row['repositoryId']) &&
    digest(row['fetchDestinationDigest']) && digest(row['pushDestinationDigest']) &&
    digest(row['baseRefDigest']) && typeof row['baseOid'] === 'string' && OID_RE.test(row['baseOid']) &&
    typeof row['headOid'] === 'string' && OID_RE.test(row['headOid']);
}

function strictBudgets(value: unknown): value is AutoMergeCanaryBudgetsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, BUDGET_KEYS) && safeInteger(row['maxAdmissions'], 64) &&
    safeInteger(row['maxMerges'], 64) && safeInteger(row['maxInFlight'], 64) &&
    Number(row['maxAdmissions']) > 0 && Number(row['maxMerges']) > 0 && Number(row['maxInFlight']) > 0 &&
    safeInteger(row['minMergeIntervalMs'], MAX_DURATION_MS) &&
    safeInteger(row['leaseDurationMs'], MAX_DURATION_MS) && Number(row['leaseDurationMs']) > 0 &&
    safeInteger(row['observationDurationMs'], MAX_DURATION_MS) && Number(row['observationDurationMs']) > 0;
}

function strictCounters(value: unknown, budgets: AutoMergeCanaryBudgetsV1): value is AutoMergeCanaryCountersV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, COUNTER_KEYS) && safeInteger(row['admissions'], budgets.maxAdmissions) &&
    safeInteger(row['merges'], budgets.maxMerges) && safeInteger(row['inFlight'], budgets.maxInFlight) &&
    safeInteger(row['rollbacks'], budgets.maxMerges) &&
    Number(row['merges']) + Number(row['inFlight']) <= Number(row['admissions']) &&
    Number(row['rollbacks']) <= Number(row['merges']);
}

function strictShadowCounters(value: unknown): value is AutoMergeCanaryShadowCountersV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, SHADOW_COUNTER_KEYS) ||
    !safeInteger(row['attempts'], AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) ||
    !safeInteger(row['eligible'], AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) ||
    !safeInteger(row['rejected'], AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) ||
    !safeInteger(row['bindingMismatches'], AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) ||
    !safeInteger(row['inspectionErrors'], AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) ||
    !safeInteger(row['casRetries'], AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH)) return false;
  return Number(row['attempts']) === Number(row['eligible']) + Number(row['rejected']) +
    Number(row['bindingMismatches']) + Number(row['inspectionErrors']) &&
    Number(row['casRetries']) <= Number(row['attempts']);
}

function zeroShadowCounters(counters: AutoMergeCanaryShadowCountersV1): boolean {
  return counters.attempts === 0 && counters.eligible === 0 && counters.rejected === 0 &&
    counters.bindingMismatches === 0 && counters.inspectionErrors === 0 && counters.casRetries === 0;
}

function outcomeCount(
  counters: AutoMergeCanaryShadowCountersV1,
  outcome: AutoMergeCanaryShadowOutcome,
): number {
  if (outcome === 'eligible') return counters.eligible;
  if (outcome === 'rejected') return counters.rejected;
  if (outcome === 'binding-mismatch') return counters.bindingMismatches;
  return counters.inspectionErrors;
}

function nullableOid(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && OID_RE.test(value));
}

function strictShadowEvidence(
  value: unknown,
  expected: AutoMergeCanaryStateV1,
): value is AutoMergeCanaryShadowEvidenceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, SHADOW_EVIDENCE_KEYS) || !digest(row['observationDigest']) ||
    !canonicalTimestamp(row['observedAt']) ||
    (row['outcome'] !== 'eligible' && row['outcome'] !== 'rejected' &&
      row['outcome'] !== 'binding-mismatch' && row['outcome'] !== 'inspection-error') ||
    !Array.isArray(row['mismatchFields']) || !digest(row['repositoryId']) ||
    !digest(row['fetchDestinationDigest']) || !digest(row['pushDestinationDigest']) ||
    !digest(row['baseRefDigest']) || !nullableOid(row['baseOid']) ||
    !nullableOid(row['headOid']) || !nullableOid(row['treeOid']) ||
    !digest(row['policyDigest']) || !digest(row['configDigest']) || !digest(row['classifierDigest']) ||
    !safeInteger(row['fileCount'], MAX_SHADOW_FILES) ||
    !safeInteger(row['lineCount'], MAX_SHADOW_LINES) ||
    !digest(row['reasonDigest']) || (row['pathDigest'] !== null && !digest(row['pathDigest']))) return false;
  const mismatchFields = row['mismatchFields'];
  if (mismatchFields.some((field) => !SHADOW_MISMATCH_FIELDS.includes(
    field as AutoMergeCanaryShadowMismatchField,
  )) || new Set(mismatchFields).size !== mismatchFields.length) return false;
  const canonicalMismatchFields = SHADOW_MISMATCH_FIELDS.filter((field) => mismatchFields.includes(field));
  if (JSON.stringify(mismatchFields) !== JSON.stringify(canonicalMismatchFields)) return false;
  const expectedBindings = {
    ...expected.repository,
    policyDigest: expected.policyDigest,
    configDigest: expected.configDigest,
    classifierDigest: expected.classifierDigest,
    pathDigest: expected.pathDigest,
  };
  const actualBindings = {
    repositoryId: row['repositoryId'],
    fetchDestinationDigest: row['fetchDestinationDigest'],
    pushDestinationDigest: row['pushDestinationDigest'],
    baseRefDigest: row['baseRefDigest'],
    baseOid: row['baseOid'],
    headOid: row['headOid'],
    policyDigest: row['policyDigest'],
    configDigest: row['configDigest'],
    classifierDigest: row['classifierDigest'],
    pathDigest: row['pathDigest'],
  };
  const actualMismatchFields = SHADOW_MISMATCH_FIELDS.filter((field) =>
    actualBindings[field] !== null && actualBindings[field] !== expectedBindings[field]);
  if (JSON.stringify(mismatchFields) !== JSON.stringify(actualMismatchFields)) return false;
  const inspectionError = row['outcome'] === 'inspection-error';
  if (inspectionError) {
    if (row['baseOid'] !== null || row['headOid'] !== null || row['treeOid'] !== null ||
      row['pathDigest'] !== null || Number(row['fileCount']) !== 0 || Number(row['lineCount']) !== 0) return false;
  } else if (row['baseOid'] === null || row['headOid'] === null || row['pathDigest'] === null ||
    (row['outcome'] === 'binding-mismatch') !== (mismatchFields.length > 0)) return false;
  const oidLengths = [row['baseOid'], row['headOid'], row['treeOid']]
    .filter((oid): oid is string => typeof oid === 'string')
    .map((oid) => oid.length);
  return oidLengths.every((length) => length === expected.repository.baseOid.length) &&
    (row['outcome'] !== 'eligible' || (row['treeOid'] !== null &&
      Number(row['fileCount']) > 0 && Number(row['lineCount']) > 0));
}

function strictLastShadowEvidence(
  value: unknown,
  expected: AutoMergeCanaryStateV1,
): value is AutoMergeCanaryShadowEvidenceV1 | null {
  return value === null || strictShadowEvidence(value, expected);
}

function strictLease(value: unknown): value is AutoMergeCanaryLeaseV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, LEASE_KEYS)) return false;
  const allNull = row['holderDigest'] === null && row['acquiredAt'] === null && row['expiresAt'] === null;
  const allPresent = digest(row['holderDigest']) && canonicalTimestamp(row['acquiredAt']) &&
    canonicalTimestamp(row['expiresAt']) && Date.parse(row['expiresAt']) > Date.parse(row['acquiredAt']);
  return allNull || allPresent;
}

function strictObservation(value: unknown): value is AutoMergeCanaryObservationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, OBSERVATION_KEYS)) return false;
  if (row['startedAt'] === null || row['deadlineAt'] === null) {
    return row['startedAt'] === null && row['deadlineAt'] === null && row['completedAt'] === null;
  }
  if (!canonicalTimestamp(row['startedAt']) || !canonicalTimestamp(row['deadlineAt']) ||
    Date.parse(row['deadlineAt']) <= Date.parse(row['startedAt'])) return false;
  return row['completedAt'] === null || (canonicalTimestamp(row['completedAt']) &&
    Date.parse(row['completedAt']) >= Date.parse(row['startedAt']) &&
    Date.parse(row['completedAt']) <= Date.parse(row['deadlineAt']));
}

function nullLease(lease: AutoMergeCanaryLeaseV1): boolean {
  return lease.holderDigest === null && lease.acquiredAt === null && lease.expiresAt === null;
}

function strictPendingEffect(value: unknown): value is AutoMergeCanaryPendingEffectV1 | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, PENDING_KEYS) &&
    (row['kind'] === 'shadow-observation' || row['kind'] === 'halt-shadow') &&
    digest(row['effectDigest']) && canonicalTimestamp(row['requestedAt']);
}

function strictBlocker(value: unknown): value is AutoMergeCanaryBlockerV1 | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, BLOCKER_KEYS) && typeof row['code'] === 'string' && BLOCKER_RE.test(row['code']) &&
    (row['severity'] === 'warning' || row['severity'] === 'critical') && canonicalTimestamp(row['since']);
}

function strictState(value: unknown, key: Buffer): AutoMergeCanaryStateV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, RECORD_KEYS) || row['schemaVersion'] !== SCHEMA_VERSION ||
    typeof row['epochId'] !== 'string' || !UUID_RE.test(row['epochId']) ||
    !safeInteger(row['revision'], AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) || Number(row['revision']) < 1 ||
    typeof row['previousAttestation'] !== 'string' || !digest(row['previousAttestation']) ||
    row['mode'] !== 'shadow' ||
    (row['state'] !== 'shadow' && row['state'] !== 'halt-requested' && row['state'] !== 'halted') ||
    !strictRepository(row['repository']) || !digest(row['policyDigest']) || !digest(row['configDigest']) ||
    !digest(row['classifierDigest']) || !digest(row['pathDigest']) || !strictBudgets(row['budgets']) ||
    !strictCounters(row['counters'], row['budgets']) || !strictShadowCounters(row['shadowCounters']) ||
    !strictLease(row['lease']) ||
    !strictObservation(row['observation']) || !canonicalTimestamp(row['activatedAt']) ||
    !canonicalTimestamp(row['updatedAt']) || !canonicalTimestamp(row['clockHighWater']) ||
    !strictPendingEffect(row['pendingEffect']) || !strictBlocker(row['blocker']) ||
    typeof row['attestation'] !== 'string' || !digest(row['attestation'])) return null;
  const state = row as unknown as AutoMergeCanaryStateV1;
  if (!strictLastShadowEvidence(state.lastShadowEvidence, state)) return null;
  const activated = Date.parse(state.activatedAt);
  const updated = Date.parse(state.updatedAt);
  const highWater = Date.parse(state.clockHighWater);
  const leaseAcquired = state.lease.acquiredAt === null ? null : Date.parse(state.lease.acquiredAt);
  const leaseExpires = state.lease.expiresAt === null ? null : Date.parse(state.lease.expiresAt);
  const observationStarted = state.observation.startedAt === null
    ? null
    : Date.parse(state.observation.startedAt);
  const observationDeadline = state.observation.deadlineAt === null
    ? null
    : Date.parse(state.observation.deadlineAt);
  const observationCompleted = state.observation.completedAt === null
    ? null
    : Date.parse(state.observation.completedAt);
  const shadowObserved = state.lastShadowEvidence === null
    ? null
    : Date.parse(state.lastShadowEvidence.observedAt);
  if (activated > updated || updated > highWater ||
    observationStarted === null || observationDeadline === null ||
    state.observation.startedAt !== state.activatedAt ||
    observationDeadline - observationStarted !== state.budgets.observationDurationMs ||
    (state.revision === AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH && state.state !== 'halted') ||
    (state.revision === 1 && state.previousAttestation !== ZERO_ATTESTATION) ||
    (state.revision > 1 && state.previousAttestation === ZERO_ATTESTATION) ||
    (leaseAcquired !== null && (leaseAcquired < activated || leaseAcquired > updated)) ||
    (leaseAcquired !== null && leaseExpires! - leaseAcquired > state.budgets.leaseDurationMs) ||
    (observationStarted !== null && (observationStarted < activated || observationStarted > updated)) ||
    (observationStarted !== null &&
      observationDeadline! - observationStarted > state.budgets.observationDurationMs) ||
    (observationCompleted !== null && observationCompleted > updated) ||
    (state.pendingEffect !== null && (Date.parse(state.pendingEffect.requestedAt) < activated ||
      Date.parse(state.pendingEffect.requestedAt) > updated)) ||
    (state.blocker !== null && (Date.parse(state.blocker.since) < activated ||
      Date.parse(state.blocker.since) > updated)) ||
    state.shadowCounters.attempts > state.revision - 1 ||
    (state.revision === 1 && !zeroShadowCounters(state.shadowCounters)) ||
    (state.shadowCounters.attempts === 0) !== (state.lastShadowEvidence === null) ||
    (state.lastShadowEvidence !== null &&
      outcomeCount(state.shadowCounters, state.lastShadowEvidence.outcome) < 1) ||
    (shadowObserved !== null && (shadowObserved < activated || shadowObserved > updated)) ||
    (state.state === 'halted' && (state.counters.inFlight !== 0 || !nullLease(state.lease) ||
      state.pendingEffect !== null))) return null;
  const expected = sign(RECORD_DOMAIN, unsignedState(state), key);
  return equalDigest(expected, state.attestation) ? state : null;
}

function validShadowTransition(
  previous: AutoMergeCanaryStateV1,
  current: AutoMergeCanaryStateV1,
): boolean {
  const attemptDelta = current.shadowCounters.attempts - previous.shadowCounters.attempts;
  if (attemptDelta === 0) {
    return JSON.stringify(current.shadowCounters) === JSON.stringify(previous.shadowCounters) &&
      JSON.stringify(current.lastShadowEvidence) === JSON.stringify(previous.lastShadowEvidence);
  }
  if (attemptDelta !== 1 || current.lastShadowEvidence === null ||
    previous.lastShadowEvidence?.observationDigest === current.lastShadowEvidence.observationDigest) return false;
  const outcomeDeltas = {
    eligible: current.shadowCounters.eligible - previous.shadowCounters.eligible,
    rejected: current.shadowCounters.rejected - previous.shadowCounters.rejected,
    'binding-mismatch': current.shadowCounters.bindingMismatches - previous.shadowCounters.bindingMismatches,
    'inspection-error': current.shadowCounters.inspectionErrors - previous.shadowCounters.inspectionErrors,
  } satisfies Record<AutoMergeCanaryShadowOutcome, number>;
  return Object.entries(outcomeDeltas).every(([outcome, delta]) =>
    delta === (outcome === current.lastShadowEvidence!.outcome ? 1 : 0)) &&
    current.shadowCounters.casRetries - previous.shadowCounters.casRetries >= 0 &&
    current.shadowCounters.casRetries - previous.shadowCounters.casRetries <= 1 &&
    (previous.lastShadowEvidence === null ||
      Date.parse(current.lastShadowEvidence.observedAt) >= Date.parse(previous.lastShadowEvidence.observedAt));
}

function strictSummary(value: unknown, key: Buffer): AutoMergeCanaryTerminalSummaryV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, SUMMARY_KEYS) || row['schemaVersion'] !== SCHEMA_VERSION ||
    row['recordType'] !== 'automerge-canary-terminal' ||
    !safeInteger(row['sequence'], AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS) || Number(row['sequence']) < 1 ||
    typeof row['epochId'] !== 'string' || !UUID_RE.test(row['epochId']) ||
    !safeInteger(row['terminalRevision'], AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) ||
    Number(row['terminalRevision']) < 1 || row['terminalState'] !== 'halted' ||
    !canonicalTimestamp(row['activatedAt']) || !canonicalTimestamp(row['terminalAt']) ||
    Date.parse(row['terminalAt']) < Date.parse(row['activatedAt']) ||
    typeof row['terminalAttestation'] !== 'string' || !digest(row['terminalAttestation']) ||
    typeof row['previousSummaryAttestation'] !== 'string' || !digest(row['previousSummaryAttestation']) ||
    typeof row['attestation'] !== 'string' || !digest(row['attestation'])) return null;
  const summary = row as unknown as AutoMergeCanaryTerminalSummaryV1;
  const expected = sign(SUMMARY_DOMAIN, unsignedSummary(summary), key);
  return equalDigest(expected, summary.attestation) ? summary : null;
}

function readStoreDirectory(): StoreDirectory | 'missing' | 'invalid' {
  let fd: number | undefined;
  try {
    const path = automergeCanaryStoreDirectory();
    const named = lstatSync(path);
    if (!privateDirectory(named)) return 'invalid';
    if (!assurePrivateStoragePath(path, 'directory', 'inspect-owned', { anchorPath: stateRoot() }).ok) {
      return 'invalid';
    }
    fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (!privateDirectory(opened) || !privateDirectory(current) || !sameNode(named, opened) ||
      !sameNode(opened, current)) return 'invalid';
    return { path, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* read-only close */ }
  }
}

function directoryStable(directory: StoreDirectory): boolean {
  try {
    const stat = lstatSync(directory.path);
    return privateDirectory(stat) && stat.dev === directory.dev && stat.ino === directory.ino;
  } catch { return false; }
}

function recoverablePublicationPair(path: string, named: Stats, directory: StoreDirectory): boolean {
  try {
    if (!privatePublicationFile(named, 2) || !canonicalAuthorityName(basename(path)) ||
      !directoryStable(directory)) return false;
    const names = readdirSync(directory.path);
    if (names.length > MAX_DIRECTORY_ENTRIES) return false;
    const partners = names.filter((name) => {
      if (!PUBLICATION_CANDIDATE_RE.test(name)) return false;
      const candidate = lstatSync(join(directory.path, name));
      return privatePublicationFile(candidate, 2) && sameSnapshot(named, candidate);
    });
    return partners.length === 1 && directoryStable(directory);
  } catch { return false; }
}

function readablePrivateFile(path: string, stat: Stats, directory: StoreDirectory): boolean {
  return privateFile(stat) || recoverablePublicationPair(path, stat, directory);
}

function readPrivateBytes(
  path: string,
  directory: StoreDirectory,
  maxBytes: number,
): StableBytes | 'absent' | 'invalid' {
  let fd: number | undefined;
  try {
    if (!directoryStable(directory)) return 'invalid';
    const named = lstatSync(path);
    if (!readablePrivateFile(path, named, directory) || named.size < 2 || named.size > maxBytes) return 'invalid';
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!readablePrivateFile(path, opened, directory) || !sameSnapshot(named, opened)) return 'invalid';
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return 'invalid';
      offset += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (!readablePrivateFile(path, after, directory) || !readablePrivateFile(path, current, directory) ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(after, current) || !directoryStable(directory)) return 'invalid';
    return { bytes, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* read-only close */ }
  }
}

function readSigningKey(directory: StoreDirectory): Buffer | 'absent' | 'invalid' {
  const path = automergeCanarySigningKeyPath();
  try { lstatSync(path); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid';
  }
  if (!assurePrivateStoragePath(path, 'file', 'inspect-owned', { anchorPath: stateRoot() }).ok) {
    return 'invalid';
  }
  const source = readPrivateBytes(path, directory, SIGNING_KEY_BYTES);
  return source === 'absent' || source === 'invalid' || source.bytes.length !== SIGNING_KEY_BYTES
    ? source === 'absent' ? 'absent' : 'invalid'
    : source.bytes;
}

function signingKeyForWrite(directory: StoreDirectory): Buffer | null {
  const key = readSigningKey(directory);
  return Buffer.isBuffer(key) ? key : null;
}

function inactiveResult(): AutoMergeCanaryReadResult {
  return {
    enforceSupported: AUTOMERGE_CANARY_ENFORCE_SUPPORTED,
    sourceState: 'missing',
    severity: 'none',
    status: 'inactive',
    active: false,
    state: null,
    revisions: [],
    terminalEpochs: [],
    diagnostics: [],
    limitExceeded: false,
  };
}

function degradedResult(
  diagnostics: Iterable<AutoMergeCanaryDiagnostic>,
  revisions: AutoMergeCanaryStateV1[] = [],
  terminalEpochs: AutoMergeCanaryTerminalSummaryV1[] = [],
  limitExceeded = false,
): AutoMergeCanaryReadResult {
  return {
    enforceSupported: AUTOMERGE_CANARY_ENFORCE_SUPPORTED,
    sourceState: 'degraded',
    severity: 'critical',
    status: 'critical',
    active: false,
    state: null,
    revisions,
    terminalEpochs,
    diagnostics: [...new Set(diagnostics)].slice(0, 16),
    limitExceeded,
  };
}

function controllerArtifact(name: string): boolean {
  return name === SIGNING_KEY_NAME || name === '.controller.lock' || name.startsWith('.controller.lock.') ||
    PUBLICATION_CANDIDATE_RE.test(name);
}

function nonDeadlineTimes(state: AutoMergeCanaryStateV1): string[] {
  return [
    state.activatedAt,
    state.updatedAt,
    state.clockHighWater,
    state.lease.acquiredAt,
    state.observation.startedAt,
    state.observation.completedAt,
    state.lastShadowEvidence?.observedAt ?? null,
    state.pendingEffect?.requestedAt ?? null,
    state.blocker?.since ?? null,
  ].filter((value): value is string => value !== null);
}

/** Pure observation: never creates, locks, chmods, repairs, fsyncs, or loads a creating key path. */
function readAutomergeCanaryStoreInternal(
  options: ReadOptions,
  classifyFutureTime: boolean,
): AutoMergeCanaryReadResult {
  const directory = readStoreDirectory();
  if (directory === 'missing') return inactiveResult();
  if (directory === 'invalid') return degradedResult(['storage-unsafe']);

  const revisionEntries: Array<{ name: string; epochId: string; revision: number }> = [];
  const summaryEntries: Array<{ name: string; sequence: number; epochId: string }> = [];
  const diagnostics = new Set<AutoMergeCanaryDiagnostic>();
  let totalEntries = 0;
  try {
    const dir = opendirSync(directory.path);
    try {
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        totalEntries += 1;
        if (totalEntries > MAX_DIRECTORY_ENTRIES) {
          return degradedResult(['capacity-exceeded'], [], [], true);
        }
        if (controllerArtifact(entry.name)) continue;
        const revisionMatch = REVISION_NAME_RE.exec(entry.name);
        const summaryMatch = SUMMARY_NAME_RE.exec(entry.name);
        if (revisionMatch) {
          revisionEntries.push({
            name: entry.name,
            epochId: revisionMatch[1]!,
            revision: Number(revisionMatch[2]),
          });
        } else if (summaryMatch) {
          summaryEntries.push({
            name: entry.name,
            sequence: Number(summaryMatch[1]),
            epochId: summaryMatch[2]!,
          });
        } else {
          diagnostics.add('invalid-record');
        }
      }
    } finally { dir.closeSync(); }
  } catch {
    return degradedResult(['storage-unsafe']);
  }
  if (!directoryStable(directory)) return degradedResult(['storage-unsafe']);
  const authorityPaths = [
    ...revisionEntries.map((entry) => join(directory.path, entry.name)),
    ...summaryEntries.map((entry) => join(directory.path, entry.name)),
  ];
  for (let index = 0; index < authorityPaths.length; index += 512) {
    if (!assurePrivateStoragePaths(authorityPaths.slice(index, index + 512), { anchorPath: stateRoot() }).ok) {
      return degradedResult(['storage-unsafe']);
    }
  }

  const key = readSigningKey(directory);
  if (revisionEntries.length === 0 && summaryEntries.length === 0 && diagnostics.size === 0) {
    return key === 'invalid' ? degradedResult(['key-unavailable']) : inactiveResult();
  }
  if (!Buffer.isBuffer(key)) return degradedResult([...diagnostics, 'key-unavailable']);

  const revisionsByEpoch = new Map<string, AutoMergeCanaryStateV1[]>();
  const physicalRevisionsByEpoch = new Map<string, number>();
  revisionEntries.sort((left, right) => left.epochId.localeCompare(right.epochId) || left.revision - right.revision);
  for (const entry of revisionEntries) {
    const physical = (physicalRevisionsByEpoch.get(entry.epochId) ?? 0) + 1;
    physicalRevisionsByEpoch.set(entry.epochId, physical);
    if (physical > AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH ||
      entry.revision < 1 || entry.revision > AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) {
      diagnostics.add('capacity-exceeded');
      continue;
    }
    const source = readPrivateBytes(join(directory.path, entry.name), directory, MAX_RECORD_BYTES);
    if (source === 'absent' || source === 'invalid') {
      diagnostics.add('invalid-record');
      continue;
    }
    let state: AutoMergeCanaryStateV1 | null = null;
    try { state = strictState(JSON.parse(source.bytes.toString('utf8')), key); } catch { state = null; }
    if (!state || state.epochId !== entry.epochId || state.revision !== entry.revision) {
      diagnostics.add('invalid-record');
      continue;
    }
    const rows = revisionsByEpoch.get(state.epochId) ?? [];
    if (rows.some((row) => row.revision === state!.revision)) diagnostics.add('revision-conflict');
    else rows.push(state);
    revisionsByEpoch.set(state.epochId, rows);
  }

  const summaries: AutoMergeCanaryTerminalSummaryV1[] = [];
  if (summaryEntries.length > AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS) diagnostics.add('capacity-exceeded');
  summaryEntries.sort((left, right) => left.sequence - right.sequence || left.name.localeCompare(right.name));
  for (const entry of summaryEntries.slice(0, AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS + 1)) {
    const source = readPrivateBytes(join(directory.path, entry.name), directory, MAX_SUMMARY_BYTES);
    if (source === 'absent' || source === 'invalid') {
      diagnostics.add('invalid-summary');
      continue;
    }
    let summary: AutoMergeCanaryTerminalSummaryV1 | null = null;
    try { summary = strictSummary(JSON.parse(source.bytes.toString('utf8')), key); } catch { summary = null; }
    if (!summary || summary.sequence !== entry.sequence || summary.epochId !== entry.epochId) {
      diagnostics.add('invalid-summary');
      continue;
    }
    summaries.push(summary);
  }

  const flattened: AutoMergeCanaryStateV1[] = [];
  for (const rows of revisionsByEpoch.values()) {
    rows.sort((left, right) => left.revision - right.revision);
    let previous: AutoMergeCanaryStateV1 | undefined;
    const observationDigests = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const appendedObservation = previous !== undefined &&
        row.shadowCounters.attempts === previous.shadowCounters.attempts + 1
        ? row.lastShadowEvidence
        : null;
      if (row.revision !== index + 1) diagnostics.add('revision-gap');
      if (previous && (previous.state === 'halted' ||
        !equalDigest(row.previousAttestation, previous.attestation) ||
        row.activatedAt !== previous.activatedAt || JSON.stringify(row.repository) !== JSON.stringify(previous.repository) ||
        JSON.stringify(row.budgets) !== JSON.stringify(previous.budgets) ||
        row.policyDigest !== previous.policyDigest || row.configDigest !== previous.configDigest ||
        row.classifierDigest !== previous.classifierDigest || row.pathDigest !== previous.pathDigest ||
        Date.parse(row.updatedAt) < Date.parse(previous.updatedAt) ||
        Date.parse(row.clockHighWater) < Date.parse(previous.clockHighWater) ||
        row.counters.admissions < previous.counters.admissions || row.counters.merges < previous.counters.merges ||
        row.counters.inFlight > previous.budgets.maxInFlight || row.counters.rollbacks < previous.counters.rollbacks ||
        !validShadowTransition(previous, row))) {
        diagnostics.add('chain-broken');
      }
      if (appendedObservation !== null) {
        if (observationDigests.has(appendedObservation.observationDigest)) diagnostics.add('chain-broken');
        observationDigests.add(appendedObservation.observationDigest);
      }
      previous = row;
      flattened.push(row);
    }
  }

  const terminalEpochIds = new Set<string>();
  let previousSummaryAttestation = ZERO_ATTESTATION;
  for (let index = 0; index < summaries.length; index += 1) {
    const summary = summaries[index]!;
    if (summary.sequence !== index + 1 || terminalEpochIds.has(summary.epochId) ||
      !equalDigest(summary.previousSummaryAttestation, previousSummaryAttestation)) {
      diagnostics.add('terminal-conflict');
    }
    terminalEpochIds.add(summary.epochId);
    const rows = revisionsByEpoch.get(summary.epochId) ?? [];
    const terminal = rows.at(-1);
    if (!terminal || terminal.state !== 'halted' || terminal.revision !== summary.terminalRevision ||
      terminal.activatedAt !== summary.activatedAt || terminal.updatedAt !== summary.terminalAt ||
      !equalDigest(terminal.attestation, summary.terminalAttestation)) diagnostics.add('terminal-conflict');
    previousSummaryAttestation = summary.attestation;
  }

  const unterminated = [...revisionsByEpoch.entries()].filter(([epochId, rows]) => {
    const latest = rows.at(-1);
    return !terminalEpochIds.has(epochId) && latest?.state !== 'halted';
  });
  for (const [epochId, rows] of revisionsByEpoch) {
    const latest = rows.at(-1);
    if ((latest?.state === 'halted') !== terminalEpochIds.has(epochId)) diagnostics.add('terminal-conflict');
  }
  if (unterminated.length > 1) diagnostics.add('epoch-conflict');

  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) diagnostics.add('future-time');
  else if (classifyFutureTime) {
    for (const row of flattened) {
      if (nonDeadlineTimes(row).some((value) => Date.parse(value) > nowMs + MAX_FUTURE_SKEW_MS)) {
        diagnostics.add('future-time');
        break;
      }
    }
    if (summaries.some((summary) => Date.parse(summary.terminalAt) > nowMs + MAX_FUTURE_SKEW_MS)) {
      diagnostics.add('future-time');
    }
  }

  const limitExceeded = diagnostics.has('capacity-exceeded');
  if (diagnostics.size > 0) return degradedResult(diagnostics, flattened, summaries, limitExceeded);
  const activeState = unterminated[0]?.[1].at(-1) ?? null;
  const latestTerminal = summaries.length > 0
    ? revisionsByEpoch.get(summaries.at(-1)!.epochId)?.at(-1) ?? null
    : null;
  const state = activeState ?? latestTerminal;
  const active = Boolean(activeState);
  const operationalDiagnostics: AutoMergeCanaryDiagnostic[] = [];
  if (activeState && Number.isFinite(nowMs)) {
    const leaseExpiry = activeState.lease.expiresAt === null
      ? null
      : Date.parse(activeState.lease.expiresAt);
    if (leaseExpiry !== null && leaseExpiry <= nowMs) operationalDiagnostics.push('lease-expired');
    const observationDeadline = activeState.observation.deadlineAt === null
      ? null
      : Date.parse(activeState.observation.deadlineAt);
    if (observationDeadline !== null && activeState.observation.completedAt === null &&
      observationDeadline <= nowMs) operationalDiagnostics.push('observation-overdue');
    if (activeState.state === 'shadow' &&
      activeState.revision >= AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - 1) {
      operationalDiagnostics.push('capacity-exceeded');
    }
  }
  const operationalCritical = operationalDiagnostics.length > 0 || state?.blocker?.severity === 'critical';
  return {
    enforceSupported: AUTOMERGE_CANARY_ENFORCE_SUPPORTED,
    sourceState: 'healthy',
    severity: operationalCritical ? 'critical' : 'none',
    status: operationalCritical ? 'critical' : activeState?.state ?? (state ? 'halted' : 'inactive'),
    active,
    state,
    revisions: flattened,
    terminalEpochs: summaries,
    diagnostics: operationalDiagnostics,
    limitExceeded: operationalDiagnostics.includes('capacity-exceeded'),
  };
}

export function readAutomergeCanaryStore(options: ReadOptions = {}): AutoMergeCanaryReadResult {
  return readAutomergeCanaryStoreInternal(options, true);
}

/** Concise status alias kept separate from write APIs to make read-only call sites obvious. */
export function automergeCanaryStatus(options: ReadOptions = {}): AutoMergeCanaryReadResult {
  return readAutomergeCanaryStore(options);
}

function ensurePrivateDirectory(path: string): StoreDirectory | null {
  try {
    let created = false;
    if (!existsSync(path)) {
      try {
        mkdirSync(path, { mode: 0o700 });
        created = true;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = lstatSync(path);
    if (!privateDirectory(stat)) return null;
    const assurance = assurePrivateStoragePath(
      path,
      'directory',
      created ? 'secure-created' : 'inspect-existing',
      { anchorPath: stateRoot() },
    );
    return assurance.ok ? { path, dev: stat.dev, ino: stat.ino } : null;
  } catch { return null; }
}

function ensureStoreDirectory(): StoreDirectory | null {
  try {
    const root = stateRoot();
    if (!ensurePrivateDirectory(root)) return null;
    const fleet = join(root, 'fleet');
    if (!ensurePrivateDirectory(fleet)) return null;
    return ensurePrivateDirectory(automergeCanaryStoreDirectory());
  } catch { return null; }
}

function revisionPath(directory: StoreDirectory, epochId: string, revision: number): string {
  return join(directory.path, `.epoch-v1-${epochId}-${String(revision).padStart(4, '0')}.json`);
}

function summaryPath(directory: StoreDirectory, epochId: string, sequence: number): string {
  return join(directory.path, `.terminal-v1-${String(sequence).padStart(4, '0')}-${epochId}.json`);
}

function canonicalAuthorityName(name: string): boolean {
  return name === SIGNING_KEY_NAME || REVISION_NAME_RE.test(name) || SUMMARY_NAME_RE.test(name);
}

/** A lock holder may collapse only candidates whose exact inode shape proves local publication. */
function cleanupPublicationCandidates(directory: StoreDirectory): boolean {
  try {
    if (!directoryStable(directory)) return false;
    const names = readdirSync(directory.path);
    if (names.length > MAX_DIRECTORY_ENTRIES) return false;
    const candidates = names.filter((name) => PUBLICATION_CANDIDATE_RE.test(name));
    let changed = false;
    for (const name of candidates) {
      const candidatePath = join(directory.path, name);
      const candidate = lstatSync(candidatePath);
      if (!privatePublicationFile(candidate, candidate.nlink === 1 ? 1 : 2)) return false;
      let installedPath: string | undefined;
      if (candidate.nlink === 2) {
        const partners = names.filter((other) => {
          if (!canonicalAuthorityName(other)) return false;
          try { return sameNode(candidate, lstatSync(join(directory.path, other))); }
          catch { return false; }
        });
        if (partners.length !== 1) return false;
        installedPath = join(directory.path, partners[0]!);
      }
      const rebound = lstatSync(candidatePath);
      if (!sameNode(candidate, rebound) || rebound.nlink !== candidate.nlink) return false;
      unlinkSync(candidatePath);
      if (installedPath !== undefined) {
        const installed = lstatSync(installedPath);
        if (!privateFile(installed) || !sameNode(candidate, installed)) return false;
      }
      changed = true;
    }
    if (!directoryStable(directory)) return false;
    if (changed) fsyncDirectory(directory.path);
    return true;
  } catch { return false; }
}

function publicationCandidatePath(directory: StoreDirectory): string {
  return join(directory.path, `.controller-publish-v1-${randomUUID()}.candidate`);
}

function publishImmutableBytes(
  path: string,
  bytes: Buffer,
  maxBytes: number,
  directory: StoreDirectory,
): boolean {
  if (bytes.length < 2 || bytes.length > maxBytes) return false;
  let candidatePath: string | undefined;
  let candidateIdentity: Stats | undefined;
  let fd: number | undefined;
  try {
    if (!directoryStable(directory)) return false;
    candidatePath = publicationCandidatePath(directory);
    fd = openSync(
      candidatePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!privateFile(opened)) return false;
    candidateIdentity = opened;
    if (!assurePrivateStoragePath(candidatePath, 'file', 'secure-created', { anchorPath: stateRoot() }).ok) {
      return false;
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return false;
      offset += count;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const written = fstatSync(fd);
    const namedCandidate = lstatSync(candidatePath);
    if (!privateFile(written) || !privateFile(namedCandidate) || !sameNode(opened, written) ||
      !sameNode(written, namedCandidate) || written.size !== bytes.length || !directoryStable(directory)) {
      return false;
    }
    closeSync(fd);
    fd = undefined;
    linkSync(candidatePath, path);
    const linkedCandidate = lstatSync(candidatePath);
    const linkedCanonical = lstatSync(path);
    if (!privatePublicationFile(linkedCandidate, 2) || !privatePublicationFile(linkedCanonical, 2) ||
      !sameNode(written, linkedCandidate) || !sameNode(linkedCandidate, linkedCanonical) ||
      !directoryStable(directory)) return false;
    unlinkSync(candidatePath);
    candidatePath = undefined;
    const installed = lstatSync(path);
    if (!privateFile(installed) || !sameNode(written, installed) || installed.size !== bytes.length ||
      !directoryStable(directory) ||
      !assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath: stateRoot() }).ok) return false;
    fsyncDirectory(directory.path);
    const reread = readPrivateBytes(path, directory, maxBytes);
    return reread !== 'absent' && reread !== 'invalid' && reread.bytes.equals(bytes);
  } catch { return false; }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* retain fail-closed state */ }
    if (candidatePath !== undefined && candidateIdentity !== undefined) {
      try {
        const candidate = lstatSync(candidatePath);
        if (sameNode(candidateIdentity, candidate) && (candidate.nlink === 1 || candidate.nlink === 2)) {
          unlinkSync(candidatePath);
          if (directoryStable(directory)) fsyncDirectory(directory.path);
        }
      } catch { /* a verified orphan remains for the next lock holder */ }
    }
  }
}

function writeImmutable(path: string, value: unknown, maxBytes: number, directory: StoreDirectory): boolean {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  return publishImmutableBytes(path, bytes, maxBytes, directory);
}

function createSigningKeyForActivation(directory: StoreDirectory): Buffer | null {
  const existing = readSigningKey(directory);
  if (Buffer.isBuffer(existing)) return existing;
  if (existing === 'invalid') return null;

  const path = automergeCanarySigningKeyPath();
  const key = randomBytes(SIGNING_KEY_BYTES);
  if (!publishImmutableBytes(path, key, SIGNING_KEY_BYTES, directory)) return null;
  const durable = readSigningKey(directory);
  return Buffer.isBuffer(durable) && timingSafeEqual(key, durable) ? durable : null;
}

function validActivation(input: AutoMergeCanaryActivationInput): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const row = input as unknown as Record<string, unknown>;
  const allowed = ['budgets', 'classifierDigest', 'configDigest', 'mode', 'pathDigest', 'policyDigest', 'repository'];
  if (Object.keys(row).some((key) => !allowed.includes(key))) return false;
  return (input.mode === undefined || input.mode === 'shadow' || input.mode === 'enforce') &&
    strictRepository(input.repository) && digest(input.policyDigest) && digest(input.configDigest) &&
    digest(input.classifierDigest) && digest(input.pathDigest) && strictBudgets(input.budgets);
}

function validCas(value: AutoMergeCanaryCas): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    exactKeys(value as unknown as Record<string, unknown>, ['attestation', 'epochId', 'revision']) &&
    UUID_RE.test(value.epochId) && safeInteger(value.revision, AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH) &&
    value.revision > 0 && digest(value.attestation));
}

function validUpdate(value: AutoMergeCanaryRevisionUpdate): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length < 1 || Object.keys(row).some((key) => !UPDATE_KEYS.includes(key))) return false;
  if (value.state !== undefined && value.state !== 'shadow' && value.state !== 'halt-requested' &&
    value.state !== 'halted') return false;
  if (value.counters !== undefined && (!value.counters || typeof value.counters !== 'object')) return false;
  if (value.lease !== undefined && !strictLease(value.lease)) return false;
  if (value.observation !== undefined && !strictObservation(value.observation)) return false;
  if (value.pendingEffect !== undefined && !strictPendingEffect(value.pendingEffect)) return false;
  return value.blocker === undefined || strictBlocker(value.blocker);
}

function monotonicUpdate(
  current: AutoMergeCanaryStateV1,
  update: AutoMergeCanaryRevisionUpdate,
  now: Date,
  key: Buffer,
  allowTerminal: boolean,
  shadowUpdate?: {
    counters: AutoMergeCanaryShadowCountersV1;
    evidence: AutoMergeCanaryShadowEvidenceV1;
  },
): { state: AutoMergeCanaryStateV1; clockRollbackDetected: boolean } | null {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !validUpdate(update) || current.state === 'halted') return null;
  const requestedState = update.state ?? current.state;
  if (requestedState === 'halted' && !allowTerminal) return null;
  const highWaterMs = Date.parse(current.clockHighWater);
  const clockRollbackDetected = nowMs < highWaterMs;
  const effectiveMs = Math.max(nowMs, highWaterMs);
  const effectiveAt = new Date(effectiveMs).toISOString();
  const state = clockRollbackDetected && requestedState !== 'halted'
    ? 'halt-requested' as const
    : requestedState;
  if (current.state === 'halt-requested' && state === 'shadow') return null;
  const requestedCounters = update.counters ?? current.counters;
  const counters = state === 'halted'
    ? { ...requestedCounters, inFlight: 0 }
    : requestedCounters;
  if (!strictCounters(counters, current.budgets) || counters.admissions < current.counters.admissions ||
    counters.merges < current.counters.merges || counters.rollbacks < current.counters.rollbacks) return null;
  const lease = state === 'halted'
    ? { holderDigest: null, acquiredAt: null, expiresAt: null } satisfies AutoMergeCanaryLeaseV1
    : update.lease ?? current.lease;
  const observation = update.observation ?? current.observation;
  if (state !== 'halted' && current.lease.expiresAt !== null && (lease.expiresAt === null ||
    Date.parse(lease.expiresAt) < Date.parse(current.lease.expiresAt))) return null;
  if (observation.startedAt !== current.observation.startedAt ||
    observation.deadlineAt !== current.observation.deadlineAt) return null;
  const pendingEffect = state === 'halted' ? null : update.pendingEffect === undefined
    ? current.pendingEffect
    : update.pendingEffect;
  const blocker: AutoMergeCanaryBlockerV1 | null = clockRollbackDetected
    ? { code: 'clock-rollback', severity: 'critical', since: effectiveAt }
    : update.blocker === undefined ? current.blocker : update.blocker;
  const unsigned: Omit<AutoMergeCanaryStateV1, 'attestation'> = {
    ...unsignedState(current),
    revision: current.revision + 1,
    previousAttestation: current.attestation,
    state,
    counters,
    shadowCounters: shadowUpdate?.counters ?? current.shadowCounters,
    lastShadowEvidence: shadowUpdate?.evidence ?? current.lastShadowEvidence,
    lease,
    observation,
    updatedAt: effectiveAt,
    clockHighWater: effectiveAt,
    pendingEffect,
    blocker,
  };
  const attestation = sign(RECORD_DOMAIN, unsigned, key);
  const candidate: AutoMergeCanaryStateV1 = { ...unsigned, attestation };
  return strictState(candidate, key) ? { state: candidate, clockRollbackDetected } : null;
}

function latestState(read: AutoMergeCanaryReadResult): AutoMergeCanaryStateV1 | null {
  return read.active && read.sourceState === 'healthy' ? read.state : null;
}

function writeTerminalSummary(
  state: AutoMergeCanaryStateV1,
  read: AutoMergeCanaryReadResult,
  key: Buffer,
  directory: StoreDirectory,
): boolean {
  if (state.state !== 'halted' || read.terminalEpochs.length >= AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS) return false;
  const previous = read.terminalEpochs.at(-1);
  const unsigned: Omit<AutoMergeCanaryTerminalSummaryV1, 'attestation'> = {
    schemaVersion: SCHEMA_VERSION,
    recordType: 'automerge-canary-terminal',
    sequence: read.terminalEpochs.length + 1,
    epochId: state.epochId,
    terminalRevision: state.revision,
    terminalState: 'halted',
    activatedAt: state.activatedAt,
    terminalAt: state.updatedAt,
    terminalAttestation: state.attestation,
    previousSummaryAttestation: previous?.attestation ?? ZERO_ATTESTATION,
  };
  const summary: AutoMergeCanaryTerminalSummaryV1 = {
    ...unsigned,
    attestation: sign(SUMMARY_DOMAIN, unsigned, key),
  };
  return writeImmutable(
    summaryPath(directory, state.epochId, summary.sequence),
    summary,
    MAX_SUMMARY_BYTES,
    directory,
  );
}

function expectedMatchesTerminal(
  expected: AutoMergeCanaryCas,
  terminal: AutoMergeCanaryStateV1,
  revisions: AutoMergeCanaryStateV1[],
): boolean {
  if (terminal.epochId !== expected.epochId) return false;
  if (terminal.revision === expected.revision && equalDigest(terminal.attestation, expected.attestation)) {
    return true;
  }
  if (terminal.revision !== expected.revision + 1 ||
    !equalDigest(terminal.previousAttestation, expected.attestation)) return false;
  return revisions.some((row) => row.epochId === expected.epochId && row.revision === expected.revision &&
    equalDigest(row.attestation, expected.attestation));
}

function recoverableMissingTerminalSummary(
  read: AutoMergeCanaryReadResult,
): AutoMergeCanaryStateV1 | null {
  if (read.sourceState !== 'degraded' || read.limitExceeded || read.diagnostics.length !== 1 ||
    read.diagnostics[0] !== 'terminal-conflict' ||
    read.terminalEpochs.length >= AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS) return null;
  const rowsByEpoch = new Map<string, AutoMergeCanaryStateV1[]>();
  for (const row of read.revisions) {
    const rows = rowsByEpoch.get(row.epochId) ?? [];
    rows.push(row);
    rowsByEpoch.set(row.epochId, rows);
  }
  const summarized = new Set<string>();
  let previousSummaryAttestation = ZERO_ATTESTATION;
  for (let index = 0; index < read.terminalEpochs.length; index += 1) {
    const summary = read.terminalEpochs[index]!;
    const terminal = rowsByEpoch.get(summary.epochId)?.at(-1);
    if (summary.sequence !== index + 1 || summarized.has(summary.epochId) ||
      !equalDigest(summary.previousSummaryAttestation, previousSummaryAttestation) ||
      !terminal || terminal.state !== 'halted' || terminal.revision !== summary.terminalRevision ||
      terminal.activatedAt !== summary.activatedAt || terminal.updatedAt !== summary.terminalAt ||
      !equalDigest(terminal.attestation, summary.terminalAttestation)) return null;
    summarized.add(summary.epochId);
    previousSummaryAttestation = summary.attestation;
  }
  const missing = [...rowsByEpoch.entries()]
    .filter(([epochId]) => !summarized.has(epochId))
    .map(([, rows]) => rows.at(-1))
    .filter((row): row is AutoMergeCanaryStateV1 => row?.state === 'halted');
  const unsummarizedActive = [...rowsByEpoch.entries()].some(([epochId, rows]) =>
    !summarized.has(epochId) && rows.at(-1)?.state !== 'halted');
  return !unsummarizedActive && missing.length === 1 ? missing[0]! : null;
}

/** Return the exact terminal CAS only for the single supported crash-recovery shape. */
export function recoverableAutomergeCanaryHaltCas(
  read: AutoMergeCanaryReadResult,
): AutoMergeCanaryCas | null {
  const terminal = recoverableMissingTerminalSummary(read);
  return terminal === null ? null : {
    epochId: terminal.epochId,
    revision: terminal.revision,
    attestation: terminal.attestation,
  };
}

/** Explicit activation is the only operation allowed to create a controller epoch or signing key. */
export function activateShadow(
  input: AutoMergeCanaryActivationInput,
  options: WriteOptions = {},
): AutoMergeCanaryWriteResult {
  if (!validActivation(input)) return { ok: false, reason: 'invalid' };
  if (input.mode === 'enforce') return { ok: false, reason: 'enforce-unsupported' };
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { ok: false, reason: 'invalid' };
  const observationDeadlineMs = now.getTime() + input.budgets.observationDurationMs;
  if (!Number.isFinite(observationDeadlineMs)) return { ok: false, reason: 'invalid' };
  let observationDeadline: string;
  try { observationDeadline = new Date(observationDeadlineMs).toISOString(); }
  catch { return { ok: false, reason: 'invalid' }; }
  const epochId = options.epochId ?? randomUUID();
  if (!UUID_RE.test(epochId)) return { ok: false, reason: 'invalid' };
  const directory = ensureStoreDirectory();
  if (!directory) return { ok: false, reason: 'unavailable' };
  const lock = acquireLocalStoreLock(automergeCanaryStoreLockPath(), LOCK_WAIT_MS);
  if (!lock) return { ok: false, reason: 'unavailable' };
  try {
    if (!ownsLocalStoreLock(lock) || !cleanupPublicationCandidates(directory)) {
      return { ok: false, reason: 'unavailable' };
    }
    const read = readAutomergeCanaryStore({ now });
    if (read.sourceState === 'degraded') return { ok: false, reason: 'degraded' };
    if (read.active) return { ok: false, reason: 'conflict' };
    if (read.terminalEpochs.length >= AUTOMERGE_CANARY_MAX_TERMINAL_EPOCHS) {
      return { ok: false, reason: 'capacity' };
    }
    if (!ownsLocalStoreLock(lock)) return { ok: false, reason: 'unavailable' };
    const key = createSigningKeyForActivation(directory);
    if (!key || !ownsLocalStoreLock(lock)) return { ok: false, reason: 'unavailable' };
    const at = now.toISOString();
    const unsigned: Omit<AutoMergeCanaryStateV1, 'attestation'> = {
      schemaVersion: SCHEMA_VERSION,
      epochId,
      revision: 1,
      previousAttestation: ZERO_ATTESTATION,
      mode: 'shadow',
      state: 'shadow',
      repository: input.repository,
      policyDigest: input.policyDigest,
      configDigest: input.configDigest,
      classifierDigest: input.classifierDigest,
      pathDigest: input.pathDigest,
      budgets: input.budgets,
      counters: { admissions: 0, merges: 0, inFlight: 0, rollbacks: 0 },
      shadowCounters: {
        attempts: 0,
        eligible: 0,
        rejected: 0,
        bindingMismatches: 0,
        inspectionErrors: 0,
        casRetries: 0,
      },
      lastShadowEvidence: null,
      lease: { holderDigest: null, acquiredAt: null, expiresAt: null },
      observation: { startedAt: at, deadlineAt: observationDeadline, completedAt: null },
      activatedAt: at,
      updatedAt: at,
      clockHighWater: at,
      pendingEffect: null,
      blocker: null,
    };
    const state: AutoMergeCanaryStateV1 = { ...unsigned, attestation: sign(RECORD_DOMAIN, unsigned, key) };
    if (!strictState(state, key) || !writeImmutable(revisionPath(directory, epochId, 1), state, MAX_RECORD_BYTES, directory)) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, state, clockRollbackDetected: false };
  } finally { releaseLocalStoreLock(lock); }
}

/** V1 deliberately has no enforce activation path. This function never touches storage. */
export function activateEnforce(): AutoMergeCanaryWriteResult {
  return { ok: false, reason: 'enforce-unsupported' };
}

function appendRevisionInternal(
  expected: AutoMergeCanaryCas,
  update: AutoMergeCanaryRevisionUpdate,
  options: ReadOptions = {},
  allowTerminal = false,
): AutoMergeCanaryWriteResult {
  if (!validCas(expected) || !validUpdate(update) || (update.state === 'halted' && !allowTerminal)) {
    return { ok: false, reason: 'invalid' };
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { ok: false, reason: 'invalid' };
  const directory = readStoreDirectory();
  if (directory === 'missing') return { ok: false, reason: 'conflict' };
  if (directory === 'invalid') return { ok: false, reason: 'degraded' };
  const lock = acquireLocalStoreLock(automergeCanaryStoreLockPath(), LOCK_WAIT_MS);
  if (!lock) return { ok: false, reason: 'unavailable' };
  try {
    if (!ownsLocalStoreLock(lock) || !cleanupPublicationCandidates(directory)) {
      return { ok: false, reason: 'unavailable' };
    }
    // Replay integrity before wall-clock health so a regressed clock can append
    // exactly one forced blocker instead of being unable to record the fault.
    const read = readAutomergeCanaryStoreInternal({ now }, false);
    if (read.sourceState === 'degraded') {
      const terminal = allowTerminal ? recoverableMissingTerminalSummary(read) : null;
      if (!terminal || !expectedMatchesTerminal(expected, terminal, read.revisions)) {
        return { ok: false, reason: 'degraded' };
      }
      if (!ownsLocalStoreLock(lock)) return { ok: false, reason: 'unavailable' };
      const key = signingKeyForWrite(directory);
      if (!key || !ownsLocalStoreLock(lock) || !writeTerminalSummary(terminal, read, key, directory)) {
        return { ok: false, reason: 'unavailable' };
      }
      const recovered = readAutomergeCanaryStoreInternal({ now }, false);
      return recovered.sourceState === 'healthy' && !recovered.active &&
        recovered.state?.epochId === terminal.epochId &&
        equalDigest(recovered.state.attestation, terminal.attestation)
        ? { ok: true, state: terminal, clockRollbackDetected: false }
        : { ok: false, reason: 'degraded' };
    }
    if (allowTerminal && !read.active && read.state?.state === 'halted' &&
      expectedMatchesTerminal(expected, read.state, read.revisions)) {
      return { ok: true, state: read.state, clockRollbackDetected: false };
    }
    const current = latestState(read);
    if (!current || current.epochId !== expected.epochId || current.revision !== expected.revision ||
      !equalDigest(current.attestation, expected.attestation)) return { ok: false, reason: 'conflict' };
    const maximumCurrentRevision = allowTerminal
      ? AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - 1
      : AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - 2;
    if (current.revision > maximumCurrentRevision) {
      return { ok: false, reason: 'capacity' };
    }
    if (!ownsLocalStoreLock(lock)) return { ok: false, reason: 'unavailable' };
    const key = signingKeyForWrite(directory);
    if (!key || !ownsLocalStoreLock(lock)) return { ok: false, reason: 'unavailable' };
    const next = monotonicUpdate(current, update, now, key, allowTerminal);
    if (!next) return { ok: false, reason: 'invalid' };
    if (!ownsLocalStoreLock(lock) || !writeImmutable(
      revisionPath(directory, next.state.epochId, next.state.revision),
      next.state,
      MAX_RECORD_BYTES,
      directory,
    )) return { ok: false, reason: 'unavailable' };
    if (next.state.state === 'halted' &&
      (!ownsLocalStoreLock(lock) || !writeTerminalSummary(next.state, read, key, directory))) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, state: next.state, clockRollbackDetected: next.clockRollbackDetected };
  } finally { releaseLocalStoreLock(lock); }
}

function shadowEvidenceFromInput(
  value: AutoMergeCanaryShadowObservationInput,
  current: AutoMergeCanaryStateV1,
): AutoMergeCanaryShadowEvidenceV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as unknown as Record<string, unknown>;
  if (!exactKeys(row, SHADOW_OBSERVATION_INPUT_KEYS) ||
    (value.casRetries !== 0 && value.casRetries !== 1)) return null;
  const evidenceWithoutDigest: Omit<AutoMergeCanaryShadowEvidenceV1, 'observationDigest'> = {
    observedAt: value.observedAt,
    outcome: value.outcome,
    mismatchFields: value.mismatchFields,
    repositoryId: value.repositoryId,
    fetchDestinationDigest: value.fetchDestinationDigest,
    pushDestinationDigest: value.pushDestinationDigest,
    baseRefDigest: value.baseRefDigest,
    baseOid: value.baseOid,
    headOid: value.headOid,
    policyDigest: value.policyDigest,
    configDigest: value.configDigest,
    classifierDigest: value.classifierDigest,
    treeOid: value.treeOid,
    fileCount: value.fileCount,
    lineCount: value.lineCount,
    reasonDigest: value.reasonDigest,
    pathDigest: value.pathDigest,
  };
  const observationDigest = value.casRetries === 1
    ? createHash('sha256').update(JSON.stringify([OBSERVATION_DOMAIN, {
      epochId: current.epochId,
      bindings: {
        repositoryId: evidenceWithoutDigest.repositoryId,
        fetchDestinationDigest: evidenceWithoutDigest.fetchDestinationDigest,
        pushDestinationDigest: evidenceWithoutDigest.pushDestinationDigest,
        baseRefDigest: evidenceWithoutDigest.baseRefDigest,
        baseOid: evidenceWithoutDigest.baseOid,
        headOid: evidenceWithoutDigest.headOid,
        policyDigest: evidenceWithoutDigest.policyDigest,
        configDigest: evidenceWithoutDigest.configDigest,
        classifierDigest: evidenceWithoutDigest.classifierDigest,
        pathDigest: evidenceWithoutDigest.pathDigest,
      },
      evidence: evidenceWithoutDigest,
    }]), 'utf8').digest('hex')
    : value.observationDigest;
  const evidence: AutoMergeCanaryShadowEvidenceV1 = { observationDigest, ...evidenceWithoutDigest };
  if (!strictShadowEvidence(evidence, current)) return null;
  return evidence;
}

function duplicateShadowObservationResult(
  expected: AutoMergeCanaryCas,
  current: AutoMergeCanaryStateV1,
  revisions: AutoMergeCanaryStateV1[],
  evidence: AutoMergeCanaryShadowEvidenceV1,
): AutoMergeCanaryWriteResult | null {
  const duplicate = revisions.find((row) => row.epochId === current.epochId &&
    row.lastShadowEvidence?.observationDigest === evidence.observationDigest);
  if (!duplicate) return null;
  if (JSON.stringify(duplicate.lastShadowEvidence) !== JSON.stringify(evidence)) {
    return { ok: false, reason: 'invalid' };
  }
  const expectedIsCurrent = current.epochId === expected.epochId && current.revision === expected.revision &&
    equalDigest(current.attestation, expected.attestation);
  const expectedIsOriginalParent = duplicate.epochId === expected.epochId &&
    duplicate.revision === expected.revision + 1 &&
    equalDigest(duplicate.previousAttestation, expected.attestation) &&
    revisions.some((row) => row.epochId === expected.epochId && row.revision === expected.revision &&
      equalDigest(row.attestation, expected.attestation));
  return expectedIsCurrent || expectedIsOriginalParent
    ? { ok: true, state: current, clockRollbackDetected: false }
    : { ok: false, reason: 'conflict' };
}

function incrementShadowCounters(
  current: AutoMergeCanaryShadowCountersV1,
  outcome: AutoMergeCanaryShadowOutcome,
  casRetries: 0 | 1,
): AutoMergeCanaryShadowCountersV1 {
  return {
    attempts: current.attempts + 1,
    eligible: current.eligible + (outcome === 'eligible' ? 1 : 0),
    rejected: current.rejected + (outcome === 'rejected' ? 1 : 0),
    bindingMismatches: current.bindingMismatches + (outcome === 'binding-mismatch' ? 1 : 0),
    inspectionErrors: current.inspectionErrors + (outcome === 'inspection-error' ? 1 : 0),
    casRetries: current.casRetries + casRetries,
  };
}

function beforeObservationDeadline(state: AutoMergeCanaryStateV1, timeMs: number): boolean {
  const deadlineMs = state.observation.deadlineAt === null
    ? Number.NaN
    : Date.parse(state.observation.deadlineAt);
  return Number.isFinite(timeMs) && Number.isFinite(deadlineMs) && timeMs < deadlineMs;
}

/** Append one bounded observation without exposing ordinary admission or merge counter updates. */
export function appendShadowObservation(
  expected: AutoMergeCanaryCas,
  input: AutoMergeCanaryShadowObservationInput,
  options: ReadOptions = {},
): AutoMergeCanaryWriteResult {
  if (!validCas(expected)) return { ok: false, reason: 'invalid' };
  const initialNow = options.now ?? new Date();
  if (!Number.isFinite(initialNow.getTime())) return { ok: false, reason: 'invalid' };
  const directory = readStoreDirectory();
  if (directory === 'missing') return { ok: false, reason: 'conflict' };
  if (directory === 'invalid') return { ok: false, reason: 'degraded' };

  const initialRead = readAutomergeCanaryStoreInternal({ now: initialNow }, false);
  if (initialRead.sourceState !== 'degraded') {
    const initial = latestState(initialRead);
    if (!initial || initial.state !== 'shadow') return { ok: false, reason: 'conflict' };
    const initialEvidence = shadowEvidenceFromInput(input, initial);
    if (!initialEvidence) return { ok: false, reason: 'invalid' };
    if (!beforeObservationDeadline(initial, initialNow.getTime()) ||
      !beforeObservationDeadline(initial, Date.parse(initialEvidence.observedAt))) {
      return { ok: false, reason: 'conflict' };
    }
    const initialDuplicate = duplicateShadowObservationResult(
      expected,
      initial,
      initialRead.revisions,
      initialEvidence,
    );
    if (initialDuplicate) return initialDuplicate;
    if (initial.epochId !== expected.epochId || initial.revision !== expected.revision ||
      !equalDigest(initial.attestation, expected.attestation)) return { ok: false, reason: 'conflict' };
  }

  const lock = acquireLocalStoreLock(automergeCanaryStoreLockPath(), LOCK_WAIT_MS);
  if (!lock) return { ok: false, reason: 'unavailable' };
  try {
    if (!ownsLocalStoreLock(lock) || !cleanupPublicationCandidates(directory)) {
      return { ok: false, reason: 'unavailable' };
    }
    const commitNow = options.now ?? new Date();
    if (!Number.isFinite(commitNow.getTime())) return { ok: false, reason: 'invalid' };
    const read = readAutomergeCanaryStoreInternal({ now: commitNow }, false);
    if (read.sourceState === 'degraded') return { ok: false, reason: 'degraded' };
    const current = latestState(read);
    if (!current || current.state !== 'shadow') return { ok: false, reason: 'conflict' };
    const evidence = shadowEvidenceFromInput(input, current);
    if (!evidence) return { ok: false, reason: 'invalid' };
    if (!beforeObservationDeadline(current, commitNow.getTime()) ||
      !beforeObservationDeadline(current, Date.parse(evidence.observedAt))) {
      return { ok: false, reason: 'conflict' };
    }
    const duplicate = duplicateShadowObservationResult(expected, current, read.revisions, evidence);
    if (duplicate) return duplicate;
    if (current.epochId !== expected.epochId || current.revision !== expected.revision ||
      !equalDigest(current.attestation, expected.attestation)) return { ok: false, reason: 'conflict' };
    if (current.revision > AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - 2) {
      return { ok: false, reason: 'capacity' };
    }
    if (!ownsLocalStoreLock(lock)) return { ok: false, reason: 'unavailable' };
    const key = signingKeyForWrite(directory);
    if (!key || !ownsLocalStoreLock(lock)) return { ok: false, reason: 'unavailable' };
    const observationTime = new Date(evidence.observedAt);
    const clockRollback = observationTime.getTime() < Date.parse(current.clockHighWater);
    const shadowCounters = clockRollback
      ? current.shadowCounters
      : incrementShadowCounters(current.shadowCounters, evidence.outcome, input.casRetries);
    if (!strictShadowCounters(shadowCounters)) return { ok: false, reason: 'capacity' };
    const next = monotonicUpdate(
      current,
      { state: 'shadow' },
      observationTime,
      key,
      false,
      clockRollback ? undefined : { counters: shadowCounters, evidence },
    );
    if (!next || next.clockRollbackDetected !== clockRollback) return { ok: false, reason: 'invalid' };
    if (!ownsLocalStoreLock(lock) || !writeImmutable(
      revisionPath(directory, next.state.epochId, next.state.revision),
      next.state,
      MAX_RECORD_BYTES,
      directory,
    )) return { ok: false, reason: 'unavailable' };
    return { ok: true, state: next.state, clockRollbackDetected: next.clockRollbackDetected };
  } finally { releaseLocalStoreLock(lock); }
}

/** Compare-and-append one non-terminal shadow revision under the controller-wide lock. */
export function appendRevision(
  expected: AutoMergeCanaryCas,
  update: AutoMergeCanaryRevisionUpdate,
  options: ReadOptions = {},
): AutoMergeCanaryWriteResult {
  return appendRevisionInternal(expected, update, options, false);
}

export const compareAndAppendRevision = appendRevision;

/** Constrained CAS transition for an operator-requested shadow halt; it performs no outward action. */
export function haltShadow(
  expected: AutoMergeCanaryCas,
  options: ReadOptions & { blockerCode?: string } = {},
): AutoMergeCanaryWriteResult {
  const now = options.now ?? new Date();
  const code = options.blockerCode ?? 'operator-halt';
  if (!BLOCKER_RE.test(code) || !Number.isFinite(now.getTime())) return { ok: false, reason: 'invalid' };
  return appendRevisionInternal(expected, {
    state: 'halted',
    pendingEffect: null,
    blocker: { code, severity: 'critical', since: now.toISOString() },
  }, { now }, true);
}
