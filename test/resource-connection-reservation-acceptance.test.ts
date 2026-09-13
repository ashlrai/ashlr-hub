/** Parent-owned inert acceptance checks; worker must not modify this file. */
import { mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceConnectionMonitor } from '../src/core/resources/connection-monitor.js';
import { createNativeMetadataCoordinator } from '../src/core/resources/metadata-coordinator.js';
import { validResourceConnectionFailure } from '../src/core/resources/connection-types.js';
const probe = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/codex-account-probe.js', () => ({ probeCodexResourceAccount: probe }));
const NOW = '2026-09-13T10:00:00.000Z';
let cwd: string;
const handles: Array<ReturnType<typeof createResourceConnectionMonitor>> = [];
const coordinators: Array<ReturnType<typeof createNativeMetadataCoordinator>> = [];
beforeEach(() => { cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-parent-reservation-'))); vi.useFakeTimers(); vi.setSystemTime(NOW); probe.mockReset(); });
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close().catch(() => {});
  for (const coordinator of coordinators.splice(0)) coordinator.dispose(); vi.useRealTimers(); rmdirSync(cwd); });
const start = (coordinator: ReturnType<typeof createNativeMetadataCoordinator>) => {
  const handle = createResourceConnectionMonitor({ cwd, assertOwnership() {}, coordinator,
    config: { schemaVersion: 1, intervalMs: 30000, accounts: [{ id: 'codex-a', label: 'Fixture', provider: 'codex', command: ['/inert/codex'] }] } });
  handles.push(handle); return handle;
};
describe('native reservation diagnostic acceptance', () => {
  it('retains a failed reservation before any native invocation without exposing the error', async () => {
    const access = vi.fn(() => 'PRIVATE_ERROR'); const error = Object.create(null);
    Object.defineProperty(error, 'message', { get: access });
    const coordinator = createNativeMetadataCoordinator({ beginNativeActivity() { throw error; } }); coordinators.push(coordinator);
    const handle = start(coordinator); await vi.advanceTimersByTimeAsync(0);
    const snapshot = handle.snapshot();
    expect(probe).not.toHaveBeenCalled(); expect(access).not.toHaveBeenCalled();
    expect(snapshot.firstFailure).toMatchObject({ accountId: 'codex-a', observedAt: NOW, reasonCode: 'activity-reservation-failed' });
    expect(validResourceConnectionFailure(snapshot.firstFailure)).toBe(true);
    expect(snapshot.firstFailure?.cleanupDiagnostics).toBeUndefined();
    expect(snapshot.accounts[0]?.authentication).toBe('unknown');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    await expect(handle.close()).rejects.toThrow();
  });
  it('does not label an already cancelled coordinator as a reservation failure', async () => {
    const begin = vi.fn(() => ({ settle() {} }));
    const coordinator = createNativeMetadataCoordinator({ beginNativeActivity: begin }); coordinators.push(coordinator); coordinator.abort();
    const handle = start(coordinator); await vi.advanceTimersByTimeAsync(0);
    expect(begin).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled(); expect(handle.snapshot().firstFailure).toBeUndefined();
  });
  it('does not blame a queued monitor when another operation is cancelled', async () => {
    const coordinator = createNativeMetadataCoordinator({ maxConcurrent: 1, beginNativeActivity: () => ({ settle() {} }) }); coordinators.push(coordinator);
    let release!: (value: number) => void;
    const first = coordinator.run(() => new Promise<number>(resolve => { release = resolve; }), () => true);
    await vi.advanceTimersByTimeAsync(0);
    const handle = start(coordinator); await vi.advanceTimersByTimeAsync(0);
    coordinator.abort(); release(1); await first; await vi.advanceTimersByTimeAsync(0);
    expect(probe).not.toHaveBeenCalled(); expect(handle.snapshot().firstFailure).toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
