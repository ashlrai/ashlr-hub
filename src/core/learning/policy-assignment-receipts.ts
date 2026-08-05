import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  loadExistingProvenanceKey,
  loadExistingProvenanceKeyReadOnly,
} from '../foundry/provenance.js';
import type { WorkItem } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { policyAssignmentUnitId } from './policy-assignment-identity.js';

const PROTOCOL = 'policy-assignment-receipt-v1' as const;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const POLICY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_ACTIONS = 32;
const MAX_PROBABILITY_DENOMINATOR = 1_000_000_000;
const MAX_RECEIPT_BYTES = 16 * 1024;
const DEFAULT_MAX_FILES = 4_096;
const HARD_MAX_FILES = 16_384;
const HARD_MAX_DIRECTORY_ENTRIES = HARD_MAX_FILES + 64;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const HARD_MAX_BYTES = 64 * 1024 * 1024;
const RECEIPT_KEYS = [
  'assignmentDigest',
  'assignmentEvidence',
  'assignmentUnitId',
  'attestation',
  'authority',
  'campaignDigest',
  'causalIdentifiability',
  'contextStratumDigest',
  'denominatorComplete',
  'eligibilityPopulationDigest',
  'executionAuthority',
  'learningEpoch',
  'policyEligible',
  'policyVersion',
  'preExposureVerified',
  'protocol',
  'reportedActionSetDigest',
  'reportedAssignedAt',
  'reportedAssignmentMechanism',
  'reportedEligibleActions',
  'reportedProbabilityDenominator',
  'reportedRandomizationCommitment',
  'reportedSelectedActionId',
  'schemaVersion',
  'timingEvidence',
  'workSource',
] as const;
const ACTION_KEYS = ['actionDefinitionDigest', 'actionId', 'probabilityNumerator'] as const;
const WORK_SOURCES = new Set<WorkItem['source']>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint',
  'goal', 'hygiene', 'invent',
]);

export interface PolicyAssignmentActionProbability {
  actionId: string;
  actionDefinitionDigest: string;
  probabilityNumerator: number;
}

export interface PolicyAssignmentReceiptInput {
  reportedAssignedAt: string;
  repo: string;
  workItemId: string;
  workSource: WorkItem['source'];
  workItemGenerationId: string;
  objectiveHash: string;
  campaignDigest: string;
  eligibilityPopulationDigest: string;
  contextStratum: string;
  policyVersion: string;
  learningEpoch: string;
  reportedAssignmentMechanism: 'randomized-hmac' | 'deterministic-policy';
  reportedRandomizationCommitment?: string;
  reportedProbabilityDenominator: number;
  reportedEligibleActions: PolicyAssignmentActionProbability[];
  reportedSelectedActionId: string;
}

export interface PolicyAssignmentReceiptV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authority: 'observation-only';
  executionAuthority: false;
  policyEligible: false;
  causalIdentifiability: 'not-identifiable';
  assignmentEvidence: 'policy-reported';
  timingEvidence: 'policy-reported';
  preExposureVerified: false;
  denominatorComplete: false;
  assignmentUnitId: string;
  reportedAssignedAt: string;
  workSource: WorkItem['source'];
  campaignDigest: string;
  eligibilityPopulationDigest: string;
  contextStratumDigest: string;
  policyVersion: string;
  learningEpoch: string;
  reportedAssignmentMechanism: 'randomized-hmac' | 'deterministic-policy';
  reportedRandomizationCommitment: string | null;
  reportedProbabilityDenominator: number;
  reportedEligibleActions: PolicyAssignmentActionProbability[];
  reportedSelectedActionId: string;
  reportedActionSetDigest: string;
  assignmentDigest: string;
  attestation: string;
}

export type PolicyAssignmentReceiptWriteDisposition =
  | 'recorded'
  | 'replayed'
  | 'conflicted'
  | 'invalid'
  | 'failed';

export type PolicyAssignmentReceiptReadStopReason =
  | 'identity-key-unavailable'
  | 'unsafe-storage'
  | 'invalid-options'
  | 'file-limit'
  | 'byte-limit'
  | 'invalid-file'
  | 'source-mutated'
  | 'io-error';

export interface PolicyAssignmentReceiptReadResult {
  receipts: PolicyAssignmentReceiptV1[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  denominatorComplete: false;
  stopReasons: PolicyAssignmentReceiptReadStopReason[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
}

interface ReceiptDirectories {
  home: string;
  fleet: string;
  receipts: string;
  identities: readonly DirectoryIdentity[];
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function shaTuple(domain: string, values: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify([domain, ...values]), 'utf8').digest('hex');
}

function hmacTuple(key: Buffer, domain: string, values: readonly unknown[]): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, ...values]), 'utf8').digest('hex');
}

