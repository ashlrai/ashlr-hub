import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  LAUNCHD_RETRY_SERVICE_IDENTITY,
  LAUNCHD_RETRY_MAX_SPACING_MS,
  LAUNCHD_RETRY_MIN_SPACING_MS,
  launchdRetryReceiptBytesEqual,
  verifyLaunchdRetryEpochReceipt,
  type LaunchdRetryEpochReceipt,
  type LaunchdRetryReceiptTransition,
  type VerifiedLaunchdRetryEpochReceipt,
} from './launchd-retry-authority.js';
import { isLaunchdReleaseObservation, observeLaunchdRelease } from './launchd-release-observation.js';
import {
  readLaunchdRetryTrustPolicy,
  type LaunchdRetryTrustPolicy,
} from './launchd-retry-trust-roots.js';
import type { DaemonRunResult } from './loop.js';
import { waitForLaunchdRetryNotBefore } from './launchd-retry-spacing.js';

export const LAUNCHD_RETRY_MAX_ATTEMPTS = 3;
export const LAUNCHD_RETRY_WINDOW_MS = 5 * 60_000;

const POLICY_VERSION = 'launchd-bounded-retry-v2';
const JOURNAL_PROTOCOL = 'ashlr-launchd-retry-cas-journal-v1' as const;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_STATE_BYTES = 32_768;
const DAEMON_REASONS = new Set([
  'clean-completion', 'kill-switch', 'signal', 'start-refused', 'persistence-failure',
  'runtime-failure', 'ownership-loss',
]);
const DAEMON_DIAGNOSTICS = new Set([
  'start-refused', 'state-malformed', 'state-unsafe', 'state-io-transient',
  'state-io-permanent', 'state-write-unclassified', 'successor-owner',
  'runtime-transient', 'runtime-unclassified',
]);

interface LaunchdRetryState {
  schemaVersion: 2;
  policyVersion: typeof POLICY_VERSION;
  serviceIdentity: typeof LAUNCHD_RETRY_SERVICE_IDENTITY;
  releaseRevision: string;
  releaseObservationDigest: string;
  epoch: number;
  sequence: number;
  claimCount: number;
  receiptDigest: string;
  receipt: LaunchdRetryEpochReceipt;
}

export interface LaunchdRetryCasRequest {
  schemaVersion: 2;
  decisionId: string;
  action: 'claim' | 'healthy-reset';
  serviceIdentity: typeof LAUNCHD_RETRY_SERVICE_IDENTITY;
  releaseRevision: string;
  releaseObservationDigest: string;
  expectedReceiptDigest: string;
  expectedEpoch: number;
  expectedSequence: number;
  nextEpoch: number;
  nextSequence: number;
  nextClaimCount: number;
  nextWindowStartedAtMs: number;
  nextMaxObservedAtMs: number;
  nextNotBeforeMinMs: number;
  nextNotBeforeMaxMs: number;
  currentReceipt: LaunchdRetryEpochReceipt;
}

interface LaunchdRetryJournal {
  schemaVersion: 1;
  protocol: typeof JOURNAL_PROTOCOL;
  request: LaunchdRetryCasRequest;
}

export type LaunchdRetryCasResult =
  | { status: 'committed'; receipt: unknown }
  | { status: 'conflict' | 'unavailable' | 'refused' };

export interface LaunchdRetryExternalAuthority {
  currentReceipt: unknown;
  compareAndSwap: (request: LaunchdRetryCasRequest) => Promise<LaunchdRetryCasResult>;
}

export type LaunchdRetryReason =
  | 'healthy-completion'
  | 'retry-exhausted'
  | 'retry-window-expired'
  | 'operator-stop'
  | 'concurrent-launch'
  | 'unsupported-platform'
  | 'release-observation-invalid'
  | 'clock-rollback'
  | 'external-retry-transport-unavailable'
  | 'external-retry-trust-unprovisioned'
  | 'external-retry-receipt-invalid'
  | 'external-retry-receipt-replayed'
  | 'retry-state-uninitialized'
  | 'retry-state-deleted'
  | 'legacy-local-authority-present'
  | 'state-corrupt'
  | 'retry-journal-corrupt'
  | 'state-persistence-failed'
  | 'daemon-terminal'
  | 'daemon-disposition-invalid';

