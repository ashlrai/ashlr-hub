import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseDeliveries, readUniverseOverview,
  runUniverseCampaign, type UniverseManifest } from '../src/core/universe/index.js';
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

function fixture(firstGenerations = 2) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-portfolio-delivery-')));
  scratch.push(base);
  const root = join(base, 'store');
  const repositories = new Map<string, { repo: string; revision: string; git: (...args: string[]) => string }>();
  for (const id of ['a', 'b']) {
    const repo = join(base, `repo-${id}`); mkdirSync(repo, { mode: 0o700 });
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'worker.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';
const next=JSON.parse(readFileSync('value.json','utf8'))+1;
writeFileSync('value.json',JSON.stringify(next)+'\\n');`);
    writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>0,score:value,metrics:{value}}));`);
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
    git('-c', 'user.name=Portfolio Fixture', '-c', 'user.email=portfolio@example.invalid', 'commit', '-qm', 'private fixture');
    const revision = git('rev-parse', 'HEAD'); repositories.set(id, { repo, revision, git });
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${id}`, name: `Local delivery ${id}`,
      objective: 'Deliver a strictly improved integer after fixed independent evaluation', seed: { repo, revision },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the measured integer', command: [process.execPath, 'worker.mjs'] }] };
    initUniverse(manifest, { root });
    initUniverseCampaign({ schemaVersion: 1, id: `campaign-${id}`, universeId: manifest.id, feedback: false,
      budget: { maxGenerations: id === 'a' ? firstGenerations : 2, maxDurationMs: 60_000,
        maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } }, { root });
  }
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'delivery-fixture', maxParallel: 2, maxDurationMs: 60_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }, { campaignId: 'campaign-b', dependsOn: ['campaign-a'] }] };
  const deliveryPlan = { schemaVersion: 1 as const, deliveries: ['a', 'b'].map((id) => ({
    campaignId: `campaign-${id}`, branch: `codex/delivered-${id}`, baseCommit: repositories.get(id)!.revision,
  })) };
  return { root, definition, deliveryPlan, repositories };
}

// Real Git refs, confined local candidates, fixed evaluators and immutable receipts.
// No provider account, model, network, Git remote, or resident service is involved.
describe.runIf(process.platform === 'darwin')('portfolio local delivery acceptance', () => {
  it('publishes the prerequisite receipt before its dependant starts and replays without new runs or commits', async () => {
    const f = fixture(); const original = campaignStore.appendCampaignEvent;
    let prerequisiteDeliveredAtStart = false;
    vi.spyOn(campaignStore, 'appendCampaignEvent').mockImplementation((directory, event, ...options) => {
      if (directory === campaignStore.campaignDirectory('campaign-b', f) && event.kind === 'started') {
        const receipt = readUniverseDeliveries('universe-a', f).deliveries[0];
        prerequisiteDeliveredAtStart = receipt?.status === 'delivered' &&
          f.repositories.get('a')!.git('rev-parse', 'refs/heads/codex/delivered-a') === receipt.commit;
      }
      return original(directory, event, ...options);
    });
    const result = await runUniversePortfolio(f.definition, { root: f.root, deliveryPlan: f.deliveryPlan });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(prerequisiteDeliveredAtStart).toBe(true);
    const beforeRuns = readUniverseOverview(f).universes.map((universe) => universe.runs);
    expect(beforeRuns.map((runs) => runs.length)).toEqual([2, 2]);
    const beforeDeliveries = ['a', 'b'].map((id) => readUniverseDeliveries(`universe-${id}`, f));
    for (const id of ['a', 'b']) {
      const repository = f.repositories.get(id)!;
      expect(repository.git('show', `refs/heads/codex/delivered-${id}:value.json`)).toBe('2');
      expect(repository.git('rev-list', '--count', `refs/heads/codex/delivered-${id}`)).toBe('2');
      expect(repository.git('rev-parse', 'HEAD')).toBe(repository.revision);
      expect(repository.git('status', '--porcelain')).toBe('');
      expect(readFileSync(join(repository.repo, 'value.json'), 'utf8')).toBe('0\n');
    }
    const replay = await runUniversePortfolio(f.definition, { root: f.root, deliveryPlan: f.deliveryPlan });
    expect(replay.status, JSON.stringify(replay)).toBe('completed');
    expect(replay.outcomes.every((outcome) => !outcome.attempted)).toBe(true);
    expect(readUniverseOverview(f).universes.map((universe) => universe.runs)).toEqual(beforeRuns);
    expect(['a', 'b'].map((id) => readUniverseDeliveries(`universe-${id}`, f))).toEqual(beforeDeliveries);
  }, 30_000);

  it('delivers an already completed campaign without rerunning it before starting its dependant', async () => {
    const f = fixture(); const before = await runUniverseCampaign('campaign-a', f);
    expect(before.state).toBe('completed');
    const result = await runUniversePortfolio(f.definition, { root: f.root, deliveryPlan: f.deliveryPlan });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'campaign-a')).toMatchObject({ attempted: false, status: 'completed' });
    expect(readUniverseCampaign('campaign-a', f)).toEqual(before);
    expect(readUniverseDeliveries('universe-a', f).deliveries).toMatchObject([{ status: 'delivered' }]);
    expect(readUniverseCampaign('campaign-b', f).state).toBe('completed');
  }, 30_000);

  it('withholds an admission-only artifact and never starts its dependant', async () => {
    const f = fixture(1);
    const result = await runUniversePortfolio(f.definition, { root: f.root, deliveryPlan: f.deliveryPlan });
    expect(result.status, JSON.stringify(result)).toBe('incomplete');
    expect(readUniverseCampaign('campaign-a', f).state).toBe('completed');
    expect(readUniverseCampaign('campaign-b', f).progress.attempts).toBe(0);
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'campaign-b')).toMatchObject({ status: 'blocked', attempted: false });
    expect(f.repositories.get('a')!.git('branch', '--list', 'codex/delivered-a')).toBe('');
    expect(readUniverseDeliveries('universe-a', f).deliveries).toEqual([]);
    const before = readUniverseCampaign('campaign-a', f);
    const retry = await runUniversePortfolio(f.definition, { root: f.root, deliveryPlan: f.deliveryPlan });
    expect(retry.status, JSON.stringify(retry)).toBe('incomplete');
    expect(retry.outcomes.find((outcome) => outcome.campaignId === 'campaign-a')).toMatchObject({
      attempted: false, status: 'blocked', delivery: { status: 'withheld', reason: 'no-strict-improvement' },
    });
    expect(readUniverseCampaign('campaign-a', f)).toEqual(before);
    expect(readUniverseCampaign('campaign-b', f).progress.attempts).toBe(0);
  }, 30_000);

  it('keeps legacy completion-only dependencies and creates no branches when no delivery plan is supplied', async () => {
    const f = fixture(1);
    const result = await runUniversePortfolio(f.definition, { root: f.root });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(readUniverseCampaign('campaign-b', f).state).toBe('completed');
    for (const id of ['a', 'b']) {
      expect(f.repositories.get(id)!.git('branch', '--list', `codex/delivered-${id}`)).toBe('');
      expect(readUniverseDeliveries(`universe-${id}`, f).deliveries).toEqual([]);
    }
  }, 30_000);

  it('preserves a conflicting owner branch and keeps descendants blocked when failed delivery is retried', async () => {
    const f = fixture(); const repository = f.repositories.get('a')!;
    repository.git('branch', 'codex/delivered-a', repository.revision);
    const result = await runUniversePortfolio(f.definition, { root: f.root, deliveryPlan: f.deliveryPlan });
    expect(result.status, JSON.stringify(result)).toBe('incomplete');
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'campaign-a')).toMatchObject({
      attempted: true, status: 'failed', delivery: { status: 'failed', reason: 'delivery-failed' },
    });
    const before = readUniverseCampaign('campaign-a', f);
    expect(before.state).toBe('completed');
    expect(readUniverseCampaign('campaign-b', f).progress.attempts).toBe(0);
    const retry = await runUniversePortfolio(f.definition, { root: f.root, deliveryPlan: f.deliveryPlan });
    expect(retry.status, JSON.stringify(retry)).toBe('incomplete');
    expect(retry.outcomes.find((outcome) => outcome.campaignId === 'campaign-a')).toMatchObject({
      attempted: false, status: 'failed', delivery: { status: 'failed', reason: 'delivery-failed' },
    });
    expect(readUniverseCampaign('campaign-a', f)).toEqual(before);
    expect(readUniverseCampaign('campaign-b', f).progress.attempts).toBe(0);
    expect(repository.git('rev-parse', 'refs/heads/codex/delivered-a')).toBe(repository.revision);
    expect(repository.git('status', '--porcelain')).toBe('');
  }, 30_000);
});
