#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SIGNED_RELEASE_CANARY_SCHEMA_VERSION = 1;
export const SIGNED_RELEASE_CANARY_ASSURANCE = 'signed-observation-only';
export const SIGNED_RELEASE_CANARY_REPETITIONS = 2;
export const SIGNED_RELEASE_CANARY_ENVELOPE_LIFETIME_MS = 10 * 60 * 1_000;
export const SIGNED_RELEASE_CANARY_KEY_LIFETIME_MS = 15 * 60 * 1_000;

const REVISION_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ED25519_SPKI_BASE64URL_RE = /^[A-Za-z0-9_-]{59}$/;
const ED25519_SIGNATURE_BASE64URL_RE = /^[A-Za-z0-9_-]{86}$/;
const MAX_REF_BYTES = 256;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_SOURCE_DIRECTORIES = 2_048;
const MAX_SOURCE_ENTRIES = 32_768;
const MAX_SOURCE_DEPTH = 64;
const NPM_TIMEOUT_MS = 5 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 60 * 1_000;
const PACKAGE_NAME = '@ashlr/hub';
export const SIGNED_RELEASE_CANARY_RECEIPT_SIGNATURE_DOMAIN = 'ashlr:local-release-canary-receipt:v1';
export const SIGNED_RELEASE_CANARY_PAIR_AUTHORITY_BLOCKERS = Object.freeze([
  'protected-remote-pr-unbound',
  'signed-source-and-diff-unbound',
  'verification-commands-unbound',
  'activation-scope-caps-unbound',
  'post-merge-observations-unbound',
  'deployment-consumer-absent',
  'rollback-consumer-absent',
  'activation-authority-unbound',
]);
const INVENTORY_PATH = 'dist/release-dependency-inventory.json';
const PUBLIC_EXPORTS = Object.freeze([
  '@ashlr/hub',
  '@ashlr/hub/core',
  '@ashlr/hub/types',
  '@ashlr/hub/plugin',
]);

export const NO_AUTHORITY = Object.freeze({
  activationPermitted: false,
  activeRuntimeInstallPermitted: false,
  deployPermitted: false,
  externalMutationPermitted: false,
  installPermitted: false,
  launchPermitted: false,
  publishPermitted: false,
  rollbackPermitted: false,
  serviceMutationPermitted: false,
  startPermitted: false,
  tagPermitted: false,
});

