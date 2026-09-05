#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { verifyReleaseSuccessorPolicyFile } from './verify-release-policy.mjs';
import {
  canonicalizeLocalProductionGateReceipt,
  LOCAL_PRODUCTION_GATE_AUTHORITY,
  LOCAL_PRODUCTION_GATE_COMMANDS,
  LOCAL_PRODUCTION_GATE_CONFINEMENT,
  LOCAL_PRODUCTION_GATE_IDS,
  LOCAL_PRODUCTION_GATE_RECEIPT_SCHEMA_VERSION,
  localProductionGateConfinement,
  validateLocalProductionGateReceipt,
} from './verify-local-production-gate-receipt.mjs';

const REVISION_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const MAX_OUTPUT_HASH_BYTES = 16 * 1024 * 1024;
const MAX_PACK_EVIDENCE_BYTES = 4 * 1024;
const PIPE_CLOSE_GRACE_MS = 2_000;
const LOCAL_GATE_TEMP_PARENT = '/private/tmp';
const LOCAL_GATE_TEMP_ROOT_MAX_BYTES = 24;
const LOCAL_GATE_CUSTODY_ROOT_MAX_BYTES = 1_024;
const TAURI_CHECK_ICON_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVRYw+3BAQEAAACCIP+vbkhAAQAAAO8GECAAAZf3V9cAAAAASUVORK5CYII=',
  'base64',
);
function resolveSystemGit() {
  if (process.platform !== 'darwin') return '/usr/bin/git';
  const result = spawnSync('/usr/bin/xcrun', ['-f', 'git'], {
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: homedir(),
      LANG: 'C',
      LC_ALL: 'C',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const path = result.stdout?.trim();
  if (result.error || result.status !== 0 || !path || !isAbsolute(path)) {
    throw new Error(`local production gate: could not resolve the active Apple Git with xcrun: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return realpathSync(path);
}

const SYSTEM_GIT = resolveSystemGit();
function fail(message) {
  throw new Error(`local production gate: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function createPrivateLocalGateTempDirectory(prefix) {
  if (!['alg-', 'agp-'].includes(prefix)) fail('local production gate temporary prefix is invalid');
  const parent = realpathSync(LOCAL_GATE_TEMP_PARENT);
  const parentIdentity = lstatSync(LOCAL_GATE_TEMP_PARENT);
  if (parent !== LOCAL_GATE_TEMP_PARENT || !parentIdentity.isDirectory()
    || parentIdentity.isSymbolicLink() || parentIdentity.uid !== 0
    || (parentIdentity.mode & 0o7777) !== 0o1777) {
    fail(`${LOCAL_GATE_TEMP_PARENT} must be the canonical root-owned sticky temporary directory`);
  }
  const path = mkdtempSync(join(parent, prefix));
  const identity = lstatSync(path);
  if (realpathSync(path) !== path || dirname(path) !== parent
    || !new RegExp(`^${prefix}[A-Za-z0-9]{6}$`, 'u').test(basename(path))
    || !identity.isDirectory() || identity.isSymbolicLink()
    || identity.uid !== process.getuid() || (identity.mode & 0o7777) !== 0o700
    || Buffer.byteLength(path, 'utf8') > LOCAL_GATE_TEMP_ROOT_MAX_BYTES) {
    rmSync(path, { recursive: true, force: true });
    fail('local production gate temporary directory is not short and private');
  }
  let owned = true;
  const assertUnchanged = () => {
    if (!owned || !existsSync(path)) {
      fail('local production gate temporary directory disappeared');
    }
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino
      || current.uid !== identity.uid || (current.mode & 0o7777) !== 0o700
      || realpathSync(path) !== path) {
      fail('local production gate temporary directory identity changed');
    }
  };
  return Object.freeze({
    path,
    assertUnchanged,
    cleanup: () => {
      if (!owned) return;
      assertUnchanged();
      rmSync(path, { recursive: true, force: true });
      owned = false;
    },
  });
}

export function createPrivateLocalGateTempRoot() {
  return createPrivateLocalGateTempDirectory('alg-');
}

function captureDarwinUserTempDirectory() {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    fail('local production gate custody is supported only on macOS');
  }
  const result = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: homedir(),
      LANG: 'C',
      LC_ALL: 'C',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reported = result.stdout?.trim().replace(/\/$/u, '');
  if (result.error || result.status !== 0 || !reported || !isAbsolute(reported)
    || reported.includes('\0') || reported.includes('\n')) {
    fail(`could not resolve DARWIN_USER_TEMP_DIR: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const path = realpathSync(reported);
  const identities = [];
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const identity = lstatSync(cursor);
    if (realpathSync(cursor) !== cursor || !identity.isDirectory() || identity.isSymbolicLink()
      || ![0, process.getuid()].includes(identity.uid) || (identity.mode & 0o022) !== 0) {
      fail('DARWIN_USER_TEMP_DIR must have canonical, owned, non-writable custody ancestors');
    }
    identities.push(Object.freeze({
      path: cursor, dev: identity.dev, ino: identity.ino, uid: identity.uid,
      mode: identity.mode & 0o7777,
    }));
    if (cursor === sep) break;
  }
  const parent = identities[0];
  if (parent.uid !== process.getuid() || parent.mode !== 0o700) {
    fail('DARWIN_USER_TEMP_DIR must be a current-user-owned mode 0700 directory');
  }
  const assertUnchanged = () => {
    for (const expected of identities) {
      if (!existsSync(expected.path)) fail('DARWIN_USER_TEMP_DIR custody ancestor disappeared');
      const current = lstatSync(expected.path);
      if (!current.isDirectory() || current.isSymbolicLink()
        || current.dev !== expected.dev || current.ino !== expected.ino
        || current.uid !== expected.uid || (current.mode & 0o7777) !== expected.mode
        || realpathSync(expected.path) !== expected.path) {
        fail('DARWIN_USER_TEMP_DIR custody ancestor identity changed');
      }
    }
  };
  return Object.freeze({ path, assertUnchanged });
}

export function createPrivateLocalGateCustodyRoot() {
  const parent = captureDarwinUserTempDirectory();
  parent.assertUnchanged();
  const path = mkdtempSync(join(parent.path, 'agc-'));
  const identity = lstatSync(path);
  if (realpathSync(path) !== path || dirname(path) !== parent.path
    || !/^agc-[A-Za-z0-9]{6}$/u.test(basename(path))
    || !identity.isDirectory() || identity.isSymbolicLink()
    || identity.uid !== process.getuid() || (identity.mode & 0o7777) !== 0o700
    || Buffer.byteLength(path, 'utf8') > LOCAL_GATE_CUSTODY_ROOT_MAX_BYTES) {
    rmSync(path, { recursive: true, force: true });
    fail('local production gate custody root is not canonical and private');
  }
  let owned = true;
  const assertUnchanged = () => {
    parent.assertUnchanged();
    if (!owned || !existsSync(path)) fail('local production gate custody root disappeared');
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino
      || current.uid !== identity.uid || (current.mode & 0o7777) !== 0o700
      || realpathSync(path) !== path) {
      fail('local production gate custody root identity changed');
    }
  };
  return Object.freeze({
    path,
    assertUnchanged,
    cleanup: () => {
      if (!owned) return;
      assertUnchanged();
      rmSync(path, { recursive: true, force: true });
      owned = false;
    },
  });
}

function assertDisjointRoots(...roots) {
  for (const [index, left] of roots.entries()) {
    for (const right of roots.slice(index + 1)) {
      const fromLeft = relative(left, right);
      const fromRight = relative(right, left);
      if (fromLeft === ''
        || (!fromLeft.startsWith(`..${sep}`) && fromLeft !== '..' && !isAbsolute(fromLeft))
        || (!fromRight.startsWith(`..${sep}`) && fromRight !== '..' && !isAbsolute(fromRight))) {
        fail('local production gate private roots must be pairwise disjoint');
      }
    }
  }
}

function directorySha256(root) {
  const hash = createHash('sha256');
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .toSorted((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (entry.isDirectory()) {
        hash.update(`d\0${relativePath}\0${metadata.mode & 0o777}\0`);
        visit(path, relativePath);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relativePath}\0${readlinkSync(path)}\0`);
      } else if (entry.isFile()) {
        hash.update(`f\0${relativePath}\0${metadata.mode & 0o777}\0${metadata.size}\0`);
        hash.update(readFileSync(path));
        hash.update('\0');
      } else {
        fail(`unsupported npm runtime entry ${relativePath}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function sync(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.trim();
}

function controlEnvironment() {
  return Object.freeze({
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: homedir(),
    TMPDIR: tmpdir(),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  });
}

function git(repo, args) {
  return sync(SYSTEM_GIT, args, repo, controlEnvironment());
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys do not match the closed schema`);
  }
  return value;
}

export function parseLocalGateArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--expected-sha', '--policy', '--artifact', '--receipt'].includes(flag)
      || value === undefined || values[flag] !== undefined) {
      fail(`invalid or duplicate option ${flag ?? '<missing>'}`);
    }
    values[flag] = value;
  }
  if (!values['--expected-sha'] || !values['--policy'] || !values['--artifact']
    || !values['--receipt']) {
    fail('usage: run-local-production-gate.mjs --expected-sha <40-hex> --policy <tracked-json> --artifact <absolute-external-tgz> --receipt <absolute-external-json>');
  }
  if (!REVISION_RE.test(values['--expected-sha'])) fail('--expected-sha must be lowercase 40-hex');
  if (!isAbsolute(values['--artifact'])) fail('--artifact must be an absolute path');
  if (!isAbsolute(values['--receipt'])) fail('--receipt must be an absolute path');
  const artifactPath = resolve(values['--artifact']);
  const receiptPath = resolve(values['--receipt']);
  if (artifactPath === receiptPath) fail('--artifact and --receipt must be different paths');
  return {
    expectedSha: values['--expected-sha'],
    policyPath: values['--policy'],
    artifactPath,
    receiptPath,
  };
}

