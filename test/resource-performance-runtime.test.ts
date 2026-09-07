/** Real private ledger plus inert worker; no providers or user stores. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeResourceWorker } from '../src/core/resources/worker.js';
import { resourcePoolStatus, runResourceTask, type ResourceTask } from '../src/core/resources/pool-runtime.js';
import { buildResourcePerformance } from '../src/core/resources/performance.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

vi.mock('../src/core/resources/worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/resources/worker.js')>();
  return { ...actual, executeResourceWorker: vi.fn() };
});
let scratch: string; let root: string; let cwd: string; let clock: number;
const pool: ResourcePool = { schemaVersion: 1, id: 'pool', workers: [{ id: 'local', provider: 'local', model: 'fixture',
  maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/v1' }];
function observation(): ResourceObservation[] {
  return [{ workerId: 'local', observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    health: 'ready', windows: [], retryAfter: null }];
}
function task(): ResourceTask {
  return { schemaVersion: 1, id: 'one', allowedWorkerIds: ['local'], prompt: 'private task', cwd,
    timeoutMs: 1000, maxOutputTokens: 100, mode: 'read-only' };
}
const run = (observations = observation()) => runResourceTask({ root, pool, bindings, observations, task: task() });
const status = () => resourcePoolStatus(root, pool, bindings, []);
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-resource-measurement-')));
  root = join(scratch, 'ledger'); cwd = join(scratch, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  clock = 100; vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.mocked(executeResourceWorker).mockReset().mockImplementation(async () => {
    clock += 25.5;
    return { status: 'completed', output: 'private result', inputTokens: 10, outputTokens: 2,
      usageScope: 'local-chat-completion', reason: 'worker-completed' };
  });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(scratch, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('durable worker execution measurement', () => {
  it('records only the adapter interval and retains it on exact replay without a second dispatch', async () => {
    const first = await run();
    expect(first.receipt?.execution).toEqual({ schemaVersion: 1, scope: 'worker-execution', durationMs: 25.5, usageScope: 'local-chat-completion' });
    const bytes = readFileSync(join(root, 'pool-state.json'), 'utf8');
    clock = 9000; const second = await run([]);
    expect(second).toMatchObject({ replayed: true, output: null, receipt: first.receipt });
    expect(executeResourceWorker).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'pool-state.json'), 'utf8')).toBe(bytes);
    expect(bytes).not.toMatch(/private task|private result/);
  });

  it('does not place a completed timing measurement on a pending reservation', async () => {
    let release!: () => void;
    vi.mocked(executeResourceWorker).mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; }); clock += 10;
      return { status: 'completed', output: 'result', inputTokens: null, outputTokens: null, reason: 'worker-completed' };
    });
    const pending = run();
    expect(status().attempts[0]).toMatchObject({ status: 'reserved' });
    expect(status().attempts[0]).not.toHaveProperty('execution');
    release(); await pending;
    expect(status().attempts[0]?.execution).toMatchObject({ durationMs: 10, usageScope: null });
  });

  it('does not fabricate duration after a backwards monotonic sample', async () => {
    vi.mocked(executeResourceWorker).mockImplementation(async () => {
      clock = 50;
      return { status: 'completed', output: 'result', inputTokens: 0, outputTokens: 0, reason: 'worker-completed' };
    });
    const result = await run();
    expect(result.receipt?.execution).toMatchObject({ durationMs: null, usageScope: null });
    expect(buildResourcePerformance(pool, status().attempts).workers[0]?.durations[0]).toMatchObject({ samples: 0, unknownAttempts: 1, p50Ms: null });
  });

  it('reads legacy bytes without backfill or reinterpretation of token provenance', async () => {
    await run(); const file = join(root, 'pool-state.json');
    const ledger = JSON.parse(readFileSync(file, 'utf8')); delete ledger.attempts[0].execution;
    writeFileSync(file, JSON.stringify(ledger) + '\n', { mode: 0o600 }); const before = readFileSync(file, 'utf8');
    const legacy = status(); expect(legacy.attempts[0]).not.toHaveProperty('execution');
    const report = buildResourcePerformance(pool, legacy.attempts);
    expect(report.workers[0]?.usage.scopes).toEqual([{ scope: null, attempts: 1, reportedAttempts: 1 }]);
    expect(report.workers[0]?.durations[0]).toMatchObject({ status: 'completed', samples: 0, unknownAttempts: 1 });
    expect((await run([])).replayed).toBe(true);
    expect(executeResourceWorker).toHaveBeenCalledTimes(1); expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each(['failed', 'timed-out', 'cancelled', 'uncertain'] as const)('retains observed timing for %s separately from successful work', async (statusValue) => {
    vi.mocked(executeResourceWorker).mockImplementation(async () => {
      clock += 20; return { status: statusValue, output: '', inputTokens: 4, outputTokens: 1,
        usageScope: 'local-chat-completion', reason: 'worker-stopped' };
    });
    const result = await run(); expect(result.receipt?.execution?.durationMs).toBe(20);
    const report = buildResourcePerformance(pool, status().attempts);
    expect(report.workers[0]?.durations.find((item) => item.status === statusValue)).toMatchObject({ attempts: 1, samples: 1, p50Ms: 20 });
    expect(report.workers[0]?.durations[0]?.samples).toBe(0);
    expect(result.receipt?.verifiedAccepted).toBe(false);
  });

  it.each(['negative', 'extra', 'scope', 'missing-field', 'unknown-usage-scope'])('rejects invalid persisted measurement: %s', async (kind) => {
    await run(); const file = join(root, 'pool-state.json'); const ledger = JSON.parse(readFileSync(file, 'utf8'));
    const receipt = ledger.attempts[0];
    if (kind === 'negative') receipt.execution.durationMs = -1;
    if (kind === 'extra') receipt.execution.prompt = 'private';
    if (kind === 'scope') receipt.execution.usageScope = 'claude-main-loop';
    if (kind === 'missing-field') delete receipt.execution.scope;
    if (kind === 'unknown-usage-scope') receipt.execution.usageScope = 'estimate';
    writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 });
    expect(() => status()).toThrow('invalid'); expect(executeResourceWorker).toHaveBeenCalledTimes(1);
  });
});
