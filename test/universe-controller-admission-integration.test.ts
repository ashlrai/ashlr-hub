import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview,
  requestUniverseCampaignControl } from '../src/core/universe/index.js';
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
  for (const gate of gates.splice(0)) if (existsSync(dirname(gate)) && !existsSync(gate)) writeFileSync(gate, 'release\n', { mode: 0o600 });
  for (const [child, closed] of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 6_000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  children.clear();
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'controller-admission-native-'))); roots.push(base);
  const root = join(base, 'store'); const repo = join(base, 'seed'); const temp = join(base, 'tmp');
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(temp, { mode: 0o700 });
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'worker.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('value.json','1\\n');\n");
  writeFileSync(join(repo, 'evaluate.mjs'), "import{readFileSync}from'node:fs';import{join}from'node:path';const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));console.log(JSON.stringify({passed:value>0,score:value,metrics:{value}}));\n");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', 'value.json', 'worker.mjs', 'evaluate.mjs');
  git('-c', 'user.name=Admission Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'inert admission seed');
  initUniverse({ schemaVersion: 1, id: 'universe-a', name: 'Admission fixture', objective: 'Prove current admission before dispatch',
    seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 3_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
    variants: [{ id: 'inert', niche: 'value', hypothesis: 'Increment once', command: [process.execPath, 'worker.mjs'] }] }, { root });
  initUniverseCampaign({ schemaVersion: 1, id: 'campaign-a', universeId: 'universe-a', feedback: false,
    budget: { maxGenerations: 2, maxDurationMs: 30_000, maxModelRequests: 0, maxStagnantGenerations: 2, maxReportedTokens: null } }, { root });
  const definition = { schemaVersion: 1, id: 'admission-controller', maxParallel: 1, maxDurationMs: 45_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }] };
  const manifest = join(base, 'portfolio.json'); writeFileSync(manifest, JSON.stringify(definition), { mode: 0o600 });
  const directory = join(root, 'portfolios', definition.id); const lock = join(directory, '.control.lock');
  const releaseAdmission = join(base, 'release-admission'); const releaseHolder = join(base, 'release-holder');
  const releaseRetry = join(base, 'release-retry');
  gates.push(releaseAdmission, releaseHolder, releaseRetry);
  return { base, root, repo, temp, manifest, directory, lock, releaseAdmission, releaseHolder, releaseRetry };
}
type Fixture = ReturnType<typeof fixture>;

function child(value: Fixture, source: string) {
  const processHandle = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LC_ALL: 'C', TMPDIR: value.temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  let stdout = ''; let stderr = ''; let failure: string | null = null;
  for (const name of ['stdout', 'stderr'] as const) processHandle[name]!.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 1_048_576) {
      failure = 'Capture limit exceeded'; processHandle.kill('SIGKILL'); return;
    }
    if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  });
  processHandle.once('error', () => { failure = 'Fixture process failed'; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    processHandle.once('close', (code, signal) => resolve({ code, signal }));
  });
  children.set(processHandle, closed);
  const watchdog = setTimeout(() => { failure = 'Fixture watchdog'; processHandle.kill('SIGTERM'); }, 45_000);
  const escalation = setTimeout(() => processHandle.kill('SIGKILL'), 51_000);
  void closed.then(() => { clearTimeout(watchdog); clearTimeout(escalation); });
  return { processHandle, closed, output: () => ({ stdout, stderr, failure }) };
}

