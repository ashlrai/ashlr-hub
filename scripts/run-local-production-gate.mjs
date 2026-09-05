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
  LOCAL_PRODUCTION_GATE_IDS,
  LOCAL_PRODUCTION_GATE_NETWORK_ENABLED_IDS,
  validateLocalProductionGateReceipt,
} from './verify-local-production-gate-receipt.mjs';

const REVISION_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const MAX_OUTPUT_HASH_BYTES = 16 * 1024 * 1024;
const PIPE_CLOSE_GRACE_MS = 2_000;
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
    || local.receiptSchemaVersion !== 1 || !Array.isArray(local.gates)
    || local.gates.length !== LOCAL_PRODUCTION_GATE_IDS.length) {
    fail('localProductionGate identity or gate count is invalid');
  }
  const seen = new Set();
  const gates = local.gates.map((value, index) => {
    const gate = exactKeys(value, ['id', 'cmd', 'cwd', 'timeoutMs'], `localProductionGate.gates[${index}]`);
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
    if (gate.id !== expectedId || gate.cwd !== expectedCwd || gate.timeoutMs !== expectedTimeout
      || gate.cmd.length !== expectedCmd.length
      || gate.cmd.some((part, partIndex) => part !== expectedCmd[partIndex])) {
      fail(`localProductionGate.gates[${index}] does not match the closed v1 command`);
    }
    return Object.freeze({ id: gate.id, cmd: Object.freeze([...gate.cmd]), cwd: gate.cwd, timeoutMs: gate.timeoutMs });
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
  const cargoAuditPath = discoverExecutable('cargo-audit', repoRoot);
  const osvScannerPath = discoverExecutable('osv-scanner', repoRoot);
  const paths = {
    node: nodePath,
    npmCli: npmCliPath,
    npmRuntime: npmRuntimePath,
    bash: '/bin/bash',
    git: SYSTEM_GIT,
    rustc: rustcPath,
    rustdoc: rustdocPath,
    cargo: cargoPath,
    cargoAudit: cargoAuditPath,
    osvScanner: osvScannerPath,
    sandboxExec: '/usr/bin/sandbox-exec',
  };
  const executables = Object.fromEntries(Object.entries(paths).map(([name, path]) => [
    name,
    Object.freeze({
      path,
      sha256: name === 'npmRuntime' ? directorySha256(path) : fileSha256(path),
    }),
  ]));
  return Object.freeze({ paths: Object.freeze(paths), executables: Object.freeze(executables) });
}

function assertToolchainUnchanged(tools) {
  for (const [name, executable] of Object.entries(tools.executables)) {
    const actual = name === 'npmRuntime'
      ? directorySha256(executable.path)
      : fileSha256(executable.path);
    if (actual !== executable.sha256) fail(`${name} changed during local verification`);
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

async function runGate(gate, context) {
  assertToolchainUnchanged(context.tools);
  const logicalCommand = expandArg(gate.cmd[0], context);
  const toolKey = logicalCommand === 'cargo-audit' ? 'cargoAudit' : logicalCommand;
  let command = context.tools.paths[toolKey] ?? logicalCommand;
  let args = gate.cmd.slice(1).map((arg) => expandArg(arg, context));
  if (logicalCommand === 'npm') {
    command = context.tools.paths.node;
    args = [context.tools.paths.npmCli, ...args];
  }
  const profile = LOCAL_PRODUCTION_GATE_NETWORK_ENABLED_IDS.includes(gate.id)
    ? context.sandboxProfiles.networkEnabled.path
    : context.sandboxProfiles.networkDenied.path;
  assertSandboxProfileUnchanged(LOCAL_PRODUCTION_GATE_NETWORK_ENABLED_IDS.includes(gate.id)
    ? context.sandboxProfiles.networkEnabled
    : context.sandboxProfiles.networkDenied);
  args = ['-f', profile, command, ...args];
  command = context.tools.paths.sandboxExec;
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
    commandSha256: sha256(commandBytes),
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode: 0,
    stdoutSha256: stdoutHash.digest('hex'),
    stderrSha256: stderrHash.digest('hex'),
  });
}

function sandboxLiteral(value) {
  return JSON.stringify(value);
}

export function writeSandboxProfiles({ verificationRoot, tempRoot, profileRoot }) {
  const privateRoot = realpathSync(tempRoot);
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
    join(privateRoot, 'home'),
    join(privateRoot, 'cargo-home'),
    join(privateRoot, 'cargo-target'),
    join(privateRoot, 'npm-cache'),
    join(privateRoot, 'npm-prefix'),
    join(privateRoot, 'pack-smoke'),
    join(realpathSync(verificationRoot), 'node_modules'),
    join(realpathSync(verificationRoot), 'src', 'raycast', 'node_modules'),
    join(realpathSync(verificationRoot), 'dist'),
  ];
  const common = [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (require-all ${writablePaths
      .map((path) => `(require-not (subpath ${sandboxLiteral(path)}))`).join(' ')} (require-not (literal "/dev/null"))))`,
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

function parsePackEvidence(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
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

export function createIsolatedGateEnvironment({ repoRoot, tempRoot, tools }) {
  const privateTemp = join(tempRoot, 'tmp');
  const operationalHome = join(tempRoot, 'home');
  const cargoHome = join(tempRoot, 'cargo-home');
  const cargoTarget = join(tempRoot, 'cargo-target');
  const npmCache = join(tempRoot, 'npm-cache');
  for (const path of [privateTemp, operationalHome, cargoHome, cargoTarget, npmCache]) {
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
    RUSTC: tools.paths.rustc,
    RUSTDOC: tools.paths.rustdoc,
  });
}

export async function runLocalProductionGate({ repoRoot, options }) {
  const controllingRepo = realpathSync(repoRoot);
  const artifactOutput = assertExternalReceiptPath(controllingRepo, options.artifactPath);
  const receiptOutput = assertExternalReceiptPath(controllingRepo, options.receiptPath);
  const artifactPath = artifactOutput.path;
  const receiptPath = receiptOutput.path;
  const source = ensureCleanExactSource(repoRoot, options.expectedSha);
  const tempRoot = mkdtempSync(join(tmpdir(), 'ashlr-local-production-gate-'));
  const verificationRoot = join(tempRoot, 'source');
  let profileRoot = null;
  let tools = null;
  let worktreeAdded = false;
  let sidecar = null;
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
    profileRoot = mkdtempSync(join(tmpdir(), 'ashlr-local-production-profiles-'));
    tools = resolveToolchain(controllingRepo);
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
    const env = createIsolatedGateEnvironment({ repoRoot: verificationRoot, tempRoot, tools });
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
    const sandboxProfiles = writeSandboxProfiles({ verificationRoot, tempRoot, profileRoot });
    context = {
      repoRoot: verificationRoot,
      tempRoot,
      env,
      tools,
      sandboxProfiles,
      activeChild: null,
      activeMarker: null,
      termination: null,
    };
    for (const gate of contract.gates) {
      if (interruptedSignal) fail(`interrupted by ${interruptedSignal}`);
      if (gate.id === 'native-check') {
        sidecar = prepareDisposableTauriSidecar(verificationRoot, rustcVerbose);
      }
      results.push(await runGate(gate, context));
    }
    if (sidecar) {
      sidecar.cleanup();
      sidecar = null;
    }
    if (interruptedSignal) fail(`interrupted by ${interruptedSignal}`);

    const verificationAfter = ensureCleanExactSource(verificationRoot, options.expectedSha);
    if (verificationAfter.tree !== source.tree) fail('source tree changed during verification');
    const pack = parsePackEvidence(join(tempRoot, 'pack-evidence.json'));
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

    git(controllingRepo, ['worktree', 'remove', '--force', verificationRoot]);
    worktreeAdded = false;
    const sourceAfter = ensureCleanExactSource(controllingRepo, options.expectedSha);
    if (sourceAfter.tree !== source.tree) fail('controlling source changed during verification');
    if (interruptedSignal) fail(`interrupted by ${interruptedSignal}`);
    const artifactIdentity = writeBytesExclusive(controllingRepo, artifactOutput, artifactBytes);
    const receipt = {
      schemaVersion: 1,
      kind: 'ashlr-local-production-gate-receipt-v1',
      assurance: 'local-source-verification-only',
      source: { ...source, cleanBefore: true, cleanAfter: true },
      toolchain: {
        ...toolchain, rustcVersion, cargoVersion, cargoAuditVersion,
        executables: tools.executables,
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
        networkIsolation: 'non-loopback-ip-egress-denied-for-source-gates',
        networkEnabledGateIds: [...LOCAL_PRODUCTION_GATE_NETWORK_ENABLED_IDS],
        filesystemIsolation: 'write-allowlist-and-user-home-read-deny;host-ipc-system-reads-and-hostile-env-clearing-descendants-not-isolated',
        sandboxProfiles: {
          networkEnabledSha256: sandboxProfiles.networkEnabled.sha256,
          networkDeniedSha256: sandboxProfiles.networkDenied.sha256,
        },
        externalEffects: 'evidence-writes-recorded;same-uid-output-parent-swap-and-other-effects-not-attested',
        operationalAshlrHome: 'redirected-to-disposable-root',
        disposableSidecar: 'created-exclusive-and-removed-before-receipt',
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
    if (sidecar) await cleanup(() => sidecar.cleanup());
    if (worktreeAdded) {
      await cleanup(() => git(controllingRepo, ['worktree', 'remove', '--force', verificationRoot]));
    }
    await cleanup(() => rmSync(tempRoot, { recursive: true, force: true }));
    if (profileRoot) await cleanup(() => rmSync(profileRoot, { recursive: true, force: true }));
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
