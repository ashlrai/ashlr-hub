/**
 * V3.10 Track B unit B-U1 — the clamp (Autonomy switch), Stop and Revoke.
 *
 * SPEC-310B §7 U1 key tests: the clamp is monotonic (raising is capped at the
 * grant and ledgered FIRST), lowering needs no auth and works even when the
 * ledger is broken. HOME-isolated.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

// U3's armed-merge revocation, loaded lazily by clamp.ts — faked so each test
// can observe (and break) it. `mode: 'throw'` simulates the module failing.
const merges = vi.hoisted(() => ({ calls: [] as string[], revoked: 0, mode: 'ok' as 'ok' | 'throw' }));
vi.mock('../src/core/fleet/host-merge.js', () => ({
  revokeArmedHostMerges: (reason: string) => {
    if (merges.mode === 'throw') throw new Error('host-merge exploded');
    merges.calls.push(reason);
    return { revoked: merges.revoked, failed: [] };
  },
}));

import {
  clampPath,
  clearStop,
  readClamp,
  revokeArmedMerges,
  revokeStanding,
  revokeStandingAndDrain,
  setAutonomySwitch,
  stopAutonomy,
  stopAutonomyAndDrain,
} from '../src/core/authority/clamp.js';
import { acquireOutwardMutationFence, ownsOutwardMutationFence, releaseOutwardMutationFence } from '../src/core/sandbox/mutation-fence.js';
import { registerExecutionLease, type ExecutionLease } from '../src/core/sandbox/execution-leases.js';
import { appendLedger, ensureAuthorityDir, ledgerPath, ledgerSnapshot, readLedger, resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { killSwitchOn, killSwitchPath } from '../src/core/sandbox/policy.js';
import { AUTONOMY_SWITCH_RANK, type AutonomySwitch } from '../src/core/authority/types.js';
import { withTempHome } from './helpers/authority-310b.js';

let restore: () => void;

const leases: ExecutionLease[] = [];

beforeEach(() => {
  restore = withTempHome('bu1-clamp-').restore;
  resetLedgerCachesForTest();
  merges.calls.length = 0;
  merges.revoked = 0;
  merges.mode = 'ok';
});

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  resetLedgerCachesForTest();
  restore();
});

/** A running agent's execution lease, registered exactly as a producer does (under the fence). */
function runningAgent(opts: { exitsOnAbort: boolean }): ExecutionLease {
  const fence = acquireOutwardMutationFence(2_000);
  expect(ownsOutwardMutationFence(fence)).toBe(true);
  try {
    const registration = registerExecutionLease(fence, { runId: `agent-${leases.length}`, repoKey: '/repo/a', engine: 'local' });
    if (!registration.ok) throw new Error(registration.reason);
    const lease = registration.lease;
    leases.push(lease);
    // A cooperative agent releases its lease when Stop aborts it; a stuck one never does.
    if (opts.exitsOnAbort) lease.signal.addEventListener('abort', () => setTimeout(() => lease.release(), 20), { once: true });
    return lease;
  } finally {
    releaseOutwardMutationFence(fence);
  }
}

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function breakLedger(): void {
  expect(appendLedger({ kind: 'note', actor: 'daemon', grantId: null, repo: null, data: { topic: 't', detail: 'x' } }).ok).toBe(true);
  const text = readFileSync(ledgerPath(), 'utf8');
  writeFileSync(ledgerPath(), text.replace('"detail":"x"', '"detail":"y"'), { mode: 0o600 });
  resetLedgerCachesForTest();
  expect(ledgerSnapshot('full').chain).toBe('broken');
}

