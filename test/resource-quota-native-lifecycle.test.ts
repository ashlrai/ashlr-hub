/** Real private lease -> native protocol fixture -> process-group settlement.
 * No provider executable, credentials, network, model call or injected probe.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Script } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { refreshResourceQuotaOnce, ResourceQuotaRefreshError } from '../src/core/resources/quota-refresh.js';
import { readResourceQuotaScopeAccess, setResourcePoolAllocation, setResourceQuotaScopeAccess } from '../src/core/resources/pool-runtime.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-native-lifecycle-'))); });
afterEach(async () => {
  // Fixture descendants exit themselves. Never signal a recycled numeric PID.
  const settled = () => {
    const file = join(root, 'descendants.jsonl');
    if (!existsSync(file)) return true;
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return rows.filter(row => row.phase === 'started').every(row => rows.some(other => other.pid === row.pid && other.phase === 'finished'));
  };
  const until = Date.now() + 5_000;
  while (!settled() && Date.now() < until) await delay(25);
  if (!settled()) throw new Error('Fixture descendant has not settled; retain directory');
  rmSync(root, { recursive: true, force: true });
});

function fixture(descendantMs = 350) {
  const script = join(root, 'native.cjs'), log = join(root, 'requests.jsonl');
  const account = { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'pro' } };
  const hint = digest(canonical({ schemaVersion: 1, ...account.account }));
  const quota = { rateLimitsByLimitId: Object.fromEntries(['codex', 'codex_bengalfox'].map(id => [id,
    { limitId: id, primary: { usedPercent: id === 'codex' ? 35 : 2, windowDurationMins: 300,
      resetsAt: Math.floor(Date.now() / 1_000) + 3_600 } }])) };
  const descendants = join(root, 'descendants.jsonl');
  const descendant = `const finish=()=>require('node:fs').appendFileSync(${JSON.stringify(descendants)},JSON.stringify({pid:process.pid,phase:'finished'})+'\\n');const watchdog=setTimeout(()=>{finish();process.exit(1);},5000);process.once('message',()=>{clearTimeout(watchdog);setTimeout(finish,${descendantMs});});process.send('ready');`;
  new Script(descendant); // Validate nested fixture source before spawning anything.
  writeFileSync(script, `
const fs=require('node:fs'), {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc'],detached:false});
fs.appendFileSync(${JSON.stringify(descendants)},JSON.stringify({pid:child.pid,phase:'started'})+'\\n');
let ready=false, sendInitialize;
child.once('message',()=>{ready=true;if(sendInitialize)sendInitialize();});
const reader=require('node:readline').createInterface({input:process.stdin});
reader.on('line', line=>{
 const request=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:request.method})+'\\n');
 if(request.method==='initialized')return;
 const result=request.id===1?{codexHome:'/private/inert-home',userAgent:'inert-fixture',platformFamily:'unix',platformOs:'macos'}:
 request.id===3?${JSON.stringify(quota)}:${JSON.stringify(account)};
 const send=()=>process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
 if(request.id===1&&!ready)sendInitialize=send;else send();
});
reader.on('close',()=>{child.send('release');child.disconnect();child.unref();});
`, { mode: 0o600 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'native-lifecycle', workers: [
    { id: 'general', provider: 'codex', model: 'gpt-6-astra', quotaScope: 'codex-general-v1', maxConcurrent: 1,
      maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 },
    { id: 'spark', provider: 'codex', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1', maxConcurrent: 1,
      maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 2, reservePercent: 10 },
  ] };
  const bindings: ResourceBinding[] = pool.workers.map(worker => ({ workerId: worker.id, capacityKey: 'personal',
    kind: 'native-cli', command: [process.execPath, script] }));
  const config = { schemaVersion: 1 as const, poolDigest: digest(canonical({ pool, bindings })), workers: pool.workers.map(worker => ({
    workerId: worker.id, accountHint: hint, bucketIds: [worker.id === 'spark' ? 'codex_bengalfox' : 'codex'],
  })) };
  return { pool, bindings, config, cwd: join(root, 'ledger'), observations: [], timeoutMs: 15_000, log };
}

describe.skipIf(process.platform === 'win32')('native quota lifecycle integration', () => {
  it('settles both scoped aliases through the real lease after short-lived native descendants exit', async () => {
    const { log, ...options } = fixture();
    setResourcePoolAllocation(options.cwd, options.pool, options.bindings, 75, 0);
    setResourceQuotaScopeAccess(options.cwd, options.pool, options.bindings,
      [{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }], 0);
    const state = readFileSync(join(options.cwd, 'pool-state.json'));
    const result = await refreshResourceQuotaOnce(options);
    expect(result.observations.map(row => row.workerId)).toEqual(['general', 'spark']);
    expect(result.observations.map(row => row.windows[0]?.usedPercent)).toEqual([35, 2]);
    expect(result.unavailableWorkerIds).toEqual([]);
    expect(result.quotaUnavailableWorkerIds).toEqual([]);
    expect(existsSync(join(options.cwd, '.resource-quota-refresh-pending.json'))).toBe(false);
    expect(existsSync(join(options.cwd, '.resource-quota-refresh.lock'))).toBe(false);
    const activity = JSON.parse(readFileSync(join(options.cwd, '.resource-quota-refresh-activity.json'), 'utf8'));
    expect(activity).toMatchObject({ schemaVersion: 2, sequence: 10, reservations: [] });
    expect(readFileSync(join(options.cwd, 'pool-state.json'))).toEqual(state);
    expect(readResourceQuotaScopeAccess(options.cwd, options.pool, options.bindings).exclusions)
      .toEqual([{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }]);
    const methods = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).method);
    expect(methods).toEqual(Array(2).fill(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read']).flat());
    expect(JSON.stringify(result)).not.toMatch(/fixture@example|inert-home|ownerToken|requests.jsonl/);
  });

  it('retains real lease custody and diagnostics without starting another alias when the group exceeds the cleanup bound', async () => {
    const { log, ...options } = fixture(2_000);
    const error = await refreshResourceQuotaOnce(options).catch(error => error);
    expect(error).toBeInstanceOf(ResourceQuotaRefreshError);
    expect(error.workerDiagnostics).toEqual([{ workerId: 'general', probeStatus: 'uncertain', cleanupDiagnostics: {
      failure: 'group-exit-unconfirmed', processGroupSettlement: 'unconfirmed', timedOut: false, cancelled: false,
    } }]);
    expect(error).not.toHaveProperty('observations');
    expect(existsSync(join(options.cwd, '.resource-quota-refresh-pending.json'))).toBe(true);
    expect(existsSync(join(options.cwd, '.resource-quota-refresh.lock'))).toBe(false);
    const activity = JSON.parse(readFileSync(join(options.cwd, '.resource-quota-refresh-activity.json'), 'utf8'));
    expect(activity.sequence).toBe(3);
    expect(activity.reservations).toEqual([{ id: expect.any(String), phase: 'registered', pgid: expect.any(Number) }]);
    const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).method);
    expect(requests.filter(method => method === 'initialize')).toHaveLength(1);
    expect(JSON.stringify(error)).not.toMatch(/fixture@example|inert-home|ownerToken|requests.jsonl/);
  });
});
