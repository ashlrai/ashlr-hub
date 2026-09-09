/** Private temporary leases and injected inert probes only; no native providers. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as locks from '../src/core/fleet/local-store-lock.js';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { refreshResourceQuotaOnce, type ResourceQuotaRefreshConfig } from '../src/core/resources/quota-refresh.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { CodexResourceProbeOptions, CodexResourceProbeResult } from '../src/core/resources/codex-account-probe.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';

let base: string; let root: string;
const leases: ResourceQuotaRefreshLease[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
const lockPath = () => join(root, '.resource-quota-refresh.lock');
const pendingPath = () => join(root, '.resource-quota-refresh-pending.json');
const unavailable = /already owned or unavailable|cleanup unconfirmed/;
const later = (action: () => void, ms = 20): void => { timers.push(setTimeout(action, ms)); };
async function acquire(options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<ResourceQuotaRefreshLease> {
  const lease = await acquireResourceQuotaRefreshLease(root, options); leases.push(lease); return lease;
}
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-quota-contention-'))); root = join(base, 'ledger'); });
afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) { try { lease.close(); } catch { /* Intentional uncertain fixtures retain their fence. */ } }
  rmSync(base, { recursive: true, force: true });
});

function fixture() {
  const pool: ResourcePool = { schemaVersion: 1, id: 'quota-contention', workers: [{ id: 'codex', provider: 'codex',
    model: 'inert-fixture', maxConcurrent: 1, maxTasksPerWindow: 2, taskWindowMs: 60_000,
    priority: 1, reservePercent: 10, allowUnknownQuota: false }] };
  const bindings: ResourceBinding[] = [{ workerId: 'codex', capacityKey: 'fixture-account',
    kind: 'native-cli', command: ['/inert-test-owned/never-spawned'] }];
  const config: ResourceQuotaRefreshConfig = { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
    workers: [{ workerId: 'codex', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] };
  return { pool, bindings, config, observations: [], cwd: root, timeoutMs: 5000 };
}
function success(options: CodexResourceProbeOptions): CodexResourceProbeResult {
  const captured = new Date().toISOString();
  return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId,
    poolDigest: digest(canonical({ pool: options.pool, bindings: options.bindings })),
    status: 'observed', reason: 'probe-observed', startedAt: captured, finishedAt: captured,
    accountHint: options.expectedAccountHint!, planType: 'pro', observation: { workerId: options.workerId,
      observedAt: captured, expiresAt: new Date(Date.parse(captured) + 60_000).toISOString(), health: 'ready', retryAfter: null,
      windows: [{ id: 'codex_primary', usedPercent: 20, resetsAt: new Date(Date.parse(captured) + 3_600_000).toISOString() }] } };
}

