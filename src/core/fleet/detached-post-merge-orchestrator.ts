/**
 * Observation-only scheduler for detached post-merge verification.
 *
 * Each invocation binds the complete set of authenticated, enrolled GitHub
 * merges and emits at most one immutable work ticket for a future sandbox
 * executor. This module never runs repository code. Denominators and tickets
 * grant no verification, merge, rollback, deployment, routing, or policy authority.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { Proposal, RealizedMergeEvidence } from '../types.js';
import { loadExistingProvenanceKey } from '../foundry/provenance.js';
import { listProposalsDetailed, type ProposalsReadResult } from '../inbox/store.js';
import { authenticatedRealizedMergeOf } from '../inbox/realized-merge.js';
import {
  readEnrollmentRegistry,
  type EnrollmentRegistrySnapshot,
} from '../sandbox/policy.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import {
  readImmutablePrivateRecords,
  readImmutablePrivateRecordPoint,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadOptions,
  type ImmutablePrivateRecordReadResult,
  type ImmutablePrivateRecordStoreConfig,
  type ImmutablePrivateRecordWriteDisposition,
} from '../util/immutable-private-record-store.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import {
  buildDetachedPostMergeCandidateIdentity,
  detachedPostMergeCandidateIdForMember,
  readDetachedPostMergeVerificationCohorts,
  type DetachedPostMergeVerificationReadResult,
} from './detached-post-merge-verification.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const MAX_CANDIDATES = 4_096;
const MAX_POINTER_BYTES = 16 * 1_024;
const DENOMINATOR_MAX_AGE_MS = 15 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 60 * 1_000;

const DENOMINATOR_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'policyEligible', 'mergePermitted',
  'rollbackPermitted', 'deployPermitted', 'capturedAt', 'denominatorId',
  'proposalSourceDigest', 'enrollmentSourceDigest', 'candidateSetDigest',
  'expectedCandidateCount', 'denominatorComplete', 'candidateIds',
  'denominatorDigest', 'attestation',
]);
const POINTER_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'policyEligible', 'mergePermitted',
  'rollbackPermitted', 'deployPermitted', 'denominatorId', 'proposalSourceDigest',
  'enrollmentSourceDigest', 'candidateSetDigest', 'updatedAt', 'attestation',
]);
const TICKET_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'policyEligible', 'executionPermitted',
  'mergePermitted', 'rollbackPermitted', 'deployPermitted', 'queuedAt', 'ticketId',
  'denominatorId', 'proposalSourceDigest', 'enrollmentSourceDigest',
  'candidateSetDigest', 'candidateId', 'ticketDigest', 'attestation',
]);

export type DetachedPostMergeOrchestratorReason =
  | 'ticket-recorded'
  | 'ticket-replayed'
  | 'no-eligible-candidates'
  | 'all-candidates-observed'
  | 'proposal-source-unavailable'
  | 'enrollment-source-unavailable'
  | 'identity-key-unavailable'
  | 'source-changed'
  | 'observation-source-unavailable'
  | 'duplicate-candidate'
  | 'invalid-candidate'
  | 'orchestrator-busy'
  | 'cancelled'
  | 'denominator-record-failed'
  | 'denominator-pointer-failed'
  | 'ticket-record-failed';

export interface DetachedPostMergeDenominatorReceiptV1 {
  schemaVersion: 1;
  recordType: 'detached-post-merge-denominator';
  authority: 'observation-only';
  policyEligible: false;
  mergePermitted: false;
  rollbackPermitted: false;
  deployPermitted: false;
  capturedAt: string;
  denominatorId: string;
  proposalSourceDigest: string;
  enrollmentSourceDigest: string;
  candidateSetDigest: string;
  expectedCandidateCount: number;
  denominatorComplete: true;
  candidateIds: string[];
  denominatorDigest: string;
  attestation: string;
}

interface DetachedPostMergeDenominatorPointerV1 {
  schemaVersion: 1;
  recordType: 'detached-post-merge-denominator-current';
  authority: 'observation-only';
  policyEligible: false;
  mergePermitted: false;
  rollbackPermitted: false;
  deployPermitted: false;
  denominatorId: string;
  proposalSourceDigest: string;
  enrollmentSourceDigest: string;
  candidateSetDigest: string;
  updatedAt: string;
  attestation: string;
}

export interface DetachedPostMergeWorkTicketV1 {
  schemaVersion: 1;
  recordType: 'detached-post-merge-work-ticket';
  authority: 'observation-only';
  policyEligible: false;
  executionPermitted: false;
  mergePermitted: false;
  rollbackPermitted: false;
  deployPermitted: false;
  queuedAt: string;
  ticketId: string;
  denominatorId: string;
  proposalSourceDigest: string;
  enrollmentSourceDigest: string;
  candidateSetDigest: string;
  candidateId: string;
  ticketDigest: string;
  attestation: string;
}

export interface DetachedPostMergeWorkTicketReadResult extends
  Omit<ImmutablePrivateRecordReadResult<DetachedPostMergeWorkTicketV1>, 'records'> {
  tickets: DetachedPostMergeWorkTicketV1[];
}

export interface DetachedPostMergeCurrentDenominatorReadResult {
  receipt: DetachedPostMergeDenominatorReceiptV1 | null;
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: string[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
}

export interface DetachedPostMergeDenominatorProjection {
  eligibleCandidates: number;
  observedCandidates: number;
  conclusiveCandidates: number;
  unobservedCandidates: number;
  pass: number;
  fail: number;
  unknown: number;
  queuedCandidates: number;
  latestObservedAt: string | null;
  passRate: number | null;
}

export interface DetachedPostMergeOrchestratorResult {
  schemaVersion: 1;
  authority: 'observation-only';
  policyEligible: false;
  mergePermitted: false;
  rollbackPermitted: false;
  deployPermitted: false;
  disposition: 'queued' | 'idle' | 'refused';
  reason: DetachedPostMergeOrchestratorReason;
  candidateSetDigest: string | null;
  eligibleCandidateCount: number;
  observedCandidateCount: number;
  selectedCandidateId: string | null;
  denominatorDisposition: ImmutablePrivateRecordWriteDisposition | 'not-recorded';
  ticketDisposition: ImmutablePrivateRecordWriteDisposition | 'not-recorded';
  ticketId: string | null;
}

interface Candidate {
  candidateId: string;
  repo: string;
  proposalId: string;
  baseBranch: string;
  candidateHead: string;
  mergeCommit: string;
  mergedAt: string;
  runId?: string;
  trajectoryId?: string;
  workItemId?: string;
}

interface CandidateSnapshot {
  proposalSourceDigest: string;
  enrollmentSourceDigest: string;
  candidateSetDigest: string;
  denominatorId: string;
  candidates: Candidate[];
}

type CandidateSnapshotResult =
  | { ok: true; snapshot: CandidateSnapshot }
  | { ok: false; reason: Extract<DetachedPostMergeOrchestratorReason,
      'proposal-source-unavailable' | 'enrollment-source-unavailable' |
      'identity-key-unavailable' | 'duplicate-candidate' | 'invalid-candidate'> };

interface CandidateSourceDependencies {
  now: () => Date;
  identityKey: () => Buffer | null;
  readProposals: () => ProposalsReadResult;
  readEnrollment: () => EnrollmentRegistrySnapshot;
  authenticateMerge: (proposal: Proposal) => RealizedMergeEvidence | null;
}

interface OrchestratorDependencies extends CandidateSourceDependencies {
  readObservations: () => DetachedPostMergeVerificationReadResult;
  onPhase?: (phase: 'after-first-source' | 'after-second-source' | 'before-ticket') => void;
}

export interface DetachedPostMergeOrchestratorOptions {
  signal?: AbortSignal;
  /** Adversarial tests only; production callers leave dependency seams unset. */
  _dependencies?: Partial<OrchestratorDependencies>;
}

