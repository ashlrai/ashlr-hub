import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import {
  requireBeforeRuntimeReleaseObservationDeadline,
  RuntimeReleaseObservationDeadlineExceededError,
  type RuntimeReleaseObservationDeadline,
} from './runtime-release-observation-deadline.js';

const MANIFEST_DIGEST_DOMAIN = 'ashlr:unsigned-runtime-release-manifest:v1';
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ARTIFACTS = 2_048;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_INTERPRETER_BYTES = 512 * 1024 * 1024;
const MAX_RELEASE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_TRAVERSAL_DEPTH = 32;
const MAX_DIRECTORY_ENTRIES = 1_024;
const MAX_DIRECTORIES = 512;
const MAX_JSON_NESTING_DEPTH = 128;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const NODE_VERSION_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1 = Object.freeze({
  schemaVersion: 1 as const,
  packageManifestPath: 'package.json' as const,
  lockfilePath: 'package-lock.json' as const,
  installedDependencyRootPath: 'node_modules' as const,
});

const PACKAGE_MANIFEST_PATH = RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1.packageManifestPath;
const LOCKFILE_PATH = RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1.lockfilePath;
const LAUNCHER_PATH = 'bin/ashlr';
const RUNTIME_ENTRY_PATH = 'dist/cli/index.js';
const VERIFIER_RUNNER_PATH = 'scripts/run-verify-command.mjs';
const FIXED_ARTIFACT_PATHS = new Set([
  PACKAGE_MANIFEST_PATH,
  LOCKFILE_PATH,
  LAUNCHER_PATH,
  VERIFIER_RUNNER_PATH,
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface UnsignedRuntimeReleaseArtifact {
  executable: boolean;
  path: string;
  sha256: string;
  size: number;
}

export interface UnsignedRuntimeReleaseManifest {
  algorithm: 'sha256';
  artifacts: UnsignedRuntimeReleaseArtifact[];
  assurance: 'unsigned-observation-only';
  coverage: {
    artifactCoherence: 'two-complete-scans';
    authenticity: 'unsigned';
    configuration: 'excluded';
    installedDependencies: 'lockfile-only';
    rollback: 'unresolved-caller-declared-reference';
    serviceInvocation: 'unbound';
  };
  entrypoints: {
    launcher: 'bin/ashlr';
    runtime: 'dist/cli/index.js';
    verifierRunner: 'scripts/run-verify-command.mjs';
  };
  expectedRevision: string;
  interpreterDeclaration: {
    source: 'caller-declared';
    kind: 'node';
    declaredPath: string;
    claimedVersion: string;
    observedArtifactSha256: string;
    observedResolvedPath: string;
  };
  lockfile: {
    lockfileVersion: number;
    path: 'package-lock.json';
    sha256: string;
  };
  manifestDigest: string;
  package: {
    binName: 'ashlr';
    manifestPath: 'package.json';
    name: string;
    sha256: string;
    version: string;
  };
  rollbackDeclaration: {
    resolution: 'unresolved';
    source: 'caller-declared';
    targetManifestDigest: string | null;
  };
  schemaVersion: 1;
}

export interface BuildUnsignedRuntimeReleaseManifestOptions {
  packageRoot: string;
  declaredInterpreterPath: string;
  declaredInterpreterVersion: string;
  expectedRevision: string;
  expectedPackageName?: string;
  declaredRollbackTargetDigest?: string | null;
}

export type BuildUnsignedRuntimeReleaseManifestResult =
  | {
    ok: true;
    manifest: UnsignedRuntimeReleaseManifest;
    canonicalJson: string;
  }
  | { ok: false; reason: string };

export type ParseUnsignedRuntimeReleaseManifestResult =
  | {
    ok: true;
    manifest: UnsignedRuntimeReleaseManifest;
    canonicalJson: string;
  }
  | { ok: false; reason: string };

export interface VerifyUnsignedRuntimeReleaseManifestOptions
  extends BuildUnsignedRuntimeReleaseManifestOptions {
  manifest: string | Buffer;
  expectedManifestDigest?: string;
}

export type VerifyUnsignedRuntimeReleaseManifestResult =
  | {
    ok: true;
    assurance: 'unsigned-observation-only';
    manifestDigest: string;
  }
  | { ok: false; reason: string };

interface FileSnapshot {
  bytes?: Buffer;
  executable: boolean;
  identity: string;
  sha256: string;
  size: number;
}

interface ReleaseSnapshot {
  artifacts: UnsignedRuntimeReleaseArtifact[];
  artifactIdentities: Array<{ identity: string; path: string }>;
  directories: Array<{ identity: string; path: string; realPath: string }>;
  interpreter: FileSnapshot & { path: string };
  lockfileVersion: number;
  packageName: string;
  packageVersion: string;
}

interface DiscoveryBudget {
  artifacts: number;
  directories: number;
  totalBytes: number;
}

interface ReleaseLayout {
  directories: Map<string, { identity: string; path: string; realPath: string }>;
  paths: string[];
}

interface RuntimeReleaseManifestTestHooks {
  afterFirstCompleteScan?: () => void;
  afterReleaseLayoutDiscovery?: (scan: 'first' | 'second') => void;
}

function manifestTestHooks(
  options: BuildUnsignedRuntimeReleaseManifestOptions | VerifyUnsignedRuntimeReleaseManifestOptions,
): RuntimeReleaseManifestTestHooks | undefined {
  if (process.env['VITEST'] !== 'true') return undefined;
  return (options as typeof options & { __testHooks?: RuntimeReleaseManifestTestHooks })
    .__testHooks;
}

function canonicalize(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  if (value === undefined) return undefined;
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
        const canonical = canonicalize(entry, ancestors);
        if (canonical === undefined) throw new TypeError('undefined JSON array entry');
        return canonical;
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('non-plain JSON object');
    }
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const canonical = canonicalize(entry, ancestors);
      if (canonical !== undefined) output[key] = canonical;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  const canonical = canonicalize(value, new Set<object>());
  if (canonical === undefined) throw new TypeError('undefined root JSON value');
  return JSON.stringify(canonical);
}

function manifestPayload(manifest: UnsignedRuntimeReleaseManifest): Omit<UnsignedRuntimeReleaseManifest, 'manifestDigest'> {
  const { manifestDigest: _manifestDigest, ...payload } = manifest;
  return payload;
}

function manifestDigest(payload: Omit<UnsignedRuntimeReleaseManifest, 'manifestDigest'>): string {
  return createHash('sha256')
    .update(MANIFEST_DIGEST_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\0\r\n]/.test(value);
}

function isReleasePath(value: unknown): value is string {
  if (!isBoundedText(value, 4_096) || value.includes('\\') || value.includes('\0')) return false;
  if (posix.isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    posix.normalize(value) === value;
}

function isCoveredArtifactPath(value: unknown): value is string {
  if (!isReleasePath(value)) return false;
  if (FIXED_ARTIFACT_PATHS.has(value)) return true;
  const segments = value.split('/');
  return segments[0] === 'dist' && segments.length >= 2 &&
    segments.length - 2 <= MAX_TRAVERSAL_DEPTH;
}

function isAbsoluteInterpreterPath(value: unknown): value is string {
  return isBoundedText(value, 16_384) &&
    (posix.isAbsolute(value) || win32.isAbsolute(value)) &&
    !value.includes('\0');
}

function isContained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
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

function snapshotRegularFile(
  filePath: string,
  options: {
    anchorPath?: string;
    captureBytes?: boolean;
    label?: string;
    maxBytes?: number;
  } = {},
  observation?: RuntimeReleaseObservationDeadline,
): FileSnapshot {
  requireBeforeRuntimeReleaseObservationDeadline(observation, options.label ?? 'release artifact');
  const absolutePath = resolve(filePath);
  const anchorPath = options.anchorPath ? realpathSync(options.anchorPath) : undefined;
  const label = options.label ?? 'release artifact';
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  const before = lstatSync(absolutePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds byte limit`);

  const realBefore = realpathSync(absolutePath);
  if (anchorPath && !isContained(anchorPath, realBefore)) {
    throw new Error('release artifact escapes package root');
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(absolutePath, fsConstants.O_RDONLY | noFollow);
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!openedBefore.isFile() || !sameIdentity(before, openedBefore)) {
      throw new Error('release artifact changed before read');
    }
    if (openedBefore.size > BigInt(maxBytes)) throw new Error(`${label} exceeds byte limit`);

    const expectedBytes = Number(openedBefore.size);
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead < expectedBytes) {
      requireBeforeRuntimeReleaseObservationDeadline(observation, label);
      const length = Math.min(READ_CHUNK_BYTES, expectedBytes - bytesRead);
      const chunk = Buffer.allocUnsafe(length);
      const count = readSync(fd, chunk, 0, length, bytesRead);
      if (count <= 0) throw new Error('release artifact changed during read');
      const bytes = count === length ? chunk : chunk.subarray(0, count);
      hash.update(bytes);
      if (options.captureBytes) chunks.push(bytes);
      bytesRead += count;
    }
    requireBeforeRuntimeReleaseObservationDeadline(observation, label);
    const growthProbe = Buffer.allocUnsafe(1);
    if (readSync(fd, growthProbe, 0, 1, expectedBytes) !== 0) {
      throw new Error('release artifact grew during read');
    }

    const openedAfter = fstatSync(fd, { bigint: true });
    const after = lstatSync(absolutePath, { bigint: true });
    requireBeforeRuntimeReleaseObservationDeadline(observation, label);
    if (!sameSnapshot(openedBefore, openedAfter) || !sameSnapshot(openedAfter, after) ||
      realpathSync(absolutePath) !== realBefore) {
      throw new Error('release artifact changed during read');
    }
    return {
      ...(options.captureBytes ? { bytes: Buffer.concat(chunks, bytesRead) } : {}),
      executable: process.platform !== 'win32' && (after.mode & 0o111n) !== 0n,
      identity: snapshotIdentity(after),
      sha256: hash.digest('hex'),
      size: bytesRead,
    };
  } finally {
    closeSync(fd);
  }
}

function canonicalPackageRoot(packageRoot: string): string {
  if (!isAbsolute(packageRoot)) throw new Error('package root must be absolute');
  const root = realpathSync(packageRoot);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('package root is not a regular directory');
  return root;
}

function directoryObservation(
  packageRoot: string,
  relativePath: string,
  observation?: RuntimeReleaseObservationDeadline,
): { identity: string; path: string; realPath: string } {
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
  const absolutePath = relativePath === '.' ? packageRoot : join(packageRoot, ...relativePath.split('/'));
  const stat = lstatSync(absolutePath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('release tree contains an unsafe directory');
  }
  const realPath = realpathSync(absolutePath);
  if ((relativePath === '.' && realPath !== packageRoot) ||
    (relativePath !== '.' && (!isContained(packageRoot, realPath) || resolve(absolutePath) !== realPath))) {
    throw new Error('release directory escapes package root');
  }
  return { identity: snapshotIdentity(stat), path: relativePath, realPath };
}

function admitArtifact(
  packageRoot: string,
  relativePath: string,
  budget: DiscoveryBudget,
  paths: string[],
  focusedLimit?: { label: string; maxBytes: number },
  observation?: RuntimeReleaseObservationDeadline,
): void {
  requireBeforeRuntimeReleaseObservationDeadline(
    observation,
    focusedLimit?.label ?? 'release artifact',
  );
  if (!isReleasePath(relativePath)) throw new Error('release artifact path is invalid');
  const absolutePath = join(packageRoot, ...relativePath.split('/'));
  const stat = lstatSync(absolutePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${focusedLimit?.label ?? 'release artifact'} is not a regular file`);
  }
  const maxBytes = focusedLimit?.maxBytes ?? MAX_ARTIFACT_BYTES;
  if (stat.size > BigInt(maxBytes)) {
    throw new Error(`${focusedLimit?.label ?? 'release artifact'} exceeds byte limit`);
  }
  budget.artifacts += 1;
  if (budget.artifacts > MAX_ARTIFACTS) throw new Error('release artifact count exceeds limit');
  budget.totalBytes += Number(stat.size);
  if (budget.totalBytes > MAX_RELEASE_BYTES) throw new Error('release artifacts exceed total byte limit');
  paths.push(relativePath);
}

function discoverReleaseLayout(
  packageRoot: string,
  observation?: RuntimeReleaseObservationDeadline,
): ReleaseLayout {
  const directories = new Map<string, { identity: string; path: string; realPath: string }>();
  const paths: string[] = [];
  const budget: DiscoveryBudget = { artifacts: 0, directories: 0, totalBytes: 0 };

  const observeDirectory = (relativePath: string): void => {
    if (!directories.has(relativePath)) {
      budget.directories += 1;
      if (budget.directories > MAX_DIRECTORIES) throw new Error('release directory count exceeds limit');
      directories.set(relativePath, directoryObservation(packageRoot, relativePath, observation));
    }
  };

  observeDirectory('.');
  observeDirectory('bin');
  observeDirectory('scripts');
  admitArtifact(packageRoot, PACKAGE_MANIFEST_PATH, budget, paths, {
    label: PACKAGE_MANIFEST_PATH,
    maxBytes: MAX_PACKAGE_MANIFEST_BYTES,
  }, observation);
  admitArtifact(packageRoot, LOCKFILE_PATH, budget, paths, {
    label: LOCKFILE_PATH,
    maxBytes: MAX_LOCKFILE_BYTES,
  }, observation);
  admitArtifact(packageRoot, LAUNCHER_PATH, budget, paths, undefined, observation);
  admitArtifact(packageRoot, VERIFIER_RUNNER_PATH, budget, paths, undefined, observation);

  const visitRuntime = (relativeDirectory: string, depth: number): void => {
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
    if (depth > MAX_TRAVERSAL_DEPTH) throw new Error('runtime traversal depth exceeds limit');
    observeDirectory(relativeDirectory);
    const before = directories.get(relativeDirectory)!;
    const absoluteDirectory = join(packageRoot, ...relativeDirectory.split('/'));
    const entries = [];
    const directory = opendirSync(absoluteDirectory);
    try {
      for (;;) {
        requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
        const entry = directory.readSync();
        if (entry === null) break;
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          throw new Error('runtime directory entry count exceeds limit');
        }
        entries.push(entry);
      }
    } finally {
      directory.closeSync();
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const absolutePath = join(packageRoot, ...relativePath.split('/'));
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new Error('runtime tree contains a symlink');
      if (stat.isDirectory()) visitRuntime(relativePath, depth + 1);
      else if (stat.isFile()) {
        admitArtifact(packageRoot, relativePath, budget, paths, undefined, observation);
      }
      else throw new Error('runtime tree contains a non-file entry');
    }
    const after = directoryObservation(packageRoot, relativeDirectory, observation);
    if (canonicalJson(before) !== canonicalJson(after)) {
      throw new Error('release directory changed during traversal');
    }
  };
  visitRuntime('dist', 0);
  if (!paths.includes(RUNTIME_ENTRY_PATH)) throw new Error('runtime entry dist/cli/index.js is missing');
  if (new Set(paths).size !== paths.length) throw new Error('release artifact paths are not unique');
  return { directories, paths: paths.sort() };
}

