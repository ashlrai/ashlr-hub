/** Inert provider mocks only: no native executable, authentication, or network calls. */
import { mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceConnectionMonitor, validateResourceConnectionConfig, expireConnectionRow,
  type ResourceConnectionConfig, type ResourceConnectionMonitor } from '../src/core/resources/connection-monitor.js';
import { createNativeMetadataCoordinator } from '../src/core/resources/metadata-coordinator.js';

const probes = vi.hoisted(() => ({ codex: vi.fn(), claude: vi.fn(), grok: vi.fn() }));
vi.mock('../src/core/resources/codex-account-probe.js', () => ({ probeCodexResourceAccount: probes.codex }));
vi.mock('../src/core/resources/claude-account-usage.js', () => ({ probeClaudeAccountUsage: probes.claude }));
vi.mock('../src/core/resources/grok-account-probe.js', () => ({ probeGrokAccount: probes.grok }));
const NOW = '2026-09-08T12:00:00.000Z'; const EXPIRES = '2026-09-08T12:01:00.000Z';
const HINT = 'a'.repeat(64); const GROK_HINT = 'b'.repeat(64);
const handles: ResourceConnectionMonitor[] = []; let cwd: string;
const quota = () => [{ id: 'primary', usedPercent: 23, resetsAt: EXPIRES }];
const codex = () => ({ status: 'observed', reason: 'probe-observed', accountHint: HINT, planType: 'pro',
  observation: { observedAt: NOW, expiresAt: EXPIRES, windows: quota() } });
const grok = () => ({ status: 'observed', reason: 'probe-observed', accountHint: GROK_HINT, planType: 'SuperGrok Heavy',
  loggedIn: true, observedAt: NOW, expiresAt: EXPIRES, windows: quota(), onDemandEnabled: false });
const claude = (loggedIn = true) => ({ status: 'observed', reason: 'status-observed', loggedIn,
  subscriptionType: 'max', startedAt: NOW, windows: [], accountHint: null });
function config(providers: Array<'codex' | 'claude' | 'grok'> = ['codex', 'claude', 'grok']): ResourceConnectionConfig {
  return { schemaVersion: 1, intervalMs: 30_000, accounts: providers.map((provider, index) => ({
    id: `${provider}-${index}`, label: `Account ${index}`, provider, command: [`/private/inert-fixture/${provider}`, '--profile'] })) };
}
function start(options: Partial<Parameters<typeof createResourceConnectionMonitor>[0]> = {}) {
  const handle = createResourceConnectionMonitor({ config: config(), cwd, assertOwnership: () => {}, ...options });
  handles.push(handle); return handle;
}
async function settle() { await vi.advanceTimersByTimeAsync(0); }
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-connection-monitor-test-')));
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  probes.codex.mockReset().mockImplementation(async () => codex());
  probes.claude.mockReset().mockImplementation(async () => claude());
  probes.grok.mockReset().mockImplementation(async () => grok());
});
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  vi.useRealTimers(); vi.restoreAllMocks(); rmdirSync(cwd);
});