describe.skipIf(process.platform === 'win32')('bounded verified quota collector contention', () => {
  it.each([false, true])('yields for a same-process live owner to release (pending=%s)', async (marked) => {
    const owner = await acquire(); if (marked) owner.markPending();
    const attempts = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome');
    let released = false; later(() => { owner.close(); released = true; });
    const successor = await acquire({ waitMs: 3000 });
    expect(released).toBe(true); expect(attempts.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(attempts.mock.calls.every((call) => call[1] === 0)).toBe(true);
    expect(attempts.mock.results[0]!.value.state).toBe('contended');
    expect(existsSync(pendingPath())).toBe(false); successor.markPending(); successor.close();
    expect(existsSync(lockPath())).toBe(false); expect(existsSync(pendingPath())).toBe(false);
  });

  it.each([undefined, 0])('preserves the legacy 500ms acquisition without opt-in (waitMs=%s)', async (waitMs) => {
    const owner = await acquire(); owner.markPending();
    const lockBytes = readFileSync(lockPath()); const markerBytes = readFileSync(pendingPath());
    const immediate = vi.spyOn(locks, 'acquireLocalStoreLock');
    const polling = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome');
    await expect(acquire({ waitMs })).rejects.toThrow(unavailable);
    expect(polling).toHaveBeenCalledExactlyOnceWith(lockPath(), 500, { anchorPath: root, exactPrivateStorage: true });
    expect(immediate).not.toHaveBeenCalled(); owner.assertOwnership();
    expect(readFileSync(lockPath())).toEqual(lockBytes); expect(readFileSync(pendingPath())).toEqual(markerBytes);
  });

  it('times out without changing the live owner or its pending marker', async () => {
    const owner = await acquire(); owner.markPending();
    const lockBytes = readFileSync(lockPath()); const markerBytes = readFileSync(pendingPath());
    await expect(acquire({ waitMs: 40 })).rejects.toThrow(unavailable);
    owner.assertOwnership(); expect(readFileSync(lockPath())).toEqual(lockBytes);
    expect(readFileSync(pendingPath())).toEqual(markerBytes);
  });

  it('cancels during a poll without touching the live owner', async () => {
    const owner = await acquire(); owner.markPending(); const controller = new AbortController();
    const markerBytes = readFileSync(pendingPath()); const attempts = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome');
    later(() => controller.abort());
    await expect(acquire({ waitMs: 3000, signal: controller.signal })).rejects.toThrow(unavailable);
    expect(attempts).toHaveBeenCalledOnce(); owner.assertOwnership(); expect(readFileSync(pendingPath())).toEqual(markerBytes);
  });

  it.each([0, 1000])('is inert for a pre-aborted signal (waitMs=%s)', async (waitMs) => {
    const controller = new AbortController(); controller.abort();
    const immediate = vi.spyOn(locks, 'acquireLocalStoreLock'); const polling = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome');
    await expect(acquire({ waitMs, signal: controller.signal })).rejects.toThrow(unavailable);
    expect(existsSync(root)).toBe(false); expect(immediate).not.toHaveBeenCalled(); expect(polling).not.toHaveBeenCalled();
  });

  it('releases its own acquisition when cancellation occurs during synchronous identity checks', async () => {
    const controller = new AbortController(); const original = locks.acquireLocalStoreLockWithOutcome;
    const attempts = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome').mockImplementation((...args) => {
      const result = original(...args); expect(result.state).toBe('acquired'); controller.abort(); return result;
    });
    await expect(acquire({ waitMs: 1000, signal: controller.signal })).rejects.toThrow(unavailable);
    expect(attempts).toHaveBeenCalledOnce(); expect(existsSync(lockPath())).toBe(false); expect(existsSync(pendingPath())).toBe(false);
  });

  it('releases its own acquisition when synchronous identity checks exhaust the monotonic budget', async () => {
    let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const original = locks.acquireLocalStoreLockWithOutcome;
    const attempts = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome').mockImplementation((...args) => {
      const result = original(...args); expect(result.state).toBe('acquired'); elapsed = 51; return result;
    });
    await expect(acquire({ waitMs: 50 })).rejects.toThrow(unavailable);
    expect(attempts).toHaveBeenCalledOnce(); expect(existsSync(lockPath())).toBe(false); expect(existsSync(pendingPath())).toBe(false);
  });

  it.each(['', '{', JSON.stringify({ pid: process.pid, token: 'missing-verified-start-identity' })])(
    'does not poll unknown or corrupt lock ownership: %j', async (record) => {
      mkdirSync(root, { mode: 0o700 }); writeFileSync(lockPath(), record, { mode: 0o600 });
      const attempts = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome');
      await expect(acquire({ waitMs: 3000 })).rejects.toThrow(unavailable);
      expect(attempts).toHaveBeenCalledOnce(); expect(attempts.mock.results[0]!.value.state).toBe('unavailable');
      expect(readFileSync(lockPath(), 'utf8')).toBe(record); expect(existsSync(pendingPath())).toBe(false);
    });

  it('stops when a formerly live owner retains an uncertain pending fence', async () => {
    const owner = await acquire(); owner.markPending(); const before = readFileSync(pendingPath());
    const attempts = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome'); later(() => owner.close(true));
    await expect(acquire({ waitMs: 3000 })).rejects.toThrow(unavailable);
    expect(attempts).toHaveBeenCalledTimes(2); expect(attempts.mock.results[1]!.value.state).toBe('acquired');
    expect(existsSync(lockPath())).toBe(false); expect(readFileSync(pendingPath())).toEqual(before);
  });

  it('never polls or removes a retained pending marker after acquisition', async () => {
    const owner = await acquire(); owner.markPending(); owner.close(true); const before = readFileSync(pendingPath());
    const attempts = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome');
    await expect(acquire({ waitMs: 3000 })).rejects.toThrow(unavailable);
    expect(attempts).toHaveBeenCalledOnce(); expect(existsSync(lockPath())).toBe(false);
    expect(readFileSync(pendingPath())).toEqual(before);
  });

  it.each([-1, 60_001, 1.5, NaN, Infinity, null, '1000'])('rejects invalid lease wait %j before creating state', async (waitMs) => {
    await expect(acquire({ waitMs: waitMs as any })).rejects.toThrow('Invalid resource quota collector wait budget');
    expect(existsSync(root)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('one-shot refresh collector wait forwarding', () => {
  it('waits for a clean live owner, then performs exactly one inert capture', async () => {
    const owner = await acquire(); owner.markPending(); later(() => owner.close());
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => {
      expect(existsSync(pendingPath())).toBe(true); return success(options);
    });
    const result = await refreshResourceQuotaOnce({ ...fixture(), capacityWaitMs: 3000, _probe: probe });
    expect(probe).toHaveBeenCalledOnce(); expect(result.unavailableWorkerIds).toEqual([]);
    expect(result.observations).toHaveLength(1); expect(existsSync(lockPath())).toBe(false); expect(existsSync(pendingPath())).toBe(false);
  });

  it('caps collector waiting by the remaining overall deadline and never contacts a probe', async () => {
    const owner = await acquire(); owner.markPending(); const before = readFileSync(pendingPath());
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    const attempts = vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome');
    await expect(refreshResourceQuotaOnce({ ...fixture(), timeoutMs: 40, capacityWaitMs: 3000, _probe: probe }))
      .rejects.toThrow('Resource quota refresh could not complete');
    expect(attempts).toHaveBeenCalledOnce(); expect(probe).not.toHaveBeenCalled(); owner.assertOwnership();
    expect(readFileSync(pendingPath())).toEqual(before);
  });

  it('forwards caller cancellation while waiting and leaves the active collector intact', async () => {
    const owner = await acquire(); owner.markPending(); const controller = new AbortController();
    const before = readFileSync(pendingPath()); const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    later(() => controller.abort());
    await expect(refreshResourceQuotaOnce({ ...fixture(), capacityWaitMs: 3000, signal: controller.signal, _probe: probe }))
      .rejects.toThrow('Resource quota refresh could not complete');
    expect(probe).not.toHaveBeenCalled(); owner.assertOwnership(); expect(readFileSync(pendingPath())).toEqual(before);
  });

  it.each([-1, 60_001, 1.5, NaN, Infinity, null, '1000'])('rejects invalid forwarded wait %j before state or capture', async (capacityWaitMs) => {
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    await expect(refreshResourceQuotaOnce({ ...fixture(), capacityWaitMs: capacityWaitMs as any, _probe: probe }))
      .rejects.toThrow('Invalid resource quota refresh capacity wait budget');
    expect(probe).not.toHaveBeenCalled(); expect(existsSync(root)).toBe(false);
  });
});
