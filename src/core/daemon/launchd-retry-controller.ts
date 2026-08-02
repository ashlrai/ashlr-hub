import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readBuildIdentity } from '../build-identity.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import type { DaemonRunResult } from './loop.js';

export const LAUNCHD_RETRY_MAX_ATTEMPTS = 3;
export const LAUNCHD_RETRY_WINDOW_MS = 5 * 60_000;

const POLICY_VERSION = 'launchd-bounded-retry-v1';
const REVISION_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_KEY_BYTES = 4_096;
const MAX_STATE_BYTES = 16_384;
const DAEMON_REASONS = new Set([
  'clean-completion', 'kill-switch', 'signal', 'start-refused', 'persistence-failure',
  'runtime-failure', 'ownership-loss',
]);
const DAEMON_DIAGNOSTICS = new Set([
  'start-refused', 'state-malformed', 'state-unsafe', 'state-io-transient',
  'state-io-permanent', 'state-write-unclassified', 'successor-owner',
  'runtime-transient', 'runtime-unclassified',
]);

interface RetryClaim {
  claimId: string;
  claimedAtMs: number;
}

interface LaunchdRetryState {
  schemaVersion: 1;
  policyVersion: typeof POLICY_VERSION;
  releaseRevision: string;
  generationId: string;
  windowStartedAtMs: number;
  maxObservedAtMs: number;
  resetSequence: number;
  claims: RetryClaim[];
  lastHealthyAtMs: number | null;
}

interface SignedLaunchdRetryState {
  state: LaunchdRetryState;
  signature: string;
}

export type LaunchdRetryReason =
  | 'retry-authorized'
  | 'healthy-completion'
  | 'retry-exhausted'
  | 'retry-window-expired'
  | 'operator-stop'
  | 'concurrent-launch'
  | 'unsupported-platform'
  | 'stale-release'
  | 'clock-rollback'
  | 'state-unavailable'
  | 'state-corrupt'
  | 'state-persistence-failed'
  | 'daemon-terminal'
  | 'daemon-disposition-invalid';

export interface LaunchdRetryControllerResult {
  exitCode: 0 | 1;
  reason: LaunchdRetryReason;
  daemonInvoked: boolean;
  claimNumber: number | null;
  attemptsRemaining: number | null;
}

interface LaunchdRetryControllerOptions {
  expectedReleaseRevision: string;
  runDaemon: () => Promise<DaemonRunResult>;
  homeDir?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  runtimeReleaseRevision?: string | null;
  runtimeReleaseTrusted?: boolean;
  killSwitchState?: () => ReturnType<typeof readKillSwitch>;
}

interface RetryPaths {
  root: string;
  key: string;
  state: string;
  lock: string;
}

function retryPaths(home: string): RetryPaths {
  const root = join(home, '.ashlr', 'daemon-supervision');
  return {
    root,
    key: join(root, 'launchd-retry.ed25519.pem'),
    state: join(root, 'launchd-retry.json'),
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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): LaunchdRetryState | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'policyVersion', 'releaseRevision', 'generationId', 'windowStartedAtMs',
    'maxObservedAtMs', 'resetSequence', 'claims', 'lastHealthyAtMs',
  ])) return null;
  if (value['schemaVersion'] !== 1 || value['policyVersion'] !== POLICY_VERSION ||
    typeof value['releaseRevision'] !== 'string' || !REVISION_RE.test(value['releaseRevision']) ||
    typeof value['generationId'] !== 'string' || value['generationId'].length < 16 ||
    !Number.isSafeInteger(value['windowStartedAtMs']) || (value['windowStartedAtMs'] as number) < 0 ||
    !Number.isSafeInteger(value['maxObservedAtMs']) || (value['maxObservedAtMs'] as number) < 0 ||
    !Number.isSafeInteger(value['resetSequence']) || (value['resetSequence'] as number) < 0 ||
    !Array.isArray(value['claims']) || value['claims'].length > LAUNCHD_RETRY_MAX_ATTEMPTS ||
    !(value['lastHealthyAtMs'] === null || (Number.isSafeInteger(value['lastHealthyAtMs']) &&
      (value['lastHealthyAtMs'] as number) >= 0))) return null;
  const claims: RetryClaim[] = [];
  for (const claim of value['claims']) {
    if (!isRecord(claim) || !exactKeys(claim, ['claimId', 'claimedAtMs']) ||
      typeof claim['claimId'] !== 'string' || claim['claimId'].length < 16 ||
      !Number.isSafeInteger(claim['claimedAtMs']) || (claim['claimedAtMs'] as number) < 0) return null;
    claims.push({ claimId: claim['claimId'], claimedAtMs: claim['claimedAtMs'] as number });
  }
  const windowStartedAtMs = value['windowStartedAtMs'] as number;
  const maxObservedAtMs = value['maxObservedAtMs'] as number;
  if (maxObservedAtMs < windowStartedAtMs || claims.some((claim) =>
    claim.claimedAtMs < windowStartedAtMs || claim.claimedAtMs > maxObservedAtMs)) return null;
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    releaseRevision: value['releaseRevision'],
    generationId: value['generationId'],
    windowStartedAtMs,
    maxObservedAtMs,
    resetSequence: value['resetSequence'] as number,
    claims,
    lastHealthyAtMs: value['lastHealthyAtMs'] as number | null,
  };
}

