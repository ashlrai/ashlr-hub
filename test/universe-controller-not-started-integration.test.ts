import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, readUniversePortfolioController } from '../src/core/universe/index.js';
import type { UniversePortfolioControllerReport } from '../src/core/universe/portfolio-controller-types.js';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const gates: string[] = [];
const children = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();

function tree(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map((name) => [name, tree(join(path, name))]))
    : readFileSync(path).toString('base64');
}

afterEach(async () => {
  // Only owned subprocess handles receive signals. Release our test-only
  // scheduling barriers so normal controller cancellation can finish cleanup.
  for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  for (const gate of gates.splice(0)) if (existsSync(dirname(gate)) && !existsSync(gate)) writeFileSync(gate, 'release\n', { mode: 0o600 });
  let uncertain = false;
  for (const [child, closed] of children) {
    const timer = setTimeout(() => { uncertain = true; child.kill('SIGKILL'); }, 6_000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  children.clear();
  if (uncertain) { const retained = roots.splice(0); throw new Error(`Cancellation cleanup uncertain; retained ${retained.join(', ')}`); }
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'controller-not-started-native-'))); roots.push(base);
  const root = join(base, 'store'); const repo = join(base, 'seed'); const temp = join(base, 'tmp');
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(temp, { mode: 0o700 });
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'worker.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('value.json','1\\n');\n");
  writeFileSync(join(repo, 'evaluate.mjs'), "import{readFileSync}from'node:fs';import{join}from'node:path';const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));console.log(JSON.stringify({passed:value>0,score:value,metrics:{value}}));\n");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
  git('-c', 'user.name=No-start Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'inert no-start seed');
  for (const name of ['a', 'b']) {
    initUniverse({ schemaVersion: 1, id: `universe-${name}`, name: 'No-start fixture', objective: 'Persist known no-start without executing work',
      seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 3_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'inert', niche: 'value', hypothesis: 'Increment once', command: [process.execPath, 'worker.mjs'] }] }, { root });
    initUniverseCampaign({ schemaVersion: 1, id: `campaign-${name}`, universeId: `universe-${name}`, feedback: false,
      budget: { maxGenerations: 1, maxDurationMs: 30_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
  }
  const definition = { schemaVersion: 1, id: 'not-started-controller', maxParallel: 1, maxDurationMs: 45_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }, { campaignId: 'campaign-b', dependsOn: ['campaign-a'] }] };
  const manifest = join(base, 'portfolio.json'); writeFileSync(manifest, JSON.stringify(definition), { mode: 0o600 });
  const directory = join(root, 'portfolios', definition.id); const release = join(base, 'release-call'); gates.push(release);
  return { base, root, repo, temp, manifest, directory, release, definition };
}
type Fixture = ReturnType<typeof fixture>;

