/** Real immutable experiment records; model and evaluator transports are inert. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as verify from '../src/core/run/verify-commands.js';
import { initUniverse, initUniverseCampaign, readUniverseOverview, runUniverse, runUniverseCampaign,
  type UniverseFeedback, type UniverseManifest } from '../src/core/universe/index.js';
import { canonical } from '../src/core/universe/artifacts.js';
import { projectUniverse, readRecords } from '../src/core/universe/store.js';

const roots: string[] = [];
const PRIVATE = 'PRIVATE_EVALUATOR_SENTINEL_never_forward_to_model';
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
interface Prompt { generation: number; parentTrialId: string | null; feedback?: UniverseFeedback }
function fixture(result: Partial<verify.VerifySubprocessResult>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-evaluator-diagnostics-'))); roots.push(base);
  const root = join(base, 'store'); const repo = join(base, 'repo'); mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'value.mjs'), 'export const value = 0;\n');
  writeFileSync(join(repo, 'evaluate.mjs'), '/* Fixed evaluator bytes, never executed by this fixture. */\n');
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.mjs', 'evaluate.mjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Pinned inert evaluator');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'evaluator-diagnostics', name: 'Evaluator diagnostics fixture',
    objective: 'Improve the fixed measured value', seed: { repo, revision: git('rev-parse', 'HEAD') },
    metric: { name: 'checks', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1_000 }, variants: [{ id: 'candidate', niche: 'quality',
      hypothesis: 'Respond to fixed evaluator feedback', generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1',
        model: 'inert', files: ['value.mjs'], maxOutputTokens: 256 } }] };
  initUniverse(manifest, { root });
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: RequestInit) => {
    requests.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant',
      content: JSON.stringify({ edits: [{ path: 'value.mjs', content: 'export const value = 1;\n' }] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const evaluator = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: '', stderr: PRIVATE,
    exitCode: 0, signal: null, timedOut: false, cancelled: false, ...result });
  const campaign = { schemaVersion: 1 as const, id: 'diagnostic-campaign', universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 2, maxDurationMs: 30_000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: null } };
  initUniverseCampaign(campaign, { root });
  return { root, manifest, campaign, evaluator, requests, directory: join(root, 'universes', manifest.id),
    prompts: () => requests.map((request) => JSON.parse(request.messages.find((message) => message.role === 'user')!.content) as Prompt) };
}

const failures: Array<{ name: string; result: Partial<verify.VerifySubprocessResult>; code: string; message: string; status: string }> = [
  { name: 'launch failure', result: { error: PRIVATE, exitCode: -1 }, code: 'evaluator-start-failed', status: 'failed',
    message: 'The fixed evaluator could not run successfully; no evaluation score was recorded.' },
  { name: 'timeout takes precedence over start error', result: { timedOut: true, error: PRIVATE, exitCode: -1 }, code: 'evaluator-timed-out', status: 'timed-out',
    message: 'The fixed evaluator exceeded its time budget; no evaluation score was recorded.' },
  { name: 'nonzero exit', result: { exitCode: 17 }, code: 'evaluator-nonzero', status: 'failed',
    message: 'The fixed evaluator exited unsuccessfully; no evaluation score was recorded.' },
  { name: 'signal exit', result: { signal: 'SIGTERM' }, code: 'evaluator-nonzero', status: 'failed',
    message: 'The fixed evaluator exited unsuccessfully; no evaluation score was recorded.' },
  { name: 'invalid JSON', result: { stdout: PRIVATE }, code: 'evaluator-invalid-result', status: 'failed',
    message: 'The fixed evaluator did not return a valid bounded evaluation result; no evaluation score was recorded.' },
  { name: 'invalid measurement shape', result: { stdout: JSON.stringify({ passed: true, score: PRIVATE, metrics: {} }) },
    code: 'evaluator-invalid-result', status: 'failed',
    message: 'The fixed evaluator did not return a valid bounded evaluation result; no evaluation score was recorded.' },
];

