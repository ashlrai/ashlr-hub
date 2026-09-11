/** Independent private evolution fixtures: loopback HTTP and an inert native protocol child only. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourcePoolSupervisor, previewResourceConsolePoolEvolution, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import { resourcePoolConfigSnapshot, validateResourcePoolAdditiveEvolution, validateResourcePoolConfigHistory } from '../src/core/resources/pool-evolution-policy.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution } from '../src/core/resources/pool-evolution.js';
import * as privateWrites from '../src/core/util/private-file-write.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function tree(root: string): Record<string, unknown> {
  if (!existsSync(root)) return { missing: true };
  const entries: Record<string, unknown> = {};
  const visit = (file: string, path: string): void => {
    const stat = lstatSync(file, { bigint: true }); expect(stat.isSymbolicLink()).toBe(false);
    entries[path] = { mode: String(stat.mode), inode: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      ...(stat.isFile() ? { digest: digest(readFileSync(file)) } : {}) };
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name), `${path}/${name}`);
  };
  visit(root, ''); return entries;
}
function textFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap(name => {
    const file = join(root, name); const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Unexpected fixture symlink');
    return stat.isDirectory() ? textFiles(file) : [readFileSync(file, 'utf8')];
  });
}
async function fixture(personalTaskLimit = 10) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pool-evolution-boundary-'))); const root = join(base, 'ledger');
  const workspace = join(base, 'project'); mkdirSync(workspace, { mode: 0o700 });
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end(JSON.stringify({ choices: [{ message: { content: 'PRIVATE_RETAINED_RESPONSE' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const owners: ResourcePoolSupervisor[] = [];
  cleanups.push(async () => {
    for (const owner of owners) await owner.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(base, { recursive: true, force: true });
  });
  const nativeCalls = join(base, 'native-calls.txt'); const executable = join(base, 'native-fixture.mjs');
  writeFileSync(executable, `import{appendFileSync}from'node:fs';process.stdin.resume();process.stdin.on('end',()=>{
appendFileSync(${JSON.stringify(nativeCalls)},'invoked\\n');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'INERT_NATIVE_RESULT'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));});`);
  const local = { id: 'local', provider: 'local' as const, model: 'fixture', maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 100, taskWindowMs: 60_000, priority: 1 };
  const general = { id: 'general', provider: 'codex' as const, model: 'gpt-6-astra', maxConcurrent: 1, reservePercent: 25,
    maxTasksPerWindow: personalTaskLimit, taskWindowMs: 60_000, priority: 1 };
  const oldPool = validateResourcePool({ schemaVersion: 1, id: 'evolution-fixture', workers: [local, general] });
  const oldBindings = validateResourceBindings([
    { workerId: 'local', capacityKey: 'local-account', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` },
    { workerId: 'general', capacityKey: 'personal-account', kind: 'native-cli', command: [process.execPath, executable] },
  ], oldPool);
  const nextPool = validateResourcePool({ ...oldPool, workers: [local, { ...general, quotaScope: 'codex-general-v1' },
    { ...general, id: 'spark', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' }] });
  const nextBindings = validateResourceBindings([...oldBindings, { ...oldBindings[1], workerId: 'spark' }], nextPool);
  const observations = (next = false): ResourceObservation[] => (next ? nextPool : oldPool).workers.map(worker => ({
    workerId: worker.id, health: 'ready', retryAfter: null, observedAt: new Date(Date.now() - 100).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), windows: worker.provider === 'local' ? [] : [
      { id: worker.id === 'spark' ? 'codex_codex_bengalfox_primary' : 'codex_codex_primary', usedPercent: 20, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
  }));
  const start = async (next = false) => {
    const owner = await createResourcePoolSupervisor({ root, workspace, pool: next ? nextPool : oldPool,
      bindings: next ? nextBindings : oldBindings, projects: [], readObservations: () => observations(next), pollIntervalMs: 20 });
    owners.push(owner); return owner;
  };
  const task = (id: string, patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
    prompt: `PRIVATE_REQUEST_${id}`, retainHistory: true, allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 10_000, maxOutputTokens: 100, ...patch });
  return { base, root, workspace, oldPool, oldBindings, nextPool, nextBindings, observations, start, task, requests,
    nativeCount: () => existsSync(nativeCalls) ? readFileSync(nativeCalls, 'utf8').split('\n').length - 1 : 0,
    ledger: () => JSON.parse(readFileSync(join(root, 'pool-state.json'), 'utf8')),
    console: () => JSON.parse(readFileSync(join(root, 'resource-console-state.json'), 'utf8')) };
}
async function settled(owner: ResourcePoolSupervisor, id: string) {
  await vi.waitFor(() => expect(owner.snapshot().jobs.find(job => job.id === id)?.state).toBe('settled'), { timeout: 15_000 });
}
async function history(f: Awaited<ReturnType<typeof fixture>>, queued = false) {
  const owner = await f.start(); const first = f.task('parent'); owner.submit(first); await settled(owner, first.id);
  const parent = owner.history(first.id)!;
  const child = f.task('child', { parent: { taskId: first.id, expectedTranscriptDigest: parent.transcriptDigest! } });
  owner.submit(child); await settled(owner, child.id); const childHistory = owner.history(child.id)!;
  owner.setPaused(true); const waiting = f.task('waiting'); if (queued) owner.submit(waiting);
  await owner.close();
  return { first, child, waiting, parent, childHistory, receipts: f.ledger().attempts as unknown[], console: f.console() };
}
function options(f: Awaited<ReturnType<typeof fixture>>) {
  return { root: f.root, workspace: f.workspace, pool: f.oldPool, bindings: f.oldBindings, nextPool: f.nextPool, nextBindings: f.nextBindings };
}
function preview(f: Awaited<ReturnType<typeof fixture>>, value: unknown) {
  return previewResourceConsolePoolEvolution(value, { workspace: f.workspace, from: { pool: f.oldPool, bindings: f.oldBindings },
    to: { pool: f.nextPool, bindings: f.nextBindings }, configHistory: [resourcePoolConfigSnapshot(f.oldPool, f.oldBindings), resourcePoolConfigSnapshot(f.nextPool, f.nextBindings)] });
}
describe('resource pool additive evolution boundaries', () => {
  it('allows a scoped Spark alias only while retaining existing account bounds and configuration history', async () => {
    const f = await fixture(); const old = resourcePoolConfigSnapshot(f.oldPool, f.oldBindings); const next = resourcePoolConfigSnapshot(f.nextPool, f.nextBindings);
    expect(validateResourcePoolAdditiveEvolution(old, next)).toEqual({ addedWorkerIds: ['spark'], annotatedWorkerIds: ['general'] });
    expect(validateResourcePoolConfigHistory([old, next])).toEqual([old, next]); expect(f.requests).toHaveLength(0); expect(f.nativeCount()).toBe(0);
  });
  it.each(['remove-worker', 'change-model', 'change-binding', 'weaker-reserve', 'new-account-key'])('refuses %s instead of widening previous authority', async (mode) => {
    const f = await fixture(); const pool = structuredClone(f.nextPool); const bindings = structuredClone(f.nextBindings);
    if (mode === 'remove-worker') { pool.workers = pool.workers.filter(worker => worker.id !== 'local'); bindings.splice(0, 1); }
    if (mode === 'change-model') pool.workers[0]!.model = 'different';
    if (mode === 'change-binding' && bindings[1]?.kind === 'native-cli') bindings[1].command = [process.execPath, 'different-profile.mjs'];
    if (mode === 'weaker-reserve') pool.workers.find(worker => worker.id === 'spark')!.reservePercent = 1;
    if (mode === 'new-account-key') bindings.find(binding => binding.workerId === 'spark')!.capacityKey = 'invented-second-account';
    expect(() => validateResourcePoolAdditiveEvolution(resourcePoolConfigSnapshot(f.oldPool, f.oldBindings), resourcePoolConfigSnapshot(pool, bindings))).toThrow();
    expect(existsSync(f.root)).toBe(false); expect(f.requests).toHaveLength(0); expect(f.nativeCount()).toBe(0);
  });
  it('rejects altered or duplicated epoch snapshots without trusting their declared digests', async () => {
    const f = await fixture(); const old = resourcePoolConfigSnapshot(f.oldPool, f.oldBindings); const next = resourcePoolConfigSnapshot(f.nextPool, f.nextBindings);
    expect(() => validateResourcePoolConfigHistory([old, { ...next, poolDigest: old.poolDigest }])).toThrow();
    expect(() => validateResourcePoolConfigHistory([old, old])).toThrow();
    const getter = vi.fn(() => f.oldPool); const malicious = { ...old }; Object.defineProperty(malicious, 'pool', { enumerable: true, get: getter });
    expect(() => validateResourcePoolConfigHistory([malicious])).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('projects old completed and queued history without rewriting accepted identities or creating files', async () => {
    const f = await fixture(); const saved = await history(f, true); const before = tree(f.base);
    const next = preview(f, saved.console)!;
    expect(next.schemaVersion).toBe(5); expect(next.scopeDigest).toBe(saved.console.scopeDigest);
    expect(next.jobs).toEqual(saved.console.jobs); expect(next.paused).toBe(true);
    expect(next.originPoolDigest).toBe(resourcePoolConfigSnapshot(f.oldPool, f.oldBindings).poolDigest);
    expect(tree(f.base)).toEqual(before); expect(f.requests).toHaveLength(2); expect(f.nativeCount()).toBe(0);
    expect(preview(f, null)).toBeNull(); expect(tree(f.base)).toEqual(before);
  });
  it('checks without writes, upgrades exact history, and retries old IDs without broadening the old queue', async () => {
    const f = await fixture(); const saved = await history(f, true); const before = tree(f.base);
    const plan = checkResourcePoolEvolution(options(f));
    expect(plan).toMatchObject({ status: 'planned', preservedReceiptCount: 2, preservedJobCount: 3,
      heldQueuedIds: ['waiting'], addedWorkerIds: ['spark'], annotatedWorkerIds: ['general'], executionStarted: false, providerContacted: false });
    expect(checkResourcePoolEvolution(options(f))).toEqual(plan); expect(tree(f.base)).toEqual(before);
    expect(applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toMatchObject({ status: 'applied', disposition: 'created' });
    expect(f.ledger().attempts).toEqual(saved.receipts); expect(f.console().jobs).toEqual(saved.console.jobs);
    expect(f.console()).toMatchObject({ schemaVersion: 5, scopeDigest: saved.console.scopeDigest, paused: true });
    const owner = await f.start(true);
    expect(owner.history('parent')).toEqual(saved.parent); expect(owner.history('child')).toEqual(saved.childHistory);
    expect(owner.submit(saved.first).state).toBe('settled'); expect(owner.submit(saved.child).state).toBe('settled');
    expect(() => owner.submit(f.task('parent', { allowedWorkerIds: ['spark'] }))).toThrow();
    owner.setPaused(false);
    await vi.waitFor(() => expect(owner.snapshot().jobs.find(job => job.id === 'waiting')?.reason).toBe('pool-evolution-reenrollment-required'));
    expect(owner.snapshot().jobs.find(job => job.id === 'waiting')).toMatchObject({ state: 'queued', allowedWorkerIds: ['local'] });
    const nextChild = f.task('new-child', { parent: { taskId: 'child', expectedTranscriptDigest: saved.childHistory.transcriptDigest! } });
    owner.submit(nextChild); await settled(owner, nextChild.id);
    expect(owner.history(nextChild.id)?.context?.map(turn => turn.taskId)).toEqual(['parent', 'child']);
    expect(f.console().jobs.find((job: { id: string }) => job.id === nextChild.id)?.originPoolDigest).toBe(plan.toPoolDigest);
    expect(f.ledger().attempts.slice(0, 2)).toEqual(saved.receipts); expect(f.requests).toHaveLength(3); expect(f.nativeCount()).toBe(0);
    owner.deleteHistory('parent'); expect(owner.submit(saved.child).state).toBe('settled'); expect(owner.history('parent')).toBeNull();
    await owner.close(); const restarted = await f.start(true);
    expect(restarted.submit(saved.child).state).toBe('settled'); expect(restarted.history('parent')).toBeNull();
    expect(restarted.history('child')).toEqual(saved.childHistory); expect(f.requests).toHaveLength(3);
  });
  it('preserves account pause and allocation revisions so adding an alias grants no account permission', async () => {
    const f = await fixture(); const saved = await history(f);
    const allocation = setResourcePoolAllocation(f.root, f.oldPool, f.oldBindings, 0, 0);
    const access = setResourceWorkerAccess(f.root, f.oldPool, f.oldBindings, ['general'], 0);
    const plan = checkResourcePoolEvolution(options(f)); applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest });
    expect(f.ledger()).toMatchObject({ allocation, workerAccess: access, attempts: saved.receipts });
    const status = resourcePoolStatus(f.root, f.nextPool, f.nextBindings, f.observations(true));
    expect(status.allocation).toEqual(allocation); expect(status.workerAccess).toEqual(access);
    const owner = await f.start(true); owner.setPaused(false);
    owner.submit(f.task('spark-denied', { allowedWorkerIds: ['spark'] }));
    await vi.waitFor(() => expect(owner.snapshot().jobs.find(job => job.id === 'spark-denied')?.reason).toBeTruthy());
    expect(owner.snapshot().jobs.find(job => job.id === 'spark-denied')?.state).toBe('queued');
    expect(f.nativeCount()).toBe(0); expect(f.ledger().attempts).toEqual(saved.receipts);
  });
  it('dispatches an explicitly selected Spark alias through the original account capacity after evolution', async () => {
    const f = await fixture(); const saved = await history(f); const plan = checkResourcePoolEvolution(options(f));
    applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest });
    const owner = await f.start(true); owner.setPaused(false); owner.submit(f.task('spark-new', { allowedWorkerIds: ['spark'] }));
    await settled(owner, 'spark-new');
    expect(f.nativeCount()).toBe(1); expect(f.requests).toHaveLength(2);
    expect(f.ledger().attempts.slice(0, 2)).toEqual(saved.receipts);
    expect(f.ledger().attempts.at(-1)).toMatchObject({ workerId: 'spark', capacityKey: 'personal-account', poolDigest: plan.toPoolDigest, status: 'completed' });
  });
  it('refuses stale plans and active console ownership without changing execution records', async () => {
    const f = await fixture(); await history(f); const plan = checkResourcePoolEvolution(options(f));
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: 'a'.repeat(64) })).toThrow();
    const owner = await f.start(); const beforePool = readFileSync(join(f.root, 'pool-state.json'), 'utf8');
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow();
    expect(readFileSync(join(f.root, 'pool-state.json'), 'utf8')).toBe(beforePool); expect(existsSync(join(f.root, 'pool-evolution'))).toBe(false);
    await owner.close(); setResourcePoolAllocation(f.root, f.oldPool, f.oldBindings, 75, 0);
    const before = tree(f.base); expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow();
    expect(tree(f.base)).toEqual(before); expect(f.requests).toHaveLength(2);
  });
  it('holds an interrupted version barrier and resumes only the exact untampered journal', async () => {
    const f = await fixture(); const saved = await history(f); const plan = checkResourcePoolEvolution(options(f));
    const original = privateWrites.writePrivateFileAtomically; let interrupted = false;
    vi.spyOn(privateWrites, 'writePrivateFileAtomically').mockImplementation((...args) => {
      if (args[1] === join(f.root, 'resource-console-state.json') && !interrupted) { interrupted = true; throw new Error('Fixture interruption before console publication'); }
      return original(...args);
    });
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow('Fixture interruption');
    vi.restoreAllMocks(); expect(f.ledger().pendingEvolution).toEqual({ planDigest: plan.planDigest });
    expect(f.ledger().attempts).toEqual(saved.receipts); expect(f.console()).toEqual(saved.console);
    const archive = textFiles(join(f.root, 'pool-evolution')).join('\n');
    for (const secret of ['PRIVATE_REQUEST_parent', 'PRIVATE_REQUEST_child', 'PRIVATE_RETAINED_RESPONSE']) expect(archive).not.toContain(secret);
    expect(() => resourcePoolStatus(f.root, f.oldPool, f.oldBindings, f.observations())).toThrow();
    expect(() => resourcePoolStatus(f.root, f.nextPool, f.nextBindings, f.observations(true))).toThrow(/pending/);
    const before = tree(f.base); expect(checkResourcePoolEvolution(options(f))).toEqual(plan); expect(tree(f.base)).toEqual(before);
    expect(applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toMatchObject({ disposition: 'resumed' });
    expect(f.ledger().pendingEvolution).toBeUndefined(); expect(f.ledger().attempts).toEqual(saved.receipts);
    expect(f.console().jobs).toEqual(saved.console.jobs); expect(f.requests).toHaveLength(2);
  });
  it('preserves a partial staging directory rather than fabricating cleanup and restart', async () => {
    const f = await fixture(); await history(f); const plan = checkResourcePoolEvolution(options(f));
    const original = privateWrites.writePrivateFileAtomically;
    vi.spyOn(privateWrites, 'writePrivateFileAtomically').mockImplementation((...args) => {
      if (args[1].endsWith('/journal.json')) throw new Error('Fixture staging interruption'); return original(...args);
    });
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow('Fixture staging');
    vi.restoreAllMocks(); const before = tree(f.base);
    expect(() => checkResourcePoolEvolution(options(f))).toThrow(/incomplete/);
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow(/incomplete/);
    expect(tree(f.base)).toEqual(before); expect(f.ledger().schemaVersion).toBe(1); expect(f.requests).toHaveLength(2);
  });
  it('refuses a changed staged snapshot without rewriting either durable store', async () => {
    const f = await fixture(); await history(f); const plan = checkResourcePoolEvolution(options(f));
    applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest });
    const directory = join(f.root, 'pool-evolution', readdirSync(join(f.root, 'pool-evolution'))[0]!);
    const after = JSON.parse(readFileSync(join(directory, 'afterPool.json'), 'utf8')); after.attempts = [];
    save(join(directory, 'afterPool.json'), after); const before = tree(f.base);
    expect(() => checkResourcePoolEvolution(options(f))).toThrow();
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow();
    expect(tree(f.base)).toEqual(before); expect(f.requests).toHaveLength(2);
  });
  it('replays a completed migration after new work without transient locks or historical overwrite', async () => {
    const f = await fixture(); await history(f); const plan = checkResourcePoolEvolution(options(f));
    applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest });
    const owner = await f.start(true); owner.setPaused(false); owner.submit(f.task('after-migration')); await settled(owner, 'after-migration');
    await owner.close(); const before = tree(f.base);
    expect(applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toMatchObject({ disposition: 'replayed' });
    expect(tree(f.base)).toEqual(before); expect(f.ledger().attempts).toHaveLength(3); expect(f.requests).toHaveLength(3);
  });
  it('invalidates legacy mixed quota windows without clearing account health or retry vetoes', async () => {
    const f = await fixture(); await history(f); const ledger = f.ledger(); const general = ledger.observations.find((row: { workerId: string }) => row.workerId === 'general');
    general.health = 'unavailable'; general.retryAfter = new Date(Date.now() + 60_000).toISOString();
    general.windows.push({ id: 'codex_codex_bengalfox_primary', usedPercent: 99, resetsAt: new Date(Date.now() + 60_000).toISOString() });
    save(join(f.root, 'pool-state.json'), ledger);
    const plan = checkResourcePoolEvolution(options(f)); applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest });
    expect(f.ledger().observations.find((row: { workerId: string }) => row.workerId === 'general')).toEqual({ ...general, windows: [] });
    expect(f.ledger().observations.some((row: { workerId: string }) => row.workerId === 'spark')).toBe(false);
    expect(f.ledger().attempts).toEqual(ledger.attempts); expect(f.nativeCount()).toBe(0);
  });
  it.each(['reserved', 'uncertain'] as const)('refuses an existing %s attempt without pretending it settled', async (status) => {
    const f = await fixture(); await history(f); const ledger = f.ledger();
    const completed = ledger.attempts[0];
    ledger.attempts.push({ schemaVersion: 1, id: 'unsettled-execution', taskDigest: 'e'.repeat(64), poolDigest: completed.poolDigest,
      workerId: 'local', capacityKey: 'local-account', status, startedAt: completed.startedAt,
      finishedAt: status === 'reserved' ? null : completed.finishedAt, outputDigest: null, inputTokens: null, outputTokens: null,
      reason: status === 'reserved' ? 'reserved' : 'worker-stop-unconfirmed', verifiedAccepted: false });
    save(join(f.root, 'pool-state.json'), ledger);
    expect(resourcePoolStatus(f.root, f.oldPool, f.oldBindings, f.observations()).attempts.at(-1)?.status).toBe(status);
    const before = tree(f.base); expect(() => checkResourcePoolEvolution(options(f))).toThrow(/reserved|uncertain/);
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: 'e'.repeat(64) })).toThrow();
    expect(tree(f.base)).toEqual(before); expect(f.requests).toHaveLength(2);
  });
  it('refuses a live standalone quota collector and preserves its exact ownership', async () => {
    const f = await fixture(); await history(f); const plan = checkResourcePoolEvolution(options(f));
    const lock = acquireLocalStoreLock(join(f.root, '.resource-quota-refresh.lock'), 0); expect(lock).not.toBeNull();
    try {
      const before = tree(f.base); expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow();
      expect(tree(f.base)).toEqual(before); expect(f.ledger().schemaVersion).toBe(1); expect(f.requests).toHaveLength(2);
    } finally { if (lock) expect(releaseLocalStoreLock(lock)).toBe(true); }
  });
  it('counts a pre-migration General attempt against the new Spark alias task-window allowance', async () => {
    const f = await fixture(1); const owner = await f.start();
    owner.submit(f.task('old-general', { allowedWorkerIds: ['general'] })); await settled(owner, 'old-general'); await owner.close();
    expect(f.nativeCount()).toBe(1); const receipt = f.ledger().attempts[0];
    const plan = checkResourcePoolEvolution(options(f)); applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest });
    const evolved = await f.start(true); evolved.submit(f.task('new-spark', { allowedWorkerIds: ['spark'] }));
    await vi.waitFor(() => expect(evolved.snapshot().jobs.find(job => job.id === 'new-spark')?.reason).toBeTruthy());
    expect(evolved.snapshot().jobs.find(job => job.id === 'new-spark')?.state).toBe('queued');
    expect(f.nativeCount()).toBe(1); expect(f.ledger().attempts).toEqual([receipt]); expect(f.requests).toHaveLength(0);
  });
  it('rejects unknown or accessor-valued migration options without evaluating them', async () => {
    const f = await fixture(); await history(f); const before = tree(f.base); const getter = vi.fn(() => f.root);
    const input = options(f); Object.defineProperty(input, 'root', { enumerable: true, get: getter });
    expect(() => checkResourcePoolEvolution(input)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => checkResourcePoolEvolution({ ...options(f), resetUsage: true } as ReturnType<typeof options>)).toThrow();
    expect(tree(f.base)).toEqual(before);
  });
  it('does not call a completed replay intact when previously accepted console tombstones disappeared', async () => {
    const f = await fixture(); await history(f); const plan = checkResourcePoolEvolution(options(f));
    applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest });
    const current = f.console(); current.jobs = []; save(join(f.root, 'resource-console-state.json'), current);
    const before = tree(f.base);
    expect(() => checkResourcePoolEvolution(options(f))).toThrow();
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow();
    expect(tree(f.base)).toEqual(before); expect(f.ledger().attempts).toHaveLength(2);
  });
  it('never archives conversation text and leaves no deleted transcript copies anywhere in its private stores', async () => {
    const f = await fixture(); await history(f); const plan = checkResourcePoolEvolution(options(f));
    applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest });
    const archive = textFiles(join(f.root, 'pool-evolution')).join('\n');
    for (const secret of ['PRIVATE_REQUEST_parent', 'PRIVATE_REQUEST_child', 'PRIVATE_RETAINED_RESPONSE']) expect(archive).not.toContain(secret);
    const owner = await f.start(true); owner.deleteHistory('parent'); owner.deleteHistory('child'); await owner.close();
    const all = textFiles(f.base).join('\n');
    for (const secret of ['PRIVATE_REQUEST_parent', 'PRIVATE_REQUEST_child', 'PRIVATE_RETAINED_RESPONSE']) expect(all).not.toContain(secret);
    const before = tree(f.base);
    expect(applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toMatchObject({ disposition: 'replayed' });
    expect(tree(f.base)).toEqual(before);
  });
  it('resumes from the published console using only its live exact hash, never a shadow transcript', async () => {
    const f = await fixture(); const saved = await history(f); const plan = checkResourcePoolEvolution(options(f));
    const original = privateWrites.writePrivateFileAtomically;
    vi.spyOn(privateWrites, 'writePrivateFileAtomically').mockImplementation((...args) => {
      if (args[1] === join(f.root, 'pool-state.json') && !JSON.parse(String(args[2])).pendingEvolution) throw new Error('Fixture final publication interruption');
      return original(...args);
    });
    expect(() => applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toThrow('Fixture final publication');
    vi.restoreAllMocks(); expect(f.ledger().pendingEvolution).toEqual({ planDigest: plan.planDigest });
    expect(f.console().schemaVersion).toBe(5); expect(f.console().jobs).toEqual(saved.console.jobs);
    const archive = textFiles(join(f.root, 'pool-evolution')).join('\n');
    expect(archive).not.toContain('PRIVATE_REQUEST_parent'); expect(archive).not.toContain('PRIVATE_RETAINED_RESPONSE');
    const before = tree(f.base); expect(checkResourcePoolEvolution(options(f))).toEqual(plan); expect(tree(f.base)).toEqual(before);
    expect(applyResourcePoolEvolution({ ...options(f), expectedPlanDigest: plan.planDigest })).toMatchObject({ disposition: 'resumed' });
    expect(f.ledger().pendingEvolution).toBeUndefined(); expect(f.ledger().attempts).toEqual(saved.receipts);
    expect(f.requests).toHaveLength(2);
  });
});