function scanJsonString(
  raw: string,
  cursor: { index: number },
  checkpoint: () => void,
): string {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < raw.length) {
    checkpoint();
    const char = raw[cursor.index]!;
    if (char === '\\') {
      cursor.index += 2;
      continue;
    }
    cursor.index += 1;
    if (char === '"') return JSON.parse(raw.slice(start, cursor.index)) as string;
  }
  throw new SyntaxError('unterminated JSON string');
}

function jsonHasDuplicateObjectKeys(
  raw: string,
  observation?: RuntimeReleaseObservationDeadline,
): boolean {
  const cursor = { index: 0 };
  let duplicate = false;
  let nextDeadlineCheck = 0;
  const checkpoint = (): void => {
    if (cursor.index < nextDeadlineCheck) return;
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release JSON');
    nextDeadlineCheck = cursor.index + 4_096;
  };
  const skipWhitespace = (): void => {
    while (/\s/u.test(raw[cursor.index] ?? '')) {
      checkpoint();
      cursor.index += 1;
    }
  };
  const scanValue = (depth: number): void => {
    checkpoint();
    if (depth > MAX_JSON_NESTING_DEPTH) throw new SyntaxError('JSON nesting depth exceeded');
    skipWhitespace();
    const char = raw[cursor.index];
    if (char === '"') {
      scanJsonString(raw, cursor, checkpoint);
      return;
    }
    if (char === '{') {
      cursor.index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[cursor.index] === '}') {
        cursor.index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (raw[cursor.index] !== '"') throw new SyntaxError('JSON object key expected');
        const key = scanJsonString(raw, cursor, checkpoint);
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        skipWhitespace();
        if (raw[cursor.index] !== ':') throw new SyntaxError('JSON object colon expected');
        cursor.index += 1;
        scanValue(depth + 1);
        skipWhitespace();
        if (raw[cursor.index] === '}') {
          cursor.index += 1;
          return;
        }
        if (raw[cursor.index] !== ',') throw new SyntaxError('JSON object separator expected');
        cursor.index += 1;
      }
    }
    if (char === '[') {
      cursor.index += 1;
      skipWhitespace();
      if (raw[cursor.index] === ']') {
        cursor.index += 1;
        return;
      }
      for (;;) {
        checkpoint();
        scanValue(depth + 1);
        skipWhitespace();
        if (raw[cursor.index] === ']') {
          cursor.index += 1;
          return;
        }
        if (raw[cursor.index] !== ',') throw new SyntaxError('JSON array separator expected');
        cursor.index += 1;
      }
    }
    const start = cursor.index;
    while (cursor.index < raw.length && !/[\s,}\]]/u.test(raw[cursor.index]!)) {
      checkpoint();
      cursor.index += 1;
    }
    if (cursor.index === start) throw new SyntaxError('JSON value expected');
  };
  scanValue(0);
  skipWhitespace();
  if (cursor.index !== raw.length) throw new SyntaxError('unexpected JSON transport bytes');
  return duplicate;
}

