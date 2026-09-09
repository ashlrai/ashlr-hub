import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseDeliveries, runUniverseCampaignAndDeliver, deliverCompletedUniverseCampaign,
  type UniverseManifest, type UniverseTrial } from '../src/core/universe/index.js';
import { artifactDigest, copyArtifact, freezeArtifact } from '../src/core/universe/artifacts.js';
import { appendCampaignEvent, campaignDirectory } from '../src/core/universe/campaign-store.js';
import { appendRecord, manifestRecord, newRun, projectUniverse, selectWinners } from '../src/core/universe/store.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';
import * as deliveryGitModule from '../src/core/universe/delivery-git.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  function writable(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  }
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture(direction: 'maximize' | 'minimize' = 'maximize') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-campaign-delivery-')));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { mode: 0o700 });
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' } }).trim();
  writeFileSync(join(repo, 'value.txt'), 'seed\n');
  writeFileSync(join(repo, 'eval.mjs'), 'console.log(JSON.stringify({passed:true,score:1}))\n');
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed']);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'fixture', name: 'Campaign delivery fixture', objective: 'Improve measured quality',
    seed: { repo, revision: git(['rev-parse', 'HEAD']) }, metric: { name: 'quality', direction, minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 5000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'eval.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'repair', niche: 'quality', hypothesis: 'Improve the source', command: [process.execPath, '-e', ''] }] };
  initUniverse(manifest, { root });
  const directory = join(root, 'universes', manifest.id);
  function register(id: string) {
    const campaign = initUniverseCampaign({ schemaVersion: 1, id, universeId: manifest.id, feedback: false,
      budget: { maxGenerations: 8, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: 8, maxReportedTokens: null } }, { root });
    const at = new Date().toISOString();
    appendCampaignEvent(campaignDirectory(id, { root }), { kind: 'started', at,
      deadlineAt: new Date(Date.parse(at) + 60_000).toISOString(), owner: { pid: process.pid, startRef: 'fixture' } });
    return campaign;
  }
  function accept(id: string, score: number, content = `improved ${score}\n`, niche = 'quality') {
    const campaign = readUniverseCampaign(id, { root });
    const overview = projectUniverse(directory);
    const record = manifestRecord(directory);
    const run = newRun(record, overview.runs.length + 1);
    run.campaign = { id, ordinal: campaign.steps.length + 1, definitionDigest: campaign.definitionDigest };
    appendCampaignEvent(campaignDirectory(id, { root }), { kind: 'step', at: run.startedAt,
      ordinal: run.campaign.ordinal, runId: run.id, generation: run.generation, variantIds: ['repair'], reservedModelRequests: 0 });
    appendRecord(directory, { id: `${run.id}.start`, kind: 'start', run, ownerPid: process.pid, ownerStart: 'fixture' });
    const trialId = randomUUID();
    mkdirSync(join(directory, 'artifacts', run.id), { mode: 0o700 });
    const path = join(directory, 'artifacts', run.id, trialId);
    copyArtifact(record.seedArtifact.path, path);
    writeFileSync(join(path, 'value.txt'), content);
    const trial: UniverseTrial = { id: trialId, variantId: 'repair', niche, parentTrialId: overview.elites.find((elite) => elite.niche === niche)?.trialId ?? null,
      status: 'passed', score, metrics: {}, artifact: { path, digest: artifactDigest(path), revision: manifest.seed.revision },
      durationMs: 1, delta: null, selected: false };
    freezeArtifact(path);
    appendRecord(directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id, trial });
    run.trials = [trial]; run.status = 'completed'; run.finishedAt = new Date().toISOString();
    selectWinners(run, manifest, overview.elites);
    appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
    return trial;
  }
  function finish(id: string, state: 'completed' | 'failed' | 'stopped' = 'completed') {
    appendCampaignEvent(campaignDirectory(id, { root }), { kind: 'settled', at: new Date().toISOString(), state, reason: 'fixture terminal' });
  }
  const options = { root, delivery: { branch: 'codex/campaign-output', baseCommit: manifest.seed.revision } };
  return { root, repo, git, manifest, directory, register, accept, finish, options };
}

