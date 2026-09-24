/**
 * V3.10 Track B unit U4 — the halt and the rollback reflex under a standing
 * policy (daemon/post-merge-halt.ts, fleet/regression-sentinel.ts) and the
 * global soft kill the post-merge watch arms.
 *
 * Pins:
 *   - resolvePostMergeHaltMode: the local-head gate stands down under a
 *     standing policy (mirrors move with every push; the per-landing watch
 *     replaces it) and master's behaviour is unchanged otherwise;
 *   - recordFleetEscalationHalt lands in the same halt record the morning
 *     report reads;
 *   - armGlobalSoftKill writes the real Stop sentinel (isolated HOME) and
 *     reports whether it changed anything;
 *   - the regression sentinel yields to the watch under a standing policy and
 *     treats `Ashlr-Grant:` squash commits as fleet candidates otherwise.
 */
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';

const standing = { policy: null as null | { grantId: string } };
vi.mock('../src/core/authority/effective-config.js', () => ({
  currentStandingPolicy: () => standing.policy,
}));

const { recordFleetEscalationHalt, readPostMergeHalts, resolvePostMergeHaltMode, postMergeHaltDir } =
  await import('../src/core/daemon/post-merge-halt.js');
const { armGlobalSoftKill } = await import('../src/core/fleet/post-merge-watch.js');
const { killSwitchOn, setKill } = await import('../src/core/sandbox/policy.js');
const { bisectAndRevert, detectRegression } = await import('../src/core/fleet/regression-sentinel.js');

const SENTINEL_ON = { foundry: { regressionSentinel: true } } as unknown as Pick<AshlrConfig, 'foundry'>;

beforeEach(() => {
  standing.policy = null;
});
afterEach(() => {
  // The worker HOME is shared across files: never leave Stop armed behind us.
  setKill(false);
  vi.restoreAllMocks();
});

describe('resolvePostMergeHaltMode', () => {
  it.each([
    [{ explicit: undefined, runWindow: false, standing: false }, 'off'],
    [{ explicit: undefined, runWindow: true, standing: false }, 'halt'],
    [{ explicit: true, runWindow: false, standing: false }, 'halt'],
    [{ explicit: false, runWindow: true, standing: false }, 'off'],
    // Under a standing policy the watch replaces the gate, whatever the flags say.
    [{ explicit: true, runWindow: true, standing: true }, 'watch'],
    [{ explicit: undefined, runWindow: false, standing: true }, 'watch'],
  ])('%j ⇒ %s', (input, mode) => {
    expect(resolvePostMergeHaltMode(input)).toBe(mode);
  });
});

describe('recordFleetEscalationHalt', () => {
  it('writes a private halt record the morning report reads back', () => {
    const nowMs = Date.parse('2026-09-24T03:10:00.000Z');
    const path = recordFleetEscalationHalt(
      { reason: '3 fleet reverts within 24 h', repos: ['ashlrai/ashlrcode'], landingIds: ['ashlrai/ashlrcode#12@aaaaaaaaaaaa'] },
      { now: () => nowMs },
    );
    expect(path).not.toBeNull();
    if (process.platform !== 'win32') expect(statSync(path!).mode & 0o777).toBe(0o600);
    const halts = readPostMergeHalts(50).filter((h) => h.haltedAt === new Date(nowMs).toISOString());
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ recordType: 'daemon-post-merge-halt', verdict: 'regressed', revertPlan: [] });
    expect(halts[0]!.detail).toBe('FLEET ESCALATION: 3 fleet reverts within 24 h (landing ashlrai/ashlrcode#12@aaaaaaaaaaaa)');
    expect(halts[0]!.failures).toEqual([expect.objectContaining({ repo: 'ashlrai/ashlrcode', command: 'post-merge watch' })]);
    expect(path!.startsWith(postMergeHaltDir())).toBe(true);
  });
});

describe('armGlobalSoftKill', () => {
  it('arms ~/.ashlr/KILL (isolated HOME) and reports whether it changed anything', () => {
    setKill(false);
    expect(killSwitchOn()).toBe(false);
    const first = armGlobalSoftKill('2 repos went red within 6 h');
    expect(first).toMatchObject({ ok: true, changed: true });
    expect(killSwitchOn()).toBe(true);
    const again = armGlobalSoftKill('3 fleet reverts within 24 h');
    expect(again).toMatchObject({ ok: true, changed: false });
  });
});

describe('regression sentinel under V3.10', () => {
  it('stands down entirely while a standing policy is live (the watch owns fleet reverts)', async () => {
    standing.policy = { grantId: 'g' };
    const git = vi.fn(() => null);
    const runSuite = vi.fn(async () => ({ red: true, conclusive: true }));
    await expect(detectRegression(SENTINEL_ON, '/nonexistent', { git, runSuite })).resolves.toEqual({ regressed: false });
    const bisect = await bisectAndRevert(SENTINEL_ON, '/nonexistent', { git, runSuite });
    expect(bisect.reason).toMatch(/standing policy is live/);
    expect(bisect.revertProposal).toBeUndefined();
    expect(git).not.toHaveBeenCalled();
    expect(runSuite).not.toHaveBeenCalled();
  });

  it('without a standing policy, fleet squash commits (Ashlr-Grant trailer) are bisect candidates too', async () => {
    const calls: string[][] = [];
    const git = vi.fn((args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'status') return '';
      if (args[0] === 'log') return '';
      return null;
    });
    const r = await bisectAndRevert(SENTINEL_ON, '/nonexistent', { git, runSuite: async () => ({ red: false }) });
    expect(r.reason).toMatch(/no recent auto-merge commits/);
    const log = calls.find((a) => a[0] === 'log')!;
    expect(log).toContain('--grep=ashlr: auto-merge');
    expect(log).toContain('--grep=^Ashlr-Grant: ');
  });
});