describe('the switch', () => {
  it('reads Off by default and Off from an unreadable file', () => {
    expect(readClamp()).toMatchObject({ state: 'default', clamp: { switch: 'off' } });
    ensureAuthorityDir();
    writeFileSync(clampPath(), '{"v":1,"switch":"turbo"}\n', { mode: 0o600 });
    expect(readClamp()).toMatchObject({ state: 'invalid', clamp: { switch: 'off' } });
    writeFileSync(clampPath(), 'not json', { mode: 0o600 });
    expect(readClamp().clamp.switch).toBe('off');
  });

  it('raising past the cap is grant-required and writes nothing', () => {
    const result = setAutonomySwitch({ to: 'autonomous', actor: 'mason', reason: 't', cap: 'propose' });
    expect(result).toMatchObject({ ok: false, code: 'grant-required', from: 'off', cap: 'propose' });
    expect(existsSync(clampPath())).toBe(false);
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('raising within the cap is ledgered first; with a broken ledger it is refused', async () => {
    expect(setAutonomySwitch({ to: 'propose', actor: 'mason', reason: 'first', cap: 'autonomous' })).toMatchObject({ ok: true, changed: true, ledgered: true });
    const rows = (await readLedger({ kinds: ['switch:changed'] })).entries;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ from: 'off', to: 'propose' });
    breakLedger();
    const refused = setAutonomySwitch({ to: 'autonomous', actor: 'mason', reason: 'x', cap: 'autonomous' });
    expect(refused).toMatchObject({ ok: false, code: 'ledger' });
    expect(readClamp().clamp.switch).toBe('propose');
  });

  it('lowering needs no cap and works even when the ledger is broken', () => {
    expect(setAutonomySwitch({ to: 'autonomous', actor: 'mason', reason: 'up', cap: 'autonomous' }).ok).toBe(true);
    breakLedger();
    const lowered = setAutonomySwitch({ to: 'off', actor: 'leader', reason: 'down', cap: 'off' });
    expect(lowered).toMatchObject({ ok: true, from: 'autonomous', to: 'off', changed: true, ledgered: false });
    expect(readClamp().clamp).toMatchObject({ switch: 'off', updatedBy: 'leader' });
  });

  it('is monotonic under any sequence of requests: never above the cap unless the cap allowed it', () => {
    const switches: AutonomySwitch[] = ['off', 'propose', 'autonomous'];
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 16807) % 2147483647;
      return seed % n;
    };
    for (let i = 0; i < 60; i += 1) {
      const before = readClamp().clamp.switch;
      const to = switches[rand(3)]!;
      const cap = switches[rand(3)]!;
      const result = setAutonomySwitch({ to, actor: 'mason', reason: `step ${i}`, cap });
      const after = readClamp().clamp.switch;
      if (AUTONOMY_SWITCH_RANK[to] <= AUTONOMY_SWITCH_RANK[before]) {
        expect(result.ok).toBe(true);
        expect(after).toBe(to);
      } else if (AUTONOMY_SWITCH_RANK[to] > AUTONOMY_SWITCH_RANK[cap]) {
        expect(result.ok).toBe(false);
        expect(after).toBe(before);
      } else {
        expect(after).toBe(to);
      }
      expect(AUTONOMY_SWITCH_RANK[after] <= Math.max(AUTONOMY_SWITCH_RANK[before], AUTONOMY_SWITCH_RANK[cap])).toBe(true);
    }
  });
});

describe('Stop and Revoke', () => {
  it('Stop arms KILL and is ledgered; clear-stop is ledgered first', async () => {
    const stopped = stopAutonomy({ actor: 'mason', reason: 'test', waitMs: 0 });
    expect(stopped).toMatchObject({ ok: true, armed: true, ledgered: true });
    expect(killSwitchOn()).toBe(true);
    expect(existsSync(killSwitchPath())).toBe(true);
    const cleared = clearStop({ actor: 'mason', reason: 'test', waitMs: 2_000 });
    expect(cleared.ok).toBe(true);
    expect(killSwitchOn()).toBe(false);
    const kinds = (await readLedger()).entries.map((e) => e.kind);
    expect(kinds).toEqual(['ledger:genesis', 'kill:on', 'kill:off']);
  });

  it('Stop works with a broken ledger; clearing it does not', () => {
    breakLedger();
    expect(stopAutonomy({ actor: 'mason', reason: 'test', waitMs: 0 })).toMatchObject({ armed: true, ledgered: false });
    expect(killSwitchOn()).toBe(true);
    expect(clearStop({ actor: 'mason', reason: 'test', waitMs: 2_000 }).ok).toBe(false);
    expect(killSwitchOn()).toBe(true);
  });

  it('Revoke with no grant installed still raises the floor and switches off', async () => {
    expect(setAutonomySwitch({ to: 'propose', actor: 'mason', reason: 'up', cap: 'autonomous' }).ok).toBe(true);
    const revoked = revokeStanding({ actor: 'mason', reason: 'Owner revoked: token=abcd1234secret' });
    expect(revoked).toMatchObject({ ok: true, grantId: null, minGrantSeq: 1, archivedAs: null, ledgered: true });
    expect(readClamp().clamp.switch).toBe('off');
    const row = (await readLedger({ kinds: ['grant:revoked'] })).entries[0]!;
    expect(row.data).toMatchObject({ grantId: null, minGrantSeq: 1 });
    expect(ledgerSnapshot().index.minGrantSeq).toBe(1);
    expect(existsSync(join(ledgerPath(), '..', 'grant.json'))).toBe(false);
  });
});

