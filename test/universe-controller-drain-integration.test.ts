import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, type UniverseManifest } from '../src/core/universe/index.js';
import type { UniversePortfolioControllerReport, UniversePortfolioControllerControl,
  UniversePortfolioControllerControlReceipt } from '../src/core/universe/portfolio-controller-types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const children = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();
const fixtureGates = new Set<string>();
const observedWorkerPids = new Set<number>();
afterEach(async () => {
  let gateFailure = false;
  // Release only gates constructed by this fixture. No persisted PID is ever
  // signalled; cancellation is sent only through our own ChildProcess handles.
  for (const path of fixtureGates) {
    try {
      // Successful trial settlement removes its scratch directory. Never
      // recreate that directory merely to release an already-exited worker.
      if (existsSync(dirname(path)) && !existsSync(path)) writeFileSync(path, 'release fixture for cleanup\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      // The runner may finish scratch cleanup between observation and open.
      // Worker death is checked independently below before root removal.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gateFailure = true;
    }
  }
  for (const [child, closed] of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 6_000);
    try { await closed; } finally { clearTimeout(escalation); }
  }
  children.clear();
  const remaining = new Set(observedWorkerPids);
  const deadline = performance.now() + 10_000;
  while (remaining.size) {
    for (const pid of remaining) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') remaining.delete(pid); }
    }
    if (!remaining.size || performance.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fixtureGates.clear(); observedWorkerPids.clear();
  if (remaining.size || gateFailure) {
    // Remove only registry entries: retain the actual files for inspection and
    // do not let a later test's teardown delete this failed fixture incidentally.
    const preserved = roots.splice(0);
    throw new Error(`Fixture cleanup could not prove worker exit or release its gates; retained scratch: ${preserved.join(', ')}`);
  }
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

function fixture(delivery = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-controller-drain-'))); roots.push(base);
  const root = join(base, 'store'); const temp = join(base, 'tmp'); mkdirSync(temp, { mode: 0o700 });
  const manifests: UniverseManifest[] = [];
  for (const name of ['a', 'b', 'c']) {
    const repo = join(base, `repo-${name}`); mkdirSync(repo, { mode: 0o700 });
    writeFileSync(join(repo, 'value.json'), '0\n');
    // The first A worker waits on a private scratch gate. This is fixture logic,
    // not a runtime hook: drain must leave it alive until the test releases it.
    writeFileSync(join(repo, 'worker.mjs'), `import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const value=JSON.parse(readFileSync('value.json','utf8'));
writeFileSync(join(process.env.TMPDIR,'worker-pid.json'),JSON.stringify(process.pid)+'\\n');
if(process.argv[2]==='hold'&&value===0){const deadline=performance.now()+25000;
while(!existsSync(join(process.env.TMPDIR,'allow-finish'))){if(performance.now()>deadline)throw new Error('Fixture release timed out');await new Promise(r=>setTimeout(r,25));}}
writeFileSync('value.json',JSON.stringify(value+1)+'\\n');`);
    writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>0,score:value,metrics:{value}}));`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
    git('-c', 'user.name=Drain Fixture', '-c', 'user.email=drain@example.invalid', 'commit', '-qm', 'fixed inert seed');
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${name}`, name: `Drain ${name}`,
      objective: 'Increase a bounded integer under independent measurement', seed: { repo, revision: git('rev-parse', 'HEAD') },
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 40_000, trialTimeoutMs: 30_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'increment', niche: 'value', hypothesis: 'Advance the integer', command: [process.execPath, 'worker.mjs', name === 'a' ? 'hold' : 'run'] }] };
    initUniverse(manifest, { root }); manifests.push(manifest);
    initUniverseCampaign({ schemaVersion: 1, id: `campaign-${name}`, universeId: manifest.id, feedback: false,
      budget: { maxGenerations: name === 'a' ? 2 : 1, maxDurationMs: 70_000, maxModelRequests: 0,
        maxStagnantGenerations: 2, maxReportedTokens: null } }, { root });
  }
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'drain-controller', maxParallel: 1, maxDurationMs: 90_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }, { campaignId: 'campaign-b', dependsOn: [] },
      { campaignId: 'campaign-c', dependsOn: ['campaign-a'] }] };
  const manifest = join(base, 'portfolio.json'); writeFileSync(manifest, JSON.stringify(definition), { mode: 0o600 });
  const deliveryPlan = join(base, 'delivery.json');
  writeFileSync(deliveryPlan, JSON.stringify({ schemaVersion: 1, deliveries: [{ campaignId: 'campaign-a',
    branch: 'codex/drain-delivery', baseCommit: manifests[0]!.seed.revision }] }), { mode: 0o600 });
  return { base, root, temp, definition, manifest, manifests, deliveryPlan: delivery ? deliveryPlan : null };
}
type Fixture = ReturnType<typeof fixture>;
type Receipt = UniversePortfolioControllerControlReceipt;
type Report = UniversePortfolioControllerReport & { control: UniversePortfolioControllerControl };

