import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseCampaignComparison, requestUniverseCampaignControl,
  type UniverseManifest, type UniverseTrial } from '../src/core/universe/index.js';
import * as delivery from '../src/core/universe/delivery.js';
import { artifactDigest, copyArtifact, freezeArtifact } from '../src/core/universe/artifacts.js';
import { appendCampaignEvent } from '../src/core/universe/campaign-store.js';
import { appendRecord, manifestRecord, newRun, selectWinners } from '../src/core/universe/store.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'universe-comparison-reader-')));
  roots.push(outer);
  const root = join(outer, 'store');
  const repo = join(outer, 'repo');
  mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'never-run.mjs'), "throw new Error('Comparison must not execute work');\n");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' } }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Comparison Fixture', '-c', 'user.email=comparison@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'baseline-universe', name: 'Comparison fixture', objective: 'Inspect without running',
    seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: 'score', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'never-run.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'never-run', niche: 'quality', hypothesis: 'Only inspect', command: [process.execPath, 'never-run.mjs'] }] };
  const init = (id = 'baseline-universe') => initUniverse({ ...manifest, id }, { root });
  const campaign = (id: string, universeId = 'baseline-universe') => initUniverseCampaign({ schemaVersion: 1, id, universeId, feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 1000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
  const pair = () => { init(); init('challenger-universe'); campaign('baseline'); campaign('challenger', 'challenger-universe'); };
  const read = () => readUniverseCampaignComparison('baseline', 'challenger', { root });
  return { root, outer, repo, git, init, campaign, pair, read };
}

function snapshot(path: string): Array<[string, number, string | null]> {
  const rows: Array<[string, number, string | null]> = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      const relative = `${prefix}${name}`;
      rows.push([relative, stat.mode, stat.isFile() ? readFileSync(absolute).toString('base64') : null]);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(absolute, `${relative}/`);
    }
  };
  visit(path, '');
  return rows;
}

