import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  realpathSync,
  readSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The source lockfile selects the build-time runtime closure only. Published
 * releases carry bundled dependency bytes plus this inventory; admission never
 * expects the source lockfile to survive npm packaging.
 */

export const RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH =
  'dist/release-dependency-inventory.json' as const;
export const RUNTIME_RELEASE_DEPENDENCY_INVENTORY_SCHEMA_VERSION = 2 as const;

const INVENTORY_DIGEST_DOMAIN = 'ashlr:runtime-release-dependency-inventory:v2';
const PACKAGE_CONTENT_DIGEST_DOMAIN = 'ashlr:runtime-release-dependency-package-content:v1';
const PACKAGE_ARCHIVE_MODE_DIGEST_DOMAIN = 'ashlr:runtime-release-dependency-archive-mode:v1';
export const RUNTIME_RELEASE_INSTALLED_DEPENDENCY_TREE_DIGEST_DOMAIN_V2 =
  'ashlr:runtime-release-installed-dependency-tree:v2' as const;
const MAX_INVENTORY_BYTES = 512 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_PACKAGES = 512;
const MAX_FILES_PER_PACKAGE = 20_000;
const MAX_TOTAL_FILES = 100_000;
const MAX_TOTAL_DIRECTORIES = 20_000;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 48;
const MAX_BUILD_OBSERVATION_MS = 120_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/i;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RuntimeReleaseDependencyInventoryPackageV1 {
  archiveModeSha256: string;
  contentSha256: string;
  fileCount: number;
  name: string;
  path: string;
  size: number;
  version: string;
}

export interface RuntimeReleaseDependencyInventoryV2 {
  algorithm: 'sha256';
  assurance: 'packaged-build-byte-observation';
  inventoryDigest: string;
  package: {
    manifestSha256: string;
    name: string;
    version: string;
  };
  packages: RuntimeReleaseDependencyInventoryPackageV1[];
  portability: 'platform-independent-no-native-or-install-variance';
  rootDependencies: Array<{
    name: string;
    requested: string;
  }>;
  schemaVersion: typeof RUNTIME_RELEASE_DEPENDENCY_INVENTORY_SCHEMA_VERSION;
}

export type BuildRuntimeReleaseDependencyInventoryResult =
  | { ok: true; inventory: RuntimeReleaseDependencyInventoryV2; canonicalJson: string }
  | { ok: false; reason: string };

export type ParseRuntimeReleaseDependencyInventoryResult =
  | { ok: true; inventory: RuntimeReleaseDependencyInventoryV2; canonicalJson: string }
  | { ok: false; reason: string };

export type ObserveInstalledRuntimeDependenciesResult =
  | {
    ok: true;
    inventoryDigest: string;
    installedTreeSha256: string;
    packageCount: number;
  }
  | { ok: false; reason: string };

export interface BuildRuntimeReleaseDependencyInventoryOptions {
  /** Exact root npm-pack file report; omitted only for already-normalized fixtures. */
  packagedFiles?: readonly RuntimeReleasePackFileRecord[];
}

export interface RuntimeReleasePackFileRecord {
  mode: number;
  path: string;
  size: number;
}

interface PackageSnapshot {
  archiveModeSha256: string;
  contentSha256: string;
  declaredBinTargets: ReadonlyMap<string, string>;
  fileCount: number;
  identitySha256: string;
  name: string;
  size: number;
  version: string;
}

interface DependencyFileContent {
  executable: boolean;
  path: string;
  sha256: string;
  size: number;
}

interface PackageFileContent {
  path: string;
  sha256: string;
  size: number;
}

interface DependencyBinLinkContent {
  linkTarget: string;
  path: string;
  symlink: true;
}

export type RuntimeDependencyBinLinkOwnership =
  | { kind: 'top-level'; targetPackagePath: string }
  | { kind: 'nested'; ownerPackagePath: string; targetPackagePath: string };