export interface LaunchdRetryControllerResult {
  exitCode: 0 | 1;
  reason: LaunchdRetryReason;
  daemonInvoked: boolean;
  claimNumber: number | null;
  attemptsRemaining: number | null;
  externalAuthority: 'verified' | 'blocked';
}

export interface LaunchdRetryControllerOptions {
  runDaemon: () => Promise<DaemonRunResult>;
  externalAuthority?: LaunchdRetryExternalAuthority;
  homeDir?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  killSwitchState?: () => ReturnType<typeof readKillSwitch>;
}

interface RetryPaths {
  root: string;
  legacyKey: string;
  state: string;
  journal: string;
  lock: string;
}

function retryPaths(home: string): RetryPaths {
  const root = join(home, '.ashlr', 'daemon-supervision');
  return {
    root,
    legacyKey: join(root, 'launchd-retry.ed25519.pem'),
    state: join(root, 'launchd-retry.json'),
    journal: join(root, 'launchd-retry-journal.json'),
    lock: join(root, 'launchd-retry.lock'),
  };
}

function owned(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777) === 0o600);
}

function readPrivateFile(path: string, maxBytes: number, anchorPath: string): Buffer | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!privateFile(before) || before.size < 1 || before.size > maxBytes) return null;
    if (!assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath }).ok) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameFile(before, opened) || opened.size !== before.size) return null;
    const value = Buffer.alloc(opened.size);
    if (readSync(fd, value, 0, value.length, 0) !== value.length) return null;
    const after = lstatSync(path);
    if (!privateFile(after) || !sameFile(opened, after) || after.size !== opened.size) return null;
    return value;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close */ }
    }
  }
}

function exactPlainRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => !Object.hasOwn(descriptor, 'value'),
  )) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stateFromReceipt(value: VerifiedLaunchdRetryEpochReceipt): LaunchdRetryState {
  return {
    schemaVersion: 2,
    policyVersion: POLICY_VERSION,
    serviceIdentity: LAUNCHD_RETRY_SERVICE_IDENTITY,
    releaseRevision: value.receipt.releaseRevision,
    releaseObservationDigest: value.receipt.releaseObservationDigest,
    epoch: value.receipt.epoch,
    sequence: value.receipt.sequence,
    claimCount: value.receipt.claimCount,
    receiptDigest: value.receiptDigest,
    receipt: value.receipt,
  };
}

function stateBytes(state: LaunchdRetryState): Buffer {
  return Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
}

function loadState(
  paths: RetryPaths,
  releaseRevision: string,
  releaseObservationDigest: string,
  nowMs: number,
  trustPolicy: LaunchdRetryTrustPolicy,
): { state: LaunchdRetryState; verified: VerifiedLaunchdRetryEpochReceipt } | null {
  const raw = readPrivateFile(paths.state, MAX_STATE_BYTES, paths.root);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!exactPlainRecord(parsed, [
      'claimCount', 'epoch', 'policyVersion', 'receipt', 'receiptDigest',
      'releaseObservationDigest', 'releaseRevision',
      'schemaVersion', 'sequence', 'serviceIdentity',
    ]) || parsed['schemaVersion'] !== 2 || parsed['policyVersion'] !== POLICY_VERSION ||
      parsed['serviceIdentity'] !== LAUNCHD_RETRY_SERVICE_IDENTITY ||
      parsed['releaseRevision'] !== releaseRevision ||
      parsed['releaseObservationDigest'] !== releaseObservationDigest) return null;
    const verified = verifyLaunchdRetryEpochReceipt(parsed['receipt'], {
      releaseRevision,
      releaseObservationDigest,
      serviceIdentity: LAUNCHD_RETRY_SERVICE_IDENTITY,
      nowMs,
    }, trustPolicy);
    if (!verified.ok) return null;
    const expected = stateFromReceipt(verified.value);
    if (parsed['epoch'] !== expected.epoch || parsed['sequence'] !== expected.sequence ||
      parsed['claimCount'] !== expected.claimCount || parsed['receiptDigest'] !== expected.receiptDigest ||
      !launchdRetryReceiptBytesEqual(stateBytes(expected), raw)) return null;
    return { state: expected, verified: verified.value };
  } catch {
    return null;
  }
}