export function assertExternalReceiptPath(repoRoot, receiptPath) {
  if (existsSync(receiptPath)) fail('receipt path already exists; refusing to overwrite evidence');
  const repoReal = realpathSync(repoRoot);
  const parentReal = realpathSync(dirname(receiptPath));
  const candidate = join(parentReal, basename(receiptPath));
  if (candidate === repoReal || candidate.startsWith(`${repoReal}${sep}`)) {
    fail('receipt path must be outside the repository');
  }
  const parent = lstatSync(parentReal);
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail('output parent must be a real directory');
  if (typeof process.getuid === 'function' && parent.uid !== process.getuid()) {
    fail('output parent must be owned by the current user');
  }
  if ((parent.mode & 0o022) !== 0) fail('output parent must not be group- or world-writable');
  return Object.freeze({
    path: candidate,
    parentReal,
    parentDev: parent.dev,
    parentIno: parent.ino,
  });
}

function revalidateExternalOutput(repoRoot, output) {
  const parentReal = realpathSync(dirname(output.path));
  const parent = lstatSync(parentReal);
  if (parentReal !== output.parentReal || parent.dev !== output.parentDev || parent.ino !== output.parentIno
    || !parent.isDirectory() || parent.isSymbolicLink()) {
    fail('external output parent identity changed during verification');
  }
  const repoReal = realpathSync(repoRoot);
  if (output.path === repoReal || output.path.startsWith(`${repoReal}${sep}`)) {
    fail('external output was redirected into the repository');
  }
}

function exactVersion(raw, label, minimumMajor) {
  const version = raw.trim().replace(/^v/u, '');
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)
    || Number(version.split('.')[0]) < minimumMajor) {
    fail(`${label} must be semantic version ${minimumMajor}+`);
  }
  return version;
}

export function validateLocalGateToolchain({ nodeVersion, npmVersion, policy }) {
  const node = exactVersion(nodeVersion, 'Node', 24);
  const npm = exactVersion(npmVersion, 'npm', 11);
  if (node !== policy.toolchain.nodeVersion || npm !== policy.toolchain.npmVersion) {
    fail('Node/npm versions must exactly match the release policy');
  }
  return Object.freeze({ nodeVersion: node, npmVersion: npm });
}

function validateStringArray(value, label) {
  if (!Array.isArray(value) || value.length < 1
    || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    fail(`${label} must be a non-empty argv array`);
  }
  return value;
}

export function validateLocalProductionContract(raw) {
  const root = exactKeys(raw, ['schemaVersion', 'mode', 'authorityFiles', 'commands', 'localProductionGate'], 'contract');
  const local = exactKeys(root.localProductionGate, [
    'schemaVersion', 'runner', 'receiptVerifier', 'receiptSchemaVersion', 'gates',
  ], 'localProductionGate');
  if (local.schemaVersion !== 1 || local.runner !== 'scripts/run-local-production-gate.mjs'
    || local.receiptVerifier !== 'scripts/verify-local-production-gate-receipt.mjs'
    || local.receiptSchemaVersion !== LOCAL_PRODUCTION_GATE_RECEIPT_SCHEMA_VERSION
    || !Array.isArray(local.gates)
    || local.gates.length !== LOCAL_PRODUCTION_GATE_IDS.length) {
    fail('localProductionGate identity or gate count is invalid');
  }
  const seen = new Set();
  const gates = local.gates.map((value, index) => {
    const gate = exactKeys(
      value, ['id', 'confinement', 'cmd', 'cwd', 'timeoutMs'],
      `localProductionGate.gates[${index}]`,
    );
    if (gate.id !== LOCAL_PRODUCTION_GATE_IDS[index] || seen.has(gate.id)) {
      fail(`localProductionGate.gates[${index}] is missing, duplicated, or out of order`);
    }
    seen.add(gate.id);
    validateStringArray(gate.cmd, `localProductionGate.gates[${index}].cmd`);
    if (typeof gate.cwd !== 'string' || !['.', 'src/raycast', 'desktop/src-tauri'].includes(gate.cwd)
      || !Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs < 1 || gate.timeoutMs > 1_800_000) {
      fail(`localProductionGate.gates[${index}] has an invalid cwd or timeout`);
    }
    const [expectedId, expectedCmd, expectedCwd, expectedTimeout] = LOCAL_PRODUCTION_GATE_COMMANDS[index];
    if (gate.id !== expectedId || gate.confinement !== localProductionGateConfinement(gate.id)
      || gate.cwd !== expectedCwd || gate.timeoutMs !== expectedTimeout
      || gate.cmd.length !== expectedCmd.length
      || gate.cmd.some((part, partIndex) => part !== expectedCmd[partIndex])) {
      fail(`localProductionGate.gates[${index}] does not match the closed v1 command`);
    }
    return Object.freeze({
      id: gate.id,
      confinement: gate.confinement,
      cmd: Object.freeze([...gate.cmd]),
      cwd: gate.cwd,
      timeoutMs: gate.timeoutMs,
    });
  });
  return Object.freeze({ ...local, gates: Object.freeze(gates) });
}

