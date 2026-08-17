import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  existsSync,
  fchmodSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  fsyncSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AshlrConfig } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import {
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import {
  resolveGoalConductorTarget,
  type GoalConductorTargetResolution,
} from '../goals/conductor-target.js';
import { nextActionableMilestone } from '../goals/advance.js';
import { goalSnapshotDigest, listGoalsDetailed } from '../goals/store.js';
import { listEnrolled } from '../sandbox/policy.js';
import {
  GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS,
  buildGoalConductorActivationPermitPayload,
  canonicalizeDaemonActivationValue,
  collectGoalConductorActivationContext,
  daemonActivationConfigDigest,
  goalConductorActivationNonceReceiptPath,
  goalConductorActivationReceiptPath,
  parseGoalConductorActivationPermitEnvelope,
  signGoalConductorActivationPermit,
  verifyGoalConductorActivationPermit,
  type DaemonActivationTrustRoot,
  type GoalConductorActivationContext,
  type GoalConductorActivationPermitEnvelope,
} from './activation-permit.js';

const REQUEST_POLICY = 'goal-conductor-permit-request-v1';
const SHA40_RE = /^[a-f0-9]{40}$/u;
const SHA64_RE = /^[a-f0-9]{64}$/u;
const MAX_OPERATOR_FILE_BYTES = 64 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PERMIT_LIFETIME_MS = 120_000;
const PERMIT_FILE_NAME = 'goal-conductor-activation-permit.json';
const PUBLICATION_ROOT_NAME = 'goal-conductor-permit-publication';

export const GOAL_CONDUCTOR_PERMIT_OPERATOR_TEST_CONTROL = Symbol.for(
  'ashlr.goal-conductor-permit-operator.test-control.v1',
);
const TEST_CONTROL_STATE = Symbol.for('ashlr.goal-conductor-permit-operator.test-control.state.v1');

interface PermitOperatorTestControl {
  observePrivateKeyBuffer?: (bytes: Buffer) => void;
  observePinnedFileBuffer?: (path: string, bytes: Buffer) => void;
  pinnedFileRead?: (input: {
    path: string;
    offset: number;
    length: number;
    read: (length?: number) => number;
  }) => number;
  pinnedFilePostFstat?: (input: {
    path: string;
    stat: () => BigIntStats;
  }) => BigIntStats;
  pinnedFilePostLstat?: (input: {
    path: string;
    stat: () => BigIntStats;
  }) => BigIntStats;
  pinnedFileClose?: (input: { path: string; close: () => void }) => void;
}

export function _setGoalConductorPermitOperatorTestControlForTest(
  sentinel: symbol,
  control: PermitOperatorTestControl | undefined,
): void {
  if (sentinel !== GOAL_CONDUCTOR_PERMIT_OPERATOR_TEST_CONTROL || process.env['VITEST'] !== 'true') {
    throw new Error('goal conductor permit operator test control unavailable');
  }
  if (control === undefined) Reflect.deleteProperty(globalThis, TEST_CONTROL_STATE);
  else Reflect.set(globalThis, TEST_CONTROL_STATE, Object.freeze({ ...control }));
}

function testControl(): PermitOperatorTestControl | undefined {
  if (process.env['VITEST'] !== 'true') return undefined;
  return Reflect.get(globalThis, TEST_CONTROL_STATE) as PermitOperatorTestControl | undefined;
}

export interface GoalConductorPermitRequestV1 {
  schemaVersion: 1;
  policyVersion: typeof REQUEST_POLICY;
  requestId: string;
  requestedAt: string;
  expectedReleaseRevision: string;
  trustRoots: DaemonActivationTrustRoot[];
  context: GoalConductorActivationContext;
}

export interface GoalConductorOperatorResult<T = undefined> {
  ok: boolean;
  state: 'ready' | 'blocked' | 'degraded' | 'staged';
  reason: string;
  value?: T;
  permitId?: string;
  command?: readonly string[];
}

export interface GoalConductorRequestDependencies {
  trustRoots?: readonly DaemonActivationTrustRoot[];
  collectContext?: (
    cfg: AshlrConfig,
    target: GoalConductorActivationContext['target'],
  ) => GoalConductorActivationContext;
  resolveTarget?: (goalId: string) => GoalConductorTargetResolution;
  verifyInstalledRelease?: (context: GoalConductorActivationContext, revision: string) => string | null;
  nowMs?: () => number;
}

export interface GoalConductorMintInput {
  requestPath: string;
  privateKeyPath: string;
  outputPath: string;
  nowMs?: number;
}

function resolveLiveGoalConductorTarget(goalId: string): GoalConductorTargetResolution {
  return resolveGoalConductorTarget(goalId, {
    listGoalsDetailed,
    listEnrolled,
    nextActionableMilestone,
    goalSnapshotDigest,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function iso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function ownedByCurrent(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function nestedWithin(anchor: string, candidate: string): boolean {
  const nested = relative(anchor, candidate);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

function exactPrivateDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrent(stat)
      && (process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(PRIVATE_DIRECTORY_MODE))
      && realpathSync(path) === path;
  } catch {
    return false;
  }
}

function canonicalHome(): string | null {
  try {
    const requested = resolve(homedir());
    const canonical = realpathSync(requested);
    return requested === canonical ? canonical : null;
  } catch {
    return null;
  }
}

function inspectExistingPrivateControl(): { home: string; ashlrHome: string; control: string } | null {
  const home = canonicalHome();
  if (!home) return null;
  const ashlrHome = join(home, '.ashlr');
  const control = join(ashlrHome, 'control');
  if (!exactPrivateDirectory(ashlrHome) || !exactPrivateDirectory(control)) return null;
  const ashlrAssurance = assurePrivateStoragePath(
    ashlrHome,
    'directory',
    'inspect-existing',
    { anchorPath: home },
  );
  const controlAssurance = assurePrivateStoragePath(
    control,
    'directory',
    'inspect-existing',
    { anchorPath: home },
  );
  return ashlrAssurance.ok && controlAssurance.ok ? { home, ashlrHome, control } : null;
}

function nearestGitCheckout(path: string): string | null {
  let cursor = path;
  for (;;) {
    if (existsSync(join(cursor, '.git'))) {
      try { return realpathSync(cursor); } catch { return null; }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function externalArtifactPathReason(
  path: string,
  context?: GoalConductorActivationContext,
  peers: readonly string[] = [],
): string | null {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) === '' || existsSync(path)) {
    return 'goal-conductor-operator-output-must-be-new-absolute-canonical-path';
  }
  let parent: string;
  try { parent = realpathSync(dirname(path)); } catch {
    return 'goal-conductor-operator-output-parent-unavailable';
  }
  if (parent !== dirname(path) || !exactPrivateDirectory(parent)) {
    return 'goal-conductor-operator-output-parent-not-exact-private';
  }
  const home = canonicalHome();
  const gitRoot = nearestGitCheckout(parent);
  const forbidden = [
    ...(home ? [join(home, '.ashlr')] : []),
    ...(gitRoot ? [gitRoot] : []),
    ...(context ? [context.releaseTree.path, context.target.projectPath] : []),
    ...peers.map((peer) => dirname(peer)),
  ].map((entry) => resolve(entry));
  if (forbidden.some((entry) => nestedWithin(entry, path))) {
    return 'goal-conductor-operator-output-inside-bound-or-custody-tree';
  }
  return null;
}

function externalExistingArtifactReason(
  path: string,
  context: GoalConductorActivationContext,
): string | null {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return 'goal-conductor-operator-input-path-not-absolute-canonical';
  }
  let canonical: string;
  try { canonical = realpathSync(path); } catch {
    return 'goal-conductor-operator-input-unavailable';
  }
  if (canonical !== path || !exactPrivateDirectory(dirname(path))) {
    return 'goal-conductor-operator-input-parent-not-exact-private';
  }
  const home = canonicalHome();
  const gitRoot = nearestGitCheckout(dirname(path));
  const forbidden = [
    ...(home ? [join(home, '.ashlr')] : []),
    ...(gitRoot ? [gitRoot] : []),
    context.releaseTree.path,
    context.target.projectPath,
  ].map((entry) => resolve(entry));
  return forbidden.some((entry) => nestedWithin(entry, path))
    ? 'goal-conductor-operator-input-inside-bound-tree'
    : null;
}

function inspectCustodyAncestors(path: string): void {
  if (process.platform === 'win32') {
    throw new Error('goal-conductor-permit-operator-unsupported-on-windows');
  }
  let cursor = dirname(path);
  for (;;) {
    const stat = lstatSync(cursor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n) {
      throw new Error('unsafe-custody-ancestor');
    }
    const ownerAllowed = typeof process.getuid !== 'function'
      || stat.uid === BigInt(process.getuid())
      || stat.uid === 0n;
    if (!ownerAllowed || (stat.mode & 0o022n) !== 0n || realpathSync(cursor) !== cursor) {
      throw new Error('unsafe-custody-ancestor');
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function readPinnedPrivateFile(path: string, maxBytes = MAX_OPERATOR_FILE_BYTES): Buffer {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('private-file-path-not-canonical');
  }
  inspectCustodyAncestors(path);
  const assurance = assurePrivateStoragePath(path, 'file', 'inspect-owned', {
    anchorPath: resolve(sep),
  });
  if (!assurance.ok) throw new Error('private-file-acl-unsafe');
  const namedBefore = lstatSync(path, { bigint: true });
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1n
    || !ownedByCurrent(namedBefore) || (namedBefore.mode & 0o777n) !== 0o600n
    || namedBefore.size <= 0n || namedBefore.size > BigInt(maxBytes)) {
    throw new Error('private-file-custody-unsafe');
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  let bytes: Buffer | undefined;
  let transferred = false;
  try {
    try {
      const openedBefore = fstatSync(fd, { bigint: true });
      if (!sameSnapshot(namedBefore, openedBefore)) throw new Error('private-file-changed-during-open');
      bytes = Buffer.alloc(Number(openedBefore.size));
      const control = testControl();
      control?.observePinnedFileBuffer?.(path, bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const length = bytes.length - offset;
        const read = (requestedLength = length): number => {
          if (!Number.isSafeInteger(requestedLength) || requestedLength <= 0 || requestedLength > length) {
            throw new Error('invalid-test-private-file-read-length');
          }
          return readSync(fd, bytes!, offset, requestedLength, offset);
        };
        const count = control?.pinnedFileRead
          ? control.pinnedFileRead({ path, offset, length, read })
          : read();
        if (!Number.isSafeInteger(count) || count <= 0 || count > length) {
          throw new Error('private-file-short-read');
        }
        offset += count;
      }
      const openedAfter = control?.pinnedFilePostFstat
        ? control.pinnedFilePostFstat({ path, stat: () => fstatSync(fd, { bigint: true }) })
        : fstatSync(fd, { bigint: true });
      const namedAfter = control?.pinnedFilePostLstat
        ? control.pinnedFilePostLstat({ path, stat: () => lstatSync(path, { bigint: true }) })
        : lstatSync(path, { bigint: true });
      if (!sameSnapshot(openedBefore, openedAfter) || !sameSnapshot(openedAfter, namedAfter)) {
        throw new Error('private-file-changed-during-read');
      }
    } finally {
      const control = testControl();
      const close = (): void => closeSync(fd);
      if (control?.pinnedFileClose) control.pinnedFileClose({ path, close });
      else close();
    }
    if (!bytes) throw new Error('private-file-read-buffer-unavailable');
    transferred = true;
    return bytes;
  } finally {
    if (!transferred) bytes?.fill(0);
  }
}

function privateKeyLocationReason(input: GoalConductorMintInput, context: GoalConductorActivationContext): string | null {
  const path = input.privateKeyPath;
  if (!isAbsolute(path) || resolve(path) !== path) {
    return 'goal-conductor-private-key-path-not-absolute-canonical';
  }
  let canonical: string;
  try { canonical = realpathSync(path); } catch {
    return 'goal-conductor-private-key-unavailable';
  }
  if (canonical !== path || !exactPrivateDirectory(dirname(path))) {
    return 'goal-conductor-private-key-custody-directory-not-exact-private';
  }
  const home = canonicalHome();
  const gitRoot = nearestGitCheckout(dirname(path));
  const forbidden = [
    ...(home ? [join(home, '.ashlr')] : []),
    ...(gitRoot ? [gitRoot] : []),
    context.releaseTree.path,
    context.target.projectPath,
    dirname(input.requestPath),
    dirname(input.outputPath),
  ].map((entry) => resolve(entry));
  if (forbidden.some((entry) => nestedWithin(entry, path))) {
    return 'goal-conductor-private-key-inside-forbidden-tree';
  }
  return null;
}

function validTrustRoot(value: unknown): value is DaemonActivationTrustRoot {
  if (!isRecord(value) || !exactKeys(value, ['keyId', 'publicKeyPem'])) return false;
  if (typeof value['keyId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value['keyId'])) {
    return false;
  }
  if (typeof value['publicKeyPem'] !== 'string') return false;
  try {
    return createPublicKey(value['publicKeyPem']).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function parseRequest(value: unknown): GoalConductorPermitRequestV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'policyVersion', 'requestId', 'requestedAt',
    'expectedReleaseRevision', 'trustRoots', 'context',
  ])) return null;
  if (value['schemaVersion'] !== 1 || value['policyVersion'] !== REQUEST_POLICY
    || typeof value['requestId'] !== 'string' || !SHA64_RE.test(value['requestId'])
    || !iso(value['requestedAt'])
    || typeof value['expectedReleaseRevision'] !== 'string'
    || !SHA40_RE.test(value['expectedReleaseRevision'])
    || !Array.isArray(value['trustRoots']) || value['trustRoots'].length < 1
    || value['trustRoots'].length > 16 || !value['trustRoots'].every(validTrustRoot)
    || !isRecord(value['context'])) return null;
  if (!exactKeys(value['context'], [
    'nowMs', 'configDigest', 'buildIdentity', 'executable', 'entrypoint',
    'releaseTree', 'authorityStateDigest', 'killSwitchOff',
    'guardHealthHealthy', 'target',
  ])) return null;
  const context = value['context'] as unknown as GoalConductorActivationContext;
  try {
    const probe = buildGoalConductorActivationPermitPayload({
      permitId: '0'.repeat(32), nonce: '0'.repeat(64), keyId: value['trustRoots'][0]!.keyId,
      issuedAt: value['requestedAt'], expiresAt: new Date(Date.parse(value['requestedAt']) + PERMIT_LIFETIME_MS).toISOString(),
      context,
    });
    void probe;
  } catch {
    return null;
  }
  const roots = value['trustRoots'] as DaemonActivationTrustRoot[];
  if (new Set(roots.map((root) => root.keyId)).size !== roots.length) return null;
  const spkiIdentities = roots.map((root) => Buffer.from(
    createPublicKey(root.publicKeyPem).export({ format: 'der', type: 'spki' }),
  ).toString('base64'));
  if (new Set(spkiIdentities).size !== spkiIdentities.length) return null;
  if (context.buildIdentity.provenance !== 'github-actions'
    || context.buildIdentity.dirty !== null
    || context.buildIdentity.revision !== value['expectedReleaseRevision']
    || !context.killSwitchOff
    || !context.guardHealthHealthy
    || context.releaseTree.path !== resolve(context.releaseTree.path)
    || basename(context.releaseTree.path) !== value['expectedReleaseRevision']
    || !context.entrypoint.path.startsWith(`${context.releaseTree.path}${sep}`)) return null;
  return value as unknown as GoalConductorPermitRequestV1;
}

export function canonicalGoalConductorPermitRequest(request: GoalConductorPermitRequestV1): string {
  if (!parseRequest(request)) throw new Error('invalid-goal-conductor-permit-request');
  return `${canonicalizeDaemonActivationValue(request)}\n`;
}

function immutableReleaseReason(context: GoalConductorActivationContext, revision: string): string | null {
  if (context.buildIdentity.provenance !== 'github-actions'
    || context.buildIdentity.dirty !== null
    || context.buildIdentity.revision !== revision) {
    return 'goal-conductor-runtime-build-identity-not-exact-github-actions-release';
  }
  const canonicalHome = realpathSync(resolve(homedir()));
  const expectedRoot = join(canonicalHome, '.local', 'share', 'ashlr', 'releases', revision);
  if (context.releaseTree.path !== expectedRoot || basename(context.releaseTree.path) !== revision) {
    return 'goal-conductor-runtime-is-not-exact-installed-release';
  }
  if (!context.entrypoint.path.startsWith(`${expectedRoot}${sep}`)) {
    return 'goal-conductor-entrypoint-outside-installed-release';
  }
  const pending = [expectedRoot];
  let entries = 0;
  while (pending.length > 0) {
    const path = pending.pop()!;
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !ownedByCurrent(stat) || (stat.mode & 0o222n) !== 0n) {
      return 'goal-conductor-installed-release-not-immutable';
    }
    if (stat.isDirectory()) {
      const directory = opendirSync(path);
      try {
        for (;;) {
          const entry = directory.readSync();
          if (!entry) break;
          entries += 1;
          if (entries > 20_000) return 'goal-conductor-installed-release-entry-bound-exceeded';
          pending.push(join(path, entry.name));
        }
      } finally {
        directory.closeSync();
      }
    } else if (!stat.isFile()) {
      return 'goal-conductor-installed-release-contains-unsupported-entry';
    }
  }
  return null;
}

export function buildGoalConductorPermitRequest(
  cfg: AshlrConfig,
  input: { goalId: string; expectedReleaseRevision: string; outputPath: string },
  dependencies: GoalConductorRequestDependencies = {},
): GoalConductorOperatorResult<GoalConductorPermitRequestV1> {
  const roots = dependencies.trustRoots ?? GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS;
  if (roots.length === 0) {
    return { ok: false, state: 'blocked', reason: 'no-trusted-goal-conductor-activation-roots' };
  }
  if (!SHA40_RE.test(input.expectedReleaseRevision)) {
    return { ok: false, state: 'blocked', reason: 'expected-release-revision-invalid' };
  }
  if (!inspectExistingPrivateControl()) {
    return { ok: false, state: 'blocked', reason: 'goal-conductor-preexisting-private-control-required' };
  }
  const resolution = (dependencies.resolveTarget ?? resolveLiveGoalConductorTarget)(input.goalId);
  if (!resolution.ok || !resolution.target) {
    return { ok: false, state: 'blocked', reason: resolution.reason };
  }
  let context: GoalConductorActivationContext;
  try {
    context = (dependencies.collectContext ?? collectGoalConductorActivationContext)(cfg, resolution.target);
  } catch {
    return { ok: false, state: 'degraded', reason: 'goal-conductor-runtime-context-unavailable' };
  }
  if (context.configDigest !== daemonActivationConfigDigest(cfg)) {
    return { ok: false, state: 'blocked', reason: 'goal-conductor-strict-config-digest-mismatch' };
  }
  if (!context.killSwitchOff) {
    return { ok: false, state: 'blocked', reason: 'kill-switch-is-on' };
  }
  if (!context.guardHealthHealthy) {
    return { ok: false, state: 'blocked', reason: 'guard-health-degraded' };
  }
  let releaseReason: string | null;
  try {
    releaseReason = (dependencies.verifyInstalledRelease ?? immutableReleaseReason)(
      context,
      input.expectedReleaseRevision,
    );
  } catch {
    releaseReason = 'goal-conductor-installed-release-inspection-failed';
  }
  if (releaseReason) return { ok: false, state: 'blocked', reason: releaseReason };
  const outputReason = externalArtifactPathReason(input.outputPath, context);
  if (outputReason) return { ok: false, state: 'blocked', reason: outputReason };
  const requestedAt = new Date((dependencies.nowMs ?? Date.now)()).toISOString();
  const requestWithoutId = {
    schemaVersion: 1 as const,
    policyVersion: REQUEST_POLICY as typeof REQUEST_POLICY,
    requestedAt,
    expectedReleaseRevision: input.expectedReleaseRevision,
    trustRoots: roots.map((root) => ({ keyId: root.keyId, publicKeyPem: root.publicKeyPem })),
    context,
  };
  const request: GoalConductorPermitRequestV1 = {
    ...requestWithoutId,
    requestId: sha256(canonicalizeDaemonActivationValue(requestWithoutId)),
  };
  if (!parseRequest(request)) {
    return { ok: false, state: 'degraded', reason: 'goal-conductor-permit-request-invalid' };
  }
  return { ok: true, state: 'ready', reason: 'goal-conductor-permit-request-ready', value: request };
}

function keySpki(key: KeyObject): Buffer {
  return Buffer.from(createPublicKey(key).export({ format: 'der', type: 'spki' }));
}

export function mintGoalConductorPermitOffline(
  input: GoalConductorMintInput,
): GoalConductorOperatorResult<GoalConductorActivationPermitEnvelope> {
  let requestBytes: Buffer | undefined;
  let privateBytes: Buffer | undefined;
  try {
    requestBytes = readPinnedPrivateFile(input.requestPath);
    const requestText = requestBytes.toString('utf8');
    const raw = JSON.parse(requestText) as unknown;
    const request = parseRequest(raw);
    if (!request || canonicalGoalConductorPermitRequest(request) !== requestText) {
      return { ok: false, state: 'blocked', reason: 'goal-conductor-permit-request-not-canonical' };
    }
    const expectedRequestId = sha256(canonicalizeDaemonActivationValue({
      schemaVersion: request.schemaVersion,
      policyVersion: request.policyVersion,
      requestedAt: request.requestedAt,
      expectedReleaseRevision: request.expectedReleaseRevision,
      trustRoots: request.trustRoots,
      context: request.context,
    }));
    if (request.requestId !== expectedRequestId) {
      return { ok: false, state: 'blocked', reason: 'goal-conductor-permit-request-id-mismatch' };
    }
    const requestPathReason = externalExistingArtifactReason(input.requestPath, request.context);
    if (requestPathReason) return { ok: false, state: 'blocked', reason: requestPathReason };
    const outputReason = externalArtifactPathReason(
      input.outputPath,
      request.context,
      [input.requestPath],
    );
    if (outputReason) return { ok: false, state: 'blocked', reason: outputReason };
    const keyLocationReason = privateKeyLocationReason(input, request.context);
    if (keyLocationReason) return { ok: false, state: 'blocked', reason: keyLocationReason };
    privateBytes = readPinnedPrivateFile(input.privateKeyPath);
    testControl()?.observePrivateKeyBuffer?.(privateBytes);
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: privateBytes, format: 'der', type: 'pkcs8' });
    } catch {
      return { ok: false, state: 'blocked', reason: 'goal-conductor-private-key-invalid' };
    } finally {
      privateBytes.fill(0);
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      return { ok: false, state: 'blocked', reason: 'goal-conductor-private-key-not-ed25519' };
    }
    const publicDer = keySpki(privateKey);
    let root: DaemonActivationTrustRoot | undefined;
    for (const candidate of request.trustRoots) {
      let trusted: Buffer | undefined;
      try {
        trusted = Buffer.from(createPublicKey(candidate.publicKeyPem).export({ format: 'der', type: 'spki' }));
        if (trusted.equals(publicDer)) {
          root = candidate;
          break;
        }
      } catch {
        // The canonical request parser already rejects invalid roots.
      } finally {
        trusted?.fill(0);
      }
    }
    publicDer.fill(0);
    if (!root) {
      return { ok: false, state: 'blocked', reason: 'goal-conductor-private-key-not-request-trusted' };
    }
    const issuedAtMs = input.nowMs ?? Date.now();
    const payload = buildGoalConductorActivationPermitPayload({
      permitId: randomBytes(16).toString('hex'),
      nonce: randomBytes(32).toString('hex'),
      keyId: root.keyId,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + PERMIT_LIFETIME_MS).toISOString(),
      context: request.context,
    });
    const envelope = signGoalConductorActivationPermit(payload, privateKey);
    return {
      ok: true,
      state: 'ready',
      reason: 'goal-conductor-permit-minted-offline',
      permitId: payload.permitId,
      value: envelope,
    };
  } catch {
    return { ok: false, state: 'degraded', reason: 'goal-conductor-offline-mint-failed' };
  } finally {
    requestBytes?.fill(0);
    privateBytes?.fill(0);
  }
}

function receiptPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function inspectGoalConductorPermit(
  cfg: AshlrConfig,
  envelope: GoalConductorActivationPermitEnvelope,
  dependencies: Pick<GoalConductorRequestDependencies,
  'trustRoots' | 'collectContext' | 'resolveTarget' | 'verifyInstalledRelease'> = {},
): GoalConductorOperatorResult<GoalConductorActivationPermitEnvelope> {
  const roots = dependencies.trustRoots ?? GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS;
  if (roots.length === 0) {
    return { ok: false, state: 'blocked', reason: 'no-trusted-goal-conductor-activation-roots' };
  }
  const goalId = envelope?.payload?.bindings?.target?.goalId;
  const resolution = (dependencies.resolveTarget ?? resolveLiveGoalConductorTarget)(goalId ?? '');
  if (!resolution.ok || !resolution.target) {
    return { ok: false, state: 'blocked', reason: resolution.reason };
  }
  let context: GoalConductorActivationContext;
  try {
    context = (dependencies.collectContext ?? collectGoalConductorActivationContext)(cfg, resolution.target);
  } catch {
    return { ok: false, state: 'degraded', reason: 'goal-conductor-runtime-context-unavailable' };
  }
  const checked = verifyGoalConductorActivationPermit(envelope, context, roots);
  if (!checked.ok || !checked.permitId) {
    return { ok: false, state: 'blocked', reason: checked.reason };
  }
  const revision = envelope.payload.bindings.buildIdentity.revision;
  if (typeof revision !== 'string' || !SHA40_RE.test(revision)) {
    return { ok: false, state: 'blocked', reason: 'goal-conductor-release-revision-invalid' };
  }
  let releaseReason: string | null;
  try {
    releaseReason = (dependencies.verifyInstalledRelease ?? immutableReleaseReason)(context, revision);
  } catch {
    releaseReason = 'goal-conductor-installed-release-inspection-failed';
  }
  if (releaseReason) return { ok: false, state: 'blocked', reason: releaseReason };
  const nonceDigest = sha256(envelope.payload.nonce);
  try {
    if (receiptPresent(goalConductorActivationReceiptPath(checked.permitId))
      || receiptPresent(goalConductorActivationNonceReceiptPath(nonceDigest))) {
      return { ok: false, state: 'blocked', reason: 'goal-conductor-permit-already-consumed' };
    }
  } catch {
    return { ok: false, state: 'degraded', reason: 'goal-conductor-replay-state-unavailable' };
  }
  return {
    ok: true,
    state: 'ready',
    reason: 'goal-conductor-permit-ready-to-stage',
    permitId: checked.permitId,
    value: envelope,
    command: Object.freeze(['ashlr', 'loop', '--goal', resolution.target.goalId]),
  };
}

