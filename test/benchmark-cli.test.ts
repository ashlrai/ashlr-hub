import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBenchmarkCli } from '../src/cli/benchmark.js';
import { parseArgs, runLocalEval, type LocalEvalDeps } from '../src/core/local-eval/main.js';
import { compareReportsCli } from '../src/core/local-eval/compare.js';
import { TASKS } from '../src/core/local-eval/tasks.js';
import type { HarnessConfiguration, TrialResult } from '../src/core/local-eval/types.js';

const configuration: HarnessConfiguration = { model: 'fixture-model', modelPath: '/models/local.gguf', quantization: 'Q8',
  slots: 2, contextPerSlot: 4096, contextTotal: 8192, samplingParams: { temperature: 0 }, baseUrl: 'http://127.0.0.1:9000',
  proxy: 'off', tracing: 'off', proxyImplementation: 'none', agentCli: 'fixture-agent', llamaServerArgv: ['llama-server', '--parallel', '2'], capturedAt: '2026-10-01' };
function result(taskId: string, trial: number, passed = true): TrialResult {
  return { taskId, trial, mode: passed ? 'pass' : 'wrong-edit', passed, wallMs: 1,
    tokens: { input: null, output: null, cacheRead: null, cacheCreation: null }, agentExit: 0, verifyExit: passed ? 0 : 1,
    changedFiles: 1, claim: 'claims-change', integrity: 'consistent', turns: 1, note: '', timeoutDiagnosis: null, trace: null };
}
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function fakeDeps(overrides: Partial<LocalEvalDeps> = {}): LocalEvalDeps {
  return { captureConfiguration: vi.fn(async () => configuration), createArtifactRoot: vi.fn(async () => '/private/fixture'),
    runTrial: vi.fn(async ({ task, trial }) => result(task.id, trial)), writeReport: vi.fn(async () => {}),
    runExperiments: vi.fn(async () => 0), out: vi.fn(), err: vi.fn(), ...overrides };
}