function launch(value: Fixture, command: 'run' | 'status' | 'drain' | 'resume', sequence?: number, gate = false) {
  if (gate) fixtureGates.add(join(value.base, 'release-intent'));
  const args = command === 'run' ? ['run', '--manifest', value.manifest,
    ...(value.deliveryPlan ? ['--delivery-plan', value.deliveryPlan] : []), '--root', value.root, '--json']
    : [command, value.definition.id, ...(sequence === undefined ? [] : ['--drain-sequence', String(sequence)]), '--root', value.root, '--json'];
  const hook = !gate ? '' : `
    import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
    const originalLink=fs.linkSync;let gated=false;
    fs.linkSync=function(existing,published){
      if(!gated&&String(published)===${JSON.stringify(join(value.root, 'portfolios', value.definition.id, '.control.lock'))}){
        const records=${JSON.stringify(join(value.root, 'portfolios', value.definition.id, 'ledger', 'records'))};
        if(fs.existsSync(records)){
          const events=fs.readdirSync(records).sort().map(name=>JSON.parse(fs.readFileSync(path.join(records,name),'utf8')));
          if(events.at(-1)?.kind==='observed'&&!events.some(event=>event.kind==='intent')){
            gated=true;fs.writeFileSync(${JSON.stringify(join(value.base, 'before-intent.json'))},JSON.stringify({pid:process.pid})+'\\n',{mode:0o600});
            const deadline=performance.now()+20000;
            while(!fs.existsSync(${JSON.stringify(join(value.base, 'release-intent'))})){
              if(performance.now()>deadline)throw new Error('Fixture pre-intent gate timed out');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
            }
          }
        }
      }
      return originalLink(existing,published);
    };syncBuiltinESMExports();`;
  const source = `${hook}
const {cmdUniverseController}=await import('./src/cli/universe-controller.ts');process.exitCode=await cmdUniverseController(${JSON.stringify(args)});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LC_ALL: 'C', TMPDIR: value.temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  let stdout = ''; let stderr = ''; let error: string | null = null;
  const capture = (name: 'stdout' | 'stderr', chunk: Buffer): void => {
    const previous = name === 'stdout' ? stdout : stderr;
    if (Buffer.byteLength(previous) + chunk.length > 1_048_576) { error = 'Fixture capture exceeded its byte limit'; child.kill('SIGTERM'); return; }
    if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout!.on('data', (chunk: Buffer) => capture('stdout', chunk));
  child.stderr!.on('data', (chunk: Buffer) => capture('stderr', chunk));
  child.once('error', (failure) => { error = failure.message; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  children.set(child, closed);
  const watchdog = setTimeout(() => { error = 'Fixture process exceeded its deadline'; child.kill('SIGTERM'); }, 55_000);
  const escalation = setTimeout(() => child.kill('SIGKILL'), 61_000);
  void closed.then(() => { clearTimeout(watchdog); clearTimeout(escalation); });
  return { child, closed, output: () => ({ stdout, stderr, error }) };
}

async function result<T>(child: ReturnType<typeof launch>, code: number): Promise<T> {
  expect(await child.closed, JSON.stringify(child.output())).toEqual({ code, signal: null });
  expect(child.output().error).toBeNull();
  return JSON.parse(child.output().stdout) as T;
}

async function until<T>(owner: ReturnType<typeof launch>, observe: () => T | null): Promise<T> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const value = observe();
    if (value !== null) return value;
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw new Error(`Fixture process ended before readiness: ${JSON.stringify(owner.output())}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture readiness exceeded its deadline: ${JSON.stringify(owner.output())}`);
}

function worker(value: Fixture): { pid: number; release: string } | null {
  const scratch = join(value.root, 'universes', 'universe-a', 'scratch');
  if (!existsSync(scratch)) return null;
  for (const run of readdirSync(scratch)) {
    const directory = join(scratch, run);
    if (!lstatSync(directory).isDirectory()) continue;
    for (const trial of readdirSync(directory)) {
      const marker = join(directory, trial, 'worker', 'worker-pid.json');
      if (!existsSync(marker)) continue;
      const bytes = readFileSync(marker, 'utf8');
      if (/^[1-9][0-9]*\n$/.test(bytes)) return { pid: Number(bytes), release: join(dirname(marker), 'allow-finish') };
    }
  }
  return null;
}

function events(value: Fixture): Array<Record<string, unknown>> {
  const records = join(value.root, 'portfolios', value.definition.id, 'ledger', 'records');
  return readdirSync(records).sort().map((name) => JSON.parse(readFileSync(join(records, name), 'utf8')) as Record<string, unknown>);
}

function expectReleased(value: Fixture): void {
  const controller = join(value.root, 'portfolios', value.definition.id);
  for (const relative of ['.execution.lock', '.control.lock', 'ledger/.records.lock']) expect(existsSync(join(controller, relative))).toBe(false);
  for (const name of ['a', 'b', 'c']) {
    expect(readUniverseCampaign(`campaign-${name}`, value).owner).toBeNull();
    expect(existsSync(join(value.root, 'universes', `universe-${name}`, '.execution.lock'))).toBe(false);
    expect(existsSync(join(value.root, 'campaigns', `campaign-${name}`, '.control.lock'))).toBe(false);
    expect(existsSync(join(value.root, 'campaigns', `campaign-${name}`, 'ledger', '.records.lock'))).toBe(false);
  }
}

describe.runIf(process.platform === 'darwin')('Universe durable drain across CLI processes', () => {
  it('finishes admitted work and delivery, preserves the queue across restart, and resumes only on explicit matching permission', async () => {
    const value = fixture();
    const owner = launch(value, 'run');
    const active = await until(owner, () => worker(value));
    expect(Number.isSafeInteger(active.pid) && active.pid > 0).toBe(true);
    expect(() => process.kill(active.pid, 0)).not.toThrow();
    observedWorkerPids.add(active.pid); fixtureGates.add(active.release);
    const initial = await result<Report>(launch(value, 'status'), 0);
    expect(initial.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
    const pending = ['b', 'c'].map((name) => snapshot(join(value.root, 'campaigns', `campaign-${name}`)));
    const request = await result<Receipt>(launch(value, 'drain'), 0);
    expect(request).toMatchObject({ schemaVersion: 1, controllerId: value.definition.id, action: 'drain', changed: true });
    const draining = await result<Report>(launch(value, 'status'), 0);
    expect(draining).toMatchObject({ status: 'draining', control: { mode: 'drain', sequence: request.sequence,
      requestedAt: request.requestedAt, acknowledgedAt: null } });
    const beforePrematureResume = events(value);
    const refused = await result<{ error: string }>(launch(value, 'resume', request.sequence), 1);
    expect(refused.error).toEqual(expect.any(String));
    expect(events(value)).toEqual(beforePrematureResume);
    expect(() => process.kill(active.pid, 0)).not.toThrow();
    expect(readUniverseCampaign('campaign-a', value).state).toBe('running');
    writeFileSync(active.release, 'finish admitted fixture\n', { mode: 0o600, flag: 'wx' });
    const drained = await result<Report>(owner, 1);
    expect(drained).toMatchObject({ status: 'drained', sourceState: 'healthy', createdAt: initial.createdAt,
      deadlineAt: initial.deadlineAt, control: { mode: 'drain', sequence: request.sequence, acknowledgedAt: expect.any(String) } });
    expect(Date.parse(drained.control.acknowledgedAt!)).toBeGreaterThanOrEqual(Date.parse(request.requestedAt));
    expect(drained.outcomes).toMatchObject([{ campaignId: 'campaign-a', state: 'completed', attempted: true, deliveryDigest: expect.any(String) },
      { campaignId: 'campaign-b', state: 'pending', attempted: false }, { campaignId: 'campaign-c', state: 'pending', attempted: false }]);
    expect(readUniverseCampaign('campaign-a', value)).toMatchObject({ state: 'completed', owner: null, progress: { attempts: 2 } });
    expect(() => process.kill(active.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expectReleased(value);
    expect(['b', 'c'].map((name) => snapshot(join(value.root, 'campaigns', `campaign-${name}`)))).toEqual(pending);
    expect(events(value).filter((event) => event.kind === 'intent').map((event) => event.campaignId)).toEqual(['campaign-a']);
    const repo = value.manifests[0]!.seed.repo;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
    const delivered = git('rev-parse', 'refs/heads/codex/drain-delivery');
    expect(git('show', `${delivered}:value.json`)).toBe('2');
    expect(git('rev-parse', 'HEAD')).toBe(value.manifests[0]!.seed.revision);
    const beforeRestart = snapshot(value.root);
    expect(await result<Report>(launch(value, 'run'), 1)).toMatchObject({ status: 'drained', deadlineAt: initial.deadlineAt, outcomes: drained.outcomes });
    expect(snapshot(value.root)).toEqual(beforeRestart);
    await result<{ error: string }>(launch(value, 'resume', request.sequence + 1), 1);
    expect(snapshot(value.root)).toEqual(beforeRestart);
    const campaigns = snapshot(join(value.root, 'campaigns'));
    const universes = snapshot(join(value.root, 'universes'));
    const resumed = await result<Receipt>(launch(value, 'resume', request.sequence), 0);
    expect(resumed).toMatchObject({ schemaVersion: 1, controllerId: value.definition.id, action: 'resume', changed: true });
    expect(resumed.sequence).toBeGreaterThan(request.sequence);
    expect(snapshot(join(value.root, 'campaigns'))).toEqual(campaigns);
    expect(snapshot(join(value.root, 'universes'))).toEqual(universes);
    const completedA = snapshot(join(value.root, 'campaigns', 'campaign-a'));
    const artifactsA = snapshot(join(value.root, 'universes', 'universe-a'));
    const finished = await result<Report>(launch(value, 'run'), 0);
    expect(finished).toMatchObject({ status: 'completed', sourceState: 'healthy', createdAt: initial.createdAt, deadlineAt: initial.deadlineAt });
    expect(snapshot(join(value.root, 'campaigns', 'campaign-a'))).toEqual(completedA);
    expect(snapshot(join(value.root, 'universes', 'universe-a'))).toEqual(artifactsA);
    expect(git('rev-parse', 'refs/heads/codex/drain-delivery')).toBe(delivered);
    for (const name of ['b', 'c']) expect(readUniverseCampaign(`campaign-${name}`, value)).toMatchObject({ state: 'completed', progress: { attempts: 1 } });
    expect(events(value).filter((event) => event.kind === 'intent').map((event) => event.campaignId)).toEqual(['campaign-a', 'campaign-b', 'campaign-c']);
    expect(readUniverseOverview(value).universes.every((universe) => universe.activeRun === null)).toBe(true);
    expectReleased(value);
  }, 90_000);

  it('orders a separate durable drain before the pending intent transaction without dispatching any worker', async () => {
    const value = fixture(false);
    const owner = launch(value, 'run', undefined, true);
    const release = join(value.base, 'release-intent');
    try {
      const marker = await until(owner, () => {
        const path = join(value.base, 'before-intent.json');
        if (!existsSync(path)) return null;
        const bytes = readFileSync(path, 'utf8');
        return bytes.endsWith('\n') ? JSON.parse(bytes) as { pid: number } : null;
      });
      expect(marker.pid).toBe(owner.child.pid);
      expect(existsSync(join(value.root, 'portfolios', value.definition.id, '.control.lock'))).toBe(false);
      expect(events(value).at(-1)!.kind).toBe('observed');
      expect(events(value).some((event) => event.kind === 'intent')).toBe(false);
      const campaignState = snapshot(join(value.root, 'campaigns'));
      const universeState = snapshot(join(value.root, 'universes'));
      const request = await result<Receipt>(launch(value, 'drain'), 0);
      expect(request.action).toBe('drain');
      expect(events(value).some((event) => event.kind === 'intent')).toBe(false);
      writeFileSync(release, 'release pre-intent fixture\n', { mode: 0o600, flag: 'wx' });
      const drained = await result<Report>(owner, 1);
      expect(drained).toMatchObject({ sourceState: 'healthy', status: 'drained', control: { mode: 'drain', sequence: request.sequence } });
      expect(drained.outcomes.every((outcome) => !outcome.attempted && outcome.state === 'pending')).toBe(true);
      expect(events(value).some((event) => event.kind === 'intent')).toBe(false);
      expect(snapshot(join(value.root, 'campaigns'))).toEqual(campaignState);
      expect(snapshot(join(value.root, 'universes'))).toEqual(universeState);
      expect(worker(value)).toBeNull();
      expectReleased(value);
    } finally {
      if (!existsSync(release)) writeFileSync(release, 'release failed fixture\n', { mode: 0o600, flag: 'wx' });
    }
  }, 45_000);
});
