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
import { isAbsolute, join, resolve } from 'node:path';

import {
  observeInstalledRuntimeDependencies,
  type RuntimeReleaseDependencyInventoryV1,
} from './runtime-release-dependency-inventory.js';

export const RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH =
  'dist/release-dependency-inventory.json' as const;

export const RUNTIME_RELEASE_PACKAGING_READINESS_EXPECTATION_V1 = Object.freeze({
  schemaVersion: 1 as const,
  packageManifestPath: 'package.json' as const,
  dependencyInventoryPath: RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
  installedDependencyRootPath: 'node_modules' as const,
  installedByteCoverage: 'inventory-package-bytes-root-unsealed' as const,
});

const INVENTORY_DIGEST_DOMAIN = 'ashlr:runtime-release-dependency-inventory:v1';
const PACKAGE_CONTENT_DIGEST_DOMAIN = 'ashlr:runtime-release-dependency-package-content:v1';
const MAX_INVENTORY_BYTES = 512 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_PACKAGES = 512;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_FILES_PER_PACKAGE = 20_000;
const MAX_TOTAL_FILES = 100_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 48;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/i;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface InventoryPackageV1 {
  contentSha256: string;
  fileCount: number;
  name: string;
  path: string;
  size: number;
  version: string;
}

interface DependencyInventoryV1 {
  algorithm: 'sha256';
  assurance: 'packaged-build-byte-observation';
  inventoryDigest: string;
  package: { name: string; version: string };
  packages: InventoryPackageV1[];
  portability: 'platform-independent-no-native-or-install-variance';
  rootDependencies: Array<{ name: string; requested: string }>;
  schemaVersion: 1;
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

interface StableFile {
  bytes: Buffer;
  executable: boolean;
  path: string;
  snapshot: BigIntStats;
}

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
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('invalid JSON object');
    }
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

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
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
    if (!openedBefore.isFile() || openedBefore.nlink !== 1n ||
      !sameSnapshot(before, openedBefore)) {
      throw new Error('file changed before read');
    }
    const expectedBytes = Number(openedBefore.size);
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(READ_CHUNK_BYTES, expectedBytes - offset);
      const count = readSync(fd, bytes, offset, length, offset);
      if (count <= 0) throw new Error('file changed during read');
      offset += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (readSync(fd, growthProbe, 0, 1, expectedBytes) !== 0) {
      throw new Error('file grew during read');
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const after = lstatSync(absolute, { bigint: true });
    if (openedAfter.nlink !== 1n || after.nlink !== 1n ||
      !sameSnapshot(openedBefore, openedAfter) || !sameSnapshot(openedAfter, after) ||
      realpathSync(absolute) !== absolute) {
      throw new Error('file changed during read');
    }
    return {
      bytes,
      executable: (openedAfter.mode & 0o111n) !== 0n,
      path: absolute,
      snapshot: openedAfter,
    };
  } finally {
    closeSync(fd);
  }
}

function assertFileStable(observed: StableFile): void {
  const after = lstatSync(observed.path, { bigint: true });
  if (after.nlink !== 1n || !sameSnapshot(observed.snapshot, after) ||
    realpathSync(observed.path) !== observed.path) {
    throw new Error('file changed after read');
  }
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

function stableDirectoryNames(path: string): string[] {
  const { path: absolute, snapshot } = canonicalDirectory(path);
  const names: string[] = [];
  const handle = opendirSync(absolute);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > MAX_DIRECTORY_ENTRIES) throw new Error('directory entry budget exceeded');
    }
  } finally {
    handle.closeSync();
  }
  assertDirectoryStable(absolute, snapshot);
  return names.sort();
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

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedText(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\0\r\n]/u.test(value);
}

function packageNameFromPath(path: string): string {
  const segments = path.split('/');
  const marker = segments.lastIndexOf('node_modules');
  const start = marker < 0 ? 0 : marker + 1;
  const first = segments[start] ?? '';
  return first.startsWith('@') ? `${first}/${segments[start + 1] ?? ''}` : first;
}

