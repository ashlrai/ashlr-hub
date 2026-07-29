/**
 * Signed, immutable, observation-only detached post-merge verification cohorts.
 *
 * The record deliberately excludes prompts, diffs, command output, environment,
 * and file contents. It cannot authorize merge, rollback, or deployment.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { loadExistingProvenanceKey } from '../foundry/provenance.js';
import type { RequiredVerificationManifest } from '../run/verification-manifest.js';
import type { VerifyFailureCategory } from '../run/verify-commands.js';
import type { RegressionGreenObservation } from './regression-sentinel.js';
import {
  readImmutablePrivateRecords,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadOptions,
  type ImmutablePrivateRecordReadResult,
  type ImmutablePrivateRecordStoreConfig,
  type ImmutablePrivateRecordWriteDisposition,
} from '../util/immutable-private-record-store.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const COHORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CAUSAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/#-]{0,239}$/;
const MAX_MEMBERS = 256;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 60 * 1_000;

const MEMBER_KEYS = new Set([
  'memberId', 'repoDigest', 'proposalId', 'baseBranch', 'baseHead',
  'candidateHead', 'mergeCommit', 'verifierManifestDigest',
  'requiredCommandCount', 'verifiedHead', 'verifiedAt', 'workspaceClean',
  'isolation', 'sourceState', 'terminal',
  'failureCategory', 'unknownReason', 'runId', 'trajectoryId', 'workItemId',
  'memberDigest',
]);

const COHORT_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'policyEligible',
  'mergePermitted', 'rollbackPermitted', 'deployPermitted', 'cohortId',
  'observedAt', 'expectedMemberCount', 'memberCount', 'passCount',
  'failCount', 'unknownCount', 'denominatorComplete', 'conclusiveComplete',
  'members', 'cohortDigest', 'attestation',
]);

export type DetachedPostMergeTerminal = 'pass' | 'fail' | 'unknown';
export type DetachedPostMergeSourceState = 'healthy' | 'missing' | 'degraded' | 'stale';
export type DetachedPostMergeUnknownReason =
  | 'missing-evidence'
  | 'stale-evidence'
  | 'degraded-source'
  | 'binding-mismatch'
  | 'isolation-unproven'
  | 'verification-infrastructure';

export interface DetachedPostMergeVerificationMember {
  memberId: string;
  /** HMAC of the canonical absolute repository path; the path is never persisted. */
  repoDigest: string;
  /** Domain-separated HMAC of the caller-supplied proposal identifier. */
  proposalId: string;
  /** Domain-separated HMAC of the branch name; branch text is never persisted. */
  baseBranch: string;
  baseHead: string;
  candidateHead: string;
  mergeCommit: string;
  verifierManifestDigest: string;
  requiredCommandCount: number;
  verifiedHead: string | null;
  verifiedAt: string | null;
  workspaceClean: true | null;
  isolation: 'detached-worktree' | null;
  sourceState: DetachedPostMergeSourceState;
  terminal: DetachedPostMergeTerminal;
  failureCategory: VerifyFailureCategory | null;
  unknownReason: DetachedPostMergeUnknownReason | null;
  /** Domain-separated HMAC pseudonyms; caller-supplied causal text is never persisted. */
  runId: string | null;
  trajectoryId: string | null;
  workItemId: string | null;
  memberDigest: string;
}

export interface DetachedPostMergeVerificationCohort {
  schemaVersion: 1;
  recordType: 'detached-post-merge-verification-cohort';
  authority: 'observation-only';
  policyEligible: false;
  mergePermitted: false;
  rollbackPermitted: false;
  deployPermitted: false;
  cohortId: string;
  observedAt: string;
  expectedMemberCount: number;
  memberCount: number;
  passCount: number;
  failCount: number;
  unknownCount: number;
  denominatorComplete: boolean;
  conclusiveComplete: boolean;
  members: DetachedPostMergeVerificationMember[];
  cohortDigest: string;
  attestation: string;
}

export interface DetachedPostMergeVerificationMemberInput {
  repo: string;
  proposalId: string;
  baseBranch: string;
  baseHead: string;
  candidateHead: string;
  mergeCommit: string;
  verifierManifest: RequiredVerificationManifest;
  sourceState: Exclude<DetachedPostMergeSourceState, 'stale'>;
  terminal?: Exclude<DetachedPostMergeTerminal, 'unknown'>;
  verifiedHead?: string;
  verifiedAt?: string;
  workspaceClean?: boolean;
  isolation?: RegressionGreenObservation['isolation'];
  failureCategory?: VerifyFailureCategory;
  runId?: string;
  trajectoryId?: string;
  workItemId?: string;
}