export interface DetachedPostMergeDenominatorReadOptions {
  maxAgeMs?: number;
  /** Adversarial tests only; production callers recompute from live stores. */
  _dependencies?: Partial<CandidateSourceDependencies>;
}

function sha(domain: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function hmac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalRepo(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096) return null;
  try {
    const canonical = resolve(value);
    return canonical === value ? canonical : null;
  } catch {
    return null;
  }
}

function physicalRepoOrLexical(repo: string): string {
  try {
    const stat = lstatSync(repo, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) return repo;
    return realpathSync.native(repo);
  } catch {
    return repo;
  }
}

function result(
  overrides: Partial<DetachedPostMergeOrchestratorResult>,
): DetachedPostMergeOrchestratorResult {
  return {
    schemaVersion: 1,
    authority: 'observation-only',
    policyEligible: false,
    mergePermitted: false,
    rollbackPermitted: false,
    deployPermitted: false,
    disposition: 'refused',
    reason: 'ticket-record-failed',
    candidateSetDigest: null,
    eligibleCandidateCount: 0,
    observedCandidateCount: 0,
    selectedCandidateId: null,
    denominatorDisposition: 'not-recorded',
    ticketDisposition: 'not-recorded',
    ticketId: null,
    ...overrides,
  };
}

function storageHome(): string {
  const configured = process.env.ASHLR_HOME;
  if (typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)) {
    return resolve(configured);
  }
  return resolve(join(homedir(), '.ashlr'));
}

export function detachedPostMergeDenominatorStorePath(): string {
  return join(storageHome(), 'detached-post-merge-denominators');
}

export function detachedPostMergeDenominatorPointerPath(): string {
  return join(storageHome(), 'detached-post-merge-denominator-current.json');
}

export function detachedPostMergeWorkTicketStorePath(): string {
  return join(storageHome(), 'detached-post-merge-work-tickets');
}

function ticketPayload(
  ticket: Omit<DetachedPostMergeWorkTicketV1, 'ticketDigest' | 'attestation'>,
): unknown[] {
  return [
    ticket.schemaVersion, ticket.recordType, ticket.authority, ticket.policyEligible,
    ticket.executionPermitted, ticket.mergePermitted, ticket.rollbackPermitted,
    ticket.deployPermitted, ticket.queuedAt, ticket.ticketId, ticket.denominatorId,
    ticket.proposalSourceDigest, ticket.enrollmentSourceDigest,
    ticket.candidateSetDigest, ticket.candidateId,
  ];
}

function parseWorkTicket(value: unknown, key: Buffer): DetachedPostMergeWorkTicketV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, TICKET_KEYS) || row['schemaVersion'] !== 1 ||
    row['recordType'] !== 'detached-post-merge-work-ticket' ||
    row['authority'] !== 'observation-only' || row['policyEligible'] !== false ||
    row['executionPermitted'] !== false || row['mergePermitted'] !== false ||
    row['rollbackPermitted'] !== false || row['deployPermitted'] !== false ||
    !canonicalTimestamp(row['queuedAt']) || !SHA256_RE.test(String(row['ticketId'])) ||
    !SHA256_RE.test(String(row['denominatorId'])) ||
    !SHA256_RE.test(String(row['proposalSourceDigest'])) ||
    !SHA256_RE.test(String(row['enrollmentSourceDigest'])) ||
    !SHA256_RE.test(String(row['candidateSetDigest'])) ||
    !SHA256_RE.test(String(row['candidateId'])) || !SHA256_RE.test(String(row['ticketDigest'])) ||
    !SHA256_RE.test(String(row['attestation']))) return null;
  const ticket = row as unknown as DetachedPostMergeWorkTicketV1;
  const ticketId = sha('ashlr:detached-post-merge-orchestrator:work-ticket-id:v1', [
    ticket.denominatorId,
    ticket.candidateId,
  ]);
  if (!equalDigest(ticket.ticketId, ticketId)) return null;
  const unsigned = { ...ticket } as Partial<DetachedPostMergeWorkTicketV1>;
  delete unsigned.ticketDigest;
  delete unsigned.attestation;
  const ticketDigest = sha(
    'ashlr:detached-post-merge-orchestrator:work-ticket:v1',
    ticketPayload(unsigned as Omit<DetachedPostMergeWorkTicketV1, 'ticketDigest' | 'attestation'>),
  );
  const attestation = hmac(
    key,
    'ashlr:detached-post-merge-orchestrator:work-ticket-attestation:v1',
    ticketDigest,
  );
  return equalDigest(ticket.ticketDigest, ticketDigest) && equalDigest(ticket.attestation, attestation)
    ? ticket
    : null;
}