type DependencyObservationCheckpoint = (phase?: string) => void;

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isBoundedText(value: unknown, max = 4_096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\0\r\n]/u.test(value);
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function inventoryPayload(
  inventory: RuntimeReleaseDependencyInventoryV2,
): Omit<RuntimeReleaseDependencyInventoryV2, 'inventoryDigest'> {
  const { inventoryDigest: _inventoryDigest, ...payload } = inventory;
  return payload;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function requireSafePortableMode(stat: BigIntStats, label: string, directory = false): void {
  if (process.platform === 'win32') return;
  if ((stat.mode & 0o7000n) !== 0n || (stat.mode & 0o400n) === 0n ||
    (directory && (stat.mode & 0o100n) === 0n)) {
    throw new Error(`${label} has an unsafe mode`);
  }
}

function stableFileBytes(
  path: string,
  label: string,
  maxBytes: number,
  checkpoint: DependencyObservationCheckpoint = () => {},
): Buffer {
  checkpoint();
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (before.nlink !== 1n) throw new Error(`${label} has multiple hard links`);
  requireSafePortableMode(before, label);
  if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds byte limit`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!openedBefore.isFile() || openedBefore.dev !== before.dev || openedBefore.ino !== before.ino) {
      throw new Error(`${label} changed before read`);
    }
    if (openedBefore.nlink !== 1n) throw new Error(`${label} has multiple hard links`);
    requireSafePortableMode(openedBefore, label);
    const expectedBytes = Number(openedBefore.size);
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      checkpoint();
      const count = readSync(fd, bytes, offset, expectedBytes - offset, offset);
      if (count <= 0) throw new Error(`${label} changed during read`);
      offset += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (readSync(fd, growthProbe, 0, 1, expectedBytes) !== 0) {
      throw new Error(`${label} grew during read`);
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (!sameSnapshot(openedBefore, openedAfter) || !sameSnapshot(openedAfter, after)) {
      throw new Error(`${label} changed during read`);
    }
    if (openedAfter.nlink !== 1n || after.nlink !== 1n) {
      throw new Error(`${label} has multiple hard links`);
    }
    requireSafePortableMode(openedAfter, label);
    requireSafePortableMode(after, label);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not valid UTF-8`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function canonicalRoot(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const resolved = resolve(path);
  const real = realpathSync(resolved);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) {
    throw new Error(`${label} is not a canonical directory`);
  }
  return real;
}

function isContained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

export function runtimeDependencyBinLinkOwnership(
  logicalPath: string,
  targetLogicalPath: string,
): RuntimeDependencyBinLinkOwnership | null {
  const linkSegments = logicalPath.split('/');
  const linkName = linkSegments.at(-1);
  if (!isBoundedText(linkName, 256) || !/^[A-Za-z0-9._~-]+$/u.test(linkName) ||
    linkName === '.' || linkName === '..') return null;
  const immediateTargetPackage = (prefix: string): string | null => {
    if (!targetLogicalPath.startsWith(prefix)) return null;
    const targetSegments = targetLogicalPath.slice(prefix.length).split('/');
    const packageSegmentCount = targetSegments[0]?.startsWith('@') ? 2 : 1;
    const remainder = targetSegments.slice(packageSegmentCount);
    if (targetSegments.length <= packageSegmentCount || remainder.includes('node_modules') ||
      targetSegments.slice(0, packageSegmentCount).some((segment) =>
        !segment || segment === '.' || segment === '..' || segment === 'node_modules')) return null;
    const targetPackagePath = `${prefix}${targetSegments.slice(0, packageSegmentCount).join('/')}`;
    try {
      return packagePathFromLockPath(`node_modules/${targetPackagePath}`) === targetPackagePath
        ? targetPackagePath
        : null;
    } catch {
      return null;
    }
  };
  if (linkSegments.length === 2 && linkSegments[0] === '.bin') {
    const targetPackagePath = immediateTargetPackage('');
    return targetPackagePath ? { kind: 'top-level', targetPackagePath } : null;
  }
  if (linkSegments.length < 4 || linkSegments.at(-2) !== '.bin' ||
    linkSegments.at(-3) !== 'node_modules') return null;
  const ownerPackagePath = linkSegments.slice(0, -3).join('/');
  try {
    if (packagePathFromLockPath(`node_modules/${ownerPackagePath}`) !== ownerPackagePath) return null;
  } catch {
    return null;
  }
  const nestedPrefix = `${ownerPackagePath}/node_modules/`;
  const targetPackagePath = immediateTargetPackage(nestedPrefix);
  if (!targetPackagePath) return null;
  return { kind: 'nested', ownerPackagePath, targetPackagePath };
}

function observeDependencyBinLink(
  dependencyRoot: string,
  path: string,
  logicalPath: string,
  admittedPackageBins: ReadonlyMap<string, ReadonlyMap<string, string>>,
): DependencyBinLinkContent {
  if (process.platform === 'win32') {
    throw new Error('installed dependency tree contains an unexpected symlink');
  }
  const before = lstatSync(path, { bigint: true });
  if (!before.isSymbolicLink()) throw new Error('installed dependency bin link changed before read');
  const linkTarget = readlinkSync(path, 'utf8');
  if (!isBoundedText(linkTarget) || isAbsolute(linkTarget) || /^[A-Za-z]:[\\/]/u.test(linkTarget) ||
    linkTarget.includes('\0') || linkTarget.includes('\\')) {
    throw new Error('installed dependency bin link target is invalid');
  }
  const targetPath = resolve(dirname(path), linkTarget);
  const targetRealPath = realpathSync(targetPath);
  if (!isContained(dependencyRoot, targetRealPath) || targetRealPath !== targetPath) {
    throw new Error('installed dependency bin link escapes dependency root');
  }
  const targetLogicalPath = relative(dependencyRoot, targetPath).split(sep).join('/');
  const ownership = runtimeDependencyBinLinkOwnership(logicalPath, targetLogicalPath);
  if (!ownership) throw new Error('installed dependency tree contains an unexpected symlink');
  if ((ownership.kind === 'nested' && !admittedPackageBins.has(ownership.ownerPackagePath)) ||
    !admittedPackageBins.has(ownership.targetPackagePath)) {
    throw new Error('installed dependency bin link is not owned by an admitted nested dependency');
  }
  const command = logicalPath.slice(logicalPath.lastIndexOf('/') + 1);
  const declaredTarget = admittedPackageBins.get(ownership.targetPackagePath)?.get(command);
  if (!declaredTarget || targetLogicalPath !== `${ownership.targetPackagePath}/${declaredTarget}`) {
    throw new Error('installed dependency bin link does not match declared package bin');
  }
  const target = lstatSync(targetPath, { bigint: true });
  if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n) {
    throw new Error('installed dependency bin link target is unsafe');
  }
  requireSafePortableMode(target, 'installed dependency bin link target');
  const after = lstatSync(path, { bigint: true });
  if (!sameSnapshot(before, after) || readlinkSync(path, 'utf8') !== linkTarget) {
    throw new Error('installed dependency bin link changed during read');
  }
  return { linkTarget, path: logicalPath, symlink: true };
}