export interface DetachedPostMergeVerificationCohortInput {
  cohortId: string;
  observedAt: string;
  expectedMemberCount: number;
  members: DetachedPostMergeVerificationMemberInput[];
}

export interface DetachedPostMergeVerificationSummary {
  cohorts: number;
  denominatorCompleteCohorts: number;
  conclusiveCompleteCohorts: number;
  expectedMembers: number;
  observedMembers: number;
  pass: number;
  fail: number;
  unknown: number;
}

export interface DetachedPostMergeVerificationReadResult extends
  Omit<ImmutablePrivateRecordReadResult<DetachedPostMergeVerificationCohort>, 'records'> {
  cohorts: DetachedPostMergeVerificationCohort[];
  summary: DetachedPostMergeVerificationSummary;
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function noControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function canonicalRepo(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096 ||
    !noControlCharacters(value)) return null;
  try { return resolve(value); } catch { return null; }
}

function canonicalBranch(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024 ||
    value === '@' || value.startsWith('/') || value.endsWith('/') ||
    value.endsWith('.') || value.includes('..') || value.includes('@{') ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 32 || code === 127 || '~^:?*[\\'.includes(char);
    })) return null;
  const parts = value.split('/');
  return parts.some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
    ? null
    : value;
}

function canonicalCausalId(value: unknown): string | null {
  return typeof value === 'string' && CAUSAL_ID_RE.test(value) ? value : null;
}

function optionalCausalId(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  return canonicalCausalId(value) ?? undefined;
}

function sha(domain: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function hmac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function sameDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function memberPayload(
  member: Omit<DetachedPostMergeVerificationMember, 'memberDigest'>,
): unknown[] {
  return [
    member.memberId, member.repoDigest, member.proposalId, member.baseBranch,
    member.baseHead, member.candidateHead, member.mergeCommit,
    member.verifierManifestDigest, member.requiredCommandCount,
    member.verifiedHead, member.verifiedAt, member.workspaceClean,
    member.isolation, member.sourceState, member.terminal,
    member.failureCategory, member.unknownReason, member.runId,
    member.trajectoryId, member.workItemId,
  ];
}

function memberIdentity(
  member: Pick<DetachedPostMergeVerificationMember,
    'repoDigest' | 'proposalId' | 'baseBranch' | 'baseHead' | 'candidateHead' |
    'mergeCommit' | 'verifierManifestDigest'>,
): unknown[] {
  return [
    member.repoDigest, member.proposalId, member.baseBranch, member.baseHead,
    member.candidateHead, member.mergeCommit, member.verifierManifestDigest,
  ];
}

function evidenceFresh(verifiedAt: string, observedAt: string): boolean {
  const verifiedMs = Date.parse(verifiedAt);
  const observedMs = Date.parse(observedAt);
  return verifiedMs <= observedMs + MAX_FUTURE_SKEW_MS &&
    observedMs - verifiedMs <= MAX_EVIDENCE_AGE_MS;
}

function validManifest(value: unknown): value is RequiredVerificationManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return Object.keys(manifest).length === 2 &&
    SHA256_RE.test(String(manifest['digest'] ?? '')) &&
    Number.isSafeInteger(manifest['commandCount']) &&
    Number(manifest['commandCount']) > 0;
}