describe('targeted campaign comparison reader', () => {
  it('returns missing evidence without creating storage', () => {
    const f = fixture();
    expect(f.read()).toMatchObject({ sourceState: 'missing', baseline: { sourceState: 'missing' }, challenger: { sourceState: 'missing' }, matching: { comparable: false } });
    expect(existsSync(f.root)).toBe(false);
  });

  it.each(['../escape', '', 'UPPER', 'a'.repeat(65), 'a\n'])('rejects invalid identity %j before reading a missing store', (id) => {
    const f = fixture();
    expect(() => readUniverseCampaignComparison(id, 'challenger', { root: f.root })).toThrow('Invalid Universe campaign id');
    expect(() => readUniverseCampaignComparison('baseline', id, { root: f.root })).toThrow('Invalid Universe campaign id');
    expect(existsSync(f.root)).toBe(false);
  });

  it('rejects an identical pair before reading', () => {
    const f = fixture();
    expect(() => readUniverseCampaignComparison('same', 'same', { root: f.root })).toThrow('two distinct campaign ids');
    expect(existsSync(f.root)).toBe(false);
  });

  it('reads healthy idle evidence without claiming a comparison or changing any bytes', () => {
    const f = fixture(); f.pair();
    const before = snapshot(f.outer);
    const value = f.read();
    expect(value).toMatchObject({ sourceState: 'healthy', authority: 'observation-only', acceptedChanges: null,
      baseline: { campaignState: 'ready', completed: false, counts: { attempts: 0 } }, matching: { comparator: true, comparable: false } });
    expect(snapshot(f.outer)).toEqual(before);
    expect(f.git('status', '--porcelain')).toBe('');
  });

  it('keeps distinct stopped campaigns in one Universe descriptive and ineligible', () => {
    const f = fixture(); f.init(); f.campaign('baseline'); f.campaign('challenger');
    requestUniverseCampaignControl('baseline', 'stop', { root: f.root });
    requestUniverseCampaignControl('challenger', 'stop', { root: f.root });
    const before = snapshot(f.outer);
    const value = f.read();
    expect(value).toMatchObject({ sourceState: 'healthy', matching: { comparable: false },
      baseline: { campaignState: 'stopped', rates: { improvementsPerMillionTokens: null } }, challenger: { campaignState: 'stopped' } });
    expect(snapshot(f.outer)).toEqual(before);
  });

  it('does not inspect unrelated corrupt campaigns, Universes, or delivery ledgers', () => {
    const f = fixture(); f.pair(); f.init('other'); f.campaign('other', 'other');
    writeFileSync(join(f.root, 'campaigns', 'other', 'ledger', 'records', '00000000.json'), '{broken', { mode: 0o600 });
    writeFileSync(join(f.root, 'universes', 'other', 'ledger', 'records', 'manifest.json'), '{broken', { mode: 0o600 });
    expect(f.read().sourceState).toBe('healthy');
  });

  it.each(['campaign', 'universe'] as const)('degrades selected corrupt %s evidence without echoing private content', (kind) => {
    const f = fixture(); f.pair();
    const path = kind === 'campaign' ? join(f.root, 'campaigns', 'baseline', 'ledger', 'records', '00000000.json') :
      join(f.root, 'universes', 'baseline-universe', 'ledger', 'records', 'manifest.json');
    writeFileSync(path, '{private-response-secret', { mode: 0o600 });
    const value = f.read();
    expect(value).toMatchObject({ sourceState: 'degraded', baseline: { sourceState: 'degraded' }, challenger: { sourceState: 'healthy' }, matching: { comparable: false } });
    expect(JSON.stringify(value)).not.toContain('private-response-secret');
    expect(JSON.stringify(value)).not.toContain(f.outer);
  });

  it('distinguishes absent selected campaign from its missing pinned Universe', () => {
    const f = fixture(); f.init(); f.campaign('baseline');
    expect(f.read()).toMatchObject({ baseline: { sourceState: 'healthy' }, challenger: { sourceState: 'missing' } });
    renameSync(join(f.root, 'universes', 'baseline-universe'), join(f.outer, 'moved-universe'));
    expect(f.read()).toMatchObject({ baseline: { sourceState: 'degraded' } });
  });

  it.each(['root', 'campaign', 'universe'] as const)('rejects a symlinked selected %s without replacing it', (kind) => {
    const f = fixture(); f.pair();
    const target = kind === 'root' ? f.root : kind === 'campaign' ? join(f.root, 'campaigns', 'baseline') : join(f.root, 'universes', 'baseline-universe');
    const moved = join(f.outer, `real-${kind}`);
    renameSync(target, moved); symlinkSync(moved, target);
    const value = f.read();
    expect(value.sourceState).toBe('degraded');
    expect(value.matching.comparable).toBe(false);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('degrades a campaign that changes after its initial projection', () => {
    const f = fixture(); f.pair();
    const original = delivery.readUniverseDeliveries;
    let changed = false;
    vi.spyOn(delivery, 'readUniverseDeliveries').mockImplementation((id, options) => {
      if (!changed && id === 'baseline-universe') {
        changed = true;
        requestUniverseCampaignControl('baseline', 'stop', { root: f.root });
      }
      return original(id, options);
    });
    const value = f.read();
    expect(changed).toBe(true);
    expect(value).toMatchObject({ sourceState: 'degraded', baseline: { sourceState: 'degraded', campaignState: 'ready' }, matching: { comparable: false } });
    expect(delivery.readUniverseDeliveries).toHaveBeenCalledTimes(4);
  });

  it('degrades delivery verification drift without exposing its private error', () => {
    const f = fixture(); f.pair();
    const original = delivery.readUniverseDeliveries;
    let count = 0;
    vi.spyOn(delivery, 'readUniverseDeliveries').mockImplementation((id, options) => {
      count++;
      return count === 3 ? { deliveries: [], sourceState: 'degraded', reasons: ['private-Git-output'] } : original(id, options);
    });
    const value = f.read();
    expect(value).toMatchObject({ sourceState: 'degraded', baseline: { sourceState: 'degraded' } });
    expect(JSON.stringify(value)).not.toContain('private-Git-output');
  });

  it('withdraws initially positive delivery verification when the second observation drifts', () => {
    const f = fixture(); f.pair();
    const directory = join(f.root, 'universes', 'baseline-universe');
    const campaignDirectory = join(f.root, 'campaigns', 'baseline');
    const record = manifestRecord(directory);
    const campaign = readUniverseCampaign('baseline', { root: f.root });
    const run = newRun(record, 1);
    run.campaign = { id: 'baseline', ordinal: 1, definitionDigest: campaign.definitionDigest };
    appendCampaignEvent(campaignDirectory, { kind: 'started', at: run.startedAt,
      deadlineAt: new Date(Date.parse(run.startedAt) + campaign.definition.budget.maxDurationMs).toISOString(),
      owner: { pid: process.pid, startRef: 'reader-fixture-owner' } });
    appendCampaignEvent(campaignDirectory, { kind: 'step', at: run.startedAt, ordinal: 1, runId: run.id,
      generation: 1, variantIds: ['never-run'], reservedModelRequests: 0 });
    appendRecord(directory, { id: `${run.id}.start`, kind: 'start', run, ownerPid: process.pid, ownerStart: 'reader-fixture-owner' });
    const artifact = join(directory, 'artifacts', run.id, 'trial');
    mkdirSync(join(directory, 'artifacts', run.id), { recursive: true, mode: 0o700 });
    copyArtifact(record.seedArtifact.path, artifact);
    writeFileSync(join(artifact, 'recorded-fixture.txt'), 'Only a ledger fixture; no candidate or evaluator executed.\n');
    const trial: UniverseTrial = { id: 'trial', variantId: 'never-run', niche: 'quality', parentTrialId: null,
      status: 'passed', score: 1, metrics: {}, artifact: { path: artifact, digest: artifactDigest(artifact), revision: record.manifest.seed.revision },
      durationMs: 1, delta: null, selected: false };
    freezeArtifact(artifact);
    appendRecord(directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id, trial });
    Object.assign(run, { trials: [trial], status: 'completed', finishedAt: new Date(Date.parse(run.startedAt) + 1).toISOString(), durationMs: 1 });
    selectWinners(run, record.manifest, []);
    appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
    appendCampaignEvent(campaignDirectory, { kind: 'settled', at: run.finishedAt!, state: 'completed', reason: 'Recorded test fixture' });
    const receipt: delivery.UniverseDeliveryReceipt = { schemaVersion: 1, id: 'd'.repeat(64), universeId: 'baseline-universe',
      runId: run.id, trialId: trial.id, niche: trial.niche, manifestDigest: run.manifestDigest, comparatorDigest: run.comparatorDigest,
      artifactDigest: trial.artifact!.digest, repo: f.repo, branch: 'codex/recorded-fixture', baseCommit: record.manifest.seed.revision,
      commit: 'c'.repeat(40), tree: 'e'.repeat(40), changedFiles: ['recorded-fixture.txt'], status: 'delivered',
      createdAt: run.finishedAt!, completedAt: run.finishedAt! };
    const original = delivery.readUniverseDeliveries;
    let drift = false;
    let observations = 0;
    vi.spyOn(delivery, 'readUniverseDeliveries').mockImplementation((id, options) => {
      if (id !== 'baseline-universe') return original(id, options);
      observations++;
      return { deliveries: [receipt], sourceState: drift && observations === 2 ? 'degraded' : 'healthy',
        reasons: drift && observations === 2 ? ['private branch drift'] : [] };
    });
    // Prove the initial positive receipt is attributed rather than ignored.
    expect(f.read().baseline.counts).toMatchObject({ verifiedDeliveryBranches: 1, distinctDeliveredArtifacts: 1 });
    drift = true; observations = 0;
    const changed = f.read();
    expect(changed.baseline).toMatchObject({ sourceState: 'degraded',
      counts: { verifiedDeliveryBranches: null, distinctDeliveredArtifacts: null }, usage: { complete: false, reportedTokens: null } });
    expect(changed.baseline.reasons).toContain('source-changed-during-sampling');
    expect(changed.matching.comparable).toBe(false);
    expect(JSON.stringify(changed)).not.toContain('private branch drift');
  });
});
