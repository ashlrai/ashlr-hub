/** Real immutable experiment records; candidate and evaluator transports are inert. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as broker from '../src/core/universe/model-candidate.js';
import * as verify from '../src/core/run/verify-commands.js';
import * as evidence from '../src/core/universe/evidence-size.js';
import { initUniverse, readUniverseOverview, runUniverse, type UniverseManifest } from '../src/core/universe/index.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { feedbackReceipt } from '../src/core/universe/feedback.js';
import { searchContextReceipt } from '../src/core/universe/search-context.js';
import { newGenerationReceipt, resourceGenerationTaskId, validGenerationReceipt } from '../src/core/universe/generation.js';
import { projectUniverse, readRecords } from '../src/core/universe/store.js';
import type { UniverseGenerationConfig } from '../src/core/universe/types.js';

const roots: string[] = [];
const PRIVATE = 'PRIVATE_GENERATION_SENTINEL_never_forward_to_model';
type Failure = 'failed' | 'not-started' | 'timed-out' | 'cancelled' | 'withheld' | 'unavailable' | 'replayed' | 'uncertain' | 'reserved';
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture(resource = false, failure: Failure = 'failed') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-generation-diagnostics-'))); roots.push(base);
  const root = join(base, 'store'); const repo = join(base, 'repo'); mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'value.mjs'), 'export const value = 0;\n');
  writeFileSync(join(repo, 'evaluate.mjs'), '/* Fixed inert evaluator. */\n');
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.mjs', 'evaluate.mjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Pinned inert evaluator');
  const generation: UniverseGenerationConfig = resource ? { kind: 'resource-pool', poolId: 'fixture', poolDigest: digest('pool'),
    allowedWorkerIds: ['fixture-worker'], files: ['value.mjs'], maxOutputTokens: 256 } :
    { kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1', model: 'inert', files: ['value.mjs'], maxOutputTokens: 256 };
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'generation-diagnostics', name: 'Generation diagnostics fixture',
    objective: 'Improve the fixed measured value', seed: { repo, revision: git('rev-parse', 'HEAD') },
    metric: { name: 'checks', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1_000 },
    variants: [{ id: 'candidate', niche: 'quality', hypothesis: 'Use recorded feedback', generation }] };
  initUniverse(manifest, { root });
  const requests: broker.ModelCandidateContext[] = [];
  const candidate = vi.spyOn(broker, 'generateModelCandidate').mockImplementation(async (config, context) => {
    requests.push(context);
    const receipt = newGenerationReceipt(config);
    receipt.status = failure === 'timed-out' || failure === 'cancelled' ? failure : 'failed';
    receipt.error = PRIVATE;
    if (failure !== 'not-started') receipt.promptDigest = digest('inert prompt');
    if (context.feedback) { receipt.feedback = feedbackReceipt(context.feedback); receipt.promptDigest = digest('inert prompt'); }
    if (receipt.promptDigest !== null && context.searchContext) receipt.search = searchContextReceipt(context.searchContext);
    if (receipt.resource && failure !== 'not-started') {
      const dispatch = ['withheld', 'unavailable', 'replayed'].includes(failure) ? failure as 'withheld' | 'unavailable' | 'replayed' : 'settled';
      Object.assign(receipt.resource, { dispatch, taskId: resourceGenerationTaskId(context.resourceIdentity!) });
      if (dispatch === 'settled' || dispatch === 'replayed') Object.assign(receipt.resource, {
        taskDigest: digest('task'), workerId: 'fixture-worker', workerProvider: 'codex', workerModel: 'inert', receiptDigest: digest('receipt'),
        taskStatus: ['uncertain', 'reserved', 'timed-out', 'cancelled'].includes(failure) ? failure : 'failed',
      });
      if (failure === 'reserved') receipt.resource.dispatch = 'replayed';
    } else if (!receipt.resource) receipt.requestStarted = failure !== 'not-started';
    expect(validGenerationReceipt(receipt)).toBe(true);
    return receipt;
  });
  const evaluator = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: JSON.stringify({ passed: true, score: 10, metrics: {} }),
    stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false });
  return { root, manifest, candidate, evaluator, requests, directory: join(root, 'universes', manifest.id),
    run: (signal?: AbortSignal) => runUniverse(manifest.id, { root, feedback: true, ...(signal ? { signal } : {}) }) };
}