function buildMember(
  input: DetachedPostMergeVerificationMemberInput,
  observedAt: string,
  key: Buffer,
): DetachedPostMergeVerificationMember | null {
  const repo = canonicalRepo(input.repo);
  const proposalId = canonicalCausalId(input.proposalId);
  const baseBranch = canonicalBranch(input.baseBranch);
  const runId = optionalCausalId(input.runId);
  const trajectoryId = optionalCausalId(input.trajectoryId);
  const workItemId = optionalCausalId(input.workItemId);
  if (!repo || !proposalId || !baseBranch || !GIT_SHA_RE.test(input.baseHead) ||
    !GIT_SHA_RE.test(input.candidateHead) || !GIT_SHA_RE.test(input.mergeCommit) ||
    !validManifest(input.verifierManifest) || runId === undefined ||
    trajectoryId === undefined || workItemId === undefined ||
    !['healthy', 'missing', 'degraded'].includes(input.sourceState)) return null;

  const suppliedVerifiedAt = input.verifiedAt === undefined
    ? null
    : canonicalTimestamp(input.verifiedAt);
  if (input.verifiedAt !== undefined && suppliedVerifiedAt === null) return null;

  let sourceState: DetachedPostMergeSourceState = input.sourceState;
  let terminal: DetachedPostMergeTerminal = 'unknown';
  let failureCategory: VerifyFailureCategory | null = null;
  let unknownReason: DetachedPostMergeUnknownReason | null = null;
  let verifiedAt = suppliedVerifiedAt;
  let verifiedHead = input.verifiedHead ?? null;
  let workspaceClean: true | null = input.workspaceClean === true ? true : null;
  let isolation: 'detached-worktree' | null =
    input.isolation === 'detached-worktree' ? 'detached-worktree' : null;

  if (sourceState === 'missing') {
    verifiedHead = null;
    verifiedAt = null;
    workspaceClean = null;
    isolation = null;
    unknownReason = 'missing-evidence';
  } else if (sourceState === 'degraded') {
    verifiedHead = null;
    verifiedAt = null;
    workspaceClean = null;
    isolation = null;
    unknownReason = 'degraded-source';
  } else if (verifiedAt === null || verifiedHead === null) {
    sourceState = 'missing';
    verifiedHead = null;
    verifiedAt = null;
    workspaceClean = null;
    isolation = null;
    unknownReason = 'missing-evidence';
  } else if (!evidenceFresh(verifiedAt, observedAt)) {
    sourceState = 'stale';
    unknownReason = 'stale-evidence';
  } else if (!GIT_SHA_RE.test(verifiedHead) || verifiedHead !== input.mergeCommit) {
    unknownReason = 'binding-mismatch';
  } else if (input.workspaceClean !== true || input.isolation !== 'detached-worktree') {
    unknownReason = 'isolation-unproven';
  } else if (input.terminal === 'pass') {
    terminal = 'pass';
  } else if (input.terminal === 'fail' && input.failureCategory === 'code') {
    terminal = 'fail';
    failureCategory = 'code';
  } else {
    unknownReason = 'verification-infrastructure';
    failureCategory = input.failureCategory ?? null;
  }

  const repoDigest = hmac(key, 'ashlr:detached-post-merge-verification:repo:v1', repo);
  const identity = {
    repoDigest,
    proposalId: hmac(
      key,
      'ashlr:detached-post-merge-verification:proposal:v1',
      proposalId,
    ),
    baseBranch: hmac(
      key,
      'ashlr:detached-post-merge-verification:base-branch:v1',
      baseBranch,
    ),
    baseHead: input.baseHead,
    candidateHead: input.candidateHead,
    mergeCommit: input.mergeCommit,
    verifierManifestDigest: input.verifierManifest.digest,
  };
  const memberId = sha('ashlr:detached-post-merge-verification:member-id:v1', memberIdentity(identity));
  const unsigned: Omit<DetachedPostMergeVerificationMember, 'memberDigest'> = {
    memberId,
    ...identity,
    requiredCommandCount: input.verifierManifest.commandCount,
    verifiedHead,
    verifiedAt,
    workspaceClean,
    isolation,
    sourceState,
    terminal,
    failureCategory,
    unknownReason,
    runId: runId === null
      ? null
      : hmac(key, 'ashlr:detached-post-merge-verification:run:v1', runId),
    trajectoryId: trajectoryId === null
      ? null
      : hmac(key, 'ashlr:detached-post-merge-verification:trajectory:v1', trajectoryId),
    workItemId: workItemId === null
      ? null
      : hmac(key, 'ashlr:detached-post-merge-verification:work-item:v1', workItemId),
  };
  return {
    ...unsigned,
    memberDigest: sha('ashlr:detached-post-merge-verification:member:v1', memberPayload(unsigned)),
  };
}