function ensureCleanExactSource(repoRoot, expectedSha) {
  const topLevel = realpathSync(git(repoRoot, ['rev-parse', '--show-toplevel']));
  if (topLevel !== realpathSync(repoRoot)) fail('Git top-level does not match the supplied repository');
  const revision = git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (revision !== expectedSha) fail(`HEAD ${revision} does not equal --expected-sha ${expectedSha}`);
  const status = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') fail('repository must be exactly clean');
  const indexFlags = git(repoRoot, ['ls-files', '-v', '-z']).split('\0').filter(Boolean);
  if (indexFlags.some((entry) => !entry.startsWith('H '))) {
    fail('repository index contains skip-worktree, assume-unchanged, or nonstandard flags');
  }
  return Object.freeze({ revision, tree: git(repoRoot, ['rev-parse', 'HEAD^{tree}']) });
}

function safeTrackedPolicy(repoRoot, suppliedPath) {
  const candidate = realpathSync(resolve(repoRoot, suppliedPath));
  const rel = relative(realpathSync(repoRoot), candidate);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..'
    || !/^\.github\/release-policies\/v[^/]+\.json$/u.test(rel.replaceAll(sep, '/'))) {
    fail('policy must be a tracked versioned file under .github/release-policies');
  }
  git(repoRoot, ['ls-files', '--error-unmatch', '--', rel]);
  return candidate;
}

function verifyPolicyGitBindings(repoRoot, policy) {
  const parents = git(repoRoot, ['show', '-s', '--format=%P', 'HEAD']).split(' ').filter(Boolean);
  if (parents.length !== 2 || parents[0] !== policy.release.requiredFirstParentRevision) {
    fail('HEAD must be a two-parent merge with the policy-required protected first parent');
  }
  const verifyHistoricalArtifact = (artifact, label, expectedTree = null) => {
    const ref = `refs/tags/${artifact.releaseTag}`;
    if (git(repoRoot, ['cat-file', '-t', ref]) !== 'commit'
      || git(repoRoot, ['rev-parse', ref]) !== artifact.revision) {
      fail(`${label} lightweight tag binding is invalid`);
    }
    if (expectedTree !== null && git(repoRoot, ['rev-parse', `${artifact.revision}^{tree}`]) !== expectedTree) {
      fail(`${label} tree binding is invalid`);
    }
  };
  verifyHistoricalArtifact(
    policy.release.rollback, 'rollback', policy.release.rollback.tree,
  );
  for (const [index, artifact] of policy.registry.quarantined.entries()) {
    verifyHistoricalArtifact(artifact, `quarantined[${index}]`);
  }
  for (const [index, artifact] of policy.registry.failedCandidates.entries()) {
    verifyHistoricalArtifact({
      releaseTag: artifact.releaseTag,
      revision: artifact.tagRevision,
    }, `failedCandidates[${index}]`);
  }
  const candidateRef = spawnSync(SYSTEM_GIT, [
    'show-ref', '--verify', '--quiet', `refs/tags/${policy.package.releaseTag}`,
  ], { cwd: repoRoot, env: controlEnvironment(), stdio: 'ignore' });
  if (candidateRef.status === 0) fail('candidate release tag must be absent during local verification');
  if (candidateRef.status !== 1) fail('candidate release tag absence could not be verified');
}

