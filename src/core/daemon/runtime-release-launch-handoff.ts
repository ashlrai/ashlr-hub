/**
 * Dormant POSIX proof of a descriptor-retaining release launch handoff.
 *
 * This module deliberately has no service or daemon integration. Its durable
 * claim is cooperative under one OS account, and every returned authority bit
 * remains false.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  readImmutablePrivateRecordPoint,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
  type ImmutablePrivateRecordWriteDisposition,
} from '../util/immutable-private-record-store.js';
import {
  observeRuntimeReleaseLaunchInputs,
  type RuntimeReleaseLaunchObservationOptions,
  type RuntimeReleaseLaunchObservationReceiptV2,
} from './runtime-release-launch-revalidation.js';

const PROTOCOL = 'runtime-release-launch-handoff-v1' as const;
const TRANSACTION_DOMAIN = 'ashlr:runtime-release-launch-handoff:transaction:v1';
const NONCE_DOMAIN = 'ashlr:runtime-release-launch-handoff:nonce:v1';
const CLAIM_DOMAIN = 'ashlr:runtime-release-launch-handoff:claim:v1';
const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const MAX_ACK_TIMEOUT_MS = 30_000;
const CHILD_TERMINATION_TIMEOUT_MS = 1_000;
const CHILD_GROUP_POLL_MS = 20;
const CHILD_STARTUP_ERROR_TIMEOUT_MS = 1_000;
const MAX_ACK_BYTES = 16 * 1_024;
const MAX_CLAIMS = 25_000;
const MAX_CLAIM_BYTES = 16 * 1_024;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const NONCE_RE = /^[a-f0-9]{64}$/u;

const AUTHORITY = Object.freeze({
  activationPermitted: false,
  deployPermitted: false,
  installPermitted: false,
  launchPermitted: false,
  mergePermitted: false,
  rollbackPermitted: false,
  startPermitted: false,
} as const);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type DescriptorLabel = 'dependencyRoot' | 'interpreter' | 'launcher' | 'packageRoot';
type ProofChild = ChildProcess;

interface DescriptorIdentity {
  ctimeNs: string;
  dev: string;
  ino: string;
  mode: string;
  mtimeNs: string;
  nlink: string;
  size: string;
}

interface PinnedDescriptor {
  fd: number;
  identity: DescriptorIdentity;
  kind: 'directory' | 'file';
  label: DescriptorLabel;
  path: string;
}

interface RuntimeReleaseLaunchHandoffBindingsV1 {
  envelopeCanonicalSha256: string;
  manifestDigest: string;
  policyCanonicalSha256: string;
  serviceInvocationDigest: string;
  stagedTreeIdentity: string;
  trustRootCanonicalSha256: string;
}

interface RuntimeReleaseLaunchHandoffClaimV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authority: 'observation-only';
  activationPermitted: false;
  deployPermitted: false;
  installPermitted: false;
  launchPermitted: false;
  mergePermitted: false;
  rollbackPermitted: false;
  startPermitted: false;
  cooperativeOneUse: true;
  sameUserTamperResistant: false;
  nonceDigest: string;
  transactionId: string;
  bindings: RuntimeReleaseLaunchHandoffBindingsV1;
  claimDigest: string;
}

interface ProofChildAcknowledgementV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  transactionId: string;
  nonceDigest: string;
  pid: number;
  descriptors: Record<DescriptorLabel, DescriptorIdentity>;
}

export interface RuntimeReleaseLaunchHandoffVerificationHooks {
  afterAcknowledgement?: () => void;
  afterDescriptorsPinned?: () => void;
  afterInitialObservation?: () => void;
  afterProofChildSpawn?: (pid: number) => void;
  beforeProofChildSpawn?: () => void;
  forceCleanupUnconfirmed?: boolean;
  platform?: NodeJS.Platform;
  proofChildSource?: string;
}

export interface RuntimeReleaseLaunchHandoffOptionsV1
  extends RuntimeReleaseLaunchObservationOptions {
  acknowledgementTimeoutMs?: number;
  claimStoreAnchorPath?: string;
  handoffNonce: string;
}

export interface RuntimeReleaseLaunchHandoffReceiptV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  assurance: 'bounded-posix-proof-child-observation-only';
  authority: typeof AUTHORITY;
  claim: {
    disposition: 'recorded';
    cooperativeOneUse: true;
    sameUserTamperResistant: false;
    nonceDigest: string;
  };
  coverage: {
    atomicLaunchHandoff: 'bounded-proof-child-observation-only';
    descriptorLifetime: 'retained-through-proof-child-acknowledgement';
    launchConsumer: 'proof-child-only-terminated';
    mutationAfterReceipt: 'not-prevented';
    replayPrevention: 'host-local-cooperative-one-use';
    serviceMutation: 'absent';
  };
  transactionId: string;
  bindings: RuntimeReleaseLaunchHandoffBindingsV1;
  proofChild: {
    acknowledged: true;
    directChildCloseObserved: true;
    pid: number;
    processGroupDeathObserved: true;
    processGroupId: number;
    signalsAttempted: Array<'SIGTERM' | 'SIGKILL'>;
    terminated: true;
  };
}

export interface RuntimeReleaseLaunchHandoffCleanupEvidenceV1 {
  bounded: true;
  directChildCloseObserved: boolean;
  pid: number;
  processGroupDeathObserved: boolean;
  processGroupId: number;
  signalsAttempted: Array<'SIGTERM' | 'SIGKILL'>;
}

export type RuntimeReleaseLaunchHandoffResultV1 =
  | {
    ok: true;
    authority: typeof AUTHORITY;
    claimDisposition: 'recorded';
    receipt: RuntimeReleaseLaunchHandoffReceiptV1;
  }
  | {
    ok: false;
    authority: typeof AUTHORITY;
    claimDisposition: ImmutablePrivateRecordWriteDisposition | 'not-attempted';
    remediation?: RuntimeReleaseLaunchHandoffCleanupEvidenceV1;
    reason: string;
  };

const PROOF_CHILD_SOURCE = String.raw`
const fs = require('node:fs');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const identity = (fd) => {
  const stat = fs.fstatSync(fd, { bigint: true });
  return {
    ctimeNs: stat.ctimeNs.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
  };
};
const ack = {
  schemaVersion: 1,
  protocol: 'runtime-release-launch-handoff-v1',
  transactionId: process.argv[1],
  nonceDigest: process.argv[2],
  pid: process.pid,
  descriptors: {
    packageRoot: identity(3),
    dependencyRoot: identity(4),
    launcher: identity(5),
    interpreter: identity(6),
  },
};
process.stdout.end(JSON.stringify(canonical(ack)) + '\n');
setInterval(() => {}, 1000);
`;

function canonicalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('invalid JSON value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse JSON array');
        return canonicalize(entry, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('non-plain JSON object');
    }
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function domainDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function sameDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function descriptorIdentity(stat: BigIntStats): DescriptorIdentity {
  return {
    ctimeNs: stat.ctimeNs.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
  };
}

function sameDescriptorIdentity(left: DescriptorIdentity, right: DescriptorIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validDescriptorIdentity(value: unknown): value is DescriptorIdentity {
  if (!plainObject(value) || !exactKeys(value, [
    'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size',
  ])) return false;
  return Object.values(value).every((entry) => typeof entry === 'string' && /^\d+$/u.test(entry));
}

function closePinned(descriptors: readonly PinnedDescriptor[]): void {
  for (const descriptor of descriptors) {
    try { closeSync(descriptor.fd); } catch { /* preserve the original outcome */ }
  }
}

