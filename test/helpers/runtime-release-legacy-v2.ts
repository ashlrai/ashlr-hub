import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import {
  observeInstalledRuntimeDependencies,
  parseRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../../src/core/daemon/runtime-release-dependency-inventory.js';
import type {
  UnsignedRuntimeReleaseArtifact,
  UnsignedRuntimeReleaseManifest,
} from '../../src/core/daemon/runtime-release-manifest.js';

const LEGACY_MANIFEST_DIGEST_DOMAIN = 'ashlr:unsigned-runtime-release-manifest:v2';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  throw new TypeError('legacy manifest fixture contains an invalid JSON value');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface LegacyRuntimeReleaseV2FixtureOptions {
  artifactPaths: readonly string[];
  declaredInterpreterPath: string;
  declaredInterpreterVersion: string;
  expectedPackageName: string;
  expectedRevision: string;
  packageRoot: string;
  rollbackTargetDigest?: string | null;
}

/**
 * Serializes the retired schema-v2 contract independently of the production
 * builder. Tests use this only to prove reader-first rollback compatibility
 * with packages that predate the scorecard-history worker.
 */
export function buildLegacyRuntimeReleaseManifestV2(
  options: LegacyRuntimeReleaseV2FixtureOptions,
): string {
  const packageBytes = readFileSync(join(options.packageRoot, 'package.json'));
  const packageJson = JSON.parse(packageBytes.toString('utf8')) as {
    name: string;
    version: string;
  };
  if (packageJson.name !== options.expectedPackageName) {
    throw new Error('legacy fixture package name mismatch');
  }
  const inventoryBytes = readFileSync(join(
    options.packageRoot,
    ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/'),
  ));
  const parsedInventory = parseRuntimeReleaseDependencyInventory(inventoryBytes);
  if (!parsedInventory.ok) throw new Error(parsedInventory.reason);
  const installed = observeInstalledRuntimeDependencies({
    dependencyRoot: join(options.packageRoot, 'node_modules'),
    inventory: parsedInventory.inventory,
    expectedPackageName: packageJson.name,
    expectedPackageVersion: packageJson.version,
  });
  if (!installed.ok) throw new Error(installed.reason);

  const artifacts: UnsignedRuntimeReleaseArtifact[] = options.artifactPaths
    .map((path) => {
      const absolutePath = join(options.packageRoot, ...path.split('/'));
      const bytes = readFileSync(absolutePath);
      const stat = lstatSync(absolutePath);
      return {
        executable: process.platform !== 'win32' && (stat.mode & 0o111) !== 0,
        path,
        sha256: sha256(bytes),
        size: bytes.length,
      };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const payload: Omit<UnsignedRuntimeReleaseManifest, 'manifestDigest'> = {
    algorithm: 'sha256',
    artifacts,
    assurance: 'unsigned-observation-only',
    coverage: {
      artifactCoherence: 'two-complete-scans',
      authenticity: 'unsigned',
      configuration: 'excluded',
      installedDependencies: 'packaged-byte-inventory-and-installed-tree',
      rollback: 'unresolved-caller-declared-reference',
      serviceInvocation: 'unbound',
    },
    dependencyInventory: {
      installedDependencyRootSha256: installed.installedTreeSha256,
      inventoryDigest: parsedInventory.inventory.inventoryDigest,
      packageCount: parsedInventory.inventory.packages.length,
      path: RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
      sha256: sha256(inventoryBytes),
    },
    entrypoints: {
      launcher: 'bin/ashlr',
      runtime: 'dist/cli/index.js',
      verifierRunner: 'scripts/run-verify-command.mjs',
    },
    expectedRevision: options.expectedRevision,
    interpreterDeclaration: {
      claimedVersion: options.declaredInterpreterVersion,
      declaredPath: options.declaredInterpreterPath,
      kind: 'node',
      observedArtifactSha256: sha256(readFileSync(options.declaredInterpreterPath)),
      observedResolvedPath: realpathSync(options.declaredInterpreterPath),
      source: 'caller-declared',
    },
    package: {
      binName: 'ashlr',
      manifestPath: 'package.json',
      name: packageJson.name,
      sha256: sha256(packageBytes),
      version: packageJson.version,
    },
    rollbackDeclaration: {
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest: options.rollbackTargetDigest ?? null,
    },
    schemaVersion: 2,
  };
  const manifest: UnsignedRuntimeReleaseManifest = {
    ...payload,
    manifestDigest: createHash('sha256')
      .update(LEGACY_MANIFEST_DIGEST_DOMAIN, 'utf8')
      .update('\n', 'utf8')
      .update(canonicalJson(payload), 'utf8')
      .digest('hex'),
  };
  return `${canonicalJson(manifest)}\n`;
}