function workTicketCodec(
  key: Buffer,
): ImmutablePrivateRecordCodec<DetachedPostMergeWorkTicketV1> {
  return {
    parse: (value) => parseWorkTicket(value, key),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.ticketId,
    recordFileName: (record) => `${record.ticketId}.json`,
    isRecordFileName: (name) => name.endsWith('.json') && SHA256_RE.test(name.slice(0, -5)),
    stageToken: (record) => record.ticketDigest,
    equivalent: (left, right) => left.ticketId === right.ticketId &&
      left.denominatorId === right.denominatorId && left.candidateId === right.candidateId &&
      left.proposalSourceDigest === right.proposalSourceDigest &&
      left.enrollmentSourceDigest === right.enrollmentSourceDigest &&
      left.candidateSetDigest === right.candidateSetDigest,
    compare: (left, right) => left.queuedAt.localeCompare(right.queuedAt) ||
      left.ticketId.localeCompare(right.ticketId),
  };
}

function workTicketStoreConfig(
  keyProvider: () => Buffer | null = () => {
    try { return loadExistingProvenanceKey(); } catch { return null; }
  },
): ImmutablePrivateRecordStoreConfig<DetachedPostMergeWorkTicketV1> {
  return {
    label: 'detached post-merge work ticket',
    anchorPath: storageHome(),
    rootPath: detachedPostMergeWorkTicketStorePath(),
    lockFileName: '.detached-post-merge-work-ticket.lock',
    maxRecordBytes: 64 * 1_024,
    defaultMaxFiles: 4_096,
    hardMaxFiles: 25_000,
    defaultMaxBytes: 64 * 1_024 * 1_024,
    hardMaxBytes: 256 * 1_024 * 1_024,
    codecForWrite: () => {
      const key = keyProvider();
      return key?.length === 32 ? workTicketCodec(key) : null;
    },
    codecForRead: () => {
      const key = keyProvider();
      return key?.length === 32 ? workTicketCodec(key) : null;
    },
  };
}

function denominatorPayload(
  receipt: Omit<DetachedPostMergeDenominatorReceiptV1, 'denominatorDigest' | 'attestation'>,
): unknown[] {
  return [
    receipt.schemaVersion, receipt.recordType, receipt.authority,
    receipt.policyEligible, receipt.mergePermitted, receipt.rollbackPermitted,
    receipt.deployPermitted, receipt.capturedAt, receipt.denominatorId,
    receipt.proposalSourceDigest, receipt.enrollmentSourceDigest,
    receipt.candidateSetDigest, receipt.expectedCandidateCount,
    receipt.denominatorComplete, receipt.candidateIds,
  ];
}

function parseDenominator(
  value: unknown,
  key: Buffer,
): DetachedPostMergeDenominatorReceiptV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, DENOMINATOR_KEYS) || row['schemaVersion'] !== 1 ||
    row['recordType'] !== 'detached-post-merge-denominator' ||
    row['authority'] !== 'observation-only' || row['policyEligible'] !== false ||
    row['mergePermitted'] !== false || row['rollbackPermitted'] !== false ||
    row['deployPermitted'] !== false || row['denominatorComplete'] !== true ||
    !canonicalTimestamp(row['capturedAt']) || !SHA256_RE.test(String(row['denominatorId'])) ||
    !SHA256_RE.test(String(row['proposalSourceDigest'])) ||
    !SHA256_RE.test(String(row['enrollmentSourceDigest'])) ||
    !SHA256_RE.test(String(row['candidateSetDigest'])) ||
    !SHA256_RE.test(String(row['denominatorDigest'])) ||
    !SHA256_RE.test(String(row['attestation'])) ||
    !Number.isSafeInteger(row['expectedCandidateCount']) ||
    Number(row['expectedCandidateCount']) < 0 || Number(row['expectedCandidateCount']) > MAX_CANDIDATES ||
    !Array.isArray(row['candidateIds'])) return null;
  const receipt = row as unknown as DetachedPostMergeDenominatorReceiptV1;
  if (receipt.candidateIds.length !== receipt.expectedCandidateCount ||
    receipt.candidateIds.some((id) => !SHA256_RE.test(id)) ||
    receipt.candidateIds.some((id, index) => index > 0 && receipt.candidateIds[index - 1]! >= id)) {
    return null;
  }
  const candidateSetDigest = sha(
    'ashlr:detached-post-merge-orchestrator:candidate-set:v1',
    receipt.candidateIds,
  );
  const denominatorId = sha('ashlr:detached-post-merge-orchestrator:denominator-id:v1', [
    receipt.proposalSourceDigest,
    receipt.enrollmentSourceDigest,
    candidateSetDigest,
  ]);
  if (!equalDigest(receipt.candidateSetDigest, candidateSetDigest) ||
    !equalDigest(receipt.denominatorId, denominatorId)) return null;
  const unsigned = { ...receipt } as Partial<DetachedPostMergeDenominatorReceiptV1>;
  delete unsigned.denominatorDigest;
  delete unsigned.attestation;
  const denominatorDigest = sha(
    'ashlr:detached-post-merge-orchestrator:denominator:v1',
    denominatorPayload(unsigned as Omit<DetachedPostMergeDenominatorReceiptV1,
      'denominatorDigest' | 'attestation'>),
  );
  const attestation = hmac(
    key,
    'ashlr:detached-post-merge-orchestrator:denominator-attestation:v1',
    denominatorDigest,
  );
  return equalDigest(receipt.denominatorDigest, denominatorDigest) &&
    equalDigest(receipt.attestation, attestation) ? receipt : null;
}

