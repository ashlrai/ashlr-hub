import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, requestUniverseCampaignControl,
  type UniverseManifest } from '../src/core/universe/index.js';
import { readUniversePortfolioController, runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { portfolioControllerDirectory, readPortfolioControllerEvents } from '../src/core/universe/portfolio-controller-store.js';
import { universePath } from '../src/core/universe/store.js';
import * as localLocks from '../src/core/fleet/local-store-lock.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
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

function fixture() {
  const measured = vi.spyOn(evaluator, 'runFixedUniverseEvaluator');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-controller-contention-')));
  scratch.push(base);
  const root = join(base, 'store'); const repo = join(base, 'repo');
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
  git('-c', 'user.name=Contention Fixture', '-c', 'user.email=contention@example.invalid', 'commit', '-qm', 'fixed private seed');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'universe-a', name: 'Native contention fixture',
    objective: 'Increase a bounded integer under independent fixed measurement', seed: { repo, revision: git('rev-parse', 'HEAD') },
    metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
    variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the integer', command: [process.execPath, 'worker.mjs'] }] };
  initUniverse(manifest, { root });
  initUniverseCampaign({ schemaVersion: 1, id: 'campaign-a', universeId: manifest.id, feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } }, { root });
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'contention-controller', maxParallel: 1, maxDurationMs: 40_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }] };
  const directory = universePath(root, manifest.id);
  const lockPath = join(directory, '.execution.lock');
  const acquired = localLocks.acquireLocalStoreLockWithOutcome(lockPath, 0, { anchorPath: directory, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new Error('Could not establish private fixture owner');
  // Observe real lock outcomes, not injected availability. The owner remains the
  // actual current process and is released only by this fixture's explicit handle.
  const acquire = localLocks.acquireLocalStoreLockWithOutcome;
  let contentions = 0;
  vi.spyOn(localLocks, 'acquireLocalStoreLockWithOutcome').mockImplementation((...args) => {
    const result = acquire(...args);
    if (args[0] === lockPath && result.state === 'contended') contentions++;
    return result;
  });
  let released = false;
  const release = (): void => { if (!released) { localLocks.releaseLocalStoreLock(acquired.lock); released = true; } };
  const events = () => readPortfolioControllerEvents(portfolioControllerDirectory(definition.id, { root }));
  return { root, definition, measured, events, release, contentions: () => contentions };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Native controller did not reach expected contention phase');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function expectUntouched(value: ReturnType<typeof fixture>): void {
  expect(value.events().filter((event) => event.kind === 'intent')).toHaveLength(0);
  expect(readUniverseCampaign('campaign-a', value)).toMatchObject({ progress: { attempts: 0, reservedModelRequests: 0 } });
  expect(readUniverseOverview(value).universes[0]!.runs).toHaveLength(0);
  expect(value.measured).not.toHaveBeenCalled();
}

// Actual private ownership, Git snapshots, command workers, and evaluators. These
// cases prove bounded local admission only; no provider or account is contacted.
describe.runIf(process.platform === 'darwin')('Universe controller native contention admission', () => {
  it('waits for a live owner to release before creating one intent and running exactly once', async () => {
    const value = fixture(); const abort = new AbortController();
    const pending = runUniversePortfolioController(value.definition, { root: value.root, signal: abort.signal });
    try {
      await until(() => value.contentions() >= 2);
      expectUntouched(value);
      const waiting = readUniversePortfolioController(value.definition.id, value);
      expect(waiting.outcomes[0]).toMatchObject({ state: 'pending', attempted: false });
      value.release();
      const result = await pending;
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed', deadlineAt: waiting.deadlineAt, createdAt: waiting.createdAt });
      expect(value.events().filter((event) => event.kind === 'intent')).toHaveLength(1);
      expect(readUniverseCampaign('campaign-a', value).progress.attempts).toBe(1);
      expect(value.measured).toHaveBeenCalledTimes(1);
      const runs = readUniverseOverview(value).universes[0]!.runs;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ generation: 1, campaign: { id: 'campaign-a', ordinal: 1 }, status: 'completed' });
      expect(runs[0]!.trials).toHaveLength(1);
      expect((await runUniversePortfolioController(value.definition, value)).status).toBe('completed');
      expect(value.measured).toHaveBeenCalledTimes(1);
    } finally { abort.abort(); value.release(); await pending; }
  });

  it('exhausts the original deadline while owned without creating an intent or renewing it on restart', async () => {
    const value = fixture(); const abort = new AbortController();
    const pending = runUniversePortfolioController(value.definition, { root: value.root, signal: abort.signal });
    try {
      await until(() => value.contentions() >= 1);
      expectUntouched(value);
      const waiting = readUniversePortfolioController(value.definition.id, value);
      // Advance only Date after proven real contention. Actual wait timers and
      // owner handles remain live; this avoids a CPU-load-dependent short budget.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse(waiting.deadlineAt!) + 1);
      const result = await pending;
      expect(result).toMatchObject({ status: 'timed-out', deadlineAt: waiting.deadlineAt, createdAt: waiting.createdAt });
      expectUntouched(value);
      value.release();
      const restarted = await runUniversePortfolioController(value.definition, value);
      expect(restarted).toMatchObject({ status: 'timed-out', deadlineAt: waiting.deadlineAt, createdAt: waiting.createdAt });
      expectUntouched(value);
    } finally { abort.abort(); value.release(); await pending; }
  });

  it('cancels while waiting without dispatching and can later admit the still-pristine campaign', async () => {
    const value = fixture(); const abort = new AbortController();
    const pending = runUniversePortfolioController(value.definition, { root: value.root, signal: abort.signal });
    try {
      await until(() => value.contentions() >= 1);
      abort.abort();
      const cancelled = await pending;
      expect(cancelled.status).toBe('cancelled');
      expectUntouched(value);
      value.release();
      const restarted = await runUniversePortfolioController(value.definition, value);
      expect(restarted, JSON.stringify(restarted)).toMatchObject({ status: 'completed', deadlineAt: cancelled.deadlineAt, createdAt: cancelled.createdAt });
      expect(value.events().filter((event) => event.kind === 'intent')).toHaveLength(1);
      expect(value.measured).toHaveBeenCalledTimes(1);
    } finally { abort.abort(); value.release(); await pending; }
  });

  it('rejects changed campaign evidence while waiting instead of adopting an owner control', async () => {
    const value = fixture(); const abort = new AbortController();
    const pending = runUniversePortfolioController(value.definition, { root: value.root, signal: abort.signal });
    try {
      await until(() => value.contentions() >= 1);
      const held = requestUniverseCampaignControl('campaign-a', 'pause', value);
      const result = await pending;
      expect(result.status).toBe('unavailable');
      expect(result.reasons.some((reason) => reason.includes('evidence-changed'))).toBe(true);
      expectUntouched(value);
      expect(readUniverseCampaign('campaign-a', value)).toEqual(held);
      value.release();
      expect((await runUniversePortfolioController(value.definition, value)).status).toBe('unavailable');
      expectUntouched(value);
    } finally { abort.abort(); value.release(); await pending; }
  });
});