function canonicalRepo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || !isAbsolute(value)) return null;
  try {
    const canonical = realpathSync(value);
    return isAbsolute(canonical) && canonical.length <= 1_024 ? canonical : null;
  } catch {
    return null;
  }
}

function canonicalActions(
  actions: unknown,
  denominator: number,
): PolicyAssignmentActionProbability[] | null {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) return null;
  const canonical: PolicyAssignmentActionProbability[] = [];
  for (const value of actions) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !exactKeys(value, ACTION_KEYS)) return null;
    const action = value as Record<string, unknown>;
    if (!safeToken(action['actionId']) ||
      !SHA256_RE.test(typeof action['actionDefinitionDigest'] === 'string'
        ? action['actionDefinitionDigest']
        : '') ||
      !Number.isSafeInteger(action['probabilityNumerator']) ||
      (action['probabilityNumerator'] as number) < 0 ||
      (action['probabilityNumerator'] as number) > denominator) return null;
    canonical.push({
      actionId: action['actionId'],
      actionDefinitionDigest: action['actionDefinitionDigest'] as string,
      probabilityNumerator: action['probabilityNumerator'] as number,
    });
  }
  canonical.sort((left, right) => left.actionId < right.actionId ? -1 : left.actionId > right.actionId ? 1 : 0);
  if (canonical.some((action, index) => index > 0 &&
    action.actionId === canonical[index - 1]?.actionId)) return null;
  const total = canonical.reduce((sum, action) => sum + BigInt(action.probabilityNumerator), 0n);
  if (total !== BigInt(denominator)) return null;
  const gcd = (left: bigint, right: bigint): bigint => {
    let a = left;
    let b = right;
    while (b !== 0n) [a, b] = [b, a % b];
    return a < 0n ? -a : a;
  };
  const divisor = canonical.reduce(
    (current, action) => gcd(current, BigInt(action.probabilityNumerator)),
    BigInt(denominator),
  );
  return divisor === 1n ? canonical : null;
}

function receiptBody(receipt: Omit<PolicyAssignmentReceiptV1, 'assignmentDigest' | 'attestation'>): unknown[] {
  return [
    receipt.schemaVersion,
    receipt.protocol,
    receipt.authority,
    receipt.executionAuthority,
    receipt.policyEligible,
    receipt.causalIdentifiability,
    receipt.assignmentEvidence,
    receipt.timingEvidence,
    receipt.preExposureVerified,
    receipt.denominatorComplete,
    receipt.assignmentUnitId,
    receipt.reportedAssignedAt,
    receipt.workSource,
    receipt.campaignDigest,
    receipt.eligibilityPopulationDigest,
    receipt.contextStratumDigest,
    receipt.policyVersion,
    receipt.learningEpoch,
    receipt.reportedAssignmentMechanism,
    receipt.reportedRandomizationCommitment,
    receipt.reportedProbabilityDenominator,
    receipt.reportedEligibleActions.map((action) => [
      action.actionId,
      action.actionDefinitionDigest,
      action.probabilityNumerator,
    ]),
    receipt.reportedSelectedActionId,
    receipt.reportedActionSetDigest,
  ];
}