function denominatorCodec(
  key: Buffer,
): ImmutablePrivateRecordCodec<DetachedPostMergeDenominatorReceiptV1> {
  return {
    parse: (value) => parseDenominator(value, key),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.denominatorId,
    recordFileName: (record) => `${record.denominatorId}.json`,
    isRecordFileName: (name) => name.endsWith('.json') && SHA256_RE.test(name.slice(0, -5)),
    stageToken: (record) => record.denominatorDigest,
    equivalent: (left, right) => left.denominatorId === right.denominatorId &&
      left.proposalSourceDigest === right.proposalSourceDigest &&
      left.enrollmentSourceDigest === right.enrollmentSourceDigest &&
      left.candidateSetDigest === right.candidateSetDigest &&
      JSON.stringify(left.candidateIds) === JSON.stringify(right.candidateIds),
    compare: (left, right) => left.capturedAt.localeCompare(right.capturedAt) ||
      left.denominatorId.localeCompare(right.denominatorId),
  };
}

function denominatorStoreConfig(
  keyProvider: () => Buffer | null = () => {
    try { return loadExistingProvenanceKey(); } catch { return null; }
  },
): ImmutablePrivateRecordStoreConfig<DetachedPostMergeDenominatorReceiptV1> {
  const home = storageHome();
  return {
    label: 'detached post-merge denominator',
    anchorPath: home,
    rootPath: detachedPostMergeDenominatorStorePath(),
    lockFileName: '.detached-post-merge-denominator.lock',
    maxRecordBytes: 512 * 1_024,
    defaultMaxFiles: 2_048,
    hardMaxFiles: 25_000,
    defaultMaxBytes: 64 * 1_024 * 1_024,
    hardMaxBytes: 256 * 1_024 * 1_024,
    codecForWrite: () => {
      const key = keyProvider();
      return key?.length === 32 ? denominatorCodec(key) : null;
    },
    codecForRead: () => {
      const key = keyProvider();
      return key?.length === 32 ? denominatorCodec(key) : null;
    },
  };
}

function buildDenominator(
  snapshot: CandidateSnapshot,
  capturedAt: string,
  key: Buffer,
): DetachedPostMergeDenominatorReceiptV1 {
  const unsigned: Omit<DetachedPostMergeDenominatorReceiptV1, 'denominatorDigest' | 'attestation'> = {
    schemaVersion: 1,
    recordType: 'detached-post-merge-denominator',
    authority: 'observation-only',
    policyEligible: false,
    mergePermitted: false,
    rollbackPermitted: false,
    deployPermitted: false,
    capturedAt,
    denominatorId: snapshot.denominatorId,
    proposalSourceDigest: snapshot.proposalSourceDigest,
    enrollmentSourceDigest: snapshot.enrollmentSourceDigest,
    candidateSetDigest: snapshot.candidateSetDigest,
    expectedCandidateCount: snapshot.candidates.length,
    denominatorComplete: true,
    candidateIds: snapshot.candidates.map((candidate) => candidate.candidateId).sort(),
  };
  const denominatorDigest = sha(
    'ashlr:detached-post-merge-orchestrator:denominator:v1',
    denominatorPayload(unsigned),
  );
  return {
    ...unsigned,
    denominatorDigest,
    attestation: hmac(
      key,
      'ashlr:detached-post-merge-orchestrator:denominator-attestation:v1',
      denominatorDigest,
    ),
  };
}

function buildWorkTicket(
  snapshot: CandidateSnapshot,
  candidateId: string,
  queuedAt: string,
  key: Buffer,
): DetachedPostMergeWorkTicketV1 {
  const ticketId = sha('ashlr:detached-post-merge-orchestrator:work-ticket-id:v1', [
    snapshot.denominatorId,
    candidateId,
  ]);
  const unsigned: Omit<DetachedPostMergeWorkTicketV1, 'ticketDigest' | 'attestation'> = {
    schemaVersion: 1,
    recordType: 'detached-post-merge-work-ticket',
    authority: 'observation-only',
    policyEligible: false,
    executionPermitted: false,
    mergePermitted: false,
    rollbackPermitted: false,
    deployPermitted: false,
    queuedAt,
    ticketId,
    denominatorId: snapshot.denominatorId,
    proposalSourceDigest: snapshot.proposalSourceDigest,
    enrollmentSourceDigest: snapshot.enrollmentSourceDigest,
    candidateSetDigest: snapshot.candidateSetDigest,
    candidateId,
  };
  const ticketDigest = sha(
    'ashlr:detached-post-merge-orchestrator:work-ticket:v1',
    ticketPayload(unsigned),
  );
  return {
    ...unsigned,
    ticketDigest,
    attestation: hmac(
      key,
      'ashlr:detached-post-merge-orchestrator:work-ticket-attestation:v1',
      ticketDigest,
    ),
  };
}

export function readDetachedPostMergeWorkTickets(
  options: ImmutablePrivateRecordReadOptions = {},
): DetachedPostMergeWorkTicketReadResult {
  const result = readImmutablePrivateRecords(workTicketStoreConfig(), options);
  return {
    tickets: result.records,
    sourceState: result.sourceState,
    sourcePresent: result.sourcePresent,
    complete: result.complete,
    stopReasons: result.stopReasons,
    filesRead: result.filesRead,
    bytesRead: result.bytesRead,
    invalidFiles: result.invalidFiles,
    limitExceeded: result.limitExceeded,
  };
}

function pointerPayload(
  pointer: Omit<DetachedPostMergeDenominatorPointerV1, 'attestation'>,
): unknown[] {
  return [
    pointer.schemaVersion, pointer.recordType, pointer.authority,
    pointer.policyEligible, pointer.mergePermitted, pointer.rollbackPermitted,
    pointer.deployPermitted, pointer.denominatorId, pointer.proposalSourceDigest,
    pointer.enrollmentSourceDigest, pointer.candidateSetDigest, pointer.updatedAt,
  ];
}

function buildPointer(
  receipt: DetachedPostMergeDenominatorReceiptV1,
  updatedAt: string,
  key: Buffer,
): DetachedPostMergeDenominatorPointerV1 {
  const unsigned: Omit<DetachedPostMergeDenominatorPointerV1, 'attestation'> = {
    schemaVersion: 1,
    recordType: 'detached-post-merge-denominator-current',
    authority: 'observation-only',
    policyEligible: false,
    mergePermitted: false,
    rollbackPermitted: false,
    deployPermitted: false,
    denominatorId: receipt.denominatorId,
    proposalSourceDigest: receipt.proposalSourceDigest,
    enrollmentSourceDigest: receipt.enrollmentSourceDigest,
    candidateSetDigest: receipt.candidateSetDigest,
    updatedAt,
  };
  return {
    ...unsigned,
    attestation: hmac(
      key,
      'ashlr:detached-post-merge-orchestrator:pointer-attestation:v1',
      pointerPayload(unsigned),
    ),
  };
}

