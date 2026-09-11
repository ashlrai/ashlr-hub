/** Private ledgers and inert local native-protocol children; never real accounts/providers. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { resourceQuotaBuckets } from '../src/core/resources/quota-scope.js';
import { validateResourceQuotaScopeExclusions, type ResourceQuotaScopeExclusion } from '../src/core/resources/quota-scope-access.js';
import { readResourceQuotaScopeAccess, resourcePoolStatus, runResourceTask, setResourcePoolAllocation,
  setResourceQuotaScopeAccess, setResourceWorkerAccess, type ResourceTask } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution } from '../src/core/resources/pool-evolution.js';
import { startResourceConsoleServer } from '../src/core/web/resource-console-server.js';
import * as readers from '../src/core/web/resource-console-reads.js';
import type { ResourceConsoleSnapshot } from '../src/core/resources/console-types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const reservedGeneral: ResourceQuotaScopeExclusion[] = [{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }];
function fixture(options: { unknownAlias?: boolean; maxTasks?: number; held?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scope-access-boundary-'))); const root = join(base, 'ledger');
  const cwd = join(base, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  const calls = join(base, 'calls.txt'); const release = join(base, 'release'); const script = join(base, 'inert.mjs');
  writeFileSync(script, `import{appendFileSync,existsSync}from'node:fs';process.stdin.resume();process.stdin.on('end',()=>{
appendFileSync(${JSON.stringify(calls)},'called\\n');const done=()=>{
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'INERT_SCOPE_RESULT'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));};
if(${options.held === true}){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);done();}},20);}else done();});`);
  const bounds = { maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: options.maxTasks ?? 10, taskWindowMs: 60_000, priority: 1 };
  const pool = validateResourcePool({ schemaVersion: 1, id: 'scope-access', workers: [
    { ...bounds, id: 'general', provider: 'codex', model: 'gpt-6-astra', quotaScope: 'codex-general-v1' },
    { ...bounds, id: 'spark', provider: 'codex', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
    ...(options.unknownAlias ? [{ ...bounds, id: 'legacy', provider: 'codex', model: 'gpt-6-astra' }] : []),
  ] });
  const bindings = validateResourceBindings(pool.workers.map(worker => ({ workerId: worker.id, capacityKey: 'personal',
    kind: 'native-cli', command: [process.execPath, script] })), pool);
  const observations: ResourceObservation[] = pool.workers.map(worker => ({ workerId: worker.id,
    observedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    health: 'ready', retryAfter: null, windows: [{ id: `codex_${resourceQuotaBuckets(worker)?.[0] ?? 'codex'}_primary`,
      usedPercent: 20, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }));
  const task = (id: string, allowedWorkerIds = ['general', 'spark']): ResourceTask => ({ schemaVersion: 1, id,
    allowedWorkerIds, cwd, prompt: 'Inert scope test', mode: 'read-only', timeoutMs: 10_000, maxOutputTokens: 100 });
  const pending: Promise<unknown>[] = [];
  const run = (id: string, allowedWorkerIds?: string[], evidence = false) => {
    const result = runResourceTask({ root, pool, bindings, observations, task: task(id, allowedWorkerIds),
      ...(evidence ? { readAdmissionEvidence: () => ({ observations, unavailableWorkerIds: [], quotaUnavailableWorkerIds: [] }) } : {}) });
    pending.push(result); return result;
  };
  const unblock = () => writeFileSync(release, 'release', { mode: 0o600 });
  cleanups.push(async () => { unblock(); await Promise.allSettled(pending); rmSync(base, { recursive: true, force: true }); });
  return { base, root, cwd, pool, bindings, observations, task, run, unblock,
    count: () => existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').length - 1 : 0,
    stateFile: join(root, 'pool-state.json'),
    status: () => resourcePoolStatus(root, pool, bindings, observations),
    read: () => readResourceQuotaScopeAccess(root, pool, bindings),
    set: (exclusions = reservedGeneral, revision = 0) => setResourceQuotaScopeAccess(root, pool, bindings, exclusions, revision) };
}
async function httpFixture(controls = true, cacheFirstRead = false) {
  const f = fixture({ unknownAlias: true });
  const poolFile = join(f.base, 'pool.json'); const bindingsFile = join(f.base, 'bindings.json'); const observationsFile = join(f.base, 'observations.json');
  for (const [file, value] of [[poolFile, f.pool], [bindingsFile, f.bindings], [observationsFile, f.observations]] as const) {
    writeFileSync(file, canonical(value), { mode: 0o600 });
  }
  setResourcePoolAllocation(f.root, f.pool, f.bindings, 75, 0);
  if (cacheFirstRead) {
    const original = readers.createResourceConsoleReader;
    vi.spyOn(readers, 'createResourceConsoleReader').mockImplementation((...args) => {
      const reader = original(...args); let cached: Awaited<ReturnType<typeof reader.snapshot>> | undefined;
      return { ...reader, snapshot: async (...readArgs) => cached ??= await reader.snapshot(...readArgs) };
    });
  }
  const server = await startResourceConsoleServer({ root: f.root, poolFile, bindingsFile, observationsFile, allocationControls: controls });
  cleanups.push(() => server.close());
  const post = (body: unknown, token = server.controlToken ?? '', origin: string | null = server.url, suffix = '') => fetch(`${server.url}/api/resources/quota-scope-access${suffix}`, {
    method: 'POST', headers: { 'X-Ashlr-Token': token, 'Content-Type': 'application/json', ...(origin === null ? {} : { Origin: origin }) }, body: JSON.stringify(body),
  });
  const get = async () => {
    const response = await fetch(`${server.url}/api/resources`, { headers: { 'X-Ashlr-Token': server.readToken } });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    return await response.json() as ResourceConsoleSnapshot;
  };
  return { ...f, server, post, get };
}

describe('independent quota-scope access boundaries', () => {
  it('keeps absent and legacy state read-only and byte-compatible', async () => {
    const f = fixture(); expect(f.read()).toEqual({ exclusions: [], revision: 0, updatedAt: null });
    expect(f.status().quotaScopeAccess).toEqual(f.read()); expect(existsSync(f.root)).toBe(false);
    await f.run('legacy', ['general']); const before = readFileSync(f.stateFile);
    expect(JSON.parse(before.toString())).not.toHaveProperty('quotaScopeAccess'); expect(f.read().revision).toBe(0);
    expect(readFileSync(f.stateFile)).toEqual(before); expect(f.count()).toBe(1);
  });
  it.each([null, {}, [{ capacityKey: 'missing', quotaScope: 'codex-general-v1' }],
    [{ capacityKey: 'personal', quotaScope: 'unknown' }], [...reservedGeneral, ...reservedGeneral],
    [{ ...reservedGeneral[0], enabled: true }]])('rejects malformed or unenrolled exclusions without store creation %#', value => {
    const f = fixture(); expect(() => validateResourceQuotaScopeExclusions(value, f.pool, f.bindings)).toThrow();
    expect(() => f.set(value as ResourceQuotaScopeExclusion[])).toThrow(); expect(existsSync(f.root)).toBe(false); expect(f.count()).toBe(0);
  });
  it('never evaluates a policy getter and detaches accepted caller data', () => {
    const f = fixture(); const getter = vi.fn(() => 'personal'); const row = { quotaScope: 'codex-general-v1' };
    Object.defineProperty(row, 'capacityKey', { enumerable: true, get: getter });
    expect(() => f.set([row as ResourceQuotaScopeExclusion])).toThrow(); expect(getter).not.toHaveBeenCalled();
    const supplied = structuredClone(reservedGeneral); const saved = f.set(supplied); supplied.splice(0); saved.exclusions.splice(0);
    expect(f.read().exclusions).toEqual(reservedGeneral); expect(f.count()).toBe(0);
  });
  it('excludes General but executes an explicit Spark request on the unchanged shared capacity', async () => {
    const f = fixture(); const policy = f.set(); const denied = await f.run('reserved-general', ['general']);
    expect(denied.receipt).toBeNull(); expect(f.count()).toBe(0);
    expect(denied.plan?.exclusions.find(row => row.workerId === 'general')?.reasons).toContain('operator-quota-scope-excluded');
    const spark = await f.run('permitted-spark', ['spark']);
    expect(spark.receipt).toMatchObject({ workerId: 'spark', capacityKey: 'personal', status: 'completed' });
    expect(f.count()).toBe(1); expect(f.read()).toEqual(policy); expect(f.status().observations).toEqual(f.observations);
  });
  it('withholds unknown aliases without feeding their policy exclusion back into independent Spark evidence', async () => {
    const f = fixture({ unknownAlias: true }); f.set();
    expect(f.status().plan.candidates.map(row => row.workerId)).toEqual(['spark']);
    expect((await f.run('legacy-denied', ['legacy'], true)).receipt).toBeNull();
    const result = await f.run('spark-with-recheck', ['general', 'spark', 'legacy'], true);
    expect(result.receipt).toMatchObject({ workerId: 'spark', status: 'completed', capacityKey: 'personal' }); expect(f.count()).toBe(1);
  });
  it.each(['account-pause', 'zero-ceiling', 'account-health', 'account-retry', 'spark-quota', 'spark-stale'])('does not override %s', async kind => {
    const f = fixture(); const policy = f.set();
    if (kind === 'account-pause') setResourceWorkerAccess(f.root, f.pool, f.bindings, ['general'], 0);
    if (kind === 'zero-ceiling') setResourcePoolAllocation(f.root, f.pool, f.bindings, 0, 0);
    if (kind === 'account-health') f.observations[0]!.health = 'unavailable';
    if (kind === 'account-retry') f.observations[0]!.retryAfter = new Date(Date.now() + 60_000).toISOString();
    if (kind === 'spark-quota') f.observations[1]!.windows[0]!.usedPercent = 100;
    if (kind === 'spark-stale') { f.observations[1]!.observedAt = new Date(Date.now() - 120_000).toISOString(); f.observations[1]!.expiresAt = new Date(Date.now() - 60_000).toISOString(); }
    expect((await f.run('still-denied', ['spark'], true)).receipt).toBeNull(); expect(f.count()).toBe(0); expect(f.read()).toEqual(policy);
  });
  it('shares one in-flight slot and keeps an already reserved attempt alive after exclusion', async () => {
    const f = fixture({ held: true }); const first = f.run('already-reserved', ['general']);
    await vi.waitFor(() => expect(f.count()).toBe(1)); const policy = f.set();
    expect((await f.run('spark-no-extra-slot', ['spark'])).receipt).toBeNull(); expect(f.count()).toBe(1);
    expect(f.status().plan.exclusions.find(row => row.workerId === 'spark')?.reasons).toContain('concurrency-exhausted');
    f.unblock(); expect((await first).receipt?.status).toBe('completed'); expect(f.read()).toEqual(policy);
    expect((await f.run('spark-after-settlement', ['spark'])).receipt?.status).toBe('completed'); expect(f.count()).toBe(2);
  });
  it('does not reset the account task allowance when excluding General', async () => {
    const f = fixture({ maxTasks: 1 }); await f.run('first', ['general']); f.set();
    const denied = await f.run('second', ['spark']); expect(denied.receipt).toBeNull(); expect(f.count()).toBe(1);
    expect(denied.plan?.exclusions.find(row => row.workerId === 'spark')?.reasons).toContain('operator-task-cap-reached');
  });
  it('keeps scope CAS independent of account pause CAS and preserves both through old setters', () => {
    const f = fixture(); const scope = f.set(); const before = readFileSync(f.stateFile);
    expect(() => f.set([], 0)).toThrow(/revision/); expect(readFileSync(f.stateFile)).toEqual(before);
    const pause = setResourceWorkerAccess(f.root, f.pool, f.bindings, ['general'], 0); expect(f.read()).toEqual(scope);
    const cleared = f.set([], scope.revision); expect(f.status().workerAccess).toEqual(pause); expect(cleared.revision).toBe(2);
    setResourceWorkerAccess(f.root, f.pool, f.bindings, [], pause.revision); expect(f.read()).toEqual(cleared);
    expect(f.count()).toBe(0);
  });
  it('preserves old receipts and policy across restart and additive migration, including newly enrolled aliases', async () => {
    const f = fixture(); const first = await f.run('old-general', ['general']); const policy = f.set();
    const nextPool = validateResourcePool({ ...f.pool, workers: [...f.pool.workers, { ...f.pool.workers[0], id: 'general-alias', model: 'gpt-5.6-sol' }] });
    const nextBindings = validateResourceBindings([...f.bindings, { ...f.bindings[0], workerId: 'general-alias' }], nextPool);
    const options = { root: f.root, workspace: f.cwd, pool: f.pool, bindings: f.bindings, nextPool, nextBindings };
    const plan = checkResourcePoolEvolution(options); const before = readFileSync(f.stateFile); expect(f.read()).toEqual(policy); expect(readFileSync(f.stateFile)).toEqual(before);
    applyResourcePoolEvolution({ ...options, expectedPlanDigest: plan.planDigest });
    expect(readResourceQuotaScopeAccess(f.root, nextPool, nextBindings)).toEqual(policy);
    const status = resourcePoolStatus(f.root, nextPool, nextBindings, [...f.observations, { ...f.observations[0]!, workerId: 'general-alias' }]);
    expect(status.attempts).toEqual([first.receipt]); expect(status.plan.candidates.map(row => row.workerId)).toEqual(['spark']);
    expect(f.count()).toBe(1); expect(canonical(JSON.parse(readFileSync(f.stateFile, 'utf8')).quotaScopeAccess)).toBe(canonical(policy));
  });
  it('requires control privilege and an explicit matching Origin without any unauthorized ledger writes', async () => {
    const f = await httpFixture(); const before = readFileSync(f.stateFile); const input = { exclusions: reservedGeneral, expectedRevision: 0 };
    expect((await f.post(input, '')).status).toBe(401);
    expect((await f.post(input, f.server.readToken)).status).toBe(401);
    expect((await f.post(input, f.server.controlToken!, null)).status).toBe(403);
    expect((await f.post(input, f.server.controlToken!, 'https://example.invalid')).status).toBe(403);
    expect((await f.post(input, f.server.controlToken!, f.server.url, '?unexpected=1')).status).toBe(400);
    expect((await f.post({ ...input, unknown: true })).status).toBe(400);
    expect((await f.post({ exclusions: [{ capacityKey: 'other', quotaScope: 'codex-general-v1' }], expectedRevision: 0 })).status).toBe(400);
    expect(readFileSync(f.stateFile)).toEqual(before); expect(f.count()).toBe(0);
  });
  it('refuses scope mutations when allocation controls are not enabled', async () => {
    const f = await httpFixture(false); const before = readFileSync(f.stateFile);
    expect((await f.post({ exclusions: reservedGeneral, expectedRevision: 0 }, f.server.readToken)).status).toBe(403);
    expect(readFileSync(f.stateFile)).toEqual(before); expect(f.count()).toBe(0);
  });
  it('reapplies fresh exact scope policy to an intentionally cached reader without spreading an unknown-alias veto', async () => {
    const f = await httpFixture(true, true); const initial = await f.get();
    expect(initial.plan?.candidates.map(row => row.workerId).sort()).toEqual(['general', 'legacy', 'spark']);
    const response = await f.post({ exclusions: reservedGeneral, expectedRevision: 0 });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ quotaScopeAccess: { exclusions: reservedGeneral, revision: 1, updatedAt: expect.any(String) } });
    const current = await f.get(); expect(current.plan?.candidates.map(row => row.workerId)).toEqual(['spark']);
    expect(current.quotaScopeAccess).toEqual(f.read()); expect(current.observations).toEqual(initial.observations);
    expect(current.plan?.exclusions.find(row => row.workerId === 'legacy')?.reasons).toContain('operator-quota-scope-excluded');
    const before = readFileSync(f.stateFile); expect((await f.post({ exclusions: [], expectedRevision: 0 })).status).toBe(409);
    expect(readFileSync(f.stateFile)).toEqual(before);
    setResourceWorkerAccess(f.root, f.pool, f.bindings, ['general'], 0);
    expect((await f.get()).plan?.candidates).toEqual([]);
    expect((await f.post({ exclusions: [], expectedRevision: 1 })).status).toBe(200);
    expect((await f.get()).plan?.candidates).toEqual([]); expect(f.count()).toBe(0);
  });
});