function createWithKey(
  input: PolicyAssignmentReceiptInput,
  key: Buffer,
): PolicyAssignmentReceiptV1 | null {
  try {
    const repo = canonicalRepo(input.repo);
    if (!repo || key.length !== 32 ||
      typeof input.workItemId !== 'string' || input.workItemId.length < 1 || input.workItemId.length > 240 ||
      !WORK_SOURCES.has(input.workSource) ||
      !SHA256_RE.test(input.workItemGenerationId) ||
      !SHA256_RE.test(input.objectiveHash) ||
      !SHA256_RE.test(input.campaignDigest) ||
      !SHA256_RE.test(input.eligibilityPopulationDigest) ||
      !canonicalTimestamp(input.reportedAssignedAt) ||
      !safeToken(input.contextStratum) ||
      !POLICY_RE.test(input.policyVersion) ||
      !POLICY_RE.test(input.learningEpoch) ||
      (input.reportedAssignmentMechanism !== 'randomized-hmac' &&
        input.reportedAssignmentMechanism !== 'deterministic-policy') ||
      !Number.isSafeInteger(input.reportedProbabilityDenominator) ||
      input.reportedProbabilityDenominator < 1 ||
      input.reportedProbabilityDenominator > MAX_PROBABILITY_DENOMINATOR ||
      !safeToken(input.reportedSelectedActionId)) return null;
    const actions = canonicalActions(
      input.reportedEligibleActions,
      input.reportedProbabilityDenominator,
    );
    const selected = actions?.find((action) => action.actionId === input.reportedSelectedActionId);
    if (!actions || !selected || selected.probabilityNumerator < 1) return null;
    const randomizationCommitment = input.reportedAssignmentMechanism === 'randomized-hmac'
      ? input.reportedRandomizationCommitment ?? null
      : null;
    if ((input.reportedAssignmentMechanism === 'randomized-hmac' &&
        (!randomizationCommitment || !SHA256_RE.test(randomizationCommitment))) ||
      (input.reportedAssignmentMechanism === 'deterministic-policy' &&
        (input.reportedRandomizationCommitment !== undefined ||
          selected.probabilityNumerator !== input.reportedProbabilityDenominator ||
          actions.some((action) => action.actionId !== input.reportedSelectedActionId &&
            action.probabilityNumerator !== 0)))) return null;

    const assignmentUnitId = policyAssignmentUnitId(key, {
      repo,
      workItemId: input.workItemId,
      workSource: input.workSource,
      workItemGenerationId: input.workItemGenerationId,
      objectiveHash: input.objectiveHash,
      campaignDigest: input.campaignDigest,
      eligibilityPopulationDigest: input.eligibilityPopulationDigest,
      policyVersion: input.policyVersion,
      learningEpoch: input.learningEpoch,
    });
    const contextStratumDigest = hmacTuple(key, 'ashlr:policy-assignment-context-stratum:v1', [
      input.campaignDigest,
      input.eligibilityPopulationDigest,
      input.policyVersion,
      input.learningEpoch,
      input.contextStratum,
    ]);
    const reportedActionSetDigest = hmacTuple(key, 'ashlr:policy-assignment-actions:v1', [
      input.campaignDigest,
      input.eligibilityPopulationDigest,
      contextStratumDigest,
      input.policyVersion,
      input.learningEpoch,
      input.reportedProbabilityDenominator,
      actions.map((action) => [
        action.actionId,
        action.actionDefinitionDigest,
        action.probabilityNumerator,
      ]),
    ]);
    const unsigned: Omit<PolicyAssignmentReceiptV1, 'assignmentDigest' | 'attestation'> = {
      schemaVersion: 1,
      protocol: PROTOCOL,
      authority: 'observation-only',
      executionAuthority: false,
      policyEligible: false,
      causalIdentifiability: 'not-identifiable',
      assignmentEvidence: 'policy-reported',
      timingEvidence: 'policy-reported',
      preExposureVerified: false,
      denominatorComplete: false,
      assignmentUnitId,
      reportedAssignedAt: input.reportedAssignedAt,
      workSource: input.workSource,
      campaignDigest: input.campaignDigest,
      eligibilityPopulationDigest: input.eligibilityPopulationDigest,
      contextStratumDigest,
      policyVersion: input.policyVersion,
      learningEpoch: input.learningEpoch,
      reportedAssignmentMechanism: input.reportedAssignmentMechanism,
      reportedRandomizationCommitment: randomizationCommitment,
      reportedProbabilityDenominator: input.reportedProbabilityDenominator,
      reportedEligibleActions: actions,
      reportedSelectedActionId: input.reportedSelectedActionId,
      reportedActionSetDigest,
    };
    const assignmentDigest = shaTuple('ashlr:policy-assignment-receipt:v1', receiptBody(unsigned));
    const attestation = hmacTuple(key, 'ashlr:policy-assignment-attestation:v1', [
      assignmentDigest,
      ...receiptBody(unsigned),
    ]);
    return { ...unsigned, assignmentDigest, attestation };
  } catch {
    return null;
  }
}