function writeExclusivePrivate(path: string, text: string, anchorPath: string): void {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    PRIVATE_FILE_MODE,
  );
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
    const initial = fstatSync(fd, { bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n || !ownedByCurrent(initial)
      || (initial.mode & 0o777n) !== 0o600n || initial.size !== 0n) {
      throw new Error('unsafe-created-private-file');
    }
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('private-file-write-made-no-progress');
      offset += count;
    }
    fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== initial.dev || after.ino !== initial.ino
      || after.size !== BigInt(bytes.length) || after.nlink !== 1n) {
      throw new Error('private-file-changed-during-write');
    }
    const assurance = assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath });
    if (!assurance.ok) throw new Error('unsafe-created-private-file-acl');
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

export function writeGoalConductorOperatorArtifact(path: string, value: unknown): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('operator-output-path-not-canonical');
  const parent = dirname(path);
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== parent || !exactPrivateDirectory(parent)) {
    throw new Error('operator-output-parent-not-exact-private');
  }
  const request = parseRequest(value);
  const envelope = parseGoalConductorActivationPermitEnvelope(value);
  const artifactContext = request?.context ?? (envelope ? contextFromEnvelope(envelope) : null);
  if (!artifactContext) throw new Error('operator-output-artifact-invalid');
  const pathReason = externalArtifactPathReason(path, artifactContext);
  if (pathReason) throw new Error(pathReason);
  inspectCustodyAncestors(path);
  writeExclusivePrivate(path, `${canonicalizeDaemonActivationValue(value)}\n`, resolve(sep));
}

