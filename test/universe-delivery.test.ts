import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverUniverseElite, initUniverse, readUniverseDeliveries, validUniverseDeliveryBranch, type UniverseManifest, type UniverseTrial } from '../src/core/universe/index.js';
import { artifactDigest, copyArtifact, freezeArtifact } from '../src/core/universe/artifacts.js';
import { appendRecord, manifestRecord, newRun, projectUniverse, selectWinners } from '../src/core/universe/store.js';
import { withUniverseExecution } from '../src/core/universe/execution.js';
import { deliveryGit } from '../src/core/universe/delivery-git.js';
import { readUniverseIntegrationPlan } from '../src/core/universe/integration-plan.js';
import type { UniverseDeliveryReceipt } from '../src/core/universe/delivery.js';
import { evaluateUniverseIntegration, readUniverseIntegrationEvaluation } from '../src/core/universe/integration-evaluate.js';
import { deliverUniverseIntegration } from '../src/core/universe/integration-delivery.js';

const roots: string[] = [];
afterEach(() => {
  function writable(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  }
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
function fixture(evaluationScript = 'console.log(JSON.stringify({passed:true,score:1}))\n') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-delivery-')));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { mode: 0o700 });
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' } }).trim();
  writeFileSync(join(repo, 'value.txt'), 'seed\n');
  writeFileSync(join(repo, 'removed.txt'), 'remove me\n');
  writeFileSync(join(repo, 'eval.mjs'), evaluationScript);
  writeFileSync(join(repo, '.gitattributes'), '*.txt filter=delivery-hostile\n');
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed']);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'fixture', name: 'Delivery fixture', objective: 'Record an independently selected local change',
    seed: { repo, revision: git(['rev-parse', 'HEAD']) }, metric: { name: 'quality', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 5000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'eval.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'repair', niche: 'quality', hypothesis: 'Improve the source', command: [process.execPath, '-e', ''] }] };
  initUniverse(manifest, { root });
  const directory = join(root, 'universes', manifest.id);
  function accept(score = 1, change = true, edit?: (path: string) => void): UniverseTrial {
    const overview = projectUniverse(directory);
    const record = manifestRecord(directory);
    const run = newRun(record, overview.runs.length + 1);
    appendRecord(directory, { id: `${run.id}.start`, kind: 'start', run, ownerPid: process.pid, ownerStart: 'fixture' });
    const trialId = randomUUID();
    mkdirSync(join(directory, 'artifacts', run.id), { mode: 0o700 });
    const path = join(directory, 'artifacts', run.id, trialId);
    copyArtifact(record.seedArtifact.path, path);
    if (change) {
      writeFileSync(join(path, 'value.txt'), `improved ${score}\n`);
      unlinkSync(join(path, 'removed.txt'));
      mkdirSync(join(path, 'nested'), { mode: 0o700 });
      writeFileSync(join(path, 'nested', 'script.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(join(path, 'binary.bin'), Buffer.from([0, 255, 128, 10]));
    }
    edit?.(path);
    const trial: UniverseTrial = { id: trialId, variantId: 'repair', niche: 'quality', parentTrialId: overview.elites[0]?.trialId ?? null,
      status: 'passed', score, metrics: {}, artifact: { path, digest: artifactDigest(path), revision: manifest.seed.revision },
      durationMs: 1, delta: null, selected: false };
    freezeArtifact(path);
    appendRecord(directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id, trial });
    run.trials = [trial]; run.status = 'completed'; run.finishedAt = new Date().toISOString();
    selectWinners(run, manifest, overview.elites);
    appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
    return trial;
  }
  return { root, repo, git, manifest, directory, accept };
}

describe.runIf(process.platform === 'darwin')('Universe combined fixed evaluation', () => {
  async function combined(a: number, b: number) {
    const f = fixture(`import {appendFileSync,readFileSync} from 'node:fs'; import {join} from 'node:path';
appendFileSync(join(process.env.HOME,'invocations'),'evaluated\\n');
const root=process.env.ASHLR_UNIVERSE_CANDIDATE;
const a=Number(readFileSync(join(root,'a.txt'),'utf8'));
const b=Number(readFileSync(join(root,'b.txt'),'utf8'));
console.log(JSON.stringify({passed:a+b<=3,score:a+b,metrics:{a,b}}));\n`);
    const firstTrial = f.accept(1, false, (path) => writeFileSync(join(path, 'a.txt'), String(a)));
    const first = await deliverUniverseElite('fixture', { root: f.root, trialId: firstTrial.id, branch: 'codex/evaluate-a' });
    const secondTrial = f.accept(2, false, (path) => writeFileSync(join(path, 'b.txt'), String(b)));
    const second = await deliverUniverseElite('fixture', { root: f.root, trialId: secondTrial.id, branch: 'codex/evaluate-b' });
    const integration = { schemaVersion: 1 as const, id: 'combined-evaluation', target: { repo: f.repo,
      baseCommit: f.manifest.seed.revision, allowedPaths: ['a.txt', 'b.txt'] }, sources: [first, second].map((receipt) => ({
        universeId: receipt.universeId, deliveryId: receipt.id, commit: receipt.commit, tree: receipt.tree })) };
    const plan = readUniverseIntegrationPlan(integration, { root: f.root });
    const record = manifestRecord(f.directory);
    const request = { schemaVersion: 1 as const, id: 'accept-combination', integration,
      expectedCompositionDigest: plan.compositionDigest!, acceptance: { universeId: 'fixture',
        manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest }, maxDurationMs: 30_000 };
    return { ...f, request };
  }

  it('freshly evaluates both upstream files and replays exact settled evidence without changing Git or trial history', async () => {
    const f = await combined(1, 2);
    writeFileSync(join(f.repo, 'value.txt'), 'user staged\n'); f.git(['add', 'value.txt']);
    writeFileSync(join(f.repo, 'value.txt'), 'user unstaged\n');
    const refs = f.git(['show-ref']); const index = readFileSync(join(f.repo, '.git', 'index'));
    const before = projectUniverse(f.directory);
    const result = await evaluateUniverseIntegration(f.request, { root: f.root });
    expect(result).toMatchObject({ status: 'passed', score: 3, metrics: { a: 1, b: 2 } });
    expect(result.artifactPath).not.toBeNull();
    expect(readFileSync(join(result.artifactPath!, 'a.txt'), 'utf8')).toBe('1');
    expect(readFileSync(join(result.artifactPath!, 'b.txt'), 'utf8')).toBe('2');
    expect(artifactDigest(result.artifactPath!)).toBe(result.artifactDigest);
    expect(await evaluateUniverseIntegration(f.request, { root: f.root })).toEqual(result);
    const requestPath = join(f.root, 'evaluation.json');
    writeFileSync(requestPath, JSON.stringify(f.request), { mode: 0o600 });
    const replay = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'universe', 'integration',
      'evaluate', '--manifest', requestPath, '--root', f.root, '--json'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: f.root, NO_COLOR: '1' },
    });
    expect(JSON.parse(replay)).toEqual(result);
    expect(readFileSync(join(result.artifactPath!, '..', 'evaluator', 'invocations'), 'utf8')).toBe('evaluated\n');
    expect(f.git(['show-ref'])).toBe(refs); expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('user unstaged\n');
    expect(projectUniverse(f.directory)).toEqual(before);
  });

  it('retains a jointly rejected candidate without promoting a branch or elite', async () => {
    const f = await combined(2, 2); const refs = f.git(['show-ref']); const before = projectUniverse(f.directory);
    const result = await evaluateUniverseIntegration(f.request, { root: f.root });
    expect(result).toMatchObject({ status: 'rejected', score: 4, metrics: { a: 2, b: 2 } });
    expect(result.artifactPath).not.toBeNull(); expect(artifactDigest(result.artifactPath!)).toBe(result.artifactDigest);
    expect(f.git(['show-ref'])).toBe(refs); expect(projectUniverse(f.directory)).toEqual(before);
  });

  it('refuses stale acceptance/composition pins and conflicting reuse of a settled request id', async () => {
    const f = await combined(1, 2);
    await expect(evaluateUniverseIntegration({ ...f.request, expectedCompositionDigest: '0'.repeat(64) }, { root: f.root })).rejects.toThrow();
    await expect(evaluateUniverseIntegration({ ...f.request, acceptance: { ...f.request.acceptance,
      comparatorDigest: '0'.repeat(64) } }, { root: f.root })).rejects.toThrow();
    await evaluateUniverseIntegration(f.request, { root: f.root });
    await expect(evaluateUniverseIntegration({ ...f.request, maxDurationMs: 29_000 }, { root: f.root })).rejects.toThrow();
  });

  it('does not replay success after retained artifact drift', async () => {
    const f = await combined(1, 2); const result = await evaluateUniverseIntegration(f.request, { root: f.root });
    const path = join(result.artifactPath!, 'a.txt'); chmodSync(path, 0o600); writeFileSync(path, 'tampered');
    await expect(evaluateUniverseIntegration(f.request, { root: f.root })).rejects.toThrow();
  });

  it('does not adopt an existing acceptance Universe execution owner', async () => {
    const f = await combined(1, 2);
    await withUniverseExecution('fixture', { root: f.root }, async () => {
      await expect(evaluateUniverseIntegration(f.request, { root: f.root })).rejects.toThrow(/owner|ownership/);
    });
  });

  async function publishable(a = 1, b = 2) {
    const f = await combined(a, b);
    const result = await evaluateUniverseIntegration(f.request, { root: f.root });
    const evidence = readUniverseIntegrationEvaluation(f.request, { root: f.root });
    expect(evidence.result).toEqual(result);
    return { ...f, result, delivery: { schemaVersion: 1 as const, evaluation: f.request,
      expectedEvaluationDigest: evidence.resultDigest, branch: 'codex/combined-product', maxDurationMs: 120_000 } };
  }

  it('delivers the inspected combined bytes to a new local branch and replays through the real CLI without reevaluation', async () => {
    const f = await publishable();
    writeFileSync(join(f.repo, 'value.txt'), 'user staged\n'); f.git(['add', 'value.txt']);
    writeFileSync(join(f.repo, 'value.txt'), 'user unstaged\n');
    const index = readFileSync(join(f.repo, '.git', 'index')); const head = f.git(['rev-parse', 'HEAD']);
    const before = projectUniverse(f.directory);
    const receipt = await deliverUniverseIntegration(f.delivery, { root: f.root });
    expect(receipt).toMatchObject({ status: 'delivered', changedFiles: ['a.txt', 'b.txt'],
      evaluationResultDigest: f.delivery.expectedEvaluationDigest, artifactDigest: f.result.artifactDigest,
      baseCommit: f.manifest.seed.revision, branch: f.delivery.branch });
    expect(f.git(['rev-parse', f.delivery.branch])).toBe(receipt.commit);
    expect(f.git(['rev-list', '--parents', '-n', '1', receipt.commit])).toBe(`${receipt.commit} ${head}`);
    expect(f.git(['show', `${receipt.commit}:a.txt`])).toBe('1');
    expect(f.git(['show', `${receipt.commit}:b.txt`])).toBe('2');
    expect(deliveryGit(f.repo).treeDigest(receipt.tree)).toBe(f.result.artifactDigest);
    const path = join(f.root, 'delivery.json'); writeFileSync(path, JSON.stringify(f.delivery), { mode: 0o600 });
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'universe', 'integration',
      'deliver', '--manifest', path, '--root', f.root, '--json'], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: f.root, NO_COLOR: '1' } });
    expect(JSON.parse(output)).toEqual(receipt);
    expect(readFileSync(join(f.result.artifactPath!, '..', 'evaluator', 'invocations'), 'utf8')).toBe('evaluated\n');
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('user unstaged\n');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head); expect(projectUniverse(f.directory)).toEqual(before);
  });

  it('inspects missing evaluations without creating evidence and never delivers a jointly rejected result', async () => {
    const missing = await combined(1, 2); const refs = missing.git(['show-ref']);
    expect(() => readUniverseIntegrationEvaluation(missing.request, { root: missing.root })).toThrow();
    expect(existsSync(join(missing.directory, 'integration-evaluations'))).toBe(false);
    expect(missing.git(['show-ref'])).toBe(refs);
    const rejected = await publishable(2, 2); const before = rejected.git(['show-ref']);
    await expect(deliverUniverseIntegration(rejected.delivery, { root: rejected.root })).rejects.toThrow();
    expect(rejected.git(['show-ref'])).toBe(before);
    expect(readFileSync(join(rejected.result.artifactPath!, '..', 'evaluator', 'invocations'), 'utf8')).toBe('evaluated\n');
  });

  it('refuses existing targets and a changed evaluation digest without overwriting or adopting refs', async () => {
    const f = await publishable(); f.git(['branch', f.delivery.branch]); const refs = f.git(['show-ref']);
    await expect(deliverUniverseIntegration(f.delivery, { root: f.root })).rejects.toThrow();
    await expect(deliverUniverseIntegration({ ...f.delivery, branch: 'codex/other', expectedEvaluationDigest: '0'.repeat(64) },
      { root: f.root })).rejects.toThrow();
    expect(f.git(['show-ref'])).toBe(refs);
  });

  it('does not recreate a completed branch that was removed or advance one that drifted', async () => {
    const f = await publishable(); const receipt = await deliverUniverseIntegration(f.delivery, { root: f.root });
    f.git(['update-ref', `refs/heads/${f.delivery.branch}`, f.manifest.seed.revision]);
    await expect(deliverUniverseIntegration(f.delivery, { root: f.root })).rejects.toThrow();
    expect(f.git(['rev-parse', f.delivery.branch])).toBe(f.manifest.seed.revision);
    f.git(['update-ref', '-d', `refs/heads/${f.delivery.branch}`]);
    await expect(deliverUniverseIntegration(f.delivery, { root: f.root })).rejects.toThrow();
    expect(f.git(['for-each-ref', '--format=%(objectname)', `refs/heads/${f.delivery.branch}`])).toBe('');
    expect(f.git(['rev-parse', `${receipt.commit}^{tree}`])).toBe(receipt.tree);
  });

  it('reconciles durable pending intent after the exact branch already became visible', async () => {
    const f = await publishable(); const receipt = await deliverUniverseIntegration(f.delivery, { root: f.root });
    unlinkSync(join(f.directory, 'integration-deliveries', 'records', `${receipt.id}.receipt.json`));
    const refs = f.git(['show-ref']);
    const replay = await deliverUniverseIntegration(f.delivery, { root: f.root });
    expect(replay).toMatchObject({ id: receipt.id, commit: receipt.commit, tree: receipt.tree, status: 'delivered' });
    expect(f.git(['show-ref'])).toBe(refs);
    expect(readFileSync(join(f.result.artifactPath!, '..', 'evaluator', 'invocations'), 'utf8')).toBe('evaluated\n');
  });

  it('rejects a changed retained artifact before publishing any combined branch', async () => {
    const f = await publishable(); const refs = f.git(['show-ref']);
    const path = join(f.result.artifactPath!, 'a.txt'); chmodSync(path, 0o600); writeFileSync(path, 'changed');
    await expect(deliverUniverseIntegration(f.delivery, { root: f.root })).rejects.toThrow();
    expect(f.git(['show-ref'])).toBe(refs);
  });
});