function stateBytes(state: LaunchdRetryState): Buffer {
  return Buffer.from(JSON.stringify(state), 'utf8');
}

function signState(state: LaunchdRetryState, key: KeyObject): SignedLaunchdRetryState {
  return { state, signature: sign(null, stateBytes(state), key).toString('base64') };
}

function serializeEnvelope(state: LaunchdRetryState, key: KeyObject): string {
  return `${JSON.stringify(signState(state, key))}\n`;
}

function loadKey(paths: RetryPaths): KeyObject | null {
  const raw = readPrivateFile(paths.key, MAX_KEY_BYTES, paths.root);
  if (!raw) return null;
  try {
    const key = createPrivateKey(raw);
    return key.type === 'private' && key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function loadState(paths: RetryPaths, key: KeyObject): LaunchdRetryState | null {
  const raw = readPrivateFile(paths.state, MAX_STATE_BYTES, paths.root);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!isRecord(parsed) || !exactKeys(parsed, ['state', 'signature']) ||
      typeof parsed['signature'] !== 'string') return null;
    const state = parseState(parsed['state']);
    if (!state || `${JSON.stringify(parsed)}\n` !== raw.toString('utf8')) return null;
    const signature = Buffer.from(parsed['signature'], 'base64');
    return verify(null, stateBytes(state), createPublicKey(key), signature) ? state : null;
  } catch {
    return null;
  }
}

function persistState(paths: RetryPaths, state: LaunchdRetryState, key: KeyObject): boolean {
  try {
    writePrivateFileAtomically(
      `${paths.state}.${process.pid}.${randomUUID()}.tmp`,
      paths.state,
      serializeEnvelope(state, key),
      { anchorPath: paths.root, label: 'launchd retry state' },
    );
    return loadState(paths, key) !== null;
  } catch {
    return false;
  }
}

function bootstrap(paths: RetryPaths, releaseRevision: string, nowMs: number): {
  key: KeyObject;
  state: LaunchdRetryState;
} | null {
  if (existsSync(paths.key) || existsSync(paths.state)) return null;
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    writePrivateFileAtomically(
      `${paths.key}.${process.pid}.${randomUUID()}.tmp`,
      paths.key,
      pem,
      { anchorPath: paths.root, label: 'launchd retry signing key' },
    );
    const key = loadKey(paths);
    if (!key) return null;
    const state: LaunchdRetryState = {
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
      releaseRevision,
      generationId: randomUUID(),
      windowStartedAtMs: nowMs,
      maxObservedAtMs: nowMs,
      resetSequence: 0,
      claims: [],
      lastHealthyAtMs: null,
    };
    return persistState(paths, state, key) ? { key, state } : null;
  } catch {
    return null;
  }
}