function fail(message) {
  throw new Error(`signed release canary: ${message}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function boundedError(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= MAX_ERROR_BYTES ? text.trim() : `${text.slice(0, MAX_ERROR_BYTES).trim()}…`;
}

function inside(root, candidate) {
  const nested = relative(root, candidate);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

function exactRegularFile(path, root, label) {
  const canonicalRoot = realpathSync(root);
  const canonicalPath = realpathSync(path);
  if (!inside(canonicalRoot, canonicalPath)) fail(`${label} escaped the temporary root`);
  const stat = lstatSync(canonicalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(`${label} is not a canonical single-link regular file`);
  }
  return canonicalPath;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) fail(`${options.label} could not execute: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${options.label} failed (${String(result.status)}): ${boundedError(result.stderr)}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function validateRef(value, label) {
  if (typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_REF_BYTES || value.startsWith('-') ||
    /[\0\r\n]/.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

export function parseCanaryArgs(argv) {
  const result = {
    candidate: null,
    expectedRevision: null,
    help: false,
    rollback: null,
    trustedProtectedSource: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--trusted-protected-source') {
      result.trustedProtectedSource = true;
      continue;
    }
    if (arg !== '--candidate' && arg !== '--expected-revision' && arg !== '--rollback') {
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
    const value = argv[index + 1];
    if (value === undefined) fail(`${arg} requires a value`);
    index += 1;
    if (arg === '--candidate') result.candidate = validateRef(value, 'candidate revision');
    if (arg === '--rollback') result.rollback = validateRef(value, 'rollback revision');
    if (arg === '--expected-revision') {
      if (!REVISION_RE.test(value)) fail('expected revision must be 40 lowercase hexadecimal characters');
      result.expectedRevision = value;
    }
  }
  if (!result.help) {
    if (!REVISION_RE.test(result.candidate ?? '')) fail('candidate must be an exact 40-character commit SHA');
    if (!REVISION_RE.test(result.expectedRevision ?? '')) fail('--expected-revision is required');
    if (result.candidate !== result.expectedRevision) fail('candidate must exactly match --expected-revision');
    if (result.rollback !== null && !REVISION_RE.test(result.rollback)) {
      fail('rollback must be an exact 40-character commit SHA');
    }
    if (!result.trustedProtectedSource) {
      fail('--trusted-protected-source is required because OS confinement is not enforced');
    }
  }
  return result;
}

export function buildIsolatedEnvironment(baseEnv, tempRoot, revision) {
  if (!REVISION_RE.test(revision)) fail('isolated environment revision is invalid');
  const root = realpathSync(tempRoot);
  const home = join(root, 'home');
  const cache = join(root, 'npm-cache');
  const prefix = join(root, 'npm-prefix');
  const temporary = join(root, 'tmp');
  const userConfig = join(root, 'npmrc');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  writeFileSync(userConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const environment = Object.create(null);
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) {
    if (typeof baseEnv[name] === 'string') environment[name] = baseEnv[name];
  }
  Object.assign(environment, {
    ASHLR_HOME: join(home, '.ashlr'),
    CI: 'true',
    HOME: home,
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_USERCONFIG: userConfig,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
  });
  return environment;
}

function resolveTarBinary() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    fail(`unsupported platform ${process.platform}; only explicitly checked Darwin and Linux tar are supported`);
  }
  const expected = process.platform === 'darwin' ? /bsdtar|libarchive/i : /GNU tar/i;
  for (const candidate of ['/usr/bin/tar', '/bin/tar']) {
    try {
      const canonical = realpathSync(candidate);
      const stat = lstatSync(canonical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) continue;
      const result = spawnSync(canonical, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result.status === 0 && expected.test(`${result.stdout}\n${result.stderr}`)) return canonical;
    } catch {
      // Try the next fixed system path.
    }
  }
  fail(`a checked ${process.platform === 'darwin' ? 'bsdtar' : 'GNU tar'} binary is required`);
}

export function assertPlainExtractedTree(root, label = 'extracted source') {
  const canonicalRoot = realpathSync(root);
  const rootStat = lstatSync(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`${label} root is not a canonical directory`);
  const pending = [{ depth: 0, path: canonicalRoot }];
  let directories = 0;
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    directories += 1;
    if (directories > MAX_SOURCE_DIRECTORIES || current.depth > MAX_SOURCE_DEPTH) {
      fail(`${label} exceeds traversal limits`);
    }
    const directory = opendirSync(current.path);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        entries += 1;
        if (entries > MAX_SOURCE_ENTRIES) fail(`${label} exceeds entry limits`);
        const path = join(current.path, entry.name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) fail(`${label} contains a symbolic link`);
        if (stat.isDirectory()) {
          pending.push({ depth: current.depth + 1, path });
        } else if (!stat.isFile()) {
          fail(`${label} contains a special file`);
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  return { directories, entries };
}

function resolveNpmCli(baseEnv) {
  const declared = baseEnv.npm_execpath;
  if (typeof declared !== 'string' || !isAbsolute(declared) || /[\0\r\n]/.test(declared)) {
    fail('run through `npm run release:canary` so npm_execpath is bound');
  }
  const canonical = realpathSync(declared);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) {
    fail('npm_execpath is not a bounded canonical regular file');
  }
  return canonical;
}

export function assertCanaryNpmArguments(args, tempRoot) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string' || /[\0\r\n]/.test(entry))) {
    fail('npm arguments are invalid');
  }
  const command = args[0];
  if (!['ci', 'run', 'pack', 'install'].includes(command)) fail(`npm command ${String(command)} is forbidden`);
  if (command === 'run' && (args.length !== 2 || args[1] !== 'build')) {
    fail('only the repository build npm script is allowed');
  }
  if (args.includes('--global') || args.includes('-g') || args.includes('publish') || args.includes('tag')) {
    fail('npm mutation arguments are forbidden');
  }
  if (command === 'install') {
    const prefixIndex = args.indexOf('--prefix');
    if (prefixIndex < 0 || typeof args[prefixIndex + 1] !== 'string') fail('temporary install prefix is required');
    const root = realpathSync(tempRoot);
    const requested = resolve(args[prefixIndex + 1]);
    if (!inside(root, requested) || requested === root) fail('install prefix escaped the canary root');
    if (!args.includes('--offline') || !args.includes('--ignore-scripts') || !args.includes('--omit=dev')) {
      fail('temporary install must be offline, production-only, and script-free');
    }
  }
}

function runNpm(npmCli, args, options) {
  assertCanaryNpmArguments(args, options.tempRoot);
  return run(process.execPath, [npmCli, ...args], {
    ...options,
    timeoutMs: NPM_TIMEOUT_MS,
  });
}

function resolveRevision(repoRoot, ref, environment) {
  const result = run('git', ['rev-parse', '--verify', `${validateRef(ref, 'revision')}^{commit}`], {
    cwd: repoRoot,
    env: environment,
    label: 'resolve release revision',
  }).stdout.trim();
  if (!REVISION_RE.test(result)) fail('resolved release revision is invalid');
  return result;
}

export async function withReleasePipelineUmask(runPipeline) {
  if (typeof runPipeline !== 'function') fail('release pipeline is required');
  const priorUmask = process.umask(0o022);
  try {
    return await runPipeline();
  } finally {
    process.umask(priorUmask);
  }
}

export function releaseArchiveArguments(archive, revision) {
  return ['-c', 'tar.umask=0022', 'archive', '--format=tar', `--output=${archive}`, revision];
}

function extractRevision(repoRoot, revision, sourceRoot, tempRoot, environment, tarBinary) {
  const archive = join(tempRoot, `${revision}-${sha256(sourceRoot).slice(0, 16)}.tar`);
  run('git', releaseArchiveArguments(archive, revision), {
    cwd: repoRoot,
    env: environment,
    label: 'archive immutable release source',
  });
  exactRegularFile(archive, tempRoot, 'release source archive');
  mkdirSync(sourceRoot, { recursive: false, mode: 0o700 });
  run(tarBinary, ['-xf', archive, '-C', sourceRoot], {
    cwd: repoRoot,
    env: environment,
    label: 'extract immutable release source',
  });
  rmSync(archive);
  return assertPlainExtractedTree(sourceRoot);
}

