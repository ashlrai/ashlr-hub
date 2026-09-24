/**
 * V3.10 Track B unit B-U1 — standing authority end to end.
 *
 * Install a signed grant → the switch → currentStandingPolicy → a standing
 * session → per-tick single-use `resident-standing` capabilities, and every
 * way authority is LOWERED (Stop, switch down, revoke, expiry, changed
 * authority code, a broken ledger) taking effect immediately and without
 * auth. The compiled trust roots are replaced by a test root through module
 * mocking — production code has no hook that could add one — and the host /
 * surface / confinement probes are faked; everything else is real, in a
 * temporary HOME.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ surface: 'b'.repeat(64) as string | null, confinement: true }));

vi.mock('../src/core/authority/trust-roots.js', async () => {
  const helpers = await import('./helpers/authority-310b.js');
  return { STANDING_GRANT_TRUST_ROOTS: Object.freeze([helpers.TEST_ROOT]), BURNED_KEY_IDS: Object.freeze(['mason-workstation']) };
});

vi.mock('../src/core/authority/surface.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/authority/surface.js')>();
  return {
    ...original,
    currentHostBinding: () => 'a'.repeat(64),
    confinementAvailable: () => (probe.confinement ? { ok: true } : { ok: false, reason: 'no sandbox in this test' }),
    runningPackageRoot: () => '/test/release',
    verifyAuthoritySurface: (target: 'running' | 'installed') => (probe.surface
      ? { ok: true, target, packageRoot: '/test/release', digest: probe.surface, fileCount: 1, checkedAt: new Date().toISOString() }
      : { ok: false, target, packageRoot: null, code: 'manifest-missing', reason: 'no manifest in this test', checkedAt: new Date().toISOString() }),
  };
});

// Stop / Revoke cancel armed host merges through U3's module (loaded lazily by
// clamp.ts). Faked here: this suite is about the grant, not the merge stack.
const merges = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../src/core/fleet/host-merge.js', () => ({
  revokeArmedHostMerges: (reason: string) => {
    merges.calls.push(reason);
    return { revoked: 0, failed: [] };
  },
}));

import { closeStandingSession, mintStandingTickCapability, openStandingSession } from '../src/core/authority/capability.js';
import { clearStop, revokeStanding, stopAutonomy } from '../src/core/authority/clamp.js';
import {
  currentStandingPolicy,
  evaluateStandingAuthority,
  invalidateStandingPolicyCache,
  requestAutonomySwitch,
} from '../src/core/authority/effective-config.js';
import { appendLedger, ledgerPath, readLedger, resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { installStandingGrant, installedGrantPath } from '../src/core/authority/standing-grant.js';
import { isDaemonActivationCapability, liveConductorActivationAuthorized } from '../src/core/daemon/activation-permit.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { StandingGrantV1 } from '../src/core/authority/types.js';
import { editGrant, makeGrant, signGrant, withTempHome } from './helpers/authority-310b.js';

let restore: () => void;

beforeEach(() => {
  restore = withTempHome('bu1-cap-').restore;
  probe.surface = 'b'.repeat(64);
  probe.confinement = true;
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
});

afterEach(() => {
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
  restore();
});

const cfg = {} as AshlrConfig;

function install(grant: StandingGrantV1 = makeGrant()) {
  const result = installStandingGrant(signGrant(grant), { surface: 'running' });
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  return result;
}

function goAutonomous(): void {
  const result = requestAutonomySwitch('autonomous', 'mason', 'test');
  if (!result.ok) throw new Error(result.reason);
}

describe('installing and using a grant', () => {
  it('is dark with no grant, and the switch cannot be raised past it', () => {
    expect(evaluateStandingAuthority({ mode: 'fresh', surface: 'running' }).grantState).toBe('none');
    expect(currentStandingPolicy()).toBeNull();
    const raised = requestAutonomySwitch('propose', 'mason', 'test');
    expect(raised).toMatchObject({ ok: false, code: 'grant-required' });
    expect(openStandingSession(cfg).ok).toBe(false);
    expect(liveConductorActivationAuthorized()).toBe(false);
  });

  it('a verified grant + the switch yield a policy, a session and single-use capabilities', async () => {
    const installed = install();
    expect(installed).toMatchObject({ ok: true, recovered: false });
    expect(readFileSync(installedGrantPath(), 'utf8').endsWith('\n')).toBe(true);
    // Installed but the switch is Off: still dark.
    expect(currentStandingPolicy()).toBeNull();
    expect(openStandingSession(cfg)).toMatchObject({ ok: false });
    goAutonomous();
    const policy = currentStandingPolicy();
    expect(policy).toMatchObject({ switch: 'autonomous', grantId: makeGrant().grantId, rollout: { stageId: 'shadow' } });
    expect(liveConductorActivationAuthorized()).toBe(true);

    const opened = openStandingSession(cfg);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const minted = mintStandingTickCapability(opened.session);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.capability.kind).toBe('resident-standing');
    expect(minted.capability.grantId).toBe(makeGrant().grantId);
    expect(isDaemonActivationCapability(minted.capability)).toBe(true);
    // Single use.
    expect(isDaemonActivationCapability(minted.capability)).toBe(false);
    // A structurally identical object is not a capability.
    expect(isDaemonActivationCapability({ ...minted.capability })).toBe(false);
    // A look-alike session is refused.
    expect(mintStandingTickCapability({ ...opened.session }).ok).toBe(false);
    closeStandingSession(opened.session);
    expect(mintStandingTickCapability(opened.session).ok).toBe(false);

    const read = await readLedger();
    expect(read.chain).toBe('ok');
    expect(read.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['grant:accepted', 'switch:changed', 'note']));
  });

  it('the conductors follow the grant’s conductorGoals', () => {
    install(makeGrant({ conductorGoals: false }));
    goAutonomous();
    expect(currentStandingPolicy()).not.toBeNull();
    expect(liveConductorActivationAuthorized()).toBe(false);
  });

  it('no OS confinement means no session and no ticks', () => {
    install();
    goAutonomous();
    probe.confinement = false;
    invalidateStandingPolicyCache();
    const opened = openStandingSession(cfg);
    expect(opened).toMatchObject({ ok: false });
    if (!opened.ok) expect(opened.reason).toMatch(/confinement/);
  });

  it('the rollout advances on its own during a tick', async () => {
    install();
    goAutonomous();
    for (let i = 0; i < 2; i += 1) {
      appendLedger({
        kind: 'gate:would-merge',
        actor: 'daemon',
        grantId: makeGrant().grantId,
        repo: 'ashlrai/ashlrcode',
        data: { v: 1, proposalId: `p${i}`, repo: 'ashlrai/ashlrcode', headSha: 'f'.repeat(40), gatesDigest: 'd'.repeat(64), withheldBecause: 'shadow', risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0, at: new Date().toISOString() },
      });
    }
    const opened = openStandingSession(cfg);
    if (!opened.ok) throw new Error(opened.reason);
    const minted = mintStandingTickCapability(opened.session);
    expect(minted.ok).toBe(true);
    if (minted.ok) expect(minted.policy.rollout.stageId).toBe('2a');
    expect((await readLedger({ kinds: ['rollout:advanced'] })).entries).toHaveLength(1);
    expect(currentStandingPolicy()?.rollout.stageId).toBe('2a');
  });
});

describe('lowering is instant and needs no auth', () => {
  function live(): { session: Parameters<typeof mintStandingTickCapability>[0] } {
    install();
    goAutonomous();
    const opened = openStandingSession(cfg);
    if (!opened.ok) throw new Error(opened.reason);
    return { session: opened.session };
  }

  it('Stop: no policy on the very next call, a minted-but-unclaimed capability is refused, no new ones', () => {
    const { session } = live();
    const minted = mintStandingTickCapability(session);
    expect(currentStandingPolicy()).not.toBeNull();
    expect(stopAutonomy({ actor: 'mason', reason: 'test', waitMs: 0 }).armed).toBe(true);
    expect(currentStandingPolicy()).toBeNull();
    if (minted.ok) expect(isDaemonActivationCapability(minted.capability)).toBe(false);
    expect(mintStandingTickCapability(session).ok).toBe(false);
    expect(clearStop({ actor: 'mason', reason: 'test', waitMs: 2_000 }).ok).toBe(true);
    expect(currentStandingPolicy()).not.toBeNull();
  });

  it('switching down narrows immediately (no 10-second staleness)', () => {
    live();
    expect(currentStandingPolicy()?.switch).toBe('autonomous');
    expect(requestAutonomySwitch('propose', 'mason', 'test').ok).toBe(true);
    const proposing = currentStandingPolicy();
    expect(proposing?.switch).toBe('propose');
    expect(proposing?.leader.classes).toEqual([]);
    expect(requestAutonomySwitch('off', 'mason', 'test').ok).toBe(true);
    expect(currentStandingPolicy()).toBeNull();
    // Raising back within the grant needs no Touch ID.
    expect(requestAutonomySwitch('autonomous', 'mason', 'test').ok).toBe(true);
    expect(currentStandingPolicy()?.switch).toBe('autonomous');
  });

  it('revoke: switch off, Stop engaged, grant moved aside, resuming needs a NEW grant and clearing Stop', () => {
    const { session } = live();
    const revoked = revokeStanding({ actor: 'mason', reason: 'test' });
    expect(revoked).toMatchObject({ ok: true, ledgered: true, minGrantSeq: 2, stopped: true, liveExecutionLeases: 0 });
    expect(currentStandingPolicy()).toBeNull();
    expect(mintStandingTickCapability(session).ok).toBe(false);
    // Re-installing the revoked grant is refused.
    const again = installStandingGrant(signGrant(makeGrant()), { surface: 'running' });
    expect(again.ok).toBe(false);
    // A newer grant installs, but Stop (engaged by the revoke) still holds everything dark…
    install(makeGrant({ grantId: 'fedcba9876543210fedcba9876543210', grantSeq: 2 }));
    goAutonomous();
    expect(currentStandingPolicy()).toBeNull();
    // …until Mason clears it.
    expect(clearStop({ actor: 'mason', reason: 'test', waitMs: 2_000 }).ok).toBe(true);
    expect(currentStandingPolicy()?.grantSeq).toBe(2);
  });

  it('changed authority code pauses the grant (recorded once); the same code resumes it', async () => {
    const { session } = live();
    probe.surface = 'c'.repeat(64);
    invalidateStandingPolicyCache();
    const ev = evaluateStandingAuthority({ mode: 'fresh', surface: 'running' });
    expect(ev).toMatchObject({ grantState: 'paused', pauseCode: 'authority-code-changed' });
    expect(mintStandingTickCapability(session).ok).toBe(false);
    expect(mintStandingTickCapability(session).ok).toBe(false);
    expect((await readLedger({ kinds: ['grant:paused'] })).entries).toHaveLength(1);
    probe.surface = 'b'.repeat(64);
    invalidateStandingPolicyCache();
    expect(mintStandingTickCapability(session).ok).toBe(true);
  });

  it('an expired grant stops everything and is recorded once', async () => {
    install(makeGrant({ issuedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), expiresAt: new Date(Date.now() + 1500).toISOString() }));
    goAutonomous();
    const opened = openStandingSession(cfg);
    if (!opened.ok) throw new Error(opened.reason);
    await new Promise((r) => setTimeout(r, 1600));
    expect(currentStandingPolicy()).toBeNull();
    expect(mintStandingTickCapability(opened.session).ok).toBe(false);
    expect(mintStandingTickCapability(opened.session).ok).toBe(false);
    expect((await readLedger({ kinds: ['grant:expired'] })).entries).toHaveLength(1);
  });

  it('a broken ledger halts everything until a new grant; the new grant recovers the chain', () => {
    live();
    const text = readFileSync(ledgerPath(), 'utf8');
    writeFileSync(ledgerPath(), text.replace('"topic":"standing-session:opened"', '"topic":"standing-session:forged"'), { mode: 0o600 });
    resetLedgerCachesForTest();
    invalidateStandingPolicyCache();
    const ev = evaluateStandingAuthority({ mode: 'fresh', surface: 'running' });
    expect(ev).toMatchObject({ grantState: 'paused', pauseCode: 'ledger-broken' });
    expect(currentStandingPolicy()).toBeNull();
    // Raising is refused while broken; lowering still works.
    expect(requestAutonomySwitch('off', 'mason', 'test').ok).toBe(true);
    expect(requestAutonomySwitch('autonomous', 'mason', 'test').ok).toBe(false);
    // Re-installing the same (older) grant cannot recover it; a newer signed grant does.
    expect(installStandingGrant(signGrant(makeGrant()), { surface: 'running' }).ok).toBe(false);
    const recovered = install(makeGrant({ grantId: '11111111111111111111111111111111', grantSeq: 2 }));
    expect(recovered.recovered).toBe(true);
    goAutonomous();
    expect(currentStandingPolicy()?.grantSeq).toBe(2);
  });
});

describe('sequence rollback and tampering', () => {
  it('putting an older signed grant back in place is refused even though it never expired', () => {
    const old = makeGrant();
    const oldEnvelope = signGrant(old);
    install(old);
    install(makeGrant({ grantId: '22222222222222222222222222222222', grantSeq: 2 }));
    goAutonomous();
    expect(currentStandingPolicy()?.grantSeq).toBe(2);
    writeFileSync(installedGrantPath(), `${JSON.stringify(oldEnvelope)}\n`, { mode: 0o600 });
    invalidateStandingPolicyCache();
    const ev = evaluateStandingAuthority({ mode: 'fresh', surface: 'running' });
    expect(ev.policy).toBeNull();
    expect(['revoked', 'invalid']).toContain(ev.grantState);
  });

  it('a hand-edited grant file is invalid (not canonical, and the signature would not match anyway)', () => {
    install();
    const text = readFileSync(installedGrantPath(), 'utf8');
    writeFileSync(installedGrantPath(), text.replace('"conductorGoals":true', '"conductorGoals":false'), { mode: 0o600 });
    invalidateStandingPolicyCache();
    expect(evaluateStandingAuthority({ mode: 'fresh', surface: 'running' }).grantState).toBe('invalid');
  });

  it('a grant that only widens beyond what was signed cannot be produced: a stage-widened payload fails before signing', () => {
    const widened = editGrant(makeGrant(), (g) => { g.rollout.stages[0]!.maxFiles = 11; });
    const result = installStandingGrant(signGrant(widened), { surface: 'running' });
    expect(result).toMatchObject({ ok: false, code: 'schema' });
  });
});
