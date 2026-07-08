/**
 * Guard-health/state-repair UX slice.
 *
 * The diagnosis helper is read-only: tests seed broken guard files directly,
 * then assert status surfaces report ids, details, paths, and repair commands.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import { cmdDaemon } from '../src/cli/daemon.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import { diagnoseGuardHealth } from '../src/core/daemon/guard-health.js';
import {
  armDaemonSpendGuard,
  daemonLockPath,
  daemonSpendGuardPath,
  daemonStatePath,
  loadDaemonState,
  saveDaemonState,
} from '../src/core/daemon/state.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import { setKill } from '../src/core/sandbox/policy.js';

const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
let tmpHome: string;

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = '';
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += args.map((arg) => String(arg)).join(' ') + '\n';
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const code = await fn();
    return { code, out };
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    consoleErrSpy.mockRestore();
  }
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `ashlr-m302-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  try {
    setKill(false);
  } catch {
    // best-effort
  }
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('diagnoseGuardHealth', () => {
  it('reports malformed daemon state, armed spend guard, kill switch, and evidence path blocks', () => {
    const statePath = daemonStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, 'not-json {{{', 'utf8');

    const guard = armDaemonSpendGuard(['item-a', 'item-b']);
    expect(guard.ok).toBe(true);

    setKill(true);

    const evidencePath = join(tmpHome, '.ashlr', 'evidence');
    writeFileSync(evidencePath, 'not a directory', 'utf8');

    const diagnosis = diagnoseGuardHealth();
    expect(diagnosis.blocked).toBe(true);
    expect(diagnosis.blocks.map((b) => b.id)).toEqual([
      'daemon-state-malformed',
      'daemon-spend-guard-armed',
      'kill-switch',
      'autonomy-evidence-unwritable',
    ]);
    for (const block of diagnosis.blocks) {
      expect(block.detail.length).toBeGreaterThan(0);
      expect(block.path.length).toBeGreaterThan(0);
      expect(block.repairCommands.length).toBeGreaterThan(0);
    }
    expect(diagnosis.blocks.find((b) => b.id === 'daemon-state-malformed')?.path).toBe(statePath);
    expect(diagnosis.blocks.find((b) => b.id === 'daemon-spend-guard-armed')?.path).toBe(guard.ok ? guard.path : '');
  });

  it('reports a malformed spend guard separately from an armed guard', () => {
    const spendGuardPath = daemonSpendGuardPath();
    mkdirSync(dirname(spendGuardPath), { recursive: true });
    writeFileSync(spendGuardPath, '{"token":42}', 'utf8');

    const diagnosis = diagnoseGuardHealth();
    expect(diagnosis.blocked).toBe(true);
    expect(diagnosis.blocks.map((b) => b.id)).toContain('daemon-spend-guard-malformed');
    const block = diagnosis.blocks.find((b) => b.id === 'daemon-spend-guard-malformed');
    expect(block?.path).toBe(spendGuardPath);
    expect(block?.repairCommands.join(' ')).toContain('.bak');
  });

  it('reports a dead-owner spend guard distinctly from an in-flight guard', () => {
    const spendGuardPath = daemonSpendGuardPath();
    mkdirSync(dirname(spendGuardPath), { recursive: true });
    writeFileSync(
      spendGuardPath,
      JSON.stringify({
        token: 'dead-owner-token',
        pid: 9_999_999,
        hostname: 'test-host',
        armedAt: '2026-07-08T07:01:26.780Z',
        itemIds: ['item-a', 'item-b'],
      }, null, 2) + '\n',
      'utf8',
    );

    const diagnosis = diagnoseGuardHealth();
    const ids = diagnosis.blocks.map((b) => b.id);
    expect(ids).toContain('daemon-spend-guard-dead-owner');
    expect(ids).not.toContain('daemon-spend-guard-armed');
    const block = diagnosis.blocks.find((b) => b.id === 'daemon-spend-guard-dead-owner');
    expect(block?.path).toBe(spendGuardPath);
    expect(block?.detail).toContain('owner pid 9999999 is not running');
    expect(block?.detail).toContain('2 item(s)');
  });

  it('does not block on a spend guard owned by the currently running daemon pid', () => {
    const state = loadDaemonState();
    state.running = true;
    state.pid = process.pid;
    saveDaemonState(state);

    const guard = armDaemonSpendGuard(['item-a']);
    expect(guard.ok).toBe(true);

    const lockPath = daemonLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: 'test-lock',
        hostname: 'test-host',
        acquiredAt: now,
        heartbeatAt: now,
      }, null, 2) + '\n',
      'utf8',
    );

    const diagnosis = diagnoseGuardHealth();
    expect(diagnosis.blocks.map((b) => b.id)).not.toContain('daemon-spend-guard-armed');
    expect(diagnosis.blocks.map((b) => b.id)).not.toContain('daemon-spend-guard-stale-live-owner');
  });

  it('blocks on a live daemon spend guard when the daemon lock heartbeat is missing', () => {
    const state = loadDaemonState();
    state.running = true;
    state.pid = process.pid;
    saveDaemonState(state);

    const guard = armDaemonSpendGuard(['item-a']);
    expect(guard.ok).toBe(true);

    const diagnosis = diagnoseGuardHealth();
    const block = diagnosis.blocks.find((b) => b.id === 'daemon-spend-guard-stale-live-owner');
    expect(block).toBeDefined();
    expect(block?.detail).toContain('no matching daemon lock heartbeat');
    expect(block?.path).toBe(daemonLockPath());
  });

  it('blocks on a live daemon spend guard when the daemon heartbeat is stale', () => {
    const state = loadDaemonState();
    state.running = true;
    state.pid = process.pid;
    saveDaemonState(state);

    const guard = armDaemonSpendGuard(['item-a']);
    expect(guard.ok).toBe(true);

    const lockPath = daemonLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: 'test-lock',
        hostname: 'test-host',
        acquiredAt: '2026-07-01T00:00:00.000Z',
        heartbeatAt: '2026-07-01T00:00:00.000Z',
      }, null, 2) + '\n',
      'utf8',
    );

    const diagnosis = diagnoseGuardHealth();
    const ids = diagnosis.blocks.map((b) => b.id);
    expect(ids).toContain('daemon-spend-guard-stale-live-owner');
    expect(ids).not.toContain('daemon-spend-guard-armed');
    const block = diagnosis.blocks.find((b) => b.id === 'daemon-spend-guard-stale-live-owner');
    expect(block?.path).toBe(lockPath);
    expect(block?.detail).toContain('heartbeat is stale');
  });
});

describe('daemon status guard health', () => {
  it('includes guardHealth in JSON and renders blocks in human output', async () => {
    const statePath = daemonStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, 'not-json {{{', 'utf8');

    const json = await captureStdout(() => cmdDaemon(['status', '--json']));
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as { guardHealth?: { blocked: boolean; blocks: Array<{ id: string }> } };
    expect(parsed.guardHealth?.blocked).toBe(true);
    expect(parsed.guardHealth?.blocks.map((b) => b.id)).toContain('daemon-state-malformed');

    const human = await captureStdout(() => cmdDaemon(['status']));
    expect(human.code).toBe(0);
    expect(human.out).toContain('guard health:');
    expect(human.out).toContain('daemon-state-malformed');
    expect(human.out).toContain('repair:');
  });
});

describe('FleetStatus guard health', () => {
  it('adds guardHealth to FleetStatus and formatter output', async () => {
    const spendGuardPath = daemonSpendGuardPath();
    mkdirSync(dirname(spendGuardPath), { recursive: true });
    writeFileSync(spendGuardPath, '{"token":42}', 'utf8');

    const status = await buildFleetStatus(baseConfig());
    expect(status.guardHealth?.blocked).toBe(true);
    expect(status.guardHealth?.blocks.map((b) => b.id)).toContain('daemon-spend-guard-malformed');

    const rendered = formatFleetStatus(status);
    expect(rendered).toContain('Guard health:');
    expect(rendered).toContain('daemon-spend-guard-malformed');
    expect(rendered).toContain('repair:');
  });
});
