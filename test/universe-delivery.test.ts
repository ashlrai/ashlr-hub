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
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-delivery-')));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { mode: 0o700 });
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' } }).trim();
  writeFileSync(join(repo, 'value.txt'), 'seed\n');
  writeFileSync(join(repo, 'removed.txt'), 'remove me\n');
  writeFileSync(join(repo, 'eval.mjs'), 'console.log(JSON.stringify({passed:true,score:1}))\n');
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
  function accept(score = 1, change = true): UniverseTrial {
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

describe('Universe local branch delivery', () => {
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
