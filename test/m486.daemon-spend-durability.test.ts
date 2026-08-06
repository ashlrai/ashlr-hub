import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PathLike } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const durability = vi.hoisted(() => ({
  events: [] as string[],
  fdPaths: new Map<number, string>(),
  failDirectorySync: false,
  failGuardFileSync: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(named: PathLike, ...args: unknown[]): number {
      const fd = (actual.openSync as (...params: unknown[]) => number)(named, ...args);
      durability.fdPaths.set(fd, String(named));
      return fd;
    },
    closeSync(fd: number): void {
      actual.closeSync(fd);
      durability.fdPaths.delete(fd);
    },
    writeSync(fd: number, ...args: unknown[]): number {
      const named = durability.fdPaths.get(fd) ?? '';
      if (named.includes('daemon.spend-guard.json')) durability.events.push('write-guard-file');
      else if (named.includes('daemon.json.')) durability.events.push('write-state-temp');
      return (actual.writeSync as (...params: unknown[]) => number)(fd, ...args);
    },
    fsyncSync(fd: number): void {
      const named = durability.fdPaths.get(fd) ?? '';
      if (named.includes('daemon.spend-guard.json')) {
        durability.events.push('fsync-guard-file');
        if (durability.failGuardFileSync) throw Object.assign(new Error('injected guard file fsync failure'), { code: 'EIO' });
      }
      else if (named.includes('daemon.json.')) durability.events.push('fsync-state-temp');
      actual.fsyncSync(fd);
    },
    renameSync(from: PathLike, to: PathLike): void {
      if (String(to).endsWith('daemon.json')) durability.events.push('rename-state');
      actual.renameSync(from, to);
    },
    unlinkSync(named: PathLike): void {
      if (String(named).endsWith('daemon.spend-guard.json')) durability.events.push('unlink-guard');
      actual.unlinkSync(named);
    },
  };
});

vi.mock('../src/core/util/durability.js', () => ({
  fsyncDirectory(named: string): void {
    durability.events.push(`fsync-directory:${path.basename(named)}`);
    if (durability.failDirectorySync) throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
  },
}));

import {
  armDaemonSpendGuard,
  clearDaemonSpendGuard,
  daemonSpendGuardPath,
  loadDaemonState,
  readDaemonSpendGuard,
  saveDaemonStateResult,
  upgradeLegacyDaemonSpendGuard,
} from '../src/core/daemon/state.js';

const originalHome = process.env.HOME;
let home: string;

function state(spend = 0) {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: '2026-08-05',
    todaySpentUsd: spend,
    itemsProcessed: 0,
    ticks: [],
  };
}

function arm() {
  return armDaemonSpendGuard({
    itemIds: ['durability-item'], daemonStartedAt: null,
    budgetDay: '2026-08-05', dailyBudgetUsd: 1,
    spentUsdAtArm: 0, reservedUsd: 1,
    now: new Date('2026-08-05T12:00:00.000Z'),
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m486-durability-'));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, '.ashlr'), { mode: 0o700 });
  durability.events.length = 0;
  durability.fdPaths.clear();
  durability.failDirectorySync = false;
  durability.failGuardFileSync = false;
});

afterEach(() => {
  durability.failDirectorySync = false;
  durability.failGuardFileSync = false;
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe('daemon accounting power-loss barriers', () => {
  it('orders state temp write and file fsync before rename and parent fsync', () => {
    expect(saveDaemonStateResult(state()).ok).toBe(true);
    expect(durability.events).toEqual([
      'write-state-temp',
      'fsync-state-temp',
      'rename-state',
      'fsync-directory:.ashlr',
    ]);
  });

  it('orders exclusive guard write and file fsync before parent fsync', () => {
    expect(arm().ok).toBe(true);
    expect(durability.events).toEqual([
      'write-guard-file',
      'fsync-guard-file',
      'fsync-directory:.ashlr',
    ]);
  });

  it('orders exact guard unlink before the parent-directory deletion barrier', () => {
    const armed = arm();
    expect(armed.ok).toBe(true);
    if (!armed.ok) return;
    durability.events.length = 0;
    expect(clearDaemonSpendGuard(armed.guard.token)).toMatchObject({ ok: true, cleared: true });
    expect(durability.events).toEqual(['unlink-guard', 'fsync-directory:.ashlr']);
  });

  it('reports an indeterminate post-rename state barrier while preserving the visible replacement', () => {
    expect(saveDaemonStateResult(state(0.1)).ok).toBe(true);
    durability.events.length = 0;
    durability.failDirectorySync = true;

    expect(saveDaemonStateResult(state(0.7))).toMatchObject({ ok: false });
    expect(loadDaemonState().todaySpentUsd).toBe(0.7);
    expect(durability.events).toEqual([
      'write-state-temp', 'fsync-state-temp', 'rename-state', 'fsync-directory:.ashlr',
    ]);
  });

  it('does not report arm success when the guard directory barrier fails', () => {
    durability.failDirectorySync = true;
    expect(arm()).toMatchObject({ ok: false });
    expect(fs.existsSync(daemonSpendGuardPath())).toBe(true);
  });

  it('does not report deletion success when the guard directory barrier fails', () => {
    const armed = arm();
    expect(armed.ok).toBe(true);
    if (!armed.ok) return;
    durability.failDirectorySync = true;
    expect(clearDaemonSpendGuard(armed.guard.token)).toMatchObject({ ok: false });
    expect(fs.existsSync(daemonSpendGuardPath())).toBe(false);
  });

  it('leaves exact legacy bytes when promotion fails before the file barrier', () => {
    const legacy = {
      token: 'legacy-token', pid: 999_999, hostname: os.hostname(),
      armedAt: '2026-08-05T12:00:00.000Z', itemIds: ['legacy-item'],
    };
    const bytes = `${JSON.stringify(legacy, null, 2)}\n`;
    fs.writeFileSync(daemonSpendGuardPath(), bytes, 'utf8');
    durability.failGuardFileSync = true;

    expect(upgradeLegacyDaemonSpendGuard(legacy, {
      daemonStartedAt: '2026-08-05T11:00:00.000Z', budgetDay: '2026-08-05',
      dailyBudgetUsd: 1, spentUsdAtArm: 0.2, reservedUsd: 0.8,
    })).toMatchObject({ ok: false });
    expect(fs.readFileSync(daemonSpendGuardPath(), 'utf8')).toBe(bytes);
  });

  it('leaves a complete recoverable v2 guard when promotion reaches rename but its directory barrier fails', () => {
    const legacy = {
      token: 'legacy-token', pid: 999_999, hostname: os.hostname(),
      armedAt: '2026-08-05T12:00:00.000Z', itemIds: ['legacy-item'],
    };
    fs.writeFileSync(daemonSpendGuardPath(), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
    durability.failDirectorySync = true;

    expect(upgradeLegacyDaemonSpendGuard(legacy, {
      daemonStartedAt: '2026-08-05T11:00:00.000Z', budgetDay: '2026-08-05',
      dailyBudgetUsd: 1, spentUsdAtArm: 0.2, reservedUsd: 0.8,
    })).toMatchObject({ ok: false });
    expect(readDaemonSpendGuard()).toMatchObject({
      exists: true,
      malformed: false,
      guard: { schemaVersion: 2, exhaustBudgetDay: true },
    });
  });
});