function parsePointer(
  value: unknown,
  key: Buffer,
): DetachedPostMergeDenominatorPointerV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, POINTER_KEYS) || row['schemaVersion'] !== 1 ||
    row['recordType'] !== 'detached-post-merge-denominator-current' ||
    row['authority'] !== 'observation-only' || row['policyEligible'] !== false ||
    row['mergePermitted'] !== false || row['rollbackPermitted'] !== false ||
    row['deployPermitted'] !== false || !SHA256_RE.test(String(row['denominatorId'])) ||
    !SHA256_RE.test(String(row['proposalSourceDigest'])) ||
    !SHA256_RE.test(String(row['enrollmentSourceDigest'])) ||
    !SHA256_RE.test(String(row['candidateSetDigest'])) ||
    !canonicalTimestamp(row['updatedAt']) || !SHA256_RE.test(String(row['attestation']))) return null;
  const pointer = row as unknown as DetachedPostMergeDenominatorPointerV1;
  const unsigned = { ...pointer } as Partial<DetachedPostMergeDenominatorPointerV1>;
  delete unsigned.attestation;
  const attestation = hmac(
    key,
    'ashlr:detached-post-merge-orchestrator:pointer-attestation:v1',
    pointerPayload(unsigned as Omit<DetachedPostMergeDenominatorPointerV1, 'attestation'>),
  );
  return equalDigest(pointer.attestation, attestation) ? pointer : null;
}

function writeCurrentPointer(
  receipt: DetachedPostMergeDenominatorReceiptV1,
  updatedAt: string,
  key: Buffer,
): boolean {
  try {
    const target = detachedPostMergeDenominatorPointerPath();
    const pointer = buildPointer(receipt, updatedAt, key);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writePrivateFileAtomically(temporary, target, `${JSON.stringify(pointer)}\n`, {
      anchorPath: storageHome(),
      label: 'detached post-merge denominator pointer',
    });
    return true;
  } catch {
    return false;
  }
}

export function readCurrentDetachedPostMergeDenominator(
  options: DetachedPostMergeDenominatorReadOptions = {},
): DetachedPostMergeCurrentDenominatorReadResult {
  const empty = (
    sourceState: 'missing' | 'healthy' | 'degraded',
    overrides: Partial<DetachedPostMergeCurrentDenominatorReadResult> = {},
  ): DetachedPostMergeCurrentDenominatorReadResult => ({
    receipt: null,
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState === 'healthy',
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    ...overrides,
  });
  const path = detachedPostMergeDenominatorPointerPath();
  if (!existsSync(path)) return empty('missing', { complete: true });
  const sourceDeps: CandidateSourceDependencies = {
    now: () => new Date(),
    identityKey: () => { try { return loadExistingProvenanceKey(); } catch { return null; } },
    readProposals: () => listProposalsDetailed({ requireComplete: true }),
    readEnrollment: readEnrollmentRegistry,
    authenticateMerge: authenticatedRealizedMergeOf,
    ...options._dependencies,
  };
  let key: Buffer | null;
  try { key = sourceDeps.identityKey(); } catch { key = null; }
  if (!key || key.length !== 32) {
    return empty('degraded', { complete: false, stopReasons: ['key-unavailable'], invalidFiles: 1 });
  }
  const loaded = readStableRegularFile(path, {
    anchorPath: storageHome(),
    maxFileBytes: MAX_POINTER_BYTES,
    remainingBytes: MAX_POINTER_BYTES,
  });
  if (!loaded.ok) {
    return empty('degraded', {
      complete: false,
      stopReasons: [loaded.reason],
      invalidFiles: 1,
    });
  }
  let pointer: DetachedPostMergeDenominatorPointerV1 | null = null;
  try { pointer = parsePointer(JSON.parse(loaded.text), key); } catch { pointer = null; }
  if (!pointer) {
    return empty('degraded', {
      complete: false,
      stopReasons: ['invalid-pointer'],
      filesRead: 1,
      bytesRead: loaded.bytesRead,
      invalidFiles: 1,
    });
  }
  const point = readImmutablePrivateRecordPoint(
    denominatorStoreConfig(() => key),
    pointer.denominatorId,
    `${pointer.denominatorId}.json`,
  );
  const receipt = point.record;
  if (!receipt || point.sourceState !== 'healthy' || !point.exactReadComplete ||
    receipt.denominatorId !== pointer.denominatorId ||
    receipt.proposalSourceDigest !== pointer.proposalSourceDigest ||
    receipt.enrollmentSourceDigest !== pointer.enrollmentSourceDigest ||
    receipt.candidateSetDigest !== pointer.candidateSetDigest) {
    return empty('degraded', {
      complete: false,
      stopReasons: point.stopReasons.length > 0 ? point.stopReasons : ['denominator-missing'],
      filesRead: 1 + Number(point.bytesRead > 0),
      bytesRead: loaded.bytesRead + point.bytesRead,
      invalidFiles: 1,
    });
  }
  const now = sourceDeps.now();
  const nowValue = now.getTime();
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && Number(options.maxAgeMs) > 0
    ? Math.min(Number(options.maxAgeMs), 24 * 60 * 60 * 1_000)
    : DENOMINATOR_MAX_AGE_MS;
  const pointerAge = nowValue - Date.parse(pointer.updatedAt);
  const receiptAge = nowValue - Date.parse(receipt.capturedAt);
  if (!Number.isFinite(nowValue) || pointerAge < -MAX_FUTURE_SKEW_MS ||
    receiptAge < -MAX_FUTURE_SKEW_MS || pointerAge > maxAgeMs) {
    return empty('degraded', {
      complete: false,
      stopReasons: ['stale-denominator'],
      filesRead: 2,
      bytesRead: loaded.bytesRead + point.bytesRead,
      invalidFiles: 1,
    });
  }
  const live = readCandidateSnapshot(sourceDeps, key);
  if (!live.ok) {
    return empty('degraded', {
      complete: false,
      stopReasons: [`live-${live.reason}`],
      filesRead: 2,
      bytesRead: loaded.bytesRead + point.bytesRead,
      invalidFiles: 1,
    });
  }
  if (live.snapshot.denominatorId !== receipt.denominatorId ||
    live.snapshot.proposalSourceDigest !== receipt.proposalSourceDigest ||
    live.snapshot.enrollmentSourceDigest !== receipt.enrollmentSourceDigest ||
    live.snapshot.candidateSetDigest !== receipt.candidateSetDigest) {
    return empty('degraded', {
      complete: false,
      stopReasons: ['live-source-mismatch'],
      filesRead: 2,
      bytesRead: loaded.bytesRead + point.bytesRead,
      invalidFiles: 1,
    });
  }
  return {
    receipt,
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesRead: 2,
    bytesRead: loaded.bytesRead + point.bytesRead,
    invalidFiles: 0,
  };
}