function reconstructWithKey(value: unknown, key: Buffer): PolicyAssignmentReceiptV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    !exactKeys(value, RECEIPT_KEYS)) return null;
  const row = value as Record<string, unknown>;
  if (row['schemaVersion'] !== 1 ||
    row['protocol'] !== PROTOCOL ||
    row['authority'] !== 'observation-only' ||
    row['executionAuthority'] !== false ||
    row['policyEligible'] !== false ||
    row['causalIdentifiability'] !== 'not-identifiable' ||
    row['assignmentEvidence'] !== 'policy-reported' ||
    row['timingEvidence'] !== 'policy-reported' ||
    row['preExposureVerified'] !== false ||
    row['denominatorComplete'] !== false ||
    !SHA256_RE.test(typeof row['assignmentUnitId'] === 'string' ? row['assignmentUnitId'] : '') ||
    !canonicalTimestamp(row['reportedAssignedAt']) ||
    !WORK_SOURCES.has(row['workSource'] as WorkItem['source']) ||
    !SHA256_RE.test(typeof row['campaignDigest'] === 'string' ? row['campaignDigest'] : '') ||
    !SHA256_RE.test(typeof row['eligibilityPopulationDigest'] === 'string'
      ? row['eligibilityPopulationDigest']
      : '') ||
    !SHA256_RE.test(typeof row['contextStratumDigest'] === 'string' ? row['contextStratumDigest'] : '') ||
    !POLICY_RE.test(typeof row['policyVersion'] === 'string' ? row['policyVersion'] : '') ||
    !POLICY_RE.test(typeof row['learningEpoch'] === 'string' ? row['learningEpoch'] : '') ||
    (row['reportedAssignmentMechanism'] !== 'randomized-hmac' &&
      row['reportedAssignmentMechanism'] !== 'deterministic-policy') ||
    (row['reportedRandomizationCommitment'] !== null &&
      !SHA256_RE.test(typeof row['reportedRandomizationCommitment'] === 'string'
        ? row['reportedRandomizationCommitment']
        : '')) ||
    !Number.isSafeInteger(row['reportedProbabilityDenominator']) ||
    (row['reportedProbabilityDenominator'] as number) < 1 ||
    (row['reportedProbabilityDenominator'] as number) > MAX_PROBABILITY_DENOMINATOR ||
    !safeToken(row['reportedSelectedActionId']) ||
    !SHA256_RE.test(typeof row['reportedActionSetDigest'] === 'string' ? row['reportedActionSetDigest'] : '') ||
    !SHA256_RE.test(typeof row['assignmentDigest'] === 'string' ? row['assignmentDigest'] : '') ||
    !SHA256_RE.test(typeof row['attestation'] === 'string' ? row['attestation'] : '')) return null;
  const actions = canonicalActions(
    row['reportedEligibleActions'],
    row['reportedProbabilityDenominator'] as number,
  );
  const selected = actions?.find((action) => action.actionId === row['reportedSelectedActionId']);
  if (!actions ||
    JSON.stringify(actions) !== JSON.stringify(row['reportedEligibleActions']) ||
    !selected ||
    selected.probabilityNumerator < 1 ||
    (row['reportedAssignmentMechanism'] === 'randomized-hmac' &&
      typeof row['reportedRandomizationCommitment'] !== 'string') ||
    (row['reportedAssignmentMechanism'] === 'deterministic-policy' &&
      (row['reportedRandomizationCommitment'] !== null ||
        selected.probabilityNumerator !== row['reportedProbabilityDenominator'] ||
        actions.some((action) => action.actionId !== row['reportedSelectedActionId'] &&
          action.probabilityNumerator !== 0)))) return null;
  const reportedActionSetDigest = hmacTuple(key, 'ashlr:policy-assignment-actions:v1', [
    row['campaignDigest'],
    row['eligibilityPopulationDigest'],
    row['contextStratumDigest'],
    row['policyVersion'],
    row['learningEpoch'],
    row['reportedProbabilityDenominator'],
    actions.map((action) => [
      action.actionId,
      action.actionDefinitionDigest,
      action.probabilityNumerator,
    ]),
  ]);
  if (!safeDigestEqual(row['reportedActionSetDigest'] as string, reportedActionSetDigest)) return null;
  const unsigned: Omit<PolicyAssignmentReceiptV1, 'assignmentDigest' | 'attestation'> = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    executionAuthority: false,
    policyEligible: false,
    causalIdentifiability: 'not-identifiable',
    assignmentEvidence: 'policy-reported',
    timingEvidence: 'policy-reported',
    preExposureVerified: false,
    denominatorComplete: false,
    assignmentUnitId: row['assignmentUnitId'] as string,
    reportedAssignedAt: row['reportedAssignedAt'] as string,
    workSource: row['workSource'] as WorkItem['source'],
    campaignDigest: row['campaignDigest'] as string,
    eligibilityPopulationDigest: row['eligibilityPopulationDigest'] as string,
    contextStratumDigest: row['contextStratumDigest'] as string,
    policyVersion: row['policyVersion'] as string,
    learningEpoch: row['learningEpoch'] as string,
    reportedAssignmentMechanism:
      row['reportedAssignmentMechanism'] as PolicyAssignmentReceiptV1['reportedAssignmentMechanism'],
    reportedRandomizationCommitment: row['reportedRandomizationCommitment'] as string | null,
    reportedProbabilityDenominator: row['reportedProbabilityDenominator'] as number,
    reportedEligibleActions: actions,
    reportedSelectedActionId: row['reportedSelectedActionId'] as string,
    reportedActionSetDigest,
  };
  const assignmentDigest = shaTuple('ashlr:policy-assignment-receipt:v1', receiptBody(unsigned));
  if (!safeDigestEqual(row['assignmentDigest'] as string, assignmentDigest)) return null;
  const attestation = hmacTuple(key, 'ashlr:policy-assignment-attestation:v1', [
    assignmentDigest,
    ...receiptBody(unsigned),
  ]);
  if (!safeDigestEqual(row['attestation'] as string, attestation)) return null;
  return { ...unsigned, assignmentDigest, attestation };
}

