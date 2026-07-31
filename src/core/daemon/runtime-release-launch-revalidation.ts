import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';
import {
  parseUnsignedRuntimeReleaseManifest,
  verifyUnsignedRuntimeReleaseManifest,
  type UnsignedRuntimeReleaseArtifact,
} from './runtime-release-manifest.js';
import {
  parseRuntimeReleaseEvidenceEnvelope,
  parseRuntimeReleaseEvidenceTrustRoot,
  verifyRuntimeReleaseEvidenceEnvelope,
  type RuntimeReleaseEvidenceVerificationDependencies,
} from './runtime-release-evidence-envelope.js';

const STAGED_TREE_IDENTITY_DOMAIN =
  'ashlr:runtime-release-immutable-staged-tree:v1';
export const RUNTIME_RELEASE_IMMUTABLE_STAGED_TREE_RECEIPT_DOMAIN_V1 =
  'ashlr:runtime-release-immutable-staged-tree-receipt:v1' as const;
export const RUNTIME_RELEASE_LAUNCH_REVALIDATION_RECEIPT_DOMAIN_V1 =
  'ashlr:runtime-release-launch-revalidation-receipt:v1' as const;
const ARTIFACT_ROOT_DOMAIN = 'ashlr:runtime-release-artifact-root:v1';
const DEPENDENCY_ROOT_DOMAIN = 'ashlr:runtime-release-dependency-root:v1';
const INTERPRETER_ROOT_DOMAIN = 'ashlr:runtime-release-interpreter-root:v1';
const STABLE_IDENTITY_DOMAIN = 'ashlr:runtime-release-stable-identity:v1';
const INVOCATION_DOMAIN = 'ashlr:runtime-release-service-invocation:v1';
const ENVELOPE_CANONICAL_DOMAIN =
  'ashlr:runtime-release-launch-envelope-canonical:v1';
const MANIFEST_CANONICAL_DOMAIN =
  'ashlr:runtime-release-launch-manifest-canonical:v1';
const POLICY_CANONICAL_DOMAIN =
  'ashlr:runtime-release-launch-policy-canonical:v1';
const TRUST_ROOT_CANONICAL_DOMAIN =
  'ashlr:runtime-release-launch-trust-root-canonical:v1';
const MAX_FILES = 32_768;
const MAX_DIRECTORIES = 8_192;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DEPTH = 48;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const KEY_ID_RE = /^ed25519-sha256:[a-f0-9]{64}$/;
const POLICY_ID_RE = /^sha256:[a-f0-9]{64}$/;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface FileObservation {
  content: {
    executable: boolean;
    path: string;
    sha256: string;
    size: number;
  };
  stable: {
    identity: string;
    path: string;
  };
}

interface RuntimeReleaseLaunchRevalidationTestHooks {
  afterBeforeObservation?: () => void;
  afterFilePathSnapshotBeforeOpen?: (path: string, label: string) => void;
}

export type RuntimeReleaseLaunchRevalidationDependencies =
  RuntimeReleaseEvidenceVerificationDependencies;

interface RootObservation {
  bytes: number;
  directories: number;
  files: number;
  rootSha256: string;
  stableIdentitySha256: string;
}

interface StageObservation {
  artifactRoot: RootObservation;
  dependencyRoot: RootObservation;
  interpreterRootSha256: string;
  manifestDigest: string;
  stableIdentitySha256: string;
  stagedTreeIdentity: string;
}

export interface RuntimeReleaseImmutableStagedTreeOptions {
  declaredInterpreterPath: string;
  declaredInterpreterVersion: string;
  dependencyRoot: string;
  expectedManifestDigest: string;
  expectedPackageName?: string;
  expectedRevision: string;
  manifest: string | Buffer;
  packageRoot: string;
  platform?: NodeJS.Platform;
}