function parsePackReport(stdout, sourceRoot, packRoot) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail('npm pack did not return JSON');
  }
  if (!Array.isArray(report) || report.length !== 1) fail('npm pack returned an ambiguous artifact set');
  const item = report[0];
  if (typeof item !== 'object' || item === null || typeof item.filename !== 'string' ||
    typeof item.integrity !== 'string' || typeof item.shasum !== 'string' ||
    !Array.isArray(item.files)) {
    fail('npm pack report is incomplete');
  }
  const paths = item.files.map((entry) => entry?.path);
  const packageManifest = readJson(join(sourceRoot, 'package.json'), 'source package manifest');
  const required = [INVENTORY_PATH, 'bin/ashlr', ...Object.values(packageManifest.exports ?? {})
    .flatMap((entry) => typeof entry === 'string' ? [entry] : Object.values(entry ?? {}))
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.replace(/^\.\//, ''))];
  if (required.some((entry) => !paths.includes(entry))) fail('npm pack omitted a required runtime or public export');
  if (paths.includes('package-lock.json')) fail('npm pack unexpectedly included the source lockfile');
  const tarball = exactRegularFile(join(packRoot, item.filename), packRoot, 'packed release');
  return { item, packageManifest, tarball };
}

async function observeInstalledRelease(input) {
  const packageRoot = realpathSync(join(input.installRoot, 'node_modules', '@ashlr', 'hub'));
  const packageManifest = readJson(join(packageRoot, 'package.json'), 'installed package manifest');
  if (packageManifest.name !== PACKAGE_NAME || packageManifest.version !== input.expectedVersion) {
    fail('installed package identity does not match the archived source');
  }
  const cli = run(process.execPath, [join(packageRoot, 'bin', 'ashlr'), 'help'], {
    cwd: input.installRoot,
    env: input.environment,
    label: 'temporary CLI smoke',
  });
  if (!/Usage:|ashlr/i.test(cli.stdout)) fail('temporary CLI smoke returned an unexpected response');
  const exportProgram = `await Promise.all(${JSON.stringify(PUBLIC_EXPORTS)}.map((name) => import(name)));`;
  run(process.execPath, ['--input-type=module', '--eval', exportProgram], {
    cwd: input.installRoot,
    env: input.environment,
    label: 'temporary public export smoke',
  });

  const inventoryApi = await import(pathToFileURL(join(
    packageRoot,
    'dist/core/daemon/runtime-release-dependency-inventory.js',
  )).href);
  const manifestApi = await import(pathToFileURL(join(
    packageRoot,
    'dist/core/daemon/runtime-release-manifest.js',
  )).href);
  const inventoryBytes = readFileSync(join(packageRoot, INVENTORY_PATH));
  const parsedInventory = inventoryApi.parseRuntimeReleaseDependencyInventory(inventoryBytes);
  if (!parsedInventory.ok) fail(`installed dependency inventory is invalid: ${parsedInventory.reason}`);
  const dependencyRoot = join(packageRoot, 'node_modules');
  const observedDependencies = inventoryApi.observeInstalledRuntimeDependencies({
    dependencyRoot,
    inventory: parsedInventory.inventory,
    expectedPackageName: PACKAGE_NAME,
    expectedPackageVersion: input.expectedVersion,
  });
  if (!observedDependencies.ok) fail(`installed dependencies are invalid: ${observedDependencies.reason}`);
  const manifest = manifestApi.buildUnsignedRuntimeReleaseManifest({
    packageRoot,
    dependencyRoot,
    declaredInterpreterPath: realpathSync(process.execPath),
    declaredInterpreterVersion: process.version,
    expectedRevision: input.revision,
    expectedPackageName: PACKAGE_NAME,
    declaredRollbackTargetDigest: input.rollbackTargetDigest,
  });
  if (!manifest.ok) fail(`runtime release manifest could not be built: ${manifest.reason}`);
  const verifiedManifest = manifestApi.verifyUnsignedRuntimeReleaseManifest({
    packageRoot,
    dependencyRoot,
    declaredInterpreterPath: realpathSync(process.execPath),
    declaredInterpreterVersion: process.version,
    expectedRevision: input.revision,
    expectedPackageName: PACKAGE_NAME,
    declaredRollbackTargetDigest: input.rollbackTargetDigest,
    manifest: manifest.canonicalJson,
    expectedManifestDigest: manifest.manifest.manifestDigest,
  });
  if (!verifiedManifest.ok) fail(`runtime release manifest did not re-verify: ${verifiedManifest.reason}`);
  return {
    apiRoot: packageRoot,
    cliOutputSha256: sha256(cli.stdout),
    dependencyInventoryDigest: observedDependencies.inventoryDigest,
    installedDependencyTreeSha256: observedDependencies.installedTreeSha256,
    manifest: manifest.canonicalJson,
    manifestDigest: manifest.manifest.manifestDigest,
    packageCount: observedDependencies.packageCount,
    publicExports: [...PUBLIC_EXPORTS],
  };
}

function comparableObservation(value) {
  const comparable = { ...value };
  delete comparable.apiRoot;
  return comparable;
}

export function assertRepeatableObservations(observations) {
  if (!Array.isArray(observations) || observations.length !== SIGNED_RELEASE_CANARY_REPETITIONS) {
    fail(`exactly ${SIGNED_RELEASE_CANARY_REPETITIONS} independent observations are required`);
  }
  const first = canonicalJson(comparableObservation(observations[0]));
  if (observations.slice(1).some((entry) => canonicalJson(comparableObservation(entry)) !== first)) {
    fail('independent pack/install observations are not byte-identical');
  }
}

async function prepareRelease(input) {
  const observations = [];
  for (let index = 0; index < SIGNED_RELEASE_CANARY_REPETITIONS; index += 1) {
    const pipeline = String(index + 1);
    const pipelineRoot = join(input.tempRoot, `pipeline-${input.role}-${pipeline}`);
    mkdirSync(pipelineRoot, { mode: 0o700 });
    const environment = buildIsolatedEnvironment(input.baseEnv, pipelineRoot, input.revision);
    const sourceRoot = join(pipelineRoot, 'source');
    const sourceTree = extractRevision(
      input.repoRoot,
      input.revision,
      sourceRoot,
      pipelineRoot,
      environment,
      input.tarBinary,
    );
    runNpm(input.npmCli, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: sourceRoot,
      env: environment,
      label: `${input.role} dependency install ${pipeline}`,
      tempRoot: pipelineRoot,
    });
    runNpm(input.npmCli, ['run', 'build'], {
      cwd: sourceRoot,
      env: environment,
      label: `${input.role} release build ${pipeline}`,
      tempRoot: pipelineRoot,
    });
    const sourcePackage = readJson(join(sourceRoot, 'package.json'), `${input.role} package manifest`);
    if (sourcePackage.name !== PACKAGE_NAME || typeof sourcePackage.version !== 'string') {
      fail(`${input.role} source package identity is invalid`);
    }
    const buildIdentity = readJson(join(sourceRoot, 'dist', 'build-identity.json'), `${input.role} build identity`);
    if (buildIdentity.revision !== null || buildIdentity.packageVersion !== sourcePackage.version ||
      buildIdentity.dirty !== null || buildIdentity.provenance !== 'unavailable') {
      fail(`${input.role} archive build identity must truthfully remain unavailable`);
    }

    const packRoot = join(pipelineRoot, 'pack');
    const installRoot = join(pipelineRoot, 'install');
    mkdirSync(packRoot, { mode: 0o700 });
    mkdirSync(installRoot, { mode: 0o700 });
    const packed = runNpm(input.npmCli, [
      'pack', '--ignore-scripts', '--json', '--pack-destination', packRoot,
    ], {
      cwd: sourceRoot,
      env: environment,
      label: `${input.role} pack ${pipeline}`,
      tempRoot: pipelineRoot,
    });
    const { item, packageManifest, tarball } = parsePackReport(packed.stdout, sourceRoot, packRoot);
    runNpm(input.npmCli, [
      'install', tarball,
      '--prefix', installRoot,
      '--ignore-scripts',
      '--omit=dev',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--save=false',
    ], {
      cwd: sourceRoot,
      env: environment,
      label: `${input.role} temporary install ${pipeline}`,
      tempRoot: pipelineRoot,
    });
    const installed = await observeInstalledRelease({
      environment,
      expectedVersion: packageManifest.version,
      installRoot,
      revision: input.revision,
      rollbackTargetDigest: input.rollbackTargetDigest,
    });
    observations.push({
      ...installed,
      archiveBuildIdentityProvenance: buildIdentity.provenance,
      extractedSourceDirectoryCount: sourceTree.directories,
      extractedSourceEntryCount: sourceTree.entries,
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
      packFileCount: item.files.length,
      packIntegrity: item.integrity,
      packSha256: sha256(readFileSync(tarball)),
      packShasum: item.shasum,
      packSize: item.size,
      unpackedSize: item.unpackedSize,
    });
  }
  assertRepeatableObservations(observations);
  return { observations, primary: observations[0] };
}