function validDaemonDisposition(result: DaemonRunResult): boolean {
  const termination = result?.termination;
  if (!isRecord(termination) || typeof termination['reason'] !== 'string' ||
    !DAEMON_REASONS.has(termination['reason']) || typeof termination['retryable'] !== 'boolean' ||
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

function terminal(reason: LaunchdRetryReason, daemonInvoked = false,
  claimNumber: number | null = null, attemptsRemaining: number | null = null): LaunchdRetryControllerResult {
  return { exitCode: 0, reason, daemonInvoked, claimNumber, attemptsRemaining };
}

export async function runLaunchdRetryController(
  options: LaunchdRetryControllerOptions,
): Promise<LaunchdRetryControllerResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return terminal('unsupported-platform');
  const buildIdentity = readBuildIdentity();
  const runtimeRevision = options.runtimeReleaseRevision ?? buildIdentity.revision;
  const runtimeReleaseTrusted = options.runtimeReleaseTrusted ?? (
    buildIdentity.provenance !== 'unavailable' && buildIdentity.dirty !== true
  );
  if (!REVISION_RE.test(options.expectedReleaseRevision) ||
    !runtimeReleaseTrusted || runtimeRevision !== options.expectedReleaseRevision) {
    return terminal('stale-release');
  }
  const nowMs = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return terminal('clock-rollback');
  const killState = options.killSwitchState ?? readKillSwitch;
  if (killState().state !== 'inactive') return terminal('operator-stop');

  const home = options.homeDir ?? homedir();
  const paths = retryPaths(home);
  const lock = acquireLocalStoreLock(paths.lock, 0, {
    anchorPath: home,
    exactPrivateStorage: true,
  });
  if (!lock) return terminal('concurrent-launch');

  try {
    if (killState().state !== 'inactive') return terminal('operator-stop');
    const keyExists = existsSync(paths.key);
    const stateExists = existsSync(paths.state);
    let loaded = !keyExists && !stateExists
      ? bootstrap(paths, runtimeRevision, nowMs)
      : null;
    if (keyExists !== stateExists) return terminal('state-unavailable');
    if (!loaded && keyExists && stateExists) {
      const key = loadKey(paths);
      const state = key ? loadState(paths, key) : null;
      if (!key || !state) return terminal('state-corrupt');
      loaded = { key, state };
    }
    if (!loaded) return terminal('state-persistence-failed');
    const { key, state } = loaded;
    if (state.releaseRevision !== runtimeRevision) return terminal('stale-release');
    if (nowMs < state.maxObservedAtMs) return terminal('clock-rollback');
    if (nowMs - state.windowStartedAtMs > LAUNCHD_RETRY_WINDOW_MS) {
      return terminal('retry-window-expired', false, null, 0);
    }
    if (state.claims.length >= LAUNCHD_RETRY_MAX_ATTEMPTS) {
      return terminal('retry-exhausted', false, null, 0);
    }

    const claimed: LaunchdRetryState = {
      ...state,
      maxObservedAtMs: nowMs,
      claims: [...state.claims, { claimId: randomUUID(), claimedAtMs: nowMs }],
    };
    if (!persistState(paths, claimed, key)) return terminal('state-persistence-failed');
    const claimNumber = claimed.claims.length;
    const remaining = LAUNCHD_RETRY_MAX_ATTEMPTS - claimNumber;
    if (killState().state !== 'inactive') return terminal('operator-stop', false, claimNumber, remaining);

    let result: DaemonRunResult;
    try {
      result = await options.runDaemon();
    } catch {
      return terminal('daemon-disposition-invalid', true, claimNumber, remaining);
    }
    if (!validDaemonDisposition(result)) {
      return terminal('daemon-disposition-invalid', true, claimNumber, remaining);
    }
    if (result.termination.reason === 'clean-completion' && !result.termination.retryable) {
      const completedAtMs = (options.now ?? Date.now)();
      if (!Number.isSafeInteger(completedAtMs) || completedAtMs < claimed.maxObservedAtMs) {
        return terminal('clock-rollback', true, claimNumber, remaining);
      }
      const reset: LaunchdRetryState = {
        ...claimed,
        generationId: randomUUID(),
        windowStartedAtMs: completedAtMs,
        maxObservedAtMs: completedAtMs,
        resetSequence: claimed.resetSequence + 1,
        claims: [],
        lastHealthyAtMs: completedAtMs,
      };
      return persistState(paths, reset, key)
        ? terminal('healthy-completion', true, claimNumber, LAUNCHD_RETRY_MAX_ATTEMPTS)
        : terminal('state-persistence-failed', true, claimNumber, remaining);
    }
    if (!result.termination.retryable) {
      return terminal('daemon-terminal', true, claimNumber, remaining);
    }
    return remaining > 0
      ? { exitCode: 1, reason: 'retry-authorized', daemonInvoked: true, claimNumber, attemptsRemaining: remaining }
      : terminal('retry-exhausted', true, claimNumber, 0);
  } finally {
    releaseLocalStoreLock(lock);
  }
}
