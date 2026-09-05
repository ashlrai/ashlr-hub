#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const REVISION_RE = /^[0-9a-f]{40}$/u;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const LOCAL_PRODUCTION_GATE_RECEIPT_SCHEMA_VERSION = 1;
export const LOCAL_PRODUCTION_GATE_AUTHORITY = Object.freeze({
  activate: false,
  dispatch: false,
  install: false,
  promote: false,
  providerEffects: false,
  publish: false,
});
export const LOCAL_PRODUCTION_GATE_COMMANDS = Object.freeze([
  ['install-root', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], '.', 600_000],
  ['install-raycast', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'src/raycast', 600_000],
  ['typecheck', ['npm', 'run', 'typecheck'], '.', 300_000],
  ['lint', ['npm', 'run', 'lint'], '.', 300_000],
  ['build', ['npm', 'run', 'build'], '.', 600_000],
  ['test-ci-1-of-3', ['npm', 'run', 'test:ci', '--', '--shard=1/3'], '.', 1_200_000],
  ['test-ci-2-of-3', ['npm', 'run', 'test:ci', '--', '--shard=2/3'], '.', 1_200_000],
  ['test-ci-3-of-3', ['npm', 'run', 'test:ci', '--', '--shard=3/3'], '.', 1_200_000],
  ['test-web', ['npm', 'run', 'test:web'], '.', 600_000],
  ['audit-root-full', ['bash', 'scripts/npm-audit-with-osv-fallback.sh', 'root full graph', 'package-lock.json'], '.', 300_000],
  ['audit-root-production', ['bash', 'scripts/npm-audit-with-osv-fallback.sh', 'root production graph', 'package-lock.json', '--omit=dev'], '.', 300_000],
  ['audit-raycast-full', ['bash', '../../scripts/npm-audit-with-osv-fallback.sh', 'Raycast full graph', 'package-lock.json'], 'src/raycast', 300_000],
  ['audit-raycast-production', ['bash', '../../scripts/npm-audit-with-osv-fallback.sh', 'Raycast production graph', 'package-lock.json', '--omit=dev'], 'src/raycast', 300_000],
  ['pack-smoke', ['node', 'scripts/run-local-pack-smoke.mjs', '--repo', '{repo}', '--work-dir', '{temp}/pack-smoke', '--output', '{temp}/pack-evidence.json'], '.', 600_000],
  ['native-fetch', ['cargo', 'fetch', '--locked'], 'desktop/src-tauri', 1_200_000],
  ['native-fmt', ['cargo', 'fmt', '--check'], 'desktop/src-tauri', 300_000],
  ['native-check', ['cargo', 'check', '--locked', '--offline', '--all-targets'], 'desktop/src-tauri', 1_200_000],
  ['native-clippy', ['cargo', 'clippy', '--locked', '--offline', '--all-targets', '--', '-D', 'warnings'], 'desktop/src-tauri', 1_200_000],
  ['native-test', ['cargo', 'test', '--locked', '--offline'], 'desktop/src-tauri', 1_200_000],
  ['native-audit', ['cargo-audit', 'audit', '--file', 'Cargo.lock', '--ignore', 'RUSTSEC-2024-0429'], 'desktop/src-tauri', 600_000],
]);
export const LOCAL_PRODUCTION_GATE_IDS = Object.freeze(
  LOCAL_PRODUCTION_GATE_COMMANDS.map(([id]) => id),
);
export const LOCAL_PRODUCTION_GATE_NETWORK_ENABLED_IDS = Object.freeze([
  'install-root', 'install-raycast',
  'audit-root-full', 'audit-root-production', 'audit-raycast-full', 'audit-raycast-production',
  'native-fetch', 'native-audit',
]);

