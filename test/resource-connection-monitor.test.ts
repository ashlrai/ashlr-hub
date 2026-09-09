/** Inert provider mocks only: no native executable, authentication, or network calls. */
import { mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceConnectionMonitor, validateResourceConnectionConfig,
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
  it('projects provider-specific evidence without inventing Claude quota or Grok task support', async () => {
    const handle = start(); await settle(); const snapshot = handle.snapshot();
    expect(snapshot.refreshing).toBe(false);
    expect(snapshot.accounts[0]).toMatchObject({ authentication: 'signed-in', health: 'reachable', windows: quota(), executionSupported: true });
    expect(snapshot.accounts[1]).toMatchObject({ authentication: 'signed-in', health: 'unknown', windows: [], planType: 'max' });
    expect(snapshot.accounts[2]).toMatchObject({ authentication: 'signed-in', health: 'reachable', executionSupported: false,
      planType: 'SuperGrok Heavy', onDemandEnabled: false });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(HINT); expect(serialized).not.toContain(GROK_HINT); expect(serialized).not.toContain('/private/inert-fixture');
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
  it('close aborts in-flight work, awaits cleanup and prevents future probes', async () => {
    let cancelled = false;
    probes.grok.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { cancelled = true; resolve({ status: 'cancelled', reason: 'probe-cancelled' }); }, { once: true });
    }));
    const handle = start({ config: config(['grok']) }); await settle(); await handle.close();
    expect(cancelled).toBe(true); await vi.advanceTimersByTimeAsync(90_000); expect(probes.grok).toHaveBeenCalledTimes(1);
  });
});