function discoverExecutable(name, cwd) {
  const env = { ...controlEnvironment(), PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const path = realpathSync(sync('/usr/bin/which', [name], cwd, env));
  if (!isAbsolute(path)) fail(`${name} did not resolve to an absolute executable`);
  return path;
}

function resolveToolchain(repoRoot) {
  const nodePath = realpathSync(process.execPath);
  const npmCliPath = realpathSync(join(
    dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js',
  ));
  const npmRuntimePath = realpathSync(join(dirname(npmCliPath), '..'));
  const rustupPath = discoverExecutable('rustup', repoRoot);
  const rustupEnv = { ...controlEnvironment(), RUSTUP_HOME: join(homedir(), '.rustup') };
  const cargoPath = realpathSync(sync(rustupPath, ['which', 'cargo'], repoRoot, rustupEnv));
  const rustcPath = realpathSync(sync(rustupPath, ['which', 'rustc'], repoRoot, rustupEnv));
  const rustdocPath = realpathSync(sync(rustupPath, ['which', 'rustdoc'], repoRoot, rustupEnv));
  const cargoFmtPath = realpathSync(sync(rustupPath, ['which', 'cargo-fmt'], repoRoot, rustupEnv));
  const rustfmtPath = realpathSync(sync(rustupPath, ['which', 'rustfmt'], repoRoot, rustupEnv));
  const cargoClippyPath = realpathSync(sync(rustupPath, ['which', 'cargo-clippy'], repoRoot, rustupEnv));
  const clippyDriverPath = realpathSync(sync(rustupPath, ['which', 'clippy-driver'], repoRoot, rustupEnv));
  const rustToolchainBin = dirname(cargoPath);
  for (const [name, path] of Object.entries({
    rustc: rustcPath,
    rustdoc: rustdocPath,
    cargoFmt: cargoFmtPath,
    rustfmt: rustfmtPath,
    cargoClippy: cargoClippyPath,
    clippyDriver: clippyDriverPath,
  })) {
    if (dirname(path) !== rustToolchainBin) fail(`${name} must use the same exact Rust toolchain as cargo`);
  }
  const cargoAuditPath = discoverExecutable('cargo-audit', repoRoot);
  const osvScannerPath = discoverExecutable('osv-scanner', repoRoot);
  const xcodeSelectPath = '/usr/bin/xcode-select';
  const xcrunPath = '/usr/bin/xcrun';
  const developerDirectory = realpathSync(sync(
    xcodeSelectPath, ['-p'], repoRoot, controlEnvironment(),
  ));
  const xcodeEnvironment = { ...controlEnvironment(), DEVELOPER_DIR: developerDirectory };
  const macosSdkRoot = realpathSync(sync(
    xcrunPath, ['--sdk', 'macosx', '--show-sdk-path'], repoRoot, xcodeEnvironment,
  ));
  const sdkRelative = relative(developerDirectory, macosSdkRoot);
  if (sdkRelative === '' || sdkRelative === '..' || sdkRelative.startsWith(`..${sep}`)
    || isAbsolute(sdkRelative)) {
    fail('macOS SDK must be inside the selected Xcode developer directory');
  }
  const macosSdkVersion = sync(
    xcrunPath, ['--sdk', 'macosx', '--show-sdk-version'], repoRoot, xcodeEnvironment,
  );
  if (!/^\d+(?:\.\d+){0,2}$/u.test(macosSdkVersion)) fail('macOS SDK version is invalid');
  const tauriConfig = JSON.parse(readFileSync(
    join(repoRoot, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8',
  ));
  const macosDeploymentTarget = tauriConfig.bundle?.macOS?.minimumSystemVersion;
  if (!/^\d+(?:\.\d+){1,2}$/u.test(macosDeploymentTarget)) {
    fail('Tauri macOS minimum system version is invalid');
  }
  const paths = {
    node: nodePath,
    npmCli: npmCliPath,
    npmRuntime: npmRuntimePath,
    bash: '/bin/bash',
    git: SYSTEM_GIT,
    rustc: rustcPath,
    rustdoc: rustdocPath,
    cargo: cargoPath,
    cargoFmt: cargoFmtPath,
    rustfmt: rustfmtPath,
    cargoClippy: cargoClippyPath,
    clippyDriver: clippyDriverPath,
    cargoAudit: cargoAuditPath,
    osvScanner: osvScannerPath,
    xcodeSelect: xcodeSelectPath,
    xcrun: xcrunPath,
    sandboxExec: '/usr/bin/sandbox-exec',
  };
  const executables = Object.fromEntries(Object.entries(paths).map(([name, path]) => [
    name,
    Object.freeze({
      path,
      sha256: name === 'npmRuntime' ? directorySha256(path) : fileSha256(path),
    }),
  ]));
  const sdkSettingsPath = realpathSync(join(macosSdkRoot, 'SDKSettings.json'));
  const sdkSettingsRelative = relative(macosSdkRoot, sdkSettingsPath);
  if (sdkSettingsRelative === '' || sdkSettingsRelative === '..'
    || sdkSettingsRelative.startsWith(`..${sep}`) || isAbsolute(sdkSettingsRelative)) {
    fail('macOS SDK settings must be inside the selected SDK root');
  }
  const files = Object.freeze({
    macosSdkSettings: Object.freeze({ path: sdkSettingsPath, sha256: fileSha256(sdkSettingsPath) }),
  });
  const appleIdentities = Object.freeze(Object.fromEntries([
    ['developerDirectory', developerDirectory], ['macosSdkRoot', macosSdkRoot],
  ].map(([name, path]) => {
    const identity = lstatSync(path);
    if (!identity.isDirectory() || identity.isSymbolicLink()) fail(`${name} must be a real directory`);
    return [name, Object.freeze({ path, dev: identity.dev, ino: identity.ino })];
  })));
  return Object.freeze({
    paths: Object.freeze(paths),
    executables: Object.freeze(executables),
    files,
    appleIdentities,
    apple: Object.freeze({
      developerDirectory, macosSdkRoot, macosSdkVersion, macosDeploymentTarget,
    }),
  });
}

function assertToolchainUnchanged(tools) {
  for (const [name, executable] of Object.entries(tools.executables)) {
    const actual = name === 'npmRuntime'
      ? directorySha256(executable.path)
      : fileSha256(executable.path);
    if (actual !== executable.sha256) fail(`${name} changed during local verification`);
  }
  for (const [name, file] of Object.entries(tools.files)) {
    if (fileSha256(file.path) !== file.sha256) fail(`${name} changed during local verification`);
  }
  for (const [name, expected] of Object.entries(tools.appleIdentities)) {
    const actual = lstatSync(expected.path);
    if (!actual.isDirectory() || actual.isSymbolicLink()
      || actual.dev !== expected.dev || actual.ino !== expected.ino
      || realpathSync(expected.path) !== expected.path) {
      fail(`${name} changed during local verification`);
    }
  }
}

export function prepareDisposableTauriSidecar(repoRoot, rustcVerbose) {
  if (process.platform !== 'darwin') fail('local production gate v1 supports macOS only');
  const match = rustcVerbose.match(/^host:\s+(\S+)$/mu);
  if (!match) fail('could not derive the Rust host triple');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const path = join(repoRoot, 'desktop', 'src-tauri', 'binaries', `ashlr-${match[1]}${suffix}`);
  if (existsSync(path)) fail('disposable Tauri sidecar target already exists');
  const parent = dirname(path);
  if (lstatSync(parent).isSymbolicLink()) fail('Tauri binaries directory must not be a symlink');
  const fd = openSync(path, 'wx', 0o700);
  try {
    writeFileSync(fd, '#!/bin/sh\nexit 64\n', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const identity = lstatSync(path);
  let owned = true;
  return Object.freeze({
    path,
    cleanup: () => {
      if (!owned) return;
      const current = lstatSync(path);
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        fail('disposable Tauri sidecar identity changed before cleanup');
      }
      rmSync(path);
      owned = false;
    },
  });
}

export function prepareDisposableTauriGeneratedRoot(repoRoot) {
  const path = join(repoRoot, 'desktop', 'src-tauri', 'gen');
  const schemasPath = join(path, 'schemas');
  if (existsSync(path)) fail('disposable Tauri generated root already exists');
  const parent = dirname(path);
  if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) {
    fail('Tauri generated-root parent must be a canonical directory');
  }
  mkdirSync(path, { mode: 0o700 });
  mkdirSync(schemasPath, { mode: 0o700 });
  const identity = lstatSync(path);
  const schemasIdentity = lstatSync(schemasPath);
  let owned = true;
  const assertUnchanged = () => {
    const current = lstatSync(path);
    const currentSchemas = lstatSync(schemasPath);
    for (const [label, actual, expected] of [
      ['root', current, identity], ['schemas', currentSchemas, schemasIdentity],
    ]) {
      if (!actual.isDirectory() || actual.isSymbolicLink()
        || actual.dev !== expected.dev || actual.ino !== expected.ino
        || actual.uid !== process.getuid() || (actual.mode & 0o7777) !== 0o700) {
        fail(`disposable Tauri generated ${label} identity changed`);
      }
    }
  };
  return Object.freeze({
    path, schemasPath, assertUnchanged,
    cleanup: () => {
      if (!owned) return;
      assertUnchanged();
      rmSync(path, { recursive: true });
      owned = false;
    },
  });
}

export function prepareDisposableTauriCheckIcon(repoRoot) {
  const path = join(repoRoot, 'desktop', 'src-tauri', 'icons', '32x32.png');
  if (existsSync(path)) fail('disposable Tauri check icon already exists');
  const parent = dirname(path);
  if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) {
    fail('Tauri check-icon parent must be a canonical directory');
  }
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, TAURI_CHECK_ICON_BYTES);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const identity = lstatSync(path);
  let owned = true;
  const assertUnchanged = () => {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino
      || current.uid !== process.getuid() || (current.mode & 0o7777) !== 0o600
      || current.size !== TAURI_CHECK_ICON_BYTES.length
      || fileSha256(path) !== sha256(TAURI_CHECK_ICON_BYTES)) {
      fail('disposable Tauri check icon identity changed');
    }
  };
  return Object.freeze({
    path, assertUnchanged,
    cleanup: () => {
      if (!owned) return;
      assertUnchanged();
      rmSync(path);
      owned = false;
    },
  });
}

function prepareImmutableToolCopy(sourcePath, expectedSha256, profileRoot, name) {
  const source = lstatSync(sourcePath);
  if (!source.isFile() || source.isSymbolicLink() || source.size < 1 || source.size > 64 * 1024 * 1024) {
    fail(`${name} source executable is invalid`);
  }
  const path = join(realpathSync(profileRoot), name);
  const bytes = readFileSync(sourcePath);
  const fd = openSync(path, 'wx', 0o700);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const identity = lstatSync(path);
  const digest = sha256(bytes);
  if (digest !== expectedSha256) fail(`${name} source changed while creating runtime copy`);
  const assertUnchanged = () => {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino
      || current.uid !== process.getuid() || (current.mode & 0o7777) !== 0o700
      || current.size !== bytes.length || fileSha256(path) !== digest) {
      fail(`${name} immutable runtime copy changed`);
    }
  };
  return Object.freeze({ path, sha256: digest, assertUnchanged });
}

function expandArg(value, context) {
  return value.replaceAll('{repo}', context.repoRoot).replaceAll('{temp}', context.tempRoot);
}

async function terminate(child, marker) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  if (markedProcessGroupExists(marker, child.pid)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* marked group already exited */ }
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
  await delay(2_000);
  if (markedProcessGroupExists(marker, child.pid)) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* marked group already exited */ }
  }
}