function persistState(
  paths: RetryPaths,
  value: VerifiedLaunchdRetryEpochReceipt,
  nowMs: number,
  trustPolicy: LaunchdRetryTrustPolicy,
): boolean {
  try {
    const state = stateFromReceipt(value);
    writePrivateFileAtomically(
      `${paths.state}.${process.pid}.${randomUUID()}.tmp`,
      paths.state,
      stateBytes(state),
      { anchorPath: paths.root, label: 'external launchd retry state' },
    );
    const loaded = loadState(
      paths,
      state.releaseRevision,
      state.releaseObservationDigest,
      nowMs,
      trustPolicy,
    );
    return loaded?.verified.receiptDigest === value.receiptDigest;
  } catch {
    return false;
  }
}

function validDaemonDisposition(result: DaemonRunResult): boolean {
  const termination = result?.termination;
  if (!exactPlainRecord(termination, termination?.diagnosticCode === undefined
    ? ['exitCode', 'reason', 'retryable']
    : ['diagnosticCode', 'exitCode', 'reason', 'retryable']) ||
    typeof termination['reason'] !== 'string' || !DAEMON_REASONS.has(termination['reason']) ||
    typeof termination['retryable'] !== 'boolean' ||
    (termination['exitCode'] !== 0 && termination['exitCode'] !== 1) ||
    termination['exitCode'] !== (termination['retryable'] ? 1 : 0) ||
    !(termination['diagnosticCode'] === undefined ||
      (typeof termination['diagnosticCode'] === 'string' &&
        DAEMON_DIAGNOSTICS.has(termination['diagnosticCode'])))) return false;
  return !termination['retryable'] || (
    termination['reason'] === 'persistence-failure' &&
    termination['diagnosticCode'] === 'state-io-transient' &&
    typeof result.startRefusal === 'string' && result.startRefusal.length > 0
  );
}

function terminal(
  reason: LaunchdRetryReason,
  externalAuthority: 'verified' | 'blocked' = 'blocked',
  daemonInvoked = false,
  claimNumber: number | null = null,
  attemptsRemaining: number | null = null,
): LaunchdRetryControllerResult {
  return { exitCode: 0, reason, daemonInvoked, claimNumber, attemptsRemaining, externalAuthority };
}

function expectedTransition(
  current: VerifiedLaunchdRetryEpochReceipt,
  action: 'claim' | 'healthy-reset',
  atMs: number,
  decisionId: string,
): Omit<LaunchdRetryCasRequest, 'schemaVersion' | 'currentReceipt'> {
  const healthy = action === 'healthy-reset';
  const unsigned = {
    action,
    serviceIdentity: LAUNCHD_RETRY_SERVICE_IDENTITY,
    releaseRevision: current.receipt.releaseRevision,
    releaseObservationDigest: current.receipt.releaseObservationDigest,
    expectedReceiptDigest: current.receiptDigest,
    expectedEpoch: current.receipt.epoch,
    expectedSequence: current.receipt.sequence,
    nextEpoch: healthy ? current.receipt.epoch + 1 : current.receipt.epoch,
    nextSequence: current.receipt.sequence + 1,
    nextClaimCount: healthy ? 0 : current.receipt.claimCount + 1,
    nextWindowStartedAtMs: healthy ? atMs : current.receipt.windowStartedAtMs,
    nextMaxObservedAtMs: atMs,
    nextNotBeforeMinMs: healthy ? atMs : atMs + LAUNCHD_RETRY_MIN_SPACING_MS,
    nextNotBeforeMaxMs: healthy ? atMs : atMs + LAUNCHD_RETRY_MAX_SPACING_MS,
  };
  return { decisionId, ...unsigned };
}

function newDecisionId(): string {
  return createHash('sha256')
    .update('ashlr:launchd-retry-cas-decision:v1\0', 'utf8')
    .update(randomUUID(), 'utf8')
    .digest('hex');
}

