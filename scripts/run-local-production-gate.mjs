#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { verifyReleaseSuccessorPolicyFile } from './verify-release-policy.mjs';
import {
  canonicalizeLocalProductionGateReceipt,
  LOCAL_PRODUCTION_GATE_AUTHORITY,
  LOCAL_PRODUCTION_GATE_COMMANDS,
  LOCAL_PRODUCTION_GATE_IDS,
  validateLocalProductionGateReceipt,
} from './verify-local-production-gate-receipt.mjs';

const REVISION_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const MAX_OUTPUT_HASH_BYTES = 1024 * 1024 * 1024;
function fail(message) {
  throw new Error(`local production gate: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

function git(repo, args) {
  return sync('git', args, repo);
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
    if (!['--expected-sha', '--policy', '--receipt'].includes(flag)
      || value === undefined || values[flag] !== undefined) {
      fail(`invalid or duplicate option ${flag ?? '<missing>'}`);
    }
    values[flag] = value;
  }
  if (!values['--expected-sha'] || !values['--policy'] || !values['--receipt']) {
    fail('usage: run-local-production-gate.mjs --expected-sha <40-hex> --policy <tracked-json> --receipt <absolute-external-path>');
  }
  if (!REVISION_RE.test(values['--expected-sha'])) fail('--expected-sha must be lowercase 40-hex');
  if (!isAbsolute(values['--receipt'])) fail('--receipt must be an absolute path');
  return {
    expectedSha: values['--expected-sha'],
    policyPath: values['--policy'],
    receiptPath: resolve(values['--receipt']),
  };
}

export function assertExternalReceiptPath(repoRoot, receiptPath) {
  if (existsSync(receiptPath)) fail('receipt path already exists; refusing to overwrite evidence');
  const repoReal = realpathSync(repoRoot);
  const parentReal = realpathSync(dirname(receiptPath));
  const candidate = join(parentReal, receiptPath.slice(dirname(receiptPath).length + 1));
  if (candidate === repoReal || candidate.startsWith(`${repoReal}${sep}`)) {
    fail('receipt path must be outside the repository');
  }
  if (!lstatSync(parentReal).isDirectory()) fail('receipt parent must be a directory');
  return candidate;
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
  const revision = git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (revision !== expectedSha) fail(`HEAD ${revision} does not equal --expected-sha ${expectedSha}`);
  const status = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') fail('repository must be exactly clean');
  return Object.freeze({ revision, tree: git(repoRoot, ['rev-parse', 'HEAD^{tree}']) });
}

function safeTrackedPolicy(repoRoot, suppliedPath) {
  const candidate = realpathSync(resolve(repoRoot, suppliedPath));
  const rel = relative(realpathSync(repoRoot), candidate);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..'
    || !/^\.github\/release-policies\/v[^/]+\.json$/u.test(rel.replaceAll(sep, '/'))) {
    fail('policy must be a tracked versioned file under .github/release-policies');
  }
  sync('git', ['ls-files', '--error-unmatch', '--', rel], repoRoot);
  return candidate;
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
  let owned = true;
  return Object.freeze({
    path,
    cleanup: () => {
      if (!owned) return;
      rmSync(path);
      owned = false;
    },
  });
}

function expandArg(value, context) {
  return value.replaceAll('{repo}', context.repoRoot).replaceAll('{temp}', context.tempRoot);
}

async function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await delay(2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

async function runGate(gate, context) {
  const command = expandArg(gate.cmd[0], context);
  const args = gate.cmd.slice(1).map((arg) => expandArg(arg, context));
  const cwd = resolve(context.repoRoot, gate.cwd);
  const commandBytes = Buffer.from(JSON.stringify({ argv: gate.cmd, cwd: gate.cwd }), 'utf8');
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  process.stderr.write(`[local-production-gate] start ${gate.id}\n`);
  const child = spawn(command, args, {
    cwd,
    env: context.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT_HASH_BYTES) void terminate(child);
    stdoutHash.update(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_OUTPUT_HASH_BYTES) void terminate(child);
    stderrHash.update(chunk);
    process.stderr.write(chunk);
  });
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    void terminate(child);
  }, gate.timeoutMs);
  const result = await new Promise((resolveResult) => {
    child.once('error', (error) => resolveResult({ exitCode: null, error }));
    child.once('exit', (code, signal) => resolveResult({ exitCode: code, signal }));
  });
  globalThis.clearTimeout(timer);
  const finished = Date.now();
  if (stdoutBytes > MAX_OUTPUT_HASH_BYTES || stderrBytes > MAX_OUTPUT_HASH_BYTES) {
    fail(`${gate.id} exceeded the output bound`);
  }
  if (result.error) fail(`${gate.id} could not start: ${result.error.message}`);
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

function parsePackEvidence(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  exactKeys(value, ['schemaVersion', 'name', 'version', 'tarballName', 'sha256', 'integrity', 'size'], 'pack evidence');
  if (value.schemaVersion !== 1 || value.name !== '@ashlr/hub'
    || !Number.isSafeInteger(value.size) || value.size < 1
    || !SHA256_RE.test(value.sha256) || !INTEGRITY_RE.test(value.integrity)) {
    fail('pack evidence is invalid');
  }
  return value;
}

function writeReceiptExclusive(path, receipt) {
  validateLocalProductionGateReceipt(receipt);
  const bytes = Buffer.from(`${canonicalizeLocalProductionGateReceipt(receipt)}\n`, 'utf8');
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return Object.freeze({ bytes, sha256: sha256(bytes) });
}

export async function runLocalProductionGate({ repoRoot, options }) {
  const receiptPath = assertExternalReceiptPath(repoRoot, options.receiptPath);
  const source = ensureCleanExactSource(repoRoot, options.expectedSha);
  const policyPath = safeTrackedPolicy(repoRoot, options.policyPath);
  const policyResult = verifyReleaseSuccessorPolicyFile(policyPath);
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  if (packageJson.name !== '@ashlr/hub' || packageJson.version !== policyResult.policy.package.version
    || packageLock.name !== packageJson.name || packageLock.version !== packageJson.version
    || packageLock.packages?.['']?.version !== packageJson.version) {
    fail('package, lockfile, and policy identity must match exactly');
  }
  const contractPath = join(repoRoot, 'ashlr.verify.json');
  const contractBytes = readFileSync(contractPath);
  const contractSha256 = sha256(contractBytes);
  if (policyResult.policy.localVerification.contractSha256 !== contractSha256) {
    fail('release policy does not bind the exact ashlr.verify.json bytes');
  }
  const contract = validateLocalProductionContract(JSON.parse(contractBytes.toString('utf8')));
  const npmVersion = sync('npm', ['--version'], repoRoot);
  const toolchain = validateLocalGateToolchain({
    nodeVersion: process.versions.node,
    npmVersion,
    policy: policyResult.policy,
  });
  const rustcVerbose = sync('rustc', ['-vV'], repoRoot);
  const rustcVersion = rustcVerbose.split('\n')[0];
  const cargoVersion = sync('cargo', ['--version'], repoRoot);
  const cargoAuditVersion = sync('cargo-audit', ['--version'], repoRoot);
  if (cargoAuditVersion !== 'cargo-audit 0.22.2') {
    fail('cargo-audit must be exactly 0.22.2');
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'ashlr-local-production-gate-'));
  const operationalHome = join(tempRoot, 'home');
  mkdirSync(operationalHome, { mode: 0o700 });
  const originalHome = homedir();
  const env = {
    ...process.env,
    HOME: operationalHome,
    USERPROFILE: operationalHome,
    ASHLR_HOME: join(operationalHome, '.ashlr'),
    CI: '1',
    ASHLR_RUN_NATIVE_LAUNCHD_TEST: '0',
    AUDIT_TIMEOUT_BIN: join(repoRoot, 'scripts', 'run-bounded-command.mjs'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(originalHome, '.rustup'),
    CARGO_HOME: process.env.CARGO_HOME ?? join(originalHome, '.cargo'),
  };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  const context = { repoRoot, tempRoot, env };
  const startedAt = new Date().toISOString();
  const results = [];
  let sidecar = null;
  try {
    for (const gate of contract.gates) {
      if (gate.id === 'native-check') {
        sidecar = prepareDisposableTauriSidecar(repoRoot, rustcVerbose);
      }
      results.push(await runGate(gate, context));
    }
    if (sidecar) {
      sidecar.cleanup();
      sidecar = null;
    }

    const sourceAfter = ensureCleanExactSource(repoRoot, options.expectedSha);
    if (sourceAfter.tree !== source.tree) fail('source tree changed during verification');
    const pack = parsePackEvidence(join(tempRoot, 'pack-evidence.json'));
    if (pack.name !== packageJson.name || pack.version !== packageJson.version
      || pack.tarballName !== policyResult.policy.package.tarballName
      || pack.integrity !== policyResult.policy.package.integrity) {
      fail('packed tarball identity or SRI does not match the release policy');
    }
    const receipt = {
      schemaVersion: 1,
      kind: 'ashlr-local-production-gate-receipt-v1',
      assurance: 'local-source-verification-only',
      source: { ...source, cleanBefore: true, cleanAfter: true },
      toolchain: { ...toolchain, rustcVersion, cargoVersion, cargoAuditVersion },
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
        networkUse: 'dependency-and-advisory-reads-only',
        externalMutations: false,
        operationalAshlrHome: 'redirected-to-disposable-root',
        disposableSidecar: 'created-exclusive-and-removed-before-receipt',
      },
      gates: results,
      authority: { ...LOCAL_PRODUCTION_GATE_AUTHORITY },
      verdict: 'passed',
    };
    const written = writeReceiptExclusive(receiptPath, receipt);
    process.stdout.write(`${JSON.stringify({
      ok: true, receiptPath, receiptSha256: written.sha256, revision: source.revision,
      tree: source.tree, packageIntegrity: pack.integrity, authority: receipt.authority,
    })}\n`);
    return Object.freeze({ receipt, receiptPath, receiptSha256: written.sha256 });
  } finally {
    if (sidecar) sidecar.cleanup();
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