function validMember(value: unknown, observedAt: string): value is DetachedPostMergeVerificationMember {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const member = value as Record<string, unknown>;
  if (!exactKeys(member, MEMBER_KEYS) ||
    !SHA256_RE.test(String(member['memberId'] ?? '')) ||
    !SHA256_RE.test(String(member['repoDigest'] ?? '')) ||
    !SHA256_RE.test(String(member['proposalId'] ?? '')) ||
    !SHA256_RE.test(String(member['baseBranch'] ?? '')) ||
    !GIT_SHA_RE.test(String(member['baseHead'] ?? '')) ||
    !GIT_SHA_RE.test(String(member['candidateHead'] ?? '')) ||
    !GIT_SHA_RE.test(String(member['mergeCommit'] ?? '')) ||
    !SHA256_RE.test(String(member['verifierManifestDigest'] ?? '')) ||
    !Number.isSafeInteger(member['requiredCommandCount']) ||
    Number(member['requiredCommandCount']) < 1 ||
    !['healthy', 'missing', 'degraded', 'stale'].includes(String(member['sourceState'])) ||
    !['pass', 'fail', 'unknown'].includes(String(member['terminal']))) return false;

  const typed = member as unknown as DetachedPostMergeVerificationMember;
  const optionalIds = [typed.runId, typed.trajectoryId, typed.workItemId];
  if (optionalIds.some((id) => id !== null && !SHA256_RE.test(id))) return false;
  if (typed.verifiedHead !== null && !GIT_SHA_RE.test(typed.verifiedHead)) return false;
  if (typed.verifiedAt !== null && canonicalTimestamp(typed.verifiedAt) === null) return false;
  if (typed.workspaceClean !== null && typed.workspaceClean !== true) return false;
  if (typed.isolation !== null && typed.isolation !== 'detached-worktree') return false;

  const conclusive = typed.terminal === 'pass' || typed.terminal === 'fail';
  if (conclusive && (typed.sourceState !== 'healthy' || typed.verifiedAt === null ||
    typed.verifiedHead !== typed.mergeCommit || typed.workspaceClean !== true ||
    typed.isolation !== 'detached-worktree' ||
    !evidenceFresh(typed.verifiedAt, observedAt) || typed.unknownReason !== null)) return false;
  if (typed.terminal === 'pass' && typed.failureCategory !== null) return false;
  if (typed.terminal === 'fail' && typed.failureCategory !== 'code') return false;
  if (typed.terminal === 'unknown' && ![
    'missing-evidence', 'stale-evidence', 'degraded-source', 'binding-mismatch',
    'isolation-unproven', 'verification-infrastructure',
  ].includes(String(typed.unknownReason))) return false;
  if (typed.sourceState === 'missing' &&
    (typed.terminal !== 'unknown' || typed.verifiedHead !== null || typed.verifiedAt !== null ||
      typed.workspaceClean !== null || typed.isolation !== null ||
      typed.unknownReason !== 'missing-evidence')) return false;
  if (typed.sourceState === 'degraded' &&
    (typed.terminal !== 'unknown' || typed.verifiedHead !== null || typed.verifiedAt !== null ||
      typed.workspaceClean !== null || typed.isolation !== null ||
      typed.unknownReason !== 'degraded-source')) return false;
  if (typed.sourceState === 'stale' &&
    (typed.terminal !== 'unknown' || typed.verifiedAt === null ||
      evidenceFresh(typed.verifiedAt, observedAt) || typed.unknownReason !== 'stale-evidence')) return false;
  if (typed.sourceState === 'healthy' && typed.terminal === 'unknown' &&
    !['binding-mismatch', 'isolation-unproven', 'verification-infrastructure']
      .includes(String(typed.unknownReason))) return false;

  const expectedId = sha(
    'ashlr:detached-post-merge-verification:member-id:v1',
    memberIdentity(typed),
  );
  const expectedDigest = sha(
    'ashlr:detached-post-merge-verification:member:v1',
    memberPayload(typed),
  );
  return sameDigest(typed.memberId, expectedId) &&
    sameDigest(typed.memberDigest, expectedDigest);
}

function cohortPayload(
  cohort: Omit<DetachedPostMergeVerificationCohort, 'cohortDigest' | 'attestation'>,
): unknown[] {
  return [
    cohort.schemaVersion, cohort.recordType, cohort.authority,
    cohort.policyEligible, cohort.mergePermitted, cohort.rollbackPermitted,
    cohort.deployPermitted, cohort.cohortId, cohort.observedAt,
    cohort.expectedMemberCount, cohort.memberCount, cohort.passCount,
    cohort.failCount, cohort.unknownCount, cohort.denominatorComplete,
    cohort.conclusiveComplete, cohort.members,
  ];
}