function pinDescriptor(
  label: DescriptorLabel,
  path: string,
  kind: PinnedDescriptor['kind'],
): PinnedDescriptor {
  const canonical = resolve(path);
  if (!isAbsolute(path) || realpathSync(canonical) !== canonical) {
    throw new Error(`runtime release handoff ${label} path is not canonical`);
  }
  const before = lstatSync(canonical, { bigint: true });
  if (before.isSymbolicLink() || (kind === 'file' ? !before.isFile() : !before.isDirectory())) {
    throw new Error(`runtime release handoff ${label} has the wrong type`);
  }
  if (kind === 'file' && before.nlink !== 1n) {
    throw new Error(`runtime release handoff ${label} has multiple hard links`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const directory = kind === 'directory' && typeof fsConstants.O_DIRECTORY === 'number'
    ? fsConstants.O_DIRECTORY
    : 0;
  const fd = openSync(canonical, fsConstants.O_RDONLY | noFollow | directory);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if ((kind === 'file' ? !opened.isFile() : !opened.isDirectory()) ||
      canonicalJson(descriptorIdentity(before)) !== canonicalJson(descriptorIdentity(opened))) {
      throw new Error(`runtime release handoff ${label} changed before descriptor pin`);
    }
    return { fd, identity: descriptorIdentity(opened), kind, label, path: canonical };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function pinLaunchDescriptors(options: RuntimeReleaseLaunchObservationOptions): PinnedDescriptor[] {
  const pinned: PinnedDescriptor[] = [];
  try {
    pinned.push(pinDescriptor('packageRoot', options.packageRoot, 'directory'));
    pinned.push(pinDescriptor('dependencyRoot', options.dependencyRoot, 'directory'));
    pinned.push(pinDescriptor('launcher', options.argv[0]!, 'file'));
    pinned.push(pinDescriptor('interpreter', options.declaredInterpreterPath, 'file'));
    return pinned;
  } catch (error) {
    closePinned(pinned);
    throw error;
  }
}

function revalidatePinnedDescriptor(descriptor: PinnedDescriptor): boolean {
  try {
    const opened = fstatSync(descriptor.fd, { bigint: true });
    const named = lstatSync(descriptor.path, { bigint: true });
    const expected = descriptor.identity;
    return (descriptor.kind === 'file' ? opened.isFile() && named.isFile() :
      opened.isDirectory() && named.isDirectory()) &&
      !named.isSymbolicLink() &&
      (descriptor.kind === 'directory' || (opened.nlink === 1n && named.nlink === 1n)) &&
      realpathSync(descriptor.path) === descriptor.path &&
      sameDescriptorIdentity(expected, descriptorIdentity(opened)) &&
      sameDescriptorIdentity(expected, descriptorIdentity(named));
  } catch {
    return false;
  }
}

function claimPayload(
  nonceDigest: string,
  transactionId: string,
  bindings: RuntimeReleaseLaunchHandoffBindingsV1,
): Omit<RuntimeReleaseLaunchHandoffClaimV1, 'claimDigest'> {
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    ...AUTHORITY,
    cooperativeOneUse: true,
    sameUserTamperResistant: false,
    nonceDigest,
    transactionId,
    bindings,
  };
}

function parseBindings(value: unknown): RuntimeReleaseLaunchHandoffBindingsV1 | null {
  if (!plainObject(value) || !exactKeys(value, [
    'envelopeCanonicalSha256',
    'manifestDigest',
    'policyCanonicalSha256',
    'serviceInvocationDigest',
    'stagedTreeIdentity',
    'trustRootCanonicalSha256',
  ])) return null;
  return Object.values(value).every((entry) => typeof entry === 'string' && SHA256_RE.test(entry))
    ? value as unknown as RuntimeReleaseLaunchHandoffBindingsV1
    : null;
}

function parseClaim(value: unknown): RuntimeReleaseLaunchHandoffClaimV1 | null {
  if (!plainObject(value) || !exactKeys(value, [
    'schemaVersion', 'protocol', 'authority', 'activationPermitted',
    'deployPermitted', 'installPermitted', 'launchPermitted', 'mergePermitted',
    'rollbackPermitted', 'startPermitted', 'cooperativeOneUse',
    'sameUserTamperResistant', 'nonceDigest', 'transactionId', 'bindings',
    'claimDigest',
  ])) return null;
  const bindings = parseBindings(value['bindings']);
  if (value['schemaVersion'] !== 1 || value['protocol'] !== PROTOCOL ||
    value['authority'] !== 'observation-only' ||
    value['activationPermitted'] !== false || value['deployPermitted'] !== false ||
    value['installPermitted'] !== false || value['launchPermitted'] !== false ||
    value['mergePermitted'] !== false || value['rollbackPermitted'] !== false ||
    value['startPermitted'] !== false || value['cooperativeOneUse'] !== true ||
    value['sameUserTamperResistant'] !== false ||
    typeof value['nonceDigest'] !== 'string' || !SHA256_RE.test(value['nonceDigest']) ||
    typeof value['transactionId'] !== 'string' || !SHA256_RE.test(value['transactionId']) ||
    typeof value['claimDigest'] !== 'string' || !SHA256_RE.test(value['claimDigest']) ||
    bindings === null) return null;
  const payload = claimPayload(value['nonceDigest'], value['transactionId'], bindings);
  if (!sameDigest(value['claimDigest'], domainDigest(CLAIM_DOMAIN, payload))) return null;
  return { ...payload, claimDigest: value['claimDigest'] };
}

function claimCodec(): ImmutablePrivateRecordCodec<RuntimeReleaseLaunchHandoffClaimV1> {
  return {
    parse: parseClaim,
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.nonceDigest,
    recordFileName: (record) => `${record.nonceDigest}.json`,
    isRecordFileName: (fileName) =>
      fileName.endsWith('.json') && SHA256_RE.test(fileName.slice(0, -5)),
    stageToken: (record) => record.claimDigest,
    equivalent: (left, right) =>
      sameDigest(left.nonceDigest, right.nonceDigest) &&
      sameDigest(left.transactionId, right.transactionId) &&
      sameDigest(left.claimDigest, right.claimDigest),
  };
}

function storageAnchor(options: RuntimeReleaseLaunchHandoffOptionsV1): string | null {
  try {
    const configured = options.claimStoreAnchorPath ?? join(homedir(), '.ashlr');
    if (!isAbsolute(configured)) return null;
    const canonical = resolve(configured);
    return canonical === parse(canonical).root ? null : canonical;
  } catch {
    return null;
  }
}

function claimStoreConfig(
  anchorPath: string,
): ImmutablePrivateRecordStoreConfig<RuntimeReleaseLaunchHandoffClaimV1> {
  return {
    label: 'runtime release launch handoff claim',
    anchorPath,
    rootPath: join(anchorPath, 'runtime-release-launch-handoff-v1'),
    lockFileName: '.runtime-release-launch-handoff.lock',
    maxRecordBytes: MAX_CLAIM_BYTES,
    defaultMaxFiles: MAX_CLAIMS,
    hardMaxFiles: MAX_CLAIMS,
    defaultMaxBytes: MAX_CLAIMS * MAX_CLAIM_BYTES,
    hardMaxBytes: MAX_CLAIMS * MAX_CLAIM_BYTES,
    codecForRead: claimCodec,
    codecForWrite: claimCodec,
  };
}

function acknowledgementTimeout(options: RuntimeReleaseLaunchHandoffOptionsV1): number | null {
  if (options.acknowledgementTimeoutMs === undefined) return DEFAULT_ACK_TIMEOUT_MS;
  return Number.isSafeInteger(options.acknowledgementTimeoutMs) &&
    options.acknowledgementTimeoutMs >= 1 &&
    options.acknowledgementTimeoutMs <= MAX_ACK_TIMEOUT_MS
    ? options.acknowledgementTimeoutMs
    : null;
}

function freshLaunchObservationOptions(
  options: RuntimeReleaseLaunchHandoffOptionsV1,
): RuntimeReleaseLaunchObservationOptions {
  return {
    argv: [...options.argv],
    declaredInterpreterPath: options.declaredInterpreterPath,
    declaredInterpreterVersion: options.declaredInterpreterVersion,
    dependencyRoot: options.dependencyRoot,
    envelope: Buffer.isBuffer(options.envelope) ? Buffer.from(options.envelope) : options.envelope,
    executablePath: options.executablePath,
    expectedEnvelopeCanonicalSha256: options.expectedEnvelopeCanonicalSha256,
    expectedKeyId: options.expectedKeyId,
    expectedManifestDigest: options.expectedManifestDigest,
    ...(options.expectedPackageName === undefined
      ? {}
      : { expectedPackageName: options.expectedPackageName }),
    expectedPolicyId: options.expectedPolicyId,
    expectedRevision: options.expectedRevision,
    expectedServiceInvocationDigest: options.expectedServiceInvocationDigest,
    expectedStagedTreeIdentity: options.expectedStagedTreeIdentity,
    expectedTrustRootCanonicalSha256: options.expectedTrustRootCanonicalSha256,
    manifest: Buffer.isBuffer(options.manifest) ? Buffer.from(options.manifest) : options.manifest,
    packageRoot: options.packageRoot,
    policy: Buffer.isBuffer(options.policy) ? Buffer.from(options.policy) : options.policy,
    trustRoot: Buffer.isBuffer(options.trustRoot) ? Buffer.from(options.trustRoot) : options.trustRoot,
  };
}

function observationBindings(
  receipt: RuntimeReleaseLaunchObservationReceiptV2,
): RuntimeReleaseLaunchHandoffBindingsV1 {
  return {
    envelopeCanonicalSha256: receipt.release.envelopeCanonicalSha256,
    manifestDigest: receipt.release.manifestDigest,
    policyCanonicalSha256: receipt.policy.canonicalSha256,
    serviceInvocationDigest: receipt.invocation.serviceInvocationDigest,
    stagedTreeIdentity: receipt.stagedTreeIdentity,
    trustRootCanonicalSha256: receipt.release.trustRootCanonicalSha256,
  };
}

function sameBindings(
  left: RuntimeReleaseLaunchHandoffBindingsV1,
  right: RuntimeReleaseLaunchHandoffBindingsV1,
): boolean {
  return Object.keys(left).every((key) => sameDigest(
    left[key as keyof RuntimeReleaseLaunchHandoffBindingsV1],
    right[key as keyof RuntimeReleaseLaunchHandoffBindingsV1],
  ));
}

function parseAcknowledgement(value: unknown): ProofChildAcknowledgementV1 | null {
  if (!plainObject(value) || !exactKeys(value, [
    'schemaVersion', 'protocol', 'transactionId', 'nonceDigest', 'pid', 'descriptors',
  ]) || value['schemaVersion'] !== 1 || value['protocol'] !== PROTOCOL ||
    typeof value['transactionId'] !== 'string' || !SHA256_RE.test(value['transactionId']) ||
    typeof value['nonceDigest'] !== 'string' || !SHA256_RE.test(value['nonceDigest']) ||
    !Number.isSafeInteger(value['pid']) || Number(value['pid']) <= 0 ||
    !plainObject(value['descriptors']) || !exactKeys(value['descriptors'], [
      'dependencyRoot', 'interpreter', 'launcher', 'packageRoot',
    ])) return null;
  const descriptors = value['descriptors'];
  if (!validDescriptorIdentity(descriptors['dependencyRoot']) ||
    !validDescriptorIdentity(descriptors['interpreter']) ||
    !validDescriptorIdentity(descriptors['launcher']) ||
    !validDescriptorIdentity(descriptors['packageRoot'])) return null;
  return value as unknown as ProofChildAcknowledgementV1;
}

function acknowledgementMatches(
  acknowledgement: ProofChildAcknowledgementV1,
  transactionId: string,
  nonceDigest: string,
  descriptors: readonly PinnedDescriptor[],
  childPid: number,
): boolean {
  if (acknowledgement.pid !== childPid ||
    !sameDigest(acknowledgement.transactionId, transactionId) ||
    !sameDigest(acknowledgement.nonceDigest, nonceDigest)) return false;
  return descriptors.every((descriptor) =>
    sameDescriptorIdentity(
      descriptor.identity,
      acknowledgement.descriptors[descriptor.label],
    ));
}

function processGroupIsDead(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForGroupCleanup(
  processGroupId: number,
  directChildCloseObserved: () => boolean,
  timeoutMs: number,
): Promise<{ directChildCloseObserved: boolean; processGroupDeathObserved: boolean }> {
  const deadline = performance.now() + timeoutMs;
  do {
    const directClosed = directChildCloseObserved();
    const groupDead = processGroupIsDead(processGroupId);
    if (directClosed && groupDead) {
      return { directChildCloseObserved: true, processGroupDeathObserved: true };
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, CHILD_GROUP_POLL_MS));
  } while (performance.now() < deadline);
  return {
    directChildCloseObserved: directChildCloseObserved(),
    processGroupDeathObserved: processGroupIsDead(processGroupId),
  };
}

async function terminateProofProcessGroup(
  child: ProofChild,
  processGroupId: number,
  directChildCloseObserved: () => boolean,
): Promise<RuntimeReleaseLaunchHandoffCleanupEvidenceV1> {
  const signalsAttempted: Array<'SIGTERM' | 'SIGKILL'> = [];
  signalsAttempted.push('SIGTERM');
  try { signalProcessGroup(processGroupId, 'SIGTERM'); } catch { /* continue to bounded KILL */ }
  let observed = await waitForGroupCleanup(
    processGroupId,
    directChildCloseObserved,
    CHILD_TERMINATION_TIMEOUT_MS,
  );
  if (!observed.directChildCloseObserved || !observed.processGroupDeathObserved) {
    signalsAttempted.push('SIGKILL');
    try { signalProcessGroup(processGroupId, 'SIGKILL'); } catch { /* report incomplete cleanup */ }
    observed = await waitForGroupCleanup(
      processGroupId,
      directChildCloseObserved,
      CHILD_TERMINATION_TIMEOUT_MS,
    );
  }
  return {
    bounded: true,
    directChildCloseObserved: observed.directChildCloseObserved,
    pid: child.pid ?? processGroupId,
    processGroupDeathObserved: observed.processGroupDeathObserved,
    processGroupId,
    signalsAttempted,
  };
}

async function runProofChild(
  options: RuntimeReleaseLaunchHandoffOptionsV1,
  descriptors: readonly PinnedDescriptor[],
  transactionId: string,
  nonceDigest: string,
  timeoutMs: number,
  hooks: RuntimeReleaseLaunchHandoffVerificationHooks | undefined,
  validateAfterAck: () => { ok: true } | { ok: false; reason: string },
): Promise<
  | { ok: true; cleanup: RuntimeReleaseLaunchHandoffCleanupEvidenceV1; pid: number }
  | { ok: false; reason: string; remediation?: RuntimeReleaseLaunchHandoffCleanupEvidenceV1 }
> {
  try {
    hooks?.beforeProofChildSpawn?.();
  } catch {
    return { ok: false, reason: 'runtime release handoff proof child hook failed' };
  }
  let child: ProofChild;
  try {
    child = spawn(
      options.executablePath,
      ['--eval', hooks?.proofChildSource ?? PROOF_CHILD_SOURCE, transactionId, nonceDigest],
      {
        cwd: options.packageRoot,
        detached: true,
        env: {},
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', ...descriptors.map((descriptor) => descriptor.fd)],
        windowsHide: true,
      },
    );
  } catch {
    return { ok: false, reason: 'runtime release handoff proof child spawn failed' };
  }
  let childErrorObserved = false;
  const childError = new Promise<void>((resolveError) => {
    child.once('error', () => {
      childErrorObserved = true;
      resolveError();
    });
  });
  const childPid = child.pid;
  if (childPid === undefined) {
    await Promise.race([
      childError,
      new Promise<void>((resolveWait) => setTimeout(resolveWait, CHILD_STARTUP_ERROR_TIMEOUT_MS)),
    ]);
    return {
      ok: false,
      reason: childErrorObserved
        ? 'runtime release handoff proof child spawn failed'
        : 'runtime release handoff proof child pid is unavailable',
    };
  }
  const processGroupId = childPid;
  let directChildCloseObserved = false;
  child.once('close', () => { directChildCloseObserved = true; });
  const cleanup = async (): Promise<RuntimeReleaseLaunchHandoffCleanupEvidenceV1> => {
    const observed = await terminateProofProcessGroup(
      child,
      processGroupId,
      () => directChildCloseObserved,
    );
    return hooks?.forceCleanupUnconfirmed === true
      ? { ...observed, processGroupDeathObserved: false }
      : observed;
  };
  const cleanupFailure = (
    reason: string,
    evidence: RuntimeReleaseLaunchHandoffCleanupEvidenceV1,
  ): { ok: false; reason: string; remediation?: RuntimeReleaseLaunchHandoffCleanupEvidenceV1 } =>
    evidence.directChildCloseObserved && evidence.processGroupDeathObserved
      ? { ok: false, reason }
      : {
        ok: false,
        reason: 'runtime release handoff proof process-group cleanup was not confirmed',
        remediation: evidence,
      };
  if (child.stdout === null || child.stderr === null) {
    return cleanupFailure(
      'runtime release handoff proof child pipes are unavailable',
      await cleanup(),
    );
  }
  try {
    hooks?.afterProofChildSpawn?.(childPid);
  } catch {
    return cleanupFailure('runtime release handoff proof child hook failed', await cleanup());
  }

  const result = await new Promise<{ ok: true; pid: number } | { ok: false; reason: string }>(
    (resolveResult) => {
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      let exitObserved = false;
      const finish = (value: { ok: true; pid: number } | { ok: false; reason: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult(value);
      };
      const timer = setTimeout(() => finish({
        ok: false,
        reason: 'runtime release handoff proof child acknowledgement timed out',
      }), timeoutMs);
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_ACK_BYTES) finish({
          ok: false,
          reason: 'runtime release handoff proof child stderr exceeded limit',
        });
      });
      child.stdout!.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > MAX_ACK_BYTES) {
          finish({ ok: false, reason: 'runtime release handoff acknowledgement exceeded limit' });
        }
      });
      child.stdout!.once('end', () => {
        if (settled) return;
        if (stdout.length === 0) {
          finish({
            ok: false,
            reason: 'runtime release handoff proof child exited before completion',
          });
          return;
        }
        const text = stdout.toString('utf8');
        if (!stdout.equals(Buffer.from(text, 'utf8')) ||
          !text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
          finish({ ok: false, reason: 'runtime release handoff acknowledgement was not singular' });
          return;
        }
        try {
          const acknowledgement = parseAcknowledgement(
            JSON.parse(text.slice(0, -1)),
          );
          if (acknowledgement === null) {
            finish({ ok: false, reason: 'runtime release handoff acknowledgement mismatch' });
            return;
          }
          const canonicalFrame = Buffer.from(`${canonicalJson(acknowledgement)}\n`, 'utf8');
          if (!stdout.equals(canonicalFrame)) {
            finish({
              ok: false,
              reason: 'runtime release handoff acknowledgement frame is not canonical',
            });
            return;
          }
          if (!acknowledgementMatches(
            acknowledgement,
            transactionId,
            nonceDigest,
            descriptors,
            childPid,
          )) {
            finish({ ok: false, reason: 'runtime release handoff acknowledgement mismatch' });
            return;
          }
          hooks?.afterAcknowledgement?.();
          const validation = validateAfterAck();
          finish(validation.ok ? { ok: true, pid: childPid } : validation);
        } catch {
          finish({ ok: false, reason: 'runtime release handoff acknowledgement is invalid' });
        }
      });
      child.stdout!.once('error', () => finish({
        ok: false,
        reason: 'runtime release handoff acknowledgement stream failed',
      }));
      void childError.then(() => finish({
        ok: false,
        reason: 'runtime release handoff proof child failed',
      }));
      child.once('exit', () => { exitObserved = true; });
      child.stdout!.once('close', () => {
        if (!settled && exitObserved && stdout.length === 0) {
          finish({
            ok: false,
            reason: 'runtime release handoff proof child exited before completion',
          });
        }
      });
    },
  );
  const cleanupEvidence = await cleanup();
  if (!cleanupEvidence.directChildCloseObserved || !cleanupEvidence.processGroupDeathObserved) {
    return {
      ok: false,
      reason: 'runtime release handoff proof process-group cleanup was not confirmed',
      remediation: cleanupEvidence,
    };
  }
  return result.ok
    ? { ...result, cleanup: cleanupEvidence }
    : result;
}