function assertNoAuthorityDecision(value, label) {
  for (const key of [
    'activationPermitted', 'deployCanaryPermitted', 'deployPermitted', 'evidenceReady',
    'executionPerformed', 'installPermitted', 'launchPermitted', 'rollbackPermitted',
    'startPermitted',
  ]) {
    if (value?.[key] === true) fail(`${label} attempted to grant ${key}`);
  }
}

function assertExactReleasePairObservationOnly(value) {
  assertNoAuthorityDecision(value, 'release-pair observer');
  if (value?.authority !== 'observation-only' || value.verdict !== 'release-pair-verified' ||
    value.releasePairVerified !== true || value.evidenceReady !== false ||
    value.deployCanaryPermitted !== false || value.rollbackPermitted !== false ||
    value.activationPermitted !== false || value.executionPerformed !== false ||
    !exactStringArray(value.authorityBlockers, SIGNED_RELEASE_CANARY_PAIR_AUTHORITY_BLOCKERS)) {
    fail('release-pair observer violated the exact observation-only authority contract');
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  return isPlainRecord(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function exactFalseAuthority(value) {
  const keys = Object.keys(NO_AUTHORITY);
  return hasExactKeys(value, keys) && keys.every((key) => value[key] === false);
}

function exactStringArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function validReleaseSummary(value) {
  const keys = [
    'cliOutputSha256', 'dependencyInventoryDigest', 'envelopeSha256', 'expectedRevision',
    'installedDependencyTreeSha256', 'keyId', 'manifestDigest', 'packFileCount',
    'packIntegrity', 'packSha256', 'packShasum', 'packSize', 'packageCount',
    'packageName', 'packageVersion', 'publicExports', 'reproducibility', 'sourceTree',
    'signatureVerified', 'unpackedSize',
  ];
  if (!hasExactKeys(value, keys)) return false;
  for (const key of [
    'cliOutputSha256', 'dependencyInventoryDigest', 'envelopeSha256',
    'installedDependencyTreeSha256', 'manifestDigest', 'packSha256',
  ]) {
    if (!SHA256_RE.test(value[key])) return false;
  }
  if (!REVISION_RE.test(value.expectedRevision) ||
    !/^ed25519-sha256:[a-f0-9]{64}$/.test(value.keyId) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.packIntegrity) ||
    !/^[a-f0-9]{40}$/.test(value.packShasum) || value.packageName !== PACKAGE_NAME ||
    typeof value.packageVersion !== 'string' || value.packageVersion.length === 0 ||
    value.packageVersion.length > 128 || value.signatureVerified !== true ||
    !exactStringArray(value.publicExports, PUBLIC_EXPORTS)) return false;
  for (const key of ['packFileCount', 'packSize', 'packageCount', 'unpackedSize']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) return false;
  }
  if (!hasExactKeys(value.reproducibility, [
    'exactMatch', 'independentArchiveExtractInstallBuildPackObservations',
  ]) || value.reproducibility.exactMatch !== true ||
    value.reproducibility.independentArchiveExtractInstallBuildPackObservations !==
      SIGNED_RELEASE_CANARY_REPETITIONS) return false;
  return hasExactKeys(value.sourceTree, [
    'buildIdentityProvenance', 'directories', 'entries', 'symbolicLinksOrSpecialFilesAccepted',
  ]) && value.sourceTree.buildIdentityProvenance === 'unavailable' &&
    Number.isSafeInteger(value.sourceTree.directories) && value.sourceTree.directories > 0 &&
    Number.isSafeInteger(value.sourceTree.entries) && value.sourceTree.entries > 0 &&
    value.sourceTree.symbolicLinksOrSpecialFilesAccepted === false;
}

function validPairSummary(value) {
  return hasExactKeys(value, [
    'activationPermitted', 'authority', 'authorityBlockers', 'deployCanaryPermitted',
    'evidenceReady', 'executionPerformed', 'releasePairVerified', 'rollbackPermitted',
  ]) && value.authority === 'observation-only' &&
    exactStringArray(value.authorityBlockers, SIGNED_RELEASE_CANARY_PAIR_AUTHORITY_BLOCKERS) &&
    value.releasePairVerified === true && value.evidenceReady === false &&
    value.deployCanaryPermitted === false && value.rollbackPermitted === false &&
    value.activationPermitted === false && value.executionPerformed === false;
}

function validReceiptSchema(receipt) {
  if (!hasExactKeys(receipt, [
    'assurance', 'authority', 'candidate', 'cleanup', 'ephemeralSigner', 'executionBoundary',
    'pair', 'rollback', 'schemaVersion', 'scope', 'verdict',
  ]) || receipt.schemaVersion !== SIGNED_RELEASE_CANARY_SCHEMA_VERSION ||
    receipt.scope !== 'trusted-source-local-release-self-check' ||
    receipt.assurance !== SIGNED_RELEASE_CANARY_ASSURANCE || !exactFalseAuthority(receipt.authority) ||
    receipt.cleanup !== 'completed-before-receipt-emission') return false;
  if (!hasExactKeys(receipt.executionBoundary, [
    'confinement', 'environmentEffects', 'requiredEnvironment', 'sourceTrust', 'warning',
  ]) || receipt.executionBoundary.confinement !== 'not-enforced' ||
    receipt.executionBoundary.environmentEffects !== 'unattested' ||
    receipt.executionBoundary.requiredEnvironment !== 'disposable-vm-or-account' ||
    receipt.executionBoundary.sourceTrust !== 'caller-asserted-trusted-protected-source' ||
    receipt.executionBoundary.warning !== 'candidate build and CLI code execute without an OS sandbox') return false;
  if (!hasExactKeys(receipt.ephemeralSigner, [
    'algorithm', 'envelopeLifetimeMs', 'expiresAt', 'issuedAt', 'keyLifetimeMs',
    'privateKeyPersistence', 'trustRootSha256', 'validUntil',
  ]) || receipt.ephemeralSigner.algorithm !== 'ed25519' ||
    receipt.ephemeralSigner.envelopeLifetimeMs !== SIGNED_RELEASE_CANARY_ENVELOPE_LIFETIME_MS ||
    receipt.ephemeralSigner.keyLifetimeMs !== SIGNED_RELEASE_CANARY_KEY_LIFETIME_MS ||
    receipt.ephemeralSigner.privateKeyPersistence !== 'memory-only-never-serialized' ||
    !SHA256_RE.test(receipt.ephemeralSigner.trustRootSha256)) return false;
  for (const key of ['issuedAt', 'expiresAt', 'validUntil']) {
    if (typeof receipt.ephemeralSigner[key] !== 'string' ||
      !Number.isFinite(Date.parse(receipt.ephemeralSigner[key])) ||
      new Date(Date.parse(receipt.ephemeralSigner[key])).toISOString() !==
        receipt.ephemeralSigner[key]) return false;
  }
  const issuedAtMs = Date.parse(receipt.ephemeralSigner.issuedAt);
  if (Date.parse(receipt.ephemeralSigner.expiresAt) - issuedAtMs !==
      SIGNED_RELEASE_CANARY_ENVELOPE_LIFETIME_MS ||
    Date.parse(receipt.ephemeralSigner.validUntil) - issuedAtMs !==
      SIGNED_RELEASE_CANARY_KEY_LIFETIME_MS) return false;
  if (!validReleaseSummary(receipt.candidate)) return false;
  if (receipt.verdict === 'candidate-observed') {
    return receipt.rollback === null && receipt.pair === null;
  }
  return receipt.verdict === 'candidate-and-rollback-observed' &&
    validReleaseSummary(receipt.rollback) &&
    receipt.rollback.expectedRevision !== receipt.candidate.expectedRevision &&
    validPairSummary(receipt.pair);
}

export function canonicalCanaryReceipt(receipt) {
  if (!validReceiptSchema(receipt)) fail('receipt schema is invalid');
  return canonicalJson(receipt);
}

function receiptSignatureInput(receipt) {
  return Buffer.concat([
    Buffer.from(`${SIGNED_RELEASE_CANARY_RECEIPT_SIGNATURE_DOMAIN}\n`, 'utf8'),
    Buffer.from(canonicalCanaryReceipt(receipt), 'utf8'),
  ]);
}

export function verifySelfAuthenticatedCanaryReceipt(bundle, expected) {
  try {
    if (!hasExactKeys(bundle, ['receipt', 'selfAuthentication']) ||
      !validReceiptSchema(bundle.receipt) || !isPlainRecord(expected)) return false;
    const expectedKeys = Object.keys(expected);
    if (expectedKeys.length < 1 || expectedKeys.length > 2 ||
      expectedKeys.some((key) => !['publicKeySpkiSha256', 'signedCanonicalReceiptSha256'].includes(key)) ||
      expectedKeys.some((key) => !SHA256_RE.test(expected[key]))) return false;
    const authentication = bundle.selfAuthentication;
    if (!hasExactKeys(authentication, [
      'algorithm', 'domain', 'publicKeySpkiBase64url', 'publicKeySpkiSha256',
      'signatureBase64url', 'signedCanonicalReceiptSha256', 'trust',
    ]) || authentication.algorithm !== 'ed25519' ||
      authentication.domain !== SIGNED_RELEASE_CANARY_RECEIPT_SIGNATURE_DOMAIN ||
      authentication.trust !== 'self-authenticated-integrity-only-no-external-trust-or-authority' ||
      !ED25519_SPKI_BASE64URL_RE.test(authentication.publicKeySpkiBase64url) ||
      !ED25519_SIGNATURE_BASE64URL_RE.test(authentication.signatureBase64url) ||
      !SHA256_RE.test(authentication.publicKeySpkiSha256) ||
      !SHA256_RE.test(authentication.signedCanonicalReceiptSha256)) return false;
    const input = receiptSignatureInput(bundle.receipt);
    if (sha256(input) !== authentication.signedCanonicalReceiptSha256) return false;
    const publicKeyBytes = Buffer.from(authentication.publicKeySpkiBase64url, 'base64url');
    const signatureBytes = Buffer.from(authentication.signatureBase64url, 'base64url');
    if (publicKeyBytes.length !== 44 || signatureBytes.length !== 64) return false;
    if (sha256(publicKeyBytes) !== authentication.publicKeySpkiSha256 ||
      (expected.signedCanonicalReceiptSha256 !== undefined &&
        expected.signedCanonicalReceiptSha256 !== authentication.signedCanonicalReceiptSha256) ||
      (expected.publicKeySpkiSha256 !== undefined &&
        expected.publicKeySpkiSha256 !== authentication.publicKeySpkiSha256)) return false;
    const publicKey = createPublicKey({
      key: publicKeyBytes,
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(
      null,
      input,
      publicKey,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

export function createSignedObservationReceipt(input, api, nowMs = Date.now()) {
  assertRepeatableObservations(input.candidate.observations);
  if (!Number.isFinite(nowMs)) fail('signature clock is invalid');
  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SIGNED_RELEASE_CANARY_ENVELOPE_LIFETIME_MS).toISOString();
  const keyValidFrom = issuedAt;
  const keyValidUntil = new Date(nowMs + SIGNED_RELEASE_CANARY_KEY_LIFETIME_MS).toISOString();
  const keys = generateKeyPairSync('ed25519');
  const trust = api.buildRuntimeReleaseEvidenceTrustRoot({
    keys: [{ publicKey: keys.publicKey, validFrom: keyValidFrom, validUntil: keyValidUntil }],
  });
  if (!trust.ok) fail(`ephemeral trust root could not be built: ${trust.reason}`);

  const signAndVerify = (release, label) => {
    assertRepeatableObservations(release.observations);
    const signed = api.signRuntimeReleaseEvidenceEnvelope({
      manifest: release.primary.manifest,
      privateKey: keys.privateKey,
      issuedAt,
      expiresAt,
    });
    if (!signed.ok) fail(`${label} evidence could not be signed: ${signed.reason}`);
    const verified = api.verifyRuntimeReleaseEvidenceEnvelope({
      envelope: signed.canonicalJson,
      manifest: release.primary.manifest,
      trustRoot: trust.canonicalJson,
    });
    if (!verified.ok || verified.assurance !== SIGNED_RELEASE_CANARY_ASSURANCE) {
      fail(`${label} signed evidence did not verify`);
    }
    return { signed, verified };
  };

  const candidate = signAndVerify(input.candidate, 'candidate');
  const rollback = input.rollback ? signAndVerify(input.rollback, 'rollback') : null;
  let pair = null;
  if (rollback) {
    pair = api.evaluateRuntimeReleaseCanaryRollbackEvidence({
      observationEnabled: true,
      candidate: {
        envelope: candidate.signed.canonicalJson,
        manifest: input.candidate.primary.manifest,
        trustRoot: trust.canonicalJson,
      },
      rollback: {
        envelope: rollback.signed.canonicalJson,
        manifest: input.rollback.primary.manifest,
        trustRoot: trust.canonicalJson,
      },
      expected: {
        candidateEnvelopeSha256: sha256(candidate.signed.canonicalJson),
        candidateManifestDigest: input.candidate.primary.manifestDigest,
        candidateRevision: input.candidate.revision,
        rollbackEnvelopeSha256: sha256(rollback.signed.canonicalJson),
        rollbackManifestDigest: input.rollback.primary.manifestDigest,
        rollbackRevision: input.rollback.revision,
        trustRootSha256: sha256(trust.canonicalJson),
      },
    });
    assertExactReleasePairObservationOnly(pair);
  }

  const summarize = (release, evidence) => ({
    cliOutputSha256: release.primary.cliOutputSha256,
    dependencyInventoryDigest: release.primary.dependencyInventoryDigest,
    envelopeSha256: sha256(evidence.signed.canonicalJson),
    expectedRevision: evidence.verified.expectedRevision,
    installedDependencyTreeSha256: release.primary.installedDependencyTreeSha256,
    keyId: evidence.verified.keyId,
    manifestDigest: release.primary.manifestDigest,
    packFileCount: release.primary.packFileCount,
    packIntegrity: release.primary.packIntegrity,
    packSha256: release.primary.packSha256,
    packShasum: release.primary.packShasum,
    packSize: release.primary.packSize,
    packageCount: release.primary.packageCount,
    packageName: release.primary.packageName,
    packageVersion: release.primary.packageVersion,
    publicExports: release.primary.publicExports,
    reproducibility: {
      exactMatch: true,
      independentArchiveExtractInstallBuildPackObservations: release.observations.length,
    },
    sourceTree: {
      buildIdentityProvenance: release.primary.archiveBuildIdentityProvenance,
      directories: release.primary.extractedSourceDirectoryCount,
      entries: release.primary.extractedSourceEntryCount,
      symbolicLinksOrSpecialFilesAccepted: false,
    },
    signatureVerified: true,
    unpackedSize: release.primary.unpackedSize,
  });

  const receipt = Object.freeze({
    schemaVersion: SIGNED_RELEASE_CANARY_SCHEMA_VERSION,
    scope: 'trusted-source-local-release-self-check',
    assurance: SIGNED_RELEASE_CANARY_ASSURANCE,
    verdict: rollback ? 'candidate-and-rollback-observed' : 'candidate-observed',
    authority: NO_AUTHORITY,
    executionBoundary: {
      confinement: 'not-enforced',
      environmentEffects: 'unattested',
      requiredEnvironment: 'disposable-vm-or-account',
      sourceTrust: 'caller-asserted-trusted-protected-source',
      warning: 'candidate build and CLI code execute without an OS sandbox',
    },
    ephemeralSigner: {
      algorithm: 'ed25519',
      envelopeLifetimeMs: SIGNED_RELEASE_CANARY_ENVELOPE_LIFETIME_MS,
      expiresAt,
      issuedAt,
      keyLifetimeMs: SIGNED_RELEASE_CANARY_KEY_LIFETIME_MS,
      privateKeyPersistence: 'memory-only-never-serialized',
      trustRootSha256: sha256(trust.canonicalJson),
      validUntil: keyValidUntil,
    },
    candidate: summarize(input.candidate, candidate),
    rollback: rollback ? summarize(input.rollback, rollback) : null,
    pair: pair ? {
      authority: pair.authority,
      authorityBlockers: pair.authorityBlockers,
      evidenceReady: false,
      releasePairVerified: true,
      deployCanaryPermitted: false,
      rollbackPermitted: false,
      activationPermitted: false,
      executionPerformed: false,
    } : null,
    cleanup: 'completed-before-receipt-emission',
  });
  const signedInput = receiptSignatureInput(receipt);
  const publicKeyBytes = keys.publicKey.export({ type: 'spki', format: 'der' });
  const publicKeySpkiSha256 = sha256(publicKeyBytes);
  const signedCanonicalReceiptSha256 = sha256(signedInput);
  const bundle = Object.freeze({
    receipt,
    selfAuthentication: Object.freeze({
      algorithm: 'ed25519',
      domain: SIGNED_RELEASE_CANARY_RECEIPT_SIGNATURE_DOMAIN,
      publicKeySpkiBase64url: publicKeyBytes.toString('base64url'),
      publicKeySpkiSha256,
      signatureBase64url: cryptoSign(null, signedInput, keys.privateKey).toString('base64url'),
      signedCanonicalReceiptSha256,
      trust: 'self-authenticated-integrity-only-no-external-trust-or-authority',
    }),
  });
  if (!verifySelfAuthenticatedCanaryReceipt(bundle, {
    publicKeySpkiSha256,
    signedCanonicalReceiptSha256,
  })) fail('outer receipt self-authentication failed');
  return bundle;
}

async function loadEvidenceApi(packageRoot) {
  const envelope = await import(pathToFileURL(join(
    packageRoot,
    'dist/core/daemon/runtime-release-evidence-envelope.js',
  )).href);
  const pair = await import(pathToFileURL(join(
    packageRoot,
    'dist/core/daemon/runtime-release-canary-rollback-evidence.js',
  )).href);
  return { ...envelope, ...pair };
}

export async function runSignedReleaseCanary(options, baseEnv = process.env) {
  if (options?.trustedProtectedSource !== true) {
    fail('trusted protected source acknowledgement is required');
  }
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = realpathSync(run('git', ['rev-parse', '--show-toplevel'], {
    cwd: scriptRoot,
    env: baseEnv,
    label: 'resolve repository root',
  }).stdout.trim());
  if (repoRoot !== scriptRoot) fail('canary script is not running from its repository root');
  const candidateRevision = resolveRevision(repoRoot, options.candidate, baseEnv);
  if (options.expectedRevision !== null && candidateRevision !== options.expectedRevision) {
    fail('candidate revision does not match --expected-revision');
  }
  const rollbackRevision = options.rollback === null
    ? null
    : resolveRevision(repoRoot, options.rollback, baseEnv);
  if (rollbackRevision === candidateRevision) fail('rollback revision must be distinct from candidate');
  if (rollbackRevision !== null) {
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', rollbackRevision, candidateRevision], {
      cwd: repoRoot,
      env: baseEnv,
      stdio: 'ignore',
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    if (ancestry.error || ancestry.status !== 0) fail('rollback revision is not an ancestor of candidate');
  }

  const npmCli = resolveNpmCli(baseEnv);
  const tarBinary = resolveTarBinary();
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-signed-canary-')));
  chmodSync(tempRoot, 0o700);
  let receipt;
  try {
    // The caller deliberately uses a private umask. Keep the root private, but
    // normalize the complete archive/install/build/pack pipeline so tar, npm,
    // and generated build output retain canonical 0644/0755 package modes.
    receipt = await withReleasePipelineUmask(async () => {
      let rollback = null;
      if (rollbackRevision !== null) {
        rollback = await prepareRelease({
          baseEnv,
          npmCli,
          repoRoot,
          revision: rollbackRevision,
          role: 'rollback',
          rollbackTargetDigest: null,
          tarBinary,
          tempRoot,
        });
        rollback.revision = rollbackRevision;
      }
      const candidate = await prepareRelease({
        baseEnv,
        npmCli,
        repoRoot,
        revision: candidateRevision,
        role: 'candidate',
        rollbackTargetDigest: rollback?.primary.manifestDigest ?? null,
        tarBinary,
        tempRoot,
      });
      candidate.revision = candidateRevision;
      const api = await loadEvidenceApi(candidate.primary.apiRoot);
      return createSignedObservationReceipt({ candidate, rollback }, api);
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return receipt;
}

function usage() {
  return 'Usage: npm --silent run release:canary -- --candidate <sha> --expected-revision <sha> ' +
    '[--rollback <ancestor-sha>] --trusted-protected-source\n\n' +
    'Runs two independent archive/extract/install/build/pack self-check pipelines.\n' +
    'OS confinement is not enforced: use only trusted protected source in a disposable VM/account.\n' +
    'Environment effects are unattested and the self-authenticated receipt grants no external trust or authority.\n';
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    const options = parseCanaryArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      const receipt = await runSignedReleaseCanary(options);
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
