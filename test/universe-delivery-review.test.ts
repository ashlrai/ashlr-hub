import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, canonical, copyArtifact, freezeArtifact } from '../src/core/universe/artifacts.js';
import { deliverUniverseElite, readUniverseDeliveries, type UniverseDeliveryReceipt } from '../src/core/universe/delivery.js';
import { appendRecord, initUniverse, manifestRecord, newRun, projectUniverse, selectWinners } from '../src/core/universe/store.js';
import type { UniverseManifest, UniverseTrial } from '../src/core/universe/types.js';

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

/** Real Git and immutable ledgers; no model, evaluator, or candidate program executes. */
function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-delivery-review-')));
  roots.push(root);
  const repo = join(root, 'repository');
  mkdirSync(repo, { mode: 0o700 });
  const git = (args: string[], input?: string): string => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Universe Review', '-c', 'user.email=review@example.invalid',
    '-C', repo, ...args,
  ], { encoding: 'utf8', input, timeout: 10_000, env: {
    PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
  } }).trim();
  git(['init', '-q', `--object-format=${objectFormat}`]);
  writeFileSync(join(repo, 'value.txt'), 'seed\n');
  writeFileSync(join(repo, 'evaluate.mjs'), '// Pinned evaluator fixture; never executed.\n');
  git(['add', '.']);
  git(['commit', '-qm', 'seed']);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'review', name: 'Delivery review',
    objective: 'Preserve independent evidence while delivering a measured change',
    seed: { repo, revision: git(['rev-parse', 'HEAD']) },
    metric: { name: 'checks', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 1_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1_000 },
    variants: [{ id: 'candidate', niche: 'correctness', hypothesis: 'Improve the fixture', command: [process.execPath, 'candidate.mjs'] }],
  };
  initUniverse(manifest, { root });
  const directory = join(root, 'universes', manifest.id);
  const record = manifestRecord(directory);
  function addElite(value: number) {
    const previous = projectUniverse(directory);
    const run = newRun(record, previous.runs.length + 1);
    appendRecord(directory, { id: `${run.id}.start`, kind: 'start', run,
      ownerPid: process.pid, ownerStart: 'independent-test-owner' });
    const trialId = `trial-${value}`;
    const artifact = join(directory, 'artifacts', run.id, trialId);
    mkdirSync(join(directory, 'artifacts', run.id), { recursive: true, mode: 0o700 });
    copyArtifact(join(directory, 'seed'), artifact);
    writeFileSync(join(artifact, 'value.txt'), `candidate ${value}\n`);
    const trial: UniverseTrial = { id: trialId, variantId: 'candidate', niche: 'correctness',
      parentTrialId: previous.elites[0]?.trialId ?? null, status: 'passed', score: value, metrics: { checks: value },
      artifact: { path: artifact, digest: artifactDigest(artifact), revision: manifest.seed.revision },
      durationMs: 1, delta: null, selected: false };
    freezeArtifact(artifact);
    appendRecord(directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id, trial });
    Object.assign(run, { trials: [trial], status: 'completed', finishedAt: new Date().toISOString(), durationMs: 1 });
    selectWinners(run, manifest, previous.elites);
    appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
    expect(projectUniverse(directory).sourceState).toBe('healthy');
    return trial;
  }
  const trial = addElite(1);
  return { root, repo, directory, manifest, git, trial, addElite };
}

function rewriteBoth(directory: string, change: (receipt: UniverseDeliveryReceipt) => void): void {
  const records = join(directory, 'deliveries', 'records');
  const paths = readdirSync(records).filter((name) => name.endsWith('.json'));
  expect(paths).toHaveLength(2);
  for (const name of paths) {
    const path = join(records, name);
    const row = JSON.parse(readFileSync(path, 'utf8')) as { delivery: UniverseDeliveryReceipt };
    change(row.delivery);
    chmodSync(path, 0o600);
    writeFileSync(path, `${canonical(row)}\n`);
  }
}