describe('explicit connection configuration', () => {
  it('detaches command and account arrays', () => {
    const original = config(); const checked = validateResourceConnectionConfig(original);
    original.accounts[0]!.command.push('changed'); original.accounts.pop();
    expect(checked.accounts).toHaveLength(3); expect(checked.accounts[0]!.command).toHaveLength(2);
  });
  it.each([
    ['extra configuration field', (v: any) => { v.extra = true; }],
    ['short interval', (v: any) => { v.intervalMs = 29_999; }],
    ['long interval', (v: any) => { v.intervalMs = 3_600_001; }],
    ['empty accounts', (v: any) => { v.accounts = []; }],
    ['sparse accounts', (v: any) => { v.accounts = Array(2); }],
    ['duplicate account', (v: any) => { v.accounts[1].id = v.accounts[0].id; }],
    ['relative command', (v: any) => { v.accounts[0].command[0] = 'codex'; }],
    ['sparse command', (v: any) => { v.accounts[0].command = Array(1); }],
    ['boxed provider', (v: any) => { v.accounts[0].provider = new String('codex'); }],
    ['private identity hint', (v: any) => { v.accounts[0].expectedAccountHint = 'private@example.invalid'; }],
  ])('rejects %s before any provider call', (_label, change) => {
    const value = config(); change(value); expect(() => start({ config: value })).toThrow('Invalid native connection');
    expect(probes.codex).not.toHaveBeenCalled(); expect(probes.claude).not.toHaveBeenCalled(); expect(probes.grok).not.toHaveBeenCalled();
  });
  it('does not evaluate coercion or accessor code during validation', () => {
    const value: any = config(); const coercion = vi.fn(() => 'codex'); value.accounts[0].provider = { toString: coercion };
    expect(() => validateResourceConnectionConfig(value)).toThrow(); expect(coercion).not.toHaveBeenCalled();
    const getter = vi.fn(() => 'codex'); Object.defineProperty(value.accounts[0], 'provider', { get: getter });
    expect(() => validateResourceConnectionConfig(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});

describe('native metadata monitoring', () => {
  it('collects all explicitly enrolled accounts beyond eight with the existing probe concurrency bound', async () => {
    let active = 0; let peak = 0;
    probes.codex.mockImplementation(async () => {
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return codex();
    });
    const large = config(Array.from({ length: 24 }, () => 'codex'));
    const handle = start({ config: large }); await settle();
    expect(handle.snapshot().accounts).toHaveLength(24);
    expect(handle.snapshot().accounts.every(row => row.authentication === 'signed-in')).toBe(true);
    expect(probes.codex).toHaveBeenCalledTimes(24); expect(peak).toBe(2);
    const duplicate = { ...large, accounts: [...large.accounts, large.accounts[0]!] };
    expect(() => validateResourceConnectionConfig(duplicate)).toThrow();
  });

  it.each(['failed', 'timed-out'] as const)('publishes fast later accounts while an earlier 20s %s probe is pending', async (status) => {
    let active = 0; let peak = 0;
    const started = Date.now();
    const completed = new Map<string, number>();
    const delayed = <T>(id: string, value: T, delay: number): Promise<T> => {
      active++; peak = Math.max(peak, active);
      return new Promise((resolve) => setTimeout(() => {
        active--; completed.set(id, Date.now() - started); resolve(value);
      }, delay));
    };
    const roster = config(['claude', 'codex', 'grok', 'codex']);
    probes.claude.mockImplementation(() => delayed('slow', { status, reason: 'usage-probe-unavailable' }, 20_000));
    probes.codex.mockImplementation(({ workerId }: { workerId: string }) => delayed(workerId, codex(), 10));
    probes.grok.mockImplementation(() => delayed('grok-2', grok(), 10));
    const handle = start({ config: roster });
    try {
      await vi.advanceTimersByTimeAsync(30);
      const snapshot = handle.snapshot();
      expect(snapshot.refreshing).toBe(true);
      expect(snapshot.accounts[0]).toMatchObject({ state: 'checking', authentication: 'unknown', windows: [] });
      // Each free native slot advances independently: a slow or eventually
      // failed provider must not hide another provider's completed metadata.
      for (const row of snapshot.accounts.slice(1)) expect(row).toMatchObject({
        state: 'observed', authentication: 'signed-in', windows: quota(),
      });
      expect([...completed.entries()]).toEqual([['codex-1', 10], ['grok-2', 20], ['codex-3', 30]]);
      expect(peak).toBe(2); expect(active).toBe(1);
      expect(probes.claude).toHaveBeenCalledOnce();
      expect(probes.codex).toHaveBeenCalledTimes(2); expect(probes.grok).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(19_970);
      expect(handle.snapshot()).toMatchObject({ refreshing: false, accounts: [
        { state: 'unavailable', authentication: 'unknown', windows: [], reason: 'usage-probe-unavailable' },
        { state: 'observed' }, { state: 'observed' }, { state: 'observed' },
      ] });
      expect(active).toBe(0); expect(peak).toBe(2);
    } finally {
      // Complete the inert delayed fixture even if a latency assertion fails.
      // Monitor close still awaits every owned probe; the test must not leak it.
      const closing = handle.close();
      await vi.advanceTimersByTimeAsync(20_000);
      await closing;
    }
  });

  it('qualifies current structured Claude quota with an opaque account hash, then clears its expired identity', async () => {
    const windows = [
      { id: 'five_hour', usedPercent: 0, resetsAt: '2026-09-08T15:00:00.000Z', nativeReport: { source: 'claude-usage-structured', resetDescription: null } },
      { id: 'seven_day', usedPercent: 28.5, resetsAt: '2026-09-10T12:00:00.000Z', nativeReport: { source: 'claude-usage-structured', resetDescription: null },
        resetProvenance: { kind: 'weekly-deadline', at: '2026-09-10T12:00:00.000Z', source: 'claude-native-usage-report', plan: 'max', description: null } },
    ];
    probes.claude.mockResolvedValue({ ...claude(), accountHint: HINT, quotaFresh: true, windows });
    const handle = start({ config: config(['claude']) }); await settle();
    expect(handle.snapshot().accounts[0]).toMatchObject({ health: 'reachable', windows, observedAt: NOW, expiresAt: EXPIRES });
    expect(handle.snapshot().accounts[0]?.accountHint).toBe(HINT);
    probes.claude.mockResolvedValue({ status: 'timed-out', reason: 'probe-timed-out' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ health: 'unavailable', windows: [], observedAt: null });
  });

  it('qualifies a Claude billing boundary only from current explicit native false, and clears it when unavailable',async()=>{
    probes.claude.mockResolvedValue({...claude(),accountHint:HINT,quotaFresh:true,windows:quota(),extraUsageEnabled:false});
    const handle=start({config:config(['claude'])});await settle();
    expect(handle.snapshot().accounts[0]?.subscriptionOnlyBoundary).toMatchObject({source:'claude-native-extra-usage',accountHint:HINT,creditsEnabled:false,observedAt:NOW,expiresAt:EXPIRES});
    probes.claude.mockResolvedValue({...claude(),accountHint:HINT,quotaFresh:true,windows:quota(),extraUsageEnabled:true});
    await vi.advanceTimersByTimeAsync(30000);expect(handle.snapshot().accounts[0]?.subscriptionOnlyBoundary).toBeUndefined();
    probes.claude.mockResolvedValue({status:'timed-out',reason:'probe-timed-out'});
    await vi.advanceTimersByTimeAsync(30000);expect(handle.snapshot().accounts[0]?.accountHint).toBeNull();
    expect(handle.snapshot().accounts[0]?.subscriptionOnlyBoundary).toBeUndefined();
  });

  it('keeps a verified Codex window for display across transient failures, without renewing its expiry or auth', async () => {
    const handle = start({ config: config(['codex']) }); await settle();
    const observed = handle.snapshot().accounts[0]!;
    expect(observed).toMatchObject({ state: 'observed', authentication: 'signed-in', windows: quota(), observedAt: NOW, expiresAt: EXPIRES });

    probes.codex.mockResolvedValue({ status: 'timed-out', reason: 'probe-timed-out' });
    await vi.advanceTimersByTimeAsync(30_000);
    const retained = handle.snapshot().accounts[0]!;
    expect(retained).toMatchObject({ state: 'unavailable', authentication: 'unknown', health: 'unavailable',
      reason: 'probe-timed-out', windows: quota(), observedAt: NOW, expiresAt: EXPIRES });
    expect(JSON.stringify(retained)).not.toContain(HINT);
    expect(JSON.stringify(retained)).not.toContain('/private/inert-fixture');

    // A read at the exact expiry must clear the meter even before the next
    // scheduled probe has settled. Repeated failures cannot extend its TTL.
    vi.setSystemTime(EXPIRES);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', authentication: 'unknown',
      windows: [], observedAt: null, expiresAt: null, reason: 'connection-reading-expired' });
  });

  it('withdraws expired Claude and Grok readings before the next native cycle settles', async () => {
    const handle = start({ config: config(['claude', 'grok']) }); await settle();
    for (const row of handle.snapshot().accounts) expect(row).toMatchObject({ state: 'observed', authentication: 'signed-in' });
    // Snapshot is a read-only projection, so an expiry between cycles must not
    // wait for a future native probe to stop claiming current access.
    vi.setSystemTime(EXPIRES);
    for (const row of handle.snapshot().accounts) expect(row).toMatchObject({
      state: 'unavailable', authentication: 'unknown', health: 'unknown', planType: null,
      windows: [], observedAt: null, expiresAt: null, reason: 'connection-reading-expired',
    });
  });

  it('does not resurrect a verified Codex window after repeat failures or identity change', async () => {
    const extended = '2026-09-08T12:02:00.000Z';
    probes.codex.mockResolvedValueOnce({ ...codex(), observation: { observedAt: NOW, expiresAt: extended, windows: quota() } });
    const handle = start({ config: config(['codex']) }); await settle();
    probes.codex.mockResolvedValue({ status: 'failed', reason: 'probe-process-failed' });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', windows: quota(), expiresAt: extended,
      reason: 'probe-process-failed' });
    probes.codex.mockResolvedValue({ status: 'failed', reason: 'probe-account-hint-mismatch' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', windows: [], observedAt: null,
      reason: 'probe-account-hint-mismatch' });
    probes.codex.mockResolvedValue({ status: 'timed-out', reason: 'probe-timed-out' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]!.windows).toEqual([]);
  });

  it('replaces a degraded Codex reading only after a fresh successful probe', async () => {
    const handle = start({ config: config(['codex']) }); await settle();
    probes.codex.mockResolvedValueOnce({ status: 'failed', reason: 'probe-native-unavailable' })
      .mockResolvedValueOnce({ ...codex(), observation: { observedAt: '2026-09-08T12:01:00.000Z',
        expiresAt: '2026-09-08T12:02:00.000Z', windows: [{ id: 'primary', usedPercent: 29, resetsAt: EXPIRES }] } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', windows: quota() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'observed', authentication: 'signed-in',
      observedAt: '2026-09-08T12:01:00.000Z', windows: [{ usedPercent: 29 }] });
  });
  it.each(['codex', 'claude', 'grok'] as const)('forwards the durable lifecycle into %s without publishing it', async (provider) => {
    const processGroupLifecycle = { prepare: vi.fn() }; const settled = vi.fn();
    const coordinator = createNativeMetadataCoordinator({
      beginNativeActivity: () => ({ processGroupLifecycle, settle: settled }),
    });
    try {
      const handle = start({ config: config([provider]), coordinator }); await settle();
      expect(probes[provider].mock.calls[0]![0].processGroupLifecycle).toBe(processGroupLifecycle);
      expect(processGroupLifecycle.prepare).not.toHaveBeenCalled();
      expect(settled).toHaveBeenCalledOnce();
      expect(JSON.stringify(handle.snapshot())).not.toMatch(/processGroupLifecycle|prepare/);
      await handle.close();
    } finally { coordinator.dispose(); }
  });

  it('keeps Claude native reports display-only and pins its private identity across cycles', async () => {
    const window = { id: 'seven_day', usedPercent: 1, resetsAt: null,
      nativeReport: { source: 'claude-usage', resetDescription: null } };
    probes.claude.mockResolvedValue({ ...claude(), accountHint: HINT, reason: 'usage-native-reported', windows: [window] });
    const handle = start({ config: config(['claude']) }); await settle();
    expect(handle.snapshot().accounts[0]).toMatchObject({ windows: [window], health: 'unknown', authentication: 'signed-in' });
    expect(JSON.stringify(handle.snapshot())).not.toContain(HINT);
    probes.claude.mockResolvedValue({ ...claude(), accountHint: GROK_HINT, windows: [window] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', authentication: 'unknown', windows: [], reason: 'usage-account-changed' });
  });
  it('honors an explicit initial Claude identity pin', async () => {
    const value = config(['claude']); value.accounts[0]!.expectedAccountHint = HINT;
    probes.claude.mockResolvedValue({ ...claude(), accountHint: GROK_HINT });
    const handle = start({ config: value }); await settle();
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', reason: 'usage-account-changed', windows: [] });
  });
  it('projects available adapters separately from provider-specific quota and task readiness', async () => {
    const handle = start(); await settle(); const snapshot = handle.snapshot();
    expect(snapshot.refreshing).toBe(false);
    expect(snapshot.accounts[0]).toMatchObject({ authentication: 'signed-in', health: 'reachable', windows: quota(), executionSupported: true });
    expect(snapshot.accounts[1]).toMatchObject({ authentication: 'signed-in', health: 'unknown', windows: [], planType: 'max' });
    expect(snapshot.accounts[2]).toMatchObject({ authentication: 'signed-in', health: 'reachable', executionSupported: true,
      planType: 'SuperGrok Heavy', onDemandEnabled: false });
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.accounts[0]?.accountHint).toBe(HINT); expect(snapshot.accounts[2]?.accountHint).toBe(GROK_HINT);
    expect(serialized).not.toContain('/private/inert-fixture');
  });
  it('keeps Grok adapter availability through unchecked, expired and failed account evidence', async () => {
    const handle = start({ config: config(['grok']) });
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'checking', authentication: 'unknown',
      executionSupported: true, windows: [], onDemandEnabled: null });
    await settle();
    const current = handle.snapshot().accounts[0]!;
    expect(expireConnectionRow(current, Date.parse(EXPIRES))).toMatchObject({ state: 'unavailable', authentication: 'unknown',
      executionSupported: true, windows: [], observedAt: null, onDemandEnabled: false });
    probes.grok.mockResolvedValue({ status: 'failed', reason: 'probe-account-unavailable' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', authentication: 'unknown',
      executionSupported: true, windows: [], onDemandEnabled: null });
    expect(probes.grok).toHaveBeenCalledTimes(2);
  });
  it('shows explicit Claude signed-out state', async () => {
    probes.claude.mockResolvedValue(claude(false)); const handle = start({ config: config(['claude']) }); await settle();
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'signed-out', authentication: 'signed-out', health: 'unknown', windows: [] });
  });
  it('deeply detaches browser snapshots', async () => {
    const handle = start(); await settle(); const snapshot = handle.snapshot();
    snapshot.accounts[0]!.windows[0]!.usedPercent = 99; snapshot.accounts[0]!.label = 'changed'; snapshot.accounts.pop();
    expect(handle.snapshot().accounts).toHaveLength(3);
    expect(handle.snapshot().accounts[0]).toMatchObject({ label: 'Account 0', windows: quota() });
  });
  it('pins observed identities on later cycles and forwards explicit initial pins', async () => {
    const value = config(); value.accounts[0]!.expectedAccountHint = HINT;
    start({ config: value }); await settle();
    expect(probes.codex.mock.calls[0]![0].expectedAccountHint).toBe(HINT);
    expect(probes.grok.mock.calls[0]![0].expectedAccountHint).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probes.codex.mock.calls[1]![0].expectedAccountHint).toBe(HINT);
    expect(probes.grok.mock.calls[1]![0].expectedAccountHint).toBe(GROK_HINT);
  });
  it('permanently stops on post-probe ownership uncertainty even if ownership could later recover', async () => {
    const ownership = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('private owner detail'); })
      .mockImplementation(() => {});
    const handle = start({ config: config(['codex']), assertOwnership: ownership }); await settle();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(probes.codex).toHaveBeenCalledTimes(1); expect(ownership).toHaveBeenCalledTimes(2);
    expect(handle.snapshot()).toMatchObject({ refreshing: false, accounts: [{ state: 'unavailable', authentication: 'unknown',
      health: 'unknown', windows: [], reason: 'connection-monitor-stopped' }] });
    expect(JSON.stringify(handle.snapshot())).not.toContain('private owner detail');
    await expect(handle.close()).rejects.toThrow('cleanup uncertain');
  });
  it('marks queued and previously successful accounts unavailable after uncertain cleanup', async () => {
    probes.codex.mockResolvedValue({ status: 'uncertain', reason: 'probe-termination-uncertain' });
    const handle = start(); await settle();
    expect(probes.grok).not.toHaveBeenCalled();
    expect(handle.snapshot().refreshing).toBe(false);
    for (const row of handle.snapshot().accounts) expect(row).toMatchObject({ state: 'unavailable', authentication: 'unknown',
      health: 'unknown', windows: [], reason: 'connection-monitor-stopped' });
    await vi.advanceTimersByTimeAsync(90_000); expect(probes.codex).toHaveBeenCalledTimes(1);
    await expect(handle.close()).rejects.toThrow('cleanup uncertain');
  });
  it.each(['reject', 'throw', 'missing', 'null', 'unknown', 'accessor'])('stops permanently after %s loses native settlement', async (kind) => {
    const getter = vi.fn(() => 'failed');
    probes.codex.mockImplementation(() => {
      if (kind === 'throw') throw new Error('private provider detail');
      if (kind === 'reject') return Promise.reject(new Error('private provider detail'));
      if (kind === 'null') return Promise.resolve(null);
      if (kind === 'unknown') return Promise.resolve({ status: 'unexpected' });
      if (kind === 'accessor') return Promise.resolve(Object.defineProperty({}, 'status', { get: getter }));
      return Promise.resolve({});
    });
    const handle = start({ config: config(['codex']) }); await settle();
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', reason: 'connection-monitor-stopped' });
    expect(JSON.stringify(handle.snapshot())).not.toContain('private provider detail');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(probes.codex).toHaveBeenCalledTimes(1); expect(getter).not.toHaveBeenCalled();
    await expect(handle.close()).rejects.toThrow('cleanup uncertain');
  });
  it.each(['failed', 'cancelled', 'timed-out'])('never upgrades %s results to signed-in', async (status) => {
    probes.grok.mockResolvedValue({ ...grok(), status, reason: 'probe-unavailable' });
    const handle = start({ config: config(['grok']) }); await settle();
    expect(handle.snapshot().accounts[0]).toMatchObject({ authentication: 'unknown', health: 'unavailable', windows: [], planType: null });
  });
  it('never invokes a provider if the external signal is already aborted', async () => {
    const controller = new AbortController(); controller.abort(); const handle = start({ signal: controller.signal }); await settle();
    expect(probes.codex).not.toHaveBeenCalled(); expect(probes.claude).not.toHaveBeenCalled(); expect(probes.grok).not.toHaveBeenCalled();
    expect(handle.snapshot().refreshing).toBe(false);
    for (const row of handle.snapshot().accounts) expect(row).toMatchObject({ state: 'unavailable', authentication: 'unknown',
      health: 'unknown', windows: [], reason: 'connection-monitor-stopped' });
    await expect(handle.close()).resolves.toBeUndefined();
  });
  it('retains uncertain cleanup when an in-flight probe rejects after cancellation', async () => {
    let reject!: (error: Error) => void;
    probes.codex.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const controller = new AbortController();
    const handle = start({ config: config(['codex']), signal: controller.signal }); await settle();
    controller.abort();
    reject(new Error('private cancelled child detail')); await settle();
    expect(probes.codex).toHaveBeenCalledTimes(1);
    await expect(handle.close()).rejects.toThrow('cleanup uncertain');
    expect(JSON.stringify(handle.snapshot())).not.toContain('private cancelled');
  });
  it('immediately withdraws health and quota when aborted between refresh cycles', async () => {
    const controller = new AbortController(); const handle = start({ signal: controller.signal }); await settle();
    expect(handle.snapshot().accounts[0]!.health).toBe('reachable'); controller.abort();
    for (const row of handle.snapshot().accounts) expect(row).toMatchObject({ state: 'unavailable', authentication: 'unknown',
      health: 'unknown', windows: [], reason: 'connection-monitor-stopped' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(probes.codex).toHaveBeenCalledTimes(1); expect(probes.claude).toHaveBeenCalledTimes(1); expect(probes.grok).toHaveBeenCalledTimes(1);
  });
  it('does not republish a late successful result after external abort', async () => {
    let finish!: () => void;
    probes.grok.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(grok()); }));
    const controller = new AbortController(); const handle = start({ config: config(['grok']), signal: controller.signal });
    await settle(); controller.abort();
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', health: 'unknown', windows: [] });
    finish(); await settle();
    expect(handle.snapshot()).toMatchObject({ refreshing: false, accounts: [{ state: 'unavailable', authentication: 'unknown',
      health: 'unknown', windows: [], reason: 'connection-monitor-stopped' }] });
  });
  it('bounds parallel clients to two and never overlaps cycles', async () => {
    const releases: Array<() => void> = [];
    probes.codex.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve(codex())); }));
    const handle = start({ config: config(['codex', 'codex', 'codex']) }); await settle();
    expect(probes.codex).toHaveBeenCalledTimes(2); expect(handle.snapshot().refreshing).toBe(true);
    await vi.advanceTimersByTimeAsync(90_000); expect(probes.codex).toHaveBeenCalledTimes(2);
    releases.splice(0).forEach((release) => release()); await settle(); expect(probes.codex).toHaveBeenCalledTimes(3);
    releases.splice(0).forEach((release) => release()); await settle(); expect(handle.snapshot().refreshing).toBe(false);
  });
  it('starts the next full pass relative to its start so a slow healthy Codex reading stays fresh', async () => {
    probes.codex.mockImplementation(() => {
      const observedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      return new Promise((resolve) => setTimeout(() => resolve({ ...codex(),
        observation: { observedAt, expiresAt, windows: quota() } }), 10_000));
    });
    probes.claude.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(claude()), 20_000)));
    probes.grok.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(grok()), 15_000)));
    const handle = start({ config: config(['codex', 'codex', 'claude', 'grok']) });
    await vi.advanceTimersByTimeAsync(30_000); // first 10s pair + 20s pair
    expect(probes.codex).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); // bounded 1s overrun pause
    expect(probes.codex).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'observed',
      observedAt: '2026-09-08T12:00:31.000Z', expiresAt: '2026-09-08T12:01:31.000Z' });
    await vi.advanceTimersByTimeAsync(1_000); // finish the second pass before close
  });

  it('wakes at the contact cadence after a shared permit delays the first account by 3s', async () => {
    const coordinator = createNativeMetadataCoordinator({ maxConcurrent: 1 });
    let release!: () => void;
    const blocked = coordinator.run(() => new Promise<void>(resolve => { release = resolve; }));
    await settle();
    const contacts: number[] = [];
    probes.codex.mockImplementation(async () => {
      contacts.push(Date.now() - Date.parse(NOW));
      if (contacts.length > 1) return { status: 'failed', reason: 'probe-timed-out' };
      return { ...codex(), observation: { observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), windows: quota() } };
    });
    const handle = start({ config: config(['codex']), coordinator });
    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(contacts).toEqual([]);
      release(); await blocked; await settle();
      expect(contacts).toEqual([3_000]);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(await handle.refreshAccount!('codex-0')).toMatchObject({ state: 'cached', reading: 'current',
        nextCheckAt: '2026-09-08T12:00:33.000Z', expiresAt: '2026-09-08T12:01:03.000Z' });
      expect(contacts).toEqual([3_000]);
      await vi.advanceTimersByTimeAsync(1);
      expect(contacts).toEqual([3_000, 33_000]);
      expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', authentication: 'unknown',
        reason: 'probe-timed-out', expiresAt: '2026-09-08T12:01:03.000Z', windows: quota() });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(contacts).toEqual([3_000, 33_000]);
      expect(handle.snapshot().accounts[0]!.windows).toEqual(quota());
      await vi.advanceTimersByTimeAsync(1);
      expect(contacts).toEqual([3_000, 33_000, 63_000]);
      expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', authentication: 'unknown',
        observedAt: null, expiresAt: null, windows: [] });
      await handle.close();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(contacts).toEqual([3_000, 33_000, 63_000]);
    } finally {
      release(); await blocked; await handle.close(); coordinator.dispose();
    }
  });

  it('keeps ordinary retry cadence when a profile is refused before any native contact', async () => {
    const handle = start({ config: config(['codex']), accountCurrent: () => false });
    await settle();
    expect(handle.readingRevision!()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(handle.readingRevision!()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.readingRevision!()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.readingRevision!()).toBe(3);
    expect(probes.codex).not.toHaveBeenCalled();
    expect(handle.snapshot().accounts[0]).toMatchObject({ reason: 'connection-account-changed', windows: [] });
  });

  it('keeps ordinary retry cadence after a previously contacted profile becomes noncurrent', async () => {
    let current = true;
    const handle = start({ config: config(['codex']), accountCurrent: () => current });
    await settle();
    expect(probes.codex).toHaveBeenCalledOnce();
    expect(handle.readingRevision!()).toBe(1);
    current = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.readingRevision!()).toBe(2);
    expect(handle.snapshot().accounts[0]).toMatchObject({ reason: 'connection-account-changed', windows: [] });
    expect(await handle.refreshAccount!('codex-0')).toMatchObject({ state: 'held', reading: 'unknown',
      nextCheckAt: '2026-09-08T12:00:30.000Z' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(handle.readingRevision!()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.readingRevision!()).toBe(3);
    expect(probes.codex).toHaveBeenCalledOnce();
  });

  it('keeps ordinary retry cadence when a joined manual check is refused at its queued contact', async () => {
    const coordinator = createNativeMetadataCoordinator({ maxConcurrent: 1 });
    let current = true;
    const handle = start({ config: config(['codex']), coordinator, accountCurrent: () => current });
    await settle();
    let release!: () => void;
    const blocked = coordinator.run(() => new Promise<void>(resolve => { release = resolve; }));
    await settle();
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      vi.setSystemTime(Date.parse(NOW) + 30_000);
      const manual = handle.refreshAccount!('codex-0'); await settle();
      await vi.advanceTimersByTimeAsync(1); // scheduled cycle joins the queued manual check
      current = false;
      release(); await blocked;
      expect(await manual).toMatchObject({ state: 'held', reading: 'unknown',
        nextCheckAt: '2026-09-08T12:00:30.000Z' });
      await settle();
      expect(handle.readingRevision!()).toBe(2);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(handle.readingRevision!()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(handle.readingRevision!()).toBe(3);
      expect(probes.codex).toHaveBeenCalledOnce();
    } finally {
      release(); await blocked; await handle.close(); coordinator.dispose();
    }
  });

  it('does not overlap an overrun under coordinator contention and reports expiry until recovery', async () => {
    const coordinator = createNativeMetadataCoordinator({ maxConcurrent: 1 });
    let active = 0; let peak = 0;
    const delayed = <T>(make: () => T, delay: number): Promise<T> => {
      active++; peak = Math.max(peak, active);
      return new Promise((resolve) => setTimeout(() => { active--; resolve(make()); }, delay));
    };
    probes.codex.mockImplementation(() => {
      const observedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      return delayed(() => ({ ...codex(), observation: { observedAt, expiresAt, windows: quota() } }), 10_000);
    });
    probes.claude.mockImplementation(() => delayed(claude, 20_000));
    probes.grok.mockImplementation(() => delayed(grok, 15_000));
    const handle = start({ config: config(['codex', 'codex', 'claude', 'grok']), coordinator });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probes.codex).toHaveBeenCalledTimes(2); // still in the first pass
    expect(peak).toBe(1);
    await vi.advanceTimersByTimeAsync(25_000); // first pass ends at 55s
    expect(probes.codex).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); // 1s pause, then second pass
    expect(probes.codex).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000); // original first reading expires at 60s
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', windows: [],
      reason: 'connection-reading-expired' });
    await vi.advanceTimersByTimeAsync(6_000); // new first reading settles at 66s
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'observed',
      observedAt: '2026-09-08T12:00:56.000Z' });
    expect(peak).toBe(1);
    await vi.advanceTimersByTimeAsync(45_000); // finish second pass before close
    coordinator.dispose();
  });
  it('close aborts in-flight work, awaits cleanup and prevents future probes', async () => {
    let cancelled = false;
    probes.grok.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { cancelled = true; resolve({ status: 'cancelled', reason: 'probe-cancelled' }); }, { once: true });
    }));
    const handle = start({ config: config(['grok']) }); await settle(); await handle.close();
    expect(cancelled).toBe(true); await vi.advanceTimersByTimeAsync(90_000); expect(probes.grok).toHaveBeenCalledTimes(1);
  });
});


