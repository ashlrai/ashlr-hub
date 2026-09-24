/**
 * V3.10 Track B (U5): `probeDaemonLiveness()` fixes the stale pid-850 reading
 * (SPEC-310B §3 "24/7"). daemon.json said `running: true, pid: 850` for three
 * weeks after that process died; a recorded pid is a claim, the lock
 * heartbeat + process identity are the proof. HOME is isolated per worker
 * (test/setup/home.ts); every file below is written under that tmp HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { clearStaleDaemonRecord, probeDaemonLiveness, resetDaemonLivenessCache } from '../src/core/daemon/liveness.js';
import { daemonLockPath, loadDaemonStateStrict, saveDaemonState } from '../src/core/daemon/state.js';
import type { DaemonState } from '../src/core/types.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
/** Out of every platform's pid range: kill(pid, 0) is ESRCH for real. */
const DEAD_PID = 9_999_999;

function writeState(over: Partial<DaemonState>): void {
  saveDaemonState({
    running: false,
    pid: null,
    startedAt: '2026-08-21T01:36:00.000Z',
    lastTickAt: '2026-09-01T19:10:00.000Z',
    todayDate: '2026-09-01',
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
    ...over,
  } as DaemonState);
}

function writeLock(pid: number, heartbeatAt: string): void {
  const path = daemonLockPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ pid, token: 't'.repeat(32), hostname: 'test', acquiredAt: heartbeatAt, heartbeatAt }), { mode: 0o600 });
}

beforeEach(() => {
  resetDaemonLivenessCache();
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

afterEach(() => {
  resetDaemonLivenessCache();
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('probeDaemonLiveness', () => {
  it('pid 850: the lock and the record name a dead pid → stale, NOT running', () => {
    writeState({ running: true, pid: 850 });
    writeLock(850, '2026-09-01T19:10:00.000Z');
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'dead' });
    expect(verdict.state).toBe('stale');
    expect(verdict.alive).toBe(false);
    expect(verdict.pid).toBeNull();
    expect(verdict.staleRecord).toBe(true);
    expect(verdict.reason).toMatch(/pid 850, which no longer exists/);
    expect(verdict.reason).toMatch(/NOT running/);
    expect(verdict.recorded).toMatchObject({ running: true, pid: 850 });
  });

  it('pid 850 reused by a root process after a reboot (EPERM, no lock) → stale', () => {
    writeState({ running: true, pid: 850 });
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'foreign' });
    expect(verdict.state).toBe('stale');
    expect(verdict.alive).toBe(false);
    expect(verdict.reason).toMatch(/no daemon holds the lock, so pid 850 is not the daemon/);
  });

  it('a lock whose pid now belongs to another user → stale', () => {
    writeState({ running: true, pid: 850 });
    writeLock(850, new Date(NOW - 10_000).toISOString());
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'foreign' });
    expect(verdict.state).toBe('stale');
    expect(verdict.reason).toMatch(/another user's process/);
  });

  it('a live lock owner with a fresh heartbeat → alive', () => {
    writeState({ running: true, pid: process.pid });
    writeLock(process.pid, new Date(NOW - 20_000).toISOString());
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'alive' });
    expect(verdict.state).toBe('alive');
    expect(verdict.alive).toBe(true);
    expect(verdict.pid).toBe(process.pid);
  });

  it('a live pid with a stale heartbeat and no identity proof → unknown, never running', () => {
    writeState({ running: true, pid: process.pid });
    writeLock(process.pid, new Date(NOW - 30 * 60_000).toISOString());
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'alive' });
    expect(verdict.state).toBe('unknown');
    expect(verdict.alive).toBeNull();
  });

  it('nothing claims to run and nothing does → stopped', () => {
    writeState({ running: false, pid: null });
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'dead' });
    expect(verdict.state).toBe('stopped');
    expect(verdict.alive).toBe(false);
    expect(verdict.staleRecord).toBe(false);
  });

  it('uses a record the caller already read instead of re-reading the state file', () => {
    const verdict = probeDaemonLiveness({
      nowMs: NOW,
      pidProbe: () => 'dead',
      recorded: { running: true, pid: 850, startedAt: null, lastTickAt: null },
    });
    expect(verdict.state).toBe('stale');
    expect(verdict.recorded.pid).toBe(850);
  });
});

describe('clearStaleDaemonRecord (`ashlr daemon doctor --clear-stale`)', () => {
  it('rewrites a provably stale running record, taking the singleton lock to do it', () => {
    writeState({ running: true, pid: DEAD_PID });
    writeLock(DEAD_PID, '2026-09-01T19:10:00.000Z');
    const result = clearStaleDaemonRecord({ pidProbe: () => 'dead' });
    expect(result).toMatchObject({ ok: true, changed: true });
    const loaded = loadDaemonStateStrict({ preserveOwnerIdentity: true });
    expect(loaded.ok && loaded.state.running).toBe(false);
    expect(loaded.ok && loaded.state.pid).toBeNull();
    // Lifetime counters are untouched.
    expect(loaded.ok && loaded.state.lastTickAt).toBe('2026-09-01T19:10:00.000Z');
  });

  it('refuses to touch a daemon it cannot prove is gone', () => {
    writeState({ running: true, pid: process.pid });
    writeLock(process.pid, new Date().toISOString());
    const result = clearStaleDaemonRecord({ pidProbe: () => 'alive' });
    expect(result).toMatchObject({ ok: false, changed: false });
    expect(result.reason).toMatch(/Refusing to clear/);
    const loaded = loadDaemonStateStrict({ preserveOwnerIdentity: true });
    expect(loaded.ok && loaded.state.running).toBe(true);
  });

  it('says there is nothing to clear when the daemon is simply stopped', () => {
    writeState({ running: false, pid: null });
    expect(clearStaleDaemonRecord({ pidProbe: () => 'dead' })).toMatchObject({ ok: true, changed: false });
  });
});
