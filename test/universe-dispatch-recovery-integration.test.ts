import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, type UniverseManifest } from '../src/core/universe/index.js';
import { readUniversePortfolioController, runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import * as controllerStore from '../src/core/universe/portfolio-controller-store.js';
import * as campaignDelivery from '../src/core/universe/campaign-delivery.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import { canonical } from '../src/core/universe/artifacts.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const scratch: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const path of scratch.splice(0)) { writable(path); rmSync(path, { recursive: true, force: true }); }
});

function fixture(delivery = false) {
  const measured = vi.spyOn(evaluator, 'runFixedUniverseEvaluator');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-dispatch-native-')));
  scratch.push(base);
  const root = join(base, 'store');
  const manifests: UniverseManifest[] = [];
  for (const name of ['a', 'b']) {
    const repo = join(base, `repo-${name}`);
    mkdirSync(repo, { mode: 0o700 });
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'worker.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';
writeFileSync('value.json',JSON.stringify(JSON.parse(readFileSync('value.json','utf8'))+1)+'\\n');`);
    writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>0,score:value,metrics:{value}}));`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
    git('-c', 'user.name=Recovery Fixture', '-c', 'user.email=recovery@example.invalid', 'commit', '-qm', 'fixed recovery seed');
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${name}`, name: `Recovery ${name}`,
      objective: 'Increase a bounded integer under independent fixed measurement', seed: { repo, revision: git('rev-parse', 'HEAD') },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the integer', command: [process.execPath, 'worker.mjs'] }] };
    initUniverse(manifest, { root }); manifests.push(manifest);
    initUniverseCampaign({ schemaVersion: 1, id: `campaign-${name}`, universeId: manifest.id, feedback: false,
      budget: { maxGenerations: delivery && name === 'a' ? 2 : 1, maxDurationMs: 45_000,
        maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } }, { root });
  }
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'recovery-controller', maxParallel: 1, maxDurationMs: 40_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }, { campaignId: 'campaign-b', dependsOn: ['campaign-a'] }] };
  const deliveryPlan = { schemaVersion: 1 as const, deliveries: [{ campaignId: 'campaign-a',
    branch: 'codex/recovery-native', baseCommit: manifests[0]!.seed.revision }] };
  return { root, definition, measured, manifests, options: { root, ...(delivery ? { deliveryPlan } : {}) } };
}

function loseNextSettlement(): void {
  const append = controllerStore.appendPortfolioControllerEvent;
  vi.spyOn(controllerStore, 'appendPortfolioControllerEvent').mockImplementation((directory, event) => {
    if (event.kind === 'settled' && event.outcome.campaignId === 'campaign-a') {
      throw new Error('Injected private fixture crash before controller settlement durability');
    }
    return append(directory, event);
  });
}

function ledger(root: string, id: string) {
  const directory = join(root, 'portfolios', id, 'ledger', 'records');
  return readdirSync(directory).sort().map((name) => ({ path: join(directory, name), text: readFileSync(join(directory, name), 'utf8') }));
}

async function completedButUnsettled(value: ReturnType<typeof fixture>) {
  loseNextSettlement();
  const first = await runUniversePortfolioController(value.definition, value.options);
  expect(first.status).not.toBe('completed');
  expect(readUniverseCampaign('campaign-a', value.options)).toMatchObject({ state: 'completed', owner: null });
  expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(0);
  vi.mocked(controllerStore.appendPortfolioControllerEvent).mockRestore();
  const before = ledger(value.root, value.definition.id);
  expect(readUniversePortfolioController(value.definition.id, value.options).outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
  expect(ledger(value.root, value.definition.id)).toEqual(before);
  return first;
}

// Native workers and evaluators are real; only the controller's final receipt
// write is fault-injected. This verifies dispatch attribution, not OS reboot durability.
describe.runIf(process.platform === 'darwin')('Universe exact-dispatch native recovery', () => {
  it('reconciles A and releases B once without repeating A evaluation or campaign execution', async () => {
    const value = fixture();
    const first = await completedButUnsettled(value);
    const completed = readUniverseCampaign('campaign-a', value.options);
    expect(value.measured).toHaveBeenCalledTimes(1);
    const recovered = await runUniversePortfolioController(value.definition, value.options);
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ status: 'completed', deadlineAt: first.deadlineAt, createdAt: first.createdAt });
    expect(readUniverseCampaign('campaign-a', value.options)).toEqual(completed);
    expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(1);
    expect(value.measured).toHaveBeenCalledTimes(2);
    expect((await runUniversePortfolioController(value.definition, value.options)).status).toBe('completed');
    expect(value.measured).toHaveBeenCalledTimes(2);
  });

  it('records proven completion after the original deadline but never dispatches B or renews time', async () => {
    const value = fixture();
    const first = await completedButUnsettled(value);
    const completed = readUniverseCampaign('campaign-a', value.options);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.parse(first.deadlineAt!) + 1));
    const recovered = await runUniversePortfolioController(value.definition, value.options);
    expect(recovered).toMatchObject({ status: 'timed-out', deadlineAt: first.deadlineAt, createdAt: first.createdAt });
    expect(recovered.outcomes[0]).toMatchObject({ state: 'completed', attempted: true });
    expect(readUniverseCampaign('campaign-a', value.options)).toEqual(completed);
    expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(0);
    expect(value.measured).toHaveBeenCalledTimes(1);
  });

  it.each(['legacy', 'mismatched'] as const)('does not adopt %s controller attribution or rerun the campaign', async (mode) => {
    const value = fixture();
    await completedButUnsettled(value);
    const completed = readUniverseCampaign('campaign-a', value.options);
    const entry = ledger(value.root, value.definition.id).find((row) => JSON.parse(row.text).kind === 'intent')!;
    const event = JSON.parse(entry.text);
    expect(event.dispatchId).toEqual(expect.any(String));
    if (mode === 'legacy') delete event.dispatchId;
    else event.dispatchId = event.dispatchId === '11111111-1111-4111-8111-111111111111'
      ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111';
    chmodSync(entry.path, 0o600); writeFileSync(entry.path, `${canonical(event)}\n`);
    const recovered = await runUniversePortfolioController(value.definition, value.options);
    expect(recovered.status).not.toBe('completed');
    expect(recovered.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
    expect(readUniverseCampaign('campaign-a', value.options)).toEqual(completed);
    expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(0);
    expect(value.measured).toHaveBeenCalledTimes(1);
  });

  it('requires an existing planned delivery and does not create its branch during recovery', async () => {
    const value = fixture(true);
    const delivery = vi.spyOn(campaignDelivery, 'deliverCompletedUniverseCampaign').mockRejectedValue(new Error('Injected fixture crash before planned delivery'));
    await completedButUnsettled(value);
    delivery.mockRestore();
    const completed = readUniverseCampaign('campaign-a', value.options);
    const recovered = await runUniversePortfolioController(value.definition, value.options);
    expect(recovered.status).not.toBe('completed');
    expect(recovered.outcomes[0]!.state).not.toBe('completed');
    expect(readUniverseCampaign('campaign-a', value.options)).toEqual(completed);
    expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(0);
    expect(execFileSync('git', ['-C', value.manifests[0]!.seed.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/codex/recovery-native'], { encoding: 'utf8' }).trim()).toBe('');
    expect(value.measured).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('verifies existing planned delivery before recovery (branch drift: %s)', async (drift) => {
    const value = fixture(true);
    await completedButUnsettled(value);
    const repo = value.manifests[0]!.seed.repo;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
    const delivered = git('rev-parse', 'refs/heads/codex/recovery-native');
    if (drift) git('update-ref', 'refs/heads/codex/recovery-native', value.manifests[0]!.seed.revision, delivered);
    const before = git('rev-parse', 'refs/heads/codex/recovery-native');
    const completed = readUniverseCampaign('campaign-a', value.options);
    const recovered = await runUniversePortfolioController(value.definition, value.options);
    expect(recovered.status === 'completed', JSON.stringify(recovered)).toBe(!drift);
    expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(drift ? 0 : 1);
    expect(readUniverseCampaign('campaign-a', value.options)).toEqual(completed);
    expect(git('rev-parse', 'refs/heads/codex/recovery-native')).toBe(before);
    expect(value.measured).toHaveBeenCalledTimes(drift ? 2 : 3);
  });
});