function parseCohort(
  value: unknown,
  key: Buffer,
): DetachedPostMergeVerificationCohort | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, COHORT_KEYS) || row['schemaVersion'] !== 1 ||
    row['recordType'] !== 'detached-post-merge-verification-cohort' ||
    row['authority'] !== 'observation-only' || row['policyEligible'] !== false ||
    row['mergePermitted'] !== false || row['rollbackPermitted'] !== false ||
    row['deployPermitted'] !== false || !SHA256_RE.test(String(row['cohortId'] ?? '')) ||
    canonicalTimestamp(row['observedAt']) === null ||
    !Number.isSafeInteger(row['expectedMemberCount']) ||
    Number(row['expectedMemberCount']) < 1 ||
    Number(row['expectedMemberCount']) > MAX_MEMBERS ||
    !Array.isArray(row['members']) || row['members'].length < 1 ||
    row['members'].length > MAX_MEMBERS) return null;

  const cohort = row as unknown as DetachedPostMergeVerificationCohort;
  if (!cohort.members.every((member) => validMember(member, cohort.observedAt))) return null;
  const memberIds = cohort.members.map((member) => member.memberId);
  if (new Set(memberIds).size !== memberIds.length ||
    memberIds.some((id, index) => index > 0 && memberIds[index - 1]! >= id)) return null;

  const passCount = cohort.members.filter((member) => member.terminal === 'pass').length;
  const failCount = cohort.members.filter((member) => member.terminal === 'fail').length;
  const unknownCount = cohort.members.filter((member) => member.terminal === 'unknown').length;
  const denominatorComplete = cohort.members.length === cohort.expectedMemberCount;
  const conclusiveComplete = denominatorComplete && unknownCount === 0;
  if (cohort.memberCount !== cohort.members.length ||
    cohort.passCount !== passCount || cohort.failCount !== failCount ||
    cohort.unknownCount !== unknownCount ||
    cohort.denominatorComplete !== denominatorComplete ||
    cohort.conclusiveComplete !== conclusiveComplete) return null;

  const unsigned = {
    ...cohort,
    cohortDigest: undefined,
    attestation: undefined,
  };
  delete unsigned.cohortDigest;
  delete unsigned.attestation;
  const expectedDigest = sha(
    'ashlr:detached-post-merge-verification:cohort:v1',
    cohortPayload(unsigned),
  );
  const expectedAttestation = hmac(
    key,
    'ashlr:detached-post-merge-verification:attestation:v1',
    expectedDigest,
  );
  return sameDigest(cohort.cohortDigest, expectedDigest) &&
    sameDigest(cohort.attestation, expectedAttestation)
    ? cohort
    : null;
}

function codec(key: Buffer): ImmutablePrivateRecordCodec<DetachedPostMergeVerificationCohort> {
  return {
    parse: (value) => parseCohort(value, key),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.cohortId,
    recordFileName: (record) => `${record.cohortId}.json`,
    isRecordFileName: (fileName) =>
      fileName.endsWith('.json') && SHA256_RE.test(fileName.slice(0, -5)),
    stageToken: (record) => record.cohortDigest,
    equivalent: (left, right) => sameDigest(left.cohortDigest, right.cohortDigest),
    compare: (left, right) =>
      left.observedAt.localeCompare(right.observedAt) || left.cohortId.localeCompare(right.cohortId),
  };
}

function storageHome(): string {
  const configured = process.env.ASHLR_HOME;
  if (typeof configured === 'string' && configured.trim() !== '' &&
    isAbsolute(configured) && noControlCharacters(configured)) {
    try { return resolve(configured); } catch { /* use private default */ }
  }
  return resolve(join(homedir(), '.ashlr'));
}

export function detachedPostMergeVerificationStorePath(): string {
  return join(storageHome(), 'detached-post-merge-verification');
}

function storeConfig(): ImmutablePrivateRecordStoreConfig<DetachedPostMergeVerificationCohort> {
  const home = storageHome();
  return {
    label: 'detached post-merge verification cohort',
    anchorPath: home,
    rootPath: detachedPostMergeVerificationStorePath(),
    lockFileName: '.detached-post-merge-verification.lock',
    maxRecordBytes: 512 * 1_024,
    defaultMaxFiles: 2_048,
    hardMaxFiles: 25_000,
    defaultMaxBytes: 32 * 1_024 * 1_024,
    hardMaxBytes: 256 * 1_024 * 1_024,
    codecForWrite: () => {
      const key = loadExistingProvenanceKey();
      return key ? codec(key) : null;
    },
    codecForRead: () => {
      const key = loadExistingProvenanceKey();
      return key ? codec(key) : null;
    },
  };
}