async function until(owner: ReturnType<typeof child>, predicate: () => boolean) {
  const deadline = performance.now() + 15_000;
  while (!predicate()) {
    if (performance.now() >= deadline || owner.processHandle.exitCode !== null || owner.processHandle.signalCode !== null) {
      throw new Error(`Fixture gate not reached: ${JSON.stringify(owner.output())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function controller(value: Fixture) {
  // Test-only publication gate is outside the short lock. Stack discrimination
  // selects append, never refresh; the Universe lease proves final admission.
  const source = `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const link=fs.linkSync;const timeout=globalThis.setTimeout;let gated=false;let retryGated=false;Error.stackTraceLimit=40;
globalThis.setTimeout=function(callback,ms,...args){
 if(gated&&!retryGated&&ms<=25&&new Error().stack?.includes('portfolio-controller.ts')){
  retryGated=true;return timeout(()=>{fs.writeFileSync(${JSON.stringify(join(value.base, 'retry-waiting'))},'ready');
   const end=performance.now()+20000;while(!fs.existsSync(${JSON.stringify(value.releaseRetry)})){if(performance.now()>end)throw new Error('Retry fixture gate expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}callback(...args);
  },ms);
 }return timeout(callback,ms,...args);
};
fs.linkSync=function(from,to){
 if(!gated&&String(to)===${JSON.stringify(value.lock)}&&fs.existsSync(${JSON.stringify(join(value.root, 'universes/universe-a/.execution.lock'))})&&new Error().stack?.includes('appendPortfolioControllerEvent')){
  gated=true;fs.writeFileSync(${JSON.stringify(join(value.base, 'before-intent'))},'ready');
  const end=performance.now()+20000;while(!fs.existsSync(${JSON.stringify(value.releaseAdmission)})){if(performance.now()>end)throw new Error('Admission fixture gate expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}
  try{return link(from,to);}catch(error){if(error.code==='EEXIST')fs.writeFileSync(${JSON.stringify(join(value.base, 'intent-contended'))},'busy');throw error;}
 }return link(from,to);
};syncBuiltinESMExports();
const{cmdUniverseController}=await import('./src/cli/universe-controller.ts');process.exitCode=await cmdUniverseController(${JSON.stringify(['run', '--manifest', value.manifest, '--root', value.root, '--json'])});`;
  return child(value, source);
}

function holder(value: Fixture) {
  return child(value, `import fs from'node:fs';import{acquireLocalStoreLockWithOutcome,releaseLocalStoreLock}from'./src/core/fleet/local-store-lock.ts';
const result=acquireLocalStoreLockWithOutcome(${JSON.stringify(value.lock)},0,{anchorPath:${JSON.stringify(value.directory)},exactPrivateStorage:true});
if(result.state!=='acquired')throw new Error('Fixture holder did not acquire');
fs.writeFileSync(${JSON.stringify(join(value.base, 'holder-ready'))},JSON.stringify({pid:process.pid})+'\\n');
try{const end=performance.now()+25000;while(!fs.existsSync(${JSON.stringify(value.releaseHolder)})){if(performance.now()>end)throw new Error('Holder expired');await new Promise(resolve=>setTimeout(resolve,25));}}finally{releaseLocalStoreLock(result.lock);}`);
}

function events(value: Fixture): Array<Record<string, unknown>> {
  const records = join(value.directory, 'ledger/records');
  return readdirSync(records).sort().map((name) => JSON.parse(readFileSync(join(records, name), 'utf8')) as Record<string, unknown>);
}

describe.runIf(process.platform === 'darwin')('controller native final-admission retry', () => {
  it.each(['changed', 'unchanged'] as const)('rechecks %s evidence after a live short-lock owner releases', async (mode) => {
    const value = fixture(); const owner = controller(value);
    await until(owner, () => existsSync(join(value.base, 'before-intent')));
    expect(events(value).some((event) => event.kind === 'intent')).toBe(false);
    const originalDeadline = (events(value)[0]!.enrollment as { deadlineAt: string }).deadlineAt;
    const lease = readFileSync(join(value.root, 'universes/universe-a/.execution.lock'));
    const competing = holder(value); await until(competing, () => existsSync(join(value.base, 'holder-ready')));
    const holderPid = JSON.parse(readFileSync(join(value.base, 'holder-ready'), 'utf8')).pid;
    expect(holderPid).toBe(competing.processHandle.pid); expect(() => process.kill(holderPid, 0)).not.toThrow();
    writeFileSync(value.releaseAdmission, 'release\n');
    await until(owner, () => existsSync(join(value.base, 'intent-contended')));
    // Wait until live ownership was classified as contended. Releasing earlier
    // races the lock's required owner proof and correctly yields unavailable.
    await until(owner, () => existsSync(join(value.base, 'retry-waiting')));
    if (mode === 'changed') expect(requestUniverseCampaignControl('campaign-a', 'pause', { root: value.root }).state).toBe('paused');
    const campaignBefore = tree(join(value.root, 'campaigns/campaign-a'));
    expect(readFileSync(join(value.root, 'universes/universe-a/.execution.lock'))).toEqual(lease);
    expect(events(value).some((event) => event.kind === 'intent')).toBe(false);
    writeFileSync(value.releaseHolder, 'release\n');
    expect(await competing.closed, JSON.stringify(competing.output())).toEqual({ code: 0, signal: null });
    writeFileSync(value.releaseRetry, 'release\n');
    expect(await owner.closed, JSON.stringify(owner.output())).toEqual({ code: mode === 'changed' ? 1 : 0, signal: null });
    expect(owner.output().failure).toBeNull();
    expect(owner.output().stdout, owner.output().stderr).not.toBe('');
    const report = JSON.parse(owner.output().stdout) as UniversePortfolioControllerReport;
    expect(report.deadlineAt, JSON.stringify(report)).toBe(originalDeadline);
    const intents = events(value).filter((event) => event.kind === 'intent');
    if (mode === 'changed') {
      expect(report.status, JSON.stringify(report)).toBe('unavailable'); expect(intents).toEqual([]);
      expect(tree(join(value.root, 'campaigns/campaign-a'))).toEqual(campaignBefore);
      expect(readUniverseOverview({ root: value.root }).universes[0]!.runs).toEqual([]);
      expect(readUniverseCampaign('campaign-a', { root: value.root }).progress.attempts).toBe(0);
    } else {
      expect(report.status).toBe('completed'); expect(intents).toHaveLength(1);
      expect(readUniverseCampaign('campaign-a', { root: value.root }).progress.attempts).toBe(2);
      const runs = readUniverseOverview({ root: value.root }).universes[0]!.runs;
      expect(runs).toHaveLength(2);
      expect(runs.flatMap((run) => run.trials).some((trial) => trial.score === 1), JSON.stringify(runs)).toBe(true);
    }
    for (const lock of [value.lock, join(value.directory, '.execution.lock'), join(value.directory, 'ledger/.records.lock'),
      join(value.root, 'universes/universe-a/.execution.lock'), join(value.root, 'campaigns/campaign-a/ledger/.records.lock')]) expect(existsSync(lock)).toBe(false);
  }, 65_000);
});