function exactTransitionReceipt(
  current: VerifiedLaunchdRetryEpochReceipt,
  next: VerifiedLaunchdRetryEpochReceipt,
  expected: ReturnType<typeof expectedTransition>,
): boolean {
  const transition: LaunchdRetryReceiptTransition = expected.action === 'claim'
    ? 'claim'
    : 'healthy-reset';
  return next.receipt.previousReceiptDigest === current.receiptDigest &&
    next.receipt.transition === transition &&
    next.receipt.transitionId === expected.decisionId &&
    next.receipt.releaseRevision === expected.releaseRevision &&
    next.receipt.releaseObservationDigest === expected.releaseObservationDigest &&
    next.receipt.serviceIdentity === expected.serviceIdentity &&
    next.receipt.epoch === expected.nextEpoch && next.receipt.sequence === expected.nextSequence &&
    next.receipt.claimCount === expected.nextClaimCount &&
    next.receipt.windowStartedAtMs === expected.nextWindowStartedAtMs &&
    next.receipt.maxObservedAtMs === expected.nextMaxObservedAtMs &&
    next.receipt.notBeforeMs >= expected.nextNotBeforeMinMs &&
    next.receipt.notBeforeMs <= expected.nextNotBeforeMaxMs;
}

function journalBytes(journal: LaunchdRetryJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8');
}

function persistJournal(paths: RetryPaths, request: LaunchdRetryCasRequest): boolean {
  try {
    const journal: LaunchdRetryJournal = {
      schemaVersion: 1,
      protocol: JOURNAL_PROTOCOL,
      request,
    };
    writePrivateFileAtomically(
      `${paths.journal}.${process.pid}.${randomUUID()}.tmp`,
      paths.journal,
      journalBytes(journal),
      { anchorPath: paths.root, label: 'external launchd retry CAS journal' },
    );
    const raw = readPrivateFile(paths.journal, MAX_STATE_BYTES, paths.root);
    return raw !== null && launchdRetryReceiptBytesEqual(raw, journalBytes(journal));
  } catch {
    return false;
  }
}

function clearJournal(paths: RetryPaths): boolean {
  try {
    if (!existsSync(paths.journal)) return true;
    if (!readPrivateFile(paths.journal, MAX_STATE_BYTES, paths.root)) return false;
    unlinkSync(paths.journal);
    fsyncDirectory(paths.root);
    return !existsSync(paths.journal);
  } catch {
    return false;
  }
}

function loadJournal(
  paths: RetryPaths,
  releaseRevision: string,
  releaseObservationDigest: string,
  nowMs: number,
  trustPolicy: LaunchdRetryTrustPolicy,
): { journal: LaunchdRetryJournal; current: VerifiedLaunchdRetryEpochReceipt } | null {
  const raw = readPrivateFile(paths.journal, MAX_STATE_BYTES, paths.root);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!exactPlainRecord(parsed, ['protocol', 'request', 'schemaVersion']) ||
      parsed['schemaVersion'] !== 1 || parsed['protocol'] !== JOURNAL_PROTOCOL ||
      !exactPlainRecord(parsed['request'], [
        'action', 'currentReceipt', 'decisionId', 'expectedEpoch', 'expectedReceiptDigest',
        'expectedSequence', 'nextClaimCount', 'nextEpoch', 'nextMaxObservedAtMs',
        'nextNotBeforeMaxMs', 'nextNotBeforeMinMs', 'nextSequence', 'nextWindowStartedAtMs',
        'releaseObservationDigest', 'releaseRevision', 'schemaVersion', 'serviceIdentity',
      ])) return null;
    const request = parsed['request'] as unknown as LaunchdRetryCasRequest;
    if (request.schemaVersion !== 2 || !DIGEST_RE.test(request.decisionId) ||
      (request.action !== 'claim' && request.action !== 'healthy-reset')) return null;
    const current = verifyLaunchdRetryEpochReceipt(request.currentReceipt, {
      releaseRevision,
      releaseObservationDigest,
      serviceIdentity: LAUNCHD_RETRY_SERVICE_IDENTITY,
      nowMs,
    }, trustPolicy);
    if (!current.ok) return null;
    const expected = expectedTransition(
      current.value,
      request.action,
      request.nextMaxObservedAtMs,
      request.decisionId,
    );
    const canonical: LaunchdRetryCasRequest = {
      schemaVersion: 2,
      ...expected,
      currentReceipt: current.value.receipt,
    };
    const journal: LaunchdRetryJournal = {
      schemaVersion: 1,
      protocol: JOURNAL_PROTOCOL,
      request: canonical,
    };
    return launchdRetryReceiptBytesEqual(raw, journalBytes(journal))
      ? { journal, current: current.value }
      : null;
  } catch {
    return null;
  }
}

