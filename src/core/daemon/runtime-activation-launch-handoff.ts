/**
 * Dormant proof of a descriptor-retaining activation launch handoff.
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
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  readImmutablePrivateRecordPoint,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
  type ImmutablePrivateRecordWriteDisposition,
} from '../util/immutable-private-record-store.js';
import { observeRuntimeActivationExecutionPlan } from './runtime-activation-authority.js';

const PROTOCOL = 'runtime-activation-launch-handoff-v1' as const;
const TRANSACTION_DOMAIN = 'ashlr:runtime-activation-launch-handoff:transaction:v1';
const REPLAY_DOMAIN = 'ashlr:runtime-activation-launch-handoff:replay:v1';
const CLAIM_DOMAIN = 'ashlr:runtime-activation-launch-handoff:claim:v1';
const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const MAX_ACK_TIMEOUT_MS = 30_000;
const CHILD_TERMINATION_TIMEOUT_MS = 1_000;
const CHILD_GROUP_POLL_MS = 20;
const CHILD_STARTUP_ERROR_TIMEOUT_MS = 1_000;
const MAX_ACK_BYTES = 16 * 1_024;
const MAX_CLAIMS = 25_000;
const MAX_CLAIM_BYTES = 16 * 1_024;
const SHA256_RE = /^[a-f0-9]{64}$/u;

const AUTHORITY = Object.freeze({
  activationPermitted: false,
  deployPermitted: false,
  dispatchPermitted: false,
  effectPermitted: false,
  installPermitted: false,
  launchPermitted: false,
  mergePermitted: false,
  rollbackPermitted: false,
  serviceMutationPermitted: false,
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

interface RuntimeActivationLaunchHandoffBindingsV1 {
  admissionDigest: string;
  candidateLaunchReceiptSha256: string;
  canonicalRequestSha256: string;
  planDigest: string;
  rollbackLaunchReceiptSha256: string;
  trustRootCanonicalSha256: string;
}

interface RuntimeActivationLaunchHandoffClaimV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authority: 'observation-only';
  activationPermitted: false;
  deployPermitted: false;
  dispatchPermitted: false;
  effectPermitted: false;
  installPermitted: false;
  launchPermitted: false;
  mergePermitted: false;
  rollbackPermitted: false;
  serviceMutationPermitted: false;
  startPermitted: false;
  cooperativeOneUse: true;
  sameUserTamperResistant: false;
  replayKeyDigest: string;
  transactionId: string;
  bindings: RuntimeActivationLaunchHandoffBindingsV1;
  claimDigest: string;
}

interface ProofChildAcknowledgementV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  transactionId: string;
  replayKeyDigest: string;
  pid: number;
  descriptors: Record<DescriptorLabel, DescriptorIdentity>;
}

export interface RuntimeActivationLaunchHandoffVerificationHooks {
  afterAcknowledgement?: () => void;
  afterDescriptorsPinned?: () => void;
  afterInitialObservation?: () => void;
  afterProofChildSpawn?: (pid: number) => void;
  beforeProofChildSpawn?: () => void;
  forceCleanupUnconfirmed?: boolean;
  homePath?: string;
  nowMs?: number;
  platform?: NodeJS.Platform;
  proofChildSource?: string;
}

export interface RuntimeActivationLaunchHandoffOptionsV1 {
  acknowledgementTimeoutMs?: number;
  expectedAdmissionDigest: string;
  requestPath: string;
}

export interface RuntimeActivationLaunchHandoffReceiptV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  assurance: 'bounded-posix-proof-child-observation-only';
  authority: typeof AUTHORITY;
  claim: {
    disposition: 'recorded';
    cooperativeOneUse: true;
    sameUserTamperResistant: false;
    replayKeyDigest: string;
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
  bindings: RuntimeActivationLaunchHandoffBindingsV1;
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

export interface RuntimeActivationLaunchHandoffCleanupEvidenceV1 {
  bounded: true;
  directChildCloseObserved: boolean;
  pid: number;
  processGroupDeathObserved: boolean;
  processGroupId: number;
  signalsAttempted: Array<'SIGTERM' | 'SIGKILL'>;
}

export type RuntimeActivationLaunchHandoffResultV1 =
  | {
    ok: true;
    authority: typeof AUTHORITY;
    claimDisposition: 'recorded';
    receipt: RuntimeActivationLaunchHandoffReceiptV1;
  }
  | {
    ok: false;
    authority: typeof AUTHORITY;
    claimDisposition: ImmutablePrivateRecordWriteDisposition | 'not-attempted';
    remediation?: RuntimeActivationLaunchHandoffCleanupEvidenceV1;
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
  protocol: 'runtime-activation-launch-handoff-v1',
  transactionId: process.argv[1],
  replayKeyDigest: process.argv[2],
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

function ownDataProperty(
  value: Record<string, unknown>,
  key: string,
): PropertyDescriptor | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable
    ? descriptor
    : null;
}

function normalizeOptions(value: RuntimeActivationLaunchHandoffOptionsV1):
RuntimeActivationLaunchHandoffOptionsV1 | null {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value);
  if (!exactKeys(value, keys.includes('acknowledgementTimeoutMs')
    ? ['acknowledgementTimeoutMs', 'expectedAdmissionDigest', 'requestPath']
    : ['expectedAdmissionDigest', 'requestPath'])) return null;
  const admission = ownDataProperty(value, 'expectedAdmissionDigest');
  const request = ownDataProperty(value, 'requestPath');
  const timeout = keys.includes('acknowledgementTimeoutMs')
    ? ownDataProperty(value, 'acknowledgementTimeoutMs')
    : null;
  if (
    !admission
    || typeof admission.value !== 'string'
    || !SHA256_RE.test(admission.value)
    || !request
    || typeof request.value !== 'string'
    || request.value.length === 0
    || request.value.length > 4_096
    || !isAbsolute(request.value)
    || (keys.includes('acknowledgementTimeoutMs') && !timeout)
  ) return null;
  return Object.freeze({
    expectedAdmissionDigest: admission.value,
    requestPath: request.value,
    ...(timeout === null ? {} : { acknowledgementTimeoutMs: timeout.value as number }),
  });
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
    throw new Error(`runtime activation handoff ${label} path is not canonical`);
  }
  const before = lstatSync(canonical, { bigint: true });
  if (before.isSymbolicLink() || (kind === 'file' ? !before.isFile() : !before.isDirectory())) {
    throw new Error(`runtime activation handoff ${label} has the wrong type`);
  }
  if (kind === 'file' && before.nlink !== 1n) {
    throw new Error(`runtime activation handoff ${label} has multiple hard links`);
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
      throw new Error(`runtime activation handoff ${label} changed before descriptor pin`);
    }
    return { fd, identity: descriptorIdentity(opened), kind, label, path: canonical };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

type RuntimeActivationExecutionPlan = ReturnType<typeof observeRuntimeActivationExecutionPlan>;

function pinLaunchDescriptors(plan: RuntimeActivationExecutionPlan): PinnedDescriptor[] {
  const candidate = plan.request.candidate;
  const pinned: PinnedDescriptor[] = [];
  try {
    pinned.push(pinDescriptor('packageRoot', candidate.packageRoot, 'directory'));
    pinned.push(pinDescriptor('dependencyRoot', candidate.dependencyRoot, 'directory'));
    pinned.push(pinDescriptor('launcher', candidate.argv[0]!, 'file'));
    pinned.push(pinDescriptor('interpreter', candidate.declaredInterpreterPath, 'file'));
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
  replayKeyDigest: string,
  transactionId: string,
  bindings: RuntimeActivationLaunchHandoffBindingsV1,
): Omit<RuntimeActivationLaunchHandoffClaimV1, 'claimDigest'> {
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    ...AUTHORITY,
    cooperativeOneUse: true,
    sameUserTamperResistant: false,
    replayKeyDigest,
    transactionId,
    bindings,
  };
}

function parseBindings(value: unknown): RuntimeActivationLaunchHandoffBindingsV1 | null {
  if (!plainObject(value) || !exactKeys(value, [
    'admissionDigest',
    'candidateLaunchReceiptSha256',
    'canonicalRequestSha256',
    'planDigest',
    'rollbackLaunchReceiptSha256',
    'trustRootCanonicalSha256',
  ])) return null;
  return Object.values(value).every((entry) => typeof entry === 'string' && SHA256_RE.test(entry))
    ? value as unknown as RuntimeActivationLaunchHandoffBindingsV1
    : null;
}

function parseClaim(value: unknown): RuntimeActivationLaunchHandoffClaimV1 | null {
  if (!plainObject(value) || !exactKeys(value, [
    'schemaVersion', 'protocol', 'authority', 'activationPermitted',
    'deployPermitted', 'dispatchPermitted', 'effectPermitted', 'installPermitted',
    'launchPermitted', 'mergePermitted', 'rollbackPermitted',
    'serviceMutationPermitted', 'startPermitted', 'cooperativeOneUse',
    'sameUserTamperResistant', 'replayKeyDigest', 'transactionId', 'bindings',
    'claimDigest',
  ])) return null;
  const bindings = parseBindings(value['bindings']);
  if (value['schemaVersion'] !== 1 || value['protocol'] !== PROTOCOL ||
    value['authority'] !== 'observation-only' ||
    value['activationPermitted'] !== false || value['deployPermitted'] !== false ||
    value['dispatchPermitted'] !== false || value['effectPermitted'] !== false ||
    value['installPermitted'] !== false || value['launchPermitted'] !== false ||
    value['mergePermitted'] !== false || value['rollbackPermitted'] !== false ||
    value['serviceMutationPermitted'] !== false ||
    value['startPermitted'] !== false || value['cooperativeOneUse'] !== true ||
    value['sameUserTamperResistant'] !== false ||
    typeof value['replayKeyDigest'] !== 'string' || !SHA256_RE.test(value['replayKeyDigest']) ||
    typeof value['transactionId'] !== 'string' || !SHA256_RE.test(value['transactionId']) ||
    typeof value['claimDigest'] !== 'string' || !SHA256_RE.test(value['claimDigest']) ||
    bindings === null) return null;
  const payload = claimPayload(value['replayKeyDigest'], value['transactionId'], bindings);
  if (!sameDigest(value['claimDigest'], domainDigest(CLAIM_DOMAIN, payload))) return null;
  return { ...payload, claimDigest: value['claimDigest'] };
}

function claimCodec(): ImmutablePrivateRecordCodec<RuntimeActivationLaunchHandoffClaimV1> {
  return {
    parse: parseClaim,
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.replayKeyDigest,
    recordFileName: (record) => `${record.replayKeyDigest}.json`,
    isRecordFileName: (fileName) =>
      fileName.endsWith('.json') && SHA256_RE.test(fileName.slice(0, -5)),
    stageToken: (record) => record.claimDigest,
    equivalent: (left, right) =>
      sameDigest(left.replayKeyDigest, right.replayKeyDigest) &&
      sameDigest(left.transactionId, right.transactionId) &&
      sameDigest(left.claimDigest, right.claimDigest),
  };
}

function accountBoundHome(
  platform: NodeJS.Platform,
  verificationHome?: string,
): string | null {
  try {
    if (platform !== 'darwin' && verificationHome === undefined) return null;
    const configured = verificationHome ?? userInfo().homedir;
    if (!isAbsolute(configured) || resolve(configured) !== configured) return null;
    const canonical = realpathSync(configured);
    if (canonical !== configured) return null;
    if (verificationHome === undefined && process.env['HOME'] !== canonical) return null;
    return canonical;
  } catch {
    return null;
  }
}

function claimStoreConfig(
  anchorPath: string,
): ImmutablePrivateRecordStoreConfig<RuntimeActivationLaunchHandoffClaimV1> {
  return {
    label: 'runtime activation launch handoff claim',
    anchorPath,
    rootPath: join(anchorPath, 'handoff-claims-v1'),
    lockFileName: '.runtime-activation-launch-handoff.lock',
    maxRecordBytes: MAX_CLAIM_BYTES,
    defaultMaxFiles: MAX_CLAIMS,
    hardMaxFiles: MAX_CLAIMS,
    defaultMaxBytes: MAX_CLAIMS * MAX_CLAIM_BYTES,
    hardMaxBytes: MAX_CLAIMS * MAX_CLAIM_BYTES,
    codecForRead: claimCodec,
    codecForWrite: claimCodec,
  };
}

function acknowledgementTimeout(options: RuntimeActivationLaunchHandoffOptionsV1): number | null {
  if (options.acknowledgementTimeoutMs === undefined) return DEFAULT_ACK_TIMEOUT_MS;
  return Number.isSafeInteger(options.acknowledgementTimeoutMs) &&
    options.acknowledgementTimeoutMs >= 1 &&
    options.acknowledgementTimeoutMs <= MAX_ACK_TIMEOUT_MS
    ? options.acknowledgementTimeoutMs
    : null;
}

function observeExactActivationPlan(
  options: RuntimeActivationLaunchHandoffOptionsV1,
  homePath: string,
  hooks: RuntimeActivationLaunchHandoffVerificationHooks | undefined,
): RuntimeActivationExecutionPlan {
  const observed = observeRuntimeActivationExecutionPlan({
    requestPath: options.requestPath,
    homePath,
    ...(hooks?.nowMs === undefined ? {} : { nowMs: hooks.nowMs }),
  });
  if (
    !SHA256_RE.test(options.expectedAdmissionDigest)
    || observed.preflight.plan.admissionDigest !== options.expectedAdmissionDigest
  ) {
    throw new Error('runtime activation handoff admission digest mismatch');
  }
  return observed;
}

function observationBindings(
  observation: RuntimeActivationExecutionPlan,
): RuntimeActivationLaunchHandoffBindingsV1 {
  const plan = observation.preflight.plan;
  if (!plan.admissionDigest || !plan.planDigest) {
    throw new Error('runtime activation handoff admission output is incomplete');
  }
  return {
    admissionDigest: plan.admissionDigest,
    candidateLaunchReceiptSha256: observation.candidateLaunchReceiptSha256,
    canonicalRequestSha256: observation.canonicalRequestSha256,
    planDigest: plan.planDigest,
    rollbackLaunchReceiptSha256: observation.rollbackLaunchReceiptSha256,
    trustRootCanonicalSha256: observation.trustRootCanonicalSha256,
  };
}

function sameStableAdmissionIdentity(
  left: RuntimeActivationLaunchHandoffBindingsV1,
  right: RuntimeActivationLaunchHandoffBindingsV1,
): boolean {
  return sameDigest(left.admissionDigest, right.admissionDigest) &&
    sameDigest(left.canonicalRequestSha256, right.canonicalRequestSha256) &&
    sameDigest(left.planDigest, right.planDigest) &&
    sameDigest(left.trustRootCanonicalSha256, right.trustRootCanonicalSha256);
}

function parseAcknowledgement(value: unknown): ProofChildAcknowledgementV1 | null {
  if (!plainObject(value) || !exactKeys(value, [
    'schemaVersion', 'protocol', 'transactionId', 'replayKeyDigest', 'pid', 'descriptors',
  ]) || value['schemaVersion'] !== 1 || value['protocol'] !== PROTOCOL ||
    typeof value['transactionId'] !== 'string' || !SHA256_RE.test(value['transactionId']) ||
    typeof value['replayKeyDigest'] !== 'string' || !SHA256_RE.test(value['replayKeyDigest']) ||
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
  replayKeyDigest: string,
  descriptors: readonly PinnedDescriptor[],
  childPid: number,
): boolean {
  if (acknowledgement.pid !== childPid ||
    !sameDigest(acknowledgement.transactionId, transactionId) ||
    !sameDigest(acknowledgement.replayKeyDigest, replayKeyDigest)) return false;
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
): Promise<RuntimeActivationLaunchHandoffCleanupEvidenceV1> {
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
  target: { executablePath: string; packageRoot: string },
  descriptors: readonly PinnedDescriptor[],
  transactionId: string,
  replayKeyDigest: string,
  timeoutMs: number,
  hooks: RuntimeActivationLaunchHandoffVerificationHooks | undefined,
  validateAfterAck: () => { ok: true } | { ok: false; reason: string },
): Promise<
  | { ok: true; cleanup: RuntimeActivationLaunchHandoffCleanupEvidenceV1; pid: number }
  | { ok: false; reason: string; remediation?: RuntimeActivationLaunchHandoffCleanupEvidenceV1 }
> {
  try {
    hooks?.beforeProofChildSpawn?.();
  } catch {
    return { ok: false, reason: 'runtime activation handoff proof child hook failed' };
  }
  let child: ProofChild;
  try {
    child = spawn(
      target.executablePath,
      ['--eval', hooks?.proofChildSource ?? PROOF_CHILD_SOURCE, transactionId, replayKeyDigest],
      {
        cwd: target.packageRoot,
        detached: true,
        env: {},
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', ...descriptors.map((descriptor) => descriptor.fd)],
        windowsHide: true,
      },
    );
  } catch {
    return { ok: false, reason: 'runtime activation handoff proof child spawn failed' };
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
        ? 'runtime activation handoff proof child spawn failed'
        : 'runtime activation handoff proof child pid is unavailable',
    };
  }
  const processGroupId = childPid;
  let directChildCloseObserved = false;
  child.once('close', () => { directChildCloseObserved = true; });
  const cleanup = async (): Promise<RuntimeActivationLaunchHandoffCleanupEvidenceV1> => {
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
    evidence: RuntimeActivationLaunchHandoffCleanupEvidenceV1,
  ): { ok: false; reason: string; remediation?: RuntimeActivationLaunchHandoffCleanupEvidenceV1 } =>
    evidence.directChildCloseObserved && evidence.processGroupDeathObserved
      ? { ok: false, reason }
      : {
        ok: false,
        reason: 'runtime activation handoff proof process-group cleanup was not confirmed',
        remediation: evidence,
      };
  if (child.stdout === null || child.stderr === null) {
    return cleanupFailure(
      'runtime activation handoff proof child pipes are unavailable',
      await cleanup(),
    );
  }
  try {
    hooks?.afterProofChildSpawn?.(childPid);
  } catch {
    return cleanupFailure('runtime activation handoff proof child hook failed', await cleanup());
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
        reason: 'runtime activation handoff proof child acknowledgement timed out',
      }), timeoutMs);
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_ACK_BYTES) finish({
          ok: false,
          reason: 'runtime activation handoff proof child stderr exceeded limit',
        });
      });
      child.stdout!.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > MAX_ACK_BYTES) {
          finish({ ok: false, reason: 'runtime activation handoff acknowledgement exceeded limit' });
        }
      });
      child.stdout!.once('end', () => {
        if (settled) return;
        if (stdout.length === 0) {
          finish({
            ok: false,
            reason: 'runtime activation handoff proof child exited before completion',
          });
          return;
        }
        const text = stdout.toString('utf8');
        if (!stdout.equals(Buffer.from(text, 'utf8')) ||
          !text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
          finish({ ok: false, reason: 'runtime activation handoff acknowledgement was not singular' });
          return;
        }
        try {
          const acknowledgement = parseAcknowledgement(
            JSON.parse(text.slice(0, -1)),
          );
          if (acknowledgement === null) {
            finish({ ok: false, reason: 'runtime activation handoff acknowledgement mismatch' });
            return;
          }
          const canonicalFrame = Buffer.from(`${canonicalJson(acknowledgement)}\n`, 'utf8');
          if (!stdout.equals(canonicalFrame)) {
            finish({
              ok: false,
              reason: 'runtime activation handoff acknowledgement frame is not canonical',
            });
            return;
          }
          if (!acknowledgementMatches(
            acknowledgement,
            transactionId,
            replayKeyDigest,
            descriptors,
            childPid,
          )) {
            finish({ ok: false, reason: 'runtime activation handoff acknowledgement mismatch' });
            return;
          }
          hooks?.afterAcknowledgement?.();
          const validation = validateAfterAck();
          finish(validation.ok ? { ok: true, pid: childPid } : validation);
        } catch {
          finish({ ok: false, reason: 'runtime activation handoff acknowledgement is invalid' });
        }
      });
      child.stdout!.once('error', () => finish({
        ok: false,
        reason: 'runtime activation handoff acknowledgement stream failed',
      }));
      void childError.then(() => finish({
        ok: false,
        reason: 'runtime activation handoff proof child failed',
      }));
      child.once('exit', () => { exitObserved = true; });
      child.stdout!.once('close', () => {
        if (!settled && exitObserved && stdout.length === 0) {
          finish({
            ok: false,
            reason: 'runtime activation handoff proof child exited before completion',
          });
        }
      });
    },
  );
  const cleanupEvidence = await cleanup();
  if (!cleanupEvidence.directChildCloseObserved || !cleanupEvidence.processGroupDeathObserved) {
    return {
      ok: false,
      reason: 'runtime activation handoff proof process-group cleanup was not confirmed',
      remediation: cleanupEvidence,
    };
  }
  return result.ok
    ? { ...result, cleanup: cleanupEvidence }
    : result;
}

function failure(
  reason: string,
  claimDisposition: RuntimeActivationLaunchHandoffResultV1['claimDisposition'] = 'not-attempted',
  remediation?: RuntimeActivationLaunchHandoffCleanupEvidenceV1,
): RuntimeActivationLaunchHandoffResultV1 {
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
async function observeRuntimeActivationLaunchHandoffInternal(
  input: RuntimeActivationLaunchHandoffOptionsV1,
  hooks: RuntimeActivationLaunchHandoffVerificationHooks | undefined,
  platform: NodeJS.Platform,
): Promise<RuntimeActivationLaunchHandoffResultV1> {
  if (platform !== 'darwin') return failure('platform-unsupported');
  const options = normalizeOptions(input);
  if (options === null) return failure('runtime activation handoff input is invalid');
  const timeoutMs = acknowledgementTimeout(options);
  if (timeoutMs === null) return failure('runtime activation handoff acknowledgement timeout is invalid');
  const homePath = accountBoundHome(platform, hooks?.homePath);
  if (homePath === null) return failure('runtime activation handoff operating-system home is unavailable');
  const anchorPath = join(homePath, '.ashlr', 'control', 'activation');

  let descriptors: PinnedDescriptor[] = [];
  let currentClaimDisposition: RuntimeActivationLaunchHandoffResultV1['claimDisposition'] =
    'not-attempted';
  try {
    const initial = observeExactActivationPlan(options, homePath, hooks);
    hooks?.afterInitialObservation?.();
    descriptors = pinLaunchDescriptors(initial);
    hooks?.afterDescriptorsPinned?.();
    const pinned = observeExactActivationPlan(options, homePath, hooks);
    const bindings = observationBindings(pinned);
    if (!sameStableAdmissionIdentity(observationBindings(initial), bindings)) {
      return failure('runtime activation handoff admission output changed before claim');
    }
    if (!descriptors.every(revalidatePinnedDescriptor)) {
      return failure('runtime activation handoff named identity changed before claim');
    }

    const replayKey = pinned.preflight.plan.replayKey;
    if (!replayKey || !SHA256_RE.test(replayKey)) {
      return failure('runtime activation handoff replay key is unavailable');
    }
    const replayKeyDigest = domainDigest(REPLAY_DOMAIN, replayKey);
    const transactionId = domainDigest(TRANSACTION_DOMAIN, { bindings, replayKeyDigest });
    const unsignedClaim = claimPayload(replayKeyDigest, transactionId, bindings);
    const claim: RuntimeActivationLaunchHandoffClaimV1 = {
      ...unsignedClaim,
      claimDigest: domainDigest(CLAIM_DOMAIN, unsignedClaim),
    };
    const config = claimStoreConfig(anchorPath);
    const existing = readImmutablePrivateRecordPoint(
      config,
      claim.replayKeyDigest,
      `${claim.replayKeyDigest}.json`,
    );
    if (!existing.exactReadComplete && existing.sourceState !== 'missing') {
      return failure('runtime activation handoff claim state is degraded', 'failed');
    }
    if (existing.record !== null) {
      return claimCodec().equivalent(existing.record, claim)
        ? failure('runtime activation handoff claim exact replay', 'replayed')
        : failure('runtime activation handoff claim conflict', 'conflicted');
    }
    const claimDisposition = writeImmutablePrivateRecord(config, claim);
    currentClaimDisposition = claimDisposition;
    if (claimDisposition === 'replayed') {
      return failure('runtime activation handoff claim exact replay', claimDisposition);
    }
    if (claimDisposition === 'conflicted') {
      return failure('runtime activation handoff claim conflict', claimDisposition);
    }
    if (claimDisposition !== 'recorded') {
      return failure('runtime activation handoff claim could not be durably recorded', claimDisposition);
    }

    const proof = await runProofChild(
      {
        executablePath: pinned.request.candidate.executablePath,
        packageRoot: pinned.request.candidate.packageRoot,
      },
      descriptors,
      transactionId,
      replayKeyDigest,
      timeoutMs,
      hooks,
      () => {
        if (!descriptors.every(revalidatePinnedDescriptor)) {
          return { ok: false, reason: 'runtime activation handoff descriptor identity changed after acknowledgement' };
        }
        const finalObservation = observeExactActivationPlan(options, homePath, hooks);
        if (!sameStableAdmissionIdentity(bindings, observationBindings(finalObservation))) {
          return { ok: false, reason: 'runtime activation handoff stable admission identity changed after acknowledgement' };
        }
        if (!descriptors.every(revalidatePinnedDescriptor)) {
          return { ok: false, reason: 'runtime activation handoff named identity changed after revalidation' };
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
          replayKeyDigest,
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

export async function observeRuntimeActivationLaunchHandoffV1(
  options: RuntimeActivationLaunchHandoffOptionsV1,
): Promise<RuntimeActivationLaunchHandoffResultV1> {
  return observeRuntimeActivationLaunchHandoffInternal(options, undefined, process.platform);
}

/**
 * Verification-only fault-injection surface. It shares the same permanently
 * false authority result and has no daemon, service, or admission consumer.
 */
export async function observeRuntimeActivationLaunchHandoffForVerificationOnly(
  options: RuntimeActivationLaunchHandoffOptionsV1,
  hooks: RuntimeActivationLaunchHandoffVerificationHooks,
): Promise<RuntimeActivationLaunchHandoffResultV1> {
  return observeRuntimeActivationLaunchHandoffInternal(
    options,
    hooks,
    hooks.platform ?? process.platform,
  );
}
