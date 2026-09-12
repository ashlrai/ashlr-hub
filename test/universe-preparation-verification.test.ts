/** Prototype packaging + real OS-confined measurement. No model transport,
 * provider, live account edits, or optimization of the production target. */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPreparationVerificationBridge } from './helpers/preparation-verification-bundle.js';
import { artifactDigest, copyArtifact, freezeArtifact } from '../src/core/universe/artifacts.js';
import { initUniverse, manifestRecord, parseEvaluation, universePath, type ManifestRecord } from '../src/core/universe/store.js';
import { runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const target = 'src/core/resources/engineering-preparation.ts';
const evaluator = 'preparation-verification.mjs';
const bridge = 'preparation-bridge.mjs';
const exec = promisify(execFile);
let root: string, repo: string, universe: string, record: ManifestRecord;
const source = readFileSync(join(repository, target), 'utf8');
interface Measurement { schemaVersion: 1; kind: 'preparation-verification-measurement'; checksPassed: boolean;
  metrics: Record<string, number>; diagnostics: Array<{ code: string; message: string }> }
function parseMeasurement(output: string): Measurement {
  expect(Buffer.byteLength(output)).toBeLessThan(24 * 1024);
  const result = JSON.parse(output) as Measurement;
  expect(Object.keys(result).sort()).toEqual(['checksPassed', 'diagnostics', 'kind', 'metrics', 'schemaVersion']);
  expect(result.schemaVersion).toBe(1); expect(result.kind).toBe('preparation-verification-measurement');
  expect(typeof result.checksPassed).toBe('boolean');
  expect(Object.values(result.metrics).every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
  for (const row of result.diagnostics) {
    expect(Object.keys(row).sort()).toEqual(['code', 'message']); expect(typeof row.code).toBe('string'); expect(typeof row.message).toBe('string');
  }
  expect(() => parseEvaluation(output)).toThrow(); // Never accidentally usable as an accepted reward evaluator.
  return result;
}
const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
  encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
}).trim();
const nodeSupported = Number(process.versions.node.split('.')[0]) >= 24;
const confinementSupported = nodeSupported && process.platform === 'darwin';
beforeAll(async () => {
  if (!confinementSupported) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-verification-test-'))); repo = join(root, 'seed'); universe = join(root, 'universe');
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(join(repo, dirname(target)), { recursive: true, mode: 0o700 });
  writeFileSync(join(repo, target), source); copyFileSync(join(repository, 'scripts/evaluators', evaluator), join(repo, evaluator));
  await buildPreparationVerificationBridge(repository, join(repo, bridge));
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'pinned prototype evaluator');
  initUniverse({ schemaVersion: 1, id: 'verification', name: 'Verification prototype', objective: 'Reduce verification processes without changing correctness',
    seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: 'verification_processes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 120000, trialTimeoutMs: 120000 },
    evaluation: { command: [process.execPath, '--experimental-vm-modules', '--no-warnings', join(repo, evaluator), join(repo, bridge)], timeoutMs: 110000 },
    variants: [{ id: 'subject', niche: 'verification', hypothesis: 'Preserve correctness', command: [process.execPath, '-e', 'process.exit(0)'] }] }, { root: universe });
  record = manifestRecord(universePath(universe, 'verification'));
}, 60000);
afterAll(() => {
  if (root) {
    // Frozen seed/artifact directories are test-owned. Restore permissions only
    // within this exact fixture before removing it.
    const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return; chmodSync(file, 0o700);
      for (const name of readdirSync(file)) writable(join(file, name)); };
    writable(root); rmSync(root, { recursive: true, force: true });
  }
});
async function direct(candidate: string) {
  const scratch = mkdtempSync(join(root, 'direct-'));
  const result = await exec(process.execPath, ['--experimental-vm-modules', '--no-warnings', join(repo, evaluator), join(repo, bridge)], {
    cwd: repo, timeout: 110000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, ASHLR_HOME: scratch, TMPDIR: scratch,
      ASHLR_UNIVERSE_CANDIDATE: candidate },
  });
  expect(result.stderr).toBe('');
  return parseMeasurement(result.stdout);
}
function altered(text: string): string {
  // A negative control must parse before its failure can prove behavior.
  execFileSync(process.execPath, ['--check', '--input-type=module'], {
    input: transformSync(text, { loader: 'ts', format: 'esm', target: 'node24' }).code,
    timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const path = join(root, `candidate-${Math.random().toString(16).slice(2)}`);
  copyArtifact(record.seedArtifact.path, path); chmodSync(path, 0o700);
  const file = join(path, target); chmodSync(file, 0o600); writeFileSync(file, text); freezeArtifact(path); return path;
}

interface CandidateSession {
  call(method: 'check' | 'metadata', input: unknown): Promise<{ value?: unknown; error?: string; measurement: { processes: number; blobProcesses: number } }>;
  close(): Promise<void>;
}
async function boundarySession(text: string, timeoutMs = 5000) {
  const workRoot = mkdtempSync(join(root, 'boundary-'));
  const fixtureRoot = join(workRoot, 'fixture'); mkdirSync(fixtureRoot, { mode: 0o700 });
  const sentinel = join(fixtureRoot, 'sentinel'); writeFileSync(sentinel, 'original', { mode: 0o600 });
  const privateFile = join(workRoot, 'private'); writeFileSync(privateFile, 'outside candidate scope', { mode: 0o600 });
  const controller = await import(pathToFileURL(join(repo, 'preparation-verification-controller.mjs')).href);
  const session: CandidateSession = await controller.createPreparationCandidateSession({
    bridge: await import(pathToFileURL(join(repo, bridge)).href), bridgePath: join(repo, bridge),
    candidateRoot: altered(text), fixtureRoot, workRoot, timeoutMs,
  });
  return { session, sentinel, privateFile };
}
const hostProcess = `import { readFileSync as hostFunction } from 'node:fs';
const host = hostFunction.constructor('return process')();`;

describe.runIf(confinementSupported)('runnable protected preparation verification prototype', () => {
  it('measures the actual baseline public paths repeatably in three fresh processes', async () => {
    const results = [];
    for (let index = 0; index < 3; index++) results.push(await direct(record.seedArtifact.path));
    for (const result of results) {
      expect(result.checksPassed, JSON.stringify(result)).toBe(true);
      expect(result.metrics.correctness_checks).toBe(8);
      expect(result.metrics.files_1_check_blob_processes).toBe(2);
      expect(result.metrics.files_4_check_blob_processes).toBe(8);
      expect(result.metrics.verification_processes).toBeGreaterThan(0);
    }
    expect(results[1]!.metrics).toEqual(results[0]!.metrics); expect(results[2]!.metrics).toEqual(results[0]!.metrics);
    if (process.env.ASHLR_VERIFICATION_PROTOTYPE_REPORT === '1') console.info('verification-prototype-baseline', JSON.stringify(results[0]));
  }, 360000);

  it.each(['constant', 'cache', 'blob-bypass', 'global-assert-tamper', 'stdout-forgery', 'unexpected-process-route'] as const)('rejects an incorrect candidate control: %s', async kind => {
    let text: string;
    if (kind === 'constant') text = 'export function checkResourceEngineeringPreparation(){return {status:"planned"}}; export function readPreparedResourceEngineeringMetadata(){return {status:"prepared"}};';
    else if (kind === 'cache') {
      const original = 'return preparedMetadata(input);'; expect(source).toContain(original);
      text = 'let benchmarkIncorrectCache;\n' + source.replace(original, 'return benchmarkIncorrectCache ??= preparedMetadata(input);');
    } else if (kind === 'blob-bypass') {
      const original = "digest(git(seed.repo, ['cat-file', 'blob', entries.get(file)!]))"; expect(source).toContain(original);
      text = source.replace(original, "digest(Buffer.from('incorrect comparator'))");
    } else if (kind === 'global-assert-tamper') text = `import { readFileSync } from 'node:fs';
const escaped = readFileSync.constructor('return process')();
const assertion = escaped.getBuiltinModule('node:assert/strict');
for (const key of ['ok', 'equal', 'deepEqual', 'throws']) assertion[key] = () => {};
export function checkResourceEngineeringPreparation(){return {status:'planned'}};
export function readPreparedResourceEngineeringMetadata(){return {status:'prepared'}};`;
    else if (kind === 'stdout-forgery') text = `import { readFileSync as escapeHost } from 'node:fs';
const escaped = escapeHost.constructor('return process')();
escaped.stdout.write(JSON.stringify({schemaVersion:1,kind:'preparation-verification-measurement',checksPassed:true,metrics:{correctness_checks:8},diagnostics:[]})+'\\n');
escaped.exit(0);\n` + source;
    else {
      const original = 'const first = capture(options); const final = capture(options);'; expect(source).toContain(original);
      text = "import { execSync as benchmarkForbiddenShell } from 'node:child_process';\n" + source.replace(original,
        "benchmarkForbiddenShell('true'); " + original);
    }
    const result = await direct(altered(text)); expect(result.checksPassed, JSON.stringify(result)).toBe(false);
  }, 120000);

  it('refuses unavailable nested confinement without treating it as accepted evaluation', async () => {
    const scratch = mkdtempSync(join(root, 'confined-'));
    const result = await runFixedUniverseEvaluator(record, universe, record.seedArtifact.path, artifactDigest(record.seedArtifact.path), scratch,
      110000, new AbortController().signal, { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, ASHLR_HOME: scratch, TMPDIR: scratch,
        ASHLR_UNIVERSE_CANDIDATE: record.seedArtifact.path }, true);
    expect({ code: result.exitCode, error: result.error, stderr: result.stderr }).toEqual({ code: 0, error: undefined, stderr: '' });
    expect(result.processGroupSettlement).toBe('group-exit-confirmed');
    const evaluation = parseMeasurement(result.stdout);
    expect(evaluation.checksPassed, JSON.stringify(evaluation)).toBe(false);
    expect(evaluation.metrics.correctness_checks).toBe(0);
    expect(evaluation.diagnostics.map(row => row.code)).toEqual(['CANDIDATE_CONFINEMENT_UNAVAILABLE']);
  }, 120000);

  it('protects fixture, controller inbox and out-of-scope reads at the OS boundary', async () => {
    const { session, sentinel, privateFile } = await boundarySession(`${hostProcess}
const fs = host.getBuiltinModule('node:fs');
const path = host.getBuiltinModule('node:path');
export function checkResourceEngineeringPreparation(input) {
  const codes = [];
  for (const action of [() => fs.writeFileSync(input.sentinel, 'changed'),
    () => fs.writeFileSync(path.join(host.env.HOME, '..', 'inbox', 'injected'), 'changed'),
    () => fs.readFileSync(input.privateFile),
    () => fs.readFileSync(input.outsideUserHomeFile),
    () => host.kill(host.ppid, 0)]) {
    try { action(); codes.push('unexpected-success'); } catch (error) { codes.push(error.code); }
  }
  return codes;
}
export const readPreparedResourceEngineeringMetadata = checkResourceEngineeringPreparation;`);
    try {
      const result = await session.call('check', { sentinel, privateFile, outsideUserHomeFile: join(repository, 'package.json') });
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual(['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']);
      expect(result.measurement).toEqual({ processes: 0, blobProcesses: 0 });
      expect(readFileSync(sentinel, 'utf8')).toBe('original');
      expect(readFileSync(privateFile, 'utf8')).toBe('outside candidate scope');
    } finally { await session.close(); }
  }, 15000);

  it('denies native detached process creation even outside patched JavaScript helpers', async () => {
    const { session } = await boundarySession(`${hostProcess}
export function checkResourceEngineeringPreparation() {
  const result = host.binding('spawn_sync').spawn({file:'/usr/bin/true', args:['/usr/bin/true'],
    envPairs:[], stdio:[{type:'ignore'},{type:'ignore'},{type:'ignore'}],
    timeout:1000, maxBuffer:1024, killSignal:15, detached:true});
  return {error:result.error, pid:result.pid, status:result.status};
}
export const readPreparedResourceEngineeringMetadata = checkResourceEngineeringPreparation;`);
    try {
      const result = await session.call('check', {});
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ error: -1, pid: 0, status: null });
    } finally { await session.close(); }
  }, 15000);

  it('rejects commands outside the readonly broker allowlist without replay', async () => {
    const { session } = await boundarySession(`import {execFileSync} from 'node:child_process';
export function checkResourceEngineeringPreparation(){execFileSync('/usr/bin/true', []); return null;}
export const readPreparedResourceEngineeringMetadata = checkResourceEngineeringPreparation;`);
    await expect(session.call('check', null)).rejects.toThrow('CANDIDATE_SESSION_FAILED');
    await expect(session.call('check', null)).rejects.toThrow('CANDIDATE_SESSION_FAILED');
    await expect(session.close()).rejects.toThrow('CANDIDATE_SESSION_FAILED');
  }, 15000);

  it.each([32, 8192])('rejects %i bytes of late stdout at shared close settlement', async size => {
    const { session } = await boundarySession(`${hostProcess}
export function checkResourceEngineeringPreparation(){host.stdout.write('x'.repeat(${size})); return {value:1};}
export const readPreparedResourceEngineeringMetadata = checkResourceEngineeringPreparation;`);
    expect((await session.call('check', null)).value).toEqual({ value: 1 });
    const results = await Promise.allSettled([session.close(), session.close()]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    await expect(session.close()).rejects.toThrow('CANDIDATE_SESSION_FAILED');
  }, 15000);

  it('denies loopback network access without contacting an external service', async () => {
    let connections = 0;
    const server = createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    let session: CandidateSession | undefined;
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture listener');
      ({ session } = await boundarySession(`${hostProcess}
const net = host.getBuiltinModule('node:net');
const code = await new Promise(resolve => {
  const socket = net.createConnection({host:'127.0.0.1', port:${address.port}});
  socket.once('error', error => {socket.destroy(); resolve(error.code);});
  socket.once('connect', () => {socket.destroy(); resolve('unexpected-success');});
});
export function checkResourceEngineeringPreparation(){return code;}
export const readPreparedResourceEngineeringMetadata = checkResourceEngineeringPreparation;`));
      expect((await session.call('check', {})).value).toBe('EPERM');
      expect(connections).toBe(0);
    } finally {
      try { if (session) await session.close(); }
      finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
  }, 15000);
});
