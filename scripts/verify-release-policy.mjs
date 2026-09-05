#!/usr/bin/env node

/**
 * Strict, authority-free verifier for a future versioned release policy.
 *
 * This module reads no repository, registry, GitHub, credential, service, or
 * runtime state beyond the one explicit policy path supplied by the caller.
 * A valid policy is evidence only; it cannot authorize any effect.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const MAX_POLICY_BYTES = 64 * 1024;
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const REVISION_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/u;

export const RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION = 1;
export const RELEASE_SUCCESSOR_POLICY_AUTHORITY = Object.freeze({
  activate: false,
  dispatch: false,
  install: false,
  promote: false,
  providerEffects: false,
  publish: false,
});

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'policyId',
  'package',
  'release',
  'registry',
  'localVerification',
  'toolchain',
  'runtime',
  'authority',
];
const ARTIFACT_KEYS = ['version', 'releaseTag', 'revision', 'integrity'];

function fail(message) {
  throw new Error(`release successor policy: ${message}`);
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object`);
  }
  let prototype;
  let ownKeys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(`${label} could not be inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail(`${label} contains a non-string key`);
  }
  const actual = ownKeys.toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys do not match the closed schema`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value;
}

function exactArray(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must contain ${minimum}-${maximum} entries`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...Array(value.length).keys()].map(String).concat('length');
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} must be a dense array without extra properties`);
  }
  return value;
}

function exactString(value, label, pattern, maximumBytes = 256) {
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function version(value, label) {
  return exactString(value, label, VERSION_RE, 32);
}

function revision(value, label) {
  return exactString(value, label, REVISION_RE, 40);
}

function integrity(value, label) {
  return exactString(value, label, INTEGRITY_RE, 95);
}

function versionTuple(value) {
  return value.split('.').map((part) => BigInt(part));
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function sameArtifact(left, right) {
  return ARTIFACT_KEYS.every((key) => left[key] === right[key]);
}

function validateArtifact(value, label) {
  const artifact = exactRecord(value, ARTIFACT_KEYS, label);
  const artifactVersion = version(artifact.version, `${label}.version`);
  if (artifact.releaseTag !== `v${artifactVersion}`) {
    fail(`${label}.releaseTag must match its version`);
  }
  revision(artifact.revision, `${label}.revision`);
  integrity(artifact.integrity, `${label}.integrity`);
  return artifact;
}

function validateOrderedHistory(values, label, candidateVersion, rollbackVersion) {
  const observed = new Set();
  let priorVersion = null;
  for (const [index, item] of values.entries()) {
    const itemVersion = version(item.version, `${label}[${index}].version`);
    if (itemVersion === candidateVersion || itemVersion === rollbackVersion || observed.has(itemVersion)) {
      fail(`${label} versions must be unique and distinct from candidate and rollback`);
    }
    if (compareVersions(itemVersion, candidateVersion) >= 0) {
      fail(`${label} versions must predate the candidate`);
    }
    if (priorVersion !== null && compareVersions(priorVersion, itemVersion) >= 0) {
      fail(`${label} must be ordered by increasing version`);
    }
    observed.add(itemVersion);
    priorVersion = itemVersion;
  }
}

export function canonicalizeReleaseSuccessorPolicy(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('canonical JSON numbers must be safe integers');
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeReleaseSuccessorPolicy(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) fail('canonical JSON keys must be strings');
    return `{${keys.toSorted().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        fail('canonical JSON accepts enumerable data properties only');
      }
      return `${JSON.stringify(key)}:${canonicalizeReleaseSuccessorPolicy(descriptor.value)}`;
    }).join(',')}}`;
  }
  fail('canonical JSON contains an unsupported value');
}

export function validateReleaseSuccessorPolicy(value) {
  const policy = exactRecord(value, TOP_LEVEL_KEYS, 'policy');
  if (policy.schemaVersion !== RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION}`);
  }

  const packagePolicy = exactRecord(
    policy.package,
    ['name', 'version', 'releaseTag', 'tarballName', 'integrity'],
    'package',
  );
  if (packagePolicy.name !== '@ashlr/hub') fail('package.name must be @ashlr/hub');
  const candidateVersion = version(packagePolicy.version, 'package.version');
  if (policy.policyId !== `ashlr-release-successor-v1:${candidateVersion}`) {
    fail('policyId must match package.version');
  }
  if (packagePolicy.releaseTag !== `v${candidateVersion}`) {
    fail('package.releaseTag must match package.version');
  }
  if (packagePolicy.tarballName !== `ashlr-hub-${candidateVersion}.tgz`) {
    fail('package.tarballName must match package.version');
  }
  integrity(packagePolicy.integrity, 'package.integrity');

  const release = exactRecord(
    policy.release,
    ['distTag', 'requiredProtectedBranch', 'requiredFirstParentRevision', 'rollback'],
    'release',
  );
  if (release.distTag !== 'candidate') fail('release.distTag must be candidate');
  if (release.requiredProtectedBranch !== 'master') {
    fail('release.requiredProtectedBranch must be master');
  }
  revision(release.requiredFirstParentRevision, 'release.requiredFirstParentRevision');
  const rollback = exactRecord(
    release.rollback,
    ['version', 'releaseTag', 'revision', 'tree', 'integrity'],
    'release.rollback',
  );
  const rollbackVersion = version(rollback.version, 'release.rollback.version');
  if (rollback.releaseTag !== `v${rollbackVersion}`) {
    fail('release.rollback.releaseTag must match its version');
  }
  revision(rollback.revision, 'release.rollback.revision');
  revision(rollback.tree, 'release.rollback.tree');
  integrity(rollback.integrity, 'release.rollback.integrity');
  if (compareVersions(candidateVersion, rollbackVersion) <= 0) {
    fail('package.version must be newer than release.rollback.version');
  }

  const registry = exactRecord(
    policy.registry,
    ['url', 'baselineLatest', 'previousCandidate', 'quarantined', 'failedCandidates'],
    'registry',
  );
  if (registry.url !== 'https://registry.npmjs.org/') {
    fail('registry.url must be the canonical public npm registry');
  }
  const baseline = validateArtifact(registry.baselineLatest, 'registry.baselineLatest');
  const previous = validateArtifact(registry.previousCandidate, 'registry.previousCandidate');
  const rollbackArtifact = {
    version: rollback.version,
    releaseTag: rollback.releaseTag,
    revision: rollback.revision,
    integrity: rollback.integrity,
  };
  if (!sameArtifact(baseline, rollbackArtifact) || !sameArtifact(previous, rollbackArtifact)) {
    fail('registry baseline and previous candidate must equal the exact rollback artifact');
  }

  const quarantined = exactArray(registry.quarantined, 'registry.quarantined', 1, 16);
  for (const [index, item] of quarantined.entries()) {
    validateArtifact(item, `registry.quarantined[${index}]`);
  }
  validateOrderedHistory(quarantined, 'registry.quarantined', candidateVersion, rollbackVersion);

  const failedCandidates = exactArray(
    registry.failedCandidates,
    'registry.failedCandidates',
    1,
    16,
  );
  for (const [index, item] of failedCandidates.entries()) {
    const label = `registry.failedCandidates[${index}]`;
    const failed = exactRecord(item, [
      'version',
      'releaseTag',
      'tagRevision',
      'attemptReceiptSha256',
      'npmVersionAbsent',
      'githubReleaseAbsent',
    ], label);
    const failedVersion = version(failed.version, `${label}.version`);
    if (failed.releaseTag !== `v${failedVersion}`) {
      fail(`${label}.releaseTag must match its version`);
    }
    revision(failed.tagRevision, `${label}.tagRevision`);
    exactString(
      failed.attemptReceiptSha256,
      `${label}.attemptReceiptSha256`,
      SHA256_RE,
      64,
    );
    if (failed.npmVersionAbsent !== true || failed.githubReleaseAbsent !== true) {
      fail(`${label} absence declarations must be true`);
    }
  }
  validateOrderedHistory(failedCandidates, 'registry.failedCandidates', candidateVersion, rollbackVersion);

  const historyVersions = new Set(quarantined.map((entry) => entry.version));
  const historyRevisions = new Set([rollback.revision]);
  for (const item of quarantined) {
    if (historyRevisions.has(item.revision)) {
      fail('quarantined, failed, and rollback revisions must be disjoint');
    }
    historyRevisions.add(item.revision);
  }
  for (const failed of failedCandidates) {
    if (historyVersions.has(failed.version)) {
      fail('quarantined and failed candidate versions must be disjoint');
    }
    if (historyRevisions.has(failed.tagRevision)) {
      fail('quarantined, failed, and rollback revisions must be disjoint');
    }
    historyVersions.add(failed.version);
    historyRevisions.add(failed.tagRevision);
  }

  const localVerification = exactRecord(policy.localVerification, [
    'kind',
    'contractPath',
    'contractSha256',
    'requiredReceiptSchemaVersion',
  ], 'localVerification');
  if (localVerification.kind !== 'local-production-gate-v1') {
    fail('localVerification.kind must be local-production-gate-v1');
  }
  if (localVerification.contractPath !== 'ashlr.verify.json') {
    fail('localVerification.contractPath must be ashlr.verify.json');
  }
  if (![1, 2].includes(localVerification.requiredReceiptSchemaVersion)) {
    fail('localVerification.requiredReceiptSchemaVersion must be 1 or 2');
  }
  exactString(
    localVerification.contractSha256,
    'localVerification.contractSha256',
    SHA256_RE,
    64,
  );

  const toolchain = exactRecord(policy.toolchain, ['nodeVersion', 'npmVersion'], 'toolchain');
  const nodeVersion = version(toolchain.nodeVersion, 'toolchain.nodeVersion');
  const npmVersion = version(toolchain.npmVersion, 'toolchain.npmVersion');
  if (versionTuple(nodeVersion)[0] < 24n || versionTuple(npmVersion)[0] < 11n) {
    fail('toolchain must use Node 24+ and npm 11+');
  }

  const runtime = exactRecord(policy.runtime, [
    'candidateManifestSchemaVersion',
    'rollbackManifestSchemaVersions',
    'stoppedConsumerProtocol',
  ], 'runtime');
  const rollbackManifestSchemas = exactArray(
    runtime.rollbackManifestSchemaVersions,
    'runtime.rollbackManifestSchemaVersions',
    2,
    2,
  );
  if (runtime.candidateManifestSchemaVersion !== 3
    || rollbackManifestSchemas[0] !== 2
    || rollbackManifestSchemas[1] !== 3
    || runtime.stoppedConsumerProtocol !== 'runtime-activation-stopped-consumer-v2') {
    fail('runtime compatibility must preserve v3 candidates and exact v2/v3 rollback support');
  }

  const authority = exactRecord(policy.authority, [
    'kind',
    'publish',
    'promote',
    'install',
    'activate',
    'dispatch',
    'providerEffects',
  ], 'authority');
  if (authority.kind !== 'evidence-only'
    || Object.entries(RELEASE_SUCCESSOR_POLICY_AUTHORITY)
      .some(([key, expected]) => authority[key] !== expected)) {
    fail('authority must remain evidence-only with every effect false');
  }

  return policy;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export function parseReleaseSuccessorPolicyBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_POLICY_BYTES) {
    fail(`policy bytes must contain 2-${MAX_POLICY_BYTES} bytes`);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('policy bytes must be valid UTF-8');
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('policy bytes must contain one JSON document');
  }
  validateReleaseSuccessorPolicy(parsed);
  const canonicalBytes = Buffer.from(`${canonicalizeReleaseSuccessorPolicy(parsed)}\n`, 'utf8');
  if (!bytes.equals(canonicalBytes)) fail('policy bytes must be canonical JSON followed by one LF');
  return Object.freeze({
    policy: deepFreeze(parsed),
    canonicalSha256: createHash('sha256').update(canonicalBytes).digest('hex'),
  });
}

function parseCli(argv) {
  if (argv.length < 1 || argv.length > 4) fail('usage: verify-release-policy.mjs <path> [--expect-version <x.y.z>] [--json]');
  const result = { path: argv[0], expectedVersion: null, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--json' && result.json === false) {
      result.json = true;
    } else if (argv[index] === '--expect-version' && result.expectedVersion === null
      && index + 1 < argv.length) {
      result.expectedVersion = version(argv[index + 1], '--expect-version');
      index += 1;
    } else {
      fail('usage: verify-release-policy.mjs <path> [--expect-version <x.y.z>] [--json]');
    }
  }
  return result;
}

export function verifyReleaseSuccessorPolicyFile(path, expectedVersion = null) {
  const result = parseReleaseSuccessorPolicyBytes(readFileSync(path));
  if (expectedVersion !== null && result.policy.package.version !== expectedVersion) {
    fail('package.version does not match --expect-version');
  }
  return result;
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const result = verifyReleaseSuccessorPolicyFile(options.path, options.expectedVersion);
  const receipt = {
    ok: true,
    schemaVersion: RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION,
    policyId: result.policy.policyId,
    version: result.policy.package.version,
    releaseTag: result.policy.package.releaseTag,
    canonicalSha256: result.canonicalSha256,
    authority: RELEASE_SUCCESSOR_POLICY_AUTHORITY,
  };
  process.stdout.write(options.json
    ? `${JSON.stringify(receipt)}\n`
    : `${receipt.canonicalSha256}  ${receipt.policyId}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'release successor policy: failed'}\n`);
    process.exitCode = 1;
  }
}
