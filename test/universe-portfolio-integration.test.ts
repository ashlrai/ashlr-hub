import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview,
  requestUniverseCampaignControl, runUniverseCampaign,
  type UniverseCampaignDefinition, type UniverseManifest } from '../src/core/universe/index.js';
import { runUniversePortfolio } from '../src/core/universe/portfolio.js';
import * as campaignStore from '../src/core/universe/campaign-store.js';
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

function fixture(specifications: Array<{ name: string; delay?: number; rejected?: boolean }>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-portfolio-native-')));
  scratch.push(base);
  const root = join(base, 'store');
  const definitions: UniverseCampaignDefinition[] = [];
  const repositories: string[] = [];
  for (const specification of specifications) {
    const repo = join(base, `repo-${specification.name}`); repositories.push(repo);
    mkdirSync(repo, { mode: 0o700 });
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'worker.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';
await new Promise(resolve=>setTimeout(resolve,Number(process.argv[2])));
const next=process.argv[3]==='reject'?-1:JSON.parse(readFileSync('value.json','utf8'))+1;
writeFileSync('value.json',JSON.stringify(next)+'\\n');`);
    writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>0,score:value,metrics:{value}}));`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
    git('-c', 'user.name=Portfolio Fixture', '-c', 'user.email=portfolio@example.invalid', 'commit', '-qm', 'private pinned fixture');
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${specification.name}`, name: `Portfolio ${specification.name}`,
      objective: 'Measure a bounded integer edit with an independent fixed evaluator', seed: { repo, revision: git('rev-parse', 'HEAD') },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the measured integer',
        command: [process.execPath, 'worker.mjs', String(specification.delay ?? 0), specification.rejected ? 'reject' : 'advance'] }] };
    initUniverse(manifest, { root });
    const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: `campaign-${specification.name}`, universeId: manifest.id,
      feedback: false, budget: { maxGenerations: 1, maxDurationMs: 30_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } };
    initUniverseCampaign(definition, { root }); definitions.push(definition);
  }
  const portfolio = (dependencies: Record<string, string[]> = {}, maxParallel = 2): UniversePortfolioDefinition => ({
    schemaVersion: 1, id: 'fixture-portfolio', maxParallel, maxDurationMs: 20_000,
    tasks: definitions.map((definition) => ({ campaignId: definition.id, dependsOn: dependencies[definition.id] ?? [] })),
  });
  return { root, definitions, repositories, portfolio };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Native fixture did not reach the expected active state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Actual macOS candidate confinement, Git seeds and immutable campaign records.
// Other platforms need their own verified execution isolation before this proof applies.
describe.runIf(process.platform === 'darwin')('Universe portfolio native acceptance', () => {
  it('overlaps independent campaigns, honors a dependency join, and reruns without duplicate generations', async () => {
    const value = fixture([{ name: 'a', delay: 700 }, { name: 'b', delay: 700 }, { name: 'c' }]);
    const definition = value.portfolio({ 'campaign-c': ['campaign-a', 'campaign-b'] });
    const result = await runUniversePortfolio(definition, value);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.outcomes.every((outcome) => outcome.status === 'completed' && outcome.attempted)).toBe(true);
    const overview = readUniverseOverview(value);
    expect(overview.sourceState, overview.reasons.join('; ')).toBe('healthy');
    const [a, b, c] = ['a', 'b', 'c'].map((name) => overview.universes.find((universe) => universe.manifest.id === `universe-${name}`)!.runs[0]!);
    expect(Date.parse(a!.startedAt)).toBeLessThan(Date.parse(b!.finishedAt!));
    expect(Date.parse(b!.startedAt)).toBeLessThan(Date.parse(a!.finishedAt!));
    expect(Date.parse(c!.startedAt)).toBeGreaterThanOrEqual(Math.max(Date.parse(a!.finishedAt!), Date.parse(b!.finishedAt!)));
    for (const universe of overview.universes) {
      expect(universe.runs).toHaveLength(1); expect(universe.elites).toHaveLength(1);
      expect(universe.runs[0]!.tokensUsed).toBeNull(); expect(universe.runs[0]!.trials[0]!.generation).toBeUndefined();
      expect(readFileSync(join(universe.manifest.seed.repo, 'value.json'), 'utf8')).toBe('0\n');
    }
    const campaigns = value.definitions.map((campaign) => readUniverseCampaign(campaign.id, value));
    const rerun = await runUniversePortfolio(definition, value);
    expect(rerun.status).toBe('completed'); expect(rerun.outcomes.every((outcome) => !outcome.attempted)).toBe(true);
    expect(value.definitions.map((campaign) => readUniverseCampaign(campaign.id, value))).toEqual(campaigns);
    expect(readUniverseOverview(value).universes.map((universe) => universe.runs)).toEqual(overview.universes.map((universe) => universe.runs));
  });

  it('respects the invocation concurrency ceiling of one even for independent roots', async () => {
    const value = fixture([{ name: 'a', delay: 100 }, { name: 'b', delay: 100 }]);
    const result = await runUniversePortfolio(value.portfolio({}, 1), value);
    expect(result.status).toBe('completed');
    const universes = readUniverseOverview(value).universes;
    const a = universes.find((universe) => universe.manifest.id === 'universe-a')!.runs[0]!;
    const b = universes.find((universe) => universe.manifest.id === 'universe-b')!.runs[0]!;
    expect(Date.parse(b.startedAt)).toBeGreaterThanOrEqual(Date.parse(a.finishedAt!));
  });

  it('treats an already-completed rejected campaign as ordering evidence only and does not rerun it', async () => {
    const value = fixture([{ name: 'a', rejected: true }, { name: 'b' }]);
    const prior = await runUniverseCampaign('campaign-a', value);
    expect(prior.state).toBe('completed'); expect(prior.progress.admissions).toBe(0);
    const result = await runUniversePortfolio(value.portfolio({ 'campaign-b': ['campaign-a'] }), value);
    expect(result.status).toBe('completed');
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'campaign-a')).toMatchObject({ status: 'completed', attempted: false });
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'campaign-b')).toMatchObject({ status: 'completed', attempted: true });
    expect(readUniverseCampaign('campaign-a', value)).toEqual(prior);
    const a = readUniverseOverview(value).universes.find((universe) => universe.manifest.id === 'universe-a')!;
    expect(a.runs).toHaveLength(1); expect(a.elites).toEqual([]); expect(a.runs[0]!.trials[0]!.status).toBe('failed');
  });

  it('blocks descendants of a stopped campaign while an independent campaign continues', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    const stopped = requestUniverseCampaignControl('campaign-a', 'stop', value);
    const result = await runUniversePortfolio(value.portfolio({ 'campaign-b': ['campaign-a'] }), value);
    expect(result.status).toBe('incomplete');
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'campaign-b')).toMatchObject({ status: 'blocked', attempted: false });
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'campaign-c')).toMatchObject({ status: 'completed', attempted: true });
    expect(readUniverseCampaign('campaign-a', value)).toEqual(stopped);
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(0);
  });

  it('starts no campaigns when an enrolled private ledger is unreadable', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }]);
    const record = join(value.root, 'campaigns', 'campaign-b', 'ledger', 'records', '00000000.json');
    chmodSync(record, 0o600); writeFileSync(record, '{');
    const result = await runUniversePortfolio(value.portfolio(), value);
    expect(result.status).toBe('failed'); expect(result.plan.sourceState).toBe('degraded');
    expect(result.outcomes.every((outcome) => !outcome.attempted)).toBe(true);
    expect(readUniverseCampaign('campaign-a', value).progress.attempts).toBe(0);
    expect(readUniverseOverview(value).universes.every((universe) => universe.runs.length === 0)).toBe(true);
  });

  it('preserves a late owner pause committed immediately before the first campaign start', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }]);
    const append = campaignStore.appendCampaignEvent;
    let paused = false;
    vi.spyOn(campaignStore, 'appendCampaignEvent').mockImplementation((directory, input, ...options) => {
      if (!paused && input.kind === 'started') {
        paused = true;
        // Place a legitimate private control transaction in the precise gap
        // between admission observation and the start transaction's lock.
        requestUniverseCampaignControl('campaign-a', 'pause', value);
      }
      return append(directory, input, ...options);
    });
    const result = await runUniversePortfolio(value.portfolio({ 'campaign-b': ['campaign-a'] }), value);
    expect(paused).toBe(true);
    expect(result.status).not.toBe('completed');
    expect(readUniverseCampaign('campaign-a', value).state).toBe('paused');
    expect(readUniverseCampaign('campaign-a', value).progress.attempts).toBe(0);
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(0);
    expect(readUniverseOverview(value).universes.every((universe) => universe.runs.length === 0)).toBe(true);
  });

  it('awaits owned campaign cancellation and never dispatches waiting descendants afterward', async () => {
    const value = fixture([{ name: 'a', delay: 3000 }, { name: 'b', delay: 3000 }, { name: 'c' }]);
    const controller = new AbortController();
    const pending = runUniversePortfolio(value.portfolio({ 'campaign-c': ['campaign-a', 'campaign-b'] }), { ...value, signal: controller.signal });
    try {
      await until(() => readUniverseOverview(value).universes.filter((universe) => universe.activeRun !== null).length === 2);
    } catch (error) {
      controller.abort(); await pending; throw error;
    }
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'campaign-c')?.attempted).toBe(false);
    const overview = readUniverseOverview(value);
    expect(overview.universes.every((universe) => universe.activeRun === null)).toBe(true);
    expect(readUniverseCampaign('campaign-c', value).progress.attempts).toBe(0);
    for (const id of ['campaign-a', 'campaign-b']) expect(readUniverseCampaign(id, value).state).toBe('paused');
  });

  it('ends at the portfolio deadline only after active native campaigns have settled', async () => {
    const value = fixture([{ name: 'a', delay: 4000 }, { name: 'b', delay: 4000 }]);
    const definition = { ...value.portfolio(), maxDurationMs: 800 };
    const result = await runUniversePortfolio(definition, value);
    expect(result.status, JSON.stringify(result)).toBe('timed-out');
    expect(result.outcomes.some((outcome) => outcome.attempted)).toBe(true);
    expect(readUniverseOverview(value).universes.every((universe) => universe.activeRun === null)).toBe(true);
    for (const campaign of value.definitions) expect(readUniverseCampaign(campaign.id, value).state).not.toBe('running');
    expect(Date.parse(result.deadlineAt) - Date.parse(result.startedAt)).toBe(800);
  });
});
