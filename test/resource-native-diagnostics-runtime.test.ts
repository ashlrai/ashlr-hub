/** Private ledger and mocked worker only: no providers, CLIs, or default stores. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { resourcePoolStatus, runResourceTask, type ResourceTask, type ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import { executeResourceWorker, type ResourceBinding, type ResourceWorkerResult } from '../src/core/resources/worker.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceNativeProcessDiagnostic } from '../src/core/resources/native-diagnostics.js';

vi.mock('../src/core/resources/worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/resources/worker.js')>();
  return { ...actual, executeResourceWorker: vi.fn() };
});
let scratch: string; let root: string; let cwd: string;
const nativeId = 'n'.repeat(64);
const pool: ResourcePool = { schemaVersion: 1, id: 'native', workers: [{ id: nativeId, provider: 'codex', model: 'fixture',
  maxConcurrent: 3, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true }] };
const bindings: ResourceBinding[] = [{ workerId: nativeId, capacityKey: 'c'.repeat(64), kind: 'native-cli', command: ['/inert/native'] }];
const processFacts = (patch: Partial<ResourceNativeProcessDiagnostic> = {}): ResourceNativeProcessDiagnostic => ({
  schemaVersion: 1, scope: 'native-process', exitCode: 0, signal: null, stderrPresent: true, outputTruncated: false, ...patch });
const result = (patch: Partial<ResourceWorkerResult> = {}): ResourceWorkerResult => ({ status: 'completed', output: 'PRIVATE_RESULT',
  inputTokens: 2, outputTokens: 1, usageScope: 'codex-turn', reason: 'worker-completed', nativeProcess: processFacts(), ...patch });
const task = (id = 'one'): ResourceTask => ({ schemaVersion: 1, id, allowedWorkerIds: [nativeId], prompt: 'PRIVATE_PROMPT',
  cwd, timeoutMs: 1000, maxOutputTokens: 100, mode: 'read-only' });
const run = (id = 'one') => runResourceTask({ root, pool, bindings, observations: [], task: task(id) });
const status = () => resourcePoolStatus(root, pool, bindings, []);
const file = () => join(root, 'pool-state.json');
const ledger = () => JSON.parse(readFileSync(file(), 'utf8'));
const save = (value: unknown) => writeFileSync(file(), canonical(value) + '\n', { mode: 0o600 });
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-native-evidence-')));
  root = join(scratch, 'ledger'); cwd = join(scratch, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  vi.mocked(executeResourceWorker).mockReset().mockResolvedValue(result());
});
afterEach(() => { vi.restoreAllMocks(); rmSync(scratch, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('durable native process facts', () => {
  it.each(['completed', 'failed', 'timed-out', 'cancelled', 'uncertain'] as const)('preserves %s process evidence on exact replay without redispatch', async (outcome) => {
    const facts = processFacts({ exitCode: outcome === 'completed' ? 0 : outcome === 'failed' ? 23 : null });
    vi.mocked(executeResourceWorker).mockResolvedValue(result({ status: outcome, nativeProcess: facts }));
    const first = await run(); const bytes = readFileSync(file(), 'utf8');
    expect(first.receipt).toMatchObject({ status: outcome, nativeProcess: facts, verifiedAccepted: false });
    expect(status().attempts[0]?.nativeProcess).toEqual(facts);
    expect((await run()).receipt).toEqual(first.receipt); expect(executeResourceWorker).toHaveBeenCalledTimes(1);
    expect(readFileSync(file(), 'utf8')).toBe(bytes); expect(bytes).not.toMatch(/PRIVATE_PROMPT|PRIVATE_RESULT/);
  });
  it('does not fabricate native facts on a pending reservation or legacy replay', async () => {
    let finish!: (value: ResourceWorkerResult) => void;
    vi.mocked(executeResourceWorker).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = run(); expect(status().attempts[0]).not.toHaveProperty('nativeProcess');
    finish(result()); await pending;
    const old = ledger(); delete old.attempts[0].nativeProcess; save(old); const bytes = readFileSync(file(), 'utf8');
    expect(status().attempts[0]).not.toHaveProperty('nativeProcess');
    expect((await run()).receipt).not.toHaveProperty('nativeProcess');
    expect(executeResourceWorker).toHaveBeenCalledTimes(1); expect(readFileSync(file(), 'utf8')).toBe(bytes);
  });
  it('does not let informative native diagnostics release uncertain occupancy or cause a retry', async () => {
    vi.mocked(executeResourceWorker).mockResolvedValue(result({ status: 'uncertain', reason: 'worker-termination-uncertain',
      nativeProcess: processFacts({ exitCode: null, signal: 'SIGTERM' }) }));
    for (const id of ['one', 'two', 'three']) expect((await run(id)).receipt?.status).toBe('uncertain');
    const blocked = await run('four'); expect(blocked.receipt).toBeNull();
    expect(blocked.plan?.exclusions[0]?.reasons).toContain('concurrency-exhausted');
    expect((await run('one')).replayed).toBe(true); expect(executeResourceWorker).toHaveBeenCalledTimes(3);
    expect(status().attempts.every((row) => row.status === 'uncertain')).toBe(true);
  });
  it.each(['failed', 'timed-out'] as const)('preserves the native %s cooldown instead of retrying from diagnostic facts', async (outcome) => {
    vi.mocked(executeResourceWorker).mockResolvedValue(result({ status: outcome,
      nativeProcess: processFacts({ exitCode: outcome === 'failed' ? 23 : null }) }));
    await run(); const blocked = await run('two'); expect(blocked.receipt).toBeNull();
    expect(blocked.plan?.exclusions[0]?.reasons).toContain('provider-retry-after');
    expect(executeResourceWorker).toHaveBeenCalledTimes(1);
  });
  it.each([
    { nativeProcess: { ...processFacts(), stderr: 'PRIVATE' } }, { nativeProcess: null },
    { nativeProcess: { ...processFacts(), signal: 'PRIVATE' } },
    { nativeProcess: processFacts({ exitCode: 1 }) }, { nativeProcess: processFacts({ outputTruncated: true }) },
    { status: 'timed-out', nativeProcess: processFacts({ exitCode: 124 }) },
    { status: 'cancelled', nativeProcess: processFacts() }, { status: 'uncertain', nativeProcess: processFacts() },
    { status: 'reserved', finishedAt: null, outputDigest: null, inputTokens: null, outputTokens: null, execution: undefined },
  ])('rejects invalid persisted metadata and status contradictions %#', async (patch) => {
    await run(); const modified = ledger(); Object.assign(modified.attempts[0], patch);
    if (modified.attempts[0].execution === undefined) delete modified.attempts[0].execution;
    save(modified);
    expect(() => status()).toThrow('ledger invalid'); await expect(run('two')).rejects.toThrow('ledger invalid');
    expect(executeResourceWorker).toHaveBeenCalledTimes(1);
  });
  it('rejects native evidence returned from a local worker before publishing a false settlement', async () => {
    const localPool: ResourcePool = { ...pool, workers: [{ ...pool.workers[0]!, provider: 'local' }] };
    const localBindings: ResourceBinding[] = [{ workerId: nativeId, capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/v1' }];
    vi.mocked(executeResourceWorker).mockResolvedValue(result({ usageScope: 'local-chat-completion' }));
    await expect(runResourceTask({ root, pool: localPool, bindings: localBindings, observations: [{ workerId: nativeId,
      observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      health: 'ready', windows: [], retryAfter: null }], task: task() })).rejects.toThrow('invalid settlement');
    const recorded = resourcePoolStatus(root, localPool, localBindings, []).attempts[0];
    expect(recorded?.status).toBe('reserved'); expect(recorded).not.toHaveProperty('nativeProcess');
  });
});

const MAX_BYTES = 4 * 1024 * 1024;
function seedNearCapacity(freeBytes: number): void {
  mkdirSync(root, { mode: 0o700 });
  const poolDigest = digest(canonical({ pool, bindings }));
  const template: ResourceTaskReceipt = { schemaVersion: 1, id: 'h'.repeat(64), taskDigest: '1'.repeat(64), poolDigest,
    workerId: nativeId, capacityKey: 'c'.repeat(64), status: 'completed', startedAt: '2000-01-01T00:00:00.000Z',
    finishedAt: '2000-01-01T00:00:01.000Z', outputDigest: '2'.repeat(64), inputTokens: Number.MAX_SAFE_INTEGER - 1,
    outputTokens: 1, reason: 'x'.repeat(120), verifiedAccepted: false,
    execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 1.0000000000000002e-6, usageScope: 'codex-turn' },
    nativeProcess: processFacts() };
  const value = { schemaVersion: 1, poolDigest, observations: [], attempts: [] as ResourceTaskReceipt[] };
  const target = MAX_BYTES - freeBytes; const baseBytes = Buffer.byteLength(canonical(value) + '\n');
  const perRow = Buffer.byteLength(canonical(template)) + 1;
  const count = Math.ceil((target - baseBytes + 1) / perRow);
  expect(count).toBeLessThan(4094);
  value.attempts = Array.from({ length: count }, (_, index) => ({ ...template, id: `h${String(index).padStart(63, '0')}` }));
  let excess = Buffer.byteLength(canonical(value) + '\n') - target;
  for (let index = value.attempts.length - 1; excess > 0; index--) {
    const reduction = Math.min(119, excess); value.attempts[index]!.reason = 'x'.repeat(120 - reduction); excess -= reduction;
  }
  save(value); expect(Buffer.byteLength(readFileSync(file(), 'utf8'))).toBe(target);
}

describe.skipIf(process.platform === 'win32')('native settlement byte headroom before contact', () => {
  it('refuses an admission whose small reservation could fit but terminal evidence cannot', async () => {
    seedNearCapacity(800); const before = readFileSync(file(), 'utf8'); const existingCount = status().attempts.length;
    await expect(run()).rejects.toThrow('settlement capacity');
    expect(executeResourceWorker).not.toHaveBeenCalled(); expect(readFileSync(file(), 'utf8')).toBe(before);
    expect(status().attempts).toHaveLength(existingCount);
  });
  it('admits and durably settles a near-capacity task with native process facts', async () => {
    seedNearCapacity(4000); const previous = status().attempts.length;
    const completed = await run(); expect(completed.receipt?.status).toBe('completed');
    expect(completed.receipt?.nativeProcess).toEqual(processFacts()); expect(status().attempts).toHaveLength(previous + 1);
    expect(Buffer.byteLength(readFileSync(file(), 'utf8'))).toBeLessThan(MAX_BYTES);
    expect(executeResourceWorker).toHaveBeenCalledTimes(1);
  });
  it('retains the full bounded quota and wide native settlement envelope near the size limit', async () => {
    seedNearCapacity(3000); let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const now = Date.now(); const at = (offset: number) => new Date(now + offset).toISOString();
    const widestNumber = 1.0000000000000002e-6;
    const quota = { workerId: nativeId, observedAt: at(-1000), expiresAt: at(60_000), updatedAt: at(0),
      retryAfter: at(120_000), health: 'unavailable' as const, windows: Array.from({ length: 8 }, (_, index) => ({
        id: `w${String(index).padStart(63, '0')}`, usedPercent: widestNumber, resetsAt: at(120_000) })) };
    vi.mocked(executeResourceWorker).mockImplementation(async () => {
      clock = widestNumber;
      return result({ status: 'uncertain', reason: 'x'.repeat(120), inputTokens: 4_503_599_627_370_495,
        outputTokens: 4_503_599_627_370_495, observation: quota,
        nativeProcess: processFacts({ exitCode: null, signal: 'SIGVTALRM', stderrPresent: false }) });
    });
    const settled = await run(); expect(settled.receipt?.status).toBe('uncertain');
    expect(settled.receipt?.execution?.durationMs).toBe(widestNumber);
    expect(status().observations).toEqual([quota]); expect(status().attempts.at(-1)).toEqual(settled.receipt);
    expect(Buffer.byteLength(readFileSync(file(), 'utf8'))).toBeLessThan(MAX_BYTES);
    expect(executeResourceWorker).toHaveBeenCalledTimes(1);
  });
  it('accounts all concurrent reservations and still settles admitted work after refusing more', async () => {
    seedNearCapacity(3500); const completions: Array<(value: ResourceWorkerResult) => void> = [];
    vi.mocked(executeResourceWorker).mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
    const first = run('first'); const pending: Array<Promise<unknown>> = [first.catch(() => {})];
    try {
      const second = run('second'); pending.push(second.catch(() => {}));
      await expect(second).rejects.toThrow('settlement capacity');
      expect(executeResourceWorker).toHaveBeenCalledTimes(1);
    } finally {
      for (const finish of completions) finish(result()); await Promise.all(pending);
    }
    expect(status().attempts.filter((row) => row.status === 'reserved')).toEqual([]);
    expect(status().attempts.at(-1)?.nativeProcess).toEqual(processFacts());
    expect(Buffer.byteLength(readFileSync(file(), 'utf8'))).toBeLessThan(MAX_BYTES);
  });
});
