import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, type UniverseManifest } from '../src/core/universe/index.js';
import { readUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { readUniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniversePortfolioControllerReport } from '../src/core/universe/portfolio-controller-types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const scratch: string[] = [];
const children = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();
const project = dirname(dirname(fileURLToPath(import.meta.url)));

afterEach(async () => {
  for (const [child, closed] of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 6_000);
    try { await closed; } finally { clearTimeout(escalation); }
  }
  children.clear();
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const path of scratch.splice(0)) { writable(path); rmSync(path, { recursive: true, force: true }); }
});

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-controller-signal-'))); scratch.push(base);
  const root = join(base, 'store');
  const temp = join(base, 'tmp'); mkdirSync(temp, { mode: 0o700 });
  const seeds = new Map<string, unknown>();
  for (const name of ['a', 'b']) {
    const repo = join(base, `repo-${name}`); mkdirSync(repo, { mode: 0o700 });
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'worker.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
writeFileSync(join(process.env.TMPDIR,'worker-pid.json'),JSON.stringify(process.pid)+'\\n');
await new Promise(resolve=>setTimeout(resolve,10000));
writeFileSync('value.json',JSON.stringify(JSON.parse(readFileSync('value.json','utf8'))+1)+'\\n');`);
    writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>0,score:value,metrics:{value}}));`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
    git('-c', 'user.name=Signal Fixture', '-c', 'user.email=signal@example.invalid', 'commit', '-qm', 'fixed signal seed');
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${name}`, name: `Signal ${name}`,
      objective: 'Exercise interruption of a bounded inert integer worker', seed: { repo, revision: git('rev-parse', 'HEAD') },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 25_000, trialTimeoutMs: 15_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the integer', command: [process.execPath, 'worker.mjs'] }] };
    initUniverse(manifest, { root });
    initUniverseCampaign({ schemaVersion: 1, id: `campaign-${name}`, universeId: manifest.id, feedback: false,
      budget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
    seeds.set(repo, snapshot(repo));
  }
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'signal-controller', maxParallel: 1, maxDurationMs: 60_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }, { campaignId: 'campaign-b', dependsOn: ['campaign-a'] }] };
  const manifestPath = join(base, 'portfolio.json');
  writeFileSync(manifestPath, JSON.stringify(definition), { mode: 0o600 });
  return { base, root, temp, definition, manifestPath, seeds };
}
type Fixture = ReturnType<typeof fixture>;

function snapshot(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? { mode: stat.mode, inode: stat.ino,
    entries: Object.fromEntries(readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))])) }
    : { mode: stat.mode, inode: stat.ino, bytes: readFileSync(path).toString('base64') };
}

function workerPids(value: Fixture, name: string): number[] {
  const directory = join(value.root, 'universes', `universe-${name}`, 'scratch');
  const found: number[] = [];
  if (!existsSync(directory)) return found;
  for (const run of readdirSync(directory)) {
    const runPath = join(directory, run);
    if (!lstatSync(runPath).isDirectory()) continue;
    for (const trial of readdirSync(runPath)) {
      const file = join(runPath, trial, 'worker', 'worker-pid.json');
      if (existsSync(file)) {
        // The worker publishes a tiny marker before waiting. Ignore a partial
        // write during polling; the next bounded observation must see full JSON.
        try {
          const marker = readFileSync(file, 'utf8');
          if (marker.endsWith('\n')) found.push(JSON.parse(marker) as number);
        } catch { /* Observe again. */ }
      }
    }
  }
  return found;
}

function launch(value: Fixture) {
  // This imports the real CLI handler, including its production signal listeners.
  // No fs hooks, provider adapters, or test-specific runtime flags are installed.
  const source = `const {cmdUniverseController}=await import('./src/cli/universe-controller.ts');
process.exitCode=await cmdUniverseController(${JSON.stringify(['run', '--manifest', value.manifestPath, '--root', value.root, '--json'])});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LC_ALL: 'C', TMPDIR: value.temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  let stdout = ''; let stderr = ''; let error: Error | undefined; let finished = false;
  child.stdout!.on('data', (buffer: Buffer) => {
    if (Buffer.byteLength(stdout) + buffer.length > 1_048_576) {
      error = new Error('Signal fixture stdout exceeded bounded capture'); child.kill('SIGKILL'); return;
    }
    stdout += buffer.toString();
  });
  child.stderr!.on('data', (buffer: Buffer) => {
    if (Buffer.byteLength(stderr) + buffer.length > 1_048_576) {
      error = new Error('Signal fixture stderr exceeded bounded capture'); child.kill('SIGKILL'); return;
    }
    stderr += buffer.toString();
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (failure) => { error = failure; });
    child.once('close', (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  children.set(child, closed);
  const terminate = setTimeout(() => { error = new Error('Signal fixture child exceeded its watchdog'); child.kill('SIGTERM'); }, 25_000);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  void closed.then(() => { clearTimeout(terminate); clearTimeout(timer); });
  return { child, closed, finished: () => finished, error: () => error,
    output: () => ({ stdout, stderr }), report: () => JSON.parse(stdout.trim()) as UniversePortfolioControllerReport };
}

async function waitForWorker(value: Fixture, runner: ReturnType<typeof launch>): Promise<number> {
  const deadline = performance.now() + 15_000;
  while (true) {
    const pids = workerPids(value, 'a');
    if (pids.length) {
      expect(pids).toHaveLength(1);
      expect(Number.isSafeInteger(pids[0]) && pids[0]! > 0).toBe(true);
      return pids[0]!;
    }
    if (runner.finished() || performance.now() >= deadline) throw new Error(`Worker did not start: ${JSON.stringify(runner.output())}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function verifyDrained(value: Fixture, pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  const overview = readUniverseOverview(value);
  expect(overview.sourceState, overview.reasons.join('; ')).toBe('healthy');
  for (const universe of overview.universes) {
    expect(universe.activeRun).toBeNull();
    expect(existsSync(join(value.root, 'universes', universe.manifest.id, '.execution.lock'))).toBe(false);
  }
  for (const id of ['campaign-a', 'campaign-b']) {
    expect(readUniverseCampaign(id, value).owner).toBeNull();
    const campaign = join(value.root, 'campaigns', id);
    expect(existsSync(join(campaign, '.control.lock'))).toBe(false);
    expect(existsSync(join(campaign, 'ledger', '.records.lock'))).toBe(false);
  }
  const controller = join(value.root, 'portfolios', value.definition.id);
  expect(existsSync(join(controller, '.execution.lock'))).toBe(false);
  expect(existsSync(join(controller, 'ledger', '.records.lock'))).toBe(false);
  for (const [repo, before] of value.seeds) expect(snapshot(repo)).toEqual(before);
}

describe.runIf(process.platform === 'darwin')('Universe controller CLI process signals', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('%s cancels and drains the real worker before CLI exit without replay on restart', async (signal) => {
    const value = fixture();
    const first = launch(value);
    const pid = await waitForWorker(value, first);
    expect(() => process.kill(pid, 0)).not.toThrow();
    const started = readUniversePortfolioController(value.definition.id, value);
    expect(started).toMatchObject({ sourceState: 'healthy', status: 'incomplete' });
    expect(started.outcomes).toMatchObject([{ state: 'in-flight', attempted: true }, { state: 'pending', attempted: false }]);
    expect(first.child.kill(signal)).toBe(true);
    expect(await first.closed, JSON.stringify(first.output())).toEqual({ code: 130, signal: null });
    expect(first.error()).toBeUndefined();
    const cancelled = first.report();
    expect(cancelled).toMatchObject({ status: 'cancelled', sourceState: 'healthy',
      createdAt: started.createdAt, deadlineAt: started.deadlineAt });
    const readiness = readUniverseCampaignReadiness('campaign-a', { root: value.root });
    expect(readiness).toMatchObject({ sourceState: 'healthy', disposition: 'recovery-required', reasonCode: 'run-incomplete', automaticAction: 'none' });
    expect(cancelled.outcomes).toMatchObject([
      { campaignId: 'campaign-a', state: 'held', attempted: true, reasonCode: readiness.reasonCode },
      { campaignId: 'campaign-b', state: 'held', attempted: false, reasonCode: 'dependency-held' },
    ]);
    expect(readUniverseCampaign('campaign-a', value)).toMatchObject({ state: 'paused', progress: { attempts: 1, reservedModelRequests: 0 } });
    expect(readUniverseCampaign('campaign-b', value)).toMatchObject({ state: 'ready', progress: { attempts: 0, reservedModelRequests: 0 } });
    expect(workerPids(value, 'b')).toEqual([]);
    verifyDrained(value, pid);

    // Successful cancellation may remove scratch, including the startup marker.
    // Compare the settled state; the durable ledgers below prove no new attempt.
    const remainingMarkers = workerPids(value, 'a');
    const campaignEvidence = snapshot(join(value.root, 'campaigns'));
    const universeEvidence = snapshot(join(value.root, 'universes'));
    const restarted = launch(value);
    expect(await restarted.closed, JSON.stringify(restarted.output())).toEqual({ code: 1, signal: null });
    expect(restarted.error()).toBeUndefined();
    expect(restarted.report()).toMatchObject({ sourceState: 'healthy', status: 'incomplete',
      createdAt: started.createdAt, deadlineAt: started.deadlineAt, outcomes: cancelled.outcomes });
    expect(snapshot(join(value.root, 'campaigns'))).toEqual(campaignEvidence);
    expect(snapshot(join(value.root, 'universes'))).toEqual(universeEvidence);
    expect(workerPids(value, 'a')).toEqual(remainingMarkers);
    expect(workerPids(value, 'b')).toEqual([]);
    verifyDrained(value, pid);
  }, 45_000);
});
