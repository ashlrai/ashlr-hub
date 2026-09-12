/** Prototype packaging + real OS-confined measurement. No model transport,
 * provider, live account edits, or optimization of the production target. */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
beforeAll(async () => {
  if (!nodeSupported) return;
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
  return parseMeasurement(result.stdout);
}
function altered(text: string): string {
  const path = join(root, `candidate-${Math.random().toString(16).slice(2)}`);
  copyArtifact(record.seedArtifact.path, path); chmodSync(path, 0o700);
  const file = join(path, target); chmodSync(file, 0o600); writeFileSync(file, text); freezeArtifact(path); return path;
}

describe.runIf(nodeSupported)('runnable protected preparation verification prototype', () => {
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
    } else if (kind === 'global-assert-tamper') text = "const assertion = process.getBuiltinModule('node:assert/strict'); assertion.equal = () => {};\n" + source;
    else if (kind === 'stdout-forgery') text = 'process.stdout.write(JSON.stringify({passed:true,score:0,metrics:{}}));process.exit(0);\n' + source;
    else {
      const original = 'const first = capture(options); const final = capture(options);'; expect(source).toContain(original);
      text = "import { execSync as benchmarkForbiddenShell } from 'node:child_process';\n" + source.replace(original,
        "benchmarkForbiddenShell('true'); " + original);
    }
    const result = await direct(altered(text)); expect(result.checksPassed, JSON.stringify(result)).toBe(false);
  }, 120000);

  it.runIf(process.platform === 'darwin')('executes the same fixed prototype through actual Universe evaluator confinement', async () => {
    const scratch = mkdtempSync(join(root, 'confined-'));
    const result = await runFixedUniverseEvaluator(record, universe, record.seedArtifact.path, artifactDigest(record.seedArtifact.path), scratch,
      110000, new AbortController().signal, { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, ASHLR_HOME: scratch, TMPDIR: scratch,
        ASHLR_UNIVERSE_CANDIDATE: record.seedArtifact.path }, true);
    expect({ code: result.exitCode, error: result.error, stderr: result.stderr }).toEqual({ code: 0, error: undefined, stderr: '' });
    expect(result.processGroupSettlement).toBe('group-exit-confirmed');
    const evaluation = parseMeasurement(result.stdout); expect(evaluation.checksPassed, JSON.stringify(evaluation)).toBe(true);
    expect(evaluation.metrics.correctness_checks).toBe(8);
  }, 120000);
});