async function commitTransition(
  authority: LaunchdRetryExternalAuthority,
  current: VerifiedLaunchdRetryEpochReceipt,
  action: 'claim' | 'healthy-reset',
  atMs: number,
  trustPolicy: LaunchdRetryTrustPolicy,
  paths: RetryPaths,
  preparedRequest?: LaunchdRetryCasRequest,
): Promise<
  | { ok: true; value: VerifiedLaunchdRetryEpochReceipt }
  | { ok: false; reason: LaunchdRetryReason }
> {
  const expected = expectedTransition(
    current,
    action,
    atMs,
    preparedRequest?.decisionId ?? newDecisionId(),
  );
  if (!Number.isSafeInteger(expected.nextEpoch) || !Number.isSafeInteger(expected.nextSequence) ||
    !Number.isSafeInteger(expected.nextNotBeforeMinMs) ||
    !Number.isSafeInteger(expected.nextNotBeforeMaxMs) ||
    expected.nextClaimCount > LAUNCHD_RETRY_MAX_ATTEMPTS) {
    return { ok: false, reason: 'external-retry-receipt-invalid' };
  }
  const request: LaunchdRetryCasRequest = {
    schemaVersion: 2,
    ...expected,
    currentReceipt: current.receipt,
  };
  if (preparedRequest && JSON.stringify(preparedRequest) !== JSON.stringify(request)) {
    return { ok: false, reason: 'retry-journal-corrupt' };
  }
  if (!preparedRequest && !persistJournal(paths, request)) {
    return { ok: false, reason: 'state-persistence-failed' };
  }
  let response: LaunchdRetryCasResult;
  try {
    response = await authority.compareAndSwap(request);
  } catch {
    return { ok: false, reason: 'external-retry-transport-unavailable' };
  }
  if (!exactPlainRecord(response, response.status === 'committed' ? ['receipt', 'status'] : ['status'])) {
    return { ok: false, reason: 'external-retry-receipt-invalid' };
  }
  if (response.status === 'conflict') return { ok: false, reason: 'external-retry-receipt-replayed' };
  if (response.status === 'unavailable') {
    return { ok: false, reason: 'external-retry-transport-unavailable' };
  }
  if (response.status !== 'committed') return { ok: false, reason: 'external-retry-receipt-invalid' };
  const verified = verifyLaunchdRetryEpochReceipt(response.receipt, {
    releaseRevision: expected.releaseRevision,
    releaseObservationDigest: expected.releaseObservationDigest,
    serviceIdentity: LAUNCHD_RETRY_SERVICE_IDENTITY,
    nowMs: atMs,
  }, trustPolicy);
  if (!verified.ok || !exactTransitionReceipt(current, verified.value, expected)) {
    return { ok: false, reason: 'external-retry-receipt-invalid' };
  }
  if (!persistState(paths, verified.value, atMs, trustPolicy) || !clearJournal(paths)) {
    return { ok: false, reason: 'state-persistence-failed' };
  }
  return { ok: true, value: verified.value };
}

function receiptFailureReason(reason: string): LaunchdRetryReason {
  return reason === 'trust-root-unprovisioned'
    ? 'external-retry-trust-unprovisioned'
    : 'external-retry-receipt-invalid';
}

