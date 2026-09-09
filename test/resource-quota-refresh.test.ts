/** Inert injected probes only: no native provider, credential or filesystem contact. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceQuotaRefresher, validateResourceQuotaRefreshConfig,
  type ResourceQuotaRefreshConfig, type ResourceQuotaRefresher, type ResourceQuotaRefresherOptions } from '../src/core/resources/quota-refresh.js';
import { planResourceAssignment, type ResourceObservation, type ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { CodexResourceProbeOptions, CodexResourceProbeResult } from '../src/core/resources/codex-account-probe.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const HINT_A = 'a'.repeat(64); const HINT_B = 'b'.repeat(64);
const handles: ResourceQuotaRefresher[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); });
const time = (ms = Date.now()) => new Date(ms).toISOString();

function fixture(shared = false) {
  const pool: ResourcePool = { schemaVersion: 1, id: 'quota-fixture', workers: ['codex-a', 'codex-b', 'claude', 'local'].map((id) => ({
    id, provider: id.startsWith('codex') ? 'codex' : id === 'claude' ? 'claude' : 'local', model: `fixture-${id}`,
    maxConcurrent: 1, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, reservePercent: 10, allowUnknownQuota: true })) };
  const bindings: ResourceBinding[] = pool.workers.map((worker) => worker.provider === 'local'
    ? { workerId: worker.id, capacityKey: worker.id, kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/v1' }
    : { workerId: worker.id, capacityKey: shared && worker.provider === 'codex' ? 'codex-shared' : worker.id,
      kind: 'native-cli', command: [`/test-owned/${worker.id}`] });
  const config: ResourceQuotaRefreshConfig = { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })), workers: [
    { workerId: 'codex-a', accountHint: HINT_A, bucketIds: ['codex'] },
    { workerId: 'codex-b', accountHint: shared ? HINT_A : HINT_B, bucketIds: ['codex'] }] };
  const options = { pool, bindings, config, cwd: '/test-owned' };
  return { ...options, options };
}
function observed(workerId = 'codex-a', patch: Partial<ResourceObservation> = {}): ResourceObservation {
  return { workerId, observedAt: time(), updatedAt: time(), expiresAt: time(Date.now() + 60_000), health: 'ready', retryAfter: null,
    windows: [{ id: 'codex_codex_primary', usedPercent: 20, resetsAt: time(Date.now() + 3_600_000) }], ...patch };
}
function success(options: CodexResourceProbeOptions, patch: Partial<CodexResourceProbeResult> = {}): CodexResourceProbeResult {
  return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId,
    poolDigest: digest(canonical({ pool: options.pool, bindings: options.bindings })), status: 'observed', reason: 'probe-observed',
    startedAt: time(), finishedAt: time(), accountHint: options.expectedAccountHint!, planType: 'pro',
    observation: observed(options.workerId), ...patch };
}
function start(options: ResourceQuotaRefresherOptions): ResourceQuotaRefresher {
  const handle = createResourceQuotaRefresher(options); handles.push(handle); return handle;
}
async function firstCycle(): Promise<void> { await vi.advanceTimersByTimeAsync(1); }

describe('pinned managed quota configuration', () => {
  it('normalizes bucket sets and deeply detaches all configuration', () => {
    const f = fixture(); f.config.workers[0]!.bucketIds = ['weekly', 'codex'];
    const config = validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings);
    expect(config.workers[0]!.bucketIds).toEqual(['codex', 'weekly']);
    expect(Object.isFrozen(config.workers[0]!.bucketIds)).toBe(true);
    f.config.workers[0]!.bucketIds.push('another'); expect(config.workers[0]!.bucketIds).toHaveLength(2);
  });

  it.each([
    ['unknown property', (config: any) => { config.extra = true; }],
    ['wrong version', (config: any) => { config.schemaVersion = 2; }],
    ['wrong digest', (config: any) => { config.poolDigest = '0'.repeat(64); }],
    ['empty roster', (config: any) => { config.workers = []; }],
    ['duplicate worker', (config: any) => { config.workers[1] = config.workers[0]; }],
    ['unknown worker', (config: any) => { config.workers[0].workerId = 'missing'; }],
    ['non-Codex worker', (config: any) => { config.workers[0].workerId = 'claude'; }],
    ['unhashed hint', (config: any) => { config.workers[0].accountHint = 'private@example.invalid'; }],
    ['uppercase hint', (config: any) => { config.workers[0].accountHint = 'A'.repeat(64); }],
    ['duplicate bucket', (config: any) => { config.workers[0].bucketIds = ['codex', 'codex']; }],
    ['empty buckets', (config: any) => { config.workers[0].bucketIds = []; }],
    ['too many buckets', (config: any) => { config.workers[0].bucketIds = ['a', 'b', 'c', 'd', 'e']; }],
    ['invalid bucket', (config: any) => { config.workers[0].bucketIds = ['CODEX']; }],
    ['row locator', (config: any) => { config.workers[0].command = '/private/wrapper'; }],
  ])('rejects %s', (_label, change) => {
    const f = fixture(); change(f.config); expect(() => validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings)).toThrow('Invalid resource quota refresh');
  });

  it('rejects sparse/accessor records without evaluating accessors', () => {
    const f = fixture(); const getter = vi.fn();
    Object.defineProperty(f.config.workers[0], 'accountHint', { get: getter });
    expect(() => validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const g = fixture(); g.config.workers = Array(1);
    expect(() => validateResourceQuotaRefreshConfig(g.config, g.pool, g.bindings)).toThrow();
  });

  it('pins both policy and actual command prefix', () => {
    const f = fixture(); (f.bindings[0] as { command: string[] }).command.push('--changed');
    expect(() => validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings)).toThrow();
  });

  it('requires every shared-capacity alias with identical hints and bucket sets', () => {
    const f = fixture(true); expect(validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings).workers).toHaveLength(2);
    f.config.workers.pop(); expect(() => validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings)).toThrow();
    const g = fixture(true); g.config.workers[1]!.accountHint = HINT_B;
    expect(() => validateResourceQuotaRefreshConfig(g.config, g.pool, g.bindings)).toThrow();
    const h = fixture(true); h.config.workers[1]!.bucketIds.push('another');
    expect(() => validateResourceQuotaRefreshConfig(h.config, h.pool, h.bindings)).toThrow();
  });

  it('refuses the same reported hint across independently counted capacities', () => {
    const f = fixture(); f.config.workers[1]!.accountHint = HINT_A;
    expect(() => validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings)).toThrow();
  });
});

describe('foreground quota refresh lifecycle', () => {
  it.each(['reject', 'throw', 'missing', 'null', 'unknown', 'accessor'])('treats %s after invocation as terminal cleanup uncertainty', async (kind) => {
    const f = fixture(); const getter = vi.fn(() => 'failed');
    const probe = vi.fn((): Promise<CodexResourceProbeResult> => {
      if (kind === 'throw') throw new Error('PRIVATE native detail');
      if (kind === 'reject') return Promise.reject(new Error('PRIVATE native detail'));
      const value = kind === 'null' ? null : kind === 'unknown' ? { status: 'unexpected' } :
        kind === 'accessor' ? Object.defineProperty({}, 'status', { get: getter }) : {};
      return Promise.resolve(value as CodexResourceProbeResult);
    });
    const handle = start({ ...f.options, _probe: probe }); await firstCycle();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(probe).toHaveBeenCalledTimes(1); expect(getter).not.toHaveBeenCalled();
    expect(handle.snapshot()).toMatchObject({ state: 'closed', workers: [
      { workerId: 'codex-a', status: 'uncertain', reason: 'managed-quota-uncertain', nextAttemptAt: null },
      { workerId: 'codex-b', status: 'closed' }] });
    expect(handle.unavailableWorkerIds()).toEqual(['codex-a', 'codex-b']);
    expect(JSON.stringify(handle.snapshot())).not.toContain('PRIVATE');
    await expect(handle.close()).rejects.toThrow('termination unconfirmed');
  });

  it('keeps cleanup uncertain when an in-flight probe rejects after close begins', async () => {
    const f = fixture(); let reject!: (error: Error) => void;
    const probe = vi.fn(() => new Promise<CodexResourceProbeResult>((_resolve, fail) => { reject = fail; }));
    const handle = start({ ...f.options, _probe: probe }); await firstCycle();
    const closing = expect(handle.close()).rejects.toThrow('termination unconfirmed');
    reject(new Error('PRIVATE late rejection')); await closing;
    expect(probe).toHaveBeenCalledTimes(1); expect(handle.snapshot().workers[0]!.status).toBe('uncertain');
  });

  it('starts only on explicit creation, withholds missing readings, and reads never trigger probes', async () => {
    const f = fixture(); const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings); expect(probe).not.toHaveBeenCalled();
    const handle = start({ ...f.options, _probe: probe });
    expect(handle.unavailableWorkerIds()).toEqual(['codex-a', 'codex-b']);
    expect(handle.readObservations([])).toEqual([]); expect(probe).not.toHaveBeenCalled();
    await firstCycle(); expect(probe).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 20; i++) { handle.readObservations([]); handle.unavailableWorkerIds(); handle.snapshot(); }
    expect(probe).toHaveBeenCalledTimes(2); expect(handle.unavailableWorkerIds()).toEqual([]);
  });

  it('pins options before scheduling and exposes detached metadata without hints, paths or native output', async () => {
    const f = fixture(); const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    const handle = start({ ...f.options, _probe: probe });
    f.config.workers[0]!.accountHint = HINT_B; f.pool.workers[0]!.model = 'mutated';
    (f.bindings[0] as { command: string[] }).command[0] = '/wrong';
    await firstCycle(); const call = probe.mock.calls[0]![0];
    expect(call.expectedAccountHint).toBe(HINT_A); expect(call.pool.workers[0]!.model).toBe('fixture-codex-a');
    expect((call.bindings[0] as { command: string[] }).command[0]).toBe('/test-owned/codex-a');
    const snapshot = handle.snapshot(); expect(Object.isFrozen(snapshot.workers[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/test-owned|accountHint|planType|aaaaaaaa|command/);
    const readings = handle.readObservations([]); expect(Object.isFrozen(readings[0]!.windows)).toBe(true);
  });

  it('uses a single sequential probe and checks each alias launcher separately', async () => {
    const f = fixture(true); let finish!: () => void;
    const probe = vi.fn((options: CodexResourceProbeOptions) => new Promise<CodexResourceProbeResult>((done) => { finish = () => done(success(options)); }));
    const handle = start({ ...f.options, _probe: probe });
    await firstCycle(); expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000); expect(probe).toHaveBeenCalledTimes(1);
    finish(); await firstCycle(); expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]![0].workerId).toBe('codex-b');
    // A fresh first alias cannot make an unproven second wrapper available.
    expect(handle.unavailableWorkerIds()).toEqual(['codex-a', 'codex-b']);
    finish(); await firstCycle(); await handle.close();
  });

  it('refreshes after 30 seconds without extending provider capture age on reads', async () => {
    const f = fixture(); const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    const handle = start({ ...f.options, _probe: probe }); await firstCycle();
    const capture = handle.readObservations([])[0]!.observedAt;
    await vi.advanceTimersByTimeAsync(29_000); expect(probe).toHaveBeenCalledTimes(2);
    expect(handle.readObservations([])[0]!.observedAt).toBe(capture);
    await vi.advanceTimersByTimeAsync(1_010); expect(probe).toHaveBeenCalledTimes(4);
    expect(Date.parse(handle.readObservations([])[0]!.observedAt)).toBeGreaterThan(Date.parse(capture));
  });

  it.each(['failed', 'timed-out', 'cancelled', 'uncertain'] as const)('gates %s probes even with opt-in unknown quota', async (status) => {
    const f = fixture(); const handle = start({ ...f.options,
      _probe: async (options) => success(options, { status, observation: null, reason: '/PRIVATE/token=not-allowed' }) });
    await firstCycle(); expect(handle.readObservations([])).toEqual([]);
    expect(handle.unavailableWorkerIds()).toEqual(['codex-a', 'codex-b']);
    expect(handle.snapshot().workers[0]).toMatchObject({ status, reason: `managed-quota-${status}`, lastSuccessAt: null });
    expect(JSON.stringify(handle.snapshot())).not.toContain('PRIVATE');
  });

  it('keeps previous captured evidence after failure without making it current availability', async () => {
    const f = fixture(); let failing = false;
    const handle = start({ ...f.options, _probe: async (options) => failing ? success(options, { status: 'failed', observation: null }) : success(options) });
    await firstCycle(); const captured = handle.readObservations([]); failing = true;
    await vi.advanceTimersByTimeAsync(30_010);
    expect(handle.readObservations([])).toEqual(captured); expect(handle.unavailableWorkerIds()).toHaveLength(2);
    const base = [observed('codex-a', { windows: [] })];
    expect(handle.readObservations(base)[0]!.workerId).toBe('codex-a');
    expect(handle.unavailableWorkerIds()).toContain('codex-a');
  });

  it('backs off failures and recovers only after a new successful probe', async () => {
    const f = fixture(); let fail = true;
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => fail ? success(options, { status: 'failed', observation: null }) : success(options));
    const handle = start({ ...f.options, _probe: probe }); await firstCycle();
    await vi.advanceTimersByTimeAsync(30_010); expect(probe).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000); expect(probe).toHaveBeenCalledTimes(4);
    fail = false; await vi.advanceTimersByTimeAsync(30_010);
    expect(probe).toHaveBeenCalledTimes(6); expect(handle.unavailableWorkerIds()).toEqual([]);
  });

  it.each([
    ['missing windows', { windows: [] }],
    ['unknown quota', { windows: [{ id: 'codex_codex_primary', usedPercent: null, resetsAt: time(NOW + 100_000) }] }],
    ['missing reset', { windows: [{ id: 'codex_codex_primary', usedPercent: 0, resetsAt: null }] }],
    ['passed reset', { windows: [{ id: 'codex_codex_primary', usedPercent: 0, resetsAt: time(NOW) }] }],
    ['unavailable health', { health: 'unavailable' }],
  ] as const)('gates observed but incomplete %s', async (_label, patch) => {
    const f = fixture(); const handle = start({ ...f.options, _probe: async (options) => success(options,
      { observation: observed(options.workerId, structuredClone(patch) as Partial<ResourceObservation>) }) });
    await firstCycle(); expect(handle.unavailableWorkerIds()).toHaveLength(2);
    expect(handle.readObservations([])).toHaveLength(2);
  });

  it('expires an earlier success while a later refresh remains in flight', async () => {
    const f = fixture(); let finish: (() => void) | undefined; let calls = 0;
    const handle = start({ ...f.options, _probe: (options) => ++calls <= 2 ? Promise.resolve(success(options)) :
      new Promise((done) => { finish = () => done(success(options)); }) });
    await firstCycle(); await vi.advanceTimersByTimeAsync(60_010);
    expect(handle.unavailableWorkerIds()).toHaveLength(2);
    expect(handle.snapshot().workers.every((row) => row.status === 'expired')).toBe(true);
    const closing = handle.close(); finish!(); await closing;
  });

  it.each([
    ['wrong account', { accountHint: HINT_B }],
    ['wrong pool', { poolDigest: '0'.repeat(64) }],
    ['wrong worker', { workerId: 'claude' }],
    ['old captured result', { startedAt: time(NOW - 1) }],
    ['future result', { finishedAt: time(NOW + 1000) }],
    ['wrong scope', { scope: 'private-auth' }],
  ])('refuses %s result without publishing it', async (_label, patch) => {
    const f = fixture(); f.config.workers = [f.config.workers[0]!];
    const handle = start({ ...f.options, _probe: async (options) => ({ ...success(options), ...patch }) as CodexResourceProbeResult });
    await firstCycle(); expect(handle.readObservations([])).toEqual([]); expect(handle.unavailableWorkerIds()).toEqual(['codex-a']);
  });

  it('retains denied windows and partial ages through refresh and external base merging', async () => {
    const f = fixture(); f.config.workers = [f.config.workers[0]!]; let partial = false;
    const initial = observed('codex-a', { windows: [
      { id: 'weekly', usedPercent: 100, resetsAt: time(NOW + 3_600_000) },
      { id: 'primary', usedPercent: 10, resetsAt: time(NOW + 3_600_000) }] });
    const handle = start({ ...f.options, _probe: async (options) => success(options,
      { observation: partial ? observed('codex-a', { windows: [{ id: 'primary', usedPercent: 5, resetsAt: time(NOW + 3_600_000) }] }) : initial }) });
    await firstCycle(); partial = true; await vi.advanceTimersByTimeAsync(30_010);
    const readings = handle.readObservations([observed('local', { windows: [] })]);
    expect(readings.find((row) => row.workerId === 'local')).toEqual(observed('local', { windows: [] }));
    const codex = readings.find((row) => row.workerId === 'codex-a')!;
    expect(codex.observedAt).toBe(initial.observedAt); expect(codex.expiresAt).toBe(initial.expiresAt);
    expect(codex.windows).toContainEqual(initial.windows[0]);
    const plan = planResourceAssignment({ pool: f.pool, observations: readings, allowedWorkerIds: ['codex-a'],
      activeCounts: {}, taskReservationCounts: {}, nowMs: Date.now() });
    expect(plan.selectedWorkerId).toBeNull();
  });

  it('current native exhaustion gates the entire shared capacity despite a newer external zero', async () => {
    const f = fixture(true); const handle = start({ ...f.options, _probe: async (options) => success(options,
      { observation: observed(options.workerId, { windows: [{ id: 'codex_codex_primary', usedPercent: options.workerId === 'codex-a' ? 95 : 0,
        resetsAt: time(NOW + 3_600_000) }] }) }) });
    await firstCycle(); await vi.advanceTimersByTimeAsync(1_000);
    const base = [observed('codex-a', { windows: [{ id: 'codex_codex_primary', usedPercent: 0, resetsAt: time(NOW + 3_600_000) }] })];
    expect(handle.readObservations(base)[0]!.windows[0]!.usedPercent).toBe(0);
    expect(handle.unavailableWorkerIds()).toEqual(['codex-a', 'codex-b']);
    expect(handle.snapshot().workers[0]!.reason).toBe('managed-quota-reserve-reached');
  });

  it('does not contact a probe when the owner signal is already aborted', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    const handle = start({ ...f.options, signal: controller.signal, _probe: probe });
    await firstCycle(); expect(probe).not.toHaveBeenCalled(); expect(handle.snapshot().state).toBe('closed');
    expect(handle.unavailableWorkerIds()).toHaveLength(2);
  });

  it('close aborts and awaits the owned probe, is idempotent and never schedules another', async () => {
    const f = fixture(); let release!: () => void; let probeSignal!: AbortSignal;
    const probe = vi.fn((options: CodexResourceProbeOptions) => { probeSignal = options.signal!;
      return new Promise<CodexResourceProbeResult>((done) => { release = () => done(success(options)); }); });
    const handle = start({ ...f.options, _probe: probe }); await firstCycle();
    let finished = false; const close = handle.close(); expect(handle.close()).toBe(close); void close.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false); expect(probeSignal.aborted).toBe(true);
    release(); await close; expect(finished).toBe(true); await vi.advanceTimersByTimeAsync(600_000);
    expect(probe).toHaveBeenCalledTimes(1); expect(handle.readObservations([])).toEqual([]);
  });

  it('unconfirmed termination stops the entire collector and cannot report a clean close', async () => {
    const f = fixture(); const probe = vi.fn(async (options: CodexResourceProbeOptions) =>
      success(options, { status: 'uncertain', observation: null }));
    const handle = start({ ...f.options, _probe: probe }); await firstCycle();
    await vi.advanceTimersByTimeAsync(600_000); expect(probe).toHaveBeenCalledTimes(1);
    expect(handle.snapshot()).toMatchObject({ state: 'closed', workers: [
      { workerId: 'codex-a', status: 'uncertain', reason: 'managed-quota-uncertain' },
      { workerId: 'codex-b', status: 'closed' }] });
    expect(handle.unavailableWorkerIds()).toEqual(['codex-a', 'codex-b']);
    await expect(handle.close()).rejects.toThrow('termination unconfirmed');
  });

  it('does not discard unconfirmed cleanup when owner cancellation precedes its result', async () => {
    const f = fixture(); let finish!: () => void;
    const handle = start({ ...f.options, _probe: (options) => new Promise((done) => {
      finish = () => done(success(options, { status: 'uncertain', observation: null }));
    }) });
    await firstCycle(); const closing = handle.close(); const rejection = expect(closing).rejects.toThrow('termination unconfirmed');
    finish(); await rejection; expect(handle.snapshot().workers[0]!.status).toBe('uncertain');
  });

  it.each(['before-probe', 'read', 'admission'] as const)('loss of ownership at %s stops future contact', async (when) => {
    const f = fixture(); let owned = when !== 'before-probe'; const probe = vi.fn(async (options: CodexResourceProbeOptions) => success(options));
    const handle = start({ ...f.options, _probe: probe, assertOwnership: () => { if (!owned) throw new Error('PRIVATE lock path'); } });
    if (when !== 'before-probe') await firstCycle();
    owned = false;
    if (when === 'read') handle.readObservations([]);
    if (when === 'admission') handle.unavailableWorkerIds();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probe).toHaveBeenCalledTimes(when === 'before-probe' ? 0 : 2);
    expect(handle.snapshot().state).toBe('closed'); expect(handle.unavailableWorkerIds()).toHaveLength(2);
    expect(JSON.stringify(handle.snapshot())).not.toContain('PRIVATE');
  });
});