function packagePathFromLockPath(value: string): string {
  if (!value.startsWith('node_modules/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('runtime dependency lock path is invalid');
  }
  const path = value.slice('node_modules/'.length);
  const segments = path.split('/');
  for (let index = 0; index < segments.length;) {
    const first = segments[index];
    if (!first || first === '.' || first === '..' || first === 'node_modules') {
      throw new Error('runtime dependency lock path is invalid');
    }
    index += first.startsWith('@') ? 2 : 1;
    if (index > segments.length || (first.startsWith('@') && !segments[index - 1])) {
      throw new Error('runtime dependency lock path is invalid');
    }
    if (index === segments.length) break;
    if (segments[index] !== 'node_modules') throw new Error('runtime dependency lock path is invalid');
    index += 1;
  }
  return path;
}

export function runtimeDependencyPackageNameFromPath(path: string): string {
  const segments = path.split('/');
  const marker = segments.lastIndexOf('node_modules');
  const start = marker < 0 ? 0 : marker + 1;
  const first = segments[start]!;
  return first.startsWith('@') ? `${first}/${segments[start + 1] ?? ''}` : first;
}

function packageIsPortable(packageJson: Record<string, unknown>, files: string[], label: string): void {
  for (const field of ['os', 'cpu', 'libc', 'optionalDependencies']) {
    const value = packageJson[field];
    if (value !== undefined && (!isPlainRecord(value) || Object.keys(value).length > 0)) {
      throw new Error(`${label} has platform-variant metadata`);
    }
  }
  const scripts = packageJson['scripts'];
  if (isPlainRecord(scripts) && ['preinstall', 'install', 'postinstall'].some((name) =>
    typeof scripts[name] === 'string')) {
    throw new Error(`${label} has an install lifecycle script`);
  }
  if (packageJson['gypfile'] === true || files.some((path) => path.toLowerCase().endsWith('.node'))) {
    throw new Error(`${label} contains native install variance`);
  }
}

function portablePackageBinTargets(
  packageJson: Record<string, unknown>,
  label: string,
): ReadonlyMap<string, string> {
  const declared = packageJson['bin'];
  if (declared === undefined) return new Map();
  const packageName = packageJson['name'];
  const entries: Array<[string, unknown]> = typeof declared === 'string' &&
    typeof packageName === 'string'
    ? [[packageName.slice(packageName.lastIndexOf('/') + 1), declared]]
    : isPlainRecord(declared)
      ? Object.entries(declared)
      : [];
  if (entries.length === 0 || entries.some(([command, value]) =>
    !isBoundedText(command, 256) || !/^[A-Za-z0-9._~-]+$/u.test(command) ||
    typeof value !== 'string')) {
    throw new Error(`${label} bin declaration is invalid`);
  }
  const targets = entries.map(([command, value]) =>
    [command, (value as string).replace(/^\.\//u, '')] as const);
  if (targets.some(([, path]) => !isBoundedText(path) || path.includes('\\') || isAbsolute(path) ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..'))) {
    throw new Error(`${label} bin declaration is invalid`);
  }
  return new Map(targets);
}

export function runtimeDependencyDeclaredBinTarget(
  packageJson: Record<string, unknown>,
  expectedName: string,
  command: string,
): string | null {
  if (packageJson['name'] !== expectedName) return null;
  try {
    return portablePackageBinTargets(packageJson, `runtime dependency ${expectedName}`).get(command) ?? null;
  } catch {
    return null;
  }
}

function portablePackageBinPaths(packageJson: Record<string, unknown>, label: string): Set<string> {
  return new Set(portablePackageBinTargets(packageJson, label).values());
}

function rootPackageIsPortable(
  packageJson: Record<string, unknown>,
  packagedFiles: readonly string[],
): void {
  const declaredFiles = packageJson['files'];
  const allowedFiles = new Set([
    'CHANGELOG.md',
    'bin',
    'dist',
    'docs/ELITE-AGENT-EFFICIENCY.md',
    'docs/MISSION-OS.md',
    'docs/RUNTIME_ACTIVATION_AUTHORITY.md',
    'docs/contracts/CONTRACT-M515.md',
    'docs/contracts/CONTRACT-M521.md',
    'docs/contracts/CONTRACT-M568.md',
    'docs/contracts/CONTRACT-MISSION-RECEIPT-V1.md',
    'schema',
    'scripts/run-verify-command.mjs',
    'scripts/scorecard-history-worker.mjs',
  ]);
  const requiredFiles = [
    'bin',
    'dist',
    'scripts/run-verify-command.mjs',
  ];
  if (!Array.isArray(declaredFiles) || declaredFiles.length === 0 ||
    declaredFiles.some((entry) => typeof entry !== 'string' || !allowedFiles.has(entry)) ||
    new Set(declaredFiles).size !== declaredFiles.length ||
    requiredFiles.some((entry) => !declaredFiles.includes(entry))) {
    throw new Error('release package files declaration is not portable');
  }
  packageIsPortable(packageJson, [...packagedFiles], 'release package');
}

export function assertRuntimeReleaseRootPackagePortability(
  packageJson: Record<string, unknown>,
  packagedFiles: readonly string[],
  inventory: RuntimeReleaseDependencyInventoryV2,
): void {
  if (inventory.portability !== 'platform-independent-no-native-or-install-variance') {
    throw new Error('runtime dependency inventory portability contract is unsupported');
  }
  rootPackageIsPortable(packageJson, packagedFiles);
}

function scanPackageDirectory(
  packageRoot: string,
  expectedName: string,
  expectedVersion: string,
  checkpoint: DependencyObservationCheckpoint = () => {},
  includedFiles?: ReadonlyMap<string, RuntimeReleasePackFileRecord>,
): PackageSnapshot {
  checkpoint();
  const root = canonicalRoot(packageRoot, `runtime dependency ${expectedName}`);
  const rootBefore = lstatSync(root, { bigint: true });
  requireSafePortableMode(rootBefore, `runtime dependency ${expectedName}`, true);
  const files: PackageFileContent[] = [];
  const hostExecutablePaths = new Set<string>();
  const identities: Array<{ path: string; identity: string }> = [];
  let directoryCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  let packageJsonBytes: Buffer | undefined;
  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    checkpoint();
    if (depth > MAX_DEPTH) throw new Error('runtime dependency traversal depth exceeds limit');
    directoryCount += 1;
    if (directoryCount > MAX_TOTAL_DIRECTORIES) {
      throw new Error('runtime dependency directory count exceeds limit');
    }
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('runtime dependency tree contains an unsafe directory');
    }
    requireSafePortableMode(before, 'runtime dependency directory', true);
    const entries = [];
    const handle = opendirSync(directory);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        entries.push(entry);
        entryCount += 1;
        if (entries.length > MAX_DIRECTORY_ENTRIES || entryCount > MAX_TOTAL_FILES) {
          throw new Error('runtime dependency tree entry count exceeds limit');
        }
      }
    } finally {
      handle.closeSync();
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      checkpoint();
      if (entry.name === 'node_modules') continue;
      const absolute = join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stat = lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error('runtime dependency tree contains a symlink');
      if (stat.isDirectory()) {
        requireSafePortableMode(stat, 'runtime dependency directory', true);
        visit(absolute, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new Error('runtime dependency tree contains a non-file entry');
      const packagedFile = includedFiles?.get(relativePath);
      if (includedFiles && !packagedFile) continue;
      const maxBytes = relativePath === 'package.json'
        ? MAX_PACKAGE_JSON_BYTES
        : MAX_FILE_BYTES;
      if (stat.size > BigInt(maxBytes)) throw new Error('runtime dependency file exceeds byte limit');
      if (files.length >= MAX_FILES_PER_PACKAGE) {
        throw new Error('runtime dependency package file count exceeds limit');
      }
      const bytes = stableFileBytes(
        absolute,
        'runtime dependency file',
        maxBytes,
        checkpoint,
      );
      if (relativePath === 'package.json') packageJsonBytes = Buffer.from(bytes);
      if (packagedFile && packagedFile.size !== bytes.length) {
        throw new Error(`runtime dependency ${expectedName} npm pack size does not match source bytes`);
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('runtime dependency package bytes exceed limit');
      files.push({
        path: relativePath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
      if ((stat.mode & 0o111n) !== 0n) hostExecutablePaths.add(relativePath);
      identities.push({
        path: relativePath,
        identity: [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs]
          .map(String).join(':'),
      });
    }
    const after = lstatSync(directory, { bigint: true });
    if (!sameSnapshot(before, after)) throw new Error('runtime dependency directory changed during scan');
  };
  visit(root, '', 0);
  if (includedFiles && canonicalJson(files.map((entry) => entry.path).sort()) !==
    canonicalJson([...includedFiles.keys()].sort())) {
    throw new Error(`runtime dependency ${expectedName} packaged file set is unavailable`);
  }
  checkpoint('after-package-traversal');
  if (!packageJsonBytes) {
    throw new Error(`runtime dependency ${expectedName} package.json is unavailable`);
  }
  const packageJson = parseJsonObject(packageJsonBytes, `${expectedName} package.json`);
  if (packageJson['name'] !== expectedName || packageJson['version'] !== expectedVersion) {
    throw new Error(`runtime dependency ${expectedName} identity does not match inventory`);
  }
  const binPaths = portablePackageBinPaths(packageJson, `runtime dependency ${expectedName}`);
  const declaredBinTargets = portablePackageBinTargets(
    packageJson,
    `runtime dependency ${expectedName}`,
  );
  const filePaths = new Set(files.map((entry) => entry.path));
  if ([...binPaths].some((path) => !filePaths.has(path))) {
    throw new Error(`runtime dependency ${expectedName} bin target is not packaged`);
  }
  const archiveModes = files.map((file) => ({
    mode: includedFiles?.get(file.path)?.mode ??
      (process.platform === 'win32'
        ? (binPaths.has(file.path) ? 0o755 : 0o644)
        : (hostExecutablePaths.has(file.path) ? 0o755 : 0o644)),
    path: file.path,
  }));
  packageIsPortable(packageJson, files.map((entry) => entry.path), `runtime dependency ${expectedName}`);
  const rootAfter = lstatSync(root, { bigint: true });
  if (!sameSnapshot(rootBefore, rootAfter) || realpathSync(root) !== root) {
    throw new Error(`runtime dependency ${expectedName} root changed during scan`);
  }
  return {
    archiveModeSha256: digest(PACKAGE_ARCHIVE_MODE_DIGEST_DOMAIN, archiveModes),
    contentSha256: digest(PACKAGE_CONTENT_DIGEST_DOMAIN, files),
    declaredBinTargets,
    fileCount: files.length,
    identitySha256: digest(PACKAGE_CONTENT_DIGEST_DOMAIN, identities),
    name: expectedName,
    size: totalBytes,
    version: expectedVersion,
  };
}

function rootDependencyEntries(packageJson: Record<string, unknown>): Array<{ name: string; requested: string }> {
  const dependencies = packageJson['dependencies'];
  if (dependencies === undefined) return [];
  if (!isPlainRecord(dependencies)) throw new Error('package dependencies are invalid');
  const output = Object.entries(dependencies).map(([name, requested]) => {
    if (!PACKAGE_NAME_RE.test(name) || !isBoundedText(requested, 512)) {
      throw new Error('package dependency declaration is invalid');
    }
    return { name, requested };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const bundled = packageJson['bundledDependencies'] ?? packageJson['bundleDependencies'];
  if (!Array.isArray(bundled) || bundled.some((name) => typeof name !== 'string')) {
    throw new Error('package bundled dependencies are missing or invalid');
  }
  const bundledNames = [...bundled].sort();
  if (canonicalJson(bundledNames) !== canonicalJson(output.map((entry) => entry.name))) {
    throw new Error('package bundled dependencies do not match runtime dependencies');
  }
  return output;
}

function normalizePackagedFiles(
  packagedFiles: readonly RuntimeReleasePackFileRecord[] | undefined,
): readonly RuntimeReleasePackFileRecord[] | undefined {
  if (!packagedFiles) return undefined;
  const output: RuntimeReleasePackFileRecord[] = [];
  const seen = new Set<string>();
  for (const value of packagedFiles as readonly unknown[]) {
    if (!isPlainRecord(value) || !hasExactKeys(value, ['mode', 'path', 'size'])) {
      throw new Error('npm pack file report is invalid');
    }
    const path = value['path'];
    const size = value['size'];
    const mode = value['mode'];
    if (!isBoundedText(path) || path.includes('\\') || path.startsWith('/') ||
      path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
      !Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > MAX_FILE_BYTES ||
      !Number.isSafeInteger(mode) || (mode !== 0o644 && mode !== 0o755) ||
      seen.has(path)) {
      throw new Error('npm pack file report is invalid');
    }
    output.push({ mode: mode as number, path, size: size as number });
    seen.add(path);
  }
  return output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function partitionPackagedFiles(
  lockPaths: readonly string[],
  packagedFiles: readonly RuntimeReleasePackFileRecord[] | undefined,
): Map<string, Map<string, RuntimeReleasePackFileRecord>> | undefined {
  if (!packagedFiles) return undefined;
  const output = new Map(lockPaths.map((path) => [path, new Map<string, RuntimeReleasePackFileRecord>()]));
  const packagePrefixes = lockPaths
    .map((path) => ({ path, prefix: `node_modules/${path}/` }))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  for (const packagedFile of packagedFiles) {
    const { path } = packagedFile;
    if (!path.startsWith('node_modules/')) continue;
    const owner = packagePrefixes.find((entry) => path.startsWith(entry.prefix));
    if (!owner) throw new Error('npm pack contains a runtime dependency outside the lock closure');
    const relativePath = path.slice(owner.prefix.length);
    if (!relativePath || relativePath.split('/').some((segment) =>
      !segment || segment === '.' || segment === '..')) {
      throw new Error('npm pack dependency file path is invalid');
    }
    output.get(owner.path)!.set(relativePath, packagedFile);
  }
  for (const [path, files] of output) {
    if (!files.has('package.json')) {
      throw new Error(`npm pack omitted runtime dependency package.json: ${path}`);
    }
  }
  return output;
}

function buildInventory(
  packageRootInput: string,
  options: BuildRuntimeReleaseDependencyInventoryOptions,
): RuntimeReleaseDependencyInventoryV2 {
  const deadline = process.hrtime.bigint() + BigInt(MAX_BUILD_OBSERVATION_MS) * 1_000_000n;
  const checkpoint = (): void => {
    if (process.hrtime.bigint() > deadline) {
      throw new Error('runtime dependency inventory build exceeded deadline');
    }
  };
  checkpoint();
  const packageRoot = canonicalRoot(packageRootInput, 'release package root');
  const packageJsonBytes = stableFileBytes(
    join(packageRoot, 'package.json'),
    'package.json',
    MAX_PACKAGE_JSON_BYTES,
  );
  const packageJson = parseJsonObject(packageJsonBytes, 'package.json');
  const name = packageJson['name'];
  const version = packageJson['version'];
  if (!isBoundedText(name, 256) || !PACKAGE_NAME_RE.test(name) || !isBoundedText(version, 128)) {
    throw new Error('release package identity is invalid');
  }
  const rootDependencies = rootDependencyEntries(packageJson);
  const packagedFiles = normalizePackagedFiles(options.packagedFiles);
  rootPackageIsPortable(
    packageJson,
    (packagedFiles ?? [])
      .map((entry) => entry.path)
      .filter((path) => !path.startsWith('node_modules/')),
  );
  const lock = parseJsonObject(
    stableFileBytes(join(packageRoot, 'package-lock.json'), 'package-lock.json', MAX_LOCKFILE_BYTES),
    'package-lock.json',
  );
  if (lock['name'] !== name || lock['version'] !== version || lock['lockfileVersion'] !== 3) {
    throw new Error('package lock identity is invalid');
  }
  const lockPackages = lock['packages'];
  if (!isPlainRecord(lockPackages)) throw new Error('package lock packages are invalid');
  const rootLock = lockPackages[''];
  if (!isPlainRecord(rootLock) || rootLock['name'] !== name || rootLock['version'] !== version) {
    throw new Error('package lock root identity is invalid');
  }
  if (canonicalJson(rootLock['dependencies'] ?? {}) !==
    canonicalJson(Object.fromEntries(rootDependencies.map((entry) => [entry.name, entry.requested])))) {
    throw new Error('package lock root dependencies do not match package.json');
  }
  const runtimeLockEntries = Object.entries(lockPackages)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const runtimeEntries: Array<[string, Record<string, unknown>]> = [];
  for (const [lockPath, metadata] of runtimeLockEntries) {
    if (lockPath === '') continue;
    if (!isPlainRecord(metadata)) throw new Error('runtime dependency lock metadata is invalid');
    if (metadata['dev'] === true) continue;
    runtimeEntries.push([lockPath, metadata]);
  }
  const packagedFilesByPath = partitionPackagedFiles(
    runtimeEntries.map(([lockPath]) => packagePathFromLockPath(lockPath)),
    packagedFiles,
  );
  const packages: RuntimeReleaseDependencyInventoryPackageV1[] = [];
  for (const [lockPath, metadata] of runtimeEntries) {
    if (!isBoundedText(metadata['version'], 128)) {
      throw new Error('runtime dependency lock version is invalid');
    }
    const path = packagePathFromLockPath(lockPath);
      const expectedName = runtimeDependencyPackageNameFromPath(path);
    const snapshot = scanPackageDirectory(
      join(packageRoot, ...lockPath.split('/')),
      expectedName,
      metadata['version'],
      checkpoint,
      packagedFilesByPath?.get(path),
    );
    packages.push({
      archiveModeSha256: snapshot.archiveModeSha256,
      contentSha256: snapshot.contentSha256,
      fileCount: snapshot.fileCount,
      name: snapshot.name,
      path,
      size: snapshot.size,
      version: snapshot.version,
    });
    if (packages.length > MAX_PACKAGES) throw new Error('runtime dependency package count exceeds limit');
  }
  if (packages.length === 0 && rootDependencies.length > 0) {
    throw new Error('runtime dependency inventory is empty');
  }
  const payload: Omit<RuntimeReleaseDependencyInventoryV2, 'inventoryDigest'> = {
    algorithm: 'sha256',
    assurance: 'packaged-build-byte-observation',
    package: {
      manifestSha256: createHash('sha256').update(packageJsonBytes).digest('hex'),
      name,
      version,
    },
    packages,
    portability: 'platform-independent-no-native-or-install-variance',
    rootDependencies,
    schemaVersion: RUNTIME_RELEASE_DEPENDENCY_INVENTORY_SCHEMA_VERSION,
  };
  return { ...payload, inventoryDigest: digest(INVENTORY_DIGEST_DOMAIN, payload) };
}

export function buildRuntimeReleaseDependencyInventory(
  packageRoot: string,
  options: BuildRuntimeReleaseDependencyInventoryOptions = {},
): BuildRuntimeReleaseDependencyInventoryResult {
  try {
    const inventory = buildInventory(packageRoot, options);
    const canonical = `${canonicalJson(inventory)}\n`;
    if (Buffer.byteLength(canonical, 'utf8') > MAX_INVENTORY_BYTES) {
      return { ok: false, reason: 'runtime dependency inventory exceeds byte limit' };
    }
    return { ok: true, inventory, canonicalJson: canonical };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function validateInventory(value: unknown): RuntimeReleaseDependencyInventoryV2 {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'algorithm',
    'assurance',
    'inventoryDigest',
    'package',
    'packages',
    'portability',
    'rootDependencies',
    'schemaVersion',
  ])) throw new Error('runtime dependency inventory has an invalid top-level shape');
  if (value['schemaVersion'] !== RUNTIME_RELEASE_DEPENDENCY_INVENTORY_SCHEMA_VERSION) {
    throw new Error('runtime dependency inventory schema is unsupported');
  }
  if (value['algorithm'] !== 'sha256' || value['assurance'] !== 'packaged-build-byte-observation' ||
    value['portability'] !== 'platform-independent-no-native-or-install-variance') {
    throw new Error('runtime dependency inventory contract is unsupported');
  }
  const packageIdentity = value['package'];
  if (!isPlainRecord(packageIdentity) ||
    !hasExactKeys(packageIdentity, ['manifestSha256', 'name', 'version']) ||
    typeof packageIdentity['manifestSha256'] !== 'string' ||
    !SHA256_RE.test(packageIdentity['manifestSha256']) ||
    !isBoundedText(packageIdentity['name'], 256) || !PACKAGE_NAME_RE.test(packageIdentity['name']) ||
    !isBoundedText(packageIdentity['version'], 128)) {
    throw new Error('runtime dependency inventory package identity is invalid');
  }
  const rootDependenciesValue = value['rootDependencies'];
  if (!Array.isArray(rootDependenciesValue) || rootDependenciesValue.length > MAX_PACKAGES) {
    throw new Error('runtime dependency inventory root dependencies are invalid');
  }
  const rootDependencies = rootDependenciesValue.map((entry) => {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ['name', 'requested']) ||
      !isBoundedText(entry['name'], 256) || !PACKAGE_NAME_RE.test(entry['name']) ||
      !isBoundedText(entry['requested'], 512)) {
      throw new Error('runtime dependency inventory root dependency is invalid');
    }
    return { name: entry['name'], requested: entry['requested'] };
  });
  if (canonicalJson(rootDependencies) !== canonicalJson([...rootDependencies]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    throw new Error('runtime dependency inventory root dependencies are not sorted');
  }
  const packagesValue = value['packages'];
  if (!Array.isArray(packagesValue) || packagesValue.length > MAX_PACKAGES) {
    throw new Error('runtime dependency inventory package count is invalid');
  }
  let previousPath: string | null = null;
  const packages = packagesValue.map((entry): RuntimeReleaseDependencyInventoryPackageV1 => {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, [
      'archiveModeSha256', 'contentSha256', 'fileCount', 'name', 'path', 'size', 'version',
    ]) || !isBoundedText(entry['path']) || !isBoundedText(entry['name'], 256) ||
      !PACKAGE_NAME_RE.test(entry['name']) ||
      packagePathFromLockPath(`node_modules/${entry['path']}`) !== entry['path'] ||
      runtimeDependencyPackageNameFromPath(entry['path']) !== entry['name'] ||
      !isBoundedText(entry['version'], 128) || typeof entry['archiveModeSha256'] !== 'string' ||
      !SHA256_RE.test(entry['archiveModeSha256']) || typeof entry['contentSha256'] !== 'string' ||
      !SHA256_RE.test(entry['contentSha256']) || !Number.isSafeInteger(entry['fileCount']) ||
      (entry['fileCount'] as number) <= 0 || (entry['fileCount'] as number) > MAX_FILES_PER_PACKAGE ||
      !Number.isSafeInteger(entry['size']) || (entry['size'] as number) < 0 ||
      (entry['size'] as number) > MAX_TOTAL_BYTES ||
      entry['path'].startsWith('/') || entry['path'].includes('\\') || entry['path'].includes('\0') ||
      entry['path'].split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error('runtime dependency inventory package is invalid');
    }
    if (previousPath !== null && entry['path'] <= previousPath) {
      throw new Error('runtime dependency inventory package paths are not unique and sorted');
    }
    previousPath = entry['path'];
    return {
      archiveModeSha256: entry['archiveModeSha256'],
      contentSha256: entry['contentSha256'],
      fileCount: entry['fileCount'] as number,
      name: entry['name'],
      path: entry['path'],
      size: entry['size'] as number,
      version: entry['version'],
    };
  });
  if (typeof value['inventoryDigest'] !== 'string' || !SHA256_RE.test(value['inventoryDigest'])) {
    throw new Error('runtime dependency inventory digest is invalid');
  }
  const inventory: RuntimeReleaseDependencyInventoryV2 = {
    algorithm: 'sha256',
    assurance: 'packaged-build-byte-observation',
    inventoryDigest: value['inventoryDigest'],
    package: {
      manifestSha256: packageIdentity['manifestSha256'],
      name: packageIdentity['name'],
      version: packageIdentity['version'],
    },
    packages,
    portability: 'platform-independent-no-native-or-install-variance',
    rootDependencies,
    schemaVersion: RUNTIME_RELEASE_DEPENDENCY_INVENTORY_SCHEMA_VERSION,
  };
  if (digest(INVENTORY_DIGEST_DOMAIN, inventoryPayload(inventory)) !== inventory.inventoryDigest) {
    throw new Error('runtime dependency inventory digest mismatch');
  }
  return inventory;
}

export function parseRuntimeReleaseDependencyInventory(
  input: string | Buffer,
): ParseRuntimeReleaseDependencyInventoryResult {
  try {
    const bytes = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input, 'utf8');
    if (bytes.length === 0 || bytes.length > MAX_INVENTORY_BYTES) {
      return { ok: false, reason: 'runtime dependency inventory exceeds byte limit' };
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      return { ok: false, reason: 'runtime dependency inventory is not valid UTF-8' };
    }
    const inventory = validateInventory(JSON.parse(text) as unknown);
    const canonical = `${canonicalJson(inventory)}\n`;
    if (canonical !== text) {
      return { ok: false, reason: 'runtime dependency inventory encoding is not canonical' };
    }
    return { ok: true, inventory, canonicalJson: canonical };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function discoverInstalledPackages(
  dependencyRoot: string,
  checkpoint: DependencyObservationCheckpoint,
): string[] {
  const output: string[] = [];
  const visitNodeModules = (nodeModulesRoot: string, prefix: string, depth: number): void => {
    checkpoint();
    if (depth > MAX_DEPTH) throw new Error('installed dependency traversal depth exceeds limit');
    const entries = readdirNames(nodeModulesRoot);
    for (const name of entries) {
      checkpoint();
      if (name === '.bin' || name === '.package-lock.json') continue;
      const absolute = join(nodeModulesRoot, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('installed dependency tree contains a symlink');
      if (name.startsWith('@')) {
        if (!stat.isDirectory()) throw new Error('installed dependency scope is invalid');
        for (const child of readdirNames(absolute)) {
          const scopedRoot = join(absolute, child);
          const scopedStat = lstatSync(scopedRoot);
          if (!scopedStat.isDirectory() || scopedStat.isSymbolicLink()) {
            throw new Error('installed dependency package is unsafe');
          }
      const relativePath = prefix ? `${prefix}/node_modules/${name}/${child}` : `${name}/${child}`;
      output.push(relativePath);
      if (output.length > MAX_PACKAGES) {
        throw new Error('installed dependency package count exceeds limit');
      }
          const nested = join(scopedRoot, 'node_modules');
          if (existsDirectory(nested)) visitNodeModules(nested, relativePath, depth + 1);
        }
        continue;
      }
      if (!stat.isDirectory()) throw new Error('installed dependency root contains an unexpected entry');
      const relativePath = prefix ? `${prefix}/node_modules/${name}` : name;
      output.push(relativePath);
      if (output.length > MAX_PACKAGES) {
        throw new Error('installed dependency package count exceeds limit');
      }
      const nested = join(absolute, 'node_modules');
      if (existsDirectory(nested)) visitNodeModules(nested, relativePath, depth + 1);
    }
  };
  visitNodeModules(dependencyRoot, '', 0);
  return output.sort();
}

function observeCompleteDependencyTree(
  dependencyRootInput: string,
  checkpoint: DependencyObservationCheckpoint,
  admittedPackageBins: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string {
  const dependencyRoot = canonicalRoot(dependencyRootInput, 'runtime dependency root');
  const rootBefore = lstatSync(dependencyRoot, { bigint: true });
  requireSafePortableMode(rootBefore, 'runtime dependency root', true);
  const content: Array<DependencyFileContent | DependencyBinLinkContent> = [];
  let directoryCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  let totalFiles = 0;
  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    checkpoint();
    if (depth > MAX_DEPTH) throw new Error('installed dependency traversal depth exceeds limit');
    directoryCount += 1;
    if (directoryCount > MAX_TOTAL_DIRECTORIES) {
      throw new Error('installed dependency directory count exceeds limit');
    }
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('installed dependency tree contains an unsafe directory');
    }
    requireSafePortableMode(before, 'installed dependency directory', true);
    const entries = readdirNames(directory);
    entryCount += entries.length;
    if (entryCount > MAX_TOTAL_FILES) {
      throw new Error('installed dependency tree entry count exceeds limit');
    }
    for (const name of entries) {
      checkpoint();
      const absolute = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        content.push(observeDependencyBinLink(
          dependencyRoot,
          absolute,
          relativePath,
          admittedPackageBins,
        ));
        totalFiles += 1;
        if (totalFiles > MAX_TOTAL_FILES) {
          throw new Error('installed dependency file count exceeds limit');
        }
        continue;
      }
      if (stat.isDirectory()) {
        requireSafePortableMode(stat, 'installed dependency directory', true);
        visit(absolute, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new Error('installed dependency tree contains a non-file entry');
      if (stat.nlink !== 1n) throw new Error('installed dependency tree has multiple hard links');
      requireSafePortableMode(stat, 'installed dependency file');
      const bytes = stableFileBytes(
        absolute,
        'installed dependency file',
        MAX_FILE_BYTES,
        checkpoint,
      );
      totalFiles += 1;
      totalBytes += bytes.length;
      if (totalFiles > MAX_TOTAL_FILES) throw new Error('installed dependency file count exceeds limit');
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('installed dependency bytes exceed limit');
      content.push({
        executable: (stat.mode & 0o111n) !== 0n,
        path: relativePath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
    }
    const after = lstatSync(directory, { bigint: true });
    if (!sameSnapshot(before, after) || realpathSync(directory) !== directory) {
      throw new Error('installed dependency directory changed during scan');
    }
  };
  visit(dependencyRoot, '', 0);
  const rootAfter = lstatSync(dependencyRoot, { bigint: true });
  if (!sameSnapshot(rootBefore, rootAfter) || realpathSync(dependencyRoot) !== dependencyRoot) {
    throw new Error('runtime dependency root changed during scan');
  }
  return digest(RUNTIME_RELEASE_INSTALLED_DEPENDENCY_TREE_DIGEST_DOMAIN_V2, content);
}

function readdirNames(directory: string): string[] {
  const before = statSync(directory, { bigint: true });
  const names: string[] = [];
  const handle = opendirSync(directory);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > MAX_DIRECTORY_ENTRIES) {
        throw new Error('installed dependency directory entry count exceeds limit');
      }
    }
  } finally {
    handle.closeSync();
  }
  const after = statSync(directory, { bigint: true });
  if (!sameSnapshot(before, after)) throw new Error('installed dependency directory changed during scan');
  return names.sort();
}

function existsDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function observeInstalledRuntimeDependencies(options: {
  checkpoint?: DependencyObservationCheckpoint;
  dependencyRoot: string;
  inventory: RuntimeReleaseDependencyInventoryV2;
  expectedPackageName: string;
  expectedPackageVersion: string;
}): ObserveInstalledRuntimeDependenciesResult {
  try {
    const checkpoint = options.checkpoint ?? (() => {});
    checkpoint();
    const dependencyRoot = canonicalRoot(options.dependencyRoot, 'runtime dependency root');
    if (options.inventory.package.name !== options.expectedPackageName ||
      options.inventory.package.version !== options.expectedPackageVersion) {
      return { ok: false, reason: 'runtime dependency inventory package identity mismatch' };
    }
    const discovered = discoverInstalledPackages(dependencyRoot, checkpoint);
    const expected = options.inventory.packages.map((entry) => entry.path);
    if (canonicalJson(discovered) !== canonicalJson(expected)) {
      return { ok: false, reason: 'installed dependency package set does not match inventory' };
    }
    let totalFiles = 0;
    let totalBytes = 0;
    const admittedPackageBins = new Map<string, ReadonlyMap<string, string>>();
    const observations = options.inventory.packages.map((entry) => {
      const absolute = join(dependencyRoot, ...entry.path.split('/'));
      const real = realpathSync(absolute);
      if (!isContained(dependencyRoot, real) || real !== resolve(absolute)) {
        throw new Error('installed dependency package escapes dependency root');
      }
      const snapshot = scanPackageDirectory(
        absolute,
        entry.name,
        entry.version,
        checkpoint,
      );
      totalFiles += snapshot.fileCount;
      totalBytes += snapshot.size;
      if (totalFiles > MAX_TOTAL_FILES) throw new Error('installed dependency file count exceeds limit');
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('installed dependency bytes exceed limit');
      if (snapshot.contentSha256 !== entry.contentSha256 || snapshot.fileCount !== entry.fileCount ||
        snapshot.size !== entry.size) {
        throw new Error(`installed dependency ${entry.name} bytes do not match inventory`);
      }
      admittedPackageBins.set(entry.path, snapshot.declaredBinTargets);
      return {
        contentSha256: snapshot.contentSha256,
        identitySha256: snapshot.identitySha256,
        name: snapshot.name,
        path: entry.path,
        version: snapshot.version,
      };
    });
    const installedTreeSha256 = observeCompleteDependencyTree(
      dependencyRoot,
      checkpoint,
      admittedPackageBins,
    );
    return {
      ok: true,
      inventoryDigest: options.inventory.inventoryDigest,
      installedTreeSha256,
      packageCount: observations.length,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
