/** Real ledgers and a confined local command; resource transports must never run. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, type UniverseManifest } from '../src/core/universe/index.js';
import { runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { portfolioControllerDirectory, readPortfolioControllerEvents } from '../src/core/universe/portfolio-controller-store.js';
import { superviseUniverseCampaigns } from '../src/core/universe/campaign-supervisor.js';
import * as worker from '../src/core/resources/worker.js';

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

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-admission-preflight-'))); scratch.push(base);
  const root = join(base, 'store'); const repo = join(base, 'seed'); const resourceRuntime = join(base, 'runtime.json');
  mkdirSync(repo, { mode: 0o700 });
  writeFileSync(resourceRuntime, '{}', { mode: 0o600 });
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'worker.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('value.json','1\\n');");
  writeFileSync(join(repo, 'evaluate.mjs'), "import {readFileSync} from 'node:fs';import {join} from 'node:path';const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));console.log(JSON.stringify({passed:value===1,score:value,metrics:{value}}));");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
  git('-c', 'user.name=Preflight Fixture', '-c', 'user.email=preflight@example.invalid', 'commit', '-qm', 'inert private seed');
  for (const resource of [true, false]) {
    const id = resource ? 'resource' : 'local';
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${id}`, name: `Preflight ${id}`,
      objective: 'Advance a local integer under a fixed evaluator', seed: { repo, revision: git('rev-parse', 'HEAD') },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'advance', niche: 'value', hypothesis: 'Advance the measured integer',
        ...(resource ? { generation: { kind: 'resource-pool' as const, poolId: 'inert-pool', poolDigest: 'a'.repeat(64),
          allowedWorkerIds: ['must-not-run'], files: ['value.json'], maxOutputTokens: 256 } }
          : { command: [process.execPath, 'worker.mjs'] }) }] };
    initUniverse(manifest, { root });
    initUniverseCampaign({ schemaVersion: 1, id: `campaign-${id}`, universeId: manifest.id, feedback: false,
      budget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: resource ? 1 : 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
  }
  const calls = vi.spyOn(worker, 'executeResourceWorker').mockImplementation(() => { throw new Error('Resource transport must remain inert'); });
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Provider must remain inert'); });
  const original = readUniverseCampaign('campaign-resource', { root });
  const untouched = () => {
    expect(readUniverseCampaign('campaign-resource', { root })).toEqual(original);
    expect(readUniverseCampaign('campaign-resource', { root }).progress).toMatchObject({ attempts: 0, reservedModelRequests: 0 });
    expect(readUniverseOverview({ root }).universes.find(row => row.manifest.id === 'universe-resource')!.runs).toHaveLength(0);
    expect(calls).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    expect(git('status', '--porcelain=v1')).toBe('');
  };
  return { root, resourceRuntime, untouched };
}

describe.runIf(process.platform === 'darwin')('resource preflight before real campaign admission', () => {
  it('keeps invalid resource work pending across controller restarts while independent local work completes once', async () => {
    const f = fixture();
    const definition = { schemaVersion: 1, id: 'preflight-controller', maxParallel: 2, maxDurationMs: 40_000,
      tasks: [{ campaignId: 'campaign-resource', dependsOn: [] }, { campaignId: 'campaign-local', dependsOn: [] }] };
    const options = { root: f.root, resourceRuntime: f.resourceRuntime };
    const first = await runUniversePortfolioController(definition, options);
    expect(first.status, JSON.stringify(first)).toBe('incomplete');
    expect(first.outcomes.find(row => row.campaignId === 'campaign-resource')).toMatchObject({ state: 'pending', attempted: false });
    expect(first.outcomes.find(row => row.campaignId === 'campaign-local')).toMatchObject({ state: 'completed', attempted: true });
    expect(first.reasons).toContain('campaign-resource:resource-runtime-invalid:runtime');
    f.untouched();
    const second = await runUniversePortfolioController(definition, options);
    expect(second).toMatchObject({ createdAt: first.createdAt, deadlineAt: first.deadlineAt, status: 'incomplete' });
    f.untouched();
    const intents = readPortfolioControllerEvents(portfolioControllerDirectory(definition.id, f)).filter(row => row.kind === 'intent');
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ campaignId: 'campaign-local' });
    expect(readUniverseCampaign('campaign-local', f).progress.attempts).toBe(1);
    expect(JSON.stringify(first)).not.toContain(f.resourceRuntime);
  });

  it('supervises independent local work without consuming the invalid resource campaign', async () => {
    const f = fixture();
    const result = await superviseUniverseCampaigns(['campaign-resource', 'campaign-local'], { root: f.root, resourceRuntime: f.resourceRuntime, maxDurationMs: 40_000, maxConcurrent: 2 });
    expect(result.status, JSON.stringify(result)).toBe('incomplete');
    expect(result.outcomes[0]).toMatchObject({ status: 'held', attempted: false, reasonCode: 'resource-runtime-invalid:runtime' });
    expect(result.outcomes[1]).toMatchObject({ status: 'completed', attempted: true });
    f.untouched();
    expect(readUniverseCampaign('campaign-local', f).progress.attempts).toBe(1);
    expect(JSON.stringify(result)).not.toContain(f.resourceRuntime);
  });
});
