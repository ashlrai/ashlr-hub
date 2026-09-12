/** Installed builtin measurement through real Universe registration and execution.
 * This remains non-evaluation output, with no model/provider or optimization. */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { artifactDigest, copyArtifact, freezeArtifact } from '../src/core/universe/artifacts.js';
import { initUniverse, manifestRecord, parseEvaluation, universePath, validateUniverseManifest, type ManifestRecord } from '../src/core/universe/store.js';
import { runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';
import { parsePreparationMeasurementReport, type PreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';
import { extractPreparationScenarioVector, PREPARATION_SCENARIO_KEYS } from '../src/core/universe/preparation-measurement-comparison.js';
import type { UniverseManifest } from '../src/core/universe/types.js';
import * as registry from '../src/core/universe/builtin-evaluator-registry.js';
import * as verify from '../src/core/run/verify-commands.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const target = 'src/core/resources/engineering-preparation.ts';
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
const EVALUATION_TIMEOUT = 1_800_000;
const TRIAL_TIMEOUT = 900_000;
const EVALUATION_TEST_TIMEOUT = EVALUATION_TIMEOUT + 60_000;
let root: string, repo: string, universe: string, revision: string, record: ManifestRecord;
let preserveRoot = false;
const source = readFileSync(join(repository, target), 'utf8');
type Measurement = PreparationMeasurementReport;
function measurement(output: string): Measurement {
  expect(Buffer.byteLength(output)).toBeLessThan(24 * 1024);
  const value = parsePreparationMeasurementReport(output);
  expect(Object.keys(value).sort()).toEqual(['checksPassed', 'diagnostics', 'kind', 'metrics', 'qualifications', 'schemaVersion', 'workflows', 'workload']);
  expect(value.schemaVersion).toBe(1); expect(value.kind).toBe('preparation-verification-measurement');
  expect(typeof value.checksPassed).toBe('boolean');
  expect(Object.values(value.metrics).every(number => number !== undefined && Number.isSafeInteger(number) && number >= 0)).toBe(true);
  expect(value.workload).toBe('preparation-workflows-v2'); expect(Array.isArray(value.workflows)).toBe(true);
  expect(value.workflows.length).toBeLessThanOrEqual(2);
  expect(new Set(value.workflows.map(row => row.name)).size).toBe(value.workflows.length);
  for (const row of value.workflows) {
    expect(Object.keys(row).sort()).toEqual(['blobProcesses', 'name', 'processes', 'requests']);
    expect(['manager', 'successor']).toContain(row.name);
    expect(Number.isSafeInteger(row.processes) && row.processes >= 0).toBe(true);
    expect(Number.isSafeInteger(row.blobProcesses) && row.blobProcesses >= 0 && row.blobProcesses <= row.processes).toBe(true);
    expect(row.requests.map(request => request.id)).toEqual(row.requests.map((_, index) => index + 1));
    for (const request of row.requests) {
      expect(Object.keys(request).sort()).toEqual(['blobProcesses', 'id', 'method', 'processes']);
      expect(typeof request.method).toBe('string');
      expect(Number.isSafeInteger(request.processes) && request.processes >= 0).toBe(true);
      expect(Number.isSafeInteger(request.blobProcesses) && request.blobProcesses >= 0 && request.blobProcesses <= request.processes).toBe(true);
    }
    expect(row.processes).toBe(row.requests.reduce((sum, request) => sum + request.processes, 0));
    expect(row.blobProcesses).toBe(row.requests.reduce((sum, request) => sum + request.blobProcesses, 0));
  }
  expect(() => parseEvaluation(output)).toThrow();
  return value;
}
const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
  encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
}).trim();
function manifest(id = 'builtin'): UniverseManifest {
  return { schemaVersion: 1, id, name: 'Installed preparation measurement', objective: 'Measure unchanged preparation behavior',
    seed: { repo, revision }, metric: { name: 'verification_processes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: EVALUATION_TIMEOUT, trialTimeoutMs: TRIAL_TIMEOUT },
    evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: EVALUATION_TIMEOUT },
    variants: [{ id: 'fixture', niche: 'verification', hypothesis: 'Preserve the fixed checks', command: [process.execPath, '-e', 'process.exit(0)'] }] };
}
beforeAll(() => {
  if (!supported) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-builtin-preparation-test-')));
  repo = join(root, 'repository'); universe = join(root, 'universe');
  mkdirSync(join(repo, dirname(target)), { recursive: true, mode: 0o700 }); writeFileSync(join(repo, target), source, { mode: 0o600 });
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'unchanged preparation candidate');
  revision = git('rev-parse', 'HEAD');
  initUniverse(manifest(), { root: universe }); record = manifestRecord(universePath(universe, 'builtin'));
}, 60000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  if (!root || preserveRoot) return;
  const writable = (file: string): void => {
    const stat = lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(file, 0o700); for (const name of readdirSync(file)) writable(join(file, name));
  };
  writable(root); rmSync(root, { recursive: true, force: true });
});
function scratch(): { directory: string; env: NodeJS.ProcessEnv } {
  const directory = mkdtempSync(join(root, 'scratch-'));
  return { directory, env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, ASHLR_HOME: directory,
    TMPDIR: directory, ASHLR_UNIVERSE_CANDIDATE: record.seedArtifact.path } };
}
function copiedInstalledBundle(): { directory: string; controller: string } {
  const installed = registry.resolveBuiltinEvaluator('preparation-measurement-v1');
  const directory = mkdtempSync(join(root, 'installed-copy-'));
  for (const file of installed.files) copyFileSync(file.path, join(directory, file.name));
  copyFileSync(join(dirname(installed.files[0]!.path), 'manifest.json'), join(directory, 'manifest.json'));
  // This test-only selection keeps all byte/shape verification real and never
  // exposes an alternate path through the production manifest or resolver API.
  vi.spyOn(registry, 'resolveBuiltinEvaluator').mockImplementation(id => {
    expect(id).toBe('preparation-measurement-v1'); return registry.inspectBuiltinEvaluatorBundle(directory);
  });
  return { directory, controller: join(directory, 'preparation-verification-controller.mjs') };
}
function spawnedActivities(directory: string): Array<{ kind: string; pgid: number }> {
  return readdirSync(directory).filter(name => /^spawned-[1-9][0-9]*\.json$/.test(name)).map(name => {
    const value = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>;
    expect(value.schemaVersion).toBe(1); expect(value.phase).toBe('spawned');
    expect(['candidate', 'tool']).toContain(value.kind);
    expect(Number.isSafeInteger(value.pgid) && Number(value.pgid) > 0).toBe(true);
    return { kind: value.kind as string, pgid: value.pgid as number };
  });
}
function groupAbsent(pgid: number): boolean {
  try { process.kill(-pgid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function completeWorkload(value: Measurement): void {
  expect(value.checksPassed).toBe(true); expect(value.metrics.correctness_checks).toBe(23);
  expect(value.diagnostics).toEqual([]);
  expect(value.workflows.map(row => row.name)).toEqual(['manager', 'successor']);
  expect(value.workflows[0]!.requests.map(row => row.method)).toEqual([
    'manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close',
  ]);
  expect(value.workflows[1]!.requests.map(row => row.method)).toEqual([
    'successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata',
  ]);
  for (const row of value.workflows) {
    expect(row.processes).toBeGreaterThan(0); expect(row.blobProcesses).toBeGreaterThan(0);
  }
  expect(value.metrics.workflow_processes).toBe(value.workflows.reduce((sum, row) => sum + row.processes, 0));
  expect(value.metrics.workflow_blob_processes).toBe(value.workflows.reduce((sum, row) => sum + row.blobProcesses, 0));
  const qualifications = value.qualifications!;
  expect(qualifications.map(row => row.name)).toEqual(['runtime-drift', 'source-drift']);
  qualifications.forEach((row, index) => {
    expect(row.injections).toBe(1);
    const method = index === 0 ? 'metadata' : 'successor-metadata';
    expect(row.requests.map(request => [request.id, request.method])).toEqual([[1, method], [2, method]]);
    for (const request of row.requests) expect(request.processes).toBeGreaterThan(0);
    expect(row.processes).toBe(row.requests.reduce((sum, request) => sum + request.processes, 0));
    expect(row.blobProcesses).toBe(row.requests.reduce((sum, request) => sum + request.blobProcesses, 0));
  });
  expect(value.metrics.qualification_processes).toBe(qualifications.reduce((sum, row) => sum + row.processes, 0));
  expect(value.metrics.qualification_blob_processes).toBe(qualifications.reduce((sum, row) => sum + row.blobProcesses, 0));
  const vector = extractPreparationScenarioVector(JSON.stringify(value));
  expect(vector.map(row => row.key)).toEqual(PREPARATION_SCENARIO_KEYS);
  expect(vector).toHaveLength(15);
  expect(vector.reduce((sum, row) => sum + row.processes, 0)).toBe(value.metrics.verification_processes! + value.metrics.workflow_processes!);
  // Preserve the original leaf metric; workflow and fixture setup counts must
  // not silently change the meaning of verification_processes.
  expect(value.metrics.verification_processes).toBe(Object.entries(value.metrics)
    .filter(([key]) => key.startsWith('files_') && key.endsWith('_processes') && !key.endsWith('_blob_processes'))
    .reduce((sum, [, count]) => sum + count!, 0));
  expect(value.metrics.verification_processes).toBeGreaterThan(0);
  expect(value.metrics.fixture_owned_process_groups).toBeGreaterThan(0);
}
function completeActivities(directory: string): void {
  const roots = readdirSync(directory).filter(name => name.startsWith('builtin-activity-'));
  expect(roots).toHaveLength(1);
  const activity = join(directory, roots[0]!);
  expect(readdirSync(activity)).toContain('complete.json');
  const groups = spawnedActivities(activity);
  expect(groups.some(row => row.kind === 'candidate')).toBe(true);
  expect(groups.some(row => row.kind === 'tool')).toBe(true);
  const absent = groups.every(row => groupAbsent(row.pgid));
  if (!absent) preserveRoot = true;
  expect(absent, 'Every recorded group must be absent before interpreting completed workload evidence').toBe(true);
}

describe.runIf(supported)('installed builtin preparation measurement', () => {
  it('registers explicit builtin identity and preserves exact immutable registration replay', () => {
    expect(record.manifest.evaluation).toEqual({ builtin: 'preparation-measurement-v1', timeoutMs: EVALUATION_TIMEOUT });
    expect(record.manifest.budget.trialTimeoutMs).toBe(TRIAL_TIMEOUT);
    const before = artifactDigest(record.seedArtifact.path);
    expect(initUniverse(manifest(), { root: universe })).toEqual(record.manifest);
    expect(manifestRecord(universePath(universe, 'builtin'))).toEqual(record);
    expect(artifactDigest(record.seedArtifact.path)).toBe(before);
    expect(record.evaluationCommand[0]).toBe(process.execPath);
    expect(record.evaluationCommand.some(argument => argument.startsWith(record.seedArtifact.path))).toBe(false);
    expect(record.evaluationBuiltinDigest).toBe(registry.resolveBuiltinEvaluator('preparation-measurement-v1').digest);
  });

  it('measures frozen baseline repeatably through runFixedUniverseEvaluator but never produces evaluation evidence', async () => {
    const results: Measurement[] = []; const before = artifactDigest(record.seedArtifact.path);
    for (let index = 0; index < 2; index++) {
      const context = scratch();
      const result = await runFixedUniverseEvaluator(record, universe, record.seedArtifact.path, before,
        context.directory, EVALUATION_TIMEOUT, new AbortController().signal, context.env, true);
      expect({ exitCode: result.exitCode, error: result.error, signal: result.signal, stderr: result.stderr,
        timedOut: result.timedOut, cancelled: result.cancelled, processGroupSettlement: result.processGroupSettlement }).toEqual({
        exitCode: 0, error: undefined, signal: null, stderr: '', timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed',
      });
      const value = measurement(result.stdout); expect(value.checksPassed, JSON.stringify(value)).toBe(true);
      completeWorkload(value); completeActivities(context.directory);
      expect(value.metrics.verification_processes).toBeGreaterThan(0); results.push(value);
      expect(artifactDigest(record.seedArtifact.path)).toBe(before);
    }
    expect(results[1]!.metrics).toEqual(results[0]!.metrics);
    expect(results[1]!.workflows).toEqual(results[0]!.workflows);
    expect(results[1]!.qualifications).toEqual(results[0]!.qualifications);
    expect(extractPreparationScenarioVector(JSON.stringify(results[1]))).toEqual(extractPreparationScenarioVector(JSON.stringify(results[0])));
  }, EVALUATION_TIMEOUT * 2 + 60_000);

  it('rejects a candidate that preserves leaf reads but poisons the installed manager restoration path', async () => {
    const anchor = 'return readPreparedBundle(input);';
    expect(source.split(anchor)).toHaveLength(2);
    const candidate = join(root, 'manager-poison'); copyArtifact(record.seedArtifact.path, candidate);
    const file = join(candidate, target); chmodSync(file, 0o600);
    writeFileSync(file, source.replace(anchor, 'throw new Error("Deliberately poisoned manager bundle reader");'));
    const expected = artifactDigest(candidate); freezeArtifact(candidate);
    const context = scratch();
    const result = await runFixedUniverseEvaluator(record, universe, candidate, expected, context.directory,
      EVALUATION_TIMEOUT, new AbortController().signal, { ...context.env, ASHLR_UNIVERSE_CANDIDATE: candidate }, true);
    expect(result.exitCode).toBe(0); expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull(); expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false); expect(result.cancelled).toBe(false);
    expect(result.processGroupSettlement).toBe('group-exit-confirmed');
    const value = measurement(result.stdout);
    expect(value.checksPassed).toBe(false); expect(value.metrics.correctness_checks).toBe(8);
    expect(value.diagnostics.map(row => row.code)).toEqual(['WORKFLOW_CANDIDATE_BEHAVIOR_FAILED']);
    expect(value.workflows).toEqual([]);
    expect(value.qualifications).toEqual([]);
    expect(artifactDigest(candidate)).toBe(expected); completeActivities(context.directory);
  }, EVALUATION_TEST_TIMEOUT);

  it.each([
    { builtin: 'unknown', timeoutMs: 1000 },
    { builtin: 'preparation-measurement-v1', command: [process.execPath], timeoutMs: 1000 },
    { builtin: 'preparation-measurement-v1', timeoutMs: 1000, modulePath: '/not-an-authority' },
    { builtin: 'preparation-measurement-v1', timeoutMs: 0 },
    { timeoutMs: 1000 },
  ])('refuses unknown, mixed, or widened evaluation mode %#', evaluation => {
    expect(() => validateUniverseManifest({ ...manifest(), evaluation })).toThrow();
  });

  it('refuses a changed scored artifact before invoking the launch boundary', async () => {
    const candidate = join(root, 'changed-artifact'); const expected = copyArtifact(record.seedArtifact.path, candidate); freezeArtifact(candidate);
    const file = join(candidate, target); chmodSync(file, 0o600); writeFileSync(file, source + '\n// fixture-only drift\n');
    const context = scratch(); let reached = false;
    await expect(runFixedUniverseEvaluator(record, universe, candidate, expected, context.directory, EVALUATION_TIMEOUT,
      new AbortController().signal, { ...context.env, ASHLR_UNIVERSE_CANDIDATE: candidate }, true, () => { reached = true; })).rejects.toThrow();
    expect(reached).toBe(false);
  });

  it('returns a pre-aborted invocation as not started, with no measurement', async () => {
    const context = scratch(); const abort = new AbortController(); abort.abort();
    const result = await runFixedUniverseEvaluator(record, universe, record.seedArtifact.path, record.seedArtifact.digest,
      context.directory, EVALUATION_TIMEOUT, abort.signal, context.env, true);
    expect(result.cancelled).toBe(true); expect(result.processGroupSettlement).toBe('not-started'); expect(result.stdout).toBe('');
  });

  it.each(['abort', 'elapsed deadline'] as const)('does not dispatch when the final launch guard causes %s', async cause => {
    const context = scratch(); const abort = new AbortController(); let reached = false; let elapsed = 0;
    const now = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed);
    const dispatch = vi.spyOn(verify, 'runVerifySubprocessAsync').mockRejectedValue(new Error('Unexpected evaluator dispatch'));
    const result = await runFixedUniverseEvaluator(record, universe, record.seedArtifact.path, record.seedArtifact.digest,
      context.directory, EVALUATION_TIMEOUT, abort.signal, context.env, true, () => {
        reached = true;
        if (cause === 'abort') abort.abort(); else elapsed = EVALUATION_TIMEOUT + 10000;
      });
    expect(reached).toBe(true); expect(dispatch).not.toHaveBeenCalled();
    expect(result.processGroupSettlement).toBe('not-started'); expect(result.stdout).toBe('');
    expect(result.cancelled).toBe(cause === 'abort'); expect(result.timedOut).toBe(cause === 'elapsed deadline');
  });

  it('refuses installed controller drift before launch without changing shared installed files', async () => {
    const copied = copiedInstalledBundle(); initUniverse(manifest('bundle-before'), { root: universe });
    const pinned = manifestRecord(universePath(universe, 'bundle-before'));
    const original = readFileSync(copied.controller, 'utf8'); writeFileSync(copied.controller, original + '\n// fixture-only drift\n');
    const context = scratch(); let reached = false;
    await expect(runFixedUniverseEvaluator(pinned, universe, pinned.seedArtifact.path, pinned.seedArtifact.digest,
      context.directory, EVALUATION_TIMEOUT, new AbortController().signal, { ...context.env, ASHLR_UNIVERSE_CANDIDATE: pinned.seedArtifact.path },
      true, () => { reached = true; })).rejects.toThrow();
    expect(reached).toBe(false);
  });

  it('rechecks installed controller bytes after actual process settlement before returning its measurement', async () => {
    const copied = copiedInstalledBundle(); initUniverse(manifest('bundle-after'), { root: universe });
    const pinned = manifestRecord(universePath(universe, 'bundle-after'));
    const original = verify.runVerifySubprocessAsync; let settled = false;
    const run = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async (...args) => {
      const result = await original(...args);
      // Never execute modified code: inject drift only after the real entry
      // process has returned its strict settlement receipt.
      expect(result.processGroupSettlement).toBe('group-exit-confirmed');
      completeWorkload(measurement(result.stdout)); settled = true;
      writeFileSync(copied.controller, readFileSync(copied.controller, 'utf8') + '\n// post-settlement fixture drift\n');
      return result;
    });
    const context = scratch();
    await expect(runFixedUniverseEvaluator(pinned, universe, pinned.seedArtifact.path, pinned.seedArtifact.digest,
      context.directory, EVALUATION_TIMEOUT, new AbortController().signal, { ...context.env, ASHLR_UNIVERSE_CANDIDATE: pinned.seedArtifact.path }, true)).rejects.toThrow();
    expect(run).toHaveBeenCalledOnce(); expect(settled).toBe(true);
    completeActivities(context.directory);
  }, EVALUATION_TEST_TIMEOUT);

  it('cancels after a real candidate registration without converting incomplete custody into accepted output', async () => {
    const context = scratch(); const abort = new AbortController();
    const pending = runFixedUniverseEvaluator(record, universe, record.seedArtifact.path, record.seedArtifact.digest,
      context.directory, EVALUATION_TIMEOUT, abort.signal, context.env, true);
    let finished = false; void pending.then(() => { finished = true; }, () => { finished = true; });
    let activityRoot: string | undefined; let observedCandidate: number | undefined;
    try {
      const deadline = performance.now() + 45000;
      while (performance.now() < deadline && !finished && observedCandidate === undefined) {
        const names = readdirSync(context.directory).filter(name => name.startsWith('builtin-activity-'));
        expect(names.length).toBeLessThanOrEqual(1);
        if (names.length === 1) {
          activityRoot = join(context.directory, names[0]!);
          const candidate = spawnedActivities(activityRoot).find(row => row.kind === 'candidate' && !groupAbsent(row.pgid));
          if (candidate) observedCandidate = candidate.pgid;
        }
        if (observedCandidate === undefined) await new Promise(resolve => setTimeout(resolve, 10));
      }
      abort.abort();
      const result = await pending;
      expect(observedCandidate, 'Cancellation must follow a recorded, independently observed live candidate group').toEqual(expect.any(Number));
      expect(abort.signal.aborted).toBe(true);
      // Losing termination ownership is an infrastructure failure, not a
      // fabricated cancellation receipt. Both must withhold accepted output.
      expect(result.cancelled === true || typeof result.error === 'string').toBe(true);
      expect(['group-exit-confirmed', 'unconfirmed']).toContain(result.processGroupSettlement);
      expect(() => parseEvaluation(result.stdout)).toThrow();
      if (result.stdout.trim()) expect(measurement(result.stdout).checksPassed).toBe(false);
      const names = readdirSync(activityRoot!);
      expect(names).toContain('owner.json'); expect(names.some(name => /^spawned-/.test(name))).toBe(true);
      if (!names.includes('complete.json')) expect(result.processGroupSettlement).toBe('unconfirmed');
      if (result.processGroupSettlement === 'unconfirmed') expect(result.error).toEqual(expect.any(String));
      if (result.processGroupSettlement === 'group-exit-confirmed') {
        expect(spawnedActivities(activityRoot!).every(row => groupAbsent(row.pgid))).toBe(true);
      }
    } finally {
      abort.abort(); await pending.catch(() => undefined);
      // Absence of known groups is only cleanup evidence, not proof that an
      // interrupted activity ledger is complete. Never kill a recycled PGID.
      if (activityRoot) {
        const cleanupDeadline = performance.now() + 6000;
        while (spawnedActivities(activityRoot).some(row => !groupAbsent(row.pgid)) && performance.now() < cleanupDeadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        preserveRoot = spawnedActivities(activityRoot).some(row => !groupAbsent(row.pgid));
        expect(preserveRoot, 'Retain fixture custody if a recorded process group cannot be confirmed absent').toBe(false);
      }
    }
  }, 60000);
});