describe('Universe local branch delivery', () => {
  it('plans exact disjoint delivered trees without writing objects, refs, records, index or checkout', async () => {
    const f = fixture();
    const a = f.accept(1, false, (path) => writeFileSync(join(path, 'a.txt'), 'first change\n'));
    const first = await deliverUniverseElite('fixture', { root: f.root, trialId: a.id, branch: 'codex/input-a' });
    const b = f.accept(2, false, (path) => writeFileSync(join(path, 'b.txt'), 'second change\n'));
    const second = await deliverUniverseElite('fixture', { root: f.root, trialId: b.id, branch: 'codex/input-b' });
    const source = (receipt: UniverseDeliveryReceipt) => ({ universeId: receipt.universeId, deliveryId: receipt.id,
      commit: receipt.commit, tree: receipt.tree });
    const definition = { schemaVersion: 1, id: 'combined', target: { repo: f.repo,
      baseCommit: f.manifest.seed.revision, allowedPaths: ['a.txt', 'b.txt'] }, sources: [source(first), source(second)] };
    writeFileSync(join(f.repo, 'value.txt'), 'user staged\n'); f.git(['add', 'value.txt']);
    writeFileSync(join(f.repo, 'value.txt'), 'user unstaged\n');
    const inventory = (path: string): unknown => {
      const stat = lstatSync(path);
      return stat.isDirectory() ? readdirSync(path).sort().map((name) => [name, inventory(join(path, name))])
        : [stat.mode, readFileSync(path).toString('base64')];
    };
    const before = inventory(f.root);
    const plan = readUniverseIntegrationPlan(definition, { root: f.root });
    expect(plan).toMatchObject({ sourceState: 'healthy', compositionReady: true, authority: 'observation-only', conflicts: [] });
    expect(plan.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
    expect(plan.compositionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readUniverseIntegrationPlan(definition, { root: f.root })).toEqual(plan);
    expect(inventory(f.root)).toEqual(before);
    f.git(['update-ref', `refs/heads/${second.branch}`, f.manifest.seed.revision]);
    expect(readUniverseIntegrationPlan(definition, { root: f.root })).toMatchObject({ compositionReady: false, sourceState: 'degraded', compositionDigest: null });
  });

  it('holds divergent same-file deliveries and out-of-scope changes without combining either', async () => {
    const f = fixture();
    const a = f.accept(1, false, (path) => writeFileSync(join(path, 'value.txt'), 'first\n'));
    const first = await deliverUniverseElite('fixture', { root: f.root, trialId: a.id, branch: 'codex/first' });
    const b = f.accept(2, false, (path) => writeFileSync(join(path, 'value.txt'), 'second\n'));
    const second = await deliverUniverseElite('fixture', { root: f.root, trialId: b.id, branch: 'codex/second' });
    const definition = { schemaVersion: 1, id: 'conflicted', target: { repo: f.repo,
      baseCommit: f.manifest.seed.revision, allowedPaths: ['value.txt'] }, sources: [first, second].map((receipt) => ({
        universeId: receipt.universeId, deliveryId: receipt.id, commit: receipt.commit, tree: receipt.tree })) };
    const plan = readUniverseIntegrationPlan(definition, { root: f.root });
    expect(plan.sourceState).toBe('healthy'); expect(plan.compositionReady).toBe(false);
    expect(plan.conflicts.length).toBeGreaterThan(0); expect(plan.compositionDigest).toBeNull();
    const scoped = readUniverseIntegrationPlan({ ...definition, target: { ...definition.target, allowedPaths: ['unrelated.txt'] } }, { root: f.root });
    expect(scoped.compositionReady).toBe(false); expect(scoped.compositionDigest).toBeNull();
  });

  it('delivers exact bytes, executable modes, additions and deletions while preserving dirty checkout and index', async () => {
    const f = fixture(); const trial = f.accept();
    writeFileSync(join(f.repo, 'value.txt'), 'staged user work\n'); f.git(['add', 'value.txt']);
    writeFileSync(join(f.repo, 'value.txt'), 'unstaged user work\n');
    const index = readFileSync(join(f.repo, '.git', 'index'));
    const head = readFileSync(join(f.repo, '.git', 'HEAD'));
    const before = f.git(['status', '--porcelain=v1']);
    const receipt = await deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: 'codex/delivery' });
    expect(receipt.status).toBe('delivered');
    expect(receipt.changedFiles).toEqual(['binary.bin', 'nested/script.sh', 'removed.txt', 'value.txt']);
    expect(f.git(['show', `${receipt.commit}:value.txt`])).toBe('improved 1');
    expect(f.git(['ls-tree', '-r', receipt.commit])).toContain('100755 blob');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.manifest.seed.revision);
    expect(f.git(['rev-parse', 'refs/heads/codex/delivery'])).toBe(receipt.commit);
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(f.repo, '.git', 'HEAD'))).toEqual(head);
    expect(f.git(['status', '--porcelain=v1'])).toBe(before);
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('unstaged user work\n');
    expect(readUniverseDeliveries('fixture', { root: f.root })).toMatchObject({ sourceState: 'healthy', deliveries: [receipt] });
    expect(await deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: 'codex/delivery' })).toEqual(receipt);
  });

  it('records unchanged content without making a branch or new commit', async () => {
    const f = fixture(); const trial = f.accept(1, false);
    const receipt = await deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: 'codex/no-op' });
    expect(receipt).toMatchObject({ status: 'unchanged', commit: f.manifest.seed.revision, changedFiles: [] });
    expect(f.git(['branch', '--list', 'codex/no-op'])).toBe('');
    expect(readUniverseDeliveries('fixture', { root: f.root }).sourceState).toBe('healthy');
  });

  it('reconciles an interrupted post-ref intent exactly once', async () => {
    const f = fixture(); const trial = f.accept();
    const options = { root: f.root, trialId: trial.id, branch: 'codex/recover' };
    const receipt = await deliverUniverseElite('fixture', options);
    const file = join(f.directory, 'deliveries', 'records', `${receipt.id}.receipt.json`);
    unlinkSync(file); // Test-owned crash boundary: intent and ref survive, settlement does not.
    expect(readUniverseDeliveries('fixture', { root: f.root }).deliveries[0]!.status).toBe('pending');
    const recovered = await deliverUniverseElite('fixture', options);
    expect(recovered).toMatchObject({ status: 'delivered', commit: receipt.commit, tree: receipt.tree, createdAt: receipt.createdAt });
    expect(f.git(['rev-list', '--count', recovered.commit])).toBe('2');
  });

  it('reconciles a pre-ref intent without resetting its commit identity', async () => {
    const f = fixture(); const trial = f.accept();
    const options = { root: f.root, trialId: trial.id, branch: 'codex/pre-ref' };
    const receipt = await deliverUniverseElite('fixture', options);
    unlinkSync(join(f.directory, 'deliveries', 'records', `${receipt.id}.receipt.json`));
    f.git(['update-ref', '-d', `refs/heads/${receipt.branch}`, receipt.commit]);
    const recovered = await deliverUniverseElite('fixture', options);
    expect(recovered.commit).toBe(receipt.commit);
    expect(recovered.createdAt).toBe(receipt.createdAt);
  });

  it('refuses a previously accepted but no-longer-current elite for a new branch', async () => {
    const f = fixture(); const old = f.accept(); f.accept(2);
    await expect(deliverUniverseElite('fixture', { root: f.root, trialId: old.id, branch: 'codex/stale' })).rejects.toThrow(/current/);
    expect(f.git(['branch', '--list', 'codex/stale'])).toBe('');
  });

  it.each(['missing', 'modified', 'symlink'] as const)('refuses a %s candidate artifact without exposing a ref', async (mode) => {
    const f = fixture(); const trial = f.accept();
    const path = join(trial.artifact!.path, 'value.txt');
    chmodSync(trial.artifact!.path, 0o700);
    if (mode === 'modified') { chmodSync(path, 0o600); writeFileSync(path, 'tampered'); }
    else { unlinkSync(path); if (mode === 'symlink') symlinkSync(join(f.repo, 'value.txt'), path); }
    await expect(deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: 'codex/bad-artifact' })).rejects.toThrow();
    expect(f.git(['branch', '--list', 'codex/bad-artifact'])).toBe('');
    expect(existsSync(join(f.directory, 'deliveries'))).toBe(false);
  });

  it.each(['direct', 'symbolic', 'dangling-symbolic'] as const)('refuses a pre-existing %s ref', async (kind) => {
    const f = fixture(); const trial = f.accept(); const name = 'refs/heads/codex/existing';
    if (kind === 'direct') f.git(['update-ref', name, f.manifest.seed.revision]);
    else f.git(['symbolic-ref', name, kind === 'symbolic' ? f.git(['symbolic-ref', 'HEAD']) : 'refs/heads/nonexistent']);
    await expect(deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: 'codex/existing' })).rejects.toThrow(/pre-existing|symbolic/);
    expect(existsSync(join(f.directory, 'deliveries'))).toBe(false);
  });

  it('does not replace a dangling symbolic ref inserted at the publication boundary', async () => {
    const f = fixture();
    const git = deliveryGit(f.repo);
    expect(git.ref('codex/raced')).toBeNull();
    f.git(['symbolic-ref', 'refs/heads/codex/raced', 'refs/heads/unrelated-dangling']);
    await expect(git.createRef('codex/raced', f.manifest.seed.revision)).rejects.toThrow(/symbolic/);
    expect(f.git(['symbolic-ref', 'refs/heads/codex/raced'])).toBe('refs/heads/unrelated-dangling');
    expect(existsSync(join(f.repo, '.git', 'refs', 'heads', 'codex', 'raced.lock'))).toBe(false);
  });

  it('aborts a prepared transaction on end-of-input without publishing or retaining a lock', () => {
    const f = fixture(); const git = deliveryGit(f.repo);
    git.invoke(['update-ref', '--stdin'], `start\noption no-deref\ncreate refs/heads/codex/eof ${f.manifest.seed.revision}\nprepare\n`);
    expect(git.ref('codex/eof')).toBeNull();
    expect(existsSync(join(f.repo, '.git', 'refs', 'heads', 'codex', 'eof.lock'))).toBe(false);
  });

  it('does not execute repository filters, hooks, signing or fsmonitor configuration', async () => {
    const f = fixture(); const trial = f.accept(); const marker = join(f.root, 'MUST-NOT-RUN');
    const script = join(f.root, 'hostile.sh');
    writeFileSync(script, `#!/bin/sh\nprintf bad > '${marker}'\ncat\n`, { mode: 0o700 });
    f.git(['config', 'filter.delivery-hostile.clean', script]);
    f.git(['config', 'filter.delivery-hostile.required', 'true']);
    f.git(['config', 'core.fsmonitor', script]);
    f.git(['config', 'commit.gpgsign', 'true']);
    f.git(['config', 'gpg.program', script]);
    writeFileSync(join(f.repo, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\nprintf bad > '${marker}'\n`, { mode: 0o700 });
    const receipt = await deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: 'codex/no-hooks' });
    expect(receipt.status).toBe('delivered');
    expect(existsSync(marker)).toBe(false);
  });

  it('reports a delivered branch that drifts or disappears as degraded', async () => {
    const f = fixture(); const trial = f.accept();
    const receipt = await deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: 'codex/drift' });
    f.git(['update-ref', `refs/heads/${receipt.branch}`, receipt.baseCommit, receipt.commit]);
    expect(readUniverseDeliveries('fixture', { root: f.root }).sourceState).toBe('degraded');
    await expect(deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: receipt.branch })).rejects.toThrow(/drifted/);
    f.git(['update-ref', '-d', `refs/heads/${receipt.branch}`]);
    expect(readUniverseDeliveries('fixture', { root: f.root }).sourceState).toBe('degraded');
  });

  it('does not steal active campaign ownership', async () => {
    const f = fixture(); const trial = f.accept();
    await withUniverseExecution('fixture', { root: f.root }, async () => {
      await expect(deliverUniverseElite('fixture', { root: f.root, trialId: trial.id, branch: 'codex/busy' })).rejects.toThrow(/active execution owner/);
    });
    expect(existsSync(join(f.directory, 'deliveries'))).toBe(false);
  });

  it.each(['main', 'codex/', 'codex/../main', 'codex/a.lock', 'codex/a b', 'codex/a\nb', 'codex/a@{b', 'codex/.hidden', 'codex/a\\b'])('rejects branch %j', (branch) => {
    expect(validUniverseDeliveryBranch(branch)).toBe(false);
  });
});
