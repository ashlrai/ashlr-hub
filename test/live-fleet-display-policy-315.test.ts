/**
 * 3.15 "the live fleet actually works" — Verse's Command card and header chip
 * read the same standing grant.
 *
 * Live (Verse 3.14.0, 2026-09-27 17:20): the header chip said "GRANT 29d"
 * while the Command card said "Fleet is dark · No standing grant is in force".
 * The card read currentStandingPolicy(), which verifies the RUNNING process's
 * authority code; the desktop sidecar is a Bun single-file binary, so that
 * check always fails there (surface `no-running-release` → grant `paused` →
 * policy null). The chip evaluates against displaySurfaceTarget() (the
 * installed daemon release). displayStandingPolicy() evaluates what the chip
 * evaluates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  kill: false,
  switch: 'autonomous' as string,
  target: 'installed' as 'installed' | 'running',
  calls: [] as { surface: string }[],
  evaluation: null as unknown,
}));

vi.mock('../src/core/authority/effective-config.js', () => ({
  displaySurfaceTarget: () => state.target,
  evaluateStandingAuthority: (opts: { surface: string }) => {
    state.calls.push({ surface: opts.surface });
    return state.evaluation;
  },
}));
vi.mock('../src/core/authority/clamp.js', () => ({
  readClamp: () => ({ state: 'ok', clamp: { switch: state.switch } }),
}));
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => state.kill,
}));

const { displayStandingPolicy, displayStandingPolicyReadiness, resetDisplayStandingPolicyForTest } = await import('../src/core/verse/display-standing-policy.js');

const NOW = Date.parse('2026-09-27T21:20:00.000Z');
const POLICY = { v: 1, grantId: 'e0c98949af418041dd06fa68b22df66b', switch: 'autonomous', repos: [] };

function evaluation(overrides: Record<string, unknown> = {}): unknown {
  return {
    grantState: 'active',
    policy: POLICY,
    grant: { grantId: POLICY.grantId, expiresAt: '2026-10-27T05:46:57.637Z' },
    ...overrides,
  };
}

beforeEach(() => {
  state.kill = false;
  state.switch = 'autonomous';
  state.target = 'installed';
  state.calls = [];
  state.evaluation = evaluation();
  resetDisplayStandingPolicyForTest();
});

afterEach(() => {
  resetDisplayStandingPolicyForTest();
});

describe('displayStandingPolicy', () => {
  it('retains display-target diagnostics for paused, off, missing and expired grants', () => {
    for (const [grantState, reason] of [
      ['paused', 'The authority code changed.'],
      ['active', 'The autonomy switch is Off.'],
      ['none', 'No standing grant is installed.'],
    ]) {
      resetDisplayStandingPolicyForTest();
      state.evaluation = evaluation({ grantState, policy: null, inactiveReason: reason });
      expect(displayStandingPolicyReadiness(NOW)).toEqual({ policy: null, grantState, reason });
    }
    resetDisplayStandingPolicyForTest();
    state.evaluation = evaluation();
    displayStandingPolicyReadiness(NOW);
    expect(displayStandingPolicyReadiness(Date.parse('2026-10-28T00:00:00.000Z')))
      .toEqual({ policy: null, grantState: 'expired', reason: 'The standing grant has expired.' });
  });

  it('reports Stop immediately after a cached active display reading', () => {
    expect(displayStandingPolicyReadiness(NOW).policy).toBe(POLICY);
    state.kill = true;
    expect(displayStandingPolicyReadiness(NOW + 1)).toEqual({ policy: null, grantState: null, reason: 'Stop is on.' });
    expect(state.calls).toHaveLength(1);
  });

  it('evaluates the display surface (the installed release in the sidecar), not `running`', () => {
    expect(displayStandingPolicy(NOW)).toBe(POLICY);
    expect(state.calls).toEqual([{ surface: 'installed' }]);
  });

  it('is null when the grant is not active, expired, or Stop is on', () => {
    state.evaluation = evaluation({ grantState: 'paused', policy: null });
    expect(displayStandingPolicy(NOW)).toBeNull();

    resetDisplayStandingPolicyForTest();
    state.evaluation = evaluation();
    expect(displayStandingPolicy(Date.parse('2026-10-28T00:00:00.000Z'))).toBeNull();

    resetDisplayStandingPolicyForTest();
    state.kill = true;
    expect(displayStandingPolicy(NOW)).toBeNull();
  });

  it('caches for 10 s but re-evaluates at once when the switch or Stop changes', () => {
    displayStandingPolicy(NOW);
    displayStandingPolicy(NOW + 5_000);
    expect(state.calls).toHaveLength(1);
    state.switch = 'propose';
    state.evaluation = evaluation({ policy: { ...POLICY, switch: 'propose' } });
    expect(displayStandingPolicy(NOW + 6_000)).toMatchObject({ switch: 'propose' });
    expect(state.calls).toHaveLength(2);
    displayStandingPolicy(NOW + 17_000);
    expect(state.calls).toHaveLength(3);
  });

  it('never throws', () => {
    state.evaluation = null;
    expect(displayStandingPolicy(NOW)).toBeNull();
  });
});
