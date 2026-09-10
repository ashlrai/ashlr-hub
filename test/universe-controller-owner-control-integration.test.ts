import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview,
  type UniverseCampaignSummary, type UniverseManifest } from '../src/core/universe/index.js';
import type { UniversePortfolioControllerReport } from '../src/core/universe/portfolio-controller-types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const children = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();
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
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function snapshot(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? { mode: stat.mode, entries: Object.fromEntries(readdirSync(path).sort()
    .map((name) => [name, snapshot(join(path, name))])) } : { mode: stat.mode, bytes: readFileSync(path).toString('base64') };
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-owner-control-'))); roots.push(base);
  const root = join(base, 'store'); const temp = join(base, 'tmp'); mkdirSync(temp, { mode: 0o700 });
  const seeds = new Map<string, unknown>();
  for (const name of ['a', 'b', 'c']) {
    const repo = join(base, `repo-${name}`); mkdirSync(repo, { mode: 0o700 });
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'worker.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
writeFileSync(join(process.env.TMPDIR,'worker-pid.json'),JSON.stringify(process.pid)+'\\n');
await new Promise(resolve=>setTimeout(resolve,Number(process.argv[2])));
writeFileSync('value.json',JSON.stringify(JSON.parse(readFileSync('value.json','utf8'))+1)+'\\n');`);
    writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>0,score:value,metrics:{value}}));`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
    git('-c', 'user.name=Owner Control Fixture', '-c', 'user.email=owner@example.invalid', 'commit', '-qm', 'fixed inert seed');
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${name}`, name: `Owner Control ${name}`,
      objective: 'Increase a bounded integer under independent measurement', seed: { repo, revision: git('rev-parse', 'HEAD') },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 45_000, trialTimeoutMs: 40_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the integer',
        command: [process.execPath, 'worker.mjs', name === 'a' ? '35000' : '0'] }] };
    initUniverse(manifest, { root });
    initUniverseCampaign({ schemaVersion: 1, id: `campaign-${name}`, universeId: manifest.id, feedback: false,
      budget: { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } }, { root });
    seeds.set(repo, snapshot(repo));
  }
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'owner-controller', maxParallel: 1, maxDurationMs: 60_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }, { campaignId: 'campaign-b', dependsOn: [] },
      { campaignId: 'campaign-c', dependsOn: ['campaign-a'] }] };
  const manifest = join(base, 'portfolio.json'); writeFileSync(manifest, JSON.stringify(definition), { mode: 0o600 });
  return { root, temp, manifest, definition, seeds };
}
type Fixture = ReturnType<typeof fixture>;

function launch(value: Fixture, command: 'controller' | 'pause' | 'stop') {
  const args = command === 'controller' ? ['run', '--manifest', value.manifest, '--root', value.root, '--json']
    : [command, 'campaign-a', '--root', value.root, '--json'];
  const source = command === 'controller'
    ? `const {cmdUniverseController}=await import('./src/cli/universe-controller.ts');process.exitCode=await cmdUniverseController(${JSON.stringify(args)});`
    : `const {cmdUniverseCampaign}=await import('./src/cli/universe-campaign.ts');process.exitCode=await cmdUniverseCampaign(${JSON.stringify(args)});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LC_ALL: 'C', TMPDIR: value.temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  let stdout = ''; let stderr = ''; let startError: string | null = null;
  const capture = (name: 'stdout' | 'stderr', chunk: Buffer): void => {
    const previous = name === 'stdout' ? stdout : stderr;
    if (Buffer.byteLength(previous) + chunk.length > 1_048_576) { child.kill('SIGTERM'); return; }
    if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout!.on('data', (chunk: Buffer) => capture('stdout', chunk));
  child.stderr!.on('data', (chunk: Buffer) => capture('stderr', chunk));
  child.once('error', (error) => { startError = error.message; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  children.set(child, closed);
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 45_000);
  const escalation = setTimeout(() => child.kill('SIGKILL'), 51_000);
  void closed.then(() => { clearTimeout(watchdog); clearTimeout(escalation); });
  return { child, closed, output: () => ({ stdout, stderr, startError }) };
}

async function waitForWorker(value: Fixture, owner: ReturnType<typeof launch>): Promise<number> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const scratch = join(value.root, 'universes', 'universe-a', 'scratch');
    if (existsSync(scratch)) {
      for (const run of readdirSync(scratch)) {
        const directory = join(scratch, run);
        if (!lstatSync(directory).isDirectory()) continue;
        for (const trial of readdirSync(directory)) {
          const marker = join(directory, trial, 'worker', 'worker-pid.json');
          if (!existsSync(marker)) continue;
          const bytes = readFileSync(marker, 'utf8');
          if (!/^[1-9][0-9]*\n$/.test(bytes)) continue;
          const pid = Number(bytes);
          expect(Number.isSafeInteger(pid)).toBe(true);
          process.kill(pid, 0);
          return pid;
        }
      }
    }
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw new Error(`Controller ended before worker startup: ${JSON.stringify(owner.output())}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Controller worker startup exceeded its fixture deadline: ${JSON.stringify(owner.output())}`);
}

async function result<T>(child: ReturnType<typeof launch>, code: number): Promise<T> {
  expect(await child.closed, JSON.stringify(child.output())).toEqual({ code, signal: null });
  expect(child.output().startError).toBeNull();
  return JSON.parse(child.output().stdout) as T;
}

function campaignEvents(value: Fixture, id: string): Array<Record<string, unknown>> {
  const records = join(value.root, 'campaigns', id, 'ledger', 'records');
  return readdirSync(records).sort().map((name) => JSON.parse(readFileSync(join(records, name), 'utf8')) as Record<string, unknown>);
}

// No API mocks, observer hooks or in-process AbortController: the operating CLI
// and the human's campaign-control CLI execute in distinct real Node processes.
describe.runIf(process.platform === 'darwin')('Universe cross-process campaign owner control', () => {
  it.each(['pause', 'stop'] as const)('acknowledges %s, drains A, completes independent B and keeps dependent C held across restart', async (action) => {
    const value = fixture();
    const controller = launch(value, 'controller');
    const worker = await waitForWorker(value, controller);
    const running = readUniverseCampaign('campaign-a', value);
    expect(running).toMatchObject({ state: 'running', owner: { pid: controller.child.pid }, progress: { attempts: 1 } });
    const control = launch(value, action);
    expect(control.child.pid).not.toBe(controller.child.pid);
    const requested = await result<UniverseCampaignSummary>(control, 0);
    expect(requested.sourceState).toBe('healthy');
    expect([`${action}-requested`, action === 'pause' ? 'paused' : 'stopped']).toContain(requested.state);
    const completed = await result<UniversePortfolioControllerReport>(controller, 1);
    expect(completed).toMatchObject({ sourceState: 'healthy', status: 'incomplete' });
    expect(completed.outcomes).toMatchObject([
      { campaignId: 'campaign-a', state: 'held', attempted: true, reasonCode: action === 'pause' ? 'owner-paused' : 'campaign-stopped' },
      { campaignId: 'campaign-b', state: 'completed', attempted: true },
      { campaignId: 'campaign-c', state: 'held', attempted: false, reasonCode: 'dependency-held' },
    ]);
    const held = readUniverseCampaign('campaign-a', value);
    expect(held).toMatchObject({ state: action === 'pause' ? 'paused' : 'stopped', owner: null,
      startedAt: running.startedAt, deadlineAt: running.deadlineAt, progress: { attempts: 1, reservedModelRequests: 0 } });
    const events = campaignEvents(value, 'campaign-a');
    expect(events.filter((event) => event.kind === 'started')).toHaveLength(1);
    const controlIndex = events.findIndex((event) => event.kind === 'control' && event.action === action);
    expect(controlIndex).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ kind: 'settled', state: held.state });
    expect(Number(events.at(-1)!.sequence)).toBeGreaterThan(Number(events[controlIndex]!.sequence));
    expect(() => process.kill(worker, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(1);
    expect(campaignEvents(value, 'campaign-b').filter((event) => event.kind === 'started')).toHaveLength(1);
    expect(campaignEvents(value, 'campaign-c').map((event) => event.kind)).toEqual(['created']);
    const overview = readUniverseOverview(value);
    expect(overview.sourceState).toBe('healthy');
    for (const universe of overview.universes) {
      expect(universe.activeRun).toBeNull();
      expect(universe.runs).toHaveLength(universe.manifest.id === 'universe-c' ? 0 : 1);
      expect(existsSync(join(value.root, 'universes', universe.manifest.id, '.execution.lock'))).toBe(false);
    }
    expect(existsSync(join(value.root, 'portfolios', value.definition.id, '.execution.lock'))).toBe(false);
    expect(existsSync(join(value.root, 'portfolios', value.definition.id, 'ledger', '.records.lock'))).toBe(false);
    for (const name of ['a', 'b', 'c']) {
      expect(existsSync(join(value.root, 'campaigns', `campaign-${name}`, '.control.lock'))).toBe(false);
      expect(existsSync(join(value.root, 'campaigns', `campaign-${name}`, 'ledger', '.records.lock'))).toBe(false);
    }
    const campaigns = snapshot(join(value.root, 'campaigns'));
    const universes = snapshot(join(value.root, 'universes'));
    const restarted = await result<UniversePortfolioControllerReport>(launch(value, 'controller'), 1);
    expect(restarted).toMatchObject({ sourceState: 'healthy', status: 'incomplete', createdAt: completed.createdAt, deadlineAt: completed.deadlineAt });
    expect(restarted.outcomes).toEqual(completed.outcomes);
    expect(snapshot(join(value.root, 'campaigns'))).toEqual(campaigns);
    expect(snapshot(join(value.root, 'universes'))).toEqual(universes);
    for (const [repo, before] of value.seeds) expect(snapshot(repo)).toEqual(before);
  });
});