async function ensureProcessTreeGone(child, marker) {
  if (process.platform === 'win32') return;
  if (markedProcessGroupExists(marker, child.pid)) await terminate(child, marker);
  if (markedProcessGroupExists(marker, child.pid)) fail('descendant process group survived SIGKILL');
}

function markedProcesses(marker) {
  if (process.platform === 'win32') return [];
  const result = spawnSync('/bin/ps', ['eww', '-axo', 'pid=,pgid=,command='], {
    env: controlEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail('could not enumerate marked gate descendants');
  const needle = `ASHLR_LOCAL_GATE_EXECUTION_ID=${marker}`;
  return result.stdout.split('\n').flatMap((line) => {
    if (!line.includes(needle)) return [];
    const match = line.match(/^\s*([0-9]+)\s+([0-9]+)\s/u);
    return match && Number(match[1]) !== process.pid
      ? [{ pid: Number(match[1]), pgid: Number(match[2]) }]
      : [];
  });
}

function markedProcessIds(marker) {
  return markedProcesses(marker).map(({ pid }) => pid);
}

function markedProcessGroupExists(marker, pgid) {
  return typeof marker === 'string'
    && markedProcesses(marker).some((processInfo) => processInfo.pgid === pgid);
}

function signalProcesses(pids, signal) {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* process already exited */ }
  }
}

async function terminateMarkedDescendants(marker) {
  let pids = markedProcessIds(marker);
  if (pids.length === 0) return;
  signalProcesses(pids, 'SIGTERM');
  await delay(250);
  pids = markedProcessIds(marker);
  signalProcesses(pids, 'SIGKILL');
  await delay(100);
  if (markedProcessIds(marker).length > 0) fail('marked gate descendants survived SIGKILL');
}

export function selectExactGateExecutable(logicalCommand, args, paths) {
  if (logicalCommand === 'cargo' && args[0] === 'fmt') return paths.cargoFmt;
  if (logicalCommand === 'cargo' && args[0] === 'clippy') return paths.cargoClippy;
  const toolKey = logicalCommand === 'cargo-audit' ? 'cargoAudit' : logicalCommand;
  return paths[toolKey] ?? logicalCommand;
}

async function runGate(gate, context) {
  assertToolchainUnchanged(context.tools);
  for (const runtimeTool of Object.values(context.runtimeTools)) runtimeTool.assertUnchanged();
  const logicalCommand = expandArg(gate.cmd[0], context);
  let args = gate.cmd.slice(1).map((arg) => expandArg(arg, context));
  let command = selectExactGateExecutable(logicalCommand, args, context.tools.paths);
  if (logicalCommand === 'cargo-audit') command = context.runtimeTools.cargoAudit.path;
  if (logicalCommand === 'npm') {
    command = context.tools.paths.node;
    args = [context.tools.paths.npmCli, ...args];
  }
  const profile = selectLocalGateSandboxProfile(gate, context.sandboxProfiles);
  if (profile !== null) {
    assertSandboxProfileUnchanged(profile);
    args = ['-f', profile.path, command, ...args];
    command = context.tools.paths.sandboxExec;
  }
  const cwd = resolve(context.repoRoot, gate.cwd);
  const commandBytes = Buffer.from(JSON.stringify({ argv: gate.cmd, cwd: gate.cwd }), 'utf8');
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;
  let resolveSupervisionExpiry;
  let terminationWatchdog = null;
  const supervisionExpiry = new Promise((resolveExpiry) => {
    resolveSupervisionExpiry = resolveExpiry;
  });
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const executionMarker = randomUUID();
  process.stderr.write(`[local-production-gate] start ${gate.id}\n`);
  const child = spawn(command, args, {
    cwd,
    env: { ...context.env, ASHLR_LOCAL_GATE_EXECUTION_ID: executionMarker },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  context.activeChild = child;
  context.activeMarker = executionMarker;
  const requestTermination = () => {
    context.termination ??= terminate(child, executionMarker);
    terminationWatchdog ??= globalThis.setTimeout(() => {
      resolveSupervisionExpiry({ exitCode: null, supervisionExpired: true });
    }, 5_000);
  };
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT_HASH_BYTES) {
      outputExceeded = true;
      requestTermination();
      return;
    }
    stdoutHash.update(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_OUTPUT_HASH_BYTES) {
      outputExceeded = true;
      requestTermination();
      return;
    }
    stderrHash.update(chunk);
    process.stderr.write(chunk);
  });
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, gate.timeoutMs);
  const closePromise = new Promise((resolveClose) => {
    child.once('close', () => resolveClose(true));
  });
  const processResult = new Promise((resolveResult) => {
    child.once('error', (error) => resolveResult({ exitCode: null, error }));
    child.once('exit', (code, signal) => resolveResult({ exitCode: code, signal }));
  });
  const result = await Promise.race([processResult, supervisionExpiry]);
  globalThis.clearTimeout(timer);
  if (terminationWatchdog !== null) globalThis.clearTimeout(terminationWatchdog);
  if (context.termination) await context.termination;
  await ensureProcessTreeGone(child, executionMarker);
  await terminateMarkedDescendants(executionMarker);
  const pipesClosed = await Promise.race([
    closePromise,
    delay(PIPE_CLOSE_GRACE_MS).then(() => false),
  ]);
  if (!pipesClosed) {
    child.stdout.destroy();
    child.stderr.destroy();
    fail(`${gate.id} retained output pipes after process exit`);
  }
  context.activeChild = null;
  context.activeMarker = null;
  if (context.termination) await context.termination;
  context.termination = null;
  const finished = Date.now();
  if (outputExceeded) {
    fail(`${gate.id} exceeded the output bound`);
  }
  if (result.error) fail(`${gate.id} could not start: ${result.error.message}`);
  if (result.supervisionExpired) fail(`${gate.id} did not exit after forced termination`);
  if (timedOut) fail(`${gate.id} exceeded ${gate.timeoutMs}ms`);
  if (result.exitCode !== 0) fail(`${gate.id} exited ${result.exitCode ?? result.signal ?? 'unknown'}`);
  process.stderr.write(`[local-production-gate] pass ${gate.id}\n`);
  return Object.freeze({
    id: gate.id,
    confinement: gate.confinement,
    commandSha256: sha256(commandBytes),
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode: 0,
    stdoutSha256: stdoutHash.digest('hex'),
    stderrSha256: stderrHash.digest('hex'),
  });
}

export function selectLocalGateSandboxProfile(gate, sandboxProfiles) {
  const expected = localProductionGateConfinement(gate.id);
  if (gate.confinement !== expected) fail(`${gate.id} confinement does not match the closed model`);
  if (expected === LOCAL_PRODUCTION_GATE_CONFINEMENT.sanitizedHost) return null;
  return expected === LOCAL_PRODUCTION_GATE_CONFINEMENT.networkEnabledSandbox
    ? sandboxProfiles.networkEnabled
    : sandboxProfiles.networkDenied;
}

function sandboxLiteral(value) {
  return JSON.stringify(value);
}