export async function runLaunchdRetryController(
  options: LaunchdRetryControllerOptions,
): Promise<LaunchdRetryControllerResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return terminal('unsupported-platform');
  let releaseObservation: ReturnType<typeof observeLaunchdRelease>;
  try {
    releaseObservation = observeLaunchdRelease('supervisor');
  } catch {
    return terminal('release-observation-invalid');
  }
  if (!isLaunchdReleaseObservation(releaseObservation)) return terminal('release-observation-invalid');
  const runtimeRevision = releaseObservation.releaseRevision;
  const now = options.now ?? Date.now;
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return terminal('clock-rollback');
  const killState = options.killSwitchState ?? readKillSwitch;
  if (killState().state !== 'inactive') return terminal('operator-stop');

  const authority = options.externalAuthority;
  if (!authority || typeof authority.compareAndSwap !== 'function') {
    return terminal('external-retry-transport-unavailable');
  }
  const trustPolicy = readLaunchdRetryTrustPolicy();
  const supplied = verifyLaunchdRetryEpochReceipt(authority.currentReceipt, {
    releaseRevision: runtimeRevision,
    releaseObservationDigest: releaseObservation.observationDigest,
    serviceIdentity: LAUNCHD_RETRY_SERVICE_IDENTITY,
    nowMs,
  }, trustPolicy);
  if (!supplied.ok) return terminal(receiptFailureReason(supplied.reason));

  const home = options.homeDir ?? homedir();
  const paths = retryPaths(home);
  const lock = acquireLocalStoreLock(paths.lock, 0, {
    anchorPath: home,
    exactPrivateStorage: true,
  });
  if (!lock) return terminal('concurrent-launch');

  try {
    if (killState().state !== 'inactive') return terminal('operator-stop');
    if (existsSync(paths.legacyKey)) return terminal('legacy-local-authority-present');
    const stateExists = existsSync(paths.state);
    const journalExists = existsSync(paths.journal);
    const loadedState = stateExists
      ? loadState(
          paths,
          runtimeRevision,
          releaseObservation.observationDigest,
          nowMs,
          trustPolicy,
        )
      : null;
    if (stateExists && !loadedState) return terminal('state-corrupt');
    let current = supplied.value;
    let daemonWasInvoked = false;
    let lastClaimNumber: number | null = null;
    let lastAttemptsRemaining: number | null = null;
    if (journalExists) {
      const loadedJournal = loadJournal(
        paths,
        runtimeRevision,
        releaseObservation.observationDigest,
        nowMs,
        trustPolicy,
      );
      if (!loadedJournal) return terminal('retry-journal-corrupt');
      const request = loadedJournal.journal.request;
      const expected = expectedTransition(
        loadedJournal.current,
        request.action,
        request.nextMaxObservedAtMs,
        request.decisionId,
      );
      const suppliedIsCurrent = supplied.value.receiptDigest === loadedJournal.current.receiptDigest;
      const suppliedIsSuccessor = exactTransitionReceipt(loadedJournal.current, supplied.value, expected);
      if (!suppliedIsCurrent && !suppliedIsSuccessor) {
        return terminal('external-retry-receipt-replayed');
      }
      if (loadedState && loadedState.verified.receiptDigest !== loadedJournal.current.receiptDigest &&
        loadedState.verified.receiptDigest !== supplied.value.receiptDigest) {
        return terminal('external-retry-receipt-replayed');
      }
      const reconciled = await commitTransition(
        authority,
        loadedJournal.current,
        request.action,
        request.nextMaxObservedAtMs,
        trustPolicy,
        paths,
        request,
      );
      if (!reconciled.ok) return terminal(reconciled.reason, 'verified');
      current = reconciled.value;
      if (request.action === 'healthy-reset') {
        return terminal(
          'healthy-completion',
          'verified',
          false,
          loadedJournal.current.receipt.claimCount,
          LAUNCHD_RETRY_MAX_ATTEMPTS,
        );
      }
      lastClaimNumber = current.receipt.claimCount;
      lastAttemptsRemaining = LAUNCHD_RETRY_MAX_ATTEMPTS - current.receipt.claimCount;
    } else if (loadedState) {
      if (loadedState.verified.receiptDigest !== supplied.value.receiptDigest) {
        return terminal('external-retry-receipt-replayed');
      }
      current = loadedState.verified;
    } else if (current.receipt.transition !== 'initialize') {
      return terminal('retry-state-deleted');
    } else if (current.receipt.sequence !== 0 || current.receipt.claimCount !== 0) {
      return terminal('retry-state-uninitialized');
    }

    while (true) {
      if (killState().state !== 'inactive') {
        return terminal(
          'operator-stop', 'verified', daemonWasInvoked, lastClaimNumber, lastAttemptsRemaining,
        );
      }
      const observedBeforeWait = now();
      if (!Number.isSafeInteger(observedBeforeWait) || observedBeforeWait < current.receipt.maxObservedAtMs) {
        return terminal('clock-rollback', 'verified', daemonWasInvoked, lastClaimNumber);
      }
      if (observedBeforeWait - current.receipt.windowStartedAtMs > LAUNCHD_RETRY_WINDOW_MS) {
        return terminal('retry-window-expired', 'verified', daemonWasInvoked, lastClaimNumber, 0);
      }
      if (current.receipt.claimCount >= LAUNCHD_RETRY_MAX_ATTEMPTS) {
        return terminal('retry-exhausted', 'verified', daemonWasInvoked, lastClaimNumber, 0);
      }
      const wait = await waitForLaunchdRetryNotBefore(
        current.receipt.notBeforeMs,
        now,
        () => killState().state !== 'inactive',
      );
      if (wait.status === 'aborted') {
        return terminal(
          'operator-stop', 'verified', daemonWasInvoked, lastClaimNumber, lastAttemptsRemaining,
        );
      }
      if (wait.status === 'clock-invalid') {
        return terminal('clock-rollback', 'verified', daemonWasInvoked, lastClaimNumber);
      }
      const attemptAtMs = wait.nowMs;
      if (attemptAtMs < current.receipt.maxObservedAtMs) {
        return terminal('clock-rollback', 'verified', daemonWasInvoked, lastClaimNumber);
      }
      if (attemptAtMs - current.receipt.windowStartedAtMs > LAUNCHD_RETRY_WINDOW_MS) {
        return terminal('retry-window-expired', 'verified', daemonWasInvoked, lastClaimNumber, 0);
      }
      const claim = await commitTransition(authority, current, 'claim', attemptAtMs, trustPolicy, paths);
      if (!claim.ok) return terminal(claim.reason, 'verified', daemonWasInvoked, lastClaimNumber);
      const claimNumber = claim.value.receipt.claimCount;
      const remaining = LAUNCHD_RETRY_MAX_ATTEMPTS - claimNumber;
      lastClaimNumber = claimNumber;
      lastAttemptsRemaining = remaining;
      if (killState().state !== 'inactive') {
        return terminal('operator-stop', 'verified', daemonWasInvoked, claimNumber, remaining);
      }

      let result: DaemonRunResult;
      try {
        daemonWasInvoked = true;
        result = await options.runDaemon();
      } catch {
        return terminal('daemon-disposition-invalid', 'verified', true, claimNumber, remaining);
      }
      if (!validDaemonDisposition(result)) {
        return terminal('daemon-disposition-invalid', 'verified', true, claimNumber, remaining);
      }
      if (result.termination.reason === 'clean-completion' && !result.termination.retryable) {
        const completedAtMs = now();
        if (!Number.isSafeInteger(completedAtMs) || completedAtMs < claim.value.receipt.maxObservedAtMs) {
          return terminal('clock-rollback', 'verified', true, claimNumber, remaining);
        }
        const reset = await commitTransition(
          authority,
          claim.value,
          'healthy-reset',
          completedAtMs,
          trustPolicy,
          paths,
        );
        if (!reset.ok) return terminal(reset.reason, 'verified', true, claimNumber, remaining);
        return terminal('healthy-completion', 'verified', true, claimNumber, LAUNCHD_RETRY_MAX_ATTEMPTS);
      }
      if (!result.termination.retryable) {
        return terminal('daemon-terminal', 'verified', true, claimNumber, remaining);
      }
      if (remaining === 0) {
        return terminal('retry-exhausted', 'verified', true, claimNumber, 0);
      }

      current = claim.value;
    }
  } finally {
    releaseLocalStoreLock(lock);
  }
}