function proposalProjection(key: Buffer, proposal: Proposal): unknown[] {
  const handoff = proposal.remoteHandoff;
  const realized = proposal.realizedMerge;
  return [
    hmac(key, 'ashlr:detached-post-merge-orchestrator:proposal-source:id:v1', proposal.id),
    proposal.repo
      ? hmac(key, 'ashlr:detached-post-merge-orchestrator:proposal-source:repo:v1', proposal.repo)
      : null,
    proposal.status,
    proposal.kind,
    proposal.createdAt,
    handoff?.provider ?? null,
    handoff?.state ?? null,
    handoff?.base ?? null,
    handoff?.expectedHeadOid ?? null,
    handoff?.mergeCommitOid ?? null,
    handoff?.mergedAt ?? null,
    handoff?.reconciliation?.attestation ?? null,
    realized?.source ?? null,
    realized?.mergeCommitOid ?? null,
  ];
}

function readCandidateSnapshot(
  deps: CandidateSourceDependencies,
  key: Buffer,
): CandidateSnapshotResult {
  let proposals: ProposalsReadResult;
  let enrollment: EnrollmentRegistrySnapshot;
  try { proposals = deps.readProposals(); } catch {
    return { ok: false, reason: 'proposal-source-unavailable' };
  }
  try { enrollment = deps.readEnrollment(); } catch {
    return { ok: false, reason: 'enrollment-source-unavailable' };
  }
  if (proposals.sourceState !== 'healthy' || !proposals.sourcePresent || !proposals.complete ||
    proposals.proposals.length > MAX_CANDIDATES) {
    return { ok: false, reason: 'proposal-source-unavailable' };
  }
  if (new Set(proposals.proposals.map((proposal) => proposal.id)).size !== proposals.proposals.length) {
    return { ok: false, reason: 'duplicate-candidate' };
  }
  if (enrollment.state !== 'ready') return { ok: false, reason: 'enrollment-source-unavailable' };
  const enrolled = enrollment.repos.map(canonicalRepo);
  if (enrolled.some((repo) => repo === null) || new Set(enrolled).size !== enrolled.length) {
    return { ok: false, reason: 'enrollment-source-unavailable' };
  }
  const enrolledSet = new Set(enrolled as string[]);
  const proposalSourceDigest = hmac(
    key,
    'ashlr:detached-post-merge-orchestrator:proposal-source:v1',
    proposals.proposals.map((proposal) => proposalProjection(key, proposal))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
  const enrollmentSourceDigest = hmac(
    key,
    'ashlr:detached-post-merge-orchestrator:enrollment-source:v1',
    [...enrolledSet].sort().map((repo) =>
      hmac(key, 'ashlr:detached-post-merge-orchestrator:enrolled-repo:v1', repo)),
  );
  const candidates: Candidate[] = [];
  for (const proposal of proposals.proposals) {
    if (proposal.status !== 'applied') continue;
    const repo = canonicalRepo(proposal.repo);
    if (!repo || !enrolledSet.has(repo)) continue;
    let realized: RealizedMergeEvidence | null;
    try { realized = deps.authenticateMerge(proposal); } catch {
      return { ok: false, reason: 'proposal-source-unavailable' };
    }
    if (realized?.source !== 'github-host') continue;
    if (!GIT_SHA_RE.test(realized.expectedHeadOid) || !GIT_SHA_RE.test(realized.mergeCommitOid) ||
      !canonicalTimestamp(realized.mergedAt)) return { ok: false, reason: 'invalid-candidate' };
    const executionRepo = physicalRepoOrLexical(repo);
    const identity = buildDetachedPostMergeCandidateIdentity({
      repo: executionRepo,
      proposalId: proposal.id,
      baseBranch: realized.base,
      candidateHead: realized.expectedHeadOid,
      mergeCommit: realized.mergeCommitOid,
    }, key);
    if (!identity) return { ok: false, reason: 'invalid-candidate' };
    candidates.push({
      candidateId: identity.candidateId,
      repo: executionRepo,
      proposalId: proposal.id,
      baseBranch: realized.base,
      candidateHead: realized.expectedHeadOid,
      mergeCommit: realized.mergeCommitOid,
      mergedAt: realized.mergedAt,
      ...(proposal.runId ? { runId: proposal.runId } : {}),
      ...(proposal.trajectoryId ? { trajectoryId: proposal.trajectoryId } : {}),
      ...(proposal.workItemId ? { workItemId: proposal.workItemId } : {}),
    });
  }
  candidates.sort((left, right) => left.mergedAt.localeCompare(right.mergedAt) ||
    left.candidateId.localeCompare(right.candidateId));
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length ||
    new Set(candidates.map((candidate) => `${candidate.repo}\0${candidate.mergeCommit}`)).size !==
      candidates.length) return { ok: false, reason: 'duplicate-candidate' };
  const candidateIds = candidates.map((candidate) => candidate.candidateId).sort();
  const candidateSetDigest = sha(
    'ashlr:detached-post-merge-orchestrator:candidate-set:v1',
    candidateIds,
  );
  return {
    ok: true,
    snapshot: {
      proposalSourceDigest,
      enrollmentSourceDigest,
      candidateSetDigest,
      denominatorId: sha('ashlr:detached-post-merge-orchestrator:denominator-id:v1', [
        proposalSourceDigest,
        enrollmentSourceDigest,
        candidateSetDigest,
      ]),
      candidates,
    },
  };
}

