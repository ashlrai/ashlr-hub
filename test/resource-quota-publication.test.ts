/** Inert transports and private fixture roots only; no native provider contact. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as quotas from '../src/core/resources/quota-refresh.js';
import { readSharedQuotaEvidence, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME } from '../src/core/resources/quota-shared-evidence.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle } from '../src/core/web/resource-console-server.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { CodexResourceProbeOptions, CodexResourceProbeResult } from '../src/core/resources/codex-account-probe.js';

let root: string;
const collectors: quotas.ResourceQuotaRefresher[] = [];
const servers: ResourceConsoleServerHandle[] = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-quota-publication-'))); });
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.allSettled(collectors.splice(0).map((collector) => collector.close()));
  vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const pool: ResourcePool = { schemaVersion: 1, id: 'publication', workers: [{ id: 'codex', provider: 'codex', model: 'inert',
    maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'codex', capacityKey: 'account', kind: 'native-cli', command: ['/inert-never-run'] }];
  const config: quotas.ResourceQuotaRefreshConfig = { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
    workers: [{ workerId: 'codex', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] };
  // One capture binds the exact allowed TTL; separate clock reads can make a
  // nominal 60s fixture exceed the native freshness limit by a millisecond.
  const capturedAt = Date.now();
  const observation: ResourceObservation = { workerId: 'codex', observedAt: new Date(capturedAt).toISOString(),
    expiresAt: new Date(capturedAt + quotas.RESOURCE_QUOTA_REFRESH_TTL_MS).toISOString(), health: 'ready', retryAfter: null,
    windows: [{ id: 'primary', usedPercent: 80, resetsAt: new Date(capturedAt + 3600_000).toISOString() }] };
  const probe = vi.fn(async (options: CodexResourceProbeOptions): Promise<CodexResourceProbeResult> => {
    const probedAt = Date.now(); const now = new Date(probedAt).toISOString();
    return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId, poolDigest: config.poolDigest,
      status: 'observed', reason: 'probe-observed', startedAt: now, finishedAt: now,
      accountHint: config.workers[0]!.accountHint, planType: 'pro', observation: { ...observation, observedAt: now,
        expiresAt: new Date(probedAt + quotas.RESOURCE_QUOTA_REFRESH_TTL_MS).toISOString() } };
  });
  return { pool, bindings, config, observation, probe };
}

describe('synchronous quota lifecycle notifications', () => {
  it('publishes start, settlement and close, with safe synchronous close reentry', async () => {
    vi.useFakeTimers(); const f = fixture(); const states: string[] = [];
    const onChange = () => {
      const snapshot = handle.snapshot(); states.push(`${snapshot.state}:${snapshot.workers[0]!.status}`);
      if (snapshot.state === 'closed') void handle.close();
    };
    const handle = quotas.createResourceQuotaRefresher({ ...f, cwd: root, _probe: f.probe, onChange }); collectors.push(handle);
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual(['running:refreshing', 'running:observed']);
    await handle.close(); expect(states).toEqual(['running:refreshing', 'running:observed', 'closed:closed']);
    expect(f.probe).toHaveBeenCalledOnce();
  });

  it('a failed start publication stops before transport and does not retry', async () => {
    vi.useFakeTimers(); const f = fixture();
    const onChange = vi.fn(() => { throw new Error('Fixture publisher failed'); });
    const handle = quotas.createResourceQuotaRefresher({ ...f, cwd: root, _probe: f.probe, onChange }); collectors.push(handle);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.probe).not.toHaveBeenCalled(); expect(onChange).toHaveBeenCalledOnce();
    expect(handle.snapshot().state).toBe('closed');
    await expect(handle.close()).rejects.toThrow('publication failed');
  });
});

async function startStubbedCollector() {
  const f = fixture(); let notify: (() => void) | undefined;
  let captures: ResourceObservation[] = []; let unavailable = ['codex']; let closed = false;
  const readObservations = vi.fn((base: ResourceObservation[]) => [...base, ...captures]);
  const unavailableWorkerIds = vi.fn((_defer?: boolean) => [...unavailable]);
  vi.spyOn(quotas, 'createResourceQuotaRefresher').mockImplementation((options) => {
    notify = options.onChange;
    options.coordinator!.signal.addEventListener('abort', () => { closed = true; notify?.(); }, { once: true });
    return { readObservations, unavailableWorkerIds,
      snapshot: () => ({ schemaVersion: 1, scope: 'codex-native-metadata', state: closed ? 'closed' : 'running',
        sampledAt: new Date().toISOString(), workers: [] }),
      close: async () => { closed = true; notify?.(); } };
  });
  const save = (name: string, value: unknown) => {
    const path = join(root, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path;
  };
  const options = { root: join(root, 'ledger'), poolFile: save('pool.json', f.pool), bindingsFile: save('bindings.json', f.bindings),
    observationsFile: save('observations.json', [f.observation]), quotaConfigFile: save('quota.json', f.config) };
  const server = await startResourceConsoleServer(options); servers.push(server);
  const scope = { ...f, root: options.root };
  return { f, server, options, readObservations, unavailableWorkerIds, read: () => readSharedQuotaEvidence(scope),
    change: (rows: ResourceObservation[], denied: string[]) => { captures = rows; unavailable = denied; notify?.(); } };
}

describe('console-owned shared quota publication', () => {
  it('publishes initial denials, capture transitions and heartbeats without promoting file input', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const value = await startStubbedCollector();
    expect(value.server.scope.readOnly).toBe(true);
    expect(value.read()).toMatchObject({ observations: [], unavailableWorkerIds: ['codex'] });
    expect(value.readObservations).toHaveBeenCalledWith([]);
    expect(value.unavailableWorkerIds).toHaveBeenCalledWith(true);
    value.change([value.f.observation], []);
    // 80% remains real evidence, not a cached veto at the collector's 75% default.
    expect(value.read()).toMatchObject({ observations: [value.f.observation], unavailableWorkerIds: [] });
    const file = join(value.options.root, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME);
    const before = JSON.parse(readFileSync(file, 'utf8'));
    await vi.advanceTimersByTimeAsync(1_000);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(Date.parse(after.publishedAt) - Date.parse(before.publishedAt)).toBe(1_000);
    expect(after.observations).toEqual(before.observations);
    value.change([value.f.observation], ['codex']);
    expect(value.read().unavailableWorkerIds).toEqual(['codex']);
    await value.server.close();
    expect(() => value.read()).toThrow('Shared resource quota evidence unavailable');
    expect(existsSync(join(value.options.root, '.resource-quota-refresh-pending.json'))).toBe(false);
  });

  it('publication failure invalidates prior success immediately and preserves the pending fence', async () => {
    const value = await startStubbedCollector(); value.change([value.f.observation], []);
    expect(Date.parse(value.f.observation.expiresAt) - Date.parse(value.f.observation.observedAt))
      .toBe(quotas.RESOURCE_QUOTA_REFRESH_TTL_MS);
    expect(value.read().unavailableWorkerIds).toEqual([]);
    chmodSync(join(value.options.root, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME), 0o644);
    value.change([value.f.observation], []);
    expect(() => value.read()).toThrow('Shared resource quota evidence unavailable');
    expect(existsSync(join(value.options.root, '.resource-quota-refresh.lock'))).toBe(false);
    expect(existsSync(join(value.options.root, '.resource-quota-refresh-pending.json'))).toBe(true);
    await expect(value.server.close()).rejects.toThrow('shutdown uncertain');
    expect(existsSync(join(value.options.root, '.resource-quota-refresh-pending.json'))).toBe(true);
  });
});
