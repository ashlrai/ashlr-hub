/** Real scoped HTTP/probe/process lifecycle, using only an inert test-owned native wrapper. */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import type { ResourceConsoleSnapshot } from '../src/core/resources/console-types.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import * as verify from '../src/core/run/verify-commands.js';
import * as accountProbe from '../src/core/resources/codex-account-probe.js';

const EMAIL = 'private-quota-fixture@example.invalid';
const HINT = digest(canonical({ schemaVersion: 1, type: 'chatgpt', email: EMAIL, planType: 'pro' }));
let directory: string;
const handles: ResourceConsoleServerHandle[] = [];
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-quota-http-test-'))); });
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true });
});
function save(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }

function fixture(mode: 'ready' | 'failed' | 'unknown' | 'exhausted' | 'held' = 'ready') {
  const script = join(directory, 'native-fixture.cjs'); const log = join(directory, 'native-log.jsonl');
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(script, `
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const mode = ${JSON.stringify(mode)};
const writeLog = (value) => fs.appendFileSync(log, JSON.stringify(value) + '\\n', {mode:0o600});
writeLog({kind:'start',pid:process.pid,argv:process.argv.slice(2)});
if (process.argv[2] !== 'app-server') { writeLog({kind:'unexpected-task'}); process.exit(29); }
const reader = readline.createInterface({input:process.stdin});
const write = (id,result) => process.stdout.write(JSON.stringify({id,result}) + '\\n');
reader.on('line', (line) => {
 const row=JSON.parse(line); writeLog({kind:'request',method:row.method});
 if (row.method==='initialized') return;
 if (row.method==='initialize') { write(row.id,{codexHome:'/private/not-real-auth',userAgent:'fixture',platformFamily:'unix',platformOs:'macos'});return; }
 if (row.method==='account/read') {
  if (mode==='failed') {process.stdout.write(JSON.stringify({id:row.id,error:{code:-1,message:'PRIVATE_NATIVE_ERROR'}})+'\\n');return;}
  write(row.id,{requiresOpenaiAuth:true,account:{type:'chatgpt',email:${JSON.stringify(EMAIL)},planType:'pro'}});return;
 }
 if (row.method==='account/rateLimits/read') {
  if(mode==='held'){setInterval(()=>{},1000);return;}
  const resetsAt=Math.floor(Date.now()/1000)+3600;
  write(row.id,{rateLimitsByLimitId:mode==='unknown'?{}:{codex:{limitId:'codex',primary:{usedPercent:mode==='exhausted'?100:25,resetsAt},secondary:{usedPercent:40,resetsAt:resetsAt+86400}}}});return;
 }
 writeLog({kind:'unexpected-method',method:row.method}); process.exit(31);
});
reader.on('close',()=>{writeLog({kind:'close',pid:process.pid});});
`, { mode: 0o600 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'quota-http-fixture', workers: [{ id: 'codex-a', provider: 'codex', model: 'inert-fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true }] };
  const bindings: ResourceBinding[] = [{ workerId: 'codex-a', capacityKey: 'fixture-subscription', kind: 'native-cli', command: [process.execPath, script] }];
  const options: ResourceConsoleServerOptions = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json') };
  const quotaConfigFile = join(directory, 'quota.json');
  save(options.poolFile, pool); save(options.bindingsFile, bindings);
  const writeBase = () => save(options.observationsFile, [{ workerId: 'codex-a', observedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'ready', retryAfter: null,
    windows: [{ id: 'codex_codex_primary', usedPercent: 0, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      { id: 'codex_codex_secondary', usedPercent: 0, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] }]);
  writeBase();
  save(quotaConfigFile, { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
    workers: [{ workerId: 'codex-a', accountHint: HINT, bucketIds: ['codex'] }] });
  function events(): Array<{ kind: string; method?: string; pid?: number; argv?: string[] }> {
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
  const start = async (extra: Partial<ResourceConsoleServerOptions> = {}) => {
    const handle = await startResourceConsoleServer({ ...options, ...extra }); handles.push(handle); return handle;
  };
  return { options, quotaConfigFile, script, log, workspace, writeBase, events, start };
}
async function http(handle: ResourceConsoleServerHandle, path = '/api/resources', method = 'GET', value?: unknown) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method, agent: false,
      headers: { 'x-ashlr-token': method === 'GET' ? handle.readToken : handle.controlToken!,
        ...(value === undefined ? {} : { 'content-type': 'application/json' }) } }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(10_000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
async function snapshot(handle: ResourceConsoleServerHandle): Promise<ResourceConsoleSnapshot> {
  const response = await http(handle); expect(response.status).toBe(200); return JSON.parse(response.text);
}
async function collected(handle: ResourceConsoleServerHandle, status: string): Promise<ResourceConsoleSnapshot> {
  let result!: ResourceConsoleSnapshot;
  await vi.waitFor(async () => { result = await snapshot(handle); expect(result.quotaRefresh?.workers[0]?.status).toBe(status); }, { timeout: 8000 });
  return result;
}

describe('explicit foreground quota collection through the scoped console', () => {
  it('does not probe or initialize state until the explicit quota option is supplied', async () => {
    const f = fixture(); const view = await f.start(); const result = await snapshot(view);
    expect(result.quotaRefresh).toBeUndefined(); expect(f.events()).toEqual([]); expect(existsSync(f.options.root)).toBe(false);
    await view.close(); const enabled = await f.start({ quotaConfigFile: f.quotaConfigFile });
    await collected(enabled, 'observed'); expect(f.events().filter((event) => event.kind === 'start')).toHaveLength(1);
    expect(enabled.scope.quotaRefreshEnabled).toBe(true); expect(enabled.scope.readOnly).toBe(true);
  });

  it('publishes real captured quota and bounded metadata, never native identity/path payloads', async () => {
    const f = fixture(); const original = readFileSync(f.options.observationsFile);
    const handle = await f.start({ quotaConfigFile: f.quotaConfigFile }); const result = await collected(handle, 'observed');
    expect(result.sourceState).toBe('healthy'); expect(result.plan?.selectedWorkerId).toBe('codex-a');
    expect(result.observations[0]?.windows.map((row) => row.usedPercent)).toEqual([25, 40]);
    expect(result.quotaRefresh?.workers[0]).toMatchObject({ workerId: 'codex-a', reason: 'managed-quota-observed' });
    const text = JSON.stringify(result);
    for (const privateValue of [EMAIL, HINT, f.script, 'codexHome', 'accountHint', 'PRIVATE_NATIVE_ERROR']) expect(text).not.toContain(privateValue);
    expect(readFileSync(f.options.observationsFile)).toEqual(original);
    expect(f.events().filter((event) => event.kind === 'request').map((event) => event.method)).toEqual([
      'initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read']);
  });

  it('repeated authenticated HTTP reads never create another metadata process', async () => {
    const f = fixture(); const handle = await f.start({ quotaConfigFile: f.quotaConfigFile }); await collected(handle, 'observed');
    await Promise.all(Array.from({ length: 8 }, () => snapshot(handle)));
    expect(f.events().filter((event) => event.kind === 'start')).toHaveLength(1);
  });

  it.each(['failed', 'unknown', 'exhausted'] as const)('blocks new tasks on %s metadata despite a newer operator zero and unknown-quota opt-in', async (mode) => {
    const f = fixture(mode); const handle = await f.start({ quotaConfigFile: f.quotaConfigFile, execute: true, workspace: f.workspace });
    const evidence = await collected(handle, mode === 'failed' ? 'failed' : 'observed');
    expect(evidence.plan?.selectedWorkerId).toBeNull();
    f.writeBase();
    const response = await http(handle, '/api/resources/tasks', 'POST', { id: 'must-stay-queued', prompt: 'Inert fixture must not execute.',
      allowedWorkerIds: ['codex-a'], mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 64 });
    expect(response.status).toBe(202);
    await new Promise((done) => setTimeout(done, 1100));
    const queued = await snapshot(handle);
    expect(queued.supervisor?.jobs[0]).toMatchObject({ id: 'must-stay-queued', state: 'queued', workerId: null });
    expect(queued.plan?.selectedWorkerId).toBeNull(); expect(queued.counts.total).toBe(0);
    expect(f.events().some((event) => event.kind === 'unexpected-task')).toBe(false);
    expect(f.events().filter((event) => event.kind === 'start')).toHaveLength(1);
  });

  it('a second same-root console remains observable without collecting and clean close releases ownership', async () => {
    const f = fixture(); const first = await f.start({ quotaConfigFile: f.quotaConfigFile }); await collected(first, 'observed');
    const blocked = await f.start({ quotaConfigFile: f.quotaConfigFile });
    expect((await snapshot(blocked)).metadataCollector).toMatchObject({ state: 'blocked', reasonCode: 'collector-owned' });
    expect((await snapshot(blocked)).plan?.selectedWorkerId).toBeNull(); await blocked.close();
    expect(f.events().filter((event) => event.kind === 'start')).toHaveLength(1);
    await first.close();
    const second = await f.start({ quotaConfigFile: f.quotaConfigFile }); await collected(second, 'observed');
    expect(f.events().filter((event) => event.kind === 'start')).toHaveLength(2);
  });

  it('rejects quota control inside the writable workspace before collection', async () => {
    const f = fixture(); const inside = join(f.workspace, 'quota.json');
    writeFileSync(inside, readFileSync(f.quotaConfigFile), { mode: 0o600 });
    await expect(f.start({ quotaConfigFile: inside, execute: true, workspace: f.workspace })).rejects.toThrow(/outside the writable workspace/);
    expect(f.events()).toEqual([]); expect(existsSync(f.options.root)).toBe(false);
  });

  it('pre-aborted startup and invalid pinned configuration are inert', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.start({ quotaConfigFile: f.quotaConfigFile, signal: controller.signal })).rejects.toThrow(/cancelled/);
    const config = JSON.parse(readFileSync(f.quotaConfigFile, 'utf8')); config.poolDigest = '0'.repeat(64); save(f.quotaConfigFile, config);
    await expect(f.start({ quotaConfigFile: f.quotaConfigFile })).rejects.toThrow(/Invalid resource quota/);
    expect(f.events()).toEqual([]); expect(existsSync(f.options.root)).toBe(false);
  });

  it('invalid base evidence is refused before native collection, not replaced with healthy metadata', async () => {
    const f = fixture(); appendFileSync(f.options.observationsFile, ' invalid');
    await expect(f.start({ quotaConfigFile: f.quotaConfigFile })).rejects.toThrow();
    expect(f.events()).toEqual([]); expect(existsSync(f.options.root)).toBe(false);
  });

  it('close awaits the active owned metadata process before releasing the collector lock', async () => {
    const original = verify.runVerifySubprocessAsync;
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation((argv, options) =>
      original(argv, { ...options, _terminationGraceMs: 75, _terminationDrainMs: 150 }));
    const f = fixture('held'); const handle = await f.start({ quotaConfigFile: f.quotaConfigFile });
    await vi.waitFor(() => expect(f.events().some((event) => event.method === 'account/rateLimits/read')).toBe(true));
    const pid = f.events().find((event) => event.kind === 'start')!.pid!;
    let settled = false; const closing = handle.close().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); await closing;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(f.options.root, '.resource-quota-refresh.lock'))).toBe(false);
    expect(f.events().filter((event) => event.kind === 'start')).toHaveLength(1);
  });

  it('uncertain native cleanup leaves a durable fence and refuses a successor without another probe', async () => {
    const f = fixture();
    const probe = vi.spyOn(accountProbe, 'probeCodexResourceAccount').mockImplementation(async (options) => ({
      schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId,
      poolDigest: digest(canonical({ pool: options.pool, bindings: options.bindings })),
      status: 'uncertain', reason: 'probe-termination-uncertain', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      accountHint: null, planType: null, observation: null,
    }));
    const handle = await f.start({ quotaConfigFile: f.quotaConfigFile }); await collected(handle, 'uncertain');
    await expect(handle.close()).rejects.toThrow(/shutdown uncertain/);
    const fence = join(f.options.root, '.resource-quota-refresh-pending.json');
    expect(existsSync(fence)).toBe(true);
    const contents = readFileSync(fence, 'utf8');
    expect(contents).not.toContain(HINT); expect(contents).not.toContain(EMAIL); expect(contents).not.toContain(f.script);
    const blocked = await f.start({ quotaConfigFile: f.quotaConfigFile });
    expect((await snapshot(blocked)).metadataCollector).toMatchObject({ state: 'blocked', reasonCode: 'reconciliation-required' });
    expect((await snapshot(blocked)).plan?.selectedWorkerId).toBeNull(); await blocked.close();
    expect(readFileSync(fence, 'utf8')).toBe(contents);
    expect(probe).toHaveBeenCalledTimes(1); expect(f.events()).toEqual([]);
  });
});
