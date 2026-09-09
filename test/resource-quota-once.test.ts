/** Private temporary leases and injected inert probes only; no provider or credentials. */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { refreshResourceQuotaOnce, type ResourceQuotaRefreshConfig } from '../src/core/resources/quota-refresh.js';
import { acquireResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import * as quotaLease from '../src/core/resources/quota-refresh-lease.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { CodexResourceProbeOptions, CodexResourceProbeResult } from '../src/core/resources/codex-account-probe.js';

let directory: string;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-quota-once-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();

function observation(workerId: string, patch: Partial<ResourceObservation> = {}): ResourceObservation {
  return { workerId, observedAt: time(), expiresAt: time(60_000), health: 'ready', retryAfter: null,
    windows: [{ id: 'codex_primary', usedPercent: 20, resetsAt: time(3_600_000) }], ...patch };
}
function success(options: CodexResourceProbeOptions, patch: Partial<CodexResourceProbeResult> = {}): CodexResourceProbeResult {
  const captured = time();
  return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId,
    poolDigest: digest(canonical({ pool: options.pool, bindings: options.bindings })),
    status: 'observed', reason: 'probe-observed', accountHint: options.expectedAccountHint!, planType: 'pro',
    startedAt: captured, finishedAt: captured, observation: observation(options.workerId, { observedAt: captured,
      expiresAt: new Date(Date.parse(captured) + 60_000).toISOString() }), ...patch };
}
function fixture(shared = false) {
  const pool: ResourcePool = { schemaVersion: 1, id: 'quota-once', workers: ['codex-a', 'codex-b', 'local'].map((id) => ({
    id, provider: id === 'local' ? 'local' : 'codex', model: 'inert-fixture', maxConcurrent: 1,
    maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, reservePercent: 10, allowUnknownQuota: true })) };
  const bindings: ResourceBinding[] = pool.workers.map((worker) => worker.provider === 'local'
    ? { workerId: worker.id, capacityKey: worker.id, kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/v1' }
    : { workerId: worker.id, capacityKey: shared ? 'shared-codex' : worker.id,
      kind: 'native-cli', command: [`/inert-test-owned/${worker.id}`] });
  const config: ResourceQuotaRefreshConfig = { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
    workers: ['codex-a', 'codex-b'].map((workerId, index) => ({ workerId,
      accountHint: shared || index === 0 ? 'a'.repeat(64) : 'b'.repeat(64), bucketIds: ['codex'] })) };
  const cwd = join(directory, 'control');
  const observations = [observation('local', { windows: [] })];
  const options = { pool, bindings, config, cwd, observations, timeoutMs: 5000 };
  const marker = join(cwd, '.resource-quota-refresh-pending.json');
  const lock = join(cwd, '.resource-quota-refresh.lock');
  return { ...options, options, marker, lock };
}

describe('one explicit quota capture pass', () => {
  it.each(['config', 'observations', 'cwd', 'probe', 'ownership', 'timeout-zero', 'timeout-large', 'timeout-fraction'])(
    'validates %s before creating state or contacting a probe', async (kind) => {
      const f = fixture(); const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
      const options: any = { ...f.options, _probe: probe };
      if (kind === 'config') options.config = { ...f.config, poolDigest: '0'.repeat(64) };
      if (kind === 'observations') options.observations = [{}];
      if (kind === 'cwd') options.cwd = 'relative';
      if (kind === 'probe') options._probe = 'not-a-function';
      if (kind === 'ownership') options.assertOwnership = 'not-a-function';
      if (kind === 'timeout-zero') options.timeoutMs = 0;
      if (kind === 'timeout-large') options.timeoutMs = 900_001;
      if (kind === 'timeout-fraction') options.timeoutMs = 1.5;
      await expect(refreshResourceQuotaOnce(options)).rejects.toThrow(/Invalid/);
      expect(probe).not.toHaveBeenCalled(); expect(existsSync(f.cwd)).toBe(false);
    });

  it('is inert when pre-aborted, without promoting supplied ready readings', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    const result = await refreshResourceQuotaOnce({ ...f.options, signal: controller.signal, _probe: probe });
    expect(result).toEqual({ observations: f.observations, unavailableWorkerIds: ['codex-a', 'codex-b'] });
    expect(probe).not.toHaveBeenCalled(); expect(existsSync(f.cwd)).toBe(false);
  });

  it('publishes the fence before one sequential attempt per alias and removes it only on clean completion', async () => {
    const f = fixture(true); const calls: string[] = []; let active = 0; let maximum = 0;
    const result = await refreshResourceQuotaOnce({ ...f.options, _probe: async (options) => {
      active++; maximum = Math.max(maximum, active); calls.push(options.workerId);
      expect(existsSync(f.marker)).toBe(true); expect(existsSync(f.lock)).toBe(true);
      // The bounded one-shot wrapper must retain the per-operation hook.
      expect(options.processGroupLifecycle).toBeDefined();
      const command = options.processGroupLifecycle!.prepare();
      command.settled('not-started'); // This injected probe never spawns a process.
      await Promise.resolve(); active--; return success(options);
    } });
    expect(calls).toEqual(['codex-a', 'codex-b']); expect(maximum).toBe(1);
    expect(result.unavailableWorkerIds).toEqual([]); expect(result.observations).toHaveLength(3);
    expect(result.observations.find((row) => row.workerId === 'local')).toEqual(f.observations[0]);
    expect(existsSync(f.marker)).toBe(false); expect(existsSync(f.lock)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/accountHint|inert-test-owned|planType|aaaaaaaa/);
  });

  it.each(['failed', 'timed-out', 'cancelled'] as const)('gates %s results without retrying or falling back to external readiness', async (status) => {
    const f = fixture(true); let calls = 0;
    const result = await refreshResourceQuotaOnce({ ...f.options, observations: [observation('codex-a'), observation('codex-b')],
      _probe: async (options) => { calls++; return success(options, options.workerId === 'codex-a'
        ? { status, observation: null, reason: '/PRIVATE/token=secret' } : {}); } });
    expect(calls).toBe(2); expect(result.unavailableWorkerIds).toEqual(['codex-a', 'codex-b']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(existsSync(f.marker)).toBe(false);
  });

  it.each(['account', 'pool', 'future', 'old-capture', 'unknown', 'exhausted', 'unavailable'])(
    'does not grant availability from %s metadata', async (kind) => {
      const f = fixture(); f.config.workers = [f.config.workers[0]!];
      const probe = vi.fn(async (options: CodexResourceProbeOptions) => {
        const result = success(options);
        if (kind === 'account') result.accountHint = 'c'.repeat(64);
        if (kind === 'pool') result.poolDigest = '0'.repeat(64);
        if (kind === 'future') result.finishedAt = time(1000);
        if (kind === 'old-capture') result.startedAt = time(-1000);
        if (kind === 'unknown') result.observation!.windows[0]!.usedPercent = null;
        if (kind === 'exhausted') result.observation!.windows[0]!.usedPercent = 100;
        if (kind === 'unavailable') result.observation!.health = 'unavailable';
        return result;
      });
      const result = await refreshResourceQuotaOnce({ ...f.options, observations: [observation('codex-a')], _probe: probe });
      expect(result.unavailableWorkerIds).toEqual(['codex-a']); expect(probe).toHaveBeenCalledOnce();
      expect(existsSync(f.marker)).toBe(false);
    });

  it('keeps early readings expired when a later alias finishes much later', async () => {
    const f = fixture(); let offset = 0; const actualNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + offset);
    const result = await refreshResourceQuotaOnce({ ...f.options, _probe: async (options) => {
      if (options.workerId === 'codex-b') offset = 61_000;
      return success(options);
    } });
    expect(result.unavailableWorkerIds).toEqual(['codex-a']);
    expect(Date.parse(result.observations.find((row) => row.workerId === 'codex-a')!.expiresAt)).toBeLessThan(Date.now());
  });

  it.each(['reject', 'throw', 'missing', 'null', 'unknown'])('retains the pending fence after %s loses settlement, without attempting another alias', async (kind) => {
    const f = fixture(); const calls: string[] = [];
    let pendingContents: string | undefined;
    const running = refreshResourceQuotaOnce({ ...f.options, _probe: (options) => {
      calls.push(options.workerId); pendingContents = readFileSync(f.marker, 'utf8');
      if (kind === 'throw') throw new Error('/PRIVATE/account-auth');
      if (kind === 'reject') return Promise.reject(new Error('/PRIVATE/account-auth'));
      return Promise.resolve((kind === 'null' ? null : kind === 'unknown' ? { status: 'unexpected' } : {}) as CodexResourceProbeResult);
    } });
    await expect(running).rejects.toThrow('Resource quota refresh cleanup unconfirmed');
    expect(calls).toEqual(['codex-a']); expect(readFileSync(f.marker, 'utf8')).toBe(pendingContents);
    await expect(acquireResourceQuotaRefreshLease(f.cwd)).rejects.toThrow(/pending|unconfirmed/);
  });

  it('awaits a cancelled active probe, never contacting the next alias', async () => {
    const f = fixture(); const controller = new AbortController(); let release!: () => void;
    let started!: () => void; const active = new Promise<void>((done) => { started = done; });
    const probe = vi.fn((options: CodexResourceProbeOptions) => new Promise<CodexResourceProbeResult>((done) => {
      release = () => done(success(options, { status: 'cancelled', observation: null }));
      options.signal!.addEventListener('abort', () => {}, { once: true }); started();
    }));
    let settled = false;
    const running = refreshResourceQuotaOnce({ ...f.options, signal: controller.signal, _probe: probe }).then((value) => { settled = true; return value; });
    await active; controller.abort(); await Promise.resolve();
    expect(settled).toBe(false); expect(probe.mock.calls[0]![0].signal!.aborted).toBe(true);
    expect(existsSync(f.marker)).toBe(true); expect(existsSync(f.lock)).toBe(true);
    release(); const result = await running;
    expect(result.unavailableWorkerIds).toEqual(['codex-a', 'codex-b']); expect(probe).toHaveBeenCalledOnce();
    expect(existsSync(f.marker)).toBe(false); expect(existsSync(f.lock)).toBe(false);
  });

  it('uses the remaining monotonic budget for each probe and never starts an alias after deadline', async () => {
    const f = fixture(); let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => { expect(options.timeoutMs).toBe(5000); elapsed = 5001; return success(options); });
    const result = await refreshResourceQuotaOnce({ ...f.options, _probe: probe });
    expect(probe).toHaveBeenCalledOnce(); expect(result.unavailableWorkerIds).toEqual(['codex-a', 'codex-b']);
    expect(existsSync(f.marker)).toBe(false);
  });

  it('caps each alias at ten seconds and reduces the next probe budget by elapsed time', async () => {
    const f = fixture(); let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const budgets: number[] = [];
    const result = await refreshResourceQuotaOnce({ ...f.options, timeoutMs: 20_000, _probe: async (options) => {
      budgets.push(options.timeoutMs!); elapsed += 11_500; return success(options);
    } });
    expect(budgets).toEqual([10_000, 8_500]);
    expect(result.unavailableWorkerIds).toEqual(['codex-a', 'codex-b']);
    expect(existsSync(f.marker)).toBe(false);
  });

  it('sanitizes lost caller ownership before publishing a marker or contacting a probe', async () => {
    const f = fixture(); const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    await expect(refreshResourceQuotaOnce({ ...f.options, _probe: probe,
      assertOwnership: () => { throw new Error('/PRIVATE/ownership-path'); } })).rejects.toThrow('Resource quota refresh could not complete');
    expect(probe).not.toHaveBeenCalled(); expect(existsSync(f.marker)).toBe(false); expect(existsSync(f.lock)).toBe(false);
  });

  it('checks elapsed acquisition time before marking or launching a probe', async () => {
    const f = fixture(); let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    const running = refreshResourceQuotaOnce({ ...f.options, _probe: probe }); elapsed = 5001;
    const result = await running;
    expect(result.unavailableWorkerIds).toEqual(['codex-a', 'codex-b']); expect(probe).not.toHaveBeenCalled();
    expect(existsSync(f.marker)).toBe(false); expect(existsSync(f.lock)).toBe(false);
  });

  it('aborts the active probe when its overall time budget expires', async () => {
    const f = fixture(); const probe = vi.fn((options: CodexResourceProbeOptions) => new Promise<CodexResourceProbeResult>((done) => {
      expect(options.timeoutMs).toBeLessThanOrEqual(2000);
      options.signal!.addEventListener('abort', () => done(success(options, { status: 'cancelled', observation: null })), { once: true });
    }));
    const result = await refreshResourceQuotaOnce({ ...f.options, timeoutMs: 2000, _probe: probe });
    expect(probe).toHaveBeenCalledOnce(); expect(result.unavailableWorkerIds).toEqual(['codex-a', 'codex-b']);
    expect(existsSync(f.marker)).toBe(false);
  });

  it('settles a reservation when the budget expires before any native call starts', async () => {
    const f = fixture(); let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const acquire = quotaLease.acquireResourceQuotaRefreshLease;
    vi.spyOn(quotaLease, 'acquireResourceQuotaRefreshLease').mockImplementation(async (...args) => {
      const lease = await acquire(...args);
      return { ...lease, beginNativeActivity() {
        const activity = lease.beginNativeActivity(); elapsed = 5001; return activity;
      } };
    });
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    const result = await refreshResourceQuotaOnce({ ...f.options, _probe: probe });
    expect(probe).not.toHaveBeenCalled(); expect(result.unavailableWorkerIds).toEqual(['codex-a', 'codex-b']);
    expect(existsSync(f.marker)).toBe(false); expect(existsSync(f.lock)).toBe(false);
  });

  it('preserves uncertain cleanup even when cancellation preceded the result', async () => {
    const f = fixture(); const controller = new AbortController(); let release!: () => void;
    let started!: () => void; const active = new Promise<void>((done) => { started = done; });
    const probe = vi.fn((options: CodexResourceProbeOptions) => new Promise<CodexResourceProbeResult>((done) => {
      release = () => done(success(options, { status: 'uncertain', observation: null })); started();
    }));
    const running = refreshResourceQuotaOnce({ ...f.options, signal: controller.signal, _probe: probe });
    const rejected = expect(running).rejects.toThrow(/cleanup unconfirmed/);
    await active; controller.abort(); release(); await rejected;
    expect(probe).toHaveBeenCalledOnce(); expect(existsSync(f.marker)).toBe(true); expect(existsSync(f.lock)).toBe(false);
    expect(readFileSync(f.marker, 'utf8')).not.toMatch(/accountHint|inert-test-owned|aaaaaaaa/);
    await expect(refreshResourceQuotaOnce({ ...f.options, _probe: probe })).rejects.toThrow();
    expect(probe).toHaveBeenCalledOnce();
  });

  it('refuses an existing shared collector lease without starting a probe', async () => {
    const f = fixture(); const owner = await acquireResourceQuotaRefreshLease(f.cwd); owner.markPending();
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    try { await expect(refreshResourceQuotaOnce({ ...f.options, _probe: probe })).rejects.toThrow(); }
    finally { owner.close(); }
    expect(probe).not.toHaveBeenCalled();
  });

  it('stops after an owned marker changes and preserves that marker on cleanup failure', async () => {
    const f = fixture(); const replacement = '{"state":"requires-owner-reconciliation"}\n';
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => {
      writeFileSync(f.marker, replacement, { mode: 0o600 }); return success(options);
    });
    await expect(refreshResourceQuotaOnce({ ...f.options, _probe: probe })).rejects.toThrow('Resource quota refresh lease cleanup unconfirmed');
    expect(probe).toHaveBeenCalledOnce(); expect(readFileSync(f.marker, 'utf8')).toBe(replacement);
    await expect(refreshResourceQuotaOnce({ ...f.options, _probe: probe })).rejects.toThrow();
    expect(probe).toHaveBeenCalledOnce();
  });
});