describe('independent Universe delivery provenance review', () => {
  it.each([
    ['manifestDigest', '1'.repeat(64)], ['comparatorDigest', '2'.repeat(64)],
    ['runId', 'other-run'], ['trialId', 'other-trial'], ['niche', 'other-niche'],
  ] as const)('rejects synchronized intent and receipt %s drift', async (key, value) => {
    const current = fixture();
    await deliverUniverseElite('review', { root: current.root, trialId: current.trial.id, branch: 'codex/delivery' });
    rewriteBoth(current.directory, (receipt) => { receipt[key] = value; });
    const report = readUniverseDeliveries('review', { root: current.root });
    expect(report.sourceState, JSON.stringify(report)).toBe('degraded');
  }, 20_000);

  it('recomputes changed-file evidence instead of trusting matching receipt copies', async () => {
    const current = fixture();
    await deliverUniverseElite('review', { root: current.root, trialId: current.trial.id, branch: 'codex/delivery' });
    rewriteBoth(current.directory, (receipt) => { receipt.changedFiles = ['different.txt']; });
    expect(readUniverseDeliveries('review', { root: current.root }).sourceState).toBe('degraded');
  }, 20_000);

  it('does not accept the delivered commit as a forged pinned base', async () => {
    const current = fixture();
    const delivered = await deliverUniverseElite('review', { root: current.root, trialId: current.trial.id, branch: 'codex/delivery' });
    rewriteBoth(current.directory, (receipt) => { receipt.baseCommit = delivered.commit; });
    expect(readUniverseDeliveries('review', { root: current.root }).sourceState).toBe('degraded');
  }, 20_000);

  it('rejects a substituted valid Git commit with the same artifact tree but a different parent', async () => {
    const current = fixture();
    const delivered = await deliverUniverseElite('review', { root: current.root, trialId: current.trial.id, branch: 'codex/delivery' });
    const unrelated = current.git(['commit-tree', delivered.tree], 'Unrelated parentless commit\n');
    current.git(['update-ref', 'refs/heads/codex/delivery', unrelated, delivered.commit]);
    rewriteBoth(current.directory, (receipt) => { receipt.commit = unrelated; });
    const report = readUniverseDeliveries('review', { root: current.root });
    expect(report.sourceState, JSON.stringify(report)).toBe('degraded');
  }, 20_000);

  it('keeps a legitimate historical delivery verifiable after a newer elite wins', async () => {
    const current = fixture();
    const delivered = await deliverUniverseElite('review', { root: current.root, trialId: current.trial.id, branch: 'codex/first' });
    const newer = current.addElite(2);
    expect(projectUniverse(current.directory).elites[0]!.trialId).toBe(newer.id);
    const report = readUniverseDeliveries('review', { root: current.root });
    expect(report.sourceState, JSON.stringify(report)).toBe('healthy');
    expect(report.deliveries).toEqual([delivered]);
  }, 20_000);

  it('preserves SHA-256 repository commit/tree identities independently from artifact digests', async () => {
    const current = fixture('sha256');
    expect(current.manifest.seed.revision).toHaveLength(64);
    const delivered = await deliverUniverseElite('review', { root: current.root, trialId: current.trial.id, branch: 'codex/sha256' });
    expect(delivered.commit).toHaveLength(64);
    expect(delivered.tree).toHaveLength(64);
    expect(delivered.artifactDigest).toBe(current.trial.artifact!.digest);
    expect(delivered.tree).not.toBe(delivered.artifactDigest);
    expect(current.git(['show', `${delivered.commit}:value.txt`])).toBe('candidate 1');
    const report = readUniverseDeliveries('review', { root: current.root });
    expect(report.sourceState, JSON.stringify(report)).toBe('healthy');
  }, 20_000);

  it('rejects failed artifact preflight before creating branch, Git objects, or delivery intents', async () => {
    const current = fixture();
    const artifactFile = join(current.trial.artifact!.path, 'value.txt');
    chmodSync(artifactFile, 0o600);
    writeFileSync(artifactFile, 'changed after scoring\n');
    const before = current.git(['count-objects', '-v']);
    const refs = current.git(['show-ref']);
    await expect(deliverUniverseElite('review', { root: current.root, trialId: current.trial.id,
      branch: 'codex/rejected' })).rejects.toThrow(/evidence|artifact/i);
    expect(current.git(['count-objects', '-v'])).toBe(before);
    expect(current.git(['show-ref'])).toBe(refs);
    expect(existsSync(join(current.directory, 'deliveries'))).toBe(false);
  }, 20_000);

  it('keeps missing custom roots absent during both read and rejected delivery', async () => {
    const current = fixture();
    const absent = join(current.root, 'missing-store');
    expect(readUniverseDeliveries('review', { root: absent }).sourceState).toBe('missing');
    await expect(deliverUniverseElite('review', { root: absent, trialId: 'trial-one', branch: 'codex/missing' })).rejects.toThrow();
    expect(existsSync(absent)).toBe(false);
  }, 20_000);
});
