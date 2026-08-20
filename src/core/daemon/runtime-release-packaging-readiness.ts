import { createHash } from 'node:crypto';
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
import { join, relative, resolve, sep } from 'node:path';

import {
  assertRuntimeReleaseRootPackagePortability,
  observeInstalledRuntimeDependencies,
  parseRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_SCHEMA_VERSION,
  type RuntimeReleaseDependencyInventoryV2,
} from './runtime-release-dependency-inventory.js';

export { RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH };

export const RUNTIME_RELEASE_PACKAGING_READINESS_EXPECTATION_V1 = Object.freeze({
  schemaVersion: RUNTIME_RELEASE_DEPENDENCY_INVENTORY_SCHEMA_VERSION,
  packageManifestPath: 'package.json' as const,
  dependencyInventoryPath: RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
  installedDependencyRootPath: 'node_modules' as const,
  installedByteCoverage: 'inventory-v2-package-manifest-bound-root-unsealed' as const,
});

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_INVENTORY_BYTES = 512 * 1024;
const MAX_ROOT_FILES = 2_048;
const MAX_ROOT_DIRECTORIES = 512;
const MAX_ROOT_DEPTH = 32;
const MAX_ROOT_FILE_BYTES = 128 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REQUIRED_ROOT_FILES = new Set([
  'bin/ashlr',
  'dist/cli/index.js',
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
  'scripts/run-verify-command.mjs',
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface StableFile {
  bytes: Buffer;
  path: string;
  snapshot: BigIntStats;
}

interface RootCoverage {
  directories: Array<{ path: string; snapshot: BigIntStats }>;
  files: Array<{ path: string; snapshot: BigIntStats }>;
  paths: string[];
}

export type RuntimeReleasePackagingReadinessResultV1 =
  | {
    ok: true;
    dependencyRoot: string;
    inventoryDigest: string;
    installedTreeSha256: string;
    packageCount: number;
    packageName: string;
    packageRoot: string;
    packageVersion: string;
  }
  | {
    ok: false;
    kind: 'missing' | 'unreadable' | 'mismatch';
    subject: 'package-manifest' | 'dependency-inventory' | 'dependency-tree';
  };

function canonicalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('invalid JSON number');
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
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('invalid JSON object');
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
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

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function canonicalDirectory(path: string): { path: string; snapshot: BigIntStats } {
  const requested = resolve(path);
  const requestedSnapshot = lstatSync(requested, { bigint: true });
  const absolute = realpathSync(requested);
  const snapshot = lstatSync(absolute, { bigint: true });
  if (!requestedSnapshot.isDirectory() || requestedSnapshot.isSymbolicLink() ||
    !snapshot.isDirectory() || snapshot.isSymbolicLink() ||
    requestedSnapshot.dev !== snapshot.dev || requestedSnapshot.ino !== snapshot.ino) {
    throw new Error('unsafe directory');
  }
  return { path: absolute, snapshot };
}

function assertDirectoryStable(path: string, before: BigIntStats): void {
  const after = lstatSync(path, { bigint: true });
  if (!sameSnapshot(before, after) || realpathSync(path) !== path) {
    throw new Error('directory changed during observation');
  }
}

function stableFile(path: string, maxBytes: number): StableFile {
  const absolute = resolve(path);
  const before = lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
    before.size < 0n || before.size > BigInt(maxBytes) || realpathSync(absolute) !== absolute) {
    throw new Error('unsafe file');
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(absolute, fsConstants.O_RDONLY | noFollow);
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!openedBefore.isFile() || openedBefore.nlink !== 1n || !sameSnapshot(before, openedBefore)) {
      throw new Error('file changed before read');
    }
    const size = Number(openedBefore.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, Math.min(READ_CHUNK_BYTES, size - offset), offset);
      if (count <= 0) throw new Error('file changed during read');
      offset += count;
    }
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, size) !== 0) {
      throw new Error('file grew during read');
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const after = lstatSync(absolute, { bigint: true });
    if (openedAfter.nlink !== 1n || after.nlink !== 1n ||
      !sameSnapshot(openedBefore, openedAfter) || !sameSnapshot(openedAfter, after) ||
      realpathSync(absolute) !== absolute) {
      throw new Error('file changed during read');
    }
    return { bytes, path: absolute, snapshot: after };
  } finally {
    closeSync(fd);
  }
}