function failure(
  reason: string,
  claimDisposition: RuntimeReleaseLaunchHandoffResultV1['claimDisposition'] = 'not-attempted',
  remediation?: RuntimeReleaseLaunchHandoffCleanupEvidenceV1,
): RuntimeReleaseLaunchHandoffResultV1 {
  return {
    ok: false,
    authority: AUTHORITY,
    claimDisposition,
    ...(remediation ? { remediation } : {}),
    reason,
  };
}

/**
 * Performs a bounded proof-child handoff observation. It never executes the
 * supplied daemon/service argv and never grants lifecycle authority.
 */
async function observeRuntimeReleaseLaunchHandoffInternal(
  options: RuntimeReleaseLaunchHandoffOptionsV1,
  hooks: RuntimeReleaseLaunchHandoffVerificationHooks | undefined,
  platform: NodeJS.Platform,
): Promise<RuntimeReleaseLaunchHandoffResultV1> {
  if (platform !== 'darwin' && platform !== 'linux') return failure('platform-unsupported');
  if (!NONCE_RE.test(options.handoffNonce)) return failure('runtime release handoff nonce is invalid');
  const timeoutMs = acknowledgementTimeout(options);
  if (timeoutMs === null) return failure('runtime release handoff acknowledgement timeout is invalid');
  const anchorPath = storageAnchor(options);
  if (anchorPath === null) return failure('runtime release handoff claim store is invalid');

  let descriptors: PinnedDescriptor[] = [];
  let currentClaimDisposition: RuntimeReleaseLaunchHandoffResultV1['claimDisposition'] =
    'not-attempted';
  try {
    descriptors = pinLaunchDescriptors(options);
    hooks?.afterDescriptorsPinned?.();
    const initial = observeRuntimeReleaseLaunchInputs(freshLaunchObservationOptions(options));
    if (!initial.ok) return failure(initial.reason);
    hooks?.afterInitialObservation?.();
    if (!descriptors.every(revalidatePinnedDescriptor)) {
      return failure('runtime release handoff named identity changed before claim');
    }

    const bindings = observationBindings(initial.receipt);
    const nonceDigest = domainDigest(NONCE_DOMAIN, options.handoffNonce);
    const transactionId = domainDigest(TRANSACTION_DOMAIN, { bindings, nonceDigest });
    const unsignedClaim = claimPayload(nonceDigest, transactionId, bindings);
    const claim: RuntimeReleaseLaunchHandoffClaimV1 = {
      ...unsignedClaim,
      claimDigest: domainDigest(CLAIM_DOMAIN, unsignedClaim),
    };
    const config = claimStoreConfig(anchorPath);
    const existing = readImmutablePrivateRecordPoint(
      config,
      claim.nonceDigest,
      `${claim.nonceDigest}.json`,
    );
    if (!existing.exactReadComplete && existing.sourceState !== 'missing') {
      return failure('runtime release handoff claim state is degraded', 'failed');
    }
    if (existing.record !== null) {
      return claimCodec().equivalent(existing.record, claim)
        ? failure('runtime release handoff claim exact replay', 'replayed')
        : failure('runtime release handoff claim conflict', 'conflicted');
    }
    const claimDisposition = writeImmutablePrivateRecord(config, claim);
    currentClaimDisposition = claimDisposition;
    if (claimDisposition === 'replayed') {
      return failure('runtime release handoff claim exact replay', claimDisposition);
    }
    if (claimDisposition === 'conflicted') {
      return failure('runtime release handoff claim conflict', claimDisposition);
    }
    if (claimDisposition !== 'recorded') {
      return failure('runtime release handoff claim could not be durably recorded', claimDisposition);
    }

    const proof = await runProofChild(
      options,
      descriptors,
      transactionId,
      nonceDigest,
      timeoutMs,
      hooks,
      () => {
        if (!descriptors.every(revalidatePinnedDescriptor)) {
          return { ok: false, reason: 'runtime release handoff descriptor identity changed after acknowledgement' };
        }
        const finalObservation = observeRuntimeReleaseLaunchInputs(
          freshLaunchObservationOptions(options),
        );
        if (!finalObservation.ok || !sameBindings(bindings, observationBindings(finalObservation.receipt))) {
          return { ok: false, reason: 'runtime release handoff signed launch identity changed after acknowledgement' };
        }
        if (!descriptors.every(revalidatePinnedDescriptor)) {
          return { ok: false, reason: 'runtime release handoff named identity changed after revalidation' };
        }
        return { ok: true };
      },
    );
    if (!proof.ok) return failure(proof.reason, claimDisposition, proof.remediation);
    return {
      ok: true,
      authority: AUTHORITY,
      claimDisposition: 'recorded',
      receipt: {
        schemaVersion: 1,
        protocol: PROTOCOL,
        assurance: 'bounded-posix-proof-child-observation-only',
        authority: AUTHORITY,
        claim: {
          disposition: 'recorded',
          cooperativeOneUse: true,
          sameUserTamperResistant: false,
          nonceDigest,
        },
        coverage: {
          atomicLaunchHandoff: 'bounded-proof-child-observation-only',
          descriptorLifetime: 'retained-through-proof-child-acknowledgement',
          launchConsumer: 'proof-child-only-terminated',
          mutationAfterReceipt: 'not-prevented',
          replayPrevention: 'host-local-cooperative-one-use',
          serviceMutation: 'absent',
        },
        transactionId,
        bindings,
        proofChild: {
          acknowledged: true,
          directChildCloseObserved: true,
          pid: proof.pid,
          processGroupDeathObserved: true,
          processGroupId: proof.cleanup.processGroupId,
          signalsAttempted: proof.cleanup.signalsAttempted,
          terminated: true,
        },
      },
    };
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : String(error),
      currentClaimDisposition,
    );
  } finally {
    closePinned(descriptors);
  }
}

export async function observeRuntimeReleaseLaunchHandoffV1(
  options: RuntimeReleaseLaunchHandoffOptionsV1,
): Promise<RuntimeReleaseLaunchHandoffResultV1> {
  return observeRuntimeReleaseLaunchHandoffInternal(options, undefined, process.platform);
}

/**
 * Verification-only fault-injection surface. It shares the same permanently
 * false authority result and has no daemon, service, or admission consumer.
 */
export async function observeRuntimeReleaseLaunchHandoffForVerificationOnly(
  options: RuntimeReleaseLaunchHandoffOptionsV1,
  hooks: RuntimeReleaseLaunchHandoffVerificationHooks,
): Promise<RuntimeReleaseLaunchHandoffResultV1> {
  return observeRuntimeReleaseLaunchHandoffInternal(
    options,
    hooks,
    hooks.platform ?? process.platform,
  );
}