export function writeSandboxProfiles({ verificationRoot, tempRoot, custodyRoot, profileRoot }) {
  const privateRoot = realpathSync(tempRoot);
  const packEvidencePath = join(privateRoot, 'pack-evidence.json');
  const privateCustodyRoot = realpathSync(custodyRoot);
  const immutableProfileRoot = realpathSync(profileRoot);
  const gitCommonDir = realpathSync(git(verificationRoot, [
    'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]));
  const gitWorktreeDir = realpathSync(git(verificationRoot, [
    'rev-parse', '--path-format=absolute', '--git-dir',
  ]));
  const readableHomePaths = [
    gitCommonDir,
    gitWorktreeDir,
    join(homedir(), '.rustup'),
    join(homedir(), '.cargo', 'bin'),
  ];
  const writablePaths = [
    join(privateRoot, 'tmp'),
    join(privateRoot, 'cargo-home'),
    join(privateRoot, 'cargo-target'),
    join(privateRoot, 'clang-module-cache'),
    join(privateRoot, 'xdg-cache'),
    join(privateRoot, 'npm-cache'),
    join(privateRoot, 'npm-prefix'),
    join(privateRoot, 'pack-smoke'),
    privateCustodyRoot,
    join(realpathSync(verificationRoot), 'node_modules'),
    join(realpathSync(verificationRoot), 'src', 'raycast', 'node_modules'),
    join(realpathSync(verificationRoot), 'dist'),
  ];
  const tauriSchemaRoot = join(realpathSync(verificationRoot), 'desktop', 'src-tauri', 'gen', 'schemas');
  const writableFiles = [
    'acl-manifests.json', 'capabilities.json', 'macOS-schema.json', 'desktop-schema.json',
  ].map((name) => join(tauriSchemaRoot, name));
  const common = [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (require-all ${writablePaths
      .map((path) => `(require-not (subpath ${sandboxLiteral(path)}))`).join(' ')} ${writableFiles
      .map((path) => `(require-not (literal ${sandboxLiteral(path)}))`).join(' ')} (require-not (literal ${sandboxLiteral(packEvidencePath)})) (require-not (literal "/dev/null"))))`,
    `(deny file-read* (require-all (subpath ${sandboxLiteral(homedir())}) ${readableHomePaths
      .map((path) => `(require-not (subpath ${sandboxLiteral(path)}))`).join(' ')}))`,
  ];
  const definitions = {
    networkEnabled: [...common, '(allow network*)', ''].join('\n'),
    networkDenied: [...common,
      '(deny network-outbound)',
      '(allow network-outbound (remote ip "localhost:*"))',
      '',
    ].join('\n'),
  };
  const profiles = {};
  for (const [name, source] of Object.entries(definitions)) {
    const path = join(immutableProfileRoot, `${name}.sb`);
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, source, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const identity = lstatSync(path);
    profiles[name] = Object.freeze({
      path,
      sha256: sha256(Buffer.from(source, 'utf8')),
      dev: identity.dev,
      ino: identity.ino,
    });
  }
  return Object.freeze(profiles);
}

function assertSandboxProfileUnchanged(profile) {
  const identity = lstatSync(profile.path);
  if (!identity.isFile() || identity.isSymbolicLink()
    || identity.dev !== profile.dev || identity.ino !== profile.ino
    || fileSha256(profile.path) !== profile.sha256) {
    fail('sandbox profile changed during local verification');
  }
}

function samePackEvidenceIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function parsePrivatePackEvidence(tempRoot) {
  const privateRoot = realpathSync(tempRoot);
  const path = join(privateRoot, 'pack-evidence.json');
  const namedBefore = lstatSync(path, { bigint: true });
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1n
    || namedBefore.uid !== BigInt(process.getuid()) || (namedBefore.mode & 0o7777n) !== 0o600n
    || namedBefore.size < 1n || namedBefore.size > BigInt(MAX_PACK_EVIDENCE_BYTES)
    || dirname(path) !== privateRoot || realpathSync(path) !== path) {
    fail('pack evidence path or custody is invalid');
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!samePackEvidenceIdentity(namedBefore, openedBefore)) {
      fail('pack evidence identity changed before read');
    }
    bytes = readFileSync(fd);
    const openedAfter = fstatSync(fd, { bigint: true });
    if (!samePackEvidenceIdentity(openedBefore, openedAfter)
      || bytes.length !== Number(openedAfter.size)) {
      fail('pack evidence changed during read');
    }
  } finally {
    closeSync(fd);
  }
  const namedAfter = lstatSync(path, { bigint: true });
  if (!samePackEvidenceIdentity(namedBefore, namedAfter) || realpathSync(path) !== path) {
    fail('pack evidence identity changed after read');
  }
  const value = JSON.parse(bytes.toString('utf8'));
  exactKeys(value, ['schemaVersion', 'name', 'version', 'tarballName', 'sha256', 'integrity', 'size'], 'pack evidence');
  if (value.schemaVersion !== 1 || value.name !== '@ashlr/hub'
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 64 * 1024 * 1024
    || !SHA256_RE.test(value.sha256) || !INTEGRITY_RE.test(value.integrity)) {
    fail('pack evidence is invalid');
  }
  return value;
}

function writeBytesExclusive(repoRoot, output, bytes) {
  revalidateExternalOutput(repoRoot, output);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0);
  let identity = null;
  const fd = openSync(output.path, flags, 0o600);
  try {
    identity = fstatSync(fd);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    removeOwnedOutput(output.path, identity);
    throw error;
  }
  closeSync(fd);
  let dirFd = null;
  try {
    dirFd = openSync(dirname(output.path), 'r');
    fsyncSync(dirFd);
  } catch (error) {
    removeOwnedOutput(output.path, identity);
    throw error;
  } finally {
    if (dirFd !== null) closeSync(dirFd);
  }
  try {
    revalidateExternalOutput(repoRoot, output);
  } catch (error) {
    removeOwnedOutput(output.path, identity);
    throw error;
  }
  return Object.freeze({ dev: identity.dev, ino: identity.ino });
}

function removeOwnedOutput(path, identity) {
  if (!identity || !existsSync(path)) return;
  const current = lstatSync(path);
  if (current.dev === identity.dev && current.ino === identity.ino) rmSync(path);
}

function writeReceiptExclusive(repoRoot, output, receipt) {
  validateLocalProductionGateReceipt(receipt);
  const bytes = Buffer.from(`${canonicalizeLocalProductionGateReceipt(receipt)}\n`, 'utf8');
  const identity = writeBytesExclusive(repoRoot, output, bytes);
  return Object.freeze({ bytes, sha256: sha256(bytes), identity });
}

export function createIsolatedGateEnvironment({ repoRoot, tempRoot, custodyRoot, tools }) {
  const privateTemp = join(tempRoot, 'tmp');
  const operationalHome = join(custodyRoot, 'home');
  const testHomeParent = join(custodyRoot, 'vitest-homes');
  const cargoHome = join(tempRoot, 'cargo-home');
  const cargoTarget = join(tempRoot, 'cargo-target');
  const clangModuleCache = join(tempRoot, 'clang-module-cache');
  const xdgCache = join(tempRoot, 'xdg-cache');
  const npmCache = join(tempRoot, 'npm-cache');
  for (const path of [
    privateTemp, operationalHome, testHomeParent, cargoHome, cargoTarget, npmCache,
    clangModuleCache, xdgCache,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const npmrcPaths = {
    user: join(tempRoot, 'empty-user-npmrc'),
    global: join(tempRoot, 'empty-global-npmrc'),
  };
  for (const path of Object.values(npmrcPaths)) {
    const npmrcFd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(npmrcFd, '\n', 'utf8');
      fsyncSync(npmrcFd);
    } finally {
      closeSync(npmrcFd);
    }
  }
  return Object.freeze({
    PATH: [...new Set([
      dirname(tools.paths.node), dirname(tools.paths.cargoAudit), dirname(tools.paths.osvScanner),
      dirname(tools.paths.git),
      '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    ])].join(':'),
    HOME: operationalHome,
    USERPROFILE: operationalHome,
    USER: 'ashlr-local-gate',
    LOGNAME: 'ashlr-local-gate',
    SHELL: '/bin/sh',
    TMPDIR: privateTemp,
    TMP: privateTemp,
    TEMP: privateTemp,
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ASHLR_HOME: join(operationalHome, '.ashlr'),
    ASHLR_VITEST_HOME_PARENT: testHomeParent,
    ASHLR_REPRODUCIBLE_PACKAGE: '1',
    ASHLR_RUN_NATIVE_LAUNCHD_TEST: '0',
    AUDIT_TIMEOUT_BIN: join(repoRoot, 'scripts', 'run-bounded-command.mjs'),
    AUDIT_NODE_BIN: tools.paths.node,
    AUDIT_NPM_CLI: tools.paths.npmCli,
    AUDIT_OSV_BIN: tools.paths.osvScanner,
    ASHLR_NPM_CLI: tools.paths.npmCli,
    NPM_CONFIG_USERCONFIG: npmrcPaths.user,
    NPM_CONFIG_GLOBALCONFIG: npmrcPaths.global,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_PREFIX: join(tempRoot, 'npm-prefix'),
    NPM_CONFIG_SCRIPT_SHELL: '/bin/sh',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: cargoTarget,
    CLANG_MODULE_CACHE_PATH: clangModuleCache,
    XDG_CACHE_HOME: xdgCache,
    CARGO: tools.paths.cargo,
    RUSTC: tools.paths.rustc,
    RUSTDOC: tools.paths.rustdoc,
    RUSTFMT: tools.paths.rustfmt,
    DEVELOPER_DIR: tools.apple.developerDirectory,
    SDKROOT: tools.apple.macosSdkRoot,
    MACOSX_DEPLOYMENT_TARGET: tools.apple.macosDeploymentTarget,
  });
}

export async function runLocalProductionGate({ repoRoot, options }) {
  const controllingRepo = realpathSync(repoRoot);
  const artifactOutput = assertExternalReceiptPath(controllingRepo, options.artifactPath);
  const receiptOutput = assertExternalReceiptPath(controllingRepo, options.receiptPath);
  const artifactPath = artifactOutput.path;
  const receiptPath = receiptOutput.path;
  const source = ensureCleanExactSource(repoRoot, options.expectedSha);
  const tempDirectory = createPrivateLocalGateTempRoot();
  const tempRoot = tempDirectory.path;
  const verificationRoot = join(tempRoot, 'source');
  let custodyRoot = null;
  let profileRoot = null;
  let tools = null;
  let runtimeTools = null;
  let worktreeAdded = false;
  let sidecar = null;
  let tauriGeneratedRoot = null;
  let tauriCheckIcon = null;
  let context = null;
  let interruptedSignal = null;
  let primaryError = null;
  let outcome = null;
  const cleanupErrors = [];
  const handleSignal = (signal) => {
    interruptedSignal = signal;
    if (context?.activeChild) {
      context.termination ??= terminate(context.activeChild, context.activeMarker);
    }
  };
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.on(signal, handleSignal);
  }
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    custodyRoot = createPrivateLocalGateCustodyRoot();
    profileRoot = createPrivateLocalGateTempDirectory('agp-');
    assertDisjointRoots(tempRoot, custodyRoot.path, profileRoot.path);
    tools = resolveToolchain(controllingRepo);
    runtimeTools = Object.freeze({
      cargoAudit: prepareImmutableToolCopy(
        tools.paths.cargoAudit,
        tools.executables.cargoAudit.sha256,
        profileRoot.path,
        'cargo-audit',
      ),
    });
    git(controllingRepo, [
      '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', verificationRoot,
      options.expectedSha,
    ]);
    worktreeAdded = true;
    const verificationSource = ensureCleanExactSource(verificationRoot, options.expectedSha);
    if (verificationSource.tree !== source.tree) fail('detached verification tree does not match source');

    const policyPath = safeTrackedPolicy(verificationRoot, options.policyPath);
    const policyResult = verifyReleaseSuccessorPolicyFile(policyPath);
    verifyPolicyGitBindings(verificationRoot, policyResult.policy);
    const packageJson = JSON.parse(readFileSync(join(verificationRoot, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(readFileSync(join(verificationRoot, 'package-lock.json'), 'utf8'));
    if (packageJson.name !== '@ashlr/hub' || packageJson.version !== policyResult.policy.package.version
      || packageLock.name !== packageJson.name || packageLock.version !== packageJson.version
      || packageLock.packages?.['']?.version !== packageJson.version) {
      fail('package, lockfile, and policy identity must match exactly');
    }
    if (basename(artifactPath) !== `ashlr-hub-${packageJson.version}.tgz`) {
      fail(`artifact filename must be ashlr-hub-${packageJson.version}.tgz`);
    }
    const contractPath = join(verificationRoot, 'ashlr.verify.json');
    const contractBytes = readFileSync(contractPath);
    const contractSha256 = sha256(contractBytes);
    if (policyResult.policy.localVerification.contractSha256 !== contractSha256) {
      fail('release policy does not bind the exact ashlr.verify.json bytes');
    }
    const contract = validateLocalProductionContract(JSON.parse(contractBytes.toString('utf8')));
    if (policyResult.policy.localVerification.requiredReceiptSchemaVersion
      !== contract.receiptSchemaVersion) {
      fail('release policy receipt schema does not match the local production contract');
    }
    const env = createIsolatedGateEnvironment({
      repoRoot: verificationRoot, tempRoot, custodyRoot: custodyRoot.path, tools,
    });
    const npmVersion = sync(
      tools.paths.node, [tools.paths.npmCli, '--version'], verificationRoot, env,
    );
    const toolchain = validateLocalGateToolchain({
      nodeVersion: process.versions.node,
      npmVersion,
      policy: policyResult.policy,
    });
    const rustcVerbose = sync(tools.paths.rustc, ['-vV'], verificationRoot, env);
    const rustcVersion = rustcVerbose.split('\n')[0];
    const cargoVersion = sync(tools.paths.cargo, ['--version'], verificationRoot, env);
    const cargoAuditVersion = sync(
      tools.paths.cargoAudit, ['--version'], verificationRoot, env,
    );
    if (cargoAuditVersion !== 'cargo-audit 0.22.2') {
      fail('cargo-audit must be exactly 0.22.2');
    }
    const sandboxProfiles = writeSandboxProfiles({
      verificationRoot, tempRoot, custodyRoot: custodyRoot.path, profileRoot: profileRoot.path,
    });
    context = {
      repoRoot: verificationRoot,
      tempRoot,
      env,
      tools,
      runtimeTools,
      sandboxProfiles,
      activeChild: null,
      activeMarker: null,
      termination: null,
    };
    for (const gate of contract.gates) {
      if (interruptedSignal) fail(`interrupted by ${interruptedSignal}`);
      tempDirectory.assertUnchanged();
      custodyRoot.assertUnchanged();
      profileRoot.assertUnchanged();
      const sanitizedHost = gate.confinement === LOCAL_PRODUCTION_GATE_CONFINEMENT.sanitizedHost;
      if (sanitizedHost) {
        const beforeTest = ensureCleanExactSource(verificationRoot, options.expectedSha);
        if (beforeTest.tree !== source.tree) fail(`${gate.id} source tree changed before execution`);
      }
      if (gate.id === 'native-check') {
        sidecar = prepareDisposableTauriSidecar(verificationRoot, rustcVerbose);
        tauriGeneratedRoot = prepareDisposableTauriGeneratedRoot(verificationRoot);
        tauriCheckIcon = prepareDisposableTauriCheckIcon(verificationRoot);
      }
      results.push(await runGate(gate, context));
      tauriGeneratedRoot?.assertUnchanged();
      tauriCheckIcon?.assertUnchanged();
      tempDirectory.assertUnchanged();
      custodyRoot.assertUnchanged();
      profileRoot.assertUnchanged();
      if (sanitizedHost) {
        const afterTest = ensureCleanExactSource(verificationRoot, options.expectedSha);
        if (afterTest.tree !== source.tree) fail(`${gate.id} source tree changed during execution`);
        verifyPolicyGitBindings(verificationRoot, policyResult.policy);
      }
    }
    if (sidecar) {
      sidecar.cleanup();
      sidecar = null;
    }
    if (tauriGeneratedRoot) {
      tauriGeneratedRoot.cleanup();
      tauriGeneratedRoot = null;
    }
    if (tauriCheckIcon) {
      tauriCheckIcon.cleanup();
      tauriCheckIcon = null;
    }
    if (interruptedSignal) fail(`interrupted by ${interruptedSignal}`);

    tempDirectory.assertUnchanged();
    custodyRoot.assertUnchanged();
    profileRoot.assertUnchanged();
    const verificationAfter = ensureCleanExactSource(verificationRoot, options.expectedSha);
    if (verificationAfter.tree !== source.tree) fail('source tree changed during verification');
    const pack = parsePrivatePackEvidence(tempRoot);
    if (pack.name !== packageJson.name || pack.version !== packageJson.version
      || pack.tarballName !== policyResult.policy.package.tarballName
      || pack.integrity !== policyResult.policy.package.integrity) {
      fail('packed tarball identity or SRI does not match the release policy');
    }
    const temporaryArtifactPath = join(
      tempRoot, 'pack-smoke', 'pack', `ashlr-hub-${packageJson.version}.tgz`,
    );
    const temporaryArtifact = lstatSync(temporaryArtifactPath);
    if (!temporaryArtifact.isFile() || temporaryArtifact.isSymbolicLink()
      || temporaryArtifact.size !== pack.size) {
      fail('verified tarball path or size does not match the pack evidence');
    }
    const artifactBytes = readFileSync(temporaryArtifactPath);
    if (sha256(artifactBytes) !== pack.sha256
      || `sha512-${createHash('sha512').update(artifactBytes).digest('base64')}` !== pack.integrity) {
      fail('verified tarball bytes do not match the pack evidence');
    }

    tempDirectory.assertUnchanged();
    custodyRoot.assertUnchanged();
    git(controllingRepo, ['worktree', 'remove', '--force', verificationRoot]);
    worktreeAdded = false;
    const sourceAfter = ensureCleanExactSource(controllingRepo, options.expectedSha);
    if (sourceAfter.tree !== source.tree) fail('controlling source changed during verification');
    if (interruptedSignal) fail(`interrupted by ${interruptedSignal}`);
    const artifactIdentity = writeBytesExclusive(controllingRepo, artifactOutput, artifactBytes);
    const receipt = {
      schemaVersion: LOCAL_PRODUCTION_GATE_RECEIPT_SCHEMA_VERSION,
      kind: 'ashlr-local-production-gate-receipt-v3',
      assurance: 'local-source-verification-only',
      source: { ...source, cleanBefore: true, cleanAfter: true },
      toolchain: {
        ...toolchain, rustcVersion, cargoVersion, cargoAuditVersion,
        ...tools.apple,
        executables: tools.executables,
        files: tools.files,
      },
      bindings: {
        policy: {
          policyId: policyResult.policy.policyId,
          version: policyResult.policy.package.version,
          sha256: policyResult.canonicalSha256,
        },
        contract: { path: 'ashlr.verify.json', sha256: contractSha256 },
        package: {
          name: pack.name,
          version: pack.version,
          tarballName: pack.tarballName,
          sha256: pack.sha256,
          integrity: pack.integrity,
        },
      },
      execution: {
        startedAt,
        finishedAt: new Date().toISOString(),
        hostPlatform: process.platform,
        confinementModel: 'closed-per-gate-v1',
        sanitizedEnvironment: 'allowlisted-disposable-home-temp-cache-and-ashlr-home',
        sandboxProfiles: {
          networkEnabledSha256: sandboxProfiles.networkEnabled.sha256,
          networkDeniedSha256: sandboxProfiles.networkDenied.sha256,
        },
        externalEffects: 'evidence-writes-recorded;same-uid-output-parent-swap-and-other-effects-not-attested',
        operationalAshlrHome: 'redirected-to-disposable-root',
        disposableSidecar: 'created-exclusive-and-removed-before-receipt',
        disposableTauriGeneratedRoot: 'created-exclusive-and-removed-before-receipt',
        disposableTauriCheckIcon: 'created-exclusive-and-removed-before-receipt',
        cargoAuditRuntime: 'digest-matched-copy-in-immutable-profile-root',
      },
      gates: results,
      authority: { ...LOCAL_PRODUCTION_GATE_AUTHORITY },
      verdict: 'passed',
    };
    let written;
    try {
      if (interruptedSignal) fail(`interrupted by ${interruptedSignal}`);
      written = writeReceiptExclusive(controllingRepo, receiptOutput, receipt);
      const finalSource = ensureCleanExactSource(controllingRepo, options.expectedSha);
      if (finalSource.tree !== source.tree) fail('controlling source changed during receipt publication');
      if (interruptedSignal) fail(`interrupted by ${interruptedSignal}`);
    } catch (error) {
      removeOwnedOutput(artifactPath, artifactIdentity);
      if (written) removeOwnedOutput(receiptPath, written.identity);
      throw error;
    }
    if (interruptedSignal) {
      removeOwnedOutput(artifactPath, artifactIdentity);
      removeOwnedOutput(receiptPath, written.identity);
      fail(`interrupted by ${interruptedSignal}`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true, artifactPath, receiptPath, receiptSha256: written.sha256, revision: source.revision,
      tree: source.tree, packageIntegrity: pack.integrity, authority: receipt.authority,
    })}\n`);
    outcome = Object.freeze({ receipt, receiptPath, receiptSha256: written.sha256 });
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
      process.off(signal, handleSignal);
    }
    if (context?.termination) await cleanup(() => context.termination);
    if (context?.activeChild) {
      await cleanup(() => ensureProcessTreeGone(context.activeChild, context.activeMarker));
    }
    if (sidecar) await cleanup(() => {
      tempDirectory.assertUnchanged();
      sidecar.cleanup();
    });
    if (tauriGeneratedRoot) await cleanup(() => {
      tempDirectory.assertUnchanged();
      tauriGeneratedRoot.cleanup();
    });
    if (tauriCheckIcon) await cleanup(() => {
      tempDirectory.assertUnchanged();
      tauriCheckIcon.cleanup();
    });
    if (worktreeAdded) {
      await cleanup(() => {
        tempDirectory.assertUnchanged();
        return git(controllingRepo, ['worktree', 'remove', '--force', verificationRoot]);
      });
    }
    await cleanup(() => tempDirectory.cleanup());
    if (custodyRoot) await cleanup(() => custodyRoot.cleanup());
    if (profileRoot) await cleanup(() => profileRoot.cleanup());
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'local production gate cleanup failed',
    );
  }
  if (primaryError) throw primaryError;
  return outcome;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  try {
    const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    await runLocalProductionGate({ repoRoot, options: parseLocalGateArgs(process.argv.slice(2)) });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
