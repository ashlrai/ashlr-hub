/** Private ledgers and injected metadata only; no native account or provider calls. */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readResourcePoolAllocation, resourcePoolStatus, setResourcePoolAllocation } from '../src/core/resources/pool-runtime.js';
import { createResourceQuotaRefresher, refreshResourceQuotaOnce, type ResourceQuotaRefresher } from '../src/core/resources/quota-refresh.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { CodexResourceProbeOptions, CodexResourceProbeResult } from '../src/core/resources/codex-account-probe.js';

let root: string;
const handles: ResourceQuotaRefresher[] = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-allocation-refresh-'))); });
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function fixture(used = 85) {
  const pool: ResourcePool = { schemaVersion: 1, id: 'allocation-refresh', workers: [{ id: 'codex', provider: 'codex',
    model: 'fixture', maxConcurrent: 1, reservePercent: 20, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'codex', capacityKey: 'account', kind: 'native-cli', command: ['/fixture/never-run'] }];
  const poolDigest = digest(canonical({ pool, bindings })); const accountHint = 'a'.repeat(64);
  const config = { schemaVersion: 1 as const, poolDigest, workers: [{ workerId: 'codex', accountHint, bucketIds: ['codex'] }] };
  const probe = vi.fn(async (input: CodexResourceProbeOptions): Promise<CodexResourceProbeResult> => {
    const startedAt = new Date().toISOString();
    return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: input.workerId, poolDigest, status: 'observed',
      reason: 'probe-observed', startedAt, finishedAt: startedAt, accountHint, planType: 'pro', observation: {
        workerId: input.workerId, observedAt: startedAt, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        health: 'ready', retryAfter: null, windows: [{ id: 'five_hour', usedPercent: used,
          resetsAt: new Date(Date.now() + 3600_000).toISOString() }] } };
  });
  const options = { pool, bindings, config, cwd: root, _probe: probe };
  const set = (ceiling: number, revision = 0) => setResourcePoolAllocation(root, pool, bindings, ceiling, revision);
  return { pool, bindings, probe, options, set };
}

it('resident collector recomputes allocation on every read without another metadata request', async () => {
  const f = fixture(); f.set(75); const handle = createResourceQuotaRefresher(f.options); handles.push(handle);
  await vi.waitFor(() => expect(handle.snapshot().workers[0]!.status).toBe('observed'));
  expect(handle.unavailableWorkerIds()).toEqual(['codex']);
  f.set(100, 1); expect(handle.unavailableWorkerIds()).toEqual([]);
  expect(handle.snapshot().workers[0]!.reason).toBe('managed-quota-observed');
  f.set(0, 2); expect(handle.unavailableWorkerIds()).toEqual(['codex']); expect(f.probe).toHaveBeenCalledOnce();
});

it('one-pass deferred allocation preserves measured usage and final status applies the newest policy', async () => {
  const f = fixture(); f.set(75);
  const captured = await refreshResourceQuotaOnce({ ...f.options, observations: [], timeoutMs: 3000, deferAllocationToAdmission: true });
  expect(captured.unavailableWorkerIds).toEqual([]); expect(captured.observations[0]!.windows[0]!.usedPercent).toBe(85);
  expect(resourcePoolStatus(root, f.pool, f.bindings, captured.observations).plan.selectedWorkerId).toBeNull();
  f.set(100, 1);
  expect(resourcePoolStatus(root, f.pool, f.bindings, captured.observations).plan.selectedWorkerId).toBe('codex');
  expect(readResourcePoolAllocation(root, f.pool, f.bindings).revision).toBe(2); expect(f.probe).toHaveBeenCalledOnce();
});

it('deferring operator allocation never defers native100% exhaustion', async () => {
  const f = fixture(100); f.set(100);
  const captured = await refreshResourceQuotaOnce({ ...f.options, observations: [], timeoutMs: 3000, deferAllocationToAdmission: true });
  expect(captured.unavailableWorkerIds).toEqual(['codex']);
});

it('unreadable allocation fails closed in a running collector rather than assuming default capacity', async () => {
  const f = fixture(10); f.set(75); const handle = createResourceQuotaRefresher(f.options); handles.push(handle);
  await vi.waitFor(() => expect(handle.unavailableWorkerIds()).toEqual([]));
  const file = join(root, 'pool-state.json'); const state = JSON.parse(readFileSync(file, 'utf8')); state.allocation.revision = -1;
  writeFileSync(file, JSON.stringify(state));
  expect(handle.unavailableWorkerIds()).toEqual(['codex']);
  expect(handle.snapshot().workers[0]!.reason).toBe('managed-allocation-unavailable'); expect(f.probe).toHaveBeenCalledOnce();
});
