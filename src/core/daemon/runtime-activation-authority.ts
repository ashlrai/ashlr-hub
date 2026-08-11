import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalizeDaemonActivationValue } from './activation-permit.js';
import {
  parseRuntimeReleaseEvidenceEnvelope,
  parseRuntimeReleaseEvidenceTrustRoot,
  runtimeReleaseEvidenceKeyId,
} from './runtime-release-evidence-envelope.js';
import {
  observeRuntimeReleaseLaunchInputs,
  runtimeReleaseEnvelopeCanonicalSha256,
  runtimeReleasePolicyId,
  runtimeReleaseTrustRootCanonicalSha256,
  type RuntimeReleaseLaunchObservationOptions,
} from './runtime-release-launch-revalidation.js';
import { parseUnsignedRuntimeReleaseManifest } from './runtime-release-manifest.js';
import { evaluateRuntimeReleaseCanaryRollbackEvidence } from './runtime-release-canary-rollback-evidence.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import {
  readImmutablePrivateRecordPoint,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordPointReadResult,
  type ImmutablePrivateRecordWriteDisposition,
} from '../util/immutable-private-record-store.js';

export const RUNTIME_ACTIVATION_AUTHORITY_TRUST_ROOT_DOMAIN_V1 =
  'ashlr:runtime-activation-authority-trust-root:v1' as const;
export const RUNTIME_ACTIVATION_MANIFEST_DOMAIN_V1 = 'ashlr:runtime-activation-manifest:v1' as const;
export const RUNTIME_ACTIVATION_REQUEST_DOMAIN_V1 = 'ashlr:runtime-activation-preflight-request:v1' as const;
export const RUNTIME_ACTIVATION_PLAN_EVIDENCE_DOMAIN_V1 = 'ashlr:runtime-activation-plan-evidence:v1' as const;
export const RUNTIME_ACTIVATION_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const RUNTIME_ACTIVATION_AUTHORITY_MAX_LIFETIME_MS = 15 * 60 * 1_000;