export interface RuntimeReleaseImmutableStagedTreeReceiptV1 {
  algorithm: 'sha256';
  assurance: 'immutable-staged-tree-observation-only';
  authority: {
    deployPermitted: false;
    installPermitted: false;
    launchPermitted: false;
    rollbackPermitted: false;
    startPermitted: false;
  };
  domain: typeof RUNTIME_RELEASE_IMMUTABLE_STAGED_TREE_RECEIPT_DOMAIN_V1;
  coverage: {
    artifacts: 'complete-manifest-artifact-root';
    dependencies: 'complete-staged-dependency-tree';
    durability: 'posix-directory-fsync-observed';
    interpreter: 'complete-declared-interpreter-artifact';
    launchConsumer: 'absent';
    mutationAfterReceipt: 'not-prevented';
    replayPrevention: 'absent-no-durable-consumption-store';
    stableIdentity: 'before-after-required';
  };
  expectedRevision: string;
  roots: {
    artifactRootSha256: string;
    dependencyRootSha256: string;
    interpreterRootSha256: string;
  };
  schemaVersion: 1;
  stableIdentitySha256: string;
  stagedTreeIdentity: string;
}

export type ObserveRuntimeReleaseImmutableStagedTreeResult =
  | {
    ok: true;
    canonicalJson: string;
    receipt: RuntimeReleaseImmutableStagedTreeReceiptV1;
  }
  | { ok: false; reason: string };

export interface RuntimeReleaseLaunchRevalidationOptions
  extends RuntimeReleaseImmutableStagedTreeOptions {
  argv: string[];
  envelope: string | Buffer;
  executablePath: string;
  expectedEnvelopeCanonicalSha256: string;
  expectedKeyId: string;
  expectedPolicyId: string;
  expectedServiceInvocationDigest: string;
  expectedStagedTreeIdentity: string;
  expectedTrustRootCanonicalSha256: string;
  policy: string | Buffer;
  trustRoot: string | Buffer;
}

export interface RuntimeReleaseLaunchRevalidationReceiptV1 {
  algorithm: 'sha256';
  assurance: 'final-pre-exec-observation-only';
  authority: {
    deployPermitted: false;
    installPermitted: false;
    launchPermitted: false;
    rollbackPermitted: false;
    startPermitted: false;
  };
  domain: typeof RUNTIME_RELEASE_LAUNCH_REVALIDATION_RECEIPT_DOMAIN_V1;
  coverage: {
    artifacts: 'complete-manifest-artifact-root';
    dependencies: 'complete-staged-dependency-tree';
    durability: 'posix-directory-fsync-observed';
    envelope: 'signed-release-observation-revalidated';
    interpreter: 'complete-declared-interpreter-artifact';
    invocation: 'exact-executable-and-argv-digest';
    launchConsumer: 'absent';
    mutationAfterReceipt: 'not-prevented';
    policy: 'caller-pinned-canonical-observation-only';
    replayPrevention: 'absent-no-durable-consumption-store';
    stableIdentity: 'before-after-equal';
  };
  expectedRevision: string;
  invocation: {
    argumentCount: number;
    executablePath: string;
    serviceInvocationDigest: string;
  };
  policy: {
    canonicalSha256: string;
    policyId: string;
    source: 'caller-pinned-unsigned';
  };
  release: {
    envelopeCanonicalSha256: string;
    expiresAt: string;
    issuedAt: string;
    keyId: string;
    manifestCanonicalSha256: string;
    manifestDigest: string;
    expectedRevision: string;
    rollbackTargetManifestDigest: string | null;
    trustRootCanonicalSha256: string;
  };
  roots: {
    artifactRootSha256: string;
    dependencyRootSha256: string;
    interpreterRootSha256: string;
  };
  schemaVersion: 1;
  stableIdentity: {
    afterSha256: string;
    beforeSha256: string;
  };
  stagedTreeIdentity: string;
}

