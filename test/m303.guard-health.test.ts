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
  daemonSpendGuardPath,
  daemonStatePath,
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