function sameSnapshot(left: CandidateSnapshot, right: CandidateSnapshot): boolean {
  return left.denominatorId === right.denominatorId &&
    left.proposalSourceDigest === right.proposalSourceDigest &&
    left.enrollmentSourceDigest === right.enrollmentSourceDigest &&
    left.candidateSetDigest === right.candidateSetDigest &&
    JSON.stringify(left.candidates) === JSON.stringify(right.candidates);
}

function conclusiveCandidateIds(read: DetachedPostMergeVerificationReadResult): Set<string> {
  const ids = new Set<string>();
  for (const cohort of read.cohorts) {
    for (const member of cohort.members) {
      if (member.terminal === 'pass' || member.terminal === 'fail') {
        ids.add(detachedPostMergeCandidateIdForMember(member));
      }
    }
  }
  return ids;
}

export function projectDetachedPostMergeDenominator(
  current: DetachedPostMergeCurrentDenominatorReadResult,
  observations: DetachedPostMergeVerificationReadResult,
  tickets: DetachedPostMergeWorkTicketReadResult | null = null,
): DetachedPostMergeDenominatorProjection {
  const candidateIds = new Set(current.receipt?.candidateIds ?? []);
  const latest = new Map<string, {
    observedAt: string;
    cohortId: string;
    terminal: 'pass' | 'fail' | 'unknown';
  }>();
  for (const cohort of observations.cohorts) {
    for (const member of cohort.members) {
      const candidateId = detachedPostMergeCandidateIdForMember(member);
      if (!candidateIds.has(candidateId)) continue;
      const prior = latest.get(candidateId);
      const memberConclusive = member.terminal === 'pass' || member.terminal === 'fail';
      const priorConclusive = prior?.terminal === 'pass' || prior?.terminal === 'fail';
      const newer = prior !== undefined && (prior.observedAt < cohort.observedAt ||
        (prior.observedAt === cohort.observedAt && prior.cohortId < cohort.cohortId));
      if (!prior || (memberConclusive && !priorConclusive) ||
        (memberConclusive === priorConclusive && newer)) {
        latest.set(candidateId, {
          observedAt: cohort.observedAt,
          cohortId: cohort.cohortId,
          terminal: member.terminal,
        });
      }
    }
  }
  const outcomes = [...latest.values()];
  const pass = outcomes.filter((row) => row.terminal === 'pass').length;
  const fail = outcomes.filter((row) => row.terminal === 'fail').length;
  const unknown = outcomes.filter((row) => row.terminal === 'unknown').length;
  const conclusive = pass + fail;
  const denominatorId = current.receipt?.denominatorId;
  const queuedCandidates = tickets && tickets.sourceState !== 'degraded' && tickets.complete && denominatorId
    ? new Set(tickets.tickets
        .filter((ticket) => ticket.denominatorId === denominatorId && candidateIds.has(ticket.candidateId))
        .map((ticket) => ticket.candidateId)).size
    : 0;
  return {
    eligibleCandidates: candidateIds.size,
    observedCandidates: latest.size,
    conclusiveCandidates: conclusive,
    unobservedCandidates: candidateIds.size - conclusive,
    pass,
    fail,
    unknown,
    queuedCandidates,
    latestObservedAt: outcomes.map((row) => row.observedAt).sort().at(-1) ?? null,
    passRate: conclusive > 0 ? pass / conclusive : null,
  };
}

function validNow(now: Date): string | null {
  return Number.isFinite(now.getTime()) ? now.toISOString() : null;
}