export type RevalidateRuntimeReleaseLaunchResult =
  | {
    ok: true;
    canonicalJson: string;
    receipt: RuntimeReleaseLaunchRevalidationReceiptV1;
  }
  | { ok: false; reason: string };

function canonicalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('invalid JSON value');
  }
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
    for (const key of Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
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

function parseCanonicalJsonBytes(
  input: string | Buffer,
  maxBytes: number,
  label: string,
): string {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error(`${label} byte length is invalid`);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const encoded = `${canonicalJson(value)}\n`;
  if (encoded !== text) throw new Error(`${label} encoding is not canonical`);
  return encoded;
}

function domainDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function domainBytesDigest(domain: string, value: string | Buffer): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(value)
    .digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function snapshotIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].map(String).join(':');
}

function requireImmutable(stat: BigIntStats, label: string): void {
  if ((stat.mode & 0o222n) !== 0n) {
    throw new Error(`${label} is writable`);
  }
}

function contained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) &&
    !isAbsolute(nested);
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const absolute = resolve(path);
  const before = lstatSync(absolute, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory`);
  }
  requireImmutable(before, label);
  const real = realpathSync(absolute);
  if (real !== absolute) throw new Error(`${label} contains a symlink`);
  return real;
}

function fsyncStableDirectory(path: string, platform: NodeJS.Platform): void {
  const before = lstatSync(path, { bigint: true });
  fsyncDirectory(path, { platform });
  const after = lstatSync(path, { bigint: true });
  if (!sameSnapshot(before, after) || realpathSync(path) !== path) {
    throw new Error(`runtime release durability directory identity changed: ${path}`);
  }
}

function snapshotFile(
  filePath: string,
  logicalPath: string,
  label: string,
  anchor?: string,
  testHooks?: RuntimeReleaseLaunchRevalidationTestHooks,
): FileObservation {
  const absolute = resolve(filePath);
  const before = lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (before.nlink !== 1n) throw new Error(`${label} has multiple hard links`);
  requireImmutable(before, label);
  if (before.size > BigInt(MAX_FILE_BYTES)) throw new Error(`${label} exceeds byte limit`);
  const realBefore = realpathSync(absolute);
  if (realBefore !== absolute || (anchor && !contained(anchor, realBefore))) {
    throw new Error(`${label} contains or escapes through a symlink`);
  }
  testHooks?.afterFilePathSnapshotBeforeOpen?.(absolute, label);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(absolute, fsConstants.O_RDONLY | noFollow);
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!openedBefore.isFile() || !sameSnapshot(before, openedBefore)) {
      throw new Error(`${label} changed before read`);
    }
    if (openedBefore.nlink !== 1n) throw new Error(`${label} has multiple hard links`);
    requireImmutable(openedBefore, label);
    const size = Number(openedBefore.size);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < size) {
      const length = Math.min(READ_CHUNK_BYTES, size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const count = readSync(fd, chunk, 0, length, offset);
      if (count <= 0) throw new Error(`${label} changed during read`);
      hash.update(count === length ? chunk : chunk.subarray(0, count));
      offset += count;
    }
    const probe = Buffer.allocUnsafe(1);
    if (readSync(fd, probe, 0, 1, size) !== 0) {
      throw new Error(`${label} grew during read`);
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const after = lstatSync(absolute, { bigint: true });
    if (!sameSnapshot(openedBefore, openedAfter) ||
      !sameSnapshot(openedAfter, after) ||
      realpathSync(absolute) !== realBefore) {
      throw new Error(`${label} changed during read`);
    }
    if (openedAfter.nlink !== 1n || after.nlink !== 1n) {
      throw new Error(`${label} has multiple hard links`);
    }
    requireImmutable(openedAfter, label);
    requireImmutable(after, label);
    return {
      content: {
        executable: (after.mode & 0o111n) !== 0n,
        path: logicalPath,
        sha256: hash.digest('hex'),
        size,
      },
      stable: {
        identity: snapshotIdentity(after),
        path: logicalPath,
      },
    };
  } finally {
    closeSync(fd);
  }
}

function observeArtifactRoot(
  packageRoot: string,
  artifacts: readonly UnsignedRuntimeReleaseArtifact[],
  testHooks?: RuntimeReleaseLaunchRevalidationTestHooks,
): RootObservation {
  const rootBefore = lstatSync(packageRoot, { bigint: true });
  requireImmutable(rootBefore, 'runtime release package root');
  const content = [];
  const stable = [{ identity: snapshotIdentity(rootBefore), path: '.' }];
  const observedDirectories = new Set<string>(['.']);
  let bytes = 0;
  for (const artifact of artifacts) {
    const segments = artifact.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const logicalDirectory = segments.slice(0, index).join('/');
      if (observedDirectories.has(logicalDirectory)) continue;
      const directoryPath = join(packageRoot, ...segments.slice(0, index));
      const directory = lstatSync(directoryPath, { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink() ||
        realpathSync(directoryPath) !== directoryPath) {
        throw new Error('runtime release artifact root contains an unsafe directory');
      }
      requireImmutable(directory, 'runtime release artifact directory');
      stable.push({
        identity: snapshotIdentity(directory),
        path: logicalDirectory,
      });
      observedDirectories.add(logicalDirectory);
    }
    const observation = snapshotFile(
      join(packageRoot, ...artifact.path.split('/')),
      artifact.path,
      'runtime release artifact',
      packageRoot,
      testHooks,
    );
    if (observation.content.executable !== artifact.executable ||
      observation.content.size !== artifact.size ||
      !equalDigest(observation.content.sha256, artifact.sha256)) {
      throw new Error('runtime release artifact root does not match manifest');
    }
    bytes += observation.content.size;
    content.push(observation.content);
    stable.push(observation.stable);
  }
  const rootAfter = lstatSync(packageRoot, { bigint: true });
  if (!sameSnapshot(rootBefore, rootAfter) || realpathSync(packageRoot) !== packageRoot) {
    throw new Error('runtime release package root changed during artifact scan');
  }
  return {
    bytes,
    directories: observedDirectories.size,
    files: artifacts.length,
    rootSha256: domainDigest(ARTIFACT_ROOT_DOMAIN, content),
    stableIdentitySha256: domainDigest(STABLE_IDENTITY_DOMAIN, stable),
  };
}

function observeDirectoryTree(
  rootPath: string,
  label: string,
  testHooks?: RuntimeReleaseLaunchRevalidationTestHooks,
): RootObservation {
  const root = canonicalDirectory(rootPath, label);
  const content: Array<Record<string, JsonValue>> = [];
  const stable: Array<{ identity: string; path: string }> = [];
  let bytes = 0;
  let directories = 0;
  let files = 0;

  const visit = (directoryPath: string, logicalPath: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error(`${label} depth exceeds limit`);
    const before = lstatSync(directoryPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`${label} contains an unsafe directory`);
    }
    requireImmutable(before, label);
    if (realpathSync(directoryPath) !== directoryPath) {
      throw new Error(`${label} contains a symlink`);
    }
    directories += 1;
    if (directories > MAX_DIRECTORIES) throw new Error(`${label} directory count exceeds limit`);
    stable.push({ identity: snapshotIdentity(before), path: logicalPath });
    const entries = readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const childPath = join(directoryPath, entry.name);
      const childLogical = logicalPath === '.' ? entry.name : `${logicalPath}/${entry.name}`;
      const stat = lstatSync(childPath);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`${label} contains a symlink`);
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        visit(childPath, childLogical, depth + 1);
      } else if (entry.isFile() && stat.isFile()) {
        files += 1;
        if (files > MAX_FILES) throw new Error(`${label} file count exceeds limit`);
        const observation = snapshotFile(childPath, childLogical, label, root, testHooks);
        bytes += observation.content.size;
        if (bytes > MAX_TOTAL_BYTES) throw new Error(`${label} bytes exceed limit`);
        content.push(observation.content as unknown as Record<string, JsonValue>);
        stable.push(observation.stable);
      } else {
        throw new Error(`${label} contains a non-file entry`);
      }
    }
    const after = lstatSync(directoryPath, { bigint: true });
    if (!sameSnapshot(before, after) || realpathSync(directoryPath) !== directoryPath) {
      throw new Error(`${label} changed during traversal`);
    }
  };

  visit(root, '.', 0);
  if (files === 0) throw new Error(`${label} has no files`);
  return {
    bytes,
    directories,
    files,
    rootSha256: domainDigest(DEPENDENCY_ROOT_DOMAIN, content),
    stableIdentitySha256: domainDigest(STABLE_IDENTITY_DOMAIN, stable),
  };
}

function observeStage(
  options: RuntimeReleaseImmutableStagedTreeOptions,
): StageObservation {
  const internal = options as RuntimeReleaseImmutableStagedTreeOptions & {
    __testHooks?: RuntimeReleaseLaunchRevalidationTestHooks;
  };
  const testHooks = process.env['VITEST'] === 'true' ? internal.__testHooks : undefined;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw new Error('runtime release launch revalidation requires available directory durability');
  }
  if (!REVISION_RE.test(options.expectedRevision)) {
    throw new Error('runtime release expected revision is invalid');
  }
  if (!SHA256_RE.test(options.expectedManifestDigest)) {
    throw new Error('runtime release expected manifest digest is invalid');
  }
  const packageRoot = canonicalDirectory(
    options.packageRoot,
    'runtime release package root',
  );
  if (basename(packageRoot) !== options.expectedRevision) {
    throw new Error('runtime release staged path does not match expected revision');
  }
  const dependencyRoot = canonicalDirectory(
    options.dependencyRoot,
    'runtime release dependency root',
  );
  if (dirname(dependencyRoot) !== packageRoot || basename(dependencyRoot) !== 'node_modules') {
    throw new Error('runtime release dependency root is not the staged node_modules tree');
  }
  if (!isAbsolute(options.declaredInterpreterPath)) {
    throw new Error('runtime release declared interpreter path is invalid');
  }
  const interpreterPath = resolve(options.declaredInterpreterPath);
  if (realpathSync(interpreterPath) !== interpreterPath) {
    throw new Error('runtime release declared interpreter contains a symlink');
  }

  fsyncStableDirectory(packageRoot, platform);
  fsyncStableDirectory(dependencyRoot, platform);
  const manifest = parseUnsignedRuntimeReleaseManifest(options.manifest);
  if (!manifest.ok) throw new Error(manifest.reason);
  if (manifest.manifest.expectedRevision !== options.expectedRevision) {
    throw new Error('runtime release manifest revision does not match expected revision');
  }
  const verified = verifyUnsignedRuntimeReleaseManifest({
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: options.declaredInterpreterVersion,
    expectedManifestDigest: options.expectedManifestDigest,
    expectedPackageName: options.expectedPackageName,
    expectedRevision: options.expectedRevision,
    manifest: options.manifest,
    packageRoot,
    declaredRollbackTargetDigest:
      manifest.manifest.rollbackDeclaration.targetManifestDigest,
  });
  if (!verified.ok) throw new Error(verified.reason);
  const artifactRoot = observeArtifactRoot(
    packageRoot,
    manifest.manifest.artifacts,
    testHooks,
  );
  const dependencyRootObservation = observeDirectoryTree(
    dependencyRoot,
    'runtime release dependency root',
    testHooks,
  );
  const interpreter = snapshotFile(
    interpreterPath,
    interpreterPath,
    'runtime release declared interpreter',
    undefined,
    testHooks,
  );
  if (!equalDigest(
    interpreter.content.sha256,
    manifest.manifest.interpreterDeclaration.observedArtifactSha256,
  )) {
    throw new Error('runtime release interpreter root does not match manifest');
  }
  const interpreterRootSha256 = domainDigest(INTERPRETER_ROOT_DOMAIN, interpreter.content);
  const stableIdentitySha256 = domainDigest(STABLE_IDENTITY_DOMAIN, {
    artifact: artifactRoot.stableIdentitySha256,
    dependency: dependencyRootObservation.stableIdentitySha256,
    interpreter: interpreter.stable.identity,
    packageRoot,
  });
  const stagedTreeIdentity = domainDigest(STAGED_TREE_IDENTITY_DOMAIN, {
    artifactRootSha256: artifactRoot.rootSha256,
    dependencyRootSha256: dependencyRootObservation.rootSha256,
    expectedRevision: options.expectedRevision,
    interpreterRootSha256,
    manifestDigest: manifest.manifest.manifestDigest,
  });
  return {
    artifactRoot,
    dependencyRoot: dependencyRootObservation,
    interpreterRootSha256,
    manifestDigest: manifest.manifest.manifestDigest,
    stableIdentitySha256,
    stagedTreeIdentity,
  };
}

function immutableReceipt(
  observation: StageObservation,
  expectedRevision: string,
): RuntimeReleaseImmutableStagedTreeReceiptV1 {
  return {
    algorithm: 'sha256',
    assurance: 'immutable-staged-tree-observation-only',
    authority: {
      deployPermitted: false,
      installPermitted: false,
      launchPermitted: false,
      rollbackPermitted: false,
      startPermitted: false,
    },
    coverage: {
      artifacts: 'complete-manifest-artifact-root',
      dependencies: 'complete-staged-dependency-tree',
      durability: 'posix-directory-fsync-observed',
      interpreter: 'complete-declared-interpreter-artifact',
      launchConsumer: 'absent',
      mutationAfterReceipt: 'not-prevented',
      replayPrevention: 'absent-no-durable-consumption-store',
      stableIdentity: 'before-after-required',
    },
    domain: RUNTIME_RELEASE_IMMUTABLE_STAGED_TREE_RECEIPT_DOMAIN_V1,
    expectedRevision,
    roots: {
      artifactRootSha256: observation.artifactRoot.rootSha256,
      dependencyRootSha256: observation.dependencyRoot.rootSha256,
      interpreterRootSha256: observation.interpreterRootSha256,
    },
    schemaVersion: 1,
    stableIdentitySha256: observation.stableIdentitySha256,
    stagedTreeIdentity: observation.stagedTreeIdentity,
  };
}

export function observeRuntimeReleaseImmutableStagedTree(
  options: RuntimeReleaseImmutableStagedTreeOptions,
): ObserveRuntimeReleaseImmutableStagedTreeResult {
  try {
    const receipt = immutableReceipt(observeStage(options), options.expectedRevision);
    return {
      ok: true,
      canonicalJson: `${canonicalJson(receipt)}\n`,
      receipt,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function runtimeReleaseServiceInvocationDigest(
  executablePath: string,
  argv: readonly string[],
): string | null {
  try {
    if (!isAbsolute(executablePath) || !Array.isArray(argv) ||
      argv.length === 0 || argv.length > MAX_ARGUMENTS) return null;
    let bytes = 0;
    for (const argument of argv) {
      if (typeof argument !== 'string' || argument.includes('\0')) return null;
      bytes += Buffer.byteLength(argument, 'utf8');
      if (bytes > MAX_ARGUMENT_BYTES) return null;
    }
    return domainDigest(INVOCATION_DOMAIN, {
      argv: [...argv],
      executablePath,
    });
  } catch {
    return null;
  }
}

export function runtimeReleasePolicyId(policy: string | Buffer): string | null {
  try {
    const canonical = parseCanonicalJsonBytes(
      policy,
      MAX_POLICY_BYTES,
      'runtime release launch policy',
    );
    return `sha256:${domainBytesDigest(POLICY_CANONICAL_DOMAIN, canonical)}`;
  } catch {
    return null;
  }
}

export function runtimeReleaseEnvelopeCanonicalSha256(
  envelope: string | Buffer,
): string | null {
  const parsed = parseRuntimeReleaseEvidenceEnvelope(envelope);
  return parsed.ok
    ? domainBytesDigest(ENVELOPE_CANONICAL_DOMAIN, parsed.canonicalJson)
    : null;
}

export function runtimeReleaseTrustRootCanonicalSha256(
  trustRoot: string | Buffer,
): string | null {
  const parsed = parseRuntimeReleaseEvidenceTrustRoot(trustRoot);
  return parsed.ok
    ? domainBytesDigest(TRUST_ROOT_CANONICAL_DOMAIN, parsed.canonicalJson)
    : null;
}

export function revalidateRuntimeReleaseLaunch(
  options: RuntimeReleaseLaunchRevalidationOptions,
  dependencies: RuntimeReleaseLaunchRevalidationDependencies = {},
): RevalidateRuntimeReleaseLaunchResult {
  try {
    if (!KEY_ID_RE.test(options.expectedKeyId)) {
      return { ok: false, reason: 'runtime release expected key id is invalid' };
    }
    if (!POLICY_ID_RE.test(options.expectedPolicyId)) {
      return { ok: false, reason: 'runtime release expected policy id is invalid' };
    }
    const policyCanonicalJson = parseCanonicalJsonBytes(
      options.policy,
      MAX_POLICY_BYTES,
      'runtime release launch policy',
    );
    const policyId = runtimeReleasePolicyId(policyCanonicalJson);
    if (!policyId || policyId !== options.expectedPolicyId) {
      return { ok: false, reason: 'runtime release launch policy identity mismatch' };
    }
    if (!SHA256_RE.test(options.expectedStagedTreeIdentity)) {
      return { ok: false, reason: 'runtime release expected staged tree identity is invalid' };
    }
    const envelopeCanonicalSha256 =
      runtimeReleaseEnvelopeCanonicalSha256(options.envelope);
    if (!envelopeCanonicalSha256 || !equalDigest(
      envelopeCanonicalSha256,
      options.expectedEnvelopeCanonicalSha256,
    )) {
      return { ok: false, reason: 'runtime release evidence envelope identity mismatch' };
    }
    const trustRootCanonicalSha256 =
      runtimeReleaseTrustRootCanonicalSha256(options.trustRoot);
    if (!trustRootCanonicalSha256 || !equalDigest(
      trustRootCanonicalSha256,
      options.expectedTrustRootCanonicalSha256,
    )) {
      return { ok: false, reason: 'runtime release evidence trust root identity mismatch' };
    }
    const invocationDigest = runtimeReleaseServiceInvocationDigest(
      options.executablePath,
      options.argv,
    );
    if (!invocationDigest || !equalDigest(
      invocationDigest,
      options.expectedServiceInvocationDigest,
    )) {
      return { ok: false, reason: 'runtime release service invocation digest mismatch' };
    }
    const packageRoot = resolve(options.packageRoot);
    const interpreterPath = resolve(options.declaredInterpreterPath);
    if (options.executablePath !== interpreterPath ||
      options.argv[0] !== join(packageRoot, 'bin', 'ashlr')) {
      return { ok: false, reason: 'runtime release service invocation is not the staged launcher' };
    }
    const signedRelease = verifyRuntimeReleaseEvidenceEnvelope({
      envelope: options.envelope,
      manifest: options.manifest,
      trustRoot: options.trustRoot,
    }, dependencies);
    if (!signedRelease.ok) return signedRelease;
    if (signedRelease.keyId !== options.expectedKeyId) {
      return { ok: false, reason: 'runtime release signing key does not match expected key id' };
    }
    if (!equalDigest(signedRelease.manifestDigest, options.expectedManifestDigest)) {
      return { ok: false, reason: 'runtime release signed manifest does not match expected digest' };
    }
    if (signedRelease.expectedRevision !== options.expectedRevision) {
      return { ok: false, reason: 'runtime release signed revision does not match expected revision' };
    }

    const before = observeStage(options);
    if (!equalDigest(before.stagedTreeIdentity, options.expectedStagedTreeIdentity)) {
      return { ok: false, reason: 'runtime release staged tree identity does not match expected' };
    }
    const internal = options as RuntimeReleaseLaunchRevalidationOptions & {
      __testHooks?: RuntimeReleaseLaunchRevalidationTestHooks;
    };
    if (process.env['VITEST'] === 'true') {
      internal.__testHooks?.afterBeforeObservation?.();
    }
    const after = observeStage(options);
    if (!equalDigest(before.stagedTreeIdentity, after.stagedTreeIdentity) ||
      !equalDigest(before.stableIdentitySha256, after.stableIdentitySha256)) {
      return {
        ok: false,
        reason: 'runtime release staged tree identity changed during launch revalidation',
      };
    }
    const receipt: RuntimeReleaseLaunchRevalidationReceiptV1 = {
      algorithm: 'sha256',
      assurance: 'final-pre-exec-observation-only',
      authority: {
        deployPermitted: false,
        installPermitted: false,
        launchPermitted: false,
        rollbackPermitted: false,
        startPermitted: false,
      },
      coverage: {
        artifacts: 'complete-manifest-artifact-root',
        dependencies: 'complete-staged-dependency-tree',
        durability: 'posix-directory-fsync-observed',
        envelope: 'signed-release-observation-revalidated',
        interpreter: 'complete-declared-interpreter-artifact',
        invocation: 'exact-executable-and-argv-digest',
        launchConsumer: 'absent',
        mutationAfterReceipt: 'not-prevented',
        policy: 'caller-pinned-canonical-observation-only',
        replayPrevention: 'absent-no-durable-consumption-store',
        stableIdentity: 'before-after-equal',
      },
      domain: RUNTIME_RELEASE_LAUNCH_REVALIDATION_RECEIPT_DOMAIN_V1,
      expectedRevision: options.expectedRevision,
      invocation: {
        argumentCount: options.argv.length,
        executablePath: options.executablePath,
        serviceInvocationDigest: invocationDigest,
      },
      policy: {
        canonicalSha256: domainBytesDigest(POLICY_CANONICAL_DOMAIN, policyCanonicalJson),
        policyId,
        source: 'caller-pinned-unsigned',
      },
      release: {
        envelopeCanonicalSha256,
        expectedRevision: signedRelease.expectedRevision,
        expiresAt: signedRelease.expiresAt,
        issuedAt: signedRelease.issuedAt,
        keyId: signedRelease.keyId,
        manifestCanonicalSha256: domainBytesDigest(
          MANIFEST_CANONICAL_DOMAIN,
          options.manifest,
        ),
        manifestDigest: signedRelease.manifestDigest,
        rollbackTargetManifestDigest: signedRelease.rollbackTargetManifestDigest,
        trustRootCanonicalSha256,
      },
      roots: {
        artifactRootSha256: after.artifactRoot.rootSha256,
        dependencyRootSha256: after.dependencyRoot.rootSha256,
        interpreterRootSha256: after.interpreterRootSha256,
      },
      schemaVersion: 1,
      stableIdentity: {
        afterSha256: after.stableIdentitySha256,
        beforeSha256: before.stableIdentitySha256,
      },
      stagedTreeIdentity: after.stagedTreeIdentity,
    };
    return {
      ok: true,
      canonicalJson: `${canonicalJson(receipt)}\n`,
      receipt,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