function parseJsonBytes(
  bytes: Buffer,
  label: string,
  observation?: RuntimeReleaseObservationDeadline,
): Record<string, unknown> {
  requireBeforeRuntimeReleaseObservationDeadline(observation, label);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not valid UTF-8`);
  let duplicateKeys: boolean;
  try {
    duplicateKeys = jsonHasDuplicateObjectKeys(text, observation);
  } catch (error) {
    if (error instanceof RuntimeReleaseObservationDeadlineExceededError) throw error;
    throw new Error(`${label} is not valid JSON`);
  }
  if (duplicateKeys) throw new Error(`${label} contains duplicate object keys`);
  let parsed: unknown;
  try {
    requireBeforeRuntimeReleaseObservationDeadline(observation, label);
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof RuntimeReleaseObservationDeadlineExceededError) throw error;
    throw new Error(`${label} is not valid JSON`);
  }
  requireBeforeRuntimeReleaseObservationDeadline(observation, label);
  if (!isPlainRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function packageIdentity(
  packageJson: Record<string, unknown>,
  expectedPackageName: string,
): { name: string; version: string } {
  if (packageJson['name'] !== expectedPackageName) throw new Error('package name does not match expected identity');
  if (!isBoundedText(packageJson['version'], 128)) throw new Error('package version is invalid');
  const bin = packageJson['bin'];
  if (!isPlainRecord(bin) || bin['ashlr'] !== LAUNCHER_PATH) {
    throw new Error('package launcher does not match bin/ashlr');
  }
  return { name: expectedPackageName, version: packageJson['version'] };
}

function lockfileIdentity(
  lockJson: Record<string, unknown>,
  expectedName: string,
  expectedVersion: string,
): number {
  const lockfileVersion = lockJson['lockfileVersion'];
  if (!Number.isSafeInteger(lockfileVersion) || (lockfileVersion as number) <= 0) {
    throw new Error('package lock version is invalid');
  }
  if (lockJson['name'] !== expectedName || lockJson['version'] !== expectedVersion) {
    throw new Error('package lock identity does not match package.json');
  }
  const packages = lockJson['packages'];
  const root = isPlainRecord(packages) ? packages[''] : undefined;
  if (!isPlainRecord(root) || root['name'] !== expectedName || root['version'] !== expectedVersion) {
    throw new Error('package lock root identity does not match package.json');
  }
  const bin = root['bin'];
  if (!isPlainRecord(bin) || bin['ashlr'] !== LAUNCHER_PATH) {
    throw new Error('package lock launcher does not match bin/ashlr');
  }
  return lockfileVersion as number;
}

function completeReleaseScan(
  packageRoot: string,
  expectedPackageName: string,
  interpreterPath: string,
  observation?: RuntimeReleaseObservationDeadline,
  afterLayoutDiscovery?: () => void,
): ReleaseSnapshot {
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
  const layout = discoverReleaseLayout(packageRoot, observation);
  afterLayoutDiscovery?.();
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest scan');
  const artifacts: UnsignedRuntimeReleaseArtifact[] = [];
  const artifactIdentities: Array<{ identity: string; path: string }> = [];
  let packageBytes: Buffer | undefined;
  let lockBytes: Buffer | undefined;
  let totalBytes = 0;
  for (const relativePath of layout.paths) {
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest scan');
    const focused = relativePath === PACKAGE_MANIFEST_PATH
      ? { label: PACKAGE_MANIFEST_PATH, maxBytes: MAX_PACKAGE_MANIFEST_BYTES }
      : relativePath === LOCKFILE_PATH
        ? { label: LOCKFILE_PATH, maxBytes: MAX_LOCKFILE_BYTES }
        : { label: 'release artifact', maxBytes: MAX_ARTIFACT_BYTES };
    const snapshot = snapshotRegularFile(join(packageRoot, ...relativePath.split('/')), {
      anchorPath: packageRoot,
      captureBytes: relativePath === PACKAGE_MANIFEST_PATH || relativePath === LOCKFILE_PATH,
      ...focused,
    }, observation);
    totalBytes += snapshot.size;
    if (totalBytes > MAX_RELEASE_BYTES) throw new Error('release artifacts exceed total byte limit');
    if (relativePath === PACKAGE_MANIFEST_PATH) packageBytes = snapshot.bytes;
    if (relativePath === LOCKFILE_PATH) lockBytes = snapshot.bytes;
    artifacts.push({
      executable: snapshot.executable,
      path: relativePath,
      sha256: snapshot.sha256,
      size: snapshot.size,
    });
    artifactIdentities.push({ identity: snapshot.identity, path: relativePath });
  }

  if (!packageBytes || !lockBytes) throw new Error('release package identity files are missing');
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest scan');
  const pkg = packageIdentity(
    parseJsonBytes(packageBytes, PACKAGE_MANIFEST_PATH, observation),
    expectedPackageName,
  );
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest scan');
  const lockfileVersion = lockfileIdentity(
    parseJsonBytes(lockBytes, LOCKFILE_PATH, observation),
    pkg.name,
    pkg.version,
  );
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest scan');
  const interpreter = snapshotRegularFile(interpreterPath, {
    label: 'declared interpreter artifact',
    maxBytes: MAX_INTERPRETER_BYTES,
  }, observation);
  const directories = [...layout.directories.values()]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const before of directories) {
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest scan');
    const after = directoryObservation(packageRoot, before.path, observation);
    if (canonicalJson(before) !== canonicalJson(after)) {
      throw new Error('release directory changed during complete scan');
    }
  }
  return {
    artifacts,
    artifactIdentities,
    directories,
    interpreter: { ...interpreter, path: interpreterPath },
    lockfileVersion,
    packageName: pkg.name,
    packageVersion: pkg.version,
  };
}

function coherentReleaseSnapshot(
  packageRoot: string,
  expectedPackageName: string,
  interpreterPath: string,
  afterFirstScan?: () => void,
  afterLayoutDiscovery?: (scan: 'first' | 'second') => void,
  observation?: RuntimeReleaseObservationDeadline,
): ReleaseSnapshot {
  // This rejects incoherent observations; it cannot prevent mutation after
  // return. Installation authority still requires immutable staged bytes.
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest first scan');
  const first = completeReleaseScan(
    packageRoot,
    expectedPackageName,
    interpreterPath,
    observation,
    () => afterLayoutDiscovery?.('first'),
  );
  afterFirstScan?.();
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest second scan');
  const second = completeReleaseScan(
    packageRoot,
    expectedPackageName,
    interpreterPath,
    observation,
    () => afterLayoutDiscovery?.('second'),
  );
  requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
  if (canonicalJson(first) !== canonicalJson(second)) {
    throw new Error('release changed between complete scans');
  }
  return second;
}

function artifactByPath(
  artifacts: readonly UnsignedRuntimeReleaseArtifact[],
  artifactPath: string,
): UnsignedRuntimeReleaseArtifact {
  const artifact = artifacts.find((candidate) => candidate.path === artifactPath);
  if (!artifact) throw new Error(`required release artifact is missing: ${artifactPath}`);
  return artifact;
}

function validateManifestShape(value: unknown): UnsignedRuntimeReleaseManifest {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'algorithm',
    'artifacts',
    'assurance',
    'coverage',
    'entrypoints',
    'expectedRevision',
    'interpreterDeclaration',
    'lockfile',
    'manifestDigest',
    'package',
    'rollbackDeclaration',
    'schemaVersion',
  ])) throw new Error('runtime release manifest has an invalid top-level shape');
  if (value['schemaVersion'] !== 1 || value['algorithm'] !== 'sha256' ||
    value['assurance'] !== 'unsigned-observation-only') {
    throw new Error('runtime release manifest has an unsupported schema');
  }
  if (typeof value['expectedRevision'] !== 'string' ||
    !REVISION_RE.test(value['expectedRevision'])) {
    throw new Error('runtime release manifest expected revision is invalid');
  }

  const coverage = value['coverage'];
  if (!isPlainRecord(coverage) || !hasExactKeys(coverage, [
    'artifactCoherence',
    'authenticity',
    'configuration',
    'installedDependencies',
    'rollback',
    'serviceInvocation',
  ]) ||
    coverage['artifactCoherence'] !== 'two-complete-scans' ||
    coverage['authenticity'] !== 'unsigned' ||
    coverage['configuration'] !== 'excluded' ||
    coverage['installedDependencies'] !== 'lockfile-only' ||
    coverage['rollback'] !== 'unresolved-caller-declared-reference' ||
    coverage['serviceInvocation'] !== 'unbound') {
    throw new Error('runtime release manifest coverage is invalid');
  }

  const entrypoints = value['entrypoints'];
  if (!isPlainRecord(entrypoints) ||
    !hasExactKeys(entrypoints, ['launcher', 'runtime', 'verifierRunner']) ||
    entrypoints['launcher'] !== LAUNCHER_PATH ||
    entrypoints['runtime'] !== RUNTIME_ENTRY_PATH ||
    entrypoints['verifierRunner'] !== VERIFIER_RUNNER_PATH) {
    throw new Error('runtime release manifest entrypoints are invalid');
  }

  const packageValue = value['package'];
  if (!isPlainRecord(packageValue) || !hasExactKeys(packageValue, [
    'binName', 'manifestPath', 'name', 'sha256', 'version',
  ]) || packageValue['binName'] !== 'ashlr' ||
    packageValue['manifestPath'] !== PACKAGE_MANIFEST_PATH ||
    !isBoundedText(packageValue['name'], 256) ||
    !isBoundedText(packageValue['version'], 128) ||
    typeof packageValue['sha256'] !== 'string' || !SHA256_RE.test(packageValue['sha256'])) {
    throw new Error('runtime release manifest package identity is invalid');
  }

  const lockfile = value['lockfile'];
  if (!isPlainRecord(lockfile) || !hasExactKeys(lockfile, ['lockfileVersion', 'path', 'sha256']) ||
    lockfile['path'] !== LOCKFILE_PATH ||
    !Number.isSafeInteger(lockfile['lockfileVersion']) || (lockfile['lockfileVersion'] as number) <= 0 ||
    typeof lockfile['sha256'] !== 'string' || !SHA256_RE.test(lockfile['sha256'])) {
    throw new Error('runtime release manifest lockfile identity is invalid');
  }

  const interpreter = value['interpreterDeclaration'];
  if (!isPlainRecord(interpreter) || !hasExactKeys(interpreter, [
    'claimedVersion',
    'declaredPath',
    'kind',
    'observedArtifactSha256',
    'observedResolvedPath',
    'source',
  ]) ||
    interpreter['source'] !== 'caller-declared' ||
    interpreter['kind'] !== 'node' ||
    !isAbsoluteInterpreterPath(interpreter['declaredPath']) ||
    !isAbsoluteInterpreterPath(interpreter['observedResolvedPath']) ||
    typeof interpreter['claimedVersion'] !== 'string' ||
    !NODE_VERSION_RE.test(interpreter['claimedVersion']) ||
    typeof interpreter['observedArtifactSha256'] !== 'string' ||
    !SHA256_RE.test(interpreter['observedArtifactSha256'])) {
    throw new Error('runtime release manifest interpreter declaration is invalid');
  }

  const artifactsValue = value['artifacts'];
  if (!Array.isArray(artifactsValue) || artifactsValue.length < 5 || artifactsValue.length > MAX_ARTIFACTS) {
    throw new Error('runtime release manifest artifact count is invalid');
  }
  const artifacts: UnsignedRuntimeReleaseArtifact[] = artifactsValue.map((entry) => {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ['executable', 'path', 'sha256', 'size']) ||
      typeof entry['executable'] !== 'boolean' || !isCoveredArtifactPath(entry['path']) ||
      typeof entry['sha256'] !== 'string' || !SHA256_RE.test(entry['sha256']) ||
      !Number.isSafeInteger(entry['size']) || (entry['size'] as number) < 0 ||
      (entry['size'] as number) > MAX_ARTIFACT_BYTES) {
      throw new Error('runtime release manifest contains an invalid artifact');
    }
    return {
      executable: entry['executable'],
      path: entry['path'],
      sha256: entry['sha256'],
      size: entry['size'] as number,
    };
  });
  const paths = artifacts.map((artifact) => artifact.path);
  if (new Set(paths).size !== paths.length || paths.some((entry, index) => index > 0 && entry <= paths[index - 1]!)) {
    throw new Error('runtime release manifest artifact paths must be unique and sorted');
  }
  if (artifacts.reduce((sum, artifact) => sum + artifact.size, 0) > MAX_RELEASE_BYTES) {
    throw new Error('runtime release manifest artifacts exceed total byte limit');
  }

  const packageArtifact = artifactByPath(artifacts, PACKAGE_MANIFEST_PATH);
  const lockArtifact = artifactByPath(artifacts, LOCKFILE_PATH);
  artifactByPath(artifacts, LAUNCHER_PATH);
  artifactByPath(artifacts, RUNTIME_ENTRY_PATH);
  artifactByPath(artifacts, VERIFIER_RUNNER_PATH);
  if (packageArtifact.sha256 !== packageValue['sha256'] ||
    lockArtifact.sha256 !== lockfile['sha256']) {
    throw new Error('runtime release manifest identity hash does not match its artifact');
  }
  if (packageArtifact.size > MAX_PACKAGE_MANIFEST_BYTES ||
    lockArtifact.size > MAX_LOCKFILE_BYTES) {
    throw new Error('runtime release manifest identity artifact exceeds focused byte limit');
  }

  const rollback = value['rollbackDeclaration'];
  if (!isPlainRecord(rollback) ||
    !hasExactKeys(rollback, ['resolution', 'source', 'targetManifestDigest']) ||
    rollback['resolution'] !== 'unresolved' ||
    rollback['source'] !== 'caller-declared' ||
    (rollback['targetManifestDigest'] !== null &&
      (typeof rollback['targetManifestDigest'] !== 'string' ||
        !SHA256_RE.test(rollback['targetManifestDigest'])))) {
    throw new Error('runtime release manifest rollback declaration is invalid');
  }
  const digest = value['manifestDigest'];
  if (typeof digest !== 'string' || !SHA256_RE.test(digest) ||
    (rollback['targetManifestDigest'] !== null && rollback['targetManifestDigest'] === digest)) {
    throw new Error('runtime release manifest digest is invalid');
  }

  return {
    algorithm: 'sha256',
    artifacts,
    assurance: 'unsigned-observation-only',
    coverage: {
      artifactCoherence: 'two-complete-scans',
      authenticity: 'unsigned',
      configuration: 'excluded',
      installedDependencies: 'lockfile-only',
      rollback: 'unresolved-caller-declared-reference',
      serviceInvocation: 'unbound',
    },
    entrypoints: {
      launcher: LAUNCHER_PATH,
      runtime: RUNTIME_ENTRY_PATH,
      verifierRunner: VERIFIER_RUNNER_PATH,
    },
    expectedRevision: value['expectedRevision'],
    interpreterDeclaration: {
      source: 'caller-declared',
      kind: 'node',
      declaredPath: interpreter['declaredPath'],
      claimedVersion: interpreter['claimedVersion'],
      observedArtifactSha256: interpreter['observedArtifactSha256'],
      observedResolvedPath: interpreter['observedResolvedPath'],
    },
    lockfile: {
      lockfileVersion: lockfile['lockfileVersion'] as number,
      path: LOCKFILE_PATH,
      sha256: lockfile['sha256'],
    },
    manifestDigest: digest,
    package: {
      binName: 'ashlr',
      manifestPath: PACKAGE_MANIFEST_PATH,
      name: packageValue['name'],
      sha256: packageValue['sha256'],
      version: packageValue['version'],
    },
    rollbackDeclaration: {
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest: rollback['targetManifestDigest'] as string | null,
    },
    schemaVersion: 1,
  };
}

export function buildUnsignedRuntimeReleaseManifest(
  options: BuildUnsignedRuntimeReleaseManifestOptions,
  observation?: RuntimeReleaseObservationDeadline,
): BuildUnsignedRuntimeReleaseManifestResult {
  try {
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
    const packageRoot = canonicalPackageRoot(options.packageRoot);
    const expectedPackageName = options.expectedPackageName ?? '@ashlr/hub';
    if (!isBoundedText(expectedPackageName, 256)) {
      return { ok: false, reason: 'expected package name is invalid' };
    }
    if (!REVISION_RE.test(options.expectedRevision)) {
      return { ok: false, reason: 'expected revision is invalid' };
    }
    const rollbackTargetDigest = options.declaredRollbackTargetDigest ?? null;
    if (rollbackTargetDigest !== null && !SHA256_RE.test(rollbackTargetDigest)) {
      return { ok: false, reason: 'declared rollback target digest is invalid' };
    }
    if (!isAbsoluteInterpreterPath(options.declaredInterpreterPath)) {
      return { ok: false, reason: 'declared interpreter path is invalid' };
    }
    const interpreterPath = realpathSync(options.declaredInterpreterPath);
    if (!isAbsoluteInterpreterPath(interpreterPath)) {
      return { ok: false, reason: 'resolved interpreter path is invalid' };
    }
    const interpreterVersion = options.declaredInterpreterVersion;
    if (!NODE_VERSION_RE.test(interpreterVersion)) {
      return { ok: false, reason: 'declared interpreter version is invalid' };
    }
    const testHooks = manifestTestHooks(options);
    const release = coherentReleaseSnapshot(
      packageRoot,
      expectedPackageName,
      interpreterPath,
      testHooks?.afterFirstCompleteScan,
      testHooks?.afterReleaseLayoutDiscovery,
      observation,
    );
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
    const packageArtifact = artifactByPath(release.artifacts, PACKAGE_MANIFEST_PATH);
    const lockArtifact = artifactByPath(release.artifacts, LOCKFILE_PATH);
    const payload: Omit<UnsignedRuntimeReleaseManifest, 'manifestDigest'> = {
      algorithm: 'sha256',
      artifacts: release.artifacts,
      assurance: 'unsigned-observation-only',
      coverage: {
        artifactCoherence: 'two-complete-scans',
        authenticity: 'unsigned',
        configuration: 'excluded',
        installedDependencies: 'lockfile-only',
        rollback: 'unresolved-caller-declared-reference',
        serviceInvocation: 'unbound',
      },
      entrypoints: {
        launcher: LAUNCHER_PATH,
        runtime: RUNTIME_ENTRY_PATH,
        verifierRunner: VERIFIER_RUNNER_PATH,
      },
      expectedRevision: options.expectedRevision,
      interpreterDeclaration: {
        source: 'caller-declared',
        kind: 'node',
        declaredPath: options.declaredInterpreterPath,
        claimedVersion: interpreterVersion,
        observedArtifactSha256: release.interpreter.sha256,
        observedResolvedPath: interpreterPath,
      },
      lockfile: {
        lockfileVersion: release.lockfileVersion,
        path: LOCKFILE_PATH,
        sha256: lockArtifact.sha256,
      },
      package: {
        binName: 'ashlr',
        manifestPath: PACKAGE_MANIFEST_PATH,
        name: release.packageName,
        sha256: packageArtifact.sha256,
        version: release.packageVersion,
      },
      rollbackDeclaration: {
        resolution: 'unresolved',
        source: 'caller-declared',
        targetManifestDigest: rollbackTargetDigest,
      },
      schemaVersion: 1,
    };
    const manifest: UnsignedRuntimeReleaseManifest = {
      ...payload,
      manifestDigest: manifestDigest(payload),
    };
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest');
    const encoded = `${canonicalJson(manifest)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_MANIFEST_BYTES) {
      return { ok: false, reason: 'generated runtime release manifest exceeds byte limit' };
    }
    return {
      ok: true,
      manifest,
      canonicalJson: encoded,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function parseUnsignedRuntimeReleaseManifest(
  input: string | Buffer,
): ParseUnsignedRuntimeReleaseManifestResult {
  try {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
      return { ok: false, reason: 'runtime release manifest byte length is invalid' };
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      return { ok: false, reason: 'runtime release manifest is not valid UTF-8' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'runtime release manifest is not valid JSON' };
    }
    const manifest = validateManifestShape(parsed);
    if (!equalDigest(manifest.manifestDigest, manifestDigest(manifestPayload(manifest)))) {
      return { ok: false, reason: 'runtime release manifest digest mismatch' };
    }
    const encoded = `${canonicalJson(manifest)}\n`;
    if (text !== encoded) {
      return { ok: false, reason: 'runtime release manifest encoding is not canonical' };
    }
    return { ok: true, manifest, canonicalJson: encoded };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function verifyUnsignedRuntimeReleaseManifest(
  options: VerifyUnsignedRuntimeReleaseManifestOptions,
  observation?: RuntimeReleaseObservationDeadline,
): VerifyUnsignedRuntimeReleaseManifestResult {
  try {
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest verification');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const parsed = parseUnsignedRuntimeReleaseManifest(options.manifest);
  if (!parsed.ok) return parsed;
  try {
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest verification');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (options.expectedManifestDigest !== undefined &&
    !equalDigest(parsed.manifest.manifestDigest, options.expectedManifestDigest)) {
    return { ok: false, reason: 'runtime release manifest does not match expected digest' };
  }
  const testHooks = manifestTestHooks(options);
  const rebuildOptions = {
    packageRoot: options.packageRoot,
    declaredInterpreterPath: options.declaredInterpreterPath,
    declaredInterpreterVersion: options.declaredInterpreterVersion,
    expectedRevision: options.expectedRevision,
    expectedPackageName: options.expectedPackageName,
    declaredRollbackTargetDigest: options.declaredRollbackTargetDigest,
    ...(testHooks ? { __testHooks: testHooks } : {}),
  } as BuildUnsignedRuntimeReleaseManifestOptions;
  const rebuilt = buildUnsignedRuntimeReleaseManifest(rebuildOptions, observation);
  if (!rebuilt.ok) return rebuilt;
  try {
    requireBeforeRuntimeReleaseObservationDeadline(observation, 'runtime release manifest verification');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (rebuilt.canonicalJson !== parsed.canonicalJson) {
    return { ok: false, reason: 'runtime release contents do not match manifest' };
  }
  return {
    ok: true,
    assurance: 'unsigned-observation-only',
    manifestDigest: parsed.manifest.manifestDigest,
  };
}