describe('opt-in campaign local delivery', () => {
  it('rechecks expiry after the final checkout inspection and leaves a recoverable intent without publishing a ref', async () => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search');
    const now = performance.now.bind(performance); const deadline = now() + 60_000;
    let expired = false; let inspections = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => expired ? deadline + 1 : now());
    const original = deliveryGitModule.deliveryGit;
    vi.spyOn(deliveryGitModule, 'deliveryGit').mockImplementation((repo, gitDeadline) => {
      const git = original(repo, gitDeadline);
      return { ...git, assertNotCheckedOut: (branch) => {
        git.assertNotCheckedOut(branch); if (++inspections === 2) expired = true;
      } };
    });
    await expect(deliverCompletedUniverseCampaign('search', { ...f.options, deadlineMonotonicMs: deadline })).rejects.toThrow(/deadline exhausted/);
    expect(inspections).toBe(2); expect(f.git(['branch', '--list', f.options.delivery.branch])).toBe('');
    vi.restoreAllMocks();
    const pending = readUniverseDeliveries('fixture', { root: f.root }).deliveries[0]!;
    expect(pending.status).toBe('pending');
    const replay = await deliverCompletedUniverseCampaign('search', f.options);
    expect(replay.delivery).toMatchObject({ status: 'delivered', receipt: { commit: pending.commit, createdAt: pending.createdAt } });
    expect(f.git(['rev-parse', `refs/heads/${pending.branch}`])).toBe(pending.commit);
  });

  it('withholds a branch when synchronous Git preparation crosses the supervisor deadline and releases its lease', async () => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search');
    const now = performance.now.bind(performance); const deadline = now() + 60_000;
    let expired = false;
    vi.spyOn(performance, 'now').mockImplementation(() => expired ? deadline + 1 : now());
    const original = deliveryGitModule.deliveryGit;
    vi.spyOn(deliveryGitModule, 'deliveryGit').mockImplementation((repo, gitDeadline) => {
      const git = original(repo, gitDeadline);
      return { ...git, writeTree: (entries) => { const tree = git.writeTree(entries); expired = true; return tree; } };
    });
    await expect(deliverCompletedUniverseCampaign('search', { ...f.options, deadlineMonotonicMs: deadline })).rejects.toThrow(/deadline exhausted/);
    expect(expired).toBe(true);
    expect(f.git(['branch', '--list', f.options.delivery.branch])).toBe('');
    await expect(withUniverseExecution('fixture', { root: f.root }, async () => true)).resolves.toBe(true);
  });

  it('delivery-only reconciliation never starts an unfinished campaign or changes its budget', async () => {
    const f = fixture(); f.register('search');
    const before = readUniverseCampaign('search', { root: f.root });
    expect(await deliverCompletedUniverseCampaign('search', f.options)).toMatchObject({
      delivery: { status: 'withheld', reason: 'campaign-not-completed' }, campaign: before,
    });
    expect(readUniverseCampaign('search', { root: f.root })).toEqual(before);
    expect(projectUniverse(f.directory).runs).toHaveLength(0);
  });

  it('rejects changed supervisor result pins before any branch mutation and releases ownership', async () => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search');
    const summary = readUniverseCampaign('search', { root: f.root });
    const identity = { universeId: 'fixture', definitionDigest: summary.definitionDigest,
      manifestDigest: summary.manifestDigest, comparatorDigest: summary.comparatorDigest };
    for (const changed of [{ summaryDigest: '0'.repeat(64) }, { recordsDigest: '0'.repeat(64) }]) {
      await expect(deliverCompletedUniverseCampaign('search', { ...f.options, expectedIdentity: { ...identity, ...changed } })).rejects.toThrow(/evidence changed/);
    }
    expect(f.git(['branch', '--list', f.options.delivery.branch])).toBe('');
    await expect(withUniverseExecution('fixture', { root: f.root }, async () => true)).resolves.toBe(true);
  });

  it.each(['maximize', 'minimize'] as const)('delivers a strict %s improvement and preserves checkout/index with idempotent replay', async (direction) => {
    const f = fixture(direction); f.register('search'); f.accept('search', 10);
    const trial = f.accept('search', direction === 'maximize' ? 20 : 5); f.finish('search');
    writeFileSync(join(f.repo, 'value.txt'), 'owner staged work\n'); f.git(['add', 'value.txt']);
    writeFileSync(join(f.repo, 'value.txt'), 'owner unstaged work\n');
    const index = readFileSync(join(f.repo, '.git', 'index'));
    const result = await runUniverseCampaignAndDeliver('search', f.options);
    expect(result.delivery.status).toBe('delivered');
    if (result.delivery.status !== 'delivered') throw new Error('Expected local delivery');
    expect(result.delivery.receipt.trialId).toBe(trial.id);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.manifest.seed.revision);
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('owner unstaged work\n');
    expect(await runUniverseCampaignAndDeliver('search', f.options)).toEqual(result);
    expect(f.git(['rev-list', '--count', result.delivery.receipt.commit])).toBe('2');
  });

  it('recovers a pending intent and replays historical delivery after another campaign replaces the elite', async () => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search');
    const result = await runUniverseCampaignAndDeliver('search', f.options);
    if (result.delivery.status !== 'delivered') throw new Error('Expected local delivery');
    const receipt = result.delivery.receipt;
    unlinkSync(join(f.directory, 'deliveries', 'records', `${receipt.id}.receipt.json`));
    f.register('later'); f.accept('later', 3); f.finish('later');
    const replay = await runUniverseCampaignAndDeliver('search', f.options);
    expect(replay.delivery).toMatchObject({ status: 'delivered', receipt: { commit: receipt.commit, createdAt: receipt.createdAt } });
    expect(await runUniverseCampaignAndDeliver('search', { ...f.options, delivery: { ...f.options.delivery, branch: 'codex/new' } }))
      .toMatchObject({ delivery: { status: 'withheld', reason: 'no-strict-improvement' } });
  });

  it('refuses branch tampering on replay and releases the execution lease after failure', async () => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search');
    await runUniverseCampaignAndDeliver('search', f.options);
    f.git(['update-ref', `refs/heads/${f.options.delivery.branch}`, f.manifest.seed.revision]);
    await expect(runUniverseCampaignAndDeliver('search', f.options)).rejects.toThrow(/degraded/);
    await expect(withUniverseExecution('fixture', { root: f.root }, async () => true)).resolves.toBe(true);
  });

  it('refuses an existing receipt belonging to another campaign', async () => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search');
    await runUniverseCampaignAndDeliver('search', f.options);
    f.register('other'); f.accept('other', 3); f.finish('other');
    await expect(runUniverseCampaignAndDeliver('other', f.options)).rejects.toThrow(/different/);
  });

  it('revalidates the explicit base on replay without modifying the already delivered branch', async () => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search');
    const result = await runUniverseCampaignAndDeliver('search', f.options);
    if (result.delivery.status !== 'delivered') throw new Error('Expected local delivery');
    await expect(runUniverseCampaignAndDeliver('search', { ...f.options,
      delivery: { ...f.options.delivery, baseCommit: '0'.repeat(40) } })).rejects.toThrow(/pinned seed/);
    expect(f.git(['rev-parse', `refs/heads/${f.options.delivery.branch}`])).toBe(result.delivery.receipt.commit);
    expect(await runUniverseCampaignAndDeliver('search', f.options)).toEqual(result);
  });

  it.each(['admission', 'equal-score', 'same-parent-bytes', 'seed-bytes'] as const)('withholds %s evidence', async (kind) => {
    const f = fixture(); f.register('search'); f.accept('search', 1);
    if (kind !== 'admission') f.accept('search', kind === 'equal-score' ? 1 : 2,
      kind === 'same-parent-bytes' ? 'improved 1\n' : kind === 'seed-bytes' ? 'seed\n' : 'different\n');
    f.finish('search');
    expect(await runUniverseCampaignAndDeliver('search', f.options)).toMatchObject({ delivery: { status: 'withheld', reason: 'no-strict-improvement' } });
    expect(f.git(['branch', '--list', f.options.delivery.branch])).toBe('');
  });

  it.each(['failed', 'stopped'] as const)('never delivers a %s campaign even with an earlier improvement', async (state) => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search', state);
    expect(await runUniverseCampaignAndDeliver('search', f.options)).toMatchObject({ delivery: { status: 'withheld', reason: 'campaign-not-completed' } });
    expect(f.git(['branch', '--list', f.options.delivery.branch])).toBe('');
  });

  it('withholds a completed campaign when the caller is cancelled', async () => {
    const f = fixture(); f.register('search'); f.accept('search', 1); f.accept('search', 2); f.finish('search');
    expect(await runUniverseCampaignAndDeliver('search', { ...f.options, signal: AbortSignal.abort() }))
      .toMatchObject({ campaign: { state: 'completed' }, delivery: { status: 'withheld', reason: 'cancelled' } });
    expect(f.git(['branch', '--list', f.options.delivery.branch])).toBe('');
  });

  it.each(['HEAD', '0'.repeat(40)])('rejects wrong or symbolic base %s before execution or replay', async (baseCommit) => {
    const f = fixture(); f.register('search');
    const before = readUniverseCampaign('search', { root: f.root });
    await expect(runUniverseCampaignAndDeliver('search', { ...f.options, delivery: { ...f.options.delivery, baseCommit } })).rejects.toThrow(/pinned/);
    expect(readUniverseCampaign('search', { root: f.root })).toEqual(before);
    expect(projectUniverse(f.directory).runs).toHaveLength(0);
  });
});