function validPackagePath(path: string): boolean {
  if (!boundedText(path) || isAbsolute(path) || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  for (let index = 0; index < segments.length;) {
    const first = segments[index]!;
    if (first === 'node_modules') return false;
    index += first.startsWith('@') ? 2 : 1;
    if (index > segments.length || (first.startsWith('@') && !segments[index - 1])) return false;
    if (index === segments.length) return true;
    if (segments[index] !== 'node_modules') return false;
    index += 1;
  }
  return false;
}

function validateInventory(value: Record<string, unknown>): DependencyInventoryV1 {
  if (!exactKeys(value, [
    'algorithm', 'assurance', 'inventoryDigest', 'package', 'packages',
    'portability', 'rootDependencies', 'schemaVersion',
  ]) || value['schemaVersion'] !== 1 || value['algorithm'] !== 'sha256' ||
    value['assurance'] !== 'packaged-build-byte-observation' ||
    value['portability'] !== 'platform-independent-no-native-or-install-variance') {
    throw new Error('unsupported inventory');
  }
  const identity = value['package'];
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity) ||
    !exactKeys(identity as Record<string, unknown>, ['name', 'version'])) {
    throw new Error('invalid inventory package');
  }
  const packageName = (identity as Record<string, unknown>)['name'];
  const packageVersion = (identity as Record<string, unknown>)['version'];
  if (!boundedText(packageName, 256) || !PACKAGE_NAME_RE.test(packageName) ||
    !boundedText(packageVersion, 128)) {
    throw new Error('invalid inventory package');
  }
  const rootDependenciesValue = value['rootDependencies'];
  if (!Array.isArray(rootDependenciesValue) || rootDependenciesValue.length > MAX_PACKAGES) {
    throw new Error('invalid root dependencies');
  }
  const rootDependencies = rootDependenciesValue.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
      !exactKeys(entry as Record<string, unknown>, ['name', 'requested'])) {
      throw new Error('invalid root dependency');
    }
    const name = (entry as Record<string, unknown>)['name'];
    const requested = (entry as Record<string, unknown>)['requested'];
    if (!boundedText(name, 256) || !PACKAGE_NAME_RE.test(name) || !boundedText(requested, 512)) {
      throw new Error('invalid root dependency');
    }
    return { name, requested };
  });
  if (canonicalJson(rootDependencies) !== canonicalJson([...rootDependencies]
    .sort((left, right) => left.name.localeCompare(right.name)))) {
    throw new Error('unsorted root dependencies');
  }
  const packagesValue = value['packages'];
  if (!Array.isArray(packagesValue) || packagesValue.length > MAX_PACKAGES) {
    throw new Error('invalid package count');
  }
  let previousPath: string | null = null;
  const packages = packagesValue.map((entry): InventoryPackageV1 => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('invalid inventory package entry');
    }
    const item = entry as Record<string, unknown>;
    if (!exactKeys(item, ['contentSha256', 'fileCount', 'name', 'path', 'size', 'version']) ||
      !boundedText(item['path']) || !validPackagePath(item['path']) ||
      !boundedText(item['name'], 256) || !PACKAGE_NAME_RE.test(item['name']) ||
      packageNameFromPath(item['path']) !== item['name'] || !boundedText(item['version'], 128) ||
      typeof item['contentSha256'] !== 'string' || !SHA256_RE.test(item['contentSha256']) ||
      !Number.isSafeInteger(item['fileCount']) || (item['fileCount'] as number) <= 0 ||
      (item['fileCount'] as number) > MAX_FILES_PER_PACKAGE ||
      !Number.isSafeInteger(item['size']) || (item['size'] as number) < 0 ||
      (item['size'] as number) > MAX_TOTAL_BYTES ||
      (previousPath !== null && item['path'] <= previousPath)) {
      throw new Error('invalid inventory package entry');
    }
    previousPath = item['path'];
    return {
      contentSha256: item['contentSha256'],
      fileCount: item['fileCount'] as number,
      name: item['name'],
      path: item['path'],
      size: item['size'] as number,
      version: item['version'],
    };
  });
  const inventoryDigest = value['inventoryDigest'];
  if (typeof inventoryDigest !== 'string' || !SHA256_RE.test(inventoryDigest)) {
    throw new Error('invalid inventory digest');
  }
  const inventory: DependencyInventoryV1 = {
    algorithm: 'sha256',
    assurance: 'packaged-build-byte-observation',
    inventoryDigest,
    package: { name: packageName, version: packageVersion },
    packages,
    portability: 'platform-independent-no-native-or-install-variance',
    rootDependencies,
    schemaVersion: 1,
  };
  const { inventoryDigest: _digest, ...payload } = inventory;
  if (digest(INVENTORY_DIGEST_DOMAIN, payload) !== inventory.inventoryDigest) {
    throw new Error('inventory digest mismatch');
  }
  return inventory;
}

function parseInventory(bytes: Buffer): DependencyInventoryV1 {
  const value = parseJsonObject(bytes);
  const inventory = validateInventory(value);
  if (`${canonicalJson(inventory)}\n` !== bytes.toString('utf8')) {
    throw new Error('inventory is not canonical');
  }
  return inventory;
}

