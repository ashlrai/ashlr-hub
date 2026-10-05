import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalWorkObserver, verifiedLocalRuns, hostDispatchEngine, type LocalWorkObservation } from '../src/core/daemon/local-work-observation.js';
import type { DaemonActivityReadResult } from '../src/core/daemon/activity.js';
import type { DaemonLivenessV1 } from '../src/core/daemon/liveness.js';
const now = Date.parse('2026-10-05T10:00:00.000Z');
const owner = { pid: 1234, instanceId: '783bdc12-8eb4-4d32-9035-a37f492ec171', processStartRef: 'a'.repeat(64), daemonStartedAt: '2026-10-05T09:00:00.000Z' };
const row: LocalWorkObservation = { ...owner, schemaVersion: 1, authority: 'none', observedAt: new Date(now).toISOString(), localRuns: 2 };
const activity: DaemonActivityReadResult = { sourceState: 'healthy', freshness: 'fresh', ownerState: 'alive', activity: { ...owner, schemaVersion: 1, authority: 'none', observedAt: row.observedAt, phase: 'tick', activeChildren: null }, phaseStartedAt: row.observedAt, ageMs: 0 };
const live: DaemonLivenessV1 = { v: 1, checkedAt: row.observedAt, state: 'alive', alive: true, pid: owner.pid, recorded: { running: true, pid: owner.pid, startedAt: owner.daemonStartedAt, lastTickAt: row.observedAt }, lock: null, activity: null, staleRecord: false, reason: 'verified' };
afterEach(() => vi.useRealTimers());
describe('resident local work observation', () => {
  it('one completion preserves overlapping actual host work and last completion clears it', () => {
    const values: LocalWorkObservation[] = []; const observer = new LocalWorkObserver(owner, value => values.push(value), () => now);
    observer.begin('one', 'codex'); observer.begin('one', 'codex'); observer.begin('two', 'claude');
    expect(values.at(-1)?.localRuns).toBe(2); observer.end('one'); expect(values.at(-1)?.localRuns).toBe(1);
    observer.end('two'); expect(values.at(-1)?.localRuns).toBe(0); observer.close();
  });
  it('renews verified idle without awake work and stops all heartbeat on owner exit', () => {
    vi.useFakeTimers(); const publish = vi.fn(); const observer = new LocalWorkObserver(owner, publish);
    vi.advanceTimersByTime(30_000); expect(publish).toHaveBeenCalledTimes(7); expect(publish.mock.lastCall?.[0].localRuns).toBe(0); publish.mockClear();
    observer.begin('one', 'llama-server'); vi.advanceTimersByTime(30_000); expect(publish).toHaveBeenCalledTimes(7);
    observer.end('one'); vi.advanceTimersByTime(30_000); expect(publish).toHaveBeenCalledTimes(14); expect(publish.mock.lastCall?.[0].localRuns).toBe(0); observer.close(); publish.mockClear(); vi.advanceTimersByTime(30_000); expect(publish).not.toHaveBeenCalled();
  });
  it('excludes provider-only work and surfaces unknown engine coverage', () => {
    const publish = vi.fn(); const observer = new LocalWorkObserver(owner, publish);
    publish.mockClear(); observer.begin('cloud', 'devin-cloud'); expect(publish).not.toHaveBeenCalled();
    observer.begin('unknown', 'future-provider'); expect(publish.mock.lastCall?.[0].localRuns).toBeNull();
    observer.begin('known', 'codex'); expect(publish.mock.lastCall?.[0].localRuns).toBe(1);
    observer.end('known'); expect(publish.mock.lastCall?.[0].localRuns).toBeNull();
    expect(hostDispatchEngine('devin-cli')).toBe(true); observer.close();
  });
  it('failure/cancellation finally removes work and owner exit clears every request', async () => {
    const publish = vi.fn(); const observer = new LocalWorkObserver(owner, publish);
    observer.begin('one', 'grok-cli');
    await expect((async () => { try { throw new Error('cancelled'); } finally { observer.end('one'); } })()).rejects.toThrow('cancelled');
    expect(publish.mock.lastCall?.[0].localRuns).toBe(0); observer.begin('two', 'codex'); observer.close();
    expect(publish.mock.lastCall?.[0].localRuns).toBe(0); observer.begin('retired', 'codex'); expect(publish.mock.lastCall?.[0].localRuns).toBe(0);
  });
  it('unexpected owner failure reports unknown and cannot later overwrite it as idle', () => {
    const publish = vi.fn(); const observer = new LocalWorkObserver(owner, publish);
    observer.begin('running', 'codex'); observer.close(true);
    expect(publish.mock.lastCall?.[0].localRuns).toBeNull();
    observer.close(); expect(publish.mock.lastCall?.[0].localRuns).toBeNull();
  });
  it('accepts only current, verified same-owner observations', () => { expect(verifiedLocalRuns(row, activity, live, now)).toBe(2); });
  it('same PID with different process start or instance remains unknown', () => {
    expect(verifiedLocalRuns({ ...row, processStartRef: 'b'.repeat(64) }, activity, live, now)).toBeNull();
    expect(verifiedLocalRuns({ ...row, instanceId: 'different' }, activity, live, now)).toBeNull();
    expect(verifiedLocalRuns({ ...row, daemonStartedAt: '2026-10-05T08:00:00.000Z' }, activity, live, now)).toBeNull();
  });
  it('stale, future, dead/reused/unverified owners and malformed counts are unknown, never inactive', () => {
    expect(verifiedLocalRuns(row, activity, live, now + 15_000)).toBeNull();
    expect(verifiedLocalRuns(row, activity, live, now - 1)).toBeNull();
    expect(verifiedLocalRuns(row, { ...activity, ownerState: 'reused' }, live, now)).toBeNull();
    expect(verifiedLocalRuns(row, activity, { ...live, alive: false, pid: null }, now)).toBeNull();
    expect(verifiedLocalRuns({ ...row, localRuns: -1 }, activity, live, now)).toBeNull();
    expect(verifiedLocalRuns(row, { ...activity, freshness: 'stale' }, live, now)).toBeNull();
  });
  it('verified last completion reports zero rather than retaining historic active work', () => { expect(verifiedLocalRuns({ ...row, localRuns: 0 }, activity, live, now)).toBe(0); });
});
