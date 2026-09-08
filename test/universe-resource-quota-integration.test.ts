/** Actual private Git/metadata processes, but an inert native wrapper and no provider calls. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, runUniverseCampaign,
  type UniverseCampaignDefinition, type UniverseManifest } from '../src/core/universe/index.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { serializeUniverseConsoleOverview } from '../src/core/web/universe-console-public.js';
import * as verification from '../src/core/run/verify-commands.js';

const scratch: string[] = [];
const EMAIL = 'quota-fixture@example.invalid';
const ACCOUNT_HINT = digest(canonical({ schemaVersion: 1, type: 'chatgpt', email: EMAIL, planType: 'pro' }));
const EVALUATOR = [
  "import {readFileSync} from 'node:fs';import {join} from 'node:path';",
  "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));",
  'console.log(JSON.stringify({passed:value===1,score:value,metrics:{value}}));',
].join('\n');
type NativeMode = 'ready' | 'denied' | 'unknown' | 'failed' | 'mismatch' | 'request' | 'held';
interface FixtureEvent { kind: 'start' | 'request' | 'close' | 'unexpected'; mode?: string; pid?: number; request?: Record<string, unknown> }

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

function fixture(options: { mode?: NativeMode; fresh?: boolean; fileDenied?: boolean; enabled?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-resource-quota-'))); scratch.push(base);
  const root = join(base, 'universe-store'); const repo = join(base, 'seed'); const workspace = join(base, 'empty-workspace');
  for (const path of [repo, workspace]) {
    mkdirSync(path, { mode: 0o700 }); git(path, 'init', '-q', '--template=', '--initial-branch=main');
  }
  writeFileSync(join(repo, 'value.json'), '0\n'); writeFileSync(join(repo, 'evaluate.mjs'), EVALUATOR);
  writeFileSync(join(repo, 'private.txt'), 'UNDECLARED_SEED_DATA'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Quota Fixture', '-c', 'user.email=quota@example.invalid', 'commit', '-qm', 'pinned private evaluator');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const workerFile = join(base, 'inert-native.cjs'); const eventsFile = join(base, 'fixture-events.jsonl');
  // One exact binding serves the metadata and task protocols. Any other entry
  // point is a fixture failure, never a fallback to a real installed executable.
  writeFileSync(workerFile, `
const fs=require('node:fs');const readline=require('node:readline');
const mode=${JSON.stringify(options.mode ?? 'ready')};
const log=value=>fs.appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify(value)+'\\n',{mode:0o600});
const argv=process.argv.slice(2);const transport=argv[0]==='app-server'?'metadata':argv[0]==='exec'?'exec':'unexpected';
log({kind:'start',mode:transport,pid:process.pid});
if(transport==='unexpected'){log({kind:'unexpected'});process.exit(30);}
if(transport==='metadata'){
  if(JSON.stringify(argv)!==JSON.stringify(['app-server','--stdio','-c','analytics.enabled=false']))process.exit(31);
  const reader=readline.createInterface({input:process.stdin});
  const write=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
  reader.on('line',line=>{
    const row=JSON.parse(line);log({kind:'request',request:row});
    if(row.method==='initialized')return;
    if(row.method==='initialize'){write(row.id,{codexHome:'/private/inert-metadata-home',userAgent:'fixture',platformFamily:'unix',platformOs:'macos'});return;}
    if(row.method==='account/read'){
      if(row.params?.refreshToken!==false)process.exit(32);
      write(row.id,{requiresOpenaiAuth:true,account:{type:'chatgpt',email:mode==='mismatch'?'other@example.invalid':${JSON.stringify(EMAIL)},planType:'pro'}});return;
    }
    if(row.method==='account/rateLimits/read'){
      if(mode==='held'){setInterval(()=>{},1000);return;}
      if(mode==='failed'){process.stderr.write('PRIVATE_NATIVE_ERROR');process.stdout.write(JSON.stringify({id:row.id,error:{code:-1,message:'PRIVATE_NATIVE_ERROR'}})+'\\n');return;}
      if(mode==='request'){process.stdout.write(JSON.stringify({id:'server-request',method:'account/chatgptAuthTokens/refresh',params:{secret:'PRIVATE_NATIVE_VALUE'}})+'\\n');return;}
      write(row.id,{rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:mode==='unknown'?null:mode==='denied'?90:25,
        windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}});return;
    }
    log({kind:'unexpected'});process.exit(33);
  });
  reader.on('close',()=>log({kind:'close',mode:transport,pid:process.pid}));
}else{
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
  process.stdin.on('end',()=>{
    const messages=JSON.parse(input);const prompt=JSON.parse(messages.find(row=>row.role==='user').content);
    if(input.includes('UNDECLARED_SEED_DATA')||input.includes('evaluate.mjs')||prompt.files.length!==1||prompt.files[0].content!=='0\\n')process.exit(34);
    const content=JSON.stringify({edits:[{path:'value.json',content:'1\\n'}]});
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:content}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}));
    log({kind:'close',mode:transport,pid:process.pid});
  });
}
`, { mode: 0o600 });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'quota-pool', workers: [{ id: 'native', provider: 'codex', model: 'inert-fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 2, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true }] });
  const bindings = validateResourceBindings([{ workerId: 'native', capacityKey: 'shared-fixture-account',
    kind: 'native-cli', command: [process.execPath, workerFile] }], pool);
  const now = Date.now(); const fresh = options.fresh || options.fileDenied;
  const observations: ResourceObservation[] = [{ workerId: 'native', observedAt: new Date(now - (fresh ? 1_000 : 120_000)).toISOString(),
    expiresAt: new Date(now + (fresh ? 60_000 : -60_000)).toISOString(), health: 'ready', retryAfter: null,
    windows: [{ id: 'codex_codex_primary', usedPercent: options.fileDenied ? 90 : 20, resetsAt: new Date(now + 3_600_000).toISOString() }] }];
  const poolDigest = digest(canonical({ pool, bindings }));
  const quotaConfig = { schemaVersion: 1, poolDigest, workers: [{ workerId: 'native', accountHint: ACCOUNT_HINT, bucketIds: ['codex'] }] };
  const quotaConfigPath = join(base, 'quota.json'); const resourceRuntime = join(base, 'runtime.json'); const ledgerRoot = join(base, 'pool-ledger');
  const runtime = { schemaVersion: 1, poolPath: join(base, 'pool.json'), bindingsPath: join(base, 'bindings.json'),
    observationsPath: join(base, 'observations.json'), root: ledgerRoot, workspace,
    ...(options.enabled === false ? {} : { quotaConfigPath }) };
  save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations);
  save(quotaConfigPath, quotaConfig); save(resourceRuntime, runtime);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'quota-universe', name: 'Quota refresh fixture',
    objective: 'Produce one independently evaluated integer edit', seed: { repo, revision },
    metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 10_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
    variants: [{ id: 'advance', niche: 'value', hypothesis: 'Make the measured integer one',
      generation: { kind: 'resource-pool', poolId: pool.id, poolDigest, allowedWorkerIds: ['native'], files: ['value.json'], maxOutputTokens: 256 } }] };
  initUniverse(manifest, { root });
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: 'quota-campaign', universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 1, maxDurationMs: 30_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null } };
  initUniverseCampaign(definition, { root });
  const events = (): FixtureEvent[] => existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { base, root, repo, revision, workspace, ledgerRoot, runtime, resourceRuntime, quotaConfigPath, quotaConfig, pool, bindings, observations, events,
    pendingPath: join(ledgerRoot, '.resource-quota-refresh-pending.json'),
    run: (signal?: AbortSignal) => runUniverseCampaign(definition.id, { root, resourceRuntime, ...(signal ? { signal } : {}) }),
    status: () => resourcePoolStatus(ledgerRoot, pool, bindings, observations),
    trial: () => readUniverseOverview({ root }).universes[0]!.runs[0]!.trials[0]!,
    contacts: (mode: string) => events().filter((event) => event.kind === 'start' && event.mode === mode) };
}

function privateBoundaries(value: ReturnType<typeof fixture>): void {
  expect(readdirSync(value.workspace)).toEqual(['.git']);
  expect(git(value.workspace, 'for-each-ref', '--format=%(refname)')).toBe('');
  expect(git(value.repo, 'rev-parse', 'HEAD')).toBe(value.revision);
  expect(git(value.repo, 'status', '--porcelain=v1')).toBe('');
  expect(readFileSync(join(value.repo, 'value.json'), 'utf8')).toBe('0\n');
  expect(readFileSync(join(value.repo, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
  const overview = readUniverseOverview(value); expect(overview.sourceState, overview.reasons.join('; ')).toBe('healthy');
  const serialized = serializeUniverseConsoleOverview(overview);
  for (const hidden of [value.quotaConfigPath, value.resourceRuntime, value.runtime.bindingsPath, value.workspace,
    'quotaConfigPath', EMAIL, 'other@example.invalid', '/private/inert-metadata-home', 'PRIVATE_NATIVE_', 'inert-native.cjs']) {
    expect(serialized).not.toContain(hidden); expect(JSON.stringify(value.trial().generation)).not.toContain(hidden);
  }
  expect(value.events().filter((event) => event.kind === 'unexpected')).toEqual([]);
}

describe.runIf(process.platform === 'darwin')('Universe generation with explicit bounded quota refresh', () => {
  it('refreshes stale metadata, admits an independently evaluated candidate, and does not contact native again on terminal rerun', async () => {
    const value = fixture(); const before = readFileSync(value.runtime.observationsPath);
    const summary = await value.run();
    expect(summary.state, JSON.stringify(summary)).toBe('completed');
    expect(summary.progress).toMatchObject({ attempts: 1, admissions: 1, reportedTokens: 30, usageComplete: true });
    expect(value.contacts('metadata')).toHaveLength(1); expect(value.contacts('exec')).toHaveLength(1);
    const metadata = value.events().filter((event) => event.kind === 'request').map((event) => event.request!);
    expect(metadata.map((request) => request.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read']);
    expect(metadata.filter((request) => request.method === 'account/read').map((request) => request.params)).toEqual([
      { refreshToken: false }, { refreshToken: false },
    ]);
    const trial = value.trial();
    expect(trial).toMatchObject({ status: 'passed', score: 1, selected: true,
      generation: { requestStarted: false, status: 'succeeded', resource: { dispatch: 'settled', taskStatus: 'completed', usageScope: 'codex-turn' } } });
    const receipt = value.status().attempts[0]!;
    expect(receipt).toMatchObject({ status: 'completed', inputTokens: 20, outputTokens: 10, verifiedAccepted: false });
    expect(trial.generation!.resource!.receiptDigest).toBe(digest(canonical(receipt)));
    expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
    expect(readFileSync(join(trial.artifact!.path, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
    expect(existsSync(value.pendingPath)).toBe(false);
    expect(readFileSync(value.runtime.observationsPath)).toEqual(before);
    const events = value.events(); const receipts = value.status().attempts;
    expect(await value.run()).toEqual(summary); expect(value.events()).toEqual(events); expect(value.status().attempts).toEqual(receipts);
    privateBoundaries(value);
  });

  it('preserves the old runtime shape and performs no metadata collection without explicit enrollment', async () => {
    const value = fixture({ enabled: false, fresh: true });
    expect((await value.run()).state).toBe('completed');
    expect(value.contacts('metadata')).toEqual([]); expect(value.contacts('exec')).toHaveLength(1);
    expect(value.trial().status).toBe('passed'); expect(existsSync(value.pendingPath)).toBe(false);
    privateBoundaries(value);
  });

  it.each(['missing', 'pin'] as const)('makes zero native contacts for a %s quota configuration', async (kind) => {
    const value = fixture({ fresh: true });
    if (kind === 'missing') unlinkSync(value.quotaConfigPath);
    else save(value.quotaConfigPath, { ...value.quotaConfig, poolDigest: '0'.repeat(64) });
    expect((await value.run()).state).toBe('paused');
    expect(value.events()).toEqual([]); expect(value.status().attempts).toEqual([]);
    expect(value.trial()).toMatchObject({ status: 'failed', artifact: null,
      generation: { requestStarted: false, resource: { dispatch: 'not-started', taskId: null } } });
    privateBoundaries(value);
  });

  it.each(['denied', 'unknown', 'failed', 'mismatch', 'request'] as const)('withholds worker contact after %s metadata despite healthy base observations', async (mode) => {
    const value = fixture({ mode, fresh: true });
    const summary = await value.run();
    expect(summary.state, JSON.stringify(summary)).toBe('paused');
    expect(value.contacts('metadata')).toHaveLength(1); expect(value.contacts('exec')).toEqual([]);
    expect(value.status().attempts).toEqual([]);
    expect(value.trial()).toMatchObject({ status: 'failed', selected: false, artifact: null,
      generation: { requestStarted: false, resource: { dispatch: 'withheld', taskStatus: null } } });
    expect(existsSync(value.pendingPath)).toBe(false);
    privateBoundaries(value);
  });

  it('retains the explicit observations-file reserve veto after a newer successful metadata read', async () => {
    const value = fixture({ fileDenied: true }); const before = readFileSync(value.runtime.observationsPath);
    expect((await value.run()).state).toBe('paused');
    expect(value.contacts('metadata')).toHaveLength(1); expect(value.contacts('exec')).toEqual([]);
    expect(value.status().attempts).toEqual([]); expect(value.trial().generation!.resource!.dispatch).toBe('withheld');
    expect(readFileSync(value.runtime.observationsPath)).toEqual(before); privateBoundaries(value);
  });

  it.each(['pending', 'owned'] as const)('refuses the shared quota %s fence before any native contact', async (kind) => {
    const value = fixture({ fresh: true }); mkdirSync(value.ledgerRoot, { mode: 0o700 });
    const pending = JSON.stringify({ schemaVersion: 1, scope: 'codex-native-metadata', state: 'pending', startedAt: new Date().toISOString() });
    const lock = kind === 'owned' ? acquireLocalStoreLock(join(value.ledgerRoot, '.resource-quota-refresh.lock'), 100,
      { anchorPath: value.ledgerRoot, exactPrivateStorage: true }) : null;
    if (kind === 'owned') expect(lock).not.toBeNull();
    else writeFileSync(value.pendingPath, pending + '\n', { mode: 0o600 });
    try {
      expect((await value.run()).state).toBe('paused');
      expect(value.events()).toEqual([]); expect(value.status().attempts).toEqual([]);
      expect(value.trial().generation!.resource!.dispatch).toBe('not-started');
      if (kind === 'pending') expect(readFileSync(value.pendingPath, 'utf8')).toBe(pending + '\n');
      privateBoundaries(value);
    } finally { if (lock) expect(releaseLocalStoreLock(lock)).toBe(true); }
  });

  it('awaits cancellation during metadata and does not submit a resource task', async () => {
    const value = fixture({ mode: 'held', fresh: true });
    const original = verification.runVerifySubprocessAsync;
    // Preserve actual process ownership while bounding the test's grace/drain.
    vi.spyOn(verification, 'runVerifySubprocessAsync').mockImplementation((argv, options) =>
      original(argv, { ...options, _terminationGraceMs: 75, _terminationDrainMs: 150 }));
    const controller = new AbortController(); const pending = value.run(controller.signal);
    try {
      await vi.waitFor(() => expect(value.events().some((event) => event.request?.method === 'account/rateLimits/read')).toBe(true), { timeout: 8_000 });
    } catch (error) { controller.abort(); await pending; throw error; }
    controller.abort(); const summary = await pending;
    expect(summary.state, JSON.stringify(summary)).toBe('paused');
    expect(value.contacts('metadata')).toHaveLength(1); expect(value.contacts('exec')).toEqual([]);
    expect(value.status().attempts).toEqual([]);
    const pid = value.contacts('metadata')[0]!.pid!;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(value.pendingPath)).toBe(false);
    const overview = readUniverseOverview(value);
    expect(overview.universes[0]!.activeRun).toBeNull();
    expect(value.trial()).toMatchObject({ selected: false, artifact: null,
      generation: { requestStarted: false, resource: { dispatch: 'not-started', taskId: null } } });
    expect(readUniverseCampaign('quota-campaign', value).owner).toBeNull();
    privateBoundaries(value);
  });
});