describe('current Codex credits publication', () => {
  it('publishes each native account balance independently and clears it on failure, expiry and stop', async () => {
    const credits = { hasCredits: true, unlimited: false, balance: '123.456789', spendControlReached: false };
    probes.codex.mockResolvedValueOnce({ ...codex(), credits });
    const handle = start({ config: config(['codex']) }); await settle();
    expect(handle.snapshot().accounts[0]?.codexCredits).toEqual(credits);
    probes.codex.mockResolvedValue({ status: 'failed', reason: 'probe-provider-error' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]).toMatchObject({ state: 'unavailable', codexCredits: null, windows: quota() });
    expect(expireConnectionRow({ ...handle.snapshot().accounts[0]!, codexCredits: credits }, Date.parse(EXPIRES))).toMatchObject({ codexCredits: null, windows: [] });
    await handle.close(); expect(handle.snapshot().accounts[0]?.codexCredits).toBeNull();
  });
  it('does not reuse positive credits when the next successful native response omits them', async () => {
    probes.codex.mockResolvedValueOnce({ ...codex(), credits: { hasCredits: true, unlimited: false, balance: '12' } });
    const handle = start({ config: config(['codex']) }); await settle();
    expect(handle.snapshot().accounts[0]?.codexCredits?.balance).toBe('12');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.snapshot().accounts[0]?.codexCredits).toBeNull();
  });
});


