/** Actual private campaign ledgers and macOS-confined fixtures; no model/provider calls. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, requestUniverseCampaignControl, runUniverseCampaign,
  type UniverseCampaignDefinition, type UniverseManifest } from '../src/core/universe/index.js';
import { superviseUniverseCampaigns } from '../src/core/universe/campaign-supervisor.js';
import { readUniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import { artifactDigest } from '../src/core/universe/artifacts.js';

const roots: string[] = [];
const WORKER = `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
writeFileSync(join(process.env.TMPDIR,'worker-pid.json'),JSON.stringify(process.pid));
await new Promise(resolve=>setTimeout(resolve,Number(process.argv[2])));
const value=JSON.parse(readFileSync('value.json','utf8'))+1;
writeFileSync('value.json',JSON.stringify(value)+'\\n');`;
const EVALUATOR = `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>0&&value<=2,score:value,metrics:{value}}));`;

afterEach(() => {
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function tree(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? { mode: stat.mode, entries: readdirSync(path).sort().map((name) => [name, tree(join(path, name))]) }
    : { mode: stat.mode, bytes: readFileSync(path).toString('base64') };
}

function fixture(specifications: Array<{ name: string; delay?: number; generations?: number }>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-supervision-native-'))); roots.push(base);
  const root = join(base, 'store'); const seeds = new Map<string, unknown>();
  const ids: string[] = [];
  for (const spec of specifications) {
    const repo = join(base, `repo-${spec.name}`); mkdirSync(repo, { mode: 0o700 });
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'worker.mjs'), WORKER); writeFileSync(join(repo, 'evaluate.mjs'), EVALUATOR);
    const git = (...args: string[]): string => execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args,
    ], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
    git('-c', 'user.name=Supervision Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed local fixture');
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${spec.name}`, name: `Supervision ${spec.name}`,
      objective: 'Increase a bounded integer with fixed independent measurement', seed: { repo, revision: git('rev-parse', 'HEAD') },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the integer',
        command: [process.execPath, 'worker.mjs', String(spec.delay ?? 0)] }] };
    initUniverse(manifest, { root });
    const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: `campaign-${spec.name}`, universeId: manifest.id,
      feedback: false, budget: { maxGenerations: spec.generations ?? 1, maxDurationMs: 30_000, maxModelRequests: 0,
        maxStagnantGenerations: 2, maxReportedTokens: null } };
    initUniverseCampaign(definition, { root }); ids.push(definition.id); seeds.set(repo, tree(repo));
  }
  return { base, root, ids, seeds };
}
type Fixture = ReturnType<typeof fixture>;

function workerPids(value: Fixture, name: string): number[] {
  const directory = join(value.root, 'universes', `universe-${name}`, 'scratch');
  const found: number[] = [];
  for (const run of readdirSync(directory)) {
    const runPath = join(directory, run);
    if (!lstatSync(runPath).isDirectory()) continue;
    for (const trial of readdirSync(runPath)) {
      const file = join(runPath, trial, 'worker', 'worker-pid.json');
      if (existsSync(file)) found.push(JSON.parse(readFileSync(file, 'utf8')) as number);
    }
  }
  return found;
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 8_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Supervision fixture did not reach its expected state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function verifySettled(value: Fixture, pids: number[] = []): void {
  const overview = readUniverseOverview(value);
  expect(overview.sourceState, overview.reasons.join('; ')).toBe('healthy');
  for (const universe of overview.universes) {
    expect(universe.activeRun).toBeNull();
    expect(existsSync(join(value.root, 'universes', universe.manifest.id, '.execution.lock'))).toBe(false);
  }
  for (const id of value.ids) expect(readUniverseCampaign(id, value).owner).toBeNull();
  for (const [repo, before] of value.seeds) expect(tree(repo)).toEqual(before);
  for (const pid of pids) {
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  }
}

describe.runIf(process.platform === 'darwin')('Universe foreground supervision with real campaign execution', () => {
  it('delivers two bounded command campaigns and reconciles a pending handoff without rerunning either worker', async () => {
    const value = fixture([{ name: 'left', generations: 2 }, { name: 'right', generations: 2 }]);
    const initial = readUniverseOverview(value);
    const deliveries = value.ids.map((campaignId) => {
      const universe = initial.universes.find((item) => item.manifest.id === campaignId.replace('campaign-', 'universe-'))!;
      return { campaignId, branch: `codex/${campaignId}`, baseCommit: universe.manifest.seed.revision };
    });
    const options = { root: value.root, maxDurationMs: 60_000, maxConcurrent: 2, pollIntervalMs: 50,
      deliveryPlan: { schemaVersion: 1 as const, deliveries } };
    const first = await superviseUniverseCampaigns(value.ids, options);
    expect(first.status, JSON.stringify(first)).toBe('completed');
    const after = readUniverseOverview(value);
    for (const outcome of first.outcomes) {
      expect(outcome).toMatchObject({ attempted: true, observedState: 'completed', delivery: { status: 'delivered' } });
      if (outcome.delivery?.status !== 'delivered') throw new Error('Expected local branch');
      const receipt = outcome.delivery.receipt;
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', receipt.repo, ...args], { encoding: 'utf8' }).trim();
      expect(git('show', `${receipt.commit}:value.json`)).toBe('2');
      expect(git('rev-parse', 'HEAD')).toBe(receipt.baseCommit);
      expect(readFileSync(join(receipt.repo, 'value.json'), 'utf8')).toBe('0\n');
    }
    const firstDelivery = first.outcomes[0]!.delivery!;
    if (firstDelivery.status !== 'delivered') throw new Error('Expected local branch');
    const receipt = firstDelivery.receipt;
    unlinkSync(join(value.root, 'universes', receipt.universeId, 'deliveries', 'records', `${receipt.id}.receipt.json`));
    const replay = await superviseUniverseCampaigns(value.ids, options);
    expect(replay.status).toBe('completed');
    expect(replay.outcomes.every((outcome) => !outcome.attempted && outcome.delivery?.status === 'delivered')).toBe(true);
    expect(replay.outcomes[0]!.delivery).toMatchObject({ receipt: { commit: receipt.commit, createdAt: receipt.createdAt } });
    expect(readUniverseOverview(value).universes.map((universe) => universe.runs)).toEqual(after.universes.map((universe) => universe.runs));
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', receipt.repo, 'update-ref', `refs/heads/${receipt.branch}`, receipt.baseCommit]);
    const drifted = await superviseUniverseCampaigns(value.ids, options);
    expect(drifted).toMatchObject({ status: 'incomplete', outcomes: [
      { attempted: false, observedState: 'completed', status: 'failed', delivery: { status: 'failed' } },
      { attempted: false, observedState: 'completed', status: 'completed', delivery: { status: 'delivered' } },
    ] });
    for (const campaignId of value.ids) expect(readUniverseCampaign(campaignId, value).state).toBe('completed');
  }, 30_000);

  it.each(['pause', 'stop'] as const)('preserves %s inserted by the running observer before actual admission', async (action) => {
    const value = fixture([{ name: 'a' }]);
    let controlled: unknown;
    const result = await superviseUniverseCampaigns(value.ids, { root: value.root, maxDurationMs: 3_000,
      onTransition: (event) => {
        if (event.status !== 'running') return;
        requestUniverseCampaignControl('campaign-a', action, value);
        controlled = tree(value.root);
      } });
    expect(controlled).toBeDefined();
    expect(result.status).toBe('incomplete');
    expect(result.outcomes[0]).toMatchObject({ status: 'failed', reasonCode: 'runner-failed', attempted: true });
    expect(tree(value.root)).toEqual(controlled);
    expect(readUniverseCampaign('campaign-a', value).progress.attempts).toBe(0);
    expect(readUniverseOverview(value).universes[0]!.runs).toEqual([]);
    verifySettled(value);
  }, 10_000);

  it('runs explicitly enrolled independent campaigns concurrently through both measured generations, then never replays terminal work', async () => {
    const value = fixture([{ name: 'a', delay: 600, generations: 2 }, { name: 'b', delay: 600, generations: 2 }]);
    const result = await superviseUniverseCampaigns(value.ids, { root: value.root, maxConcurrent: 2, maxDurationMs: 20_000, pollIntervalMs: 100 });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.outcomes.map((row) => [row.campaignId, row.status, row.attempted])).toEqual([
      ['campaign-a', 'completed', true], ['campaign-b', 'completed', true],
    ]);
    const overview = readUniverseOverview(value);
    const [a, b] = ['a', 'b'].map((name) => overview.universes.find((row) => row.manifest.id === `universe-${name}`)!);
    expect(Date.parse(a!.runs[0]!.startedAt)).toBeLessThan(Date.parse(b!.runs[0]!.finishedAt!));
    expect(Date.parse(b!.runs[0]!.startedAt)).toBeLessThan(Date.parse(a!.runs[0]!.finishedAt!));
    for (const universe of overview.universes) {
      expect(universe.runs.map((run) => run.trials[0]!.score)).toEqual([1, 2]);
      expect(universe.elites).toHaveLength(1);
      for (const run of universe.runs) {
        const trial = run.trials[0]!;
        expect(trial).toMatchObject({ status: 'passed', selected: true }); expect(trial.generation).toBeUndefined();
        expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
        expect(readFileSync(join(trial.artifact!.path, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
      }
    }
    for (const id of value.ids) {
      expect(readUniverseCampaign(id, value)).toMatchObject({ state: 'completed', progress: {
        attempts: 2, completedRuns: 2, reservedModelRequests: 0, admissions: 1, improvements: 1,
      } });
      expect(readUniverseCampaignReadiness(id, value)).toMatchObject({ disposition: 'terminal', automaticAction: 'none' });
    }
    const before = tree(value.root);
    const rerun = await superviseUniverseCampaigns(value.ids, { root: value.root, maxDurationMs: 2_000 });
    expect(rerun.status).toBe('completed'); expect(rerun.outcomes.every((row) => !row.attempted)).toBe(true);
    expect(tree(value.root)).toEqual(before); verifySettled(value);
  }, 30_000);

  it('enforces a concurrency ceiling of one without changing the campaigns own generation budgets', async () => {
    const value = fixture([{ name: 'a', delay: 200 }, { name: 'b', delay: 200 }]);
    const result = await superviseUniverseCampaigns(value.ids, { root: value.root, maxConcurrent: 1, maxDurationMs: 15_000, pollIntervalMs: 100 });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    const universes = readUniverseOverview(value).universes;
    const a = universes.find((row) => row.manifest.id === 'universe-a')!.runs[0]!;
    const b = universes.find((row) => row.manifest.id === 'universe-b')!.runs[0]!;
    expect(Date.parse(b.startedAt)).toBeGreaterThanOrEqual(Date.parse(a.finishedAt!));
    for (const id of value.ids) expect(readUniverseCampaign(id, value).progress.attempts).toBe(1);
    verifySettled(value);
  }, 20_000);

  it('serializes distinct fresh campaigns sharing one Universe even when invocation concurrency is two', async () => {
    const value = fixture([{ name: 'a', delay: 400 }]);
    const definition = readUniverseCampaign('campaign-a', value).definition;
    initUniverseCampaign({ ...definition, id: 'campaign-b' }, value); value.ids.push('campaign-b');
    const result = await superviseUniverseCampaigns(value.ids, { root: value.root, maxConcurrent: 2, maxDurationMs: 15_000, pollIntervalMs: 100 });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.outcomes.every((row) => row.attempted && row.status === 'completed')).toBe(true);
    const universe = readUniverseOverview(value).universes[0]!;
    expect(universe.runs).toHaveLength(2);
    const [a, b] = universe.runs;
    expect(a!.campaign?.id).toBe('campaign-a'); expect(b!.campaign?.id).toBe('campaign-b');
    expect(Date.parse(b!.startedAt)).toBeGreaterThanOrEqual(Date.parse(a!.finishedAt!));
    expect(universe.runs.map((run) => run.trials[0]!.score)).toEqual([1, 2]);
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(1);
    verifySettled(value);
  }, 20_000);

  it('preserves an existing owner pause and stop byte-for-byte without acknowledging or dispatching either', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }]);
    requestUniverseCampaignControl('campaign-a', 'pause', value); requestUniverseCampaignControl('campaign-b', 'stop', value);
    const before = tree(value.root);
    const result = await superviseUniverseCampaigns(value.ids, { root: value.root, maxDurationMs: 2_000 });
    expect(result.status).not.toBe('completed');
    expect(result.outcomes.every((row) => !row.attempted)).toBe(true);
    expect(tree(value.root)).toEqual(before);
    expect(readUniverseCampaignReadiness('campaign-a', value)).toMatchObject({ disposition: 'owner-held', automaticAction: 'none' });
    expect(readUniverseOverview(value).universes.every((row) => row.runs.length === 0)).toBe(true);
    verifySettled(value);
  }, 10_000);

  it('rechecks a queued campaign after an owner pauses it while the first actual worker is active', async () => {
    const value = fixture([{ name: 'a', delay: 1_200 }, { name: 'b' }]);
    const controller = new AbortController();
    const pending = superviseUniverseCampaigns(value.ids, { root: value.root, maxConcurrent: 1, maxDurationMs: 15_000,
      pollIntervalMs: 100, signal: controller.signal });
    let paused: unknown;
    try {
      await until(() => workerPids(value, 'a').length > 0);
      requestUniverseCampaignControl('campaign-b', 'pause', value);
      paused = tree(join(value.root, 'campaigns', 'campaign-b'));
    } catch (error) { controller.abort(); await pending; throw error; }
    const result = await pending;
    expect(result.status).not.toBe('completed');
    expect(result.outcomes.find((row) => row.campaignId === 'campaign-b')).toMatchObject({ attempted: false, status: 'held' });
    expect(readUniverseCampaign('campaign-a', value).state).toBe('completed');
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(0);
    expect(tree(join(value.root, 'campaigns', 'campaign-b'))).toEqual(paused);
    expect(readUniverseOverview(value).universes.find((row) => row.manifest.id === 'universe-b')!.runs).toEqual([]);
    verifySettled(value);
  }, 20_000);

  it('awaits actual owned-worker cancellation, leaves the queue untouched, and does not resume the interrupted campaign', async () => {
    const value = fixture([{ name: 'a', delay: 4_000 }, { name: 'b' }]);
    const untouched = tree(join(value.root, 'campaigns', 'campaign-b'));
    const controller = new AbortController(); let pids: number[] = [];
    const pending = superviseUniverseCampaigns(value.ids, { root: value.root, maxConcurrent: 1, maxDurationMs: 15_000,
      pollIntervalMs: 100, signal: controller.signal });
    try { await until(() => (pids = workerPids(value, 'a')).length > 0); }
    catch (error) { controller.abort(); await pending; throw error; }
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.outcomes.find((row) => row.campaignId === 'campaign-b')?.attempted).toBe(false);
    expect(readUniverseCampaign('campaign-a', value)).toMatchObject({ state: 'paused', progress: { attempts: 1 } });
    expect(tree(join(value.root, 'campaigns', 'campaign-b'))).toEqual(untouched);
    verifySettled(value, pids);
    const before = tree(value.root);
    await superviseUniverseCampaigns(['campaign-a'], { root: value.root, maxDurationMs: 1_000 });
    expect(tree(value.root)).toEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(tree(value.root)).toEqual(before); verifySettled(value, pids);
  }, 20_000);

  it('settles owned work before returning at its deadline and never dispatches the pending campaign afterward', async () => {
    const value = fixture([{ name: 'a', delay: 4_000 }, { name: 'b' }]);
    const untouched = tree(join(value.root, 'campaigns', 'campaign-b'));
    const result = await superviseUniverseCampaigns(value.ids, { root: value.root, maxConcurrent: 1, maxDurationMs: 1_000, pollIntervalMs: 100 });
    expect(result.status, JSON.stringify(result)).toBe('timed-out');
    expect(result.outcomes.find((row) => row.campaignId === 'campaign-b')?.attempted).toBe(false);
    expect(readUniverseCampaign('campaign-a', value).progress.attempts).toBe(1);
    expect(tree(join(value.root, 'campaigns', 'campaign-b'))).toEqual(untouched);
    verifySettled(value);
    const before = tree(value.root);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(tree(value.root)).toEqual(before);
  }, 10_000);

  it('makes a pre-cancelled invocation wholly read-only including its never-started queue', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }]);
    const controller = new AbortController(); controller.abort();
    const before = tree(value.root);
    const result = await superviseUniverseCampaigns(value.ids, { root: value.root, maxDurationMs: 2_000, signal: controller.signal });
    expect(result.status).toBe('cancelled'); expect(tree(value.root)).toEqual(before); verifySettled(value);
  }, 10_000);

  it('never cancels an independently owned worker when supervision itself is cancelled', async () => {
    const value = fixture([{ name: 'a', delay: 4_000 }]);
    const externalController = new AbortController(); const supervisorController = new AbortController();
    const external = runUniverseCampaign('campaign-a', { root: value.root, signal: externalController.signal });
    let pids: number[] = [];
    try {
      await until(() => (pids = workerPids(value, 'a')).length > 0);
      const before = tree(value.root);
      const result = await superviseUniverseCampaigns(value.ids, { root: value.root, maxDurationMs: 2_000,
        pollIntervalMs: 100, signal: supervisorController.signal,
        onTransition: (event) => { if (event.status === 'held') supervisorController.abort(); } });
      expect(result.status).toBe('cancelled'); expect(result.outcomes[0]?.attempted).toBe(false);
      expect(tree(value.root)).toEqual(before);
      expect(readUniverseCampaign('campaign-a', value).owner).not.toBeNull();
      for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
    } finally { externalController.abort(); await external; }
    verifySettled(value, pids);
  }, 15_000);
});