const SIGNATURE_INPUT_DOMAIN = 'ashlr:runtime-activation-manifest-signature:v1\0';
const PLAN_DIGEST_DOMAIN = 'ashlr:runtime-activation-plan-digest:v1\0';
const REPLAY_KEY_DOMAIN = 'ashlr:runtime-activation-replay-key:v1\0';
const BUILD_BINDING_DOMAIN = 'ashlr:runtime-activation-build-binding:v1\0';
const MAX_TRUST_ROOT_BYTES = 64 * 1_024;
const MAX_REQUEST_BYTES = 256 * 1_024;
const MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_HASH_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 16 * 1_024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SHA1_RE = /^[a-f0-9]{40}$/;
const KEY_ID_RE = /^ed25519-sha256:[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RuntimeActivationModeV1 = 'resident-canary';

export interface RuntimeActivationAuthorityTrustRootV1 {
  assurance: 'operator-custodied-public-trust-root';
  domain: typeof RUNTIME_ACTIVATION_AUTHORITY_TRUST_ROOT_DOMAIN_V1;
  evidenceTrustRoot: JsonValue;
  minimumPolicyEpoch: number;
  permittedActivationModes: RuntimeActivationModeV1[];
  schemaVersion: 1;
}

export interface RuntimeActivationArtifactBindingV1 {
  buildSha256: string;
  dependencyInventoryDigest: string;
  envelopeCanonicalSha256: string;
  envelopeSha256: string;
  evidenceKeyId: string;
  evidenceTrustRootCanonicalSha256: string;
  evidenceTrustRootSha256: string;
  expectedRevision: string;
  expectedTree: string;
  independentlyPackaged: true;
  interpreterSha256: string;
  manifestDigest: string;
  packageTarballSha256: string;
  packageVersion: string;
  policyId: string;
  runtimeTreeSha256: string;
  releaseTag: string;
  serviceDescriptorSha256: string;
  serviceInvocationDigest: string;
}

export function runtimeActivationBuildBindingSha256(
  binding: Omit<RuntimeActivationArtifactBindingV1, 'buildSha256'>,
): string {
  return domainSha256(BUILD_BINDING_DOMAIN, canonicalizeDaemonActivationValue(binding));
}

export interface RuntimeActivationPriorBindingV1 {
  currentRevision: string | null;
  plistSha256: string | null;
  serviceLoaded: false;
}

export interface RuntimeActivationExecutionBindingV1 {
  configPath: string;
  configSha256: string;
  currentPointerPath: string;
  homePath: string;
  operation: 'activate-resident-release';
  platform: 'darwin';
  prior: RuntimeActivationPriorBindingV1;
  releasesRoot: string;
}

export interface RuntimeActivationManifestPayloadV1 {
  activationMode: RuntimeActivationModeV1;
  candidate: RuntimeActivationArtifactBindingV1;
  execution: RuntimeActivationExecutionBindingV1;
  expiresAt: string;
  issuedAt: string;
  planId: string;
  policyEpoch: number;
  rollback: RuntimeActivationArtifactBindingV1;
}

export interface SignedRuntimeActivationManifestV1 {
  algorithm: 'ed25519';
  domain: typeof RUNTIME_ACTIVATION_MANIFEST_DOMAIN_V1;
  keyId: string;
  payload: RuntimeActivationManifestPayloadV1;
  schemaVersion: 1;
  signature: string;
}

export interface RuntimeActivationBundleRequestV1 {
  argv: string[];
  bundleRoot: string;
  declaredInterpreterPath: string;
  declaredInterpreterVersion: string;
  dependencyRoot: string;
  envelopePath: string;
  executablePath: string;
  manifestPath: string;
  packageRoot: string;
  packageTarballPath: string;
  policyPath: string;
  serviceDescriptorPath: string;
}

export interface RuntimeActivationPreflightRequestV1 {
  candidate: RuntimeActivationBundleRequestV1;
  domain: typeof RUNTIME_ACTIVATION_REQUEST_DOMAIN_V1;
  signedManifest: SignedRuntimeActivationManifestV1;
  rollback: RuntimeActivationBundleRequestV1;
  schemaVersion: 1;
}

export interface RuntimeActivationPlanEvidenceV1 {
  activationMode: RuntimeActivationModeV1;
  authority: 'observation-only';
  domain: typeof RUNTIME_ACTIVATION_PLAN_EVIDENCE_DOMAIN_V1;
  executionPermitted: false;
  planDigest: string;
  planId: string;
  policyEpoch: number;
  replayKey: string;
  schemaVersion: 1;
  trustRootCanonicalSha256: string;
}

export type RuntimeActivationPreflightBlockerCode =
  | 'operator-trust-root-unavailable'
  | 'operator-trust-root-invalid'
  | 'request-unavailable'
  | 'request-invalid'
  | 'signed-manifest-invalid'
  | 'signed-manifest-expired'
  | 'policy-epoch-stale'
  | 'activation-mode-denied'
  | 'candidate-artifact-invalid'
  | 'rollback-artifact-invalid'
  | 'rollback-not-independent'
  | 'release-pair-invalid';

export interface RuntimeActivationPreflightBlocker {
  code: RuntimeActivationPreflightBlockerCode;
  detail: string;
}

export interface RuntimeActivationAuthorityPreflightResult {
  schemaVersion: 1;
  authority: 'read-only-preflight';
  verdict: 'blocked' | 'evidence-ready';
  evidenceReady: boolean;
  activationPermitted: false;
  deployPermitted: false;
  installPermitted: false;
  launchPermitted: false;
  rollbackPermitted: false;
  startPermitted: false;
  executionPerformed: false;
  plan: {
    planId: string | null;
    planDigest: string | null;
    replayKey: string | null;
    policyEpoch: number | null;
    activationMode: RuntimeActivationModeV1 | null;
    expiresAt: string | null;
  };
  trust: {
    operatorCustodyVerified: boolean;
    signatureVerified: boolean;
    signingKeyId: string | null;
    trustRootCanonicalSha256: string | null;
  };
  releases: {
    candidateRevision: string | null;
    candidateTree: string | null;
    rollbackRevision: string | null;
    rollbackTree: string | null;
    pairVerified: boolean;
  };
  blockers: RuntimeActivationPreflightBlocker[];
  authorityBlockers: readonly [
    'explicit-activation-command-required',
    'two-exact-digest-confirmations-required',
    'durable-replay-consumption-required',
    'macos-platform-required',
    'protected-postmerge-evidence-required',
  ];
}

interface LoadedTrustRoot {
  root: RuntimeActivationAuthorityTrustRootV1;
  canonicalJson: string;
  canonicalSha256: string;
  evidenceTrustRootCanonicalJson: string;
  evidenceTrustRootCanonicalSha256: string;
  evidenceTrustRootSha256: string;
}

interface ParsedActivationManifest {
  manifest: SignedRuntimeActivationManifestV1;
  canonicalJson: string;
  planDigest: string;
  replayKey: string;
}

interface ReadRequestResult {
  request: RuntimeActivationPreflightRequestV1;
  requestPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalJson(value: unknown): string {
  return `${canonicalizeDaemonActivationValue(value)}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function domainSha256(domain: string, value: string | Buffer): string {
  return createHash('sha256').update(domain, 'utf8').update(value).digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  return (
    SHA256_RE.test(left) &&
    SHA256_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 32 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function decodeBase64url(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || !BASE64URL_RE.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (expectedBytes !== undefined && decoded.length !== expectedBytes) return null;
    if (decoded.toString('base64url') !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseCanonicalJson(value: string, maxBytes: number): unknown {
  if (Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) {
    throw new Error('canonical JSON exceeds its byte boundary');
  }
  const parsed = JSON.parse(value) as unknown;
  if (canonicalJson(parsed) !== value) throw new Error('JSON is not canonical');
  return parsed;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validateArtifactBinding(value: unknown): RuntimeActivationArtifactBindingV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'buildSha256',
      'dependencyInventoryDigest',
      'envelopeCanonicalSha256',
      'envelopeSha256',
      'evidenceKeyId',
      'evidenceTrustRootCanonicalSha256',
      'evidenceTrustRootSha256',
      'expectedRevision',
      'expectedTree',
      'independentlyPackaged',
      'interpreterSha256',
      'manifestDigest',
      'packageTarballSha256',
      'packageVersion',
      'policyId',
      'releaseTag',
      'runtimeTreeSha256',
      'serviceDescriptorSha256',
      'serviceInvocationDigest',
    ])
  )
    throw new Error('activation artifact binding has invalid keys');
  for (const key of [
    'buildSha256',
    'dependencyInventoryDigest',
    'envelopeCanonicalSha256',
    'envelopeSha256',
    'evidenceTrustRootCanonicalSha256',
    'evidenceTrustRootSha256',
    'interpreterSha256',
    'manifestDigest',
    'packageTarballSha256',
    'runtimeTreeSha256',
    'serviceDescriptorSha256',
    'serviceInvocationDigest',
  ] as const) {
    if (typeof value[key] !== 'string' || !SHA256_RE.test(value[key])) {
      throw new Error(`activation artifact ${key} is invalid`);
    }
  }
  if (
    typeof value['expectedRevision'] !== 'string' ||
    !SHA1_RE.test(value['expectedRevision']) ||
    typeof value['expectedTree'] !== 'string' ||
    !SHA1_RE.test(value['expectedTree']) ||
    typeof value['evidenceKeyId'] !== 'string' ||
    !KEY_ID_RE.test(value['evidenceKeyId']) ||
    typeof value['policyId'] !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value['policyId']) ||
    typeof value['packageVersion'] !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value['packageVersion']) ||
    value['releaseTag'] !== `v${value['packageVersion']}` ||
    value['independentlyPackaged'] !== true
  ) {
    throw new Error('activation artifact identity is invalid');
  }
  const binding = value as unknown as RuntimeActivationArtifactBindingV1;
  const { buildSha256: _buildSha256, ...buildInputs } = binding;
  if (!equalDigest(binding.buildSha256, runtimeActivationBuildBindingSha256(buildInputs))) {
    throw new Error('activation artifact build binding is invalid');
  }
  return binding;
}

function canonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 1 &&
    value.length <= 4_096 &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

function validateExecutionBinding(value: unknown): RuntimeActivationExecutionBindingV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'configPath',
      'configSha256',
      'currentPointerPath',
      'homePath',
      'operation',
      'platform',
      'prior',
      'releasesRoot',
    ]) ||
    value['operation'] !== 'activate-resident-release' ||
    value['platform'] !== 'darwin' ||
    !canonicalAbsolutePath(value['configPath']) ||
    !canonicalAbsolutePath(value['currentPointerPath']) ||
    !canonicalAbsolutePath(value['homePath']) ||
    !canonicalAbsolutePath(value['releasesRoot']) ||
    typeof value['configSha256'] !== 'string' ||
    !SHA256_RE.test(value['configSha256']) ||
    !isRecord(value['prior']) ||
    !exactKeys(value['prior'], ['currentRevision', 'plistSha256', 'serviceLoaded'])
  )
    throw new Error('activation execution binding is invalid');
  const prior = value['prior'];
  if (
    !(
      prior['currentRevision'] === null ||
      (typeof prior['currentRevision'] === 'string' && SHA1_RE.test(prior['currentRevision']))
    ) ||
    !(
      prior['plistSha256'] === null ||
      (typeof prior['plistSha256'] === 'string' && SHA256_RE.test(prior['plistSha256']))
    ) ||
    prior['serviceLoaded'] !== false
  ) {
    throw new Error('activation prior snapshot binding is invalid');
  }
  return value as unknown as RuntimeActivationExecutionBindingV1;
}

function unsignedActivationManifest(
  manifest: SignedRuntimeActivationManifestV1,
): Omit<SignedRuntimeActivationManifestV1, 'signature'> {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

function signatureBytes(manifest: SignedRuntimeActivationManifestV1): Buffer {
  return Buffer.concat([
    Buffer.from(SIGNATURE_INPUT_DOMAIN, 'utf8'),
    Buffer.from(canonicalizeDaemonActivationValue(unsignedActivationManifest(manifest)), 'utf8'),
  ]);
}

export function parseSignedRuntimeActivationManifest(value: string): ParsedActivationManifest {
  const parsed = parseCanonicalJson(value, MAX_REQUEST_BYTES);
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ['algorithm', 'domain', 'keyId', 'payload', 'schemaVersion', 'signature']) ||
    parsed['algorithm'] !== 'ed25519' ||
    parsed['domain'] !== RUNTIME_ACTIVATION_MANIFEST_DOMAIN_V1 ||
    parsed['schemaVersion'] !== 1 ||
    typeof parsed['keyId'] !== 'string' ||
    !KEY_ID_RE.test(parsed['keyId']) ||
    decodeBase64url(parsed['signature'], 64) === null ||
    !isRecord(parsed['payload'])
  ) {
    throw new Error('signed activation manifest is invalid');
  }
  const payload = parsed['payload'];
  if (
    !exactKeys(payload, [
      'activationMode',
      'candidate',
      'execution',
      'expiresAt',
      'issuedAt',
      'planId',
      'policyEpoch',
      'rollback',
    ]) ||
    payload['activationMode'] !== 'resident-canary' ||
    !validTimestamp(payload['issuedAt']) ||
    !validTimestamp(payload['expiresAt']) ||
    typeof payload['planId'] !== 'string' ||
    !UUID_RE.test(payload['planId']) ||
    !isPositiveSafeInteger(payload['policyEpoch'])
  ) {
    throw new Error('activation manifest payload is invalid');
  }
  const issuedAtMs = Date.parse(payload['issuedAt']);
  const expiresAtMs = Date.parse(payload['expiresAt']);
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > RUNTIME_ACTIVATION_AUTHORITY_MAX_LIFETIME_MS) {
    throw new Error('activation manifest lifetime is invalid');
  }
  validateArtifactBinding(payload['candidate']);
  validateExecutionBinding(payload['execution']);
  validateArtifactBinding(payload['rollback']);
  const manifest = parsed as unknown as SignedRuntimeActivationManifestV1;
  const canonical = canonicalJson(manifest);
  const planDigest = domainSha256(PLAN_DIGEST_DOMAIN, canonical);
  return {
    manifest,
    canonicalJson: canonical,
    planDigest,
    replayKey: domainSha256(REPLAY_KEY_DOMAIN, `${manifest.payload.planId}\n${planDigest}`),
  };
}

export function signRuntimeActivationManifest(
  payload: RuntimeActivationManifestPayloadV1,
  privateKey: KeyObject,
): { manifest: SignedRuntimeActivationManifestV1; canonicalJson: string } {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('runtime activation manifests require an Ed25519 private key');
  }
  const keyId = runtimeReleaseEvidenceKeyId(createPublicKey(privateKey));
  if (!keyId) throw new Error('runtime activation public key is invalid');
  const manifest: SignedRuntimeActivationManifestV1 = {
    algorithm: 'ed25519',
    domain: RUNTIME_ACTIVATION_MANIFEST_DOMAIN_V1,
    keyId,
    payload,
    schemaVersion: 1,
    signature: '',
  };
  manifest.signature = cryptoSign(null, signatureBytes(manifest), privateKey).toString('base64url');
  const parsed = parseSignedRuntimeActivationManifest(canonicalJson(manifest));
  return { manifest: parsed.manifest, canonicalJson: parsed.canonicalJson };
}

function ownedByCurrentUser(stat: BigIntStats): boolean {
  return process.platform === 'win32' || typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function exactPrivateDirectory(stat: BigIntStats): boolean {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === 0o700n)
  );
}

function exactPrivateFile(stat: BigIntStats): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === 0o600n)
  );
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function contained(anchor: string, candidate: string, allowEqual = false): boolean {
  const nested = relative(anchor, candidate);
  return (
    (allowEqual && nested === '') ||
    (nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

function verifyImmutableBundlePath(bundleRootPath: string, targetPath: string, kind: 'directory' | 'file'): void {
  const root = resolve(bundleRootPath);
  const target = resolve(targetPath);
  if (!contained(root, target, kind === 'directory')) {
    throw new Error('artifact path escapes immutable bundle root');
  }
  const directoryTarget = kind === 'file' ? dirname(target) : target;
  const components = relative(root, directoryTarget).split(sep).filter(Boolean);
  let current = root;
  for (const component of ['', ...components]) {
    if (component) current = join(current, component);
    const stat = lstatSync(current, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !ownedByCurrentUser(stat) ||
      (process.platform !== 'win32' && (stat.mode & 0o222n) !== 0n) ||
      realpathSync(current) !== current
    ) {
      throw new Error('immutable bundle directory custody is invalid');
    }
    if (process.platform === 'win32') {
      const assurance = assurePrivateStoragePath(current, 'directory', 'inspect-owned', { anchorPath: root });
      if (!assurance.ok) throw new Error('immutable bundle directory ACL is invalid');
    }
  }
  if (kind === 'file') {
    const stat = lstatSync(target, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      !ownedByCurrentUser(stat) ||
      (process.platform !== 'win32' && (stat.mode & 0o222n) !== 0n) ||
      realpathSync(target) !== target
    ) {
      throw new Error('immutable bundle file custody is invalid');
    }
    if (process.platform === 'win32') {
      const assurance = assurePrivateStoragePath(target, 'file', 'inspect-owned', { anchorPath: root });
      if (!assurance.ok) throw new Error('immutable bundle file ACL is invalid');
    }
  }
}

function runtimeActivationRootPath(homePath = homedir()): string {
  return join(realpathSync(resolve(homePath)), '.ashlr', 'control', 'activation');
}

export function runtimeActivationAuthorityPaths(homePath = homedir()): {
  rootPath: string;
  trustRootPath: string;
  plansPath: string;
} {
  const rootPath = runtimeActivationRootPath(homePath);
  return {
    rootPath,
    trustRootPath: join(rootPath, 'trust-root.json'),
    plansPath: join(rootPath, 'plans'),
  };
}

function verifyPrivateAuthorityPath(path: string, homePath: string, kind: 'directory' | 'file'): void {
  const home = resolve(homePath);
  const target = resolve(path);
  if (!contained(home, target)) throw new Error('activation authority path escapes operator home');
  const components = relative(home, kind === 'file' ? dirname(target) : target)
    .split(sep)
    .filter(Boolean);
  let current = home;
  const homeStat = lstatSync(home, { bigint: true });
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    !ownedByCurrentUser(homeStat) ||
    (process.platform !== 'win32' && (homeStat.mode & 0o022n) !== 0n)
  ) {
    throw new Error('operator home custody is invalid');
  }
  for (const component of components) {
    current = join(current, component);
    const stat = lstatSync(current, { bigint: true });
    if (!exactPrivateDirectory(stat) || realpathSync(current) !== current) {
      throw new Error('activation authority directory custody is invalid');
    }
    if (process.platform === 'win32') {
      const assurance = assurePrivateStoragePath(current, 'directory', 'inspect-owned', { anchorPath: home });
      if (!assurance.ok) throw new Error('activation authority directory ACL is invalid');
    }
  }
  if (kind === 'file') {
    const stat = lstatSync(target, { bigint: true });
    if (!exactPrivateFile(stat) || realpathSync(target) !== target) {
      throw new Error('activation authority file custody is invalid');
    }
    if (process.platform === 'win32') {
      const assurance = assurePrivateStoragePath(target, 'file', 'inspect-owned', { anchorPath: home });
      if (!assurance.ok) throw new Error('activation authority file ACL is invalid');
    }
  }
}

function loadOperatorTrustRoot(homePath: string): LoadedTrustRoot {
  const paths = runtimeActivationAuthorityPaths(homePath);
  verifyPrivateAuthorityPath(paths.rootPath, homePath, 'directory');
  verifyPrivateAuthorityPath(paths.trustRootPath, homePath, 'file');
  const read = readStableRegularFile(paths.trustRootPath, {
    anchorPath: paths.rootPath,
    maxFileBytes: MAX_TRUST_ROOT_BYTES,
    remainingBytes: MAX_TRUST_ROOT_BYTES,
  });
  if (!read.ok) throw new Error(`operator trust root read failed: ${read.reason}`);
  const parsed = parseCanonicalJson(read.text, MAX_TRUST_ROOT_BYTES);
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, [
      'assurance',
      'domain',
      'evidenceTrustRoot',
      'minimumPolicyEpoch',
      'permittedActivationModes',
      'schemaVersion',
    ]) ||
    parsed['assurance'] !== 'operator-custodied-public-trust-root' ||
    parsed['domain'] !== RUNTIME_ACTIVATION_AUTHORITY_TRUST_ROOT_DOMAIN_V1 ||
    parsed['schemaVersion'] !== 1 ||
    !isPositiveSafeInteger(parsed['minimumPolicyEpoch']) ||
    !Array.isArray(parsed['permittedActivationModes']) ||
    parsed['permittedActivationModes'].length !== 1 ||
    parsed['permittedActivationModes'][0] !== 'resident-canary'
  ) {
    throw new Error('operator trust root schema is invalid');
  }
  const evidenceCanonicalJson = canonicalJson(parsed['evidenceTrustRoot']);
  const evidence = parseRuntimeReleaseEvidenceTrustRoot(evidenceCanonicalJson);
  if (!evidence.ok) throw new Error(`operator evidence trust root is invalid: ${evidence.reason}`);
  const canonical = canonicalJson(parsed);
  return {
    root: parsed as unknown as RuntimeActivationAuthorityTrustRootV1,
    canonicalJson: canonical,
    canonicalSha256: sha256(canonical),
    evidenceTrustRootCanonicalJson: evidence.canonicalJson,
    evidenceTrustRootCanonicalSha256: runtimeReleaseTrustRootCanonicalSha256(evidence.canonicalJson)!,
    evidenceTrustRootSha256: sha256(evidence.canonicalJson),
  };
}

function validateBundleRequest(value: unknown): RuntimeActivationBundleRequestV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'argv',
      'bundleRoot',
      'declaredInterpreterPath',
      'declaredInterpreterVersion',
      'dependencyRoot',
      'envelopePath',
      'executablePath',
      'manifestPath',
      'packageRoot',
      'packageTarballPath',
      'policyPath',
      'serviceDescriptorPath',
    ])
  )
    throw new Error('activation bundle request has invalid keys');
  for (const key of [
    'bundleRoot',
    'declaredInterpreterPath',
    'declaredInterpreterVersion',
    'dependencyRoot',
    'envelopePath',
    'executablePath',
    'manifestPath',
    'packageRoot',
    'packageTarballPath',
    'policyPath',
    'serviceDescriptorPath',
  ] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 4_096) {
      throw new Error(`activation bundle ${key} is invalid`);
    }
  }
  for (const key of [
    'bundleRoot',
    'declaredInterpreterPath',
    'dependencyRoot',
    'envelopePath',
    'executablePath',
    'manifestPath',
    'packageRoot',
    'packageTarballPath',
    'policyPath',
    'serviceDescriptorPath',
  ] as const) {
    const path = value[key] as string;
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new Error(`activation bundle ${key} must be absolute and canonical`);
    }
  }
  if (!Array.isArray(value['argv']) || value['argv'].length < 1 || value['argv'].length > MAX_ARGUMENTS) {
    throw new Error('activation bundle argv is invalid');
  }
  let argumentBytes = 0;
  for (const argument of value['argv']) {
    if (typeof argument !== 'string' || argument.includes('\0')) throw new Error('activation bundle argv is invalid');
    argumentBytes += Buffer.byteLength(argument, 'utf8');
  }
  if (argumentBytes > MAX_ARGUMENT_BYTES) throw new Error('activation bundle argv exceeds byte limit');
  return value as unknown as RuntimeActivationBundleRequestV1;
}

function readRequest(requestPath: string, homePath: string): ReadRequestResult {
  const paths = runtimeActivationAuthorityPaths(homePath);
  verifyPrivateAuthorityPath(paths.plansPath, homePath, 'directory');
  const canonicalRequestPath = resolve(requestPath);
  if (
    dirname(canonicalRequestPath) !== paths.plansPath ||
    realpathSync(canonicalRequestPath) !== canonicalRequestPath
  ) {
    throw new Error('activation request must be a direct file in the operator plans directory');
  }
  verifyPrivateAuthorityPath(canonicalRequestPath, homePath, 'file');
  const read = readStableRegularFile(canonicalRequestPath, {
    anchorPath: paths.plansPath,
    maxFileBytes: MAX_REQUEST_BYTES,
    remainingBytes: MAX_REQUEST_BYTES,
  });
  if (!read.ok) throw new Error(`activation request read failed: ${read.reason}`);
  const parsed = parseCanonicalJson(read.text, MAX_REQUEST_BYTES);
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ['candidate', 'domain', 'rollback', 'schemaVersion', 'signedManifest']) ||
    parsed['domain'] !== RUNTIME_ACTIVATION_REQUEST_DOMAIN_V1 ||
    parsed['schemaVersion'] !== 1 ||
    !isRecord(parsed['signedManifest'])
  ) {
    throw new Error('activation request schema is invalid');
  }
  const signed = parseSignedRuntimeActivationManifest(canonicalJson(parsed['signedManifest']));
  if (basename(canonicalRequestPath) !== `${signed.manifest.payload.planId}.json`) {
    throw new Error('activation request filename does not match signed plan id');
  }
  return {
    request: {
      candidate: validateBundleRequest(parsed['candidate']),
      domain: RUNTIME_ACTIVATION_REQUEST_DOMAIN_V1,
      rollback: validateBundleRequest(parsed['rollback']),
      schemaVersion: 1,
      signedManifest: signed.manifest,
    },
    requestPath: canonicalRequestPath,
  };
}

function verifyActivationManifest(parsed: ParsedActivationManifest, trust: LoadedTrustRoot, nowMs: number): void {
  const { manifest } = parsed;
  if (manifest.payload.policyEpoch < trust.root.minimumPolicyEpoch) {
    throw new Error('activation manifest policy epoch is stale');
  }
  if (!trust.root.permittedActivationModes.includes(manifest.payload.activationMode)) {
    throw new Error('activation mode is not permitted by operator policy');
  }
  const issuedAtMs = Date.parse(manifest.payload.issuedAt);
  const expiresAtMs = Date.parse(manifest.payload.expiresAt);
  if (nowMs < issuedAtMs || nowMs >= expiresAtMs) throw new Error('activation manifest is expired or not yet valid');
  const evidence = parseRuntimeReleaseEvidenceTrustRoot(trust.evidenceTrustRootCanonicalJson);
  if (!evidence.ok) throw new Error('operator evidence trust root is invalid');
  const key = evidence.trustRoot.keys.find((entry) => entry.keyId === manifest.keyId);
  if (!key || nowMs < Date.parse(key.validFrom) || nowMs >= Date.parse(key.validUntil)) {
    throw new Error('activation signing key is unavailable or outside validity');
  }
  const der = decodeBase64url(key.publicKeySpki);
  const signature = decodeBase64url(manifest.signature, 64);
  if (!der || !signature) throw new Error('activation signing material is invalid');
  const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (
    publicKey.asymmetricKeyType !== 'ed25519' ||
    runtimeReleaseEvidenceKeyId(publicKey) !== manifest.keyId ||
    !cryptoVerify(null, signatureBytes(manifest), publicKey, signature)
  ) {
    throw new Error('activation manifest signature is invalid');
  }
}

function hashStableArtifact(path: string, rootPath: string): string {
  const root = resolve(rootPath);
  const target = resolve(path);
  verifyImmutableBundlePath(root, target, 'file');
  const rootBefore = lstatSync(root, { bigint: true });
  const fileBefore = lstatSync(target, { bigint: true });
  if (fileBefore.size < 1n || fileBefore.size > BigInt(MAX_HASH_ARTIFACT_BYTES)) {
    throw new Error('artifact size is invalid');
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(target, fsConstants.O_RDONLY | noFollow);
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!sameSnapshot(fileBefore, openedBefore)) throw new Error('artifact changed before read');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(openedBefore.size)) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, Number(openedBefore.size) - offset), offset);
      if (count <= 0) throw new Error('artifact changed during read');
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    if (readSync(fd, chunk, 0, 1, offset) !== 0) throw new Error('artifact grew during read');
    const openedAfter = fstatSync(fd, { bigint: true });
    const fileAfter = lstatSync(target, { bigint: true });
    const rootAfter = lstatSync(root, { bigint: true });
    if (
      !sameSnapshot(openedBefore, openedAfter) ||
      !sameSnapshot(openedAfter, fileAfter) ||
      !sameSnapshot(rootBefore, rootAfter) ||
      realpathSync(root) !== root ||
      realpathSync(target) !== target
    ) {
      throw new Error('artifact changed during read');
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function readBundleText(path: string, bundleRoot: string): string {
  verifyImmutableBundlePath(bundleRoot, path, 'file');
  const read = readStableRegularFile(path, {
    anchorPath: bundleRoot,
    maxFileBytes: MAX_TEXT_ARTIFACT_BYTES,
    remainingBytes: MAX_TEXT_ARTIFACT_BYTES,
  });
  if (!read.ok) throw new Error(`bundle text read failed: ${read.reason}`);
  return read.text;
}

interface ObservedBundle {
  envelope: string;
  manifest: string;
  launchReceiptSha256: string;
}

function observeBundle(
  request: RuntimeActivationBundleRequestV1,
  binding: RuntimeActivationArtifactBindingV1,
  trust: LoadedTrustRoot,
): ObservedBundle {
  const bundleRoot = resolve(request.bundleRoot);
  verifyImmutableBundlePath(bundleRoot, bundleRoot, 'directory');
  verifyImmutableBundlePath(bundleRoot, request.packageRoot, 'directory');
  verifyImmutableBundlePath(bundleRoot, request.dependencyRoot, 'directory');
  verifyImmutableBundlePath(bundleRoot, request.declaredInterpreterPath, 'file');
  verifyImmutableBundlePath(bundleRoot, request.executablePath, 'file');
  const manifest = readBundleText(request.manifestPath, bundleRoot);
  const envelope = readBundleText(request.envelopePath, bundleRoot);
  const policy = readBundleText(request.policyPath, bundleRoot);
  if (
    !equalDigest(hashStableArtifact(request.packageTarballPath, bundleRoot), binding.packageTarballSha256) ||
    !equalDigest(hashStableArtifact(request.serviceDescriptorPath, bundleRoot), binding.serviceDescriptorSha256)
  ) {
    throw new Error('package tarball or service descriptor digest mismatch');
  }
  if (
    runtimeReleaseEnvelopeCanonicalSha256(envelope) !== binding.envelopeCanonicalSha256 ||
    sha256(envelope) !== binding.envelopeSha256 ||
    runtimeReleasePolicyId(policy) !== binding.policyId ||
    runtimeReleaseTrustRootCanonicalSha256(trust.evidenceTrustRootCanonicalJson) !==
      binding.evidenceTrustRootCanonicalSha256 ||
    sha256(trust.evidenceTrustRootCanonicalJson) !== binding.evidenceTrustRootSha256
  ) {
    throw new Error('release evidence or policy identity mismatch');
  }
  const parsedEnvelope = parseRuntimeReleaseEvidenceEnvelope(envelope);
  const parsedManifest = parseUnsignedRuntimeReleaseManifest(manifest);
  if (
    !parsedEnvelope.ok ||
    !parsedManifest.ok ||
    parsedEnvelope.envelope.keyId !== binding.evidenceKeyId ||
    parsedManifest.manifest.manifestDigest !== binding.manifestDigest ||
    parsedManifest.manifest.expectedRevision !== binding.expectedRevision ||
    parsedManifest.manifest.dependencyInventory.inventoryDigest !== binding.dependencyInventoryDigest ||
    parsedManifest.manifest.interpreterDeclaration.observedArtifactSha256 !== binding.interpreterSha256 ||
    parsedManifest.manifest.package.version !== binding.packageVersion
  ) {
    throw new Error('release manifest binding mismatch');
  }
  const observed = observeRuntimeReleaseLaunchInputs({
    argv: [...request.argv],
    declaredInterpreterPath: request.declaredInterpreterPath,
    declaredInterpreterVersion: request.declaredInterpreterVersion,
    dependencyRoot: request.dependencyRoot,
    envelope,
    executablePath: request.executablePath,
    expectedEnvelopeCanonicalSha256: binding.envelopeCanonicalSha256,
    expectedKeyId: binding.evidenceKeyId,
    expectedManifestDigest: binding.manifestDigest,
    expectedPolicyId: binding.policyId,
    expectedRevision: binding.expectedRevision,
    expectedServiceInvocationDigest: binding.serviceInvocationDigest,
    expectedStagedTreeIdentity: binding.runtimeTreeSha256,
    expectedTrustRootCanonicalSha256: binding.evidenceTrustRootCanonicalSha256,
    manifest,
    packageRoot: request.packageRoot,
    policy,
    trustRoot: trust.evidenceTrustRootCanonicalJson,
  } satisfies RuntimeReleaseLaunchObservationOptions);
  if (!observed.ok) throw new Error(`release launch observation failed: ${observed.reason}`);
  return {
    envelope,
    manifest,
    launchReceiptSha256: sha256(observed.canonicalJson),
  };
}

function emptyResult(blockers: RuntimeActivationPreflightBlocker[]): RuntimeActivationAuthorityPreflightResult {
  return {
    schemaVersion: 1,
    authority: 'read-only-preflight',
    verdict: 'blocked',
    evidenceReady: false,
    activationPermitted: false,
    deployPermitted: false,
    installPermitted: false,
    launchPermitted: false,
    rollbackPermitted: false,
    startPermitted: false,
    executionPerformed: false,
    plan: {
      planId: null,
      planDigest: null,
      replayKey: null,
      policyEpoch: null,
      activationMode: null,
      expiresAt: null,
    },
    trust: {
      operatorCustodyVerified: false,
      signatureVerified: false,
      signingKeyId: null,
      trustRootCanonicalSha256: null,
    },
    releases: {
      candidateRevision: null,
      candidateTree: null,
      rollbackRevision: null,
      rollbackTree: null,
      pairVerified: false,
    },
    blockers,
    authorityBlockers: [
      'explicit-activation-command-required',
      'two-exact-digest-confirmations-required',
      'durable-replay-consumption-required',
      'macos-platform-required',
      'protected-postmerge-evidence-required',
    ],
  };
}

function activationManifestBlocker(error: unknown): RuntimeActivationPreflightBlocker {
  const detail = error instanceof Error ? error.message : 'signed activation manifest is invalid';
  const code: RuntimeActivationPreflightBlockerCode = detail.includes('expired')
    ? 'signed-manifest-expired'
    : detail.includes('policy epoch')
      ? 'policy-epoch-stale'
      : detail.includes('activation mode')
        ? 'activation-mode-denied'
        : 'signed-manifest-invalid';
  return { code, detail };
}

export function preflightRuntimeActivationAuthority(input: {
  requestPath: string;
  homePath?: string;
  nowMs?: number;
  clock?: () => number;
}): RuntimeActivationAuthorityPreflightResult {
  const blockers: RuntimeActivationPreflightBlocker[] = [];
  const clock = input.clock ?? (() => input.nowMs ?? Date.now());
  let homePath: string;
  try {
    homePath = realpathSync(resolve(input.homePath ?? homedir()));
  } catch {
    return emptyResult([
      {
        code: 'operator-trust-root-unavailable',
        detail: 'operator home is unavailable',
      },
    ]);
  }
  let trust: LoadedTrustRoot;
  try {
    trust = loadOperatorTrustRoot(homePath);
  } catch (error) {
    return emptyResult([
      {
        code: 'operator-trust-root-unavailable',
        detail: error instanceof Error ? error.message : 'operator trust root is unavailable',
      },
    ]);
  }
  let read: ReadRequestResult;
  try {
    read = readRequest(input.requestPath, homePath);
  } catch (error) {
    const result = emptyResult([
      {
        code: 'request-unavailable',
        detail: error instanceof Error ? error.message : 'activation request is unavailable',
      },
    ]);
    result.trust.operatorCustodyVerified = true;
    result.trust.trustRootCanonicalSha256 = trust.canonicalSha256;
    return result;
  }
  const parsed = parseSignedRuntimeActivationManifest(canonicalJson(read.request.signedManifest));
  const payload = parsed.manifest.payload;
  try {
    verifyActivationManifest(parsed, trust, clock());
  } catch (error) {
    blockers.push(activationManifestBlocker(error));
  }
  let candidate: ObservedBundle | null = null;
  let rollback: ObservedBundle | null = null;
  if (blockers.length === 0) {
    try {
      candidate = observeBundle(read.request.candidate, payload.candidate, trust);
    } catch (error) {
      blockers.push({
        code: 'candidate-artifact-invalid',
        detail: error instanceof Error ? error.message : 'candidate artifact is invalid',
      });
    }
    try {
      rollback = observeBundle(read.request.rollback, payload.rollback, trust);
    } catch (error) {
      blockers.push({
        code: 'rollback-artifact-invalid',
        detail: error instanceof Error ? error.message : 'rollback artifact is invalid',
      });
    }
  }
  const distinct =
    payload.candidate.expectedRevision !== payload.rollback.expectedRevision &&
    payload.candidate.expectedTree !== payload.rollback.expectedTree &&
    payload.candidate.manifestDigest !== payload.rollback.manifestDigest &&
    payload.candidate.packageTarballSha256 !== payload.rollback.packageTarballSha256 &&
    payload.candidate.runtimeTreeSha256 !== payload.rollback.runtimeTreeSha256 &&
    resolve(read.request.candidate.bundleRoot) !== resolve(read.request.rollback.bundleRoot) &&
    resolve(read.request.candidate.packageTarballPath) !== resolve(read.request.rollback.packageTarballPath);
  if (!distinct)
    blockers.push({
      code: 'rollback-not-independent',
      detail:
        'candidate and rollback must be distinct revisions, trees, manifests, tarballs, runtime trees, and bundle paths',
    });
  let pairVerified = false;
  if (candidate && rollback) {
    const pair = evaluateRuntimeReleaseCanaryRollbackEvidence({
      observationEnabled: true,
      candidate: {
        envelope: candidate.envelope,
        manifest: candidate.manifest,
        trustRoot: trust.evidenceTrustRootCanonicalJson,
      },
      rollback: {
        envelope: rollback.envelope,
        manifest: rollback.manifest,
        trustRoot: trust.evidenceTrustRootCanonicalJson,
      },
      expected: {
        candidateEnvelopeSha256: payload.candidate.envelopeSha256,
        candidateManifestDigest: payload.candidate.manifestDigest,
        candidateRevision: payload.candidate.expectedRevision,
        rollbackEnvelopeSha256: payload.rollback.envelopeSha256,
        rollbackManifestDigest: payload.rollback.manifestDigest,
        rollbackRevision: payload.rollback.expectedRevision,
        trustRootSha256: payload.candidate.evidenceTrustRootSha256,
      },
    });
    pairVerified = pair.releasePairVerified;
    if (!pairVerified)
      blockers.push({
        code: 'release-pair-invalid',
        detail: pair.blockers.map((entry) => entry.code).join(', ') || 'candidate and rollback release pair is invalid',
      });
  }
  if (blockers.length === 0) {
    try {
      verifyActivationManifest(parsed, trust, clock());
    } catch (error) {
      blockers.push(activationManifestBlocker(error));
    }
  }
  const evidenceReady = blockers.length === 0 && pairVerified;
  return {
    ...emptyResult(blockers),
    verdict: evidenceReady ? 'evidence-ready' : 'blocked',
    evidenceReady,
    plan: {
      planId: payload.planId,
      planDigest: parsed.planDigest,
      replayKey: parsed.replayKey,
      policyEpoch: payload.policyEpoch,
      activationMode: payload.activationMode,
      expiresAt: payload.expiresAt,
    },
    trust: {
      operatorCustodyVerified: true,
      signatureVerified: blockers.every(
        (entry) =>
          ![
            'signed-manifest-invalid',
            'signed-manifest-expired',
            'policy-epoch-stale',
            'activation-mode-denied',
          ].includes(entry.code),
      ),
      signingKeyId: parsed.manifest.keyId,
      trustRootCanonicalSha256: trust.canonicalSha256,
    },
    releases: {
      candidateRevision: payload.candidate.expectedRevision,
      candidateTree: payload.candidate.expectedTree,
      rollbackRevision: payload.rollback.expectedRevision,
      rollbackTree: payload.rollback.expectedTree,
      pairVerified,
    },
  };
}

/**
 * Re-observe the private request around a complete preflight and return only an
 * exact, unchanged, evidence-ready plan. Mutation consumers must still apply
 * their own platform, host, replay, and transactional authority checks.
 */
export function observeRuntimeActivationExecutionPlan(input: {
  requestPath: string;
  homePath?: string;
  nowMs?: number;
  clock?: () => number;
}): {
  preflight: RuntimeActivationAuthorityPreflightResult;
  request: RuntimeActivationPreflightRequestV1;
  canonicalRequestSha256: string;
} {
  const first = preflightRuntimeActivationAuthority(input);
  if (!first.evidenceReady || !first.plan.planDigest) {
    throw new Error(`runtime activation evidence is blocked: ${first.blockers.map((entry) => entry.code).join(', ')}`);
  }
  const homePath = realpathSync(resolve(input.homePath ?? homedir()));
  const observed = readRequest(input.requestPath, homePath);
  const canonicalRequest = runtimeActivationRequestCanonicalJson(observed.request);
  const parsed = parseSignedRuntimeActivationManifest(canonicalJson(observed.request.signedManifest));
  const second = preflightRuntimeActivationAuthority(input);
  if (
    !second.evidenceReady ||
    second.plan.planDigest !== first.plan.planDigest ||
    parsed.planDigest !== first.plan.planDigest
  ) {
    throw new Error('runtime activation request changed during execution admission');
  }
  return {
    preflight: second,
    request: structuredClone(observed.request),
    canonicalRequestSha256: sha256(canonicalRequest),
  };
}

export function runtimeActivationTrustRootCanonicalJson(input: RuntimeActivationAuthorityTrustRootV1): string {
  const canonical = canonicalJson(input);
  const parsed = parseCanonicalJson(canonical, MAX_TRUST_ROOT_BYTES);
  if (!isRecord(parsed)) throw new Error('runtime activation trust root is invalid');
  return canonical;
}

export function runtimeActivationRequestCanonicalJson(input: RuntimeActivationPreflightRequestV1): string {
  const canonical = canonicalJson(input);
  const parsed = parseCanonicalJson(canonical, MAX_REQUEST_BYTES);
  if (!isRecord(parsed)) throw new Error('runtime activation request is invalid');
  return canonical;
}

export function runtimeActivationPlanEvidence(
  signedManifest: SignedRuntimeActivationManifestV1,
  trustRootCanonicalSha256: string,
): RuntimeActivationPlanEvidenceV1 {
  if (!SHA256_RE.test(trustRootCanonicalSha256)) throw new Error('trust root digest is invalid');
  const parsed = parseSignedRuntimeActivationManifest(canonicalJson(signedManifest));
  return {
    activationMode: parsed.manifest.payload.activationMode,
    authority: 'observation-only',
    domain: RUNTIME_ACTIVATION_PLAN_EVIDENCE_DOMAIN_V1,
    executionPermitted: false,
    planDigest: parsed.planDigest,
    planId: parsed.manifest.payload.planId,
    policyEpoch: parsed.manifest.payload.policyEpoch,
    replayKey: parsed.replayKey,
    schemaVersion: 1,
    trustRootCanonicalSha256,
  };
}

export function runtimeActivationPlanEvidenceCanonicalJson(input: RuntimeActivationPlanEvidenceV1): string {
  if (
    !UUID_RE.test(input.planId) ||
    !SHA256_RE.test(input.planDigest) ||
    !SHA256_RE.test(input.replayKey) ||
    !SHA256_RE.test(input.trustRootCanonicalSha256) ||
    !isPositiveSafeInteger(input.policyEpoch) ||
    input.activationMode !== 'resident-canary' ||
    input.authority !== 'observation-only' ||
    input.executionPermitted !== false ||
    input.domain !== RUNTIME_ACTIVATION_PLAN_EVIDENCE_DOMAIN_V1 ||
    input.schemaVersion !== 1
  ) {
    throw new Error('runtime activation plan evidence is invalid');
  }
  return canonicalJson(input);
}

function parseRuntimeActivationPlanEvidence(value: unknown): RuntimeActivationPlanEvidenceV1 | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'activationMode',
      'authority',
      'domain',
      'executionPermitted',
      'planDigest',
      'planId',
      'policyEpoch',
      'replayKey',
      'schemaVersion',
      'trustRootCanonicalSha256',
    ])
  )
    return null;
  try {
    const evidence = value as unknown as RuntimeActivationPlanEvidenceV1;
    runtimeActivationPlanEvidenceCanonicalJson(evidence);
    return evidence;
  } catch {
    return null;
  }
}

function runtimeActivationPlanEvidenceCodec(): ImmutablePrivateRecordCodec<RuntimeActivationPlanEvidenceV1> {
  return {
    parse: parseRuntimeActivationPlanEvidence,
    serialize: runtimeActivationPlanEvidenceCanonicalJson,
    recordId: (record) => record.planId,
    recordFileName: (record) => `${record.planId}.json`,
    isRecordFileName: (fileName) => fileName.endsWith('.json') && UUID_RE.test(fileName.slice(0, -'.json'.length)),
    stageToken: (record) => record.replayKey,
    equivalent: (left, right) =>
      runtimeActivationPlanEvidenceCanonicalJson(left) === runtimeActivationPlanEvidenceCanonicalJson(right),
  };
}

function runtimeActivationPlanEvidenceStore(input: { anchorPath: string; storeRoot: string }) {
  return {
    label: 'runtime activation plan evidence',
    anchorPath: input.anchorPath,
    rootPath: input.storeRoot,
    lockFileName: '.runtime-activation-plan-evidence.lock',
    maxRecordBytes: 4 * 1_024,
    defaultMaxFiles: 1_024,
    hardMaxFiles: 10_000,
    defaultMaxBytes: 4 * 1024 * 1_024,
    hardMaxBytes: 40 * 1024 * 1_024,
    codecForWrite: runtimeActivationPlanEvidenceCodec,
    codecForRead: runtimeActivationPlanEvidenceCodec,
  };
}

/**
 * Persist deterministic observation evidence without granting activation or
 * consuming the replay key. Callers must supply an isolated private anchor;
 * the read-only CLI never invokes this writer or defaults it into ~/.ashlr.
 */
export function writeRuntimeActivationPlanEvidence(
  evidence: RuntimeActivationPlanEvidenceV1,
  storage: { anchorPath: string; storeRoot: string },
): ImmutablePrivateRecordWriteDisposition {
  return writeImmutablePrivateRecord(runtimeActivationPlanEvidenceStore(storage), evidence);
}

export function readRuntimeActivationPlanEvidence(
  planId: string,
  storage: { anchorPath: string; storeRoot: string },
): ImmutablePrivateRecordPointReadResult<RuntimeActivationPlanEvidenceV1> {
  if (!UUID_RE.test(planId)) {
    return {
      record: null,
      sourceState: 'degraded',
      sourcePresent: false,
      exactReadComplete: false,
      stopReasons: ['invalid-options'],
      bytesRead: 0,
    };
  }
  return readImmutablePrivateRecordPoint(runtimeActivationPlanEvidenceStore(storage), planId, `${planId}.json`);
}

export const runtimeActivationAuthorityInternals = {
  hashStableArtifact,
  loadOperatorTrustRoot,
  verifyActivationManifest,
};