function fail(message) {
  throw new Error(`local production gate receipt: ${message}`);
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getPrototypeOf(value) !== Object.prototype
    || ownKeys.some((key) => typeof key !== 'string')) {
    fail(`${label} must be a plain string-keyed object`);
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

function exactString(value, pattern, label, maxBytes = 512) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function exactFalseAuthority(value, label = 'authority') {
  const authority = exactRecord(value, Object.keys(LOCAL_PRODUCTION_GATE_AUTHORITY), label);
  if (Object.entries(LOCAL_PRODUCTION_GATE_AUTHORITY)
    .some(([key, expected]) => authority[key] !== expected)) {
    fail(`${label} must keep every effect false`);
  }
  return authority;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function canonicalizeLocalProductionGateReceipt(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('canonical JSON numbers must be safe integers');
    return String(value);
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    const expected = [...Array(value.length).keys()].map(String).concat('length');
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      fail('canonical JSON arrays must be dense and undecorated');
    }
    return `[${value.map((entry) => canonicalizeLocalProductionGateReceipt(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Reflect.ownKeys(value);
    if (Object.getPrototypeOf(value) !== Object.prototype
      || keys.some((key) => typeof key !== 'string')) {
      fail('canonical JSON objects must be plain and string-keyed');
    }
    return `{${keys.toSorted().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        fail('canonical JSON accepts enumerable data properties only');
      }
      return `${JSON.stringify(key)}:${canonicalizeLocalProductionGateReceipt(descriptor.value)}`;
    }).join(',')}}`;
  }
  fail('canonical JSON contains an unsupported value');
}

function validateIso(value, label) {
  exactString(value, ISO_RE, label, 24);
  if (new Date(value).toISOString() !== value) fail(`${label} is not a canonical instant`);
}

export function validateLocalProductionGateReceipt(value) {
  const receipt = exactRecord(value, [
    'schemaVersion', 'kind', 'assurance', 'source', 'toolchain', 'bindings',
    'execution', 'gates', 'authority', 'verdict',
  ], 'receipt');
  if (receipt.schemaVersion !== LOCAL_PRODUCTION_GATE_RECEIPT_SCHEMA_VERSION
    || receipt.kind !== 'ashlr-local-production-gate-receipt-v1'
    || receipt.assurance !== 'local-source-verification-only'
    || receipt.verdict !== 'passed') {
    fail('receipt identity or verdict is invalid');
  }

  const source = exactRecord(receipt.source, ['revision', 'tree', 'cleanBefore', 'cleanAfter'], 'source');
  exactString(source.revision, REVISION_RE, 'source.revision', 40);
  exactString(source.tree, REVISION_RE, 'source.tree', 40);
  if (source.cleanBefore !== true || source.cleanAfter !== true) fail('source must be clean before and after');

  const toolchain = exactRecord(receipt.toolchain, [
    'nodeVersion', 'npmVersion', 'rustcVersion', 'cargoVersion', 'cargoAuditVersion',
    'executables',
  ], 'toolchain');
  exactString(toolchain.nodeVersion, SEMVER_RE, 'toolchain.nodeVersion', 32);
  exactString(toolchain.npmVersion, SEMVER_RE, 'toolchain.npmVersion', 32);
  for (const key of ['rustcVersion', 'cargoVersion', 'cargoAuditVersion']) {
    exactString(toolchain[key], /^[^\r\n]{1,160}$/u, `toolchain.${key}`, 160);
  }
  if (toolchain.cargoAuditVersion !== 'cargo-audit 0.22.2') {
    fail('toolchain.cargoAuditVersion must be cargo-audit 0.22.2');
  }
  if (Number(toolchain.nodeVersion.split('.')[0]) < 24
    || Number(toolchain.npmVersion.split('.')[0]) < 11) {
    fail('toolchain must use Node 24+ and npm 11+');
  }
  const executables = exactRecord(toolchain.executables, [
    'node', 'npmCli', 'npmRuntime', 'bash', 'git', 'rustc', 'rustdoc', 'cargo',
    'cargoAudit', 'osvScanner', 'sandboxExec',
  ], 'toolchain.executables');
  for (const [name, executableValue] of Object.entries(executables)) {
    const executable = exactRecord(executableValue, ['path', 'sha256'], `toolchain.executables.${name}`);
    exactString(executable.path, /^\/.{1,1023}$/u, `toolchain.executables.${name}.path`, 1024);
    exactString(executable.sha256, SHA256_RE, `toolchain.executables.${name}.sha256`, 64);
  }

  const bindings = exactRecord(receipt.bindings, ['policy', 'contract', 'package'], 'bindings');
  const policy = exactRecord(bindings.policy, ['policyId', 'version', 'sha256'], 'bindings.policy');
  exactString(policy.policyId, /^ashlr-release-successor-v1:(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u, 'bindings.policy.policyId');
  exactString(policy.version, SEMVER_RE, 'bindings.policy.version', 32);
  exactString(policy.sha256, SHA256_RE, 'bindings.policy.sha256', 64);
  if (policy.policyId !== `ashlr-release-successor-v1:${policy.version}`) fail('policy id/version drift');
  const contract = exactRecord(bindings.contract, ['path', 'sha256'], 'bindings.contract');
  if (contract.path !== 'ashlr.verify.json') fail('contract path must be ashlr.verify.json');
  exactString(contract.sha256, SHA256_RE, 'bindings.contract.sha256', 64);
  const pkg = exactRecord(bindings.package, [
    'name', 'version', 'tarballName', 'sha256', 'integrity',
  ], 'bindings.package');
  if (pkg.name !== '@ashlr/hub') fail('package name must be @ashlr/hub');
  exactString(pkg.version, SEMVER_RE, 'bindings.package.version', 32);
  if (pkg.version !== policy.version || pkg.tarballName !== `ashlr-hub-${pkg.version}.tgz`) {
    fail('package identity must match the policy version');
  }
  exactString(pkg.sha256, SHA256_RE, 'bindings.package.sha256', 64);
  exactString(pkg.integrity, INTEGRITY_RE, 'bindings.package.integrity', 95);

  const execution = exactRecord(receipt.execution, [
    'startedAt', 'finishedAt', 'hostPlatform', 'networkIsolation', 'networkEnabledGateIds',
    'filesystemIsolation', 'sandboxProfiles', 'externalEffects', 'operationalAshlrHome',
    'disposableSidecar',
  ], 'execution');
  validateIso(execution.startedAt, 'execution.startedAt');
  validateIso(execution.finishedAt, 'execution.finishedAt');
  if (Date.parse(execution.finishedAt) < Date.parse(execution.startedAt)
    || execution.hostPlatform !== 'darwin'
    || execution.networkIsolation !== 'non-loopback-ip-egress-denied-for-source-gates'
    || execution.filesystemIsolation !== 'write-allowlist-and-user-home-read-deny;host-ipc-system-reads-and-hostile-env-clearing-descendants-not-isolated'
    || execution.externalEffects !== 'evidence-writes-recorded;same-uid-output-parent-swap-and-other-effects-not-attested'
    || execution.operationalAshlrHome !== 'redirected-to-disposable-root'
    || execution.disposableSidecar !== 'created-exclusive-and-removed-before-receipt') {
    fail('execution boundary is invalid');
  }
  if (!Array.isArray(execution.networkEnabledGateIds)
    || execution.networkEnabledGateIds.length !== LOCAL_PRODUCTION_GATE_NETWORK_ENABLED_IDS.length
    || execution.networkEnabledGateIds.some(
      (id, index) => id !== LOCAL_PRODUCTION_GATE_NETWORK_ENABLED_IDS[index],
    )) {
    fail('network-enabled gate set is invalid');
  }
  const networkArrayKeys = Reflect.ownKeys(execution.networkEnabledGateIds);
  const expectedNetworkArrayKeys = [...Array(execution.networkEnabledGateIds.length).keys()]
    .map(String).concat('length');
  if (networkArrayKeys.length !== expectedNetworkArrayKeys.length
    || networkArrayKeys.some((key, index) => key !== expectedNetworkArrayKeys[index])) {
    fail('network-enabled gate set must be dense and undecorated');
  }
  const sandboxProfiles = exactRecord(execution.sandboxProfiles, [
    'networkEnabledSha256', 'networkDeniedSha256',
  ], 'execution.sandboxProfiles');
  exactString(sandboxProfiles.networkEnabledSha256, SHA256_RE, 'execution.sandboxProfiles.networkEnabledSha256', 64);
  exactString(sandboxProfiles.networkDeniedSha256, SHA256_RE, 'execution.sandboxProfiles.networkDeniedSha256', 64);

  if (!Array.isArray(receipt.gates) || receipt.gates.length !== LOCAL_PRODUCTION_GATE_IDS.length) {
    fail('gates must contain the complete ordered local gate');
  }
  const arrayKeys = Reflect.ownKeys(receipt.gates);
  const expectedArrayKeys = [...Array(receipt.gates.length).keys()].map(String).concat('length');
  if (arrayKeys.length !== expectedArrayKeys.length
    || arrayKeys.some((key, index) => key !== expectedArrayKeys[index])) {
    fail('gates must be a dense array without extra properties');
  }
  let priorFinishedAt = Date.parse(execution.startedAt);
  const executionFinishedAt = Date.parse(execution.finishedAt);
  for (const [index, gateValue] of receipt.gates.entries()) {
    const label = `gates[${index}]`;
    const gate = exactRecord(gateValue, [
      'id', 'commandSha256', 'startedAt', 'finishedAt', 'durationMs', 'exitCode',
      'stdoutSha256', 'stderrSha256',
    ], label);
    if (gate.id !== LOCAL_PRODUCTION_GATE_IDS[index]) fail(`${label}.id is out of order`);
    for (const key of ['commandSha256', 'stdoutSha256', 'stderrSha256']) {
      exactString(gate[key], SHA256_RE, `${label}.${key}`, 64);
    }
    const [, expectedCmd, expectedCwd] = LOCAL_PRODUCTION_GATE_COMMANDS[index];
    const expectedCommandSha256 = createHash('sha256')
      .update(Buffer.from(JSON.stringify({ argv: expectedCmd, cwd: expectedCwd }), 'utf8'))
      .digest('hex');
    if (gate.commandSha256 !== expectedCommandSha256) {
      fail(`${label}.commandSha256 does not bind the closed v1 command`);
    }
    validateIso(gate.startedAt, `${label}.startedAt`);
    validateIso(gate.finishedAt, `${label}.finishedAt`);
    const gateStartedAt = Date.parse(gate.startedAt);
    const gateFinishedAt = Date.parse(gate.finishedAt);
    if (!Number.isSafeInteger(gate.durationMs) || gate.durationMs < 0
      || gate.exitCode !== 0 || gateFinishedAt < gateStartedAt
      || gate.durationMs !== gateFinishedAt - gateStartedAt
      || gateStartedAt < priorFinishedAt || gateFinishedAt > executionFinishedAt) {
      fail(`${label} did not record one successful bounded execution`);
    }
    priorFinishedAt = gateFinishedAt;
  }
  exactFalseAuthority(receipt.authority);
  return receipt;
}

export function parseLocalProductionGateReceiptBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_RECEIPT_BYTES) {
    fail(`receipt bytes must contain 2-${MAX_RECEIPT_BYTES} bytes`);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('receipt bytes must be valid UTF-8');
  }
  let receipt;
  try {
    receipt = JSON.parse(source);
  } catch {
    fail('receipt bytes must contain one JSON document');
  }
  validateLocalProductionGateReceipt(receipt);
  const canonicalBytes = Buffer.from(`${canonicalizeLocalProductionGateReceipt(receipt)}\n`, 'utf8');
  if (!bytes.equals(canonicalBytes)) fail('receipt must be canonical JSON followed by one LF');
  return Object.freeze({
    receipt: deepFreeze(receipt),
    sha256: createHash('sha256').update(canonicalBytes).digest('hex'),
  });
}

export function verifyPersistedArtifact(parsed, artifactPath) {
  if (!isAbsolute(artifactPath)) fail('artifact path must be absolute');
  const artifact = lstatSync(artifactPath);
  if (!artifact.isFile() || artifact.isSymbolicLink()
    || artifact.size < 1 || artifact.size > MAX_ARTIFACT_BYTES) {
    fail(`artifact bytes must contain 1-${MAX_ARTIFACT_BYTES} bytes`);
  }
  const bytes = readFileSync(artifactPath);
  const expected = parsed.receipt.bindings.package;
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  const actualIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (basename(artifactPath) !== expected.tarballName
    || actualSha256 !== expected.sha256 || actualIntegrity !== expected.integrity) {
    fail('persisted artifact does not match the receipt binding');
  }
  return parsed;
}

export function parseCli(argv) {
  if (argv.length < 1 || argv.length % 2 === 0) {
    fail('usage: verify-local-production-gate-receipt.mjs <receipt> --artifact <tgz> plus all six --expect-* pins');
  }
  const options = { path: resolve(argv[0]), expected: {} };
  const flags = new Map([
    ['--artifact', 'artifactPath'],
    ['--expect-revision', 'revision'],
    ['--expect-tree', 'tree'],
    ['--expect-policy-sha256', 'policySha256'],
    ['--expect-contract-sha256', 'contractSha256'],
    ['--expect-tarball-integrity', 'integrity'],
    ['--expect-receipt-sha256', 'receiptSha256'],
  ]);
  for (let index = 1; index < argv.length; index += 2) {
    const key = flags.get(argv[index]);
    if (!key || (key === 'artifactPath' ? options.artifactPath : options.expected[key]) !== undefined
      || argv[index + 1] === undefined) {
      fail(`invalid or duplicate option ${argv[index] ?? '<missing>'}`);
    }
    if (key === 'artifactPath') options.artifactPath = argv[index + 1];
    else options.expected[key] = argv[index + 1];
  }
  if (!options.artifactPath || !isAbsolute(options.artifactPath)
    || Object.keys(options.expected).length !== flags.size - 1) {
    fail('--artifact and all six independent --expect-* binding pins are required');
  }
  options.artifactPath = resolve(options.artifactPath);
  return options;
}

export function verifyExpectedReceiptBindings(parsed, expected) {
  exactRecord(expected, [
    'revision', 'tree', 'policySha256', 'contractSha256', 'integrity', 'receiptSha256',
  ], 'caller pins');
  const actual = {
    revision: parsed.receipt.source.revision,
    tree: parsed.receipt.source.tree,
    policySha256: parsed.receipt.bindings.policy.sha256,
    contractSha256: parsed.receipt.bindings.contract.sha256,
    integrity: parsed.receipt.bindings.package.integrity,
    receiptSha256: parsed.sha256,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) fail(`${key} does not match the caller pin`);
  }
  return parsed;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  try {
    const options = parseCli(process.argv.slice(2));
    const receiptFile = lstatSync(options.path);
    if (!receiptFile.isFile() || receiptFile.isSymbolicLink()
      || receiptFile.size < 2 || receiptFile.size > MAX_RECEIPT_BYTES) {
      fail(`receipt file must contain 2-${MAX_RECEIPT_BYTES} bytes and not be a symlink`);
    }
    const parsed = parseLocalProductionGateReceiptBytes(readFileSync(options.path));
    verifyPersistedArtifact(parsed, options.artifactPath);
    verifyExpectedReceiptBindings(parsed, options.expected);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      receiptSha256: parsed.sha256,
      revision: parsed.receipt.source.revision,
      tree: parsed.receipt.source.tree,
      packageIntegrity: parsed.receipt.bindings.package.integrity,
      authority: parsed.receipt.authority,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