function assertFileStable(observed: StableFile | { path: string; snapshot: BigIntStats }): void {
  const after = lstatSync(observed.path, { bigint: true });
  if (after.nlink !== 1n || !sameSnapshot(observed.snapshot, after) ||
    realpathSync(observed.path) !== observed.path) {
    throw new Error('file changed after read');
  }
}

function stableDirectoryEntries(path: string): string[] {
  const before = lstatSync(path, { bigint: true });
  const names: string[] = [];
  const handle = opendirSync(path);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > MAX_ROOT_FILES + MAX_ROOT_DIRECTORIES) {
        throw new Error('release directory entry budget exceeded');
      }
    }
  } finally {
    handle.closeSync();
  }
  assertDirectoryStable(path, before);
  return names.sort();
}

function completeRootCoverage(packageRoot: string): RootCoverage {
  const paths: string[] = [];
  const files: RootCoverage['files'] = [];
  const directories: RootCoverage['directories'] = [];
  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    if (depth > MAX_ROOT_DEPTH) throw new Error('release root traversal depth exceeded');
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('unsafe release directory');
    directories.push({ path: directory, snapshot: before });
    if (directories.length > MAX_ROOT_DIRECTORIES) throw new Error('release directory budget exceeded');
    for (const name of stableDirectoryEntries(directory)) {
      if (relativeDirectory === '' && name === 'node_modules') continue;
      const absolute = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error('release root contains a symlink');
      if (stat.isDirectory()) {
        visit(absolute, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1n || stat.size < 0n ||
        stat.size > BigInt(MAX_ROOT_FILE_BYTES)) {
        throw new Error('release root contains an unsafe file');
      }
      const resolved = realpathSync(absolute);
      const nested = relative(packageRoot, resolved);
      if (resolved !== absolute || nested === '' || nested === '..' || nested.startsWith(`..${sep}`)) {
        throw new Error('release root file escapes package root');
      }
      paths.push(relativePath);
      files.push({ path: absolute, snapshot: stat });
      if (files.length > MAX_ROOT_FILES) throw new Error('release root file budget exceeded');
    }
    assertDirectoryStable(directory, before);
  };
  visit(packageRoot, '', 0);
  paths.sort();
  if ([...REQUIRED_ROOT_FILES].some((path) => !paths.includes(path))) {
    throw new Error('release root is missing a required file');
  }
  return { directories, files, paths };
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid UTF-8');
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('invalid JSON object');
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\0\r\n]/u.test(value);
}

