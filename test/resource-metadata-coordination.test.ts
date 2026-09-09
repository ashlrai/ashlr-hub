/** Real collectors, private fixture ledger and inert transports; never native accounts or providers. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createNativeMetadataCoordinator, type NativeMetadataCoordinator } from '../src/core/resources/metadata-coordinator.js';
import { createResourceConnectionMonitor, type ResourceConnectionMonitor } from '../src/core/resources/connection-monitor.js';
import { createResourceQuotaRefresher, type ResourceQuotaRefresher } from '../src/core/resources/quota-refresh.js';
import type { CodexResourceProbeOptions, CodexResourceProbeResult } from '../src/core/resources/codex-account-probe.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const native = vi.hoisted(() => ({ codex: vi.fn() }));
vi.mock('../src/core/resources/codex-account-probe.js', () => ({ probeCodexResourceAccount: native.codex }));
// Fail the test immediately if an unrelated transport ever enters this fixture.
vi.mock('../src/core/resources/claude-account-usage.js', () => ({ probeClaudeAccountUsage: () => { throw new Error('Unexpected Claude transport'); } }));
vi.mock('../src/core/resources/grok-account-probe.js', () => ({ probeGrokAccount: () => { throw new Error('Unexpected Grok transport'); } }));

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const ids = ['admission-a', 'admission-b'];
let cwd: string;
const collectors: Array<ResourceConnectionMonitor | ResourceQuotaRefresher> = [];
const coordinators: NativeMetadataCoordinator[] = [];
const forceFinish: Array<() => void> = [];
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-metadata-coordination-')));
  vi.useFakeTimers(); vi.setSystemTime(NOW); native.codex.mockReset();
});
afterEach(async () => {
  for (const coordinator of coordinators) coordinator.abort();
  for (const finish of forceFinish.splice(0)) finish();
  await Promise.allSettled(collectors.splice(0).map((collector) => collector.close()));
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  vi.useRealTimers(); vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true });
});
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();

function result(options: CodexResourceProbeOptions, status: CodexResourceProbeResult['status'] = 'observed'): CodexResourceProbeResult {
  return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId,
    poolDigest: digest(canonical({ pool: options.pool, bindings: options.bindings })), status,
    reason: status === 'observed' ? 'probe-observed' : `probe-${status}`,
    startedAt: time(), finishedAt: time(), accountHint: options.expectedAccountHint ?? 'c'.repeat(64), planType: 'pro',
    observation: status === 'observed' ? { workerId: options.workerId, observedAt: time(), expiresAt: time(60_000),
      health: 'ready', retryAfter: null, windows: [{ id: 'primary', usedPercent: 10, resetsAt: time(3_600_000) }] } : null };
}

function fixture(beginNativeActivity?: NonNullable<Parameters<typeof createNativeMetadataCoordinator>[0]>['beginNativeActivity']) {
  const coordinator = createNativeMetadataCoordinator({ maxConcurrent: 2, beginNativeActivity }); coordinators.push(coordinator);
  const pool: ResourcePool = { schemaVersion: 1, id: 'combined-collector-fixture', workers: ids.map((id) => ({
    id, provider: 'codex', model: 'inert', maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 5,
    taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true })) };
  const bindings: ResourceBinding[] = ids.map((id) => ({ workerId: id, capacityKey: id,
    kind: 'native-cli', command: [`/inert-never-executed/${id}`] }));
  const quota = createResourceQuotaRefresher({ pool, bindings, cwd, coordinator,
    config: { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })), workers: ids.map((workerId, index) => ({
      workerId, accountHint: (index ? 'b' : 'a').repeat(64), bucketIds: ['codex'] })) } });
  collectors.push(quota);
  const connect = () => {
    const connections = createResourceConnectionMonitor({ cwd, coordinator, assertOwnership: () => {},
      config: { schemaVersion: 1, intervalMs: 30_000, accounts: ['connection-a', 'connection-b', 'connection-c'].map((id) => ({
        id, label: id, provider: 'codex', command: [`/inert-never-executed/${id}`] })) } });
    collectors.push(connections); return connections;
  };
  return { coordinator, quota, connect };
}

function controlledTransport(holdCancelled = false) {
  let active = 0; let maximum = 0;
  const pending = new Map<string, { options: CodexResourceProbeOptions; finish: (status?: CodexResourceProbeResult['status']) => void; fail: () => void }>();
  native.codex.mockImplementation((options: CodexResourceProbeOptions) => new Promise<CodexResourceProbeResult>((resolve, reject) => {
    active++; maximum = Math.max(maximum, active);
    let finished = false;
    const finish = (status: CodexResourceProbeResult['status'] = 'observed') => {
      if (finished) return; finished = true; active--; pending.delete(options.workerId);
      options.signal?.removeEventListener('abort', aborted); resolve(result(options, status));
    };
    const aborted = () => { if (!holdCancelled) finish('cancelled'); };
    const fail = () => {
      if (finished) return; finished = true; active--; pending.delete(options.workerId);
      options.signal?.removeEventListener('abort', aborted); reject(new Error('Fixture lost native settlement'));
    };
    pending.set(options.workerId, { options, finish, fail }); forceFinish.push(() => finish('cancelled'));
    if (options.signal?.aborted) aborted(); else options.signal?.addEventListener('abort', aborted, { once: true });
  }));
  return { pending, active: () => active, maximum: () => maximum };
}
async function settle() { await vi.advanceTimersByTimeAsync(0); }

describe('shared native metadata coordination across live collectors', () => {
  it('forwards distinct durable lifecycles into quota and connection probes', async () => {
    const transport = controlledTransport();
    const hooks: Array<{ prepare: ReturnType<typeof vi.fn> }> = [];
    const f = fixture(() => {
      const hook = { prepare: vi.fn() }; hooks.push(hook);
      return { processGroupLifecycle: hook, settle: vi.fn() };
    });
    await settle(); f.connect(); await settle();
    expect(hooks).toHaveLength(2);
    expect(transport.pending.get('admission-a')!.options.processGroupLifecycle).toBe(hooks[0]);
    expect(transport.pending.get('connection-a')!.options.processGroupLifecycle).toBe(hooks[1]);
    for (const hook of hooks) expect(hook.prepare).not.toHaveBeenCalled();
  });

  it.each(['quota', 'connections'] as const)('fences missing %s settlement before queued probes launch and awaits active peer cleanup', async (origin) => {
    const transport = controlledTransport(true); const f = fixture(); await settle();
    const connections = f.connect(); await settle();
    const originId = origin === 'quota' ? 'admission-a' : 'connection-a';
    const otherId = origin === 'quota' ? 'connection-a' : 'admission-a';
    const peer = transport.pending.get(otherId)!;
    expect(native.codex).toHaveBeenCalledTimes(2);
    transport.pending.get(originId)!.fail(); await settle();
    expect(f.coordinator.signal.aborted).toBe(true);
    expect(peer.options.signal!.aborted).toBe(true);
    expect(f.quota.unavailableWorkerIds()).toEqual(ids);
    expect(connections.snapshot().accounts.every((account) => account.windows.length === 0 && account.state === 'unavailable')).toBe(true);
    let closed = false;
    const both = Promise.allSettled([f.quota.close(), connections.close()]).then((outcomes) => { closed = true; return outcomes; });
    await settle(); expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(native.codex).toHaveBeenCalledTimes(2);
    peer.finish('cancelled');
    const outcomes = await both;
    expect(outcomes[origin === 'quota' ? 0 : 1]!.status).toBe('rejected');
    expect(outcomes[origin === 'quota' ? 1 : 0]!.status).toBe('fulfilled');
    expect(native.codex).toHaveBeenCalledTimes(2);
  });

  it('bounds total native clients to two across admission and connection collectors', async () => {
    const transport = controlledTransport(); const f = fixture(); await settle();
    expect([...transport.pending.keys()]).toEqual(['admission-a']);
    const connections = f.connect(); await settle();
    expect(transport.active()).toBe(2); expect(native.codex).toHaveBeenCalledTimes(2);
    // A connection queued behind the occupied permits must wait for a real completion.
    expect(transport.pending.has('connection-b')).toBe(false);
    transport.pending.get('admission-a')!.finish(); await settle();
    expect(transport.active()).toBe(2); expect(transport.pending.has('connection-b')).toBe(true);
    for (let turn = 0; turn < 6 && transport.pending.size; turn++) {
      for (const pending of [...transport.pending.values()]) pending.finish();
      await settle();
    }
    expect(transport.maximum()).toBe(2); expect(transport.active()).toBe(0);
    expect(native.codex).toHaveBeenCalledTimes(5);
    expect(f.quota.unavailableWorkerIds()).toEqual([]);
    expect(connections.snapshot().accounts.every((account) => account.windows.length === 1)).toBe(true);
  });

  it.each(['quota', 'connections'] as const)('fans out %s uncertainty before queued probes can start', async (origin) => {
    const transport = controlledTransport(); const f = fixture(); await settle();
    const connections = f.connect(); await settle();
    const originId = origin === 'quota' ? 'admission-a' : 'connection-a';
    const otherId = origin === 'quota' ? 'connection-a' : 'admission-a';
    const otherSignal = transport.pending.get(otherId)!.options.signal!;
    expect(native.codex).toHaveBeenCalledTimes(2);
    transport.pending.get(originId)!.finish('uncertain'); await settle();
    expect(f.coordinator.signal.aborted).toBe(true); expect(otherSignal.aborted).toBe(true);
    expect(native.codex).toHaveBeenCalledTimes(2);
    expect(f.quota.unavailableWorkerIds()).toEqual(ids);
    expect(f.quota.snapshot().state).toBe('closed');
    for (const account of connections.snapshot().accounts) {
      expect(account).toMatchObject({ state: 'unavailable', authentication: 'unknown', health: 'unknown',
        windows: [], reason: 'connection-monitor-stopped' });
    }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(native.codex).toHaveBeenCalledTimes(2); expect(transport.active()).toBe(0);
    if (origin === 'quota') {
      await expect(f.quota.close()).rejects.toThrow('termination unconfirmed');
      await expect(connections.close()).resolves.toBeUndefined();
    } else {
      await expect(connections.close()).rejects.toThrow('cleanup uncertain');
      await expect(f.quota.close()).resolves.toBeUndefined();
    }
  });

  it('withdraws evidence immediately but waits for the other active client to finish cleanup', async () => {
    const transport = controlledTransport(true); const f = fixture(); await settle();
    const connections = f.connect(); await settle();
    transport.pending.get('admission-a')!.finish('uncertain'); await settle();
    const connection = transport.pending.get('connection-a')!;
    expect(connection.options.signal!.aborted).toBe(true);
    expect(connections.snapshot().accounts.every((account) => account.windows.length === 0 && account.state === 'unavailable')).toBe(true);
    let closed = false; const closing = connections.close().then(() => { closed = true; });
    await settle(); expect(closed).toBe(false); expect(native.codex).toHaveBeenCalledTimes(2);
    connection.finish('cancelled'); await closing;
    expect(closed).toBe(true); expect(native.codex).toHaveBeenCalledTimes(2);
    await expect(f.quota.close()).rejects.toThrow('termination unconfirmed');
  });

  it.each(['quota', 'connections'] as const)('withdraws previously successful evidence after later %s uncertainty', async (origin) => {
    native.codex.mockImplementation(async (options: CodexResourceProbeOptions) => result(options));
    const f = fixture(); const connections = f.connect(); await vi.advanceTimersByTimeAsync(1);
    expect(f.quota.unavailableWorkerIds()).toEqual([]);
    expect(f.quota.readObservations([])).toHaveLength(2);
    expect(connections.snapshot().accounts.every((account) => account.windows.length === 1)).toBe(true);
    const transport = controlledTransport(); await vi.advanceTimersByTimeAsync(30_000);
    const originId = origin === 'quota' ? 'admission-a' : 'connection-a';
    // Whichever collector obtained the first permits, admit the chosen origin
    // by finishing an actual peer, never by advancing past a held permit.
    if (!transport.pending.has(originId)) {
      expect(transport.pending.size).toBe(2);
      [...transport.pending.values()][0]!.finish(); await settle();
    }
    expect(transport.pending.has(originId)).toBe(true);
    const callsBeforeAbort = native.codex.mock.calls.length;
    transport.pending.get(originId)!.finish('uncertain'); await settle();
    expect(f.quota.unavailableWorkerIds()).toEqual(ids);
    // Captured admission history may remain, but the explicit gate must veto it.
    expect(f.quota.readObservations([])).toHaveLength(2);
    expect(connections.snapshot().accounts.every((account) => account.windows.length === 0 && account.state === 'unavailable')).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(native.codex).toHaveBeenCalledTimes(callsBeforeAbort);
  });
});