function portablePackage(packageJson: Record<string, unknown>, filePaths: readonly string[]): boolean {
  for (const field of ['os', 'cpu', 'libc', 'optionalDependencies']) {
    const value = packageJson[field];
    if (value !== undefined && (value === null || typeof value !== 'object' ||
      Array.isArray(value) || Object.keys(value as Record<string, unknown>).length > 0)) {
      return false;
    }
  }
  const scripts = packageJson['scripts'];
  if (scripts !== undefined && (scripts === null || typeof scripts !== 'object' ||
    Array.isArray(scripts))) return false;
  if (scripts && ['preinstall', 'install', 'postinstall'].some((name) =>
    typeof (scripts as Record<string, unknown>)[name] === 'string')) return false;
  return packageJson['gypfile'] !== true && !filePaths.some((path) => path.endsWith('.node'));
}

function scanPackage(rootInput: string, expected: InventoryPackageV1): void {
  const { path: root, snapshot: rootBefore } = canonicalDirectory(rootInput);
  const files: Array<{ executable: boolean; path: string; sha256: string; size: number }> = [];
  const stableFiles: StableFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error('package depth exceeded');
    const { path: absolute, snapshot } = canonicalDirectory(directory);
    for (const name of stableDirectoryNames(absolute)) {
      if (name === 'node_modules') continue;
      const child = join(absolute, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = lstatSync(child, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error('package contains symlink');
      if (stat.isDirectory()) {
        visit(child, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile() || files.length >= MAX_FILES_PER_PACKAGE) {
        throw new Error('package contains unsafe entry');
      }
      const observed = stableFile(child, MAX_FILE_BYTES);
      stableFiles.push(observed);
      totalBytes += observed.bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('package bytes exceeded');
      files.push({
        executable: observed.executable,
        path: relativePath,
        sha256: createHash('sha256').update(observed.bytes).digest('hex'),
        size: observed.bytes.length,
      });
    }
    assertDirectoryStable(absolute, snapshot);
  };
  visit(root, '', 0);
  const packageManifest = stableFile(join(root, 'package.json'), MAX_PACKAGE_JSON_BYTES);
  const packageJson = parseJsonObject(packageManifest.bytes);
  if (packageJson['name'] !== expected.name || packageJson['version'] !== expected.version ||
    !portablePackage(packageJson, files.map((entry) => entry.path))) {
    throw new Error('package identity or portability mismatch');
  }
  for (const observed of stableFiles) assertFileStable(observed);
  assertFileStable(packageManifest);
  assertDirectoryStable(root, rootBefore);
  if (files.length !== expected.fileCount || totalBytes !== expected.size ||
    digest(PACKAGE_CONTENT_DIGEST_DOMAIN, files) !== expected.contentSha256) {
    throw new Error('package bytes mismatch');
  }
}

function discoverPackages(dependencyRoot: string): string[] {
  const output: string[] = [];
  const visit = (nodeModulesRoot: string, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error('dependency depth exceeded');
    for (const name of stableDirectoryNames(nodeModulesRoot)) {
      if (name === '.bin' || name === '.package-lock.json') continue;
      const absolute = join(nodeModulesRoot, name);
      const stat = lstatSync(absolute, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe dependency entry');
      if (name.startsWith('@')) {
        for (const child of stableDirectoryNames(absolute)) {
          const packageRoot = join(absolute, child);
          const packageStat = lstatSync(packageRoot, { bigint: true });
          if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
            throw new Error('unsafe scoped dependency');
          }
          const packagePath = prefix ? `${prefix}/node_modules/${name}/${child}` : `${name}/${child}`;
          output.push(packagePath);
          if (output.length > MAX_PACKAGES) throw new Error('dependency package budget exceeded');
          const nested = join(packageRoot, 'node_modules');
          try {
            canonicalDirectory(nested);
            visit(nested, packagePath, depth + 1);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        continue;
      }
      const packagePath = prefix ? `${prefix}/node_modules/${name}` : name;
      output.push(packagePath);
      if (output.length > MAX_PACKAGES) throw new Error('dependency package budget exceeded');
      const nested = join(absolute, 'node_modules');
      try {
        canonicalDirectory(nested);
        visit(nested, packagePath, depth + 1);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
  visit(dependencyRoot, '', 0);
  return output.sort();
}

function rootDependencies(packageJson: Record<string, unknown>): Array<{ name: string; requested: string }> {
  const dependencies = packageJson['dependencies'];
  if (dependencies === undefined) return [];
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('invalid root dependencies');
  }
  return Object.entries(dependencies).map(([name, requested]) => {
    if (!PACKAGE_NAME_RE.test(name) || !boundedText(requested, 512)) {
      throw new Error('invalid root dependency');
    }
    return { name, requested };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function bundledDependenciesMatch(
  packageJson: Record<string, unknown>,
  dependencies: readonly { name: string }[],
): boolean {
  const bundled = packageJson['bundledDependencies'] ?? packageJson['bundleDependencies'];
  if (bundled === undefined) return dependencies.length === 0;
  if (!Array.isArray(bundled) || bundled.some((name) => typeof name !== 'string')) return false;
  return canonicalJson([...bundled].sort()) ===
    canonicalJson(dependencies.map(({ name }) => name).sort());
}

function classifyMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Read-only compatibility observation for the release-artifact inventory.
 * Package bytes are matched, but the node_modules root remains explicitly
 * unsealed and this result is never launch or activation authority.
 */
export function observeRuntimeReleasePackagingReadinessV1(
  packageRootInput: string,
): RuntimeReleasePackagingReadinessResultV1 {
  let packageRoot: { path: string; snapshot: BigIntStats };
  try {
    packageRoot = canonicalDirectory(packageRootInput);
  } catch (error) {
    return { ok: false, kind: classifyMissing(error) ? 'missing' : 'unreadable', subject: 'package-manifest' };
  }
  let packageManifest: StableFile;
  let packageJson: Record<string, unknown>;
  try {
    packageManifest = stableFile(
      join(packageRoot.path, RUNTIME_RELEASE_PACKAGING_READINESS_EXPECTATION_V1.packageManifestPath),
      MAX_PACKAGE_JSON_BYTES,
    );
    packageJson = parseJsonObject(packageManifest.bytes);
  } catch (error) {
    return { ok: false, kind: classifyMissing(error) ? 'missing' : 'unreadable', subject: 'package-manifest' };
  }
  let inventoryFile: StableFile;
  let inventory: DependencyInventoryV1;
  try {
    inventoryFile = stableFile(
      join(packageRoot.path, RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH),
      MAX_INVENTORY_BYTES,
    );
    inventory = parseInventory(inventoryFile.bytes);
  } catch (error) {
    return { ok: false, kind: classifyMissing(error) ? 'missing' : 'unreadable', subject: 'dependency-inventory' };
  }
  try {
    const declaredDependencies = rootDependencies(packageJson);
    if (packageJson['name'] !== inventory.package.name || packageJson['version'] !== inventory.package.version ||
      canonicalJson(declaredDependencies) !== canonicalJson(inventory.rootDependencies) ||
      !bundledDependenciesMatch(packageJson, declaredDependencies) ||
      !portablePackage(packageJson, [])) {
      throw new Error('root package mismatch');
    }
  } catch {
    return { ok: false, kind: 'mismatch', subject: 'dependency-inventory' };
  }
  try {
    const dependencyRoot = canonicalDirectory(join(
      packageRoot.path,
      RUNTIME_RELEASE_PACKAGING_READINESS_EXPECTATION_V1.installedDependencyRootPath,
    ));
    const discovered = discoverPackages(dependencyRoot.path);
    if (canonicalJson(discovered) !== canonicalJson(inventory.packages.map(({ path }) => path))) {
      throw new Error('dependency package set mismatch');
    }
    let files = 0;
    let bytes = 0;
    for (const expected of inventory.packages) {
      scanPackage(join(dependencyRoot.path, ...expected.path.split('/')), expected);
      files += expected.fileCount;
      bytes += expected.size;
      if (files > MAX_TOTAL_FILES || bytes > MAX_TOTAL_BYTES) throw new Error('dependency budget exceeded');
    }
    const installed = observeInstalledRuntimeDependencies({
      dependencyRoot: dependencyRoot.path,
      inventory: inventory as unknown as RuntimeReleaseDependencyInventoryV1,
      expectedPackageName: inventory.package.name,
      expectedPackageVersion: inventory.package.version,
    });
    if (!installed.ok || installed.inventoryDigest !== inventory.inventoryDigest ||
      installed.packageCount !== inventory.packages.length) {
      throw new Error('complete dependency tree does not match inventory');
    }
    assertFileStable(packageManifest);
    assertFileStable(inventoryFile);
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
    return { ok: false, kind: classifyMissing(error) ? 'missing' : 'mismatch', subject: 'dependency-tree' };
  }
}