describe('pure account publication revision', () => {
  it('publishes independent successful and unavailable account settlements without snapshot reads', async () => {
    let first!: (value: ReturnType<typeof codex>) => void;
    let second!: (value: { status: string; reason: string }) => void;
    probes.codex.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    const handle = start({ config: config(['codex', 'codex']) });
    await settle();
    expect(handle.readingRevision?.()).toBe(0);
    first(codex()); await settle();
    expect(handle.readingRevision?.()).toBe(1);
    second({ status: 'failed', reason: 'probe-native-unavailable' }); await settle();
    expect(handle.readingRevision?.()).toBe(2);
    for (let i = 0; i < 20; i++) expect(handle.readingRevision?.()).toBe(2);
    expect(probes.codex).toHaveBeenCalledTimes(2);
    expect(handle.snapshot().accounts.map(row => row.state)).toEqual(['observed', 'unavailable']);
  });
});

describe('selected account reading refresh', () => {
  it('joins one scheduled target while an unrelated provider remains pending, and publishes it immediately', async () => {
    let release!: (value: ReturnType<typeof codex>) => void;
    let slow!: (value: ReturnType<typeof claude>) => void;
    probes.claude.mockImplementation(() => new Promise(resolve => { slow = resolve; }));
    probes.codex.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const handle = start({ config: config(['claude', 'codex']) });
    await settle();
    const a = handle.refreshAccount!('codex-1'); const b = handle.refreshAccount!('codex-1');
    release(codex());
    const result = await a; await b;
    expect(result).toMatchObject({ state: 'completed', reading: 'current', joined: true, observedAt: NOW });
    expect(handle.readingRevision!()).toBe(1);
    expect(handle.snapshot().refreshing).toBe(true);
    expect(probes.codex).toHaveBeenCalledTimes(1);
    slow(claude()); await settle();
  });

  it('uses the existing cadence after success or failure, never turning repeated clicks into extra probes', async () => {
    const handle = start({ config: config(['codex']) }); await settle();
    expect(await handle.refreshAccount!('codex-0')).toMatchObject({ state: 'cached', reading: 'current', nextCheckAt: '2026-09-08T12:00:30.000Z' });
    expect(probes.codex).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse(NOW) + 30_000);
    probes.codex.mockResolvedValue({ status: 'failed', reason: 'probe-timed-out' });
    expect(await handle.refreshAccount!('codex-0')).toMatchObject({ state: 'completed', reading: 'unknown' });
    expect(await handle.refreshAccount!('codex-0')).toMatchObject({ state: 'cached', reading: 'unknown' });
    expect(probes.codex).toHaveBeenCalledTimes(2);
  });

  it('keeps the two-client bound for manual checks without an externally supplied coordinator', async () => {
    const releases: Array<() => void> = []; let active = 0; let peak = 0;
    probes.codex.mockImplementation(() => { active++; peak = Math.max(peak, active); return new Promise(resolve => {
      releases.push(() => { active--; resolve(codex()); });
    }); });
    const handle = start({ config: config(['codex', 'codex', 'codex']) }); await settle();
    const third = handle.refreshAccount!('codex-2');
    await settle(); expect(probes.codex).toHaveBeenCalledTimes(2);
    releases.shift()!(); await settle(); expect(probes.codex).toHaveBeenCalledTimes(3);
    while (releases.length) releases.shift()!();
    await third; await settle(); expect(peak).toBe(2);
  });

  it('rechecks a queued target profile before native contact and refuses publication after a profile change', async () => {
    let valid = true; const releases: Array<() => void> = [];
    probes.codex.mockImplementation(() => new Promise(resolve => { releases.push(() => resolve(codex())); }));
    const handle = start({ config: config(['codex', 'codex', 'codex']),
      accountCurrent: account => account.id !== 'codex-2' || valid });
    await settle();
    const target = handle.refreshAccount!('codex-2'); await settle(); valid = false;
    releases.shift()!(); await settle();
    expect(await target).toMatchObject({ state: 'held', reading: 'unknown', reason: 'connection-account-changed' });
    expect(probes.codex).toHaveBeenCalledTimes(2);
    releases.shift()!(); await settle();
    expect(handle.snapshot().accounts[2]).toMatchObject({ observedAt: null, windows: [], reason: 'connection-account-changed' });
  });

  it('does not mask uncertain cleanup when the account changes while its native process is settling', async () => {
    let valid = true; let release!: (value: unknown) => void;
    probes.codex.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const settled = vi.fn();
    const coordinator = createNativeMetadataCoordinator({ beginNativeActivity: () => ({ settle: settled }) });
    const handle = start({ config: config(['codex']), accountCurrent: () => valid, coordinator }); await settle();
    const target = handle.refreshAccount!('codex-0'); valid = false;
    release({ status: 'uncertain', reason: 'probe-termination-uncertain' });
    expect(await target).toMatchObject({ state: 'held', reading: 'unknown' });
    await expect(handle.close()).rejects.toThrow('cleanup uncertain');
    expect(settled).not.toHaveBeenCalled(); expect(coordinator.signal.aborted).toBe(true); coordinator.dispose();
    expect(probes.codex).toHaveBeenCalledTimes(1);
  });

  it('close waits for manual work outside the regular cycle and never confirms stopped work', async () => {
    const handle = start({ config: config(['codex']) }); await settle();
    vi.setSystemTime(Date.parse(NOW) + 30_000);
    let release!: (value: ReturnType<typeof codex>) => void;
    probes.codex.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const target = handle.refreshAccount!('codex-0'); await settle();
    let closed = false; const close = handle.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    release(codex()); await close;
    expect(await target).toMatchObject({ state: 'held', reading: 'unknown', reason: 'connection-monitor-stopped' });
    expect(handle.readingRevision!()).toBe(1);
  });

  it('refuses a throwing host guard without contacting native metadata', async () => {
    const handle = start({ config: config(['codex']), accountCurrent: () => { throw new Error('private profile'); } }); await settle();
    expect(await handle.refreshAccount!('codex-0')).toMatchObject({ state: 'held', reading: 'unknown' });
    expect(probes.codex).not.toHaveBeenCalled();
    expect(JSON.stringify(handle.snapshot())).not.toContain('private profile');
  });

  it.each([false, undefined, null])('refuses a malformed/false host account guard (%s) before contact', async value => {
    const handle = start({ config: config(['codex']), accountCurrent: () => value as boolean }); await settle();
    expect(await handle.refreshAccount!('codex-0')).toMatchObject({ state: 'held', reading: 'unknown' });
    expect(probes.codex).not.toHaveBeenCalled();
    expect(await handle.refreshAccount!('unknown')).toMatchObject({ state: 'held', reason: 'connection-account-not-configured' });
  });
});
