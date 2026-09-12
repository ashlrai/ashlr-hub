/** Real private campaign records and lease; evaluator responses are inert, controlled receipts. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
vi.mock('../src/core/universe/fixed-evaluator.js', () => ({ runFixedUniverseEvaluator: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', async (original) => ({ ...await original<object>(), readKillSwitch: vi.fn() }));
const roots: string[] = [];
const evaluator = vi.mocked(runFixedUniverseEvaluator);
const response = (patch: Partial<VerifySubprocessResult> = {}): VerifySubprocessResult => ({ stdout: '{"passed":false,"score":0,"metrics":{"checks":142}}',
  stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed', ...patch });
beforeEach(() => {
  vi.mocked(readKillSwitch).mockReturnValue({ state: 'inactive', sourceState: 'healthy' } as ReturnType<typeof readKillSwitch>);
  evaluator.mockImplementation(async (...args) => { args[9]?.(); return response(); });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks();
  const writable = (path: string): void => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const entry of readdirSync(path)) writable(join(path, entry)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seed-runtime-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'value'), '0'); writeFileSync(join(repo, 'evaluate.mjs'), 'console.log("unused")');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  initUniverse({ schemaVersion: 1, id: 'seed', name: 'Seed measurement', objective: 'Measure immutable seed', seed: { repo, revision: git('rev-parse', 'HEAD') },
    metric: { name: 'quality', direction: 'maximize', minImprovement: 0 }, budget: { maxTrials: 1, maxDurationMs: 5000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
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
    await expect(runUniverse('seed', { root: f.root })).rejects.toThrow('unresolved campaign seed evaluator');
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