function contextFromEnvelope(
  value: GoalConductorActivationPermitEnvelope,
): GoalConductorActivationContext {
  const bindings = value.payload.bindings;
  return {
    nowMs: 0,
    configDigest: bindings.configDigest,
    buildIdentity: bindings.buildIdentity,
    executable: bindings.executable,
    entrypoint: bindings.entrypoint,
    releaseTree: bindings.releaseTree,
    authorityStateDigest: bindings.authorityStateDigest,
    killSwitchOff: true,
    guardHealthHealthy: true,
    target: bindings.target,
  };
}

const permitPublicationCodec: ImmutablePrivateRecordCodec<GoalConductorActivationPermitEnvelope> = {
  parse: parseGoalConductorActivationPermitEnvelope,
  serialize: (envelope) => `${canonicalizeDaemonActivationValue(envelope)}\n`,
  recordId: (envelope) => envelope.payload.permitId,
  recordFileName: () => PERMIT_FILE_NAME,
  isRecordFileName: (fileName) => fileName === PERMIT_FILE_NAME,
  stageToken: (envelope) => sha256(canonicalizeDaemonActivationValue(envelope)).slice(0, 32),
  equivalent: (left, right) => (
    canonicalizeDaemonActivationValue(left) === canonicalizeDaemonActivationValue(right)
  ),
};