export function createPolicyAssignmentReceipt(
  input: PolicyAssignmentReceiptInput,
): PolicyAssignmentReceiptV1 | null {
  try {
    const key = loadExistingProvenanceKey();
    return key ? createWithKey(input, key) : null;
  } catch {
    return null;
  }
}

export function verifyPolicyAssignmentReceipt(value: unknown): PolicyAssignmentReceiptV1 | null {
  try {
    const key = loadExistingProvenanceKeyReadOnly();
    return key ? reconstructWithKey(value, key) : null;
  } catch {
    return null;
  }
}

function receiptRoot(): string {
  return resolve(join(homedir(), '.ashlr', 'fleet', 'policy-assignment-receipts'));
}

export function policyAssignmentReceiptRootPath(): string {
  return receiptRoot();
}

function privateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
    (process.platform === 'win32' || (stat.mode & 0o777) === 0o700);
}

function privateFile(stat: Stats): boolean {
  return privateFileWithLinks(stat, 1);
}

function privateFileWithLinks(stat: Stats, expectedLinks: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === expectedLinks &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
    (process.platform === 'win32' || (stat.mode & 0o777) === 0o600);
}

function pinDirectories(home: string, fleet: string, receipts: string): ReceiptDirectories {
  const identities = [home, fleet, receipts].map((path): DirectoryIdentity => {
    const stat = lstatSync(path);
    if (!privateDirectory(stat)) throw new Error('unsafe policy assignment receipt directory');
    return { path, dev: stat.dev, ino: stat.ino };
  });
  return { home, fleet, receipts, identities };
}

function prepareDirectories(): ReceiptDirectories {
  const home = resolve(join(homedir(), '.ashlr'));
  const fleet = join(home, 'fleet');
  const receipts = join(fleet, 'policy-assignment-receipts');
  for (const path of [home, fleet, receipts]) {
    const created = !existsSync(path);
    if (created) mkdirSync(path, { recursive: true, mode: 0o700 });
    if (created && process.platform !== 'win32') chmodSync(path, 0o700);
    const stat = lstatSync(path);
    if (!privateDirectory(stat)) throw new Error('unsafe policy assignment receipt directory');
    const assurance = assurePrivateStoragePath(
      path,
      'directory',
      created ? 'secure-created' : 'inspect-existing',
      {
      anchorPath: homedir(),
      },
    );
    if (!assurance.ok) throw new Error(`unsafe policy assignment receipt directory: ${assurance.reason}`);
  }
  return pinDirectories(home, fleet, receipts);
}

function inspectDirectories(): ReceiptDirectories {
  const home = resolve(join(homedir(), '.ashlr'));
  const directories = pinDirectories(
    home,
    join(home, 'fleet'),
    join(home, 'fleet', 'policy-assignment-receipts'),
  );
  verifyDirectories(directories);
  for (const path of [directories.home, directories.fleet, directories.receipts]) {
    const assurance = assurePrivateStoragePath(path, 'directory', 'inspect-existing', {
      anchorPath: homedir(),
    });
    if (!assurance.ok) throw new Error(`unsafe policy assignment receipt directory: ${assurance.reason}`);
  }
  return directories;
}

function verifyDirectories(directories: ReceiptDirectories): void {
  for (const identity of directories.identities) {
    const stat = lstatSync(identity.path);
    if (!privateDirectory(stat) || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new Error('policy assignment receipt directory changed');
    }
  }
}

function receiptPath(unitId: string): string {
  return join(receiptRoot(), `${unitId}.json`);
}

function readReceiptFile(
  path: string,
  key: Buffer,
  anchorPath: string,
  expectedLinks = 1,
): PolicyAssignmentReceiptV1 | null {
  let fd: number | undefined;
  try {
    const assurance = assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath });
    if (!assurance.ok) return null;
    const before = lstatSync(path);
    if (!privateFileWithLinks(before, expectedLinks) ||
      before.size < 2 || before.size > MAX_RECEIPT_BYTES) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!privateFileWithLinks(opened, expectedLinks) ||
      opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size) return null;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    const after = fstatSync(fd);
    if (!privateFileWithLinks(after, expectedLinks) ||
      after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size) return null;
    const namedAfter = lstatSync(path);
    if (!privateFileWithLinks(namedAfter, expectedLinks) ||
      namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino ||
      namedAfter.size !== opened.size) return null;
    const finalAssurance = assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath });
    if (!finalAssurance.ok) return null;
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) return null;
    const reconstructed = reconstructWithKey(JSON.parse(text), key);
    return reconstructed && text === `${JSON.stringify(reconstructed)}\n`
      ? reconstructed
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function publicationStageToken(key: Buffer, receipt: PolicyAssignmentReceiptV1): string {
  return hmacTuple(key, 'ashlr:policy-assignment-publication-stage:v1', [
    receipt.assignmentUnitId,
  ]).slice(0, 32);
}