describe('Stop and Revoke halt running agents and cancel armed merges (3.10 integration: U3 + U6)', () => {
  it('instant Stop aborts a running agent, reports it still live, and starts the merge revocation', async () => {
    const agent = runningAgent({ exitsOnAbort: false });
    const stopped = stopAutonomy({ actor: 'mason', reason: 'Stop pressed', waitMs: 0 });
    expect(stopped).toMatchObject({ armed: true, quiesced: false, liveExecutionLeases: 1, drainWaitedMs: 0, mergesRevoked: null });
    expect(agent.signal.aborted).toBe(true);
    await tick();
    expect(merges.calls).toEqual(['Stop pressed']);
  });

  it('draining Stop waits for a cooperative agent, then reports quiet and the merges it cancelled', async () => {
    const agent = runningAgent({ exitsOnAbort: true });
    merges.revoked = 3;
    const stopped = await stopAutonomyAndDrain({ actor: 'mason', reason: 'cli stop', drainMs: 5_000 });
    expect(agent.signal.aborted).toBe(true);
    expect(agent.isHeld()).toBe(false);
    expect(stopped).toMatchObject({ ok: true, armed: true, quiesced: true, liveExecutionLeases: 0, mergesRevoked: 3, mergeRevokeFailures: [], ledgered: true });
    expect(merges.calls).toEqual(['cli stop']);
    expect((await readLedger({ kinds: ['kill:on'] })).entries).toHaveLength(1);
  });

  it('draining Stop gives up on a stuck agent after drainMs and says so (KILL stays armed)', async () => {
    runningAgent({ exitsOnAbort: false });
    const stopped = await stopAutonomyAndDrain({ actor: 'mason', reason: 'stuck', drainMs: 300 });
    expect(stopped).toMatchObject({ armed: true, quiesced: false, liveExecutionLeases: 1 });
    expect(stopped.drainWaitedMs).toBeGreaterThanOrEqual(250);
    expect(killSwitchOn()).toBe(true);
  });

  it('a broken merge module never fails Stop — the failure is reported and KILL still holds', async () => {
    merges.mode = 'throw';
    expect(await revokeArmedMerges('x')).toEqual({ revoked: 0, failed: [expect.stringMatching(/host-merge exploded/)] });
    const stopped = await stopAutonomyAndDrain({ actor: 'mason', reason: 'x', drainMs: 100 });
    expect(stopped).toMatchObject({ ok: true, armed: true, mergesRevoked: 0 });
    expect(stopped.mergeRevokeFailures).toHaveLength(1);
    // The instant variant swallows it entirely.
    expect(() => stopAutonomy({ actor: 'mason', reason: 'x', waitMs: 0 })).not.toThrow();
    await tick();
  });

  it('the deferred revocation never writes into a different HOME than the one Stop was pressed for', async () => {
    stopAutonomy({ actor: 'mason', reason: 'home-a', waitMs: 0 });
    // Swap HOME before the deferred revocation gets to run (a test restoring its HOME, a re-targeted process).
    restore();
    restore = withTempHome('bu1-clamp-other-').restore;
    await tick();
    expect(merges.calls).toEqual([]);
  });

  it('Revoke engages Stop, aborts running agents and cancels armed merges', async () => {
    const agent = runningAgent({ exitsOnAbort: true });
    expect(setAutonomySwitch({ to: 'propose', actor: 'mason', reason: 'up', cap: 'autonomous' }).ok).toBe(true);
    const revoked = await revokeStandingAndDrain({ actor: 'mason', reason: 'done for today', drainMs: 5_000 });
    expect(revoked).toMatchObject({ ok: true, stopped: true, liveExecutionLeases: 0, mergesRevoked: 0, minGrantSeq: 1 });
    expect(revoked.reason).toMatch(/then clearing Stop/);
    expect(agent.signal.aborted).toBe(true);
    expect(killSwitchOn()).toBe(true);
    expect(readClamp().clamp.switch).toBe('off');
    expect(merges.calls).toEqual(['revoked: done for today']);
    const kinds = (await readLedger()).entries.map((e) => e.kind);
    expect(kinds).toEqual(['ledger:genesis', 'switch:changed', 'grant:revoked', 'kill:on']);
  });

  it('instant Revoke also engages Stop', async () => {
    const revoked = revokeStanding({ actor: 'mason', reason: 'now' });
    expect(revoked).toMatchObject({ ok: true, stopped: true, mergesRevoked: null });
    expect(killSwitchOn()).toBe(true);
    await tick();
    expect(merges.calls).toEqual(['revoked: now']);
  });
});
