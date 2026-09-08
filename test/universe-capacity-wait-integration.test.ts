/** Two private Universes, real ledgers/evaluators, and one inert dual-protocol native binding. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview,
  type UniverseCampaignDefinition, type UniverseManifest } from '../src/core/universe/index.js';
import { runUniversePortfolio } from '../src/core/universe/portfolio.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { resourceGenerationTaskId } from '../src/core/universe/generation.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import * as poolRuntime from '../src/core/resources/pool-runtime.js';
import * as localLocks from '../src/core/fleet/local-store-lock.js';
import * as verification from '../src/core/run/verify-commands.js';
import { serializeUniverseConsoleOverview } from '../src/core/web/universe-console-public.js';

const scratch: string[] = [];
const EMAIL = 'capacity-fixture@example.invalid';
const ACCOUNT_HINT = digest(canonical({ schemaVersion: 1, type: 'chatgpt', email: EMAIL, planType: 'pro' }));
const EVALUATOR = [
  "import {readFileSync} from 'node:fs';import {join} from 'node:path';",
  "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));",
  'console.log(JSON.stringify({passed:value===1,score:value,metrics:{value}}));',
].join('\n');
interface FixtureEvent { kind: 'start' | 'request' | 'close' | 'unexpected'; mode?: 'metadata' | 'exec'; pid?: number; method?: string }

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  }).trim();
}
function save(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }

function fixture(options: { capacityWaitMs?: number } = { capacityWaitMs: 8000 }) {
  const { capacityWaitMs } = options;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-capacity-wait-'))); scratch.push(base);
  const root = join(base, 'universe-store'); const workspace = join(base, 'empty-workspace');
  mkdirSync(workspace, { mode: 0o700 }); git(workspace, 'init', '-q', '--template=', '--initial-branch=main');
  const eventsFile = join(base, 'fixture-events.jsonl'); const workerFile = join(base, 'inert-capacity-native.cjs');
  const metadataGate = join(base, 'release-metadata'); const execGate = join(base, 'release-exec');
  writeFileSync(workerFile, `
const fs=require('node:fs');const readline=require('node:readline');
const log=value=>fs.appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify(value)+'\\n',{mode:0o600});
const wait=async file=>{while(!fs.existsSync(file))await new Promise(done=>setTimeout(done,10));};
const argv=process.argv.slice(2);const mode=argv[0]==='app-server'?'metadata':argv[0]==='exec'?'exec':'unexpected';
log({kind:'start',mode,pid:process.pid});
if(mode==='unexpected'){log({kind:'unexpected'});process.exit(30);}
if(mode==='metadata'){
  if(JSON.stringify(argv)!==JSON.stringify(['app-server','--stdio','-c','analytics.enabled=false']))process.exit(31);
  const reader=readline.createInterface({input:process.stdin});
  const write=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
  reader.on('line',async line=>{
    const row=JSON.parse(line);log({kind:'request',mode,pid:process.pid,method:row.method});
    if(row.method==='initialized')return;
    if(row.method==='initialize'){write(row.id,{codexHome:'/private/inert-capacity-home',userAgent:'fixture',platformFamily:'unix',platformOs:'macos'});return;}
    if(row.method==='account/read'){
      if(row.params?.refreshToken!==false)process.exit(32);
      write(row.id,{requiresOpenaiAuth:true,account:{type:'chatgpt',email:${JSON.stringify(EMAIL)},planType:'pro'}});return;
    }
    if(row.method==='account/rateLimits/read'){
      await wait(${JSON.stringify(metadataGate)});
      write(row.id,{rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}});return;
    }
    log({kind:'unexpected'});process.exit(33);
  });
  reader.on('close',()=>log({kind:'close',mode,pid:process.pid}));
}else{
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
  process.stdin.on('end',async()=>{
    const messages=JSON.parse(input);const prompt=JSON.parse(messages.find(row=>row.role==='user').content);
    if(input.includes('UNDECLARED_SEED_DATA')||input.includes('evaluate.mjs')||prompt.files.length!==1||prompt.files[0].path!=='value.json'||prompt.files[0].content!=='0\\n')process.exit(34);
    await wait(${JSON.stringify(execGate)});
    const content=JSON.stringify({edits:[{path:'value.json',content:'1\\n'}]});
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:content}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}));
    log({kind:'close',mode,pid:process.pid});
  });
}
`, { mode: 0o600 });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'capacity-pool', workers: [{ id: 'native', provider: 'codex', model: 'inert-fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 8, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true }] });
  const bindings = validateResourceBindings([{ workerId: 'native', capacityKey: 'one-shared-fixture-account',
    kind: 'native-cli', command: [process.execPath, workerFile] }], pool);
  const now = Date.now();
  const observations: ResourceObservation[] = [{ workerId: 'native', observedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), health: 'ready', retryAfter: null,
    windows: [{ id: 'codex_codex_primary', usedPercent: 20, resetsAt: new Date(now + 3_600_000).toISOString() }] }];
  const poolDigest = digest(canonical({ pool, bindings })); const ledgerRoot = join(base, 'shared-ledger');
  const quotaConfigPath = join(base, 'quota.json'); const resourceRuntime = join(base, 'runtime.json');
  const runtime = { schemaVersion: 1, poolPath: join(base, 'pool.json'), bindingsPath: join(base, 'bindings.json'),
    observationsPath: join(base, 'observations.json'), root: ledgerRoot, workspace, quotaConfigPath,
    ...(capacityWaitMs === undefined ? {} : { capacityWaitMs }) };
  save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations); save(resourceRuntime, runtime);
  save(quotaConfigPath, { schemaVersion: 1, poolDigest, workers: [{ workerId: 'native', accountHint: ACCOUNT_HINT, bucketIds: ['codex'] }] });
  const privateFiles = [runtime.poolPath, runtime.bindingsPath, resourceRuntime, quotaConfigPath, workerFile]
    .map((path) => ({ path, bytes: readFileSync(path) }));
  const seeds: Array<{ repo: string; revision: string }> = [];
  for (const name of ['a', 'b']) {
    const repo = join(base, `seed-${name}`); mkdirSync(repo, { mode: 0o700 });
    git(repo, 'init', '-q', '--template=', '--initial-branch=main');
    writeFileSync(join(repo, 'value.json'), '0\n'); writeFileSync(join(repo, 'evaluate.mjs'), EVALUATOR);
    writeFileSync(join(repo, 'private.txt'), 'UNDECLARED_SEED_DATA'); git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Capacity Fixture', '-c', 'user.email=capacity@example.invalid', 'commit', '-qm', 'pinned private evaluator');
    const seed = { repo, revision: git(repo, 'rev-parse', 'HEAD') }; seeds.push(seed);
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${name}`, name: `Capacity ${name}`,
      objective: 'Produce one independently evaluated integer edit', seed,
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 20_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
      variants: [{ id: 'advance', niche: 'value', hypothesis: 'Make the measured integer one',
        generation: { kind: 'resource-pool', poolId: pool.id, poolDigest, allowedWorkerIds: ['native'], files: ['value.json'], maxOutputTokens: 256 } }] };
    initUniverse(manifest, { root });
    const campaign: UniverseCampaignDefinition = { schemaVersion: 1, id: `campaign-${name}`, universeId: manifest.id, feedback: true,
      budget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null } };
    initUniverseCampaign(campaign, { root });
  }
  const portfolio: UniversePortfolioDefinition = { schemaVersion: 1, id: 'capacity-portfolio', maxParallel: 2, maxDurationMs: 40_000,
    tasks: ['a', 'b'].map((name) => ({ campaignId: `campaign-${name}`, dependsOn: [] })) };
  const events = (): FixtureEvent[] => existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line)) : [];
  // Capture the real read before installing orchestration spies. Test polling
  // must not manufacture evidence that the runtime checked contended capacity.
  const readStatus = poolRuntime.resourcePoolStatus;
  return { base, root, workspace, ledgerRoot, runtime, resourceRuntime, quotaConfigPath, pool, bindings, observations, seeds, privateFiles, portfolio, events,
    quotaLock: join(ledgerRoot, '.resource-quota-refresh.lock'), pendingPath: join(ledgerRoot, '.resource-quota-refresh-pending.json'),
    releaseMetadata: () => writeFileSync(metadataGate, '', { mode: 0o600 }),
    releaseExec: () => writeFileSync(execGate, '', { mode: 0o600 }),
    contacts: (mode: 'metadata' | 'exec') => events().filter((event) => event.kind === 'start' && event.mode === mode),
    status: () => readStatus(ledgerRoot, pool, bindings, observations) };
}

function watchContention(value: ReturnType<typeof fixture>) {
  let quota = 0; let slots = 0;
  const acquire = localLocks.acquireLocalStoreLock; const status = poolRuntime.resourcePoolStatus;
  const acquireOutcome = localLocks.acquireLocalStoreLockWithOutcome;
  vi.spyOn(localLocks, 'acquireLocalStoreLock').mockImplementation((...args) => {
    const result = acquire(...args);
    if (args[0] === value.quotaLock && result === null) quota++;
    return result;
  });
  vi.spyOn(localLocks, 'acquireLocalStoreLockWithOutcome').mockImplementation((...args) => {
    const result = acquireOutcome(...args);
    if (args[0] === value.quotaLock && result.state === 'contended') quota++;
    return result;
  });
  vi.spyOn(poolRuntime, 'resourcePoolStatus').mockImplementation((...args) => {
    const result = status(...args);
    if (args[0] === value.ledgerRoot && value.contacts('metadata').length === 2 &&
      value.events().filter((event) => event.kind === 'close' && event.mode === 'metadata').length === 2 &&
      value.contacts('exec').length === 1 && result.plan.selectedWorkerId === null &&
      result.plan.exclusions.some((row) => row.workerId === 'native' && row.reasons.length === 1 && row.reasons[0] === 'concurrency-exhausted')) slots++;
    return result;
  });
  return { quota: () => quota, slots: () => slots };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Inert capacity fixture did not reach its expected state');
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function bothWaits(value: ReturnType<typeof fixture>, observed: ReturnType<typeof watchContention>): Promise<void> {
  await until(() => value.contacts('metadata').length === 1 && observed.quota() > 0);
  expect(value.contacts('exec')).toEqual([]); value.releaseMetadata();
  await until(() => observed.slots() > 0);
  expect(value.contacts('metadata')).toHaveLength(2); expect(value.contacts('exec')).toHaveLength(1);
  expect(value.status().attempts).toHaveLength(1); expect(value.status().attempts[0]!.status).toBe('reserved');
  expect(existsSync(value.pendingPath)).toBe(false); expect(existsSync(value.quotaLock)).toBe(false);
}

function boundaries(value: ReturnType<typeof fixture>, result: unknown): void {
  const overview = readUniverseOverview(value); expect(overview.sourceState, overview.reasons.join('; ')).toBe('healthy');
  expect(overview.universes.every((universe) => universe.activeRun === null)).toBe(true);
  expect(readdirSync(value.workspace)).toEqual(['.git']);
  expect(git(value.workspace, 'ls-files')).toBe(''); expect(git(value.workspace, 'for-each-ref', '--format=%(refname)')).toBe('');
  for (const seed of value.seeds) {
    expect(git(seed.repo, 'rev-parse', 'HEAD')).toBe(seed.revision); expect(git(seed.repo, 'status', '--porcelain=v1')).toBe('');
    expect(git(seed.repo, 'remote')).toBe(''); expect(readFileSync(join(seed.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(seed.repo, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
  }
  for (const file of value.privateFiles) expect(readFileSync(file.path)).toEqual(file.bytes);
  const serialized = serializeUniverseConsoleOverview(overview);
  for (const hidden of [value.resourceRuntime, value.runtime.bindingsPath, value.workspace, value.quotaConfigPath,
    'capacityWaitMs', 'quotaConfigPath', EMAIL, ACCOUNT_HINT, '/private/inert-capacity-home', 'inert-capacity-native.cjs']) {
    expect(serialized).not.toContain(hidden); expect(JSON.stringify(result)).not.toContain(hidden);
  }
  expect(value.events().filter((event) => event.kind === 'unexpected')).toEqual([]);
  for (const name of ['a', 'b']) expect(readUniverseCampaign(`campaign-${name}`, value).owner).toBeNull();
}

describe.runIf(process.platform === 'darwin')('bounded capacity waiting across a resource-backed portfolio', () => {
  it('waits through metadata and task-slot contention, records sixty fixture tokens, and never contacts on terminal rerun', async () => {
    const value = fixture(); const observed = watchContention(value); const controller = new AbortController();
    const before = readFileSync(value.runtime.observationsPath);
    const pending = runUniversePortfolio(value.portfolio, { root: value.root, resourceRuntime: value.resourceRuntime, signal: controller.signal });
    try {
      await bothWaits(value, observed); value.releaseExec();
      const result = await pending;
      expect(result.status, JSON.stringify(result)).toBe('completed');
      expect(result.outcomes.every((outcome) => outcome.status === 'completed' && outcome.attempted)).toBe(true);
      expect(value.contacts('metadata')).toHaveLength(2); expect(value.contacts('exec')).toHaveLength(2);
      const receipts = value.status().attempts; expect(receipts).toHaveLength(2);
      expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(2);
      const ordered = [...receipts].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      expect(Date.parse(ordered[1]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(ordered[0]!.finishedAt!));
      const overview = readUniverseOverview(value);
      expect(overview.universes.reduce((total, universe) => total + universe.runs[0]!.tokensUsed!, 0)).toBe(60);
      for (const universe of overview.universes) {
        const run = universe.runs[0]!; const trial = run.trials[0]!;
        expect(universe.runs).toHaveLength(1); expect(universe.elites).toHaveLength(1);
        expect(run.generationUsage).toMatchObject({ requestsStarted: 0, reportedRequests: 0, resourceAttempts: 1,
          resourceReportedAttempts: 1, inputTokens: 20, outputTokens: 10 });
        expect(trial).toMatchObject({ status: 'passed', score: 1, selected: true, generation: { status: 'succeeded', requestStarted: false,
          resource: { dispatch: 'settled', taskStatus: 'completed', workerId: 'native', usageScope: 'codex-turn' } } });
        const taskId = resourceGenerationTaskId({ universeId: universe.manifest.id, runId: run.id, variantId: 'advance' });
        const receipt = receipts.find((row) => row.id === taskId)!;
        expect(receipt).toMatchObject({ status: 'completed', inputTokens: 20, outputTokens: 10, verifiedAccepted: false });
        expect(trial.generation!.resource).toMatchObject({ taskId, taskDigest: receipt.taskDigest, receiptDigest: digest(canonical(receipt)) });
        expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
        expect(readUniverseCampaign(`campaign-${universe.manifest.id.slice('universe-'.length)}`, value).progress)
          .toMatchObject({ attempts: 1, reservedModelRequests: 1, reportedTokens: 30, admissions: 1, usageComplete: true });
      }
      const events = value.events(); const summaries = ['a', 'b'].map((name) => readUniverseCampaign(`campaign-${name}`, value));
      const rerun = await runUniversePortfolio(value.portfolio, { root: value.root, resourceRuntime: value.resourceRuntime });
      expect(rerun.status).toBe('completed'); expect(rerun.outcomes.every((outcome) => !outcome.attempted)).toBe(true);
      expect(value.events()).toEqual(events); expect(value.status().attempts).toEqual(receipts);
      expect(['a', 'b'].map((name) => readUniverseCampaign(`campaign-${name}`, value))).toEqual(summaries);
      expect(readFileSync(value.runtime.observationsPath)).toEqual(before); boundaries(value, result);
    } finally { value.releaseMetadata(); value.releaseExec(); controller.abort(); await pending; }
  });

  it.each([undefined, 0])('preserves no-wait behavior for capacityWaitMs %s', async (capacityWaitMs) => {
    const value = fixture({ capacityWaitMs }); const observed = watchContention(value); const controller = new AbortController();
    const pending = runUniversePortfolio(value.portfolio, { root: value.root, resourceRuntime: value.resourceRuntime, signal: controller.signal });
    try {
      await until(() => value.contacts('metadata').length === 1 && observed.quota() > 0 &&
        ['a', 'b'].some((name) => readUniverseCampaign(`campaign-${name}`, value).state === 'paused'));
      value.releaseMetadata(); value.releaseExec(); const result = await pending;
      expect(result.status).toBe('incomplete'); expect(result.outcomes.map((outcome) => outcome.status).sort()).toEqual(['completed', 'paused']);
      expect(value.contacts('metadata')).toHaveLength(1); expect(value.contacts('exec')).toHaveLength(1); expect(value.status().attempts).toHaveLength(1);
      const stopped = readUniverseOverview(value).universes.flatMap((universe) => universe.runs[0]!.trials)
        .find((trial) => trial.generation!.resource!.dispatch === 'not-started')!;
      expect(stopped).toMatchObject({ selected: false, artifact: null, generation: { requestStarted: false } }); boundaries(value, result);
    } finally { value.releaseMetadata(); value.releaseExec(); controller.abort(); await pending; }
  });

  it('stops a waiting contender after a fresh file denial without another metadata pass or worker contact', async () => {
    const value = fixture(); const observed = watchContention(value); const controller = new AbortController();
    const pending = runUniversePortfolio(value.portfolio, { root: value.root, resourceRuntime: value.resourceRuntime, signal: controller.signal });
    try {
      await bothWaits(value, observed);
      save(value.runtime.observationsPath, [{ ...value.observations[0]!, observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'unavailable' }]);
      await until(() => ['a', 'b'].some((name) => readUniverseCampaign(`campaign-${name}`, value).state === 'paused'));
      value.releaseExec(); const result = await pending;
      expect(result.status).toBe('incomplete'); expect(result.outcomes.map((outcome) => outcome.status).sort()).toEqual(['completed', 'paused']);
      expect(value.contacts('metadata')).toHaveLength(2); expect(value.contacts('exec')).toHaveLength(1); expect(value.status().attempts).toHaveLength(1);
      const trials = readUniverseOverview(value).universes.flatMap((universe) => universe.runs[0]!.trials);
      expect(trials.find((trial) => trial.generation!.resource!.dispatch === 'withheld'))
        .toMatchObject({ selected: false, artifact: null, generation: { status: 'failed', requestStarted: false,
          resource: { taskStatus: null, usageScope: null } } }); boundaries(value, result);
    } finally { value.releaseMetadata(); value.releaseExec(); controller.abort(); await pending; }
  });

  it('exhausts the bounded capacity wait without retrying metadata or starting another worker', async () => {
    const value = fixture({ capacityWaitMs: 2000 }); const observed = watchContention(value); const controller = new AbortController();
    const pending = runUniversePortfolio(value.portfolio, { root: value.root, resourceRuntime: value.resourceRuntime, signal: controller.signal });
    try {
      await bothWaits(value, observed);
      await until(() => ['a', 'b'].some((name) => readUniverseCampaign(`campaign-${name}`, value).state === 'paused'));
      value.releaseExec(); const result = await pending;
      expect(result.status).toBe('incomplete'); expect(result.outcomes.map((outcome) => outcome.status).sort()).toEqual(['completed', 'paused']);
      expect(value.contacts('metadata')).toHaveLength(2); expect(value.contacts('exec')).toHaveLength(1); expect(value.status().attempts).toHaveLength(1);
      expect(readUniverseOverview(value).universes.flatMap((universe) => universe.runs[0]!.trials)
        .some((trial) => trial.generation!.resource!.dispatch === 'withheld')).toBe(true); boundaries(value, result);
    } finally { value.releaseMetadata(); value.releaseExec(); controller.abort(); await pending; }
  });

  it('cancels active and waiting campaigns, awaits owned cleanup, and never dispatches the contender', async () => {
    const value = fixture(); const observed = watchContention(value); const controller = new AbortController();
    const original = verification.runVerifySubprocessAsync;
    vi.spyOn(verification, 'runVerifySubprocessAsync').mockImplementation((argv, options) =>
      original(argv, { ...options, _terminationGraceMs: 75, _terminationDrainMs: 150 }));
    const pending = runUniversePortfolio(value.portfolio, { root: value.root, resourceRuntime: value.resourceRuntime, signal: controller.signal });
    try {
      await bothWaits(value, observed); controller.abort(); const result = await pending;
      expect(result.status).toBe('cancelled'); expect(value.contacts('metadata')).toHaveLength(2); expect(value.contacts('exec')).toHaveLength(1);
      expect(value.status().attempts).toHaveLength(1);
      expect(['cancelled', 'uncertain']).toContain(value.status().attempts[0]!.status);
      for (const contact of value.contacts('exec')) expect(() => process.kill(contact.pid!, 0)).toThrow();
      const universes = readUniverseOverview(value).universes;
      expect(universes.every((universe) => universe.elites.length === 0)).toBe(true);
      expect(universes.flatMap((universe) => universe.runs[0]!.trials).every((trial) => trial.selected === false && trial.artifact === null)).toBe(true);
      expect(existsSync(value.pendingPath)).toBe(false); boundaries(value, result);
    } finally { value.releaseMetadata(); value.releaseExec(); controller.abort(); await pending; }
  });
});