function publicationStagePath(
  directories: ReceiptDirectories,
  receipt: PolicyAssignmentReceiptV1,
  key: Buffer,
): string {
  return join(
    directories.receipts,
    `.${receipt.assignmentUnitId}.${publicationStageToken(key, receipt)}.stage`,
  );
}

/**
 * Complete only the exact publication interrupted around the hard-link
 * boundary. Recovery runs under the writer lock and mutates only the
 * host-keyed transaction slot for the expected assignment unit.
 */
function recoverInterruptedPublication(
  directories: ReceiptDirectories,
  target: string,
  expected: PolicyAssignmentReceiptV1,
  key: Buffer,
): 'none' | 'recovered' | 'conflicted' | 'failed' {
  try {
    verifyDirectories(directories);
    const stage = publicationStagePath(directories, expected, key);
    const temporary = `${stage}.tmp`;
    if (existsSync(temporary)) {
      if (existsSync(stage)) return 'failed';
      const temporaryIdentity = lstatSync(temporary);
      if (!privateFile(temporaryIdentity)) return 'failed';
      const temporaryReceipt = readReceiptFile(temporary, key, directories.home);
      if (temporaryReceipt) {
        if (temporaryReceipt.assignmentUnitId !== expected.assignmentUnitId ||
          !safeDigestEqual(temporaryReceipt.assignmentDigest, expected.assignmentDigest) ||
          !safeDigestEqual(temporaryReceipt.attestation, expected.attestation)) return 'conflicted';
        renameSync(temporary, stage);
        const installedStage = lstatSync(stage);
        if (!privateFile(installedStage) ||
          !sameIdentity(installedStage, temporaryIdentity)) return 'failed';
        fsyncDirectory(directories.receipts);
      } else {
        const installedTemporary = lstatSync(temporary);
        if (!privateFile(installedTemporary) ||
          !sameIdentity(installedTemporary, temporaryIdentity)) return 'failed';
        unlinkSync(temporary);
        fsyncDirectory(directories.receipts);
      }
    }
    if (!existsSync(stage)) return 'none';
    const targetPresent = existsSync(target);
    const expectedLinks = targetPresent ? 2 : 1;
    const stagedIdentity = lstatSync(stage);
    if (!privateFileWithLinks(stagedIdentity, expectedLinks)) return 'failed';
    if (targetPresent) {
      const targetIdentity = lstatSync(target);
      if (!privateFileWithLinks(targetIdentity, 2) ||
        !sameIdentity(stagedIdentity, targetIdentity)) return 'failed';
    }
    const staged = readReceiptFile(stage, key, directories.home, expectedLinks);
    if (!staged || staged.assignmentUnitId !== expected.assignmentUnitId) return 'failed';
    if (!safeDigestEqual(staged.assignmentDigest, expected.assignmentDigest) ||
      !safeDigestEqual(staged.attestation, expected.attestation)) return 'conflicted';

    if (!targetPresent) {
      linkSync(stage, target);
      const targetIdentity = lstatSync(target);
      const linkedStage = lstatSync(stage);
      if (!privateFileWithLinks(targetIdentity, 2) ||
        !privateFileWithLinks(linkedStage, 2) ||
        !sameIdentity(linkedStage, stagedIdentity) ||
        !sameIdentity(targetIdentity, linkedStage)) return 'failed';
      fsyncDirectory(directories.receipts);
    }
    const exactStage = lstatSync(stage);
    const exactTarget = lstatSync(target);
    if (!privateFileWithLinks(exactStage, 2) ||
      !privateFileWithLinks(exactTarget, 2) ||
      !sameIdentity(exactStage, stagedIdentity) ||
      !sameIdentity(exactStage, exactTarget)) return 'failed';
    unlinkSync(stage);
    fsyncDirectory(directories.receipts);
    verifyDirectories(directories);
    const recovered = readReceiptFile(target, key, directories.home);
    return recovered &&
      safeDigestEqual(recovered.assignmentDigest, expected.assignmentDigest) &&
      safeDigestEqual(recovered.attestation, expected.attestation)
      ? 'recovered'
      : 'failed';
  } catch {
    return 'failed';
  }
}

