/** Real private Git, immutable campaign/run records, execution lease and delivery.
 * The scored evaluator/registry are synthetic: this proves campaign ingestion
 * and local publication, not installed workload qualification or calibration.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactDigest, copyArtifact, digest, freezeArtifact } from '../src/core/universe/artifacts.js';
import { resolveBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
import { deliverCompletedUniverseCampaign } from '../src/core/universe/campaign-delivery.js';
import { readCompletedCampaignDelivery } from '../src/core/universe/campaign-delivery-recovery.js';
import { verifiedInitialCampaignRepair } from '../src/core/universe/campaign-improvement.js';
import { runCampaignSeedEvaluationOwned } from '../src/core/universe/campaign-seed-evaluation.js';
import { readCampaignSeedContext } from '../src/core/universe/campaign-seed-context.js';
import { appendCampaignEvent, campaignDirectory, initUniverseCampaign, readCampaignEvents, readUniverseCampaign } from '../src/core/universe/campaign-store.js';
import { readUniverseDeliveries } from '../src/core/universe/delivery.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';
import { runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';
import { appendRecord, initUniverse, manifestRecord, newRun, parseEvaluation, projectUniverse, selectWinners } from '../src/core/universe/store.js';
import { readKillSwitch } from '../src/core/sandbox/policy.js';
import type { UniverseManifest, UniverseTrial } from '../src/core/universe/types.js';

vi.mock('../src/core/universe/fixed-evaluator.js', () => ({ runFixedUniverseEvaluator: vi.fn() }));
vi.mock('../src/core/universe/builtin-evaluator-registry.js', async original => ({ ...await original<object>(), resolveBuiltinEvaluator: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', async original => ({ ...await original<object>(), readKillSwitch: vi.fn() }));

const roots: string[] = [];
const evaluator = vi.mocked(runFixedUniverseEvaluator);
const scoreOutput = (score: number, passed = true): string => JSON.stringify({ passed, score,
  metrics: { preparation_processes: score, baseline_processes: 150, candidate_processes: score,
    process_delta: score - 150, improved: passed && score < 150 ? 1 : 0 } });

beforeEach(() => {
  vi.mocked(readKillSwitch).mockReturnValue({ state: 'inactive', sourceState: 'healthy' } as ReturnType<typeof readKillSwitch>);
  // No score installation is fabricated. The isolated registry transport is a
  // fixed synthetic pin whose executable bytes remain independently checked by
  // the real store; the fixed evaluator below never launches it.
  const nodeDigest = digest(readFileSync(process.execPath));
  vi.mocked(resolveBuiltinEvaluator).mockReturnValue({ id: 'preparation-process-score-v1', digest: 'a'.repeat(64),
    executableDigest: nodeDigest, command: [process.execPath, '-e', 'throw new Error("inert evaluator must not execute")'],
    files: [], tools: [], git: { path: '/usr/bin/git', digest: 'b'.repeat(64) } });
  evaluator.mockImplementation(async (...args) => {
    args[9]?.();
    return { stdout: scoreOutput(150), stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false,
      processGroupSettlement: 'group-exit-confirmed' };
  });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks();
  // Only owned temporary fixtures; never follow symlinks during permission repair.
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture(minImprovement = 1, maxGenerations = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'calibrated-campaign-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 });
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' } }).trim();
  writeFileSync(join(repo, 'target.ts'), 'export const implementation = "seed";\n');
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'calibrated', name: 'Synthetic scored campaign',
    objective: 'Reduce verified process count', seed: { repo, revision: git('rev-parse', 'HEAD') },
    metric: { name: 'preparation_processes', direction: 'minimize', minImprovement },
    budget: { maxTrials: 1, maxDurationMs: 5000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { builtin: 'preparation-process-score-v1', timeoutMs: 1000 },
    variants: [{ id: 'change', niche: 'processes', hypothesis: 'Batch immutable reads', command: [process.execPath, '-e', 'void 0'] }] };
  initUniverse(manifest, { root });
  const directory = join(root, 'universes', manifest.id);
  const campaign = initUniverseCampaign({ schemaVersion: 1, id: 'campaign', universeId: manifest.id, measureSeed: true, feedback: true,
    budget: { maxGenerations, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: maxGenerations, maxReportedTokens: null } }, { root });
  const campaignPath = campaignDirectory(campaign.definition.id, { root });
  const startedAt = new Date().toISOString();
  appendCampaignEvent(campaignPath, { kind: 'started', at: startedAt,
    deadlineAt: new Date(Date.parse(startedAt) + 60_000).toISOString(), owner: { pid: process.pid, startRef: 'fixture' } });
  const deadlineMonotonicMs = performance.now() + 60_000;
  const measure = () => withUniverseExecution(manifest.id, { root }, lock => runCampaignSeedEvaluationOwned(campaign.definition.id,
    { root, signal: new AbortController().signal, deadlineMonotonicMs }, lock));
  function accept(score: number, content = `export const implementation = "changed-${score}";\n`) {
    const current = readUniverseCampaign(campaign.definition.id, { root });
    const overview = projectUniverse(directory); const record = manifestRecord(directory);
    const run = newRun(record, overview.runs.length + 1);
    run.campaign = { id: campaign.definition.id, ordinal: current.steps.length + 1, definitionDigest: campaign.definitionDigest };
    run.feedbackEnabled = true; run.feedbackVersion = 2;
    appendCampaignEvent(campaignPath, { kind: 'step', at: run.startedAt, ordinal: run.campaign.ordinal,
      runId: run.id, generation: run.generation, variantIds: ['change'], reservedModelRequests: 0 });
    run.seedContext = readCampaignSeedContext(run, record, root);
    appendRecord(directory, { id: `${run.id}.start`, kind: 'start', run, ownerPid: process.pid, ownerStart: 'fixture' });
    const trialId = randomUUID(); mkdirSync(join(directory, 'artifacts', run.id), { mode: 0o700 });
    const path = join(directory, 'artifacts', run.id, trialId); copyArtifact(record.seedArtifact.path, path);
    writeFileSync(join(path, 'target.ts'), content);
    const measured = parseEvaluation(scoreOutput(score));
    const trial: UniverseTrial = { id: trialId, variantId: 'change', niche: 'processes',
      parentTrialId: overview.elites[0]?.trialId ?? null, status: 'passed', score: measured.score, metrics: measured.metrics,
      artifact: { path, digest: artifactDigest(path), revision: manifest.seed.revision }, durationMs: 1, delta: null, selected: false };
    freezeArtifact(path);
    appendRecord(directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id, trial });
    run.trials = [trial]; run.status = 'completed'; run.finishedAt = new Date().toISOString();
    selectWinners(run, manifest, overview.elites);
    appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
    return { trial, run };
  }
  const finish = () => appendCampaignEvent(campaignPath, { kind: 'settled', at: new Date().toISOString(), state: 'completed', reason: 'Synthetic campaign complete' });
  const options = { root, delivery: { branch: 'codex/calibrated-result', baseCommit: manifest.seed.revision } };
  return { root, repo, git, manifest, directory, campaignPath, measure, accept, finish, options,
    read: () => readUniverseCampaign(campaign.definition.id, { root }) };
}

describe('calibrated scoring campaign ingestion and local delivery (synthetic evaluator)', () => {
  it('retains passing seed 150 as feedback without creating a parent or replaying the evaluator', async () => {
    const f = fixture(); expect(await f.measure()).toEqual({ status: 'measured', reason: null });
    expect(f.read().seedEvaluation?.result).toMatchObject({ status: 'measured', processGroupSettlement: 'group-exit-confirmed',
      measurement: { passed: true, score: 150 } });
    const before = readCampaignEvents(f.campaignPath);
    expect(await f.measure()).toEqual({ status: 'measured', reason: null });
    expect(readCampaignEvents(f.campaignPath)).toEqual(before); expect(evaluator).toHaveBeenCalledTimes(1);
    expect(projectUniverse(f.directory)).toMatchObject({ runs: [], elites: [] });
    const { trial, run } = f.accept(149);
    expect(run.seedContext?.measurement).toMatchObject({ passed: true, score: 150 });
    expect(trial).toMatchObject({ selected: true, parentTrialId: null, delta: null, score: 149 });
    expect(projectUniverse(f.directory).elites[0]?.score).toBe(149);
  });

  it('delivers first changed 149 against passing seed 150 and replays the real branch receipt without reevaluation', async () => {
    const f = fixture(); await f.measure(); const { trial } = f.accept(149); f.finish();
    expect(verifiedInitialCampaignRepair(projectUniverse(f.directory), f.read(), trial, manifestRecord(f.directory).seedArtifact.digest)).toBeNull();
    const before = readCampaignEvents(f.campaignPath); const index = readFileSync(join(f.repo, '.git', 'index'));
    const result = await deliverCompletedUniverseCampaign('campaign', f.options);
    expect(result.delivery.status).toBe('delivered');
    if (result.delivery.status !== 'delivered') throw new Error('Passing calibrated seed improvement was withheld');
    expect(result.delivery.receipt.trialId).toBe(trial.id);
    expect(f.git('show', `${result.delivery.receipt.commit}:target.ts`)).toContain('changed-149');
    expect(f.git('rev-parse', 'HEAD')).toBe(f.manifest.seed.revision);
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(await deliverCompletedUniverseCampaign('campaign', f.options)).toEqual(result);
    expect(readCompletedCampaignDelivery(f.read(), f.options.delivery, { root: f.root })).toEqual(result.delivery.receipt);
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root }).deliveries).toHaveLength(1);
    expect(readCampaignEvents(f.campaignPath)).toEqual(before); expect(evaluator).toHaveBeenCalledTimes(1);
  });

  it('keeps the first strict seed improvement deliverable after a later equal-score attempt', async () => {
    const f = fixture(1, 3); await f.measure(); const first = f.accept(149); const later = f.accept(149, 'export const implementation = "another";\n'); f.finish();
    expect(later.trial).toMatchObject({ parentTrialId: first.trial.id, selected: false });
    // The minimize multiplier produces -0 in memory; JSON records normalize it.
    expect(later.trial.delta === 0).toBe(true);
    expect(f.read().progress).toMatchObject({ admissions: 1, improvements: 0, stagnantGenerations: 1 });
    expect(await deliverCompletedUniverseCampaign('campaign', f.options)).toMatchObject({ delivery: { status: 'delivered', receipt: { trialId: first.trial.id } } });
    expect(evaluator).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'equal score', score: 150, minimum: 1, unchanged: false },
    { name: 'regressed score', score: 151, minimum: 1, unchanged: false },
    { name: 'below threshold', score: 149, minimum: 2, unchanged: false },
    { name: 'unchanged seed bytes', score: 149, minimum: 1, unchanged: true },
  ])('withholds $name without any branch or delivery intent', async ({ score, minimum, unchanged }) => {
    const f = fixture(minimum); await f.measure();
    f.accept(score, unchanged ? readFileSync(join(f.repo, 'target.ts'), 'utf8') : undefined); f.finish();
    expect(await deliverCompletedUniverseCampaign('campaign', f.options)).toMatchObject({ delivery: { status: 'withheld', reason: 'no-strict-improvement' } });
    expect(f.git('branch', '--list', f.options.delivery.branch)).toBe('');
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root }).deliveries).toEqual([]);
  });

  it('keeps failed-seed repair separately opted in', async () => {
    evaluator.mockImplementation(async (...args) => { args[9]?.(); return { stdout: scoreOutput(150, false), stderr: '',
      exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' }; });
    const f = fixture(); await f.measure(); const { trial } = f.accept(149); f.finish();
    expect(await deliverCompletedUniverseCampaign('campaign', f.options)).toMatchObject({ delivery: { status: 'withheld', reason: 'no-strict-improvement' } });
    expect(await deliverCompletedUniverseCampaign('campaign', { ...f.options, delivery: { ...f.options.delivery, allowInitialRepair: true } }))
      .toMatchObject({ delivery: { status: 'delivered', receipt: { trialId: trial.id } } });
  });

  it('refuses seed byte drift in the final stop callback after initial eligibility, before publishing a branch', async () => {
    const f = fixture(); await f.measure(); f.accept(149); f.finish();
    const seed = join(manifestRecord(f.directory).seedArtifact.path, 'target.ts');
    const original = readFileSync(seed); const mode = lstatSync(seed).mode & 0o777;
    let checks = 0; let injected = false;
    try {
      await expect(deliverCompletedUniverseCampaign('campaign', { ...f.options, isExecutionStopped: () => {
        if (++checks === 2) {
          chmodSync(seed, 0o600); writeFileSync(seed, 'export const implementation = "drifted";\n');
          chmodSync(seed, mode); injected = true;
        }
        return false;
      } })).rejects.toThrow(/baseline artifact is missing or changed/);
      expect(injected).toBe(true); expect(checks).toBe(2);
      expect(f.git('branch', '--list', f.options.delivery.branch)).toBe('');
    } finally { chmodSync(seed, 0o600); writeFileSync(seed, original); chmodSync(seed, mode); }
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root }).deliveries).toEqual([]);
    expect(evaluator).toHaveBeenCalledTimes(1);
    await expect(withUniverseExecution(f.manifest.id, { root: f.root }, async () => true)).resolves.toBe(true);
  });
});
