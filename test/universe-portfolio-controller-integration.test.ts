import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview,
  requestUniverseCampaignControl, runUniverseCampaign, type UniverseCampaignDefinition, type UniverseManifest } from '../src/core/universe/index.js';
import { readUniversePortfolioController, runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { manifestRecord, universePath } from '../src/core/universe/store.js';
import * as fixedEvaluator from '../src/core/universe/fixed-evaluator.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const path of scratch.splice(0)) { writable(path); rmSync(path, { recursive: true, force: true }); }
});

function fixture(specifications: Array<{ name: string; delay?: number; generations?: number }>) {
  // Observe real native evaluator invocations without replacing execution. Its
  // private scratch is intentionally removed after each trial by the runner.
  const evaluation = vi.spyOn(fixedEvaluator, 'runFixedUniverseEvaluator');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-controller-native-')));
  scratch.push(base);
  const root = join(base, 'store');
  const definitions: UniverseCampaignDefinition[] = [];
  const manifests: UniverseManifest[] = [];
  for (const specification of specifications) {
    const repo = join(base, `repo-${specification.name}`);
    mkdirSync(repo, { mode: 0o700 });
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'worker.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';
await new Promise(resolve=>setTimeout(resolve,Number(process.argv[2])));
writeFileSync('value.json',JSON.stringify(JSON.parse(readFileSync('value.json','utf8'))+1)+'\\n');`);
    writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>0,score:value,metrics:{value}}));`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
    git('-c', 'user.name=Controller Fixture', '-c', 'user.email=controller@example.invalid', 'commit', '-qm', 'fixed private seed');
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${specification.name}`, name: `Controller ${specification.name}`,
      objective: 'Increase a bounded integer under independent fixed measurement', seed: { repo, revision: git('rev-parse', 'HEAD') },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the integer',
        command: [process.execPath, 'worker.mjs', String(specification.delay ?? 0)] }] };
    initUniverse(manifest, { root }); manifests.push(manifest);
    const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: `campaign-${specification.name}`, universeId: manifest.id,
      feedback: false, budget: { maxGenerations: specification.generations ?? 1, maxDurationMs: 45_000,
        maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } };
    initUniverseCampaign(definition, { root }); definitions.push(definition);
  }
  const portfolio = (dependencies: Record<string, string[]> = {}, maxParallel = 2): UniversePortfolioDefinition => ({
    schemaVersion: 1, id: 'fixture-controller', maxParallel, maxDurationMs: 40_000,
    tasks: definitions.map((definition) => ({ campaignId: definition.id, dependsOn: dependencies[definition.id] ?? [] })),
  });
  return { root, definitions, manifests, portfolio, evaluation };
}

function files(root: string): Array<{ path: string; mode: number; modified: number; bytes: string }> {
  const result: Array<{ path: string; mode: number; modified: number; bytes: string }> = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else result.push({ path: relative(root, path), mode: stat.mode, modified: stat.mtimeMs, bytes: readFileSync(path).toString('base64') });
    }
  };
  walk(root); return result;
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Native controller fixture did not reach expected state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Real private records, Git seeds, workers and fixed evaluators under the macOS
// confinement lane. Reinvocation is process-level recovery, not an OS reboot or provider proof.
describe.runIf(process.platform === 'darwin')('Universe portfolio controller native acceptance', () => {
  it('runs a dependency join and replays durable completion without evaluator or campaign duplication', async () => {
    const value = fixture([{ name: 'a', delay: 200 }, { name: 'b', delay: 200 }, { name: 'c' }]);
    const definition = value.portfolio({ 'campaign-c': ['campaign-a', 'campaign-b'] });
    const result = await runUniversePortfolioController(definition, { root: value.root });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.outcomes.map((row) => row.state)).toEqual(['completed', 'completed', 'completed']);
    const campaigns = value.definitions.map((row) => readUniverseCampaign(row.id, value));
    expect(campaigns.every((row) => row.progress.attempts === 1 && row.progress.reservedModelRequests === 0)).toBe(true);
    const overview = readUniverseOverview(value);
    const [a, b, c] = ['a', 'b', 'c'].map((name) => overview.universes.find((row) => row.manifest.id === `universe-${name}`)!.runs[0]!);
    expect(Date.parse(c.startedAt)).toBeGreaterThanOrEqual(Math.max(Date.parse(a.finishedAt!), Date.parse(b.finishedAt!)));
    const measured = value.evaluation.mock.calls.length;
    expect(measured).toBe(3);
    const repeated = await runUniversePortfolioController(definition, { root: value.root });
    expect(repeated).toMatchObject({ status: 'completed', createdAt: result.createdAt, deadlineAt: result.deadlineAt });
    expect(value.definitions.map((row) => readUniverseCampaign(row.id, value))).toEqual(campaigns);
    expect(value.evaluation).toHaveBeenCalledTimes(measured);
    expect(readUniverseOverview(value).universes.map((row) => row.runs)).toEqual(overview.universes.map((row) => row.runs));
    const beforeRead = files(value.root);
    expect(readUniversePortfolioController(definition.id, { root: value.root }).status).toBe('completed');
    expect(files(value.root)).toEqual(beforeRead);
  });

  it('preserves paused work and its descendants while completing an independent campaign', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    const held = requestUniverseCampaignControl('campaign-a', 'pause', value);
    const definition = value.portfolio({ 'campaign-b': ['campaign-a'] });
    const result = await runUniversePortfolioController(definition, { root: value.root });
    expect(result.status).toBe('incomplete');
    expect(result.outcomes.find((row) => row.campaignId === 'campaign-a')).toMatchObject({ state: 'held', attempted: false });
    expect(readUniverseCampaign('campaign-a', value)).toEqual(held);
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(0);
    expect(readUniverseCampaign('campaign-c', value).progress.attempts).toBe(1);
    const before = value.definitions.map((row) => readUniverseCampaign(row.id, value));
    await runUniversePortfolioController(definition, { root: value.root });
    expect(value.definitions.map((row) => readUniverseCampaign(row.id, value))).toEqual(before);
  });

  it('drains cancellation and on restart runs only untouched independent work with the original deadline', async () => {
    const value = fixture([{ name: 'a', delay: 3500 }, { name: 'b' }, { name: 'c' }]);
    const definition = value.portfolio({ 'campaign-c': ['campaign-a'] }, 1);
    const controller = new AbortController();
    const pending = runUniversePortfolioController(definition, { root: value.root, signal: controller.signal });
    try { await until(() => readUniverseOverview(value).universes.some((row) => row.activeRun !== null)); }
    catch (error) { controller.abort(); await pending; throw error; }
    controller.abort();
    const first = await pending;
    expect(first.status).toBe('cancelled');
    const interrupted = readUniverseCampaign('campaign-a', value);
    expect(interrupted).toMatchObject({ state: 'paused', owner: null, progress: { attempts: 1, reservedModelRequests: 0 } });
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(0);
    expect(readUniverseCampaign('campaign-c', value).progress.attempts).toBe(0);
    const repeated = await runUniversePortfolioController(definition, { root: value.root });
    expect(repeated).toMatchObject({ status: 'incomplete', createdAt: first.createdAt, deadlineAt: first.deadlineAt });
    expect(readUniverseCampaign('campaign-a', value)).toEqual(interrupted);
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(1);
    expect(readUniverseCampaign('campaign-c', value).progress.attempts).toBe(0);
    expect(readUniverseOverview(value).universes.every((row) => row.activeRun === null)).toBe(true);
  });

  it('never renews the persisted controller time budget after expiry', async () => {
    const value = fixture([{ name: 'a', delay: 4000 }, { name: 'b' }]);
    const definition = { ...value.portfolio({}, 1), maxDurationMs: 750 };
    const first = await runUniversePortfolioController(definition, { root: value.root });
    expect(first.status, JSON.stringify(first)).toBe('timed-out');
    expect(Date.parse(first.deadlineAt!) - Date.parse(first.createdAt!)).toBe(750);
    const before = value.definitions.map((row) => readUniverseCampaign(row.id, value));
    const measured = value.evaluation.mock.calls.length;
    const repeated = await runUniversePortfolioController(definition, { root: value.root });
    expect(repeated).toMatchObject({ status: 'timed-out', createdAt: first.createdAt, deadlineAt: first.deadlineAt });
    expect(value.definitions.map((row) => readUniverseCampaign(row.id, value))).toEqual(before);
    expect(value.evaluation).toHaveBeenCalledTimes(measured);
  });

  it('refuses an altered definition instead of widening a persisted controller budget', async () => {
    const value = fixture([{ name: 'a' }]);
    const definition = value.portfolio();
    await runUniversePortfolioController(definition, { root: value.root });
    const before = files(value.root);
    await expect(runUniversePortfolioController({ ...definition, maxDurationMs: definition.maxDurationMs + 1 }, { root: value.root })).rejects.toThrow();
    expect(files(value.root)).toEqual(before);
  });

  it('reports missing status without creating controller records', () => {
    const value = fixture([{ name: 'a' }]);
    const before = files(value.root);
    expect(readUniversePortfolioController('not-enrolled', { root: value.root })).toMatchObject({ sourceState: 'missing', status: 'unavailable' });
    expect(files(value.root)).toEqual(before);
  });

  it('keeps a pre-cancelled fresh invocation entirely read-only', async () => {
    const value = fixture([{ name: 'a' }]);
    const before = files(value.root);
    const controller = new AbortController(); controller.abort();
    const result = await runUniversePortfolioController(value.portfolio(), { root: value.root, signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(files(value.root)).toEqual(before);
    expect(readUniverseCampaign('campaign-a', value).progress.attempts).toBe(0);
    expect(readUniversePortfolioController('fixture-controller', { root: value.root }).sourceState).toBe('missing');
  });

  it('holds a lost controller settlement without replaying an already-completed native campaign', async () => {
    const value = fixture([{ name: 'a' }]);
    const definition = value.portfolio();
    const first = await runUniversePortfolioController(definition, { root: value.root });
    expect(first.status).toBe('completed');
    const campaign = readUniverseCampaign('campaign-a', value);
    const measured = value.evaluation.mock.calls.length;
    const records = join(value.root, 'portfolios', definition.id, 'ledger', 'records');
    const names = readdirSync(records).sort();
    const settled = names.findIndex((name) => JSON.parse(readFileSync(join(records, name), 'utf8')).kind === 'settled');
    expect(settled).toBeGreaterThanOrEqual(0);
    // Remove only this private test ledger's final settlement suffix, simulating
    // loss after actual worker settlement but before controller receipt durability.
    for (const name of names.slice(settled)) rmSync(join(records, name));
    const observed = readUniversePortfolioController(definition.id, { root: value.root });
    expect(observed.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true, reasonCode: 'reconciliation-required' });
    const repeated = await runUniversePortfolioController(definition, { root: value.root });
    expect(repeated.status).not.toBe('completed');
    expect(repeated.deadlineAt).toBe(first.deadlineAt);
    expect(readUniverseCampaign('campaign-a', value)).toEqual(campaign);
    expect(value.evaluation).toHaveBeenCalledTimes(measured);
  });

  it('reports changed pinned seed evidence without repairing or rerunning it', async () => {
    const value = fixture([{ name: 'a' }]);
    const definition = value.portfolio();
    expect((await runUniversePortfolioController(definition, { root: value.root })).status).toBe('completed');
    const record = manifestRecord(universePath(value.root, 'universe-a'));
    const file = join(record.seedArtifact.path, 'value.json');
    chmodSync(file, 0o600); writeFileSync(file, '999\n');
    const before = files(value.root);
    expect(readUniversePortfolioController(definition.id, { root: value.root })).toMatchObject({ sourceState: 'degraded', status: 'unavailable' });
    expect(files(value.root)).toEqual(before);
    const measured = value.evaluation.mock.calls.length;
    const repeated = await runUniversePortfolioController(definition, { root: value.root });
    expect(repeated.status).toBe('unavailable');
    expect(value.evaluation).toHaveBeenCalledTimes(measured);
  });

  it('keeps a planned ancestor delivery gate through a pre-completed intermediate', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]);
    const intermediate = await runUniverseCampaign('campaign-b', value);
    expect(intermediate.state).toBe('completed');
    const definition = value.portfolio({ 'campaign-b': ['campaign-a'], 'campaign-c': ['campaign-b'] });
    const deliveryPlan = { schemaVersion: 1 as const, deliveries: [{ campaignId: 'campaign-a',
      branch: 'codex/controller-ancestor', baseCommit: value.manifests[0]!.seed.revision }] };
    // One generation establishes a measured baseline, not a strict improvement.
    // The planned branch is therefore withheld even though A's campaign completes.
    const result = await runUniversePortfolioController(definition, { root: value.root, deliveryPlan });
    expect(result.status).toBe('incomplete');
    expect(result.outcomes.find((row) => row.campaignId === 'campaign-a')).toMatchObject({ state: 'held', attempted: true });
    expect(result.outcomes.find((row) => row.campaignId === 'campaign-c')).toMatchObject({ state: 'held', attempted: false, reasonCode: 'dependency-held' });
    expect(readUniverseCampaign('campaign-b', value)).toEqual(intermediate);
    expect(readUniverseCampaign('campaign-c', value).progress.attempts).toBe(0);
    expect(readUniverseCampaign('campaign-d', value).progress.attempts).toBe(1);
  });

  it('delivers a strict measured improvement before dispatching dependent work and reuses that receipt', async () => {
    const value = fixture([{ name: 'a', generations: 2 }, { name: 'b' }]);
    const definition = value.portfolio({ 'campaign-b': ['campaign-a'] });
    const deliveryPlan = { schemaVersion: 1 as const, deliveries: [{ campaignId: 'campaign-a',
      branch: 'codex/controller-improvement', baseCommit: value.manifests[0]!.seed.revision }] };
    const result = await runUniversePortfolioController(definition, { root: value.root, deliveryPlan });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.outcomes[0]!.deliveryDigest).toMatch(/^[a-f0-9]{64}$/);
    const repo = value.manifests[0]!.seed.repo;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
    const commit = git('rev-parse', 'refs/heads/codex/controller-improvement');
    expect(git('show', `${commit}:value.json`)).toBe('2');
    expect(git('rev-parse', 'HEAD')).toBe(value.manifests[0]!.seed.revision);
    const records = join(value.root, 'portfolios', definition.id, 'ledger', 'records');
    const events = readdirSync(records).sort().map((name) => JSON.parse(readFileSync(join(records, name), 'utf8')));
    const deliveredAt = events.findIndex((event) => event.kind === 'settled' && event.outcome.campaignId === 'campaign-a');
    const downstreamAt = events.findIndex((event) => event.kind === 'intent' && event.campaignId === 'campaign-b');
    expect(deliveredAt).toBeGreaterThanOrEqual(0); expect(downstreamAt).toBeGreaterThan(deliveredAt);
    const campaigns = value.definitions.map((row) => readUniverseCampaign(row.id, value));
    const measured = value.evaluation.mock.calls.length;
    const repeated = await runUniversePortfolioController(definition, { root: value.root, deliveryPlan });
    expect(repeated).toMatchObject({ status: 'completed', deadlineAt: result.deadlineAt });
    expect(repeated.outcomes[0]!.deliveryDigest).toBe(result.outcomes[0]!.deliveryDigest);
    expect(git('rev-parse', 'refs/heads/codex/controller-improvement')).toBe(commit);
    expect(value.definitions.map((row) => readUniverseCampaign(row.id, value))).toEqual(campaigns);
    expect(value.evaluation).toHaveBeenCalledTimes(measured);
    git('update-ref', 'refs/heads/codex/controller-improvement', value.manifests[0]!.seed.revision, commit);
    expect(readUniversePortfolioController(definition.id, { root: value.root })).toMatchObject({ sourceState: 'degraded', status: 'unavailable' });
    expect((await runUniversePortfolioController(definition, { root: value.root, deliveryPlan })).status).toBe('unavailable');
    expect(git('rev-parse', 'refs/heads/codex/controller-improvement')).toBe(value.manifests[0]!.seed.revision);
    expect(value.definitions.map((row) => readUniverseCampaign(row.id, value))).toEqual(campaigns);
    expect(value.evaluation).toHaveBeenCalledTimes(measured);
  });
});
