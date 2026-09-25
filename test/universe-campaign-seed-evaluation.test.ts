/** Real private campaign records and lease; evaluator responses are inert, controlled receipts. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initUniverse, manifestRecord, projectUniverse, universePath } from '../src/core/universe/store.js';
import { appendCampaignEvent, campaignDirectory, initUniverseCampaign, readUniverseCampaign } from '../src/core/universe/campaign-store.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';
import { runCampaignSeedEvaluationOwned } from '../src/core/universe/campaign-seed-evaluation.js';
import { runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';
import { readKillSwitch } from '../src/core/sandbox/policy.js';
import type { VerifySubprocessResult } from '../src/core/run/verify-commands.js';
import * as immutableStore from '../src/core/util/immutable-private-record-store.js';
import { runUniverseCampaign } from '../src/core/universe/campaign.js';
import { runUniverse } from '../src/core/universe/runner.js';
import { parsePreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';
import { resolveBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
vi.mock('../src/core/universe/fixed-evaluator.js', () => ({ runFixedUniverseEvaluator: vi.fn() }));
// The long-diagnostic fixtures declare the preparation-measurement-v1 builtin,
// whose real resolution requires macOS, Node 24+ and a freshly built dist
// bundle. These tests exercise campaign deadline and ingestion policy with an
// inert fixed evaluator, so they pin a synthetic installed identity instead of
// depending on host installation state (which made them fail everywhere but a
// freshly built macOS checkout). Real bundle verification is covered by
// universe-builtin-evaluator-registry and universe-builtin-preparation-evaluator.
vi.mock('../src/core/universe/builtin-evaluator-registry.js', async original => ({ ...await original<object>(), resolveBuiltinEvaluator: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', async (original) => ({ ...await original<object>(), readKillSwitch: vi.fn() }));
const roots: string[] = [];
const evaluator = vi.mocked(runFixedUniverseEvaluator);
const response = (patch: Partial<VerifySubprocessResult> = {}): VerifySubprocessResult => ({ stdout: '{"passed":false,"score":0,"metrics":{"checks":142}}',
  stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed', ...patch });
const nodeDigest = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
beforeEach(() => {
  // The real store still pins these bytes; the mocked fixed evaluator never launches the command.
  vi.mocked(resolveBuiltinEvaluator).mockReturnValue({ id: 'preparation-measurement-v1', digest: 'a'.repeat(64),
    executableDigest: nodeDigest, command: [process.execPath, '-e', 'throw new Error("inert evaluator must not execute")'],
    files: [], tools: [], git: { path: '/usr/bin/git', digest: 'b'.repeat(64) } });
  vi.mocked(readKillSwitch).mockReturnValue({ state: 'inactive', sourceState: 'healthy' } as ReturnType<typeof readKillSwitch>);
  evaluator.mockImplementation(async (...args) => { args[9]?.(); return response(); });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks();
  const writable = (path: string): void => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const entry of readdirSync(path)) writable(join(path, entry)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
function fixture(longDiagnostic = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seed-runtime-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'value'), '0'); writeFileSync(join(repo, 'evaluate.mjs'), 'console.log("unused")');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  initUniverse({ schemaVersion: 1, id: 'seed', name: 'Seed measurement', objective: 'Measure immutable seed', seed: { repo, revision: git('rev-parse', 'HEAD') },
    metric: { name: 'quality', direction: 'maximize', minImprovement: 0 }, budget: { maxTrials: 1, maxDurationMs: 5000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: longDiagnostic ? { builtin: 'preparation-measurement-v1', timeoutMs: 1_800_000 }
      : { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'change', niche: 'quality', hypothesis: 'Improve', command: [process.execPath, '-e', 'void 0'] }] }, { root });
  initUniverseCampaign({ schemaVersion: 1, id: 'campaign', universeId: 'seed', measureSeed: true, feedback: true,
    budget: { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
  const directory = campaignDirectory('campaign', { root }); const at = new Date().toISOString();
  // The persisted deadline is derived from the same start instant, never a
  // second clock read that can cross a millisecond boundary under load.
  appendCampaignEvent(directory, { kind: 'started', at, deadlineAt: new Date(Date.parse(at) + 60_000).toISOString(), owner: { pid: process.pid, startRef: 'fixture' } });
  const controller = new AbortController();
  const execute = (extra = {}) => withUniverseExecution('seed', { root }, lock => runCampaignSeedEvaluationOwned('campaign',
    { root, signal: controller.signal, deadlineMonotonicMs: performance.now() + 30_000, ...extra }, lock));
  return { root, directory, controller, execute, read: () => readUniverseCampaign('campaign', { root }) };
}
describe('campaign seed long diagnostic deadline contract', () => {
  it('holds a valid full v2 diagnostic rather than accepting it as scored seed evidence', async () => {
    const f = fixture(true);
    // Synthetic diagnostic bytes exercise ingestion, not actual qualification execution.
    const workflows = [
      { name: 'manager', methods: ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'] },
      { name: 'successor', methods: ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'] },
    ].map(({ name, methods }) => ({ name, processes: methods.length, blobProcesses: methods.length,
      requests: methods.map((method, index) => ({ id: index + 1, method, processes: 1, blobProcesses: 1 })) }));
    const qualifications = ['runtime-drift', 'source-drift'].map((name, index) => ({ name, processes: 2, blobProcesses: 2,
      requests: [1, 2].map(id => ({ id, method: index ? 'successor-metadata' : 'metadata', processes: 1, blobProcesses: 1 })), injections: 1 }));
    const stdout = JSON.stringify({ schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v2',
      checksPassed: true, workflows, qualifications, diagnostics: [], metrics: {
        correctness_checks: 23, verification_processes: 4, workflow_processes: 11, workflow_blob_processes: 11,
        fixture_owned_process_groups: 4, qualification_processes: 4, qualification_blob_processes: 4,
        ...Object.fromEntries(['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata']
          .flatMap(key => [[`${key}_processes`, 1], [`${key}_blob_processes`, 1]])),
      } });
    expect(parsePreparationMeasurementReport(stdout)).toMatchObject({ workload: 'preparation-workflows-v2',
      checksPassed: true, metrics: { correctness_checks: 23 }, qualifications });
    evaluator.mockImplementation(async (...args) => { args[9]?.(); return response({ stdout }); });
    expect(await f.execute()).toMatchObject({ status: 'held' });
    expect(evaluator.mock.calls[0]![0].manifest.evaluation).toEqual({ builtin: 'preparation-measurement-v1', timeoutMs: 1_800_000 });
    expect(f.read().seedEvaluation?.result).toMatchObject({ status: 'failed', reason: 'evaluator-invalid-result',
      measurement: null, processGroupSettlement: 'group-exit-confirmed' });
    expect(await f.execute()).toMatchObject({ status: 'held' });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(projectUniverse(universePath(f.root, 'seed')).runs).toEqual([]);
  });
  function clockFixture() {
    const f = fixture(true);
    let wall = Date.now(), monotonic = 1000;
    const wallDeadline = Date.parse(f.read().deadlineAt!), deadlineMonotonicMs = monotonic + 5000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    return { ...f, wallDeadline, deadlineMonotonicMs,
      expire: (clock: 'wall' | 'monotonic') => { if (clock === 'wall') wall = wallDeadline; else monotonic = deadlineMonotonicMs; },
      run: () => f.execute({ deadlineMonotonicMs }) };
  }
  it('clamps a selected 1800000ms diagnostic to the original 5000ms campaign remainder', async () => {
    const f = clockFixture();
    expect(await f.run()).toEqual({ status: 'measured', reason: null });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(evaluator.mock.calls[0]![0].manifest.evaluation.timeoutMs).toBe(1_800_000);
    expect(evaluator.mock.calls[0]![5]).toBe(5000);
    expect(f.read().seedEvaluation?.intent.deadlineAt).toBe(new Date(f.wallDeadline).toISOString());
  });
  it.each(['wall', 'monotonic'] as const)('refuses a valid settled response after original %s expiry', async clock => {
    const f = clockFixture();
    evaluator.mockImplementation(async (...args) => { args[9]?.(); f.expire(clock); return response({ stdout: '{"passed":true,"score":1}' }); });
    expect(await f.run()).toMatchObject({ status: 'held' });
    expect(evaluator.mock.calls[0]![5]).toBe(5000);
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(f.read().seedEvaluation?.result).toMatchObject({ status: 'timed-out', reason: 'evaluation-timed-out',
      measurement: null, processGroupSettlement: 'group-exit-confirmed' });
  });
});
describe('campaign seed evaluation runtime', () => {
  it.each([false, true])('records passed=%s without a trial, generation environment or model reservation; reuses exact evidence', async (passed) => {
    const f = fixture(); evaluator.mockImplementation(async (...args) => { args[9]?.(); return response({ stdout: JSON.stringify({ passed, score: 3 }) }); });
    expect(await f.execute()).toEqual({ status: 'measured', reason: null });
    expect(f.read()).toMatchObject({ steps: [], seedEvaluation: { result: { status: 'measured', measurement: { passed, score: 3 } } } });
    expect(projectUniverse(universePath(f.root, 'seed')).runs).toEqual([]);
    const call = evaluator.mock.calls[0]!;
    expect(call[2]).toBe(manifestRecord(universePath(f.root, 'seed')).seedArtifact.path);
    expect(call[7]).toMatchObject({ ASHLR_UNIVERSE_EVALUATION_CONTEXT: 'campaign-seed-v1' });
    expect(call[7]).not.toHaveProperty('ASHLR_UNIVERSE_GENERATION'); expect(call[8]).toBe(true);
    expect(await f.execute()).toEqual({ status: 'measured', reason: null }); expect(evaluator).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['invalid JSON', { stdout: 'not-json' }, 'failed', 'evaluator-invalid-result'],
    ['failed process', { exitCode: 1 }, 'failed', 'evaluator-failed'],
    ['timeout', { timedOut: true }, 'timed-out', 'evaluation-timed-out'],
    ['cancelled', { cancelled: true }, 'cancelled', 'evaluation-cancelled'],
    ['not started', { processGroupSettlement: 'not-started' }, 'failed', 'evaluator-failed'],
  ] as const)('holds %s and never re-evaluates', async (_name, patch, status, reason) => {
    const f = fixture(); evaluator.mockImplementation(async (...args) => { args[9]?.(); return response(patch); });
    expect(await f.execute()).toMatchObject({ status: 'held' });
    expect(f.read().seedEvaluation?.result).toMatchObject({ status, reason, measurement: null });
    expect(await f.execute()).toMatchObject({ status: 'held' }); expect(evaluator).toHaveBeenCalledTimes(1);
  });
  it('keeps an unresolved intent when process-group absence is unconfirmed', async () => {
    const f = fixture(); evaluator.mockImplementation(async (...args) => { args[9]?.(); return response({ processGroupSettlement: 'unconfirmed' }); });
    expect(await f.execute()).toMatchObject({ status: 'held' }); expect(f.read().seedEvaluation?.result).toBeNull();
    // Once persisted, any experiment-wide entry must refuse or hold, never execute again.
    await expect(f.execute()).rejects.toThrow('unresolved campaign seed evaluator');
    initUniverseCampaign({ schemaVersion: 1, id: 'sibling', universeId: 'seed', feedback: true,
      budget: { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root: f.root });
    await expect(runUniverseCampaign('sibling', { root: f.root })).rejects.toThrow('unresolved campaign seed evaluator');
    // Off macOS, direct Universe execution refuses earlier for lack of a verified
    // confinement profile; it must still refuse and never re-run the evaluator.
    await expect(runUniverse('seed', { root: f.root })).rejects.toThrow(process.platform === 'darwin'
      ? 'unresolved campaign seed evaluator' : 'Universe local execution currently requires macOS sandbox-exec');
    expect(evaluator).toHaveBeenCalledTimes(1);
  });
  it('does not invent settled evidence when post-spawn integrity checking throws', async () => {
    const f = fixture(); evaluator.mockImplementation(async (...args) => { args[9]?.(); throw new Error('post-spawn integrity drift'); });
    expect(await f.execute()).toMatchObject({ status: 'held' }); expect(f.read().seedEvaluation?.result).toBeNull();
  });
  it('refuses an already stopped parent before publishing intent', async () => {
    const f = fixture(); await expect(f.execute({ isExecutionStopped: () => true })).rejects.toThrow();
    expect(f.read()).not.toHaveProperty('seedEvaluation'); expect(evaluator).not.toHaveBeenCalled();
  });
  it('checks the parent stop again at the final evaluator spawn boundary', async () => {
    const f = fixture(); let stopped = false;
    evaluator.mockImplementation(async (...args) => { stopped = true; args[9]?.(); throw new Error('must not spawn'); });
    expect(await f.execute({ isExecutionStopped: () => stopped })).toMatchObject({ status: 'held' });
    expect(f.read().seedEvaluation?.result).toMatchObject({ status: 'cancelled', processGroupSettlement: 'not-started', measurement: null });
  });
  it('cancels the evaluator promptly when the enclosing stop changes during evaluation', async () => {
    const f = fixture(); let stopped = false;
    evaluator.mockImplementation(async (...args) => { args[9]?.(); stopped = true;
      await new Promise<void>(resolve => args[6].addEventListener('abort', () => resolve(), { once: true }));
      return response({ cancelled: true }); });
    expect(await f.execute({ isExecutionStopped: () => stopped })).toMatchObject({ status: 'held' });
    expect(f.read().seedEvaluation?.result).toMatchObject({ status: 'cancelled', processGroupSettlement: 'group-exit-confirmed' });
  });
  it('records only cancellation when an owner pause arrives before result publication', async () => {
    const f = fixture(); evaluator.mockImplementation(async (...args) => { args[9]?.();
      appendCampaignEvent(f.directory, { kind: 'control', action: 'pause', at: new Date().toISOString() }); return response(); });
    expect(await f.execute()).toMatchObject({ status: 'held' });
    expect(f.read().seedEvaluation?.result).toMatchObject({ status: 'cancelled', measurement: null });
  });
  it('rejects invalid or already exhausted original deadlines without an intent', async () => {
    const f = fixture(); for (const deadlineMonotonicMs of [NaN, Infinity, 0]) await expect(f.execute({ deadlineMonotonicMs })).rejects.toThrow();
    expect(f.read()).not.toHaveProperty('seedEvaluation'); expect(evaluator).not.toHaveBeenCalled();
  });
  it('refuses a stop that arrives inside the immutable result write boundary', async () => {
    const f = fixture(); let stopped = false; const writer = immutableStore.writeImmutablePrivateRecord;
    vi.spyOn(immutableStore, 'writeImmutablePrivateRecord').mockImplementation((config, value, options) => {
      if ((value as { kind?: string }).kind === 'seed-evaluation-result') stopped = true;
      return writer(config, value, options);
    });
    await expect(f.execute({ isExecutionStopped: () => stopped })).rejects.toThrow();
    expect(f.read().seedEvaluation?.result).toBeNull(); expect(evaluator).toHaveBeenCalledTimes(1);
  });
  it('refuses changed seed bytes before evaluator invocation', async () => {
    const f = fixture(); const seed = manifestRecord(universePath(f.root, 'seed')).seedArtifact.path;
    chmodSync(join(seed, 'value'), 0o600); writeFileSync(join(seed, 'value'), 'changed');
    await expect(f.execute()).rejects.toThrow(); expect(evaluator).not.toHaveBeenCalled();
  });
});