export function buildDetachedPostMergeVerificationCohort(
  input: DetachedPostMergeVerificationCohortInput,
): DetachedPostMergeVerificationCohort | null {
  try {
    const key = loadExistingProvenanceKey();
    const observedAt = canonicalTimestamp(input.observedAt);
    if (!key || !observedAt || !COHORT_ID_RE.test(input.cohortId) ||
      !Number.isSafeInteger(input.expectedMemberCount) ||
      input.expectedMemberCount < 1 || input.expectedMemberCount > MAX_MEMBERS ||
      !Array.isArray(input.members) || input.members.length < 1 ||
      input.members.length > input.expectedMemberCount ||
      input.members.length > MAX_MEMBERS) return null;

    const members = input.members
      .map((member) => buildMember(member, observedAt, key))
      .filter((member): member is DetachedPostMergeVerificationMember => member !== null)
      .sort((left, right) => left.memberId.localeCompare(right.memberId));
    if (members.length !== input.members.length ||
      new Set(members.map((member) => member.memberId)).size !== members.length) return null;

    const passCount = members.filter((member) => member.terminal === 'pass').length;
    const failCount = members.filter((member) => member.terminal === 'fail').length;
    const unknownCount = members.filter((member) => member.terminal === 'unknown').length;
    const denominatorComplete = members.length === input.expectedMemberCount;
    const unsigned: Omit<DetachedPostMergeVerificationCohort, 'cohortDigest' | 'attestation'> = {
      schemaVersion: 1,
      recordType: 'detached-post-merge-verification-cohort',
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      cohortId: hmac(
        key,
        'ashlr:detached-post-merge-verification:cohort-id:v1',
        input.cohortId,
      ),
      observedAt,
      expectedMemberCount: input.expectedMemberCount,
      memberCount: members.length,
      passCount,
      failCount,
      unknownCount,
      denominatorComplete,
      conclusiveComplete: denominatorComplete && unknownCount === 0,
      members,
    };
    const cohortDigest = sha(
      'ashlr:detached-post-merge-verification:cohort:v1',
      cohortPayload(unsigned),
    );
    return {
      ...unsigned,
      cohortDigest,
      attestation: hmac(
        key,
        'ashlr:detached-post-merge-verification:attestation:v1',
        cohortDigest,
      ),
    };
  } catch {
    return null;
  }
}

export function recordDetachedPostMergeVerificationCohort(
  input: DetachedPostMergeVerificationCohortInput,
): ImmutablePrivateRecordWriteDisposition {
  const cohort = buildDetachedPostMergeVerificationCohort(input);
  return cohort === null
    ? 'invalid'
    : writeImmutablePrivateRecord(storeConfig(), cohort);
}

function emptySummary(): DetachedPostMergeVerificationSummary {
  return {
    cohorts: 0,
    denominatorCompleteCohorts: 0,
    conclusiveCompleteCohorts: 0,
    expectedMembers: 0,
    observedMembers: 0,
    pass: 0,
    fail: 0,
    unknown: 0,
  };
}

export function readDetachedPostMergeVerificationCohorts(
  options: ImmutablePrivateRecordReadOptions = {},
): DetachedPostMergeVerificationReadResult {
  const result = readImmutablePrivateRecords(storeConfig(), options);
  const cohorts = result.records;
  const summary = cohorts.reduce<DetachedPostMergeVerificationSummary>((acc, cohort) => {
    acc.cohorts += 1;
    acc.denominatorCompleteCohorts += Number(cohort.denominatorComplete);
    acc.conclusiveCompleteCohorts += Number(cohort.conclusiveComplete);
    acc.expectedMembers += cohort.expectedMemberCount;
    acc.observedMembers += cohort.memberCount;
    acc.pass += cohort.passCount;
    acc.fail += cohort.failCount;
    acc.unknown += cohort.unknownCount;
    return acc;
  }, emptySummary());
  const { records: _records, ...source } = result;
  return { ...source, cohorts, summary };
}
