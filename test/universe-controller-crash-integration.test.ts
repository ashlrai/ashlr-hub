import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, type UniverseManifest } from '../src/core/universe/index.js';
import { readUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import type { UniversePortfolioControllerReport } from '../src/core/universe/portfolio-controller-types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const scratch: string[] = [];
const children = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();
const project = dirname(dirname(fileURLToPath(import.meta.url)));
afterEach(async () => {
  for (const [child, closed] of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
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

// The same inert integer worker / independently pinned evaluator used by the
// dispatch recovery acceptance tests. No subscription, credential or network IO.
function fixture(delivery = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-controller-crash-')));
  scratch.push(base);
  const root = join(base, 'store');
  const temp = join(base, 'tmp'); mkdirSync(temp, { mode: 0o700 });
  const manifests: UniverseManifest[] = [];
  for (const name of ['a', 'b']) {
    const repo = join(base, `repo-${name}`); mkdirSync(repo, { mode: 0o700 });
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
    git('-c', 'user.name=Crash Fixture', '-c', 'user.email=crash@example.invalid', 'commit', '-qm', 'fixed crash seed');
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${name}`, name: `Crash ${name}`,
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
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'crash-controller', maxParallel: 1, maxDurationMs: 60_000,
    tasks: [{ campaignId: 'campaign-a', dependsOn: [] }, { campaignId: 'campaign-b', dependsOn: ['campaign-a'] }] };
  const deliveryPlan = { schemaVersion: 1 as const, deliveries: [{ campaignId: 'campaign-a',
    branch: 'codex/crash-native', baseCommit: manifests[0]!.seed.revision }] };
  return { base, root, temp, definition, manifests, options: { root, ...(delivery ? { deliveryPlan } : {}) } };
}

type Fixture = ReturnType<typeof fixture>;
type Boundary = 'before-intent' | 'before-start' | 'before-settlement';

function ledger(root: string, relative: string) {
  const path = join(root, relative, 'ledger', 'records');
  return readdirSync(path).sort().map((name) => JSON.parse(readFileSync(join(path, name), 'utf8')) as Record<string, unknown>);
}

function snapshot(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? { mode: stat.mode, inode: stat.ino,
    entries: Object.fromEntries(readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))])) }
    : { mode: stat.mode, inode: stat.ino, bytes: readFileSync(path).toString('base64') };
}

function launch(value: Fixture, boundary?: Boundary) {
  // Hooks exist only in the doomed child. Its successor imports production
  // modules in a new process, with no fs patch, mock state or fault flags.
  const hook = boundary === undefined ? '' : `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeSync;
    const boundary = ${JSON.stringify(boundary)};
    fs.openSync = function(...args) {
      const name = String(args[0]);
      const stage = path.dirname(name);
      const controller = path.join(input.options.root, 'portfolios', input.definition.id);
      const campaign = path.join(input.options.root, 'campaigns', 'campaign-a');
      const staged = /^\\.\\d{8}\\.[a-f0-9]{64}\\.stage\\.tmp$/.test(path.basename(name));
      let matches = false;
      if (staged && stage === path.join(controller, 'ledger', 'staging')) {
        const events = fs.readdirSync(path.join(controller, 'ledger', 'records')).sort()
          .map(file => JSON.parse(fs.readFileSync(path.join(controller, 'ledger', 'records', file), 'utf8')));
        matches = boundary === 'before-intent' && events.at(-1)?.kind === 'observed'
          || boundary === 'before-settlement' && events.at(-1)?.kind === 'intent';
      }
      if (staged && stage === path.join(campaign, 'ledger', 'staging') && boundary === 'before-start') matches = true;
      if (matches) {
        originalWrite(1, JSON.stringify({boundary, pid: process.pid, stagePath: name}) + '\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return originalOpen.apply(this, args);
    };
    syncBuiltinESMExports();
  `;
  const source = `const input = ${JSON.stringify({ definition: value.definition, options: value.options })};
    ${hook}
    const {runUniversePortfolioController} = await import('./src/core/universe/portfolio-controller.ts');
    const report = await runUniversePortfolioController(input.definition, input.options);
    process.stdout.write(JSON.stringify({report})+'\\n');`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LC_ALL: 'C', TMPDIR: value.temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  let stdout = ''; let stderr = '';
  let readyResolve!: (marker: { boundary: Boundary; pid: number; stagePath: string }) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<{ boundary: Boundary; pid: number; stagePath: string }>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Attach immediately; successful children have no marker and do not consume ready.
  void ready.catch(() => {});
  child.stdout!.on('data', (buffer: Buffer) => {
    if (Buffer.byteLength(stdout) + buffer.length > 1_048_576) {
      readyReject(new Error('Fixture stdout exceeded its bounded capture'));
      child.kill('SIGKILL'); return;
    }
    stdout += buffer.toString();
    // Pipes may split even this tiny JSON marker across multiple chunks.
    const line = stdout.split('\n').slice(0, -1).find((item) => item.startsWith('{"boundary":'));
    if (line) readyResolve(JSON.parse(line));
  });
  child.stderr!.on('data', (buffer: Buffer) => {
    if (Buffer.byteLength(stderr) + buffer.length > 1_048_576) {
      readyReject(new Error('Fixture stderr exceeded its bounded capture'));
      child.kill('SIGKILL'); return;
    }
    stderr += buffer.toString();
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => { readyReject(error); });
    child.once('close', (code, signal) => {
      readyReject(new Error(`Child exited before boundary: ${code}/${signal}\n${stderr}\n${stdout}`));
      resolve({ code, signal });
    });
  });
  children.set(child, closed);
  // Every child has a bounded parent watchdog, including assertion-failure paths.
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  void closed.then(() => clearTimeout(timer));
  return { child, ready, closed, output: () => ({ stdout, stderr }) };
}

async function killAt(value: Fixture, boundary: Boundary, beforeKill?: (child: ReturnType<typeof launch>) => Promise<void>) {
  const child = launch(value, boundary);
  const marker = await child.ready;
  expect(marker).toMatchObject({ boundary, pid: child.child.pid });
  expect(existsSync(marker.stagePath)).toBe(false);
  expect(readdirSync(dirname(marker.stagePath))).toEqual([]);
  await beforeKill?.(child);
  expect(child.child.kill('SIGKILL')).toBe(true);
  expect(await child.closed).toEqual({ code: null, signal: 'SIGKILL' });
  expect(() => process.kill(marker.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  const controller = join(value.root, 'portfolios', value.definition.id);
  const owner = JSON.parse(readFileSync(join(controller, '.execution.lock'), 'utf8'));
  expect(owner.pid).toBe(marker.pid);
  expect(JSON.parse(readFileSync(join(dirname(dirname(marker.stagePath)), '.records.lock'), 'utf8')).pid).toBe(marker.pid);
  return { marker, controller };
}

async function successor(value: Fixture): Promise<UniversePortfolioControllerReport> {
  const child = launch(value);
  const exit = await child.closed;
  expect(exit, JSON.stringify(child.output())).toEqual({ code: 0, signal: null });
  return JSON.parse(child.output().stdout.trim()).report as UniversePortfolioControllerReport;
}

// SIGKILL is real, but these receipts do not claim machine reboot or disk-power-loss durability.
describe.runIf(process.platform === 'darwin')('Universe controller subprocess crash recovery', () => {
  it('reclaims dead leases and reconciles completed A once, while a live owner remains exclusive', async () => {
    const value = fixture();
    const { controller } = await killAt(value, 'before-settlement', async () => {
      expect(readUniverseCampaign('campaign-a', value.options).state).toBe('completed');
      const before = snapshot(value.root);
      const competing = await successor(value);
      expect(competing.status).not.toBe('completed');
      expect(competing.reasons).toContain('controller-owned');
      expect(snapshot(value.root)).toEqual(before);
    });
    const before = snapshot(value.root);
    const status = readUniversePortfolioController(value.definition.id, value.options);
    expect(status.status).not.toBe('completed');
    expect(snapshot(value.root)).toEqual(before);
    const campaign = snapshot(join(value.root, 'campaigns', 'campaign-a'));
    const universe = snapshot(join(value.root, 'universes', 'universe-a'));
    const created = ledger(value.root, `portfolios/${value.definition.id}`)[0]!;
    const report = await successor(value);
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'completed', createdAt: created.at,
      deadlineAt: (created.enrollment as { deadlineAt: string }).deadlineAt });
    expect(snapshot(join(value.root, 'campaigns', 'campaign-a'))).toEqual(campaign);
    expect(snapshot(join(value.root, 'universes', 'universe-a'))).toEqual(universe);
    expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(1);
    expect(existsSync(join(controller, '.execution.lock'))).toBe(false);
    expect(existsSync(join(controller, 'ledger', '.records.lock'))).toBe(false);
    const durable = snapshot(value.root);
    expect((await successor(value)).status).toBe('completed');
    expect(snapshot(value.root)).toEqual(durable);
  });

  it('retains a durable intent when killed before campaign start, without retrying A or releasing B', async () => {
    const value = fixture();
    await killAt(value, 'before-start');
    const original = ledger(value.root, `portfolios/${value.definition.id}`);
    const before = original.filter((row) => row.kind === 'intent');
    expect(before).toHaveLength(1);
    expect(ledger(value.root, 'campaigns/campaign-a').map((row) => row.kind)).toEqual(['created']);
    const campaign = snapshot(join(value.root, 'campaigns', 'campaign-a'));
    const universe = snapshot(join(value.root, 'universes', 'universe-a'));
    const report = await successor(value);
    expect(report.status).not.toBe('completed');
    expect(report).toMatchObject({ createdAt: original[0]!.at,
      deadlineAt: (original[0]!.enrollment as { deadlineAt: string }).deadlineAt });
    expect(report.outcomes[0]).toMatchObject({ state: 'in-flight', attempted: true });
    expect(ledger(value.root, `portfolios/${value.definition.id}`).filter((row) => row.kind === 'intent')).toEqual(before);
    expect(snapshot(join(value.root, 'campaigns', 'campaign-a'))).toEqual(campaign);
    expect(snapshot(join(value.root, 'universes', 'universe-a'))).toEqual(universe);
    expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(0);
  });

  it('reclaims pre-intent dead locks and starts each campaign once with the original deadline', async () => {
    const value = fixture();
    await killAt(value, 'before-intent');
    const records = ledger(value.root, `portfolios/${value.definition.id}`);
    expect(records.map((row) => row.kind)).toEqual(['created', 'observed']);
    expect(ledger(value.root, 'campaigns/campaign-a').map((row) => row.kind)).toEqual(['created']);
    const report = await successor(value);
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'completed', createdAt: records[0]!.at,
      deadlineAt: (records[0]!.enrollment as { deadlineAt: string }).deadlineAt });
    for (const name of ['a', 'b']) {
      expect(readUniverseCampaign(`campaign-${name}`, value.options).progress.attempts).toBe(1);
      expect(ledger(value.root, `campaigns/campaign-${name}`).filter((row) => row.kind === 'started')).toHaveLength(1);
    }
  });

  it('verifies an existing planned Git delivery after SIGKILL without recreating its branch or rerunning A', async () => {
    const value = fixture(true);
    await killAt(value, 'before-settlement');
    const repo = value.manifests[0]!.seed.repo;
    const revision = () => execFileSync('git', ['-C', repo, 'rev-parse', 'refs/heads/codex/crash-native'], { encoding: 'utf8', timeout: 10_000 }).trim();
    const delivered = revision();
    expect(delivered).not.toBe(value.manifests[0]!.seed.revision);
    const campaign = snapshot(join(value.root, 'campaigns', 'campaign-a'));
    const universe = snapshot(join(value.root, 'universes', 'universe-a'));
    const report = await successor(value);
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'completed' });
    expect(report.outcomes[0]!.deliveryDigest).toEqual(expect.any(String));
    expect(revision()).toBe(delivered);
    expect(snapshot(join(value.root, 'campaigns', 'campaign-a'))).toEqual(campaign);
    expect(snapshot(join(value.root, 'universes', 'universe-a'))).toEqual(universe);
    expect(readUniverseCampaign('campaign-b', value.options).progress.attempts).toBe(1);
  });
});
