/**
 * m49.fleet-status.test.ts — M49: fleet control plane + observability.
 *
 * Units under test:
 *   1. buildFleetStatus (src/core/fleet/status.ts) — READ-ONLY aggregation that
 *      NEVER throws. HOME is relocated to a fresh tmp dir per test so the whole
 *      ~/.ashlr surface (daemon state, quota ledger, backlog, inbox, kill
 *      switch) is isolated; restored afterward.
 *   2. formatFleetStatus (src/cli/fleet.ts) — the pure no-color formatter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, EngineId } from '../src/core/types.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import { recordUse } from '../src/core/fleet/quota.js';
import { setKill } from '../src/core/sandbox/policy.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

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

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry };
}

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

describe('buildFleetStatus — read-only aggregation (M49)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m49-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome; // win32 homedir()
  });

  afterEach(() => {
    // Always clear the kill switch we may have set (it lives under tmpHome, but
    // be explicit so a stray sentinel never leaks between tests).
    try {
      setKill(false);
    } catch {
      // best-effort
    }
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns the full shape with sane fallbacks on an empty ~/.ashlr', async () => {
    const cfg = baseConfig();
    const s = await buildFleetStatus(cfg);

    // Shape
    expect(typeof s.generatedAt).toBe('string');
    expect(Date.parse(s.generatedAt)).not.toBeNaN();
    expect(s.daemon).toBeDefined();
    expect(s.backends).toBeInstanceOf(Array);
    expect(s.queue).toBeDefined();
    expect(s.proposals).toBeDefined();
    expect(s.merges).toBeDefined();

    // Fallbacks on a pristine HOME
    expect(s.killed).toBe(false);
    expect(s.daemon.running).toBe(false);
    expect(s.daemon.lastTickAt).toBeNull();
    expect(s.daemon.todaySpentUsd).toBe(0);
    expect(s.queue.backlogItems).toBe(0);
    expect(s.proposals.pending).toBe(0);
    expect(s.proposals.frontierPending).toBe(0);
    expect(s.proposals.applied).toBe(0);
    expect(s.merges.recent).toBe(0);
  });

  it('reflects allowedBackends — defaults to [builtin] when no foundry', async () => {
    const cfg = baseConfig();
    const s = await buildFleetStatus(cfg);
    expect(s.backends.map((b) => b.backend)).toEqual(['builtin']);
    const builtin = s.backends.find((b) => b.backend === 'builtin')!;
    expect(builtin.dispatchesRecent).toBe(0);
    // No limit configured => unlimited.
    expect(builtin.quota).toBe('unlimited');
  });

  it("includes 'claude' with quota 'unlimited' when allowed but no limit set", async () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    const s = await buildFleetStatus(cfg);
    const names = s.backends.map((b) => b.backend);
    expect(names).toContain('claude');
    const claude = s.backends.find((b) => b.backend === 'claude')!;
    expect(claude.quota).toBe('unlimited');
    expect(claude.dispatchesRecent).toBe(0);
  });

  it('dispatchesRecent reflects recorded quota uses', async () => {
    const backend: EngineId = 'claude';
    const cfg = withFoundry({ allowedBackends: [backend] });

    recordUse(backend);
    recordUse(backend);
    recordUse(backend);

    const s = await buildFleetStatus(cfg);
    const claude = s.backends.find((b) => b.backend === backend)!;
    expect(claude.dispatchesRecent).toBe(3);
  });

  it("evaluates quota status when a limit is configured", async () => {
    const backend: EngineId = 'claude';
    const cfg = withFoundry({
      allowedBackends: [backend],
      limits: { [backend]: { window: '1d', max: 2 } },
    });

    // 2 uses against a max of 2 => at/over the cap => 'over'.
    recordUse(backend);
    recordUse(backend);

    const s = await buildFleetStatus(cfg);
    const claude = s.backends.find((b) => b.backend === backend)!;
    expect(claude.dispatchesRecent).toBe(2);
    expect(claude.quota).toBe('over');
  });

  it('reports killed:true when the kill switch is set', async () => {
    setKill(true);
    const s = await buildFleetStatus(baseConfig());
    expect(s.killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure formatter
// ---------------------------------------------------------------------------

describe('formatFleetStatus — pure formatter (M49)', () => {
  it('renders all sections and flags the paused banner when killed', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: true, lastTickAt: '2026-06-17T00:00:00.000Z', todaySpentUsd: 1.2345 },
      backends: [
        { backend: 'builtin', dispatchesRecent: 4, quota: 'unlimited' },
        { backend: 'claude', dispatchesRecent: 2, quota: 'warn' },
      ],
      queue: { backlogItems: 7 },
      proposals: { pending: 3, frontierPending: 1, applied: 5 },
      merges: { recent: 2 },
      killed: true,
    });

    expect(out).toContain('Fleet status');
    expect(out).toContain('[PAUSED');
    expect(out).toContain('Daemon:');
    expect(out).toContain('running');
    expect(out).toContain('$1.2345');
    expect(out).toContain('builtin');
    expect(out).toContain('claude');
    expect(out).toContain('quota=warn');
    expect(out).toContain('7 backlog item(s)');
    expect(out).toContain('frontier pending:  1');
    expect(out).toContain('applied:           5');
    expect(out).toContain('2 auto-merge(s)');
  });

  it('omits the paused banner when not killed', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    });
    expect(out).not.toContain('[PAUSED');
    expect(out).toContain('(none)');
  });
});