describe.runIf(process.platform === 'darwin')('fixed evaluator phase diagnostics', () => {
  it.each(failures)('records $name and forwards only fixed evidence to the next generation', async ({ result, code, message, status }) => {
    const value = fixture(result); const final = await runUniverseCampaign(value.campaign.id, value);
    expect(final.state).toBe('completed'); expect(final.progress).toMatchObject({ attempts: 2, admissions: 0, improvements: 0 });
    const summary = readUniverseOverview(value).universes[0]!;
    expect(summary.sourceState).toBe('healthy'); expect(summary.elites).toEqual([]);
    expect(summary.runs).toHaveLength(2);
    for (const run of summary.runs) {
      const trial = run.trials[0]!;
      expect(trial).toMatchObject({ status, score: null, metrics: {}, selected: false, delta: null,
        diagnostics: [{ code, message }] });
      expect(trial.artifact).not.toBeNull();
      expect(JSON.stringify(trial.diagnostics)).not.toContain(PRIVATE);
      expect(JSON.stringify(trial.generation)).not.toContain(PRIVATE);
    }
    expect(value.evaluator).toHaveBeenCalledTimes(2); expect(value.requests).toHaveLength(2);
    const [first, second] = value.prompts(); expect(first!.feedback).toBeUndefined();
    expect(second).toMatchObject({ generation: 2, parentTrialId: null, feedback: { status, score: null, metrics: {},
      source: { trialId: summary.runs[0]!.trials[0]!.id }, diagnostics: [{ code, message }] } });
    expect(JSON.stringify(value.requests)).not.toContain(PRIVATE);
    const before = readRecords(value.directory).map(canonical);
    expect(projectUniverse(value.directory).sourceState).toBe('healthy');
    expect(readRecords(value.directory).map(canonical)).toEqual(before);
  });

  it('does not misclassify cancellation as a launch or timeout failure', async () => {
    const value = fixture({ cancelled: true, timedOut: true, error: PRIVATE, exitCode: -1 });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(run.trials[0]).toMatchObject({ status: 'cancelled', score: null, metrics: {}, selected: false });
    expect(run.trials[0]!.diagnostics ?? []).toEqual([]);
    expect(readUniverseOverview(value).universes[0]!.elites).toEqual([]);
  });

  it('preserves deliberately shared diagnostics from a valid rejected measurement', async () => {
    const diagnostic = { code: 'wrong-value', message: 'Expected the value two.', path: 'value.mjs', line: 1 };
    const value = fixture({ stdout: JSON.stringify({ passed: false, score: 4, metrics: { checks: 4 }, diagnostics: [diagnostic] }) });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(run.trials[0]).toMatchObject({ status: 'failed', score: 4, metrics: { checks: 4 }, selected: false, diagnostics: [diagnostic] });
  });

  it('detects rewritten prior diagnostics even when trial and final records agree', async () => {
    const value = fixture({ exitCode: 9 }); await runUniverseCampaign(value.campaign.id, value);
    const first = projectUniverse(value.directory).runs[0]!;
    for (const record of readRecords(value.directory)) {
      if (record.kind === 'trial' && record.runId === first.id) record.trial.diagnostics![0]!.message = 'Rewritten evaluator finding';
      else if (record.kind === 'final' && record.run.id === first.id) record.run.trials[0]!.diagnostics![0]!.message = 'Rewritten evaluator finding';
      else continue;
      const file = join(value.directory, 'ledger', 'records', `${record.id}.json`);
      chmodSync(file, 0o600); writeFileSync(file, `${canonical(record)}\n`);
    }
    expect(() => projectUniverse(value.directory)).toThrow(/feedback digest/);
    expect(JSON.stringify(value.requests)).not.toContain(PRIVATE);
    expect(readFileSync(join(value.manifest.seed.repo, 'value.mjs'), 'utf8')).toBe('export const value = 0;\n');
  });

  it('keeps the accepted elite as edit parent while forwarding a later evaluator failure', async () => {
    const value = fixture({ exitCode: 9 });
    value.evaluator.mockResolvedValueOnce({ stdout: JSON.stringify({ passed: true, score: 10, metrics: { checks: 10 } }),
      stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false });
    const accepted = await runUniverse(value.manifest.id, { root: value.root });
    const elite = accepted.trials[0]!; expect(elite.selected).toBe(true);
    await runUniverseCampaign(value.campaign.id, value);
    const summary = projectUniverse(value.directory); expect(summary.sourceState).toBe('healthy');
    expect(summary.runs).toHaveLength(3); expect(summary.elites).toHaveLength(1);
    expect(summary.elites[0]).toMatchObject({ trialId: elite.id, score: 10, artifact: elite.artifact });
    const failure = summary.runs[1]!.trials[0]!;
    for (const run of summary.runs.slice(1)) expect(run.trials[0]).toMatchObject({ parentTrialId: elite.id,
      status: 'failed', score: null, metrics: {}, selected: false });
    expect(value.prompts()[2]).toMatchObject({ parentTrialId: elite.id,
      feedback: { source: { trialId: failure.id }, score: null, diagnostics: [{ code: 'evaluator-nonzero' }] } });
    expect(JSON.stringify(value.requests)).not.toContain(PRIVATE);
  });

  it('does not relabel a changed comparator as invalid evaluator output', async () => {
    const value = fixture({ stdout: PRIVATE });
    value.evaluator.mockImplementationOnce(async () => {
      const evaluator = join(value.directory, 'seed', 'evaluate.mjs');
      chmodSync(evaluator, 0o600); writeFileSync(evaluator, '/* Mutated fixture comparator. */\n');
      return { stdout: PRIVATE, stderr: PRIVATE, exitCode: 0, signal: null, timedOut: false, cancelled: false };
    });
    const run = await runUniverse(value.manifest.id, { root: value.root });
    expect(run.status).toBe('failed'); expect(run.trials).toHaveLength(1);
    expect(run.trials[0]).toMatchObject({ status: 'failed', score: null, metrics: {}, selected: false });
    expect(run.trials[0]!.error).toMatch(/comparator|seed/i);
    expect(run.trials[0]!.diagnostics ?? []).toEqual([]);
  });
});