function rootDependencies(packageJson: Record<string, unknown>): Array<{ name: string; requested: string }> {
  const dependencies = packageJson['dependencies'];
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies) ||
    Object.getPrototypeOf(dependencies) !== Object.prototype) {
    throw new Error('package dependencies are invalid');
  }
  return Object.entries(dependencies as Record<string, unknown>).map(([name, requested]) => {
    if (!boundedText(name, 256) || !boundedText(requested, 512)) {
      throw new Error('package dependency is invalid');
    }
    return { name, requested };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function bundledDependenciesMatch(
  packageJson: Record<string, unknown>,
  dependencies: readonly { name: string }[],
): boolean {
  const bundled = packageJson['bundledDependencies'] ?? packageJson['bundleDependencies'];
  if (!Array.isArray(bundled) || bundled.some((name) => typeof name !== 'string')) return false;
  return canonicalJson([...bundled].sort()) ===
    canonicalJson(dependencies.map(({ name }) => name).sort());
}

function validateRootContract(
  packageBytes: Buffer,
  packageJson: Record<string, unknown>,
  rootPaths: readonly string[],
  inventory: RuntimeReleaseDependencyInventoryV2,
): void {
  const dependencies = rootDependencies(packageJson);
  if (packageJson['name'] !== inventory.package.name ||
    packageJson['version'] !== inventory.package.version ||
    canonicalJson(dependencies) !== canonicalJson(inventory.rootDependencies) ||
    !bundledDependenciesMatch(packageJson, dependencies) ||
    !SHA256_RE.test(inventory.package.manifestSha256) ||
    createHash('sha256').update(packageBytes).digest('hex') !== inventory.package.manifestSha256) {
    throw new Error('release root does not match dependency inventory');
  }
  assertRuntimeReleaseRootPackagePortability(packageJson, rootPaths, inventory);
}

function classifyMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Observe V2 release packaging bytes without granting launch or activation
 * authority. Host-local immutability is enforced by the shared staged-tree
 * scanner during launch-readiness inspection.
 */
export function observeRuntimeReleasePackagingReadinessV1(
  packageRootInput: string,
): RuntimeReleasePackagingReadinessResultV1 {
  let packageRoot: { path: string; snapshot: BigIntStats };
  try {
    packageRoot = canonicalDirectory(packageRootInput);
  } catch (error) {
    return {
      ok: false,
      kind: classifyMissing(error) ? 'missing' : 'unreadable',
      subject: 'package-manifest',
    };
  }
  let packageManifest: StableFile;
  let packageJson: Record<string, unknown>;
  try {
    packageManifest = stableFile(join(packageRoot.path, 'package.json'), MAX_PACKAGE_JSON_BYTES);
    packageJson = parseJsonObject(packageManifest.bytes);
  } catch (error) {
    return {
      ok: false,
      kind: classifyMissing(error) ? 'missing' : 'unreadable',
      subject: 'package-manifest',
    };
  }
  let inventoryFile: StableFile;
  let inventory: RuntimeReleaseDependencyInventoryV2;
  try {
    inventoryFile = stableFile(
      join(packageRoot.path, RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH),
      MAX_INVENTORY_BYTES,
    );
    const parsed = parseRuntimeReleaseDependencyInventory(inventoryFile.bytes);
    if (!parsed.ok) throw new Error(parsed.reason);
    inventory = parsed.inventory;
  } catch (error) {
    return {
      ok: false,
      kind: classifyMissing(error) ? 'missing' : 'unreadable',
      subject: 'dependency-inventory',
    };
  }
  let coverage: RootCoverage;
  try {
    coverage = completeRootCoverage(packageRoot.path);
    validateRootContract(packageManifest.bytes, packageJson, coverage.paths, inventory);
  } catch {
    return { ok: false, kind: 'mismatch', subject: 'dependency-inventory' };
  }
  try {
    const dependencyRoot = canonicalDirectory(join(packageRoot.path, 'node_modules'));
    const installed = observeInstalledRuntimeDependencies({
      dependencyRoot: dependencyRoot.path,
      inventory,
      expectedPackageName: inventory.package.name,
      expectedPackageVersion: inventory.package.version,
    });
    if (!installed.ok || installed.inventoryDigest !== inventory.inventoryDigest ||
      installed.packageCount !== inventory.packages.length) {
      throw new Error('complete dependency tree does not match inventory');
    }
    assertFileStable(packageManifest);
    assertFileStable(inventoryFile);
    for (const file of coverage.files) assertFileStable(file);
    for (const directory of coverage.directories) {
      assertDirectoryStable(directory.path, directory.snapshot);
    }
    assertDirectoryStable(dependencyRoot.path, dependencyRoot.snapshot);
    assertDirectoryStable(packageRoot.path, packageRoot.snapshot);
    return {
      ok: true,
      dependencyRoot: dependencyRoot.path,
      inventoryDigest: inventory.inventoryDigest,
      installedTreeSha256: installed.installedTreeSha256,
      packageCount: inventory.packages.length,
      packageName: inventory.package.name,
      packageRoot: packageRoot.path,
      packageVersion: inventory.package.version,
    };
  } catch (error) {
    return {
      ok: false,
      kind: classifyMissing(error) ? 'missing' : 'mismatch',
      subject: 'dependency-tree',
    };
  }
}