function publishReceiptWithoutClobber(
  directories: ReceiptDirectories,
  target: string,
  serialized: string,
  receipt: PolicyAssignmentReceiptV1,
  key: Buffer,
): 'published' | 'exists' {
  const stage = publicationStagePath(directories, receipt, key);
  const temporary = `${stage}.tmp`;
  let stagedIdentity: Stats | undefined;
  try {
    writePrivateFileAtomically(temporary, stage, serialized, {
      anchorPath: directories.home,
      label: 'policy assignment receipt stage',
    });
    stagedIdentity = lstatSync(stage);
    if (!privateFile(stagedIdentity)) throw new Error('unsafe policy assignment receipt stage');
    try {
      linkSync(stage, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw error;
    }
    const targetIdentity = lstatSync(target);
    if (!targetIdentity.isFile() || targetIdentity.isSymbolicLink() ||
      !sameIdentity(stagedIdentity, targetIdentity) || targetIdentity.nlink !== 2) {
      throw new Error('policy assignment receipt target changed during no-clobber publication');
    }
    fsyncDirectory(directories.receipts);
    unlinkSync(stage);
    stagedIdentity = undefined;
    fsyncDirectory(directories.receipts);
    const published = lstatSync(target);
    if (!privateFile(published) || !sameIdentity(targetIdentity, published)) {
      throw new Error('policy assignment receipt target changed after publication');
    }
    return 'published';
  } finally {
    if (stagedIdentity) {
      try {
        const installed = lstatSync(stage);
        if (sameIdentity(stagedIdentity, installed)) {
          unlinkSync(stage);
          fsyncDirectory(directories.receipts);
        }
      } catch {
        // Exact staged inode is already gone or cannot be safely removed.
      }
    }
  }
}

export function recordPolicyAssignmentReceipt(
  input: PolicyAssignmentReceiptInput,
  options: { lockWaitMs?: number } = {},
): PolicyAssignmentReceiptWriteDisposition {
  const lockWaitMs = options.lockWaitMs === undefined
    ? 2_000
    : Number.isFinite(options.lockWaitMs)
      ? Math.max(0, Math.min(2_000, Math.floor(options.lockWaitMs)))
      : null;
  if (lockWaitMs === null) return 'failed';
  let key: Buffer | null;
  try { key = loadExistingProvenanceKey(); } catch { return 'failed'; }
  if (!key) return 'failed';
  const receipt = createWithKey(input, key);
  if (!receipt) return 'invalid';
  let directories: ReceiptDirectories;
  try { directories = prepareDirectories(); } catch { return 'failed'; }
  const lock = acquireLocalStoreLock(
    join(directories.receipts, '.policy-assignment-receipts.lock'),
    lockWaitMs,
    { anchorPath: directories.home, exactPrivateStorage: true },
  );
  if (!lock) return 'failed';
  try {
    verifyDirectories(directories);
    const target = receiptPath(receipt.assignmentUnitId);
    const recovery = recoverInterruptedPublication(directories, target, receipt, key);
    if (recovery === 'recovered') return 'recorded';
    if (recovery === 'conflicted') return 'conflicted';
    if (recovery === 'failed') return 'failed';
    if (existsSync(target)) {
      const existing = readReceiptFile(target, key, directories.home);
      if (!existing) return 'failed';
      return safeDigestEqual(existing.assignmentDigest, receipt.assignmentDigest) &&
        safeDigestEqual(existing.attestation, receipt.attestation)
        ? 'replayed'
        : 'conflicted';
    }
    const serialized = `${JSON.stringify(receipt)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECEIPT_BYTES) return 'invalid';
    const publication = publishReceiptWithoutClobber(
      directories,
      target,
      serialized,
      receipt,
      key,
    );
    if (publication === 'exists') {
      const existing = readReceiptFile(target, key, directories.home);
      if (!existing) return 'failed';
      return safeDigestEqual(existing.assignmentDigest, receipt.assignmentDigest) &&
        safeDigestEqual(existing.attestation, receipt.attestation)
        ? 'replayed'
        : 'conflicted';
    }
    verifyDirectories(directories);
    const persisted = readReceiptFile(target, key, directories.home);
    return persisted &&
      safeDigestEqual(persisted.assignmentDigest, receipt.assignmentDigest) &&
      safeDigestEqual(persisted.attestation, receipt.attestation)
      ? 'recorded'
      : 'failed';
  } catch {
    return 'failed';
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function emptyRead(
  sourceState: PolicyAssignmentReceiptReadResult['sourceState'],
  overrides: Partial<PolicyAssignmentReceiptReadResult> = {},
): PolicyAssignmentReceiptReadResult {
  return {
    receipts: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState === 'healthy',
    denominatorComplete: false,
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    limitExceeded: false,
    ...overrides,
  };
}

function boundedLimit(value: number | undefined, fallback: number, hardMax: number): number | null {
  if (value === undefined) return fallback;
  return Number.isFinite(value)
    ? Math.max(0, Math.min(hardMax, Math.floor(value)))
    : null;
}

function boundedDirectoryEntries(path: string): { entries: string[]; overflow: boolean } {
  const directory = opendirSync(path);
  const entries: string[] = [];
  let overflow = false;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (entries.length >= HARD_MAX_DIRECTORY_ENTRIES) {
        overflow = true;
        break;
      }
      entries.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  entries.sort();
  return { entries, overflow };
}

export function readPolicyAssignmentReceipts(
  options: {
    maxFiles?: number;
    maxBytes?: number;
    requireComplete?: boolean;
  } = {},
): PolicyAssignmentReceiptReadResult {
  const root = receiptRoot();
  if (!existsSync(root)) return emptyRead('missing', { sourcePresent: false });
  let key: Buffer | null;
  try { key = loadExistingProvenanceKeyReadOnly(); } catch { key = null; }
  if (!key) {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['identity-key-unavailable'],
    });
  }
  let directories: ReceiptDirectories;
  try { directories = inspectDirectories(); } catch {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['unsafe-storage'],
    });
  }
  const maxFiles = boundedLimit(options.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES);
  const maxBytes = boundedLimit(options.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  if (maxFiles === null || maxBytes === null) {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['invalid-options'],
      limitExceeded: true,
    });
  }
  try {
    verifyDirectories(directories);
    const snapshotBefore = boundedDirectoryEntries(root);
    const entriesBefore = snapshotBefore.entries;
    const files = entriesBefore.filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
    const stopReasons = new Set<PolicyAssignmentReceiptReadStopReason>();
    if (snapshotBefore.overflow) stopReasons.add('file-limit');
    const writerActive = entriesBefore.includes('.policy-assignment-receipts.lock');
    if (writerActive) stopReasons.add('source-mutated');
    const unexpectedEntries = entriesBefore.filter((entry) =>
      entry !== '.policy-assignment-receipts.lock' && !/^[a-f0-9]{64}\.json$/.test(entry));
    if (unexpectedEntries.length > 0) stopReasons.add('invalid-file');
    if (files.length > maxFiles || files.length > HARD_MAX_FILES) stopReasons.add('file-limit');
    const selected = files.slice(0, maxFiles);
    const receipts: PolicyAssignmentReceiptV1[] = [];
    let filesRead = 0;
    let bytesRead = 0;
    let invalidFiles = unexpectedEntries.length + (snapshotBefore.overflow ? 1 : 0);
    for (const file of selected) {
      const path = join(root, file);
      let size = 0;
      try { size = lstatSync(path).size; } catch {
        invalidFiles += 1;
        stopReasons.add('io-error');
        continue;
      }
      if (size > MAX_RECEIPT_BYTES || bytesRead + size > maxBytes) {
        stopReasons.add('byte-limit');
        break;
      }
      bytesRead += size;
      filesRead += 1;
      const receipt = readReceiptFile(path, key, directories.home);
      if (!receipt || file !== `${receipt.assignmentUnitId}.json`) {
        invalidFiles += 1;
        stopReasons.add('invalid-file');
        continue;
      }
      receipts.push(receipt);
    }
    receipts.sort((left, right) =>
      left.reportedAssignedAt === right.reportedAssignedAt
        ? left.assignmentUnitId < right.assignmentUnitId ? -1 : 1
        : left.reportedAssignedAt < right.reportedAssignedAt ? -1 : 1);
    const snapshotAfter = boundedDirectoryEntries(root);
    if (snapshotAfter.overflow !== snapshotBefore.overflow ||
      JSON.stringify(snapshotAfter.entries) !== JSON.stringify(entriesBefore)) {
      stopReasons.add('source-mutated');
    }
    verifyDirectories(directories);
    const degraded = stopReasons.size > 0;
    return {
      receipts: options.requireComplete === true && degraded ? [] : receipts,
      sourceState: degraded ? 'degraded' : 'healthy',
      sourcePresent: true,
      complete: !degraded,
      denominatorComplete: false,
      stopReasons: [...stopReasons],
      filesRead,
      bytesRead,
      invalidFiles,
      limitExceeded: stopReasons.has('file-limit') || stopReasons.has('byte-limit'),
    };
  } catch {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['io-error'],
    });
  }
}
