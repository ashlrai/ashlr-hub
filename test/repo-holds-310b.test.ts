/**
 * V3.10 Track B unit U4 — repo holds (src/core/fleet/quarantine.ts).
 *
 * Pins: holds are listed only while active; the permission matrix (only Mason
 * clears an owner-hold, the Leader touches only leader-pause); extend-only
 * re-sets by actors that may not clear; lowering never waits on the ledger,
 * raising requires it; a corrupt store is never read as "no holds"; private
 * file modes; scrubbed reasons.
 *
 * HOME is isolated by test/setup/home.ts. The authority ledger and the
 * standing policy are mocked: B-U1 builds them in parallel, and this suite
 * pins U4's side of the contract (what is appended, and when).
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ledgerRows: { kind: string; data: unknown; actor: string; repo: string | null }[] = [];
let ledgerOk = true;
vi.mock('../src/core/authority/ledger.js', () => ({
  appendLedger: (input: { kind: string; data: unknown; actor: string; repo: string | null }) => {
    if (!ledgerOk) return { ok: false, reason: 'ledger offline (test)' };
    ledgerRows.push(input);
    return { ok: true, entry: { ...input, seq: ledgerRows.length - 1 } };
  },
  readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
  currentLedgerHead: () => null,
}));
vi.mock('../src/core/authority/effective-config.js', () => ({
  currentStandingPolicy: () => null,
}));

const {
  authorityStateDir,
  HOLD_PERMISSIONS,
  listRepoHolds,
  repoHoldsFor,
  repoHoldsPath,
  setRepoHold,
  sweepExpiredRepoHolds,
} = await import('../src/core/fleet/quarantine.js');

const T0 = Date.parse('2026-09-24T10:00:00.000Z');
const H = 60 * 60 * 1000;
const at = (ms: number): string => new Date(ms).toISOString();

// The worker HOME is shared by every file this worker runs: start and end clean.
beforeEach(() => {
  ledgerRows.length = 0;
  ledgerOk = true;
  rmSync(authorityStateDir(), { recursive: true, force: true });
});
afterEach(() => {
  rmSync(authorityStateDir(), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('repo holds — store', () => {
  it('no store file ⇒ no holds (and reading creates nothing)', () => {
    expect(listRepoHolds({ nowMs: T0 })).toEqual([]);
    expect(() => statSync(repoHoldsPath())).toThrow();
  });

  it('sets a quarantine, lists it while active, ledgers hold:set, and writes 0600 in a 0700 dir', () => {
    const r = setRepoHold({
      repo: 'ashlrai/binshield',
      kind: 'quarantine',
      actor: 'post-merge-watch',
      hold: { reason: 'red after PR #12', until: at(T0 + 6 * H), landingId: 'ashlrai/binshield#12@abc' },
    }, { nowMs: T0 });
    expect(r).toMatchObject({ ok: true, reason: null, before: null });
    expect(r.after).toMatchObject({
      v: 1, repo: 'ashlrai/binshield', kind: 'quarantine', setBy: 'post-merge-watch',
      since: at(T0), until: at(T0 + 6 * H), landingId: 'ashlrai/binshield#12@abc',
    });
    expect(listRepoHolds({ nowMs: T0 + H })).toHaveLength(1);
    expect(listRepoHolds({ nowMs: T0 + 6 * H })).toEqual([]); // expiry is exclusive
    expect(ledgerRows).toEqual([expect.objectContaining({ kind: 'hold:set', actor: 'post-merge-watch', repo: 'ashlrai/binshield' })]);
    if (process.platform !== 'win32') {
      expect(statSync(repoHoldsPath()).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(repoHoldsPath())).mode & 0o777).toBe(0o700);
    }
  });

  it('matches repos case-insensitively (a hold on AshlrAI/Binshield pauses ashlrai/binshield)', () => {
    setRepoHold({ repo: 'AshlrAI/Binshield', kind: 'owner-hold', actor: 'mason', hold: { reason: 'paused', until: null } }, { nowMs: T0 });
    expect(repoHoldsFor('ashlrai/binshield', { nowMs: T0 })).toHaveLength(1);
    // …and a second set of the same kind replaces instead of duplicating.
    setRepoHold({ repo: 'ashlrai/binshield', kind: 'owner-hold', actor: 'mason', hold: { reason: 'still paused', until: null } }, { nowMs: T0 });
    expect(listRepoHolds({ nowMs: T0 })).toHaveLength(1);
  });

  it('a corrupt store THROWS from listRepoHolds and refuses setRepoHold — never "no holds"', () => {
    mkdirSync(dirname(repoHoldsPath()), { recursive: true, mode: 0o700 });
    writeFileSync(repoHoldsPath(), '{"v":1,"holds":[{"repo":"x"}]}', { mode: 0o600 });
    expect(() => listRepoHolds({ nowMs: T0 })).toThrow(/repo holds unknown/);
    const r = setRepoHold({ repo: 'ashlrai/locus', kind: 'quarantine', actor: 'daemon', hold: { reason: 'r', until: at(T0 + H) } }, { nowMs: T0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/malformed hold/);
    expect(ledgerRows).toEqual([]);
  });

  it('refuses malformed input with a specific sentence and writes nothing', () => {
    const bad = [
      { repo: '../etc', kind: 'quarantine', actor: 'daemon', hold: { reason: 'r', until: null } },
      { repo: 'a/b', kind: 'freeze', actor: 'daemon', hold: { reason: 'r', until: null } },
      { repo: 'a/b', kind: 'quarantine', actor: 'agent', hold: { reason: 'r', until: null } },
      { repo: 'a/b', kind: 'quarantine', actor: 'daemon', hold: { reason: '   ', until: null } },
      { repo: 'a/b', kind: 'quarantine', actor: 'daemon', hold: { reason: 'r', until: at(T0 - 1) } },
      { repo: 'a/b', kind: 'quarantine', actor: 'daemon', hold: { reason: 'r', until: 'tomorrow' } },
      { repo: 'a/b', kind: 'quarantine', actor: 'daemon', hold: { reason: 'r', until: null, landingId: 'has space' } },
    ];
    for (const req of bad) {
      const r = setRepoHold(req as never, { nowMs: T0 });
      expect(r.ok, JSON.stringify(req)).toBe(false);
      expect(r.reason).toBeTruthy();
    }
    expect(() => statSync(repoHoldsPath())).toThrow();
  });

  it('scrubs secrets out of the reason', () => {
    const r = setRepoHold({
      repo: 'ashlrai/locus', kind: 'quarantine', actor: 'daemon',
      hold: { reason: 'failed with token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB in output', until: at(T0 + H) },
    }, { nowMs: T0 });
    expect(r.after?.reason).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
  });
});

describe('repo holds — who may do what', () => {
  it('matrix: only Mason clears an owner-hold; the Leader only leader-pause; backpressure only cooldown', () => {
    expect(HOLD_PERMISSIONS['owner-hold'].clear).toEqual(['mason']);
    expect(HOLD_PERMISSIONS['leader-pause'].set).toContain('leader');
    for (const kind of ['quarantine', 'owner-hold', 'cooldown'] as const) {
      expect(HOLD_PERMISSIONS[kind].set).not.toContain('leader');
      expect(HOLD_PERMISSIONS[kind].clear).not.toContain('leader');
    }
    expect(HOLD_PERMISSIONS.cooldown.set).toContain('backpressure');
    expect(HOLD_PERMISSIONS.quarantine.set).not.toContain('backpressure');
  });

  it('the Leader cannot set an owner-hold, nor clear one; the watch cannot clear one; Mason can', () => {
    expect(setRepoHold({ repo: 'a/b', kind: 'owner-hold', actor: 'leader', hold: { reason: 'r', until: null } }, { nowMs: T0 }).ok).toBe(false);
    expect(setRepoHold({ repo: 'a/b', kind: 'owner-hold', actor: 'post-merge-watch', hold: { reason: 'revert failed', until: null } }, { nowMs: T0 }).ok).toBe(true);
    for (const actor of ['leader', 'post-merge-watch', 'daemon', 'backpressure'] as const) {
      const r = setRepoHold({ repo: 'a/b', kind: 'owner-hold', actor, hold: null }, { nowMs: T0 });
      expect(r.ok, actor).toBe(false);
      expect(r.after).not.toBeNull();
    }
    expect(listRepoHolds({ nowMs: T0 })).toHaveLength(1);
    const mason = setRepoHold({ repo: 'a/b', kind: 'owner-hold', actor: 'mason', hold: null }, { nowMs: T0 });
    expect(mason).toMatchObject({ ok: true, after: null });
    expect(mason.before?.kind).toBe('owner-hold');
    expect(listRepoHolds({ nowMs: T0 })).toEqual([]);
    expect(ledgerRows.map((r) => r.kind)).toEqual(['hold:set', 'hold:cleared']);
  });

  it('an actor that may not clear a kind may only EXTEND it when re-setting', () => {
    setRepoHold({ repo: 'a/b', kind: 'owner-hold', actor: 'post-merge-watch', hold: { reason: 'first', until: null } }, { nowMs: T0 });
    const r = setRepoHold({ repo: 'a/b', kind: 'owner-hold', actor: 'daemon', hold: { reason: 'second', until: at(T0 + H) } }, { nowMs: T0 + 1000 });
    expect(r.ok).toBe(true);
    expect(r.after).toMatchObject({ until: null, since: at(T0), reason: 'second' });
  });

  it('clearing a hold that does not exist is a no-op success (and writes no ledger row)', () => {
    const r = setRepoHold({ repo: 'a/b', kind: 'cooldown', actor: 'backpressure', hold: null }, { nowMs: T0 });
    expect(r).toEqual({ ok: true, reason: null, before: null, after: null });
    expect(ledgerRows).toEqual([]);
  });
});

describe('repo holds — ledger fail directions', () => {
  it('SETTING (lowering) stands even when the ledger refuses; the failure is audited, not fatal', () => {
    ledgerOk = false;
    const r = setRepoHold({ repo: 'a/b', kind: 'quarantine', actor: 'post-merge-watch', hold: { reason: 'red', until: at(T0 + H) } }, { nowMs: T0 });
    expect(r.ok).toBe(true);
    expect(listRepoHolds({ nowMs: T0 })).toHaveLength(1);
  });

  it('CLEARING (raising) is refused when the ledger refuses — the hold stands', () => {
    setRepoHold({ repo: 'a/b', kind: 'owner-hold', actor: 'mason', hold: { reason: 'paused', until: null } }, { nowMs: T0 });
    ledgerOk = false;
    const r = setRepoHold({ repo: 'a/b', kind: 'owner-hold', actor: 'mason', hold: null }, { nowMs: T0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ledger refused the clear/);
    expect(listRepoHolds({ nowMs: T0 })).toHaveLength(1);
  });

  it('sweep ledgers each expired hold as hold:cleared and drops it; active holds stay', () => {
    setRepoHold({ repo: 'a/b', kind: 'quarantine', actor: 'post-merge-watch', hold: { reason: 'red', until: at(T0 + H) } }, { nowMs: T0 });
    setRepoHold({ repo: 'a/c', kind: 'owner-hold', actor: 'mason', hold: { reason: 'paused', until: null } }, { nowMs: T0 });
    ledgerRows.length = 0;
    const swept = sweepExpiredRepoHolds({ nowMs: T0 + 2 * H });
    expect(swept.error).toBeNull();
    expect(swept.swept.map((h) => h.repo)).toEqual(['a/b']);
    expect(ledgerRows).toEqual([expect.objectContaining({ kind: 'hold:cleared', data: expect.objectContaining({ repo: 'a/b', kind: 'quarantine' }) })]);
    expect(listRepoHolds({ nowMs: T0 + 2 * H }).map((h) => h.repo)).toEqual(['a/c']);
  });
});