export function goalConductorPermitPublicationRootPath(): string {
  return join(homedir(), '.ashlr', 'control', PUBLICATION_ROOT_NAME);
}

function permitPublicationConfig(
  control: string,
): ImmutablePrivateRecordStoreConfig<GoalConductorActivationPermitEnvelope> {
  return {
    label: 'goal conductor activation permit',
    anchorPath: control,
    rootPath: join(control, PUBLICATION_ROOT_NAME),
    lockFileName: '.goal-conductor-permit-publication.lock',
    maxRecordBytes: MAX_OPERATOR_FILE_BYTES,
    defaultMaxFiles: 1,
    hardMaxFiles: 1,
    defaultMaxBytes: MAX_OPERATOR_FILE_BYTES,
    hardMaxBytes: MAX_OPERATOR_FILE_BYTES,
    codecForWrite: () => permitPublicationCodec,
    codecForRead: () => permitPublicationCodec,
  };
}

export function stageGoalConductorPermit(
  cfg: AshlrConfig,
  envelope: GoalConductorActivationPermitEnvelope,
  dependencies: Pick<GoalConductorRequestDependencies,
  'trustRoots' | 'collectContext' | 'resolveTarget' | 'verifyInstalledRelease'> = {},
): GoalConductorOperatorResult<GoalConductorActivationPermitEnvelope> {
  const inspection = inspectGoalConductorPermit(cfg, envelope, dependencies);
  if (!inspection.ok || !inspection.command) return inspection;
  const privateControl = inspectExistingPrivateControl();
  if (!privateControl) {
    return { ok: false, state: 'blocked', reason: 'goal-conductor-preexisting-private-control-required' };
  }
  const disposition = writeImmutablePrivateRecord(
    permitPublicationConfig(privateControl.control),
    envelope,
  );
  if (disposition !== 'recorded') {
    return {
      ok: false,
      state: 'blocked',
      reason: disposition === 'replayed' || disposition === 'conflicted'
        ? 'goal-conductor-staged-permit-already-exists'
        : 'goal-conductor-permit-stage-failed',
    };
  }
  return {
    ok: true,
    state: 'staged',
    reason: 'goal-conductor-permit-staged',
    permitId: inspection.permitId,
    command: inspection.command,
  };
}

export function readGoalConductorOperatorEnvelope(path: string): GoalConductorActivationPermitEnvelope {
  const bytes = readPinnedPrivateFile(path);
  try {
    const text = bytes.toString('utf8');
    const value = JSON.parse(text) as GoalConductorActivationPermitEnvelope;
    if (`${canonicalizeDaemonActivationValue(value)}\n` !== text) {
      throw new Error('goal-conductor-permit-not-canonical');
    }
    const pathReason = externalExistingArtifactReason(path, contextFromEnvelope(value));
    if (pathReason) throw new Error(pathReason);
    return value;
  } finally {
    bytes.fill(0);
  }
}