const cases: Array<{ resource: boolean; failure: Failure; code: string }> = [
  { resource: false, failure: 'failed', code: 'generation-failed' },
  { resource: false, failure: 'not-started', code: 'generation-not-started' },
  { resource: false, failure: 'timed-out', code: 'generation-timed-out' },
  { resource: true, failure: 'not-started', code: 'generation-resource-not-started' },
  { resource: true, failure: 'withheld', code: 'generation-resource-withheld' },
  { resource: true, failure: 'unavailable', code: 'generation-resource-unresolved' },
  { resource: true, failure: 'replayed', code: 'generation-resource-unresolved' },
  { resource: true, failure: 'reserved', code: 'generation-resource-unresolved' },
  { resource: true, failure: 'uncertain', code: 'generation-resource-unresolved' },
  { resource: true, failure: 'timed-out', code: 'generation-timed-out' },
  { resource: true, failure: 'failed', code: 'generation-failed' },
];
describe.runIf(process.platform === 'darwin')('fixed generation failure diagnostics', () => {
  it.each(cases)('forwards $failure (resource=$resource) as $code without private errors', async ({ resource, failure, code }) => {
    const f = fixture(resource, failure); const first = await f.run(); await f.run();
    expect(first.trials[0]).toMatchObject({ score: null, metrics: {}, artifact: null, delta: null, selected: false,
      diagnostics: [{ code }] });
    expect(first.trials[0]!.error).toBe(PRIVATE);
    expect(f.evaluator).not.toHaveBeenCalled();
    expect(f.requests[1]!.feedback).toMatchObject({ score: null, metrics: {}, source: { artifactDigest: null },
      diagnostics: [{ code }], previousAttemptFiles: [] });
    expect(JSON.stringify(f.requests[1]!.feedback)).not.toContain(PRIVATE);
    const before = readRecords(f.directory).map(canonical);
    const summary = projectUniverse(f.directory); expect(summary.sourceState).toBe('healthy'); expect(summary.elites).toEqual([]);
    expect(readRecords(f.directory).map(canonical)).toEqual(before);
    expect(readUniverseOverview(f).universes[0]!.runs[0]!.trials[0]!.diagnostics).toEqual(first.trials[0]!.diagnostics);
  });

  it.each([false, true])('suppresses cancellation feedback (resource=%s)', async (resource) => {
    const f = fixture(resource, 'cancelled'); const run = await f.run();
    expect(run.trials[0]!.status).toBe('cancelled'); expect(run.trials[0]!.diagnostics ?? []).toEqual([]);
    expect(f.evaluator).not.toHaveBeenCalled();
  });

  it('suppresses failure diagnostics if owner cancellation races the generation return', async () => {
    const f = fixture(true, 'uncertain'); const controller = new AbortController();
    const generate = f.candidate.getMockImplementation()!;
    f.candidate.mockImplementationOnce(async (...args) => { const receipt = await generate(...args); controller.abort(); return receipt; });
    const run = await f.run(controller.signal);
    expect(run.trials[0]!.diagnostics ?? []).toEqual([]); expect(f.evaluator).not.toHaveBeenCalled();
  });

  it('does not describe an uncertain timeout as proven native termination', async () => {
    const f = fixture(true, 'uncertain'); const generate = f.candidate.getMockImplementation()!;
    f.candidate.mockImplementationOnce(async (...args) => ({ ...await generate(...args), status: 'timed-out' }));
    const run = await f.run();
    expect(run.trials[0]).toMatchObject({ status: 'timed-out', diagnostics: [{ code: 'generation-resource-unresolved' }] });
    expect(f.evaluator).not.toHaveBeenCalled();
  });

  it('reserves the longest fixed phase diagnostic before candidate contact', async () => {
    const f = fixture(); const preflight = vi.spyOn(evidence, 'preflightTrialEvidenceBudget');
    await f.run();
    const diagnostic = preflight.mock.calls[0]![0].diagnostics![0]!;
    expect(diagnostic.code).toBe('generation-resource-unresolved');
    expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
    expect(preflight.mock.invocationCallOrder[0]).toBeLessThan(f.candidate.mock.invocationCallOrder[0]!);
  });

  it('retains the accepted elite while forwarding a later generation failure', async () => {
    const f = fixture();
    f.candidate.mockImplementationOnce(async (config, context) => {
      writeFileSync(join(context.candidatePath, 'value.mjs'), 'export const value = 1;\n');
      return { ...newGenerationReceipt(config), status: 'succeeded', requestStarted: true,
        promptDigest: digest('prompt'), responseDigest: digest('response'), changedFiles: ['value.mjs'],
        ...(context.searchContext ? { search: searchContextReceipt(context.searchContext) } : {}) };
    });
    const accepted = await f.run(); const elite = accepted.trials[0]!; expect(elite.selected).toBe(true);
    await f.run(); await f.run();
    const summary = projectUniverse(f.directory); expect(summary.sourceState).toBe('healthy');
    expect(summary.elites).toHaveLength(1); expect(summary.elites[0]).toMatchObject({ trialId: elite.id, artifact: elite.artifact });
    expect(f.requests[1]).toMatchObject({ parentTrialId: elite.id, feedback: { score: null, diagnostics: [{ code: 'generation-failed' }] } });
    expect(f.evaluator).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(f.manifest.seed.repo, 'value.mjs'), 'utf8')).toBe('export const value = 0;\n');
  });

  it('detects rewritten feedback diagnostics in durable replay', async () => {
    const f = fixture(); const first = await f.run(); await f.run();
    for (const record of readRecords(f.directory)) {
      if (record.kind === 'trial' && record.runId === first.id) record.trial.diagnostics![0]!.message = 'Rewritten';
      else if (record.kind === 'final' && record.run.id === first.id) record.run.trials[0]!.diagnostics![0]!.message = 'Rewritten';
      else continue;
      const path = join(f.directory, 'ledger', 'records', `${record.id}.json`);
      chmodSync(path, 0o600); writeFileSync(path, `${canonical(record)}\n`);
    }
    expect(() => projectUniverse(f.directory)).toThrow(/feedback digest/);
  });
});