function launch(value: Fixture, gate = false) {
  const hook = !gate ? '' : `import fs from'node:fs';import path from'node:path';
const original=Promise.resolve;let gated=false;Error.stackTraceLimit=40;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>fs.writeFileSync(${JSON.stringify(join(value.base, 'signal-observed'))},signal+'\\n'));
Promise.resolve=function(...args){
 if(!gated&&args.length===0&&new Error().stack?.includes('launch')){
  const directory=${JSON.stringify(join(value.directory, 'ledger/records'))};
  if(fs.existsSync(directory)){
   const records=fs.readdirSync(directory).sort().map(name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8')));
   if(records.at(-1)?.kind==='intent'&&records.at(-1)?.campaignId==='campaign-a'){
    gated=true;fs.writeFileSync(${JSON.stringify(join(value.base, 'before-call'))},JSON.stringify({pid:process.pid,sequence:records.at(-1).sequence})+'\\n');
    return new Promise((resolve,reject)=>{const end=performance.now()+20000;const timer=setInterval(()=>{
     if(fs.existsSync(${JSON.stringify(value.release)})){clearInterval(timer);resolve();}
     else if(performance.now()>end){clearInterval(timer);reject(new Error('No-start fixture gate expired'));}
    },25);});
   }
  }
 }return original.apply(this,args);
};`;
  // The asynchronous scheduling gate permits the real OS signal handler to run
  // before releasing the exact post-intent/pre-call continuation. No filesystem
  // publication or runner function is replaced; the scheduling barrier exists only in this fixture.
  const source = `${hook}
const{cmdUniverseController}=await import('./src/cli/universe-controller.ts');process.exitCode=await cmdUniverseController(${JSON.stringify(['run', '--manifest', value.manifest, '--root', value.root, '--json'])});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LC_ALL: 'C', TMPDIR: value.temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  let stdout = ''; let stderr = ''; let failure: string | null = null;
  for (const name of ['stdout', 'stderr'] as const) child[name]!.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 1_048_576) {
      failure = 'Capture limit exceeded'; child.kill('SIGKILL'); return;
    }
    if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  });
  child.once('error', () => { failure = 'Fixture process failed'; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  children.set(child, closed);
  const watchdog = setTimeout(() => { failure = 'Fixture watchdog'; child.kill('SIGTERM'); }, 45_000);
  const escalation = setTimeout(() => child.kill('SIGKILL'), 51_000);
  void closed.then(() => { clearTimeout(watchdog); clearTimeout(escalation); });
  return { child, closed, output: () => ({ stdout, stderr, failure }) };
}

async function until(owner: ReturnType<typeof launch>, predicate: () => boolean) {
  const deadline = performance.now() + 15_000;
  while (!predicate()) {
    if (performance.now() >= deadline || owner.child.exitCode !== null || owner.child.signalCode !== null) {
      throw new Error(`Fixture gate not reached: ${JSON.stringify(owner.output())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function events(value: Fixture): Array<Record<string, unknown>> {
  const records = join(value.directory, 'ledger/records');
  return readdirSync(records).sort().map((name) => JSON.parse(readFileSync(join(records, name), 'utf8')) as Record<string, unknown>);
}

describe.runIf(process.platform === 'darwin')('native controller known no-start cancellation', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('%s settles a durable intent before actual invocation and never replays it', async (signal) => {
    const value = fixture(); const campaigns = tree(join(value.root, 'campaigns')); const universes = tree(join(value.root, 'universes'));
    const owner = launch(value, true);
    await until(owner, () => existsSync(join(value.base, 'before-call')));
    expect(JSON.parse(readFileSync(join(value.base, 'before-call'), 'utf8')).pid).toBe(owner.child.pid);
    const before = readUniversePortfolioController(value.definition.id, { root: value.root });
    expect(before.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
    expect(events(value).filter((event) => event.kind === 'intent')).toHaveLength(1);
    expect(owner.child.kill(signal)).toBe(true);
    await until(owner, () => existsSync(join(value.base, 'signal-observed')));
    expect(readFileSync(join(value.base, 'signal-observed'), 'utf8')).toBe(`${signal}\n`);
    writeFileSync(value.release, 'release\n');
    expect(await owner.closed, JSON.stringify(owner.output())).toEqual({ code: 130, signal: null });
    expect(owner.output().failure).toBeNull();
    const report = JSON.parse(owner.output().stdout) as UniversePortfolioControllerReport;
    expect(report).toMatchObject({ status: 'cancelled', sourceState: 'healthy', createdAt: before.createdAt, deadlineAt: before.deadlineAt,
      outcomes: [{ campaignId: 'campaign-a', state: 'held', attempted: true, reasonCode: 'dispatch-not-started' },
        { campaignId: 'campaign-b', state: 'held', attempted: false, reasonCode: 'dependency-held' }] });
    expect(events(value).filter((event) => event.kind === 'settled')).toHaveLength(1);
    expect(tree(join(value.root, 'campaigns'))).toEqual(campaigns); expect(tree(join(value.root, 'universes'))).toEqual(universes);
    for (const id of ['campaign-a', 'campaign-b']) expect(readUniverseCampaign(id, { root: value.root })).toMatchObject({ state: 'ready', owner: null,
      progress: { attempts: 0, reservedModelRequests: 0 } });
    for (const row of readUniverseOverview({ root: value.root }).universes) expect(row.runs).toEqual([]);
    const restarted = launch(value);
    expect(await restarted.closed, JSON.stringify(restarted.output())).toEqual({ code: 1, signal: null });
    expect(JSON.parse(restarted.output().stdout)).toMatchObject({ status: 'incomplete', createdAt: before.createdAt,
      deadlineAt: before.deadlineAt, outcomes: report.outcomes });
    expect(events(value).filter((event) => event.kind === 'intent')).toHaveLength(1);
    expect(events(value).filter((event) => event.kind === 'settled')).toHaveLength(1);
    expect(tree(join(value.root, 'campaigns'))).toEqual(campaigns); expect(tree(join(value.root, 'universes'))).toEqual(universes);
    for (const lock of [join(value.directory, '.control.lock'), join(value.directory, '.execution.lock'), join(value.directory, 'ledger/.records.lock'),
      join(value.root, 'universes/universe-a/.execution.lock')]) expect(existsSync(lock)).toBe(false);
  }, 60_000);
});