export async function runDetachedPostMergeOrchestrator(
  options: DetachedPostMergeOrchestratorOptions = {},
): Promise<DetachedPostMergeOrchestratorResult> {
  const deps: OrchestratorDependencies = {
    now: () => new Date(),
    identityKey: () => { try { return loadExistingProvenanceKey(); } catch { return null; } },
    readProposals: () => listProposalsDetailed({ requireComplete: true }),
    readEnrollment: readEnrollmentRegistry,
    authenticateMerge: authenticatedRealizedMergeOf,
    readObservations: () => readDetachedPostMergeVerificationCohorts({ requireComplete: true }),
    ...options._dependencies,
  };
  if (options.signal?.aborted) return result({ reason: 'cancelled' });
  let key: Buffer | null;
  try { key = deps.identityKey(); } catch { key = null; }
  if (!key || key.length !== 32) return result({ reason: 'identity-key-unavailable' });
  const lock = acquireLocalStoreLock(join(storageHome(), '.detached-post-merge-orchestrator.lock'));
  if (!lock) return result({ reason: 'orchestrator-busy' });
  try {
    const first = readCandidateSnapshot(deps, key);
    if (!first.ok) return result({ reason: first.reason });
    deps.onPhase?.('after-first-source');
    let observations: DetachedPostMergeVerificationReadResult;
    try { observations = deps.readObservations(); } catch {
      return result({
        reason: 'observation-source-unavailable',
        candidateSetDigest: first.snapshot.candidateSetDigest,
        eligibleCandidateCount: first.snapshot.candidates.length,
      });
    }
    if (observations.sourceState === 'degraded' ||
      (observations.sourceState !== 'missing' && !observations.complete)) {
      return result({
        reason: 'observation-source-unavailable',
        candidateSetDigest: first.snapshot.candidateSetDigest,
        eligibleCandidateCount: first.snapshot.candidates.length,
      });
    }
    const second = readCandidateSnapshot(deps, key);
    if (!second.ok || !sameSnapshot(first.snapshot, second.snapshot)) {
      return result({
        reason: 'source-changed',
        candidateSetDigest: first.snapshot.candidateSetDigest,
        eligibleCandidateCount: first.snapshot.candidates.length,
      });
    }
    deps.onPhase?.('after-second-source');
    const conclusive = conclusiveCandidateIds(observations);
    const selected = second.snapshot.candidates.find((candidate) =>
      !conclusive.has(candidate.candidateId));
    const third = readCandidateSnapshot(deps, key);
    if (!third.ok || !sameSnapshot(second.snapshot, third.snapshot)) {
      return result({
        reason: 'source-changed',
        candidateSetDigest: second.snapshot.candidateSetDigest,
        eligibleCandidateCount: second.snapshot.candidates.length,
        observedCandidateCount: second.snapshot.candidates.filter((candidate) =>
          conclusive.has(candidate.candidateId)).length,
        selectedCandidateId: selected?.candidateId ?? null,
      });
    }
    const capturedAt = validNow(deps.now());
    if (!capturedAt) return result({ reason: 'denominator-record-failed' });
    const denominator = buildDenominator(third.snapshot, capturedAt, key);
    const denominatorDisposition = writeImmutablePrivateRecord(
      denominatorStoreConfig(() => key),
      denominator,
    );
    if (!['recorded', 'replayed'].includes(denominatorDisposition)) {
      return result({
        reason: 'denominator-record-failed',
        candidateSetDigest: third.snapshot.candidateSetDigest,
        eligibleCandidateCount: third.snapshot.candidates.length,
        observedCandidateCount: third.snapshot.candidates.filter((candidate) =>
          conclusive.has(candidate.candidateId)).length,
        selectedCandidateId: selected?.candidateId ?? null,
        denominatorDisposition,
      });
    }
    if (!writeCurrentPointer(denominator, capturedAt, key)) {
      return result({
        reason: 'denominator-pointer-failed',
        candidateSetDigest: third.snapshot.candidateSetDigest,
        eligibleCandidateCount: third.snapshot.candidates.length,
        observedCandidateCount: third.snapshot.candidates.filter((candidate) =>
          conclusive.has(candidate.candidateId)).length,
        selectedCandidateId: selected?.candidateId ?? null,
        denominatorDisposition,
      });
    }
    const observedCount = third.snapshot.candidates.filter((candidate) =>
      conclusive.has(candidate.candidateId)).length;
    if (!selected) {
      return result({
        disposition: 'idle',
        reason: third.snapshot.candidates.length === 0
          ? 'no-eligible-candidates'
          : 'all-candidates-observed',
        candidateSetDigest: third.snapshot.candidateSetDigest,
        eligibleCandidateCount: third.snapshot.candidates.length,
        observedCandidateCount: observedCount,
        denominatorDisposition,
      });
    }
    if (options.signal?.aborted) {
      return result({
        reason: 'cancelled',
        candidateSetDigest: third.snapshot.candidateSetDigest,
        eligibleCandidateCount: third.snapshot.candidates.length,
        observedCandidateCount: observedCount,
        selectedCandidateId: selected.candidateId,
        denominatorDisposition,
      });
    }
    let finalObservations: DetachedPostMergeVerificationReadResult;
    try { finalObservations = deps.readObservations(); } catch {
      return result({
        reason: 'observation-source-unavailable',
        candidateSetDigest: third.snapshot.candidateSetDigest,
        eligibleCandidateCount: third.snapshot.candidates.length,
        observedCandidateCount: observedCount,
        selectedCandidateId: selected.candidateId,
        denominatorDisposition,
      });
    }
    if (finalObservations.sourceState === 'degraded' ||
      (finalObservations.sourceState !== 'missing' && !finalObservations.complete)) {
      return result({
        reason: 'observation-source-unavailable',
        candidateSetDigest: third.snapshot.candidateSetDigest,
        eligibleCandidateCount: third.snapshot.candidates.length,
        observedCandidateCount: observedCount,
        selectedCandidateId: selected.candidateId,
        denominatorDisposition,
      });
    }
    if (conclusiveCandidateIds(finalObservations).has(selected.candidateId)) {
      return result({
        disposition: 'idle',
        reason: 'all-candidates-observed',
        candidateSetDigest: third.snapshot.candidateSetDigest,
        eligibleCandidateCount: third.snapshot.candidates.length,
        observedCandidateCount: observedCount + 1,
        denominatorDisposition,
      });
    }
    deps.onPhase?.('before-ticket');
    const fourth = readCandidateSnapshot(deps, key);
    if (!fourth.ok || !sameSnapshot(third.snapshot, fourth.snapshot)) {
      return result({
        reason: 'source-changed',
        candidateSetDigest: third.snapshot.candidateSetDigest,
        eligibleCandidateCount: third.snapshot.candidates.length,
        observedCandidateCount: observedCount,
        selectedCandidateId: selected.candidateId,
        denominatorDisposition,
      });
    }
    if (options.signal?.aborted) return result({ reason: 'cancelled' });
    const queuedAt = validNow(deps.now());
    if (!queuedAt) return result({ reason: 'ticket-record-failed' });
    const ticket = buildWorkTicket(fourth.snapshot, selected.candidateId, queuedAt, key);
    const ticketDisposition = writeImmutablePrivateRecord(
      workTicketStoreConfig(() => key),
      ticket,
    );
    if (!['recorded', 'replayed'].includes(ticketDisposition)) {
      return result({
        reason: 'ticket-record-failed',
        candidateSetDigest: fourth.snapshot.candidateSetDigest,
        eligibleCandidateCount: fourth.snapshot.candidates.length,
        observedCandidateCount: observedCount,
        selectedCandidateId: selected.candidateId,
        denominatorDisposition,
        ticketDisposition,
        ticketId: ticket.ticketId,
      });
    }
    return result({
      disposition: 'queued',
      reason: ticketDisposition === 'recorded' ? 'ticket-recorded' : 'ticket-replayed',
      candidateSetDigest: fourth.snapshot.candidateSetDigest,
      eligibleCandidateCount: fourth.snapshot.candidates.length,
      observedCandidateCount: observedCount,
      selectedCandidateId: selected.candidateId,
      denominatorDisposition,
      ticketDisposition,
      ticketId: ticket.ticketId,
    });
  } catch {
    return result({ reason: 'ticket-record-failed' });
  } finally {
    releaseLocalStoreLock(lock);
  }
}