describe('installed benchmark CLI', () => {
  it.each([[], ['--help'], ['-h'], ['help'], ['run', '--help']].map((args) => [args]))('does not even load the harness for help %j', async (args) => {
    const loadRunner = vi.fn(); const loadComparator = vi.fn(); const out = vi.fn();
    expect(await runBenchmarkCli(args, { loadRunner, loadComparator, out, err: vi.fn() })).toBe(0);
    expect(out.mock.calls[0]?.[0]).toContain('Only run starts agent/model work');
    expect(loadRunner).not.toHaveBeenCalled(); expect(loadComparator).not.toHaveBeenCalled();
  });
  it('compares reports offline without loading the runtime harness', async () => {
    const loadRunner = vi.fn(); const compare = vi.fn(() => ({ output: 'descriptive matched receipt', exitCode: 0 as const }));
    const loadComparator = vi.fn(async () => ({ compareReportsCli: compare }));
    expect(await runBenchmarkCli(['--compare-reports', 'base.json', 'head.json'], { loadRunner, loadComparator, out: vi.fn(), err: vi.fn() })).toBe(0);
    expect(compare).toHaveBeenCalledWith(['--compare-reports', 'base.json', 'head.json']); expect(loadRunner).not.toHaveBeenCalled();
  });
  it.each([['run', '--trials', '0'], ['run', '--concurrency', '1.5'], ['run', '--timeout-ms'], ['run', '--delete'],
    ['run', '--set', 'unknown'], ['run', '--trace', '--no-trace'], ['run', '--fleet-busy']].map((args) => [args]))('rejects malformed run flags before execution %j', async (args) => {
    const run = vi.fn();
    expect(await runBenchmarkCli(args, { loadRunner: async () => ({ parseArgs, runLocalEval: run }), out: vi.fn(), err: vi.fn() })).toBe(2);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([['--compare-reports', 'base.json'], ['--compare-reports', '--delete', 'head'], ['implicit-model-run']].map((args) => [args]))('refuses invalid command before loaders %j', async (args) => {
    const loadRunner = vi.fn(); const loadComparator = vi.fn();
    expect(await runBenchmarkCli(args, { loadRunner, loadComparator, out: vi.fn(), err: vi.fn() })).toBe(2);
    expect(loadRunner).not.toHaveBeenCalled(); expect(loadComparator).not.toHaveBeenCalled();
  });
  it('preserves the actual runner failure and scrubs thrown loader errors', async () => {
    const err = vi.fn();
    expect(await runBenchmarkCli(['run', '--trials', '1'], { loadRunner: async () => ({ parseArgs, runLocalEval: async () => 1 }), out: vi.fn(), err })).toBe(1);
    expect(await runBenchmarkCli(['run'], { loadRunner: async () => { throw new Error('SECRET_SENTINEL'); }, out: vi.fn(), err })).toBe(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain('SECRET_SENTINEL');
  });
});

describe('modern benchmark orchestration without agents or model requests', () => {
  it.each(['0', '-1', '1.5', '1e3', 'Infinity', '9007199254740992', '01'])('strictly refuses invalid numeric value %s before capture', async (value) => {
    const deps = fakeDeps();
    expect(await runLocalEval(['--trials', value], deps)).toBe(2);
    expect(deps.captureConfiguration).not.toHaveBeenCalled(); expect(deps.runTrial).not.toHaveBeenCalled();
  });
  it('keeps defaults and accepts representable preferences without arbitrary small caps', () => {
    expect(parseArgs([])).toMatchObject({ trials: 3, concurrency: 2, cacheState: 'uncontrolled' });
    expect(parseArgs(['--concurrency', '17', '--trials', '100'])).toMatchObject({ concurrency: 17, trials: 100 });
    expect(parseArgs(['--concurrency', String(Number.MAX_SAFE_INTEGER)])).toMatchObject({ concurrency: Number.MAX_SAFE_INTEGER });
  });
  it('refuses unknown tasks and unrepresentable allocation before probing', async () => {
    const deps = fakeDeps();
    expect(await runLocalEval(['--task', 'not-an-existing-task'], deps)).toBe(2);
    expect(await runLocalEval(['--task', TASKS[0]!.id, '--trials', '4294967296'], deps)).toBe(1);
    expect(await runLocalEval(['--trials', String(Number.MAX_SAFE_INTEGER)], deps)).toBe(2);
    expect(deps.captureConfiguration).not.toHaveBeenCalled(); expect(deps.runTrial).not.toHaveBeenCalled();
  });
  it('runs the entire requested inventory with real configured concurrency and deterministic receipt order', async () => {
    let active = 0; let peak = 0; const completed: number[] = [];
    const deps = fakeDeps({ runTrial: vi.fn(async ({ task, trial }) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, (18 - trial) % 3));
      active -= 1; completed.push(trial); return result(task.id, trial);
    }) });
    expect(await runLocalEval(['--task', TASKS[0]!.id, '--trials', '30', '--concurrency', '17'], deps)).toBe(0);
    expect(peak).toBe(17); expect(active).toBe(0); expect(completed).toHaveLength(30);
    const report = JSON.parse(vi.mocked(deps.writeReport).mock.calls[0]![1]);
    expect(report.outcomes[0].trials.map((trial: TrialResult) => trial.trial)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(report.comparisonEvidence.cacheState).toBe('uncontrolled');
    expect(report.totalTrials).toBe(30);
  });
  it('writes a failed checker receipt and returns failure rather than a fabricated pass', async () => {
    const deps = fakeDeps({ runTrial: vi.fn(async ({ task, trial }) => ({ ...result(task.id, trial, false), note: 'Authorization: Bearer SECRET_CHECKER_FIXTURE' })) });
    expect(await runLocalEval(['--task', TASKS[0]!.id, '--trials', '1'], deps)).toBe(1);
    expect(deps.writeReport).toHaveBeenCalled(); expect(JSON.stringify(vi.mocked(deps.out).mock.calls)).toContain('0/1');
    expect(JSON.stringify(vi.mocked(deps.out).mock.calls)).not.toContain('SECRET_CHECKER_FIXTURE');
  });
  it('waits for already-started workers after a runtime exception and emits only a categorical error', async () => {
    let finished = false;
    const deps = fakeDeps({ runTrial: vi.fn(async ({ task, trial }) => {
      if (trial === 1) throw new Error('SECRET_RUNTIME_RESPONSE');
      await new Promise((resolve) => setTimeout(resolve, 10)); finished = true; return result(task.id, trial);
    }) });
    expect(await runLocalEval(['--task', TASKS[0]!.id, '--trials', '4', '--concurrency', '2'], deps)).toBe(1);
    expect(finished).toBe(true); expect(deps.runTrial).toHaveBeenCalledTimes(2);
    expect(deps.writeReport).not.toHaveBeenCalled(); expect(JSON.stringify(vi.mocked(deps.err).mock.calls)).not.toContain('SECRET_RUNTIME_RESPONSE');
  });
  it('keeps actual trace parent private and writes the report with owner-only permissions', async () => {
    const paths: string[] = [];
    const deps = fakeDeps({
      runTrial: vi.fn(async ({ task, trial, trialDir }) => { paths.push(trialDir); return result(task.id, trial); }) });
    // Omit overrides rather than masking production defaults with undefined.
    const { createArtifactRoot: _root, writeReport: _write, ...injected } = deps;
    expect(await runLocalEval(['--task', TASKS[0]!.id, '--trials', '1'], injected)).toBe(0);
    const root = dirname(paths[0]!); scratch.push(root);
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, 'report.json'))).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8')).totalPasses).toBe(1);
  });
  it('retains offline comparison refusal and experiment failures without probing', async () => {
    const deps = fakeDeps({ runExperiments: vi.fn(async () => 1) });
    expect(await runLocalEval(['--compare-reports', '/does-not-exist/base', '/does-not-exist/head'], deps)).toBe(2);
    expect(await runLocalEval(['--experiments'], deps)).toBe(1);
    expect(deps.captureConfiguration).not.toHaveBeenCalled(); expect(deps.runTrial).not.toHaveBeenCalled();
  });
  it('supports actual offline matched receipts via public command, no runtime loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-offline-')); scratch.push(root);
    const deps = fakeDeps({ createArtifactRoot: async () => root });
    const { writeReport: _write, ...injected } = deps;
    expect(await runLocalEval(['--task', TASKS[0]!.id, '--trials', '1', '--cache-state', 'cold', '--cache-protocol', 'fixture-only operator procedure'], injected)).toBe(0);
    const loadRunner = vi.fn(); const out = vi.fn();
    expect(await runBenchmarkCli(['--compare-reports', join(root, 'report.json'), join(root, 'report.json')],
      { loadRunner, loadComparator: async () => ({ compareReportsCli }), out, err: vi.fn() })).toBe(0);
    expect(loadRunner).not.toHaveBeenCalled(); expect(JSON.parse(out.mock.calls[0]![0]).status).toBe('compared');
  });
});
