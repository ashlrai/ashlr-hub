/**
 * 3.10 review fixes owned by F2-authority:
 *   c3 / c4 — reserve breaches are DETECTED and ledgered (reserve-breach.ts),
 *             and the rollout regresses on them end to end through the real
 *             standing tick (capability.ts), not only when a test hand-writes
 *             the row;
 *   c6      — a revert is charged to the stage of the merge it reverts; a
 *             stage waits (bounded) for a red merge's revert to settle; a
 *             zero-merge stage reads neither 100% green nor 100% reverts.
 *
 * Real ledger, real capacity snapshot and routing log, temporary HOME. Only
 * the trust root, host / surface / confinement probes and the host-merge
 * module are faked (exactly as authority-capability-310b does).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ surface: 'b'.repeat(64) as string | null }));

vi.mock('../src/core/authority/trust-roots.js', async () => {
  const helpers = await import('./helpers/authority-310b.js');
  return { STANDING_GRANT_TRUST_ROOTS: Object.freeze([helpers.TEST_ROOT]), BURNED_KEY_IDS: Object.freeze(['mason-workstation']) };
});

vi.mock('../src/core/authority/surface.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/authority/surface.js')>();
  return {
    ...original,
    currentHostBinding: () => 'a'.repeat(64),
    confinementAvailable: () => ({ ok: true }),
    runningPackageRoot: () => '/test/release',
    verifyAuthoritySurface: (target: 'running' | 'installed') => ({
      ok: true, target, packageRoot: '/test/release', digest: probe.surface, fileCount: 1, checkedAt: new Date().toISOString(),
    }),
  };
});

vi.mock('../src/core/fleet/host-merge.js', () => ({
  revokeArmedHostMerges: () => ({ revoked: 0, failed: [] }),
}));

import { mintStandingTickCapability, openStandingSession } from '../src/core/authority/capability.js';
import { invalidateStandingPolicyCache, requestAutonomySwitch } from '../src/core/authority/effective-config.js';
import { appendLedger, ledgerSnapshot, readLedger, resetLedgerCachesForTest, type LedgerEvidenceRow } from '../src/core/authority/ledger.js';
import {
  ATTRIBUTION_LOOKBACK_MS,
  detectReserveBreaches,
  recordReserveBreaches,
  reserveWatchPath,
} from '../src/core/authority/reserve-breach.js';
import { REVERT_SETTLE_MS, evaluateRollout, type RolloutPositionInternal } from '../src/core/authority/rollout.js';
import { installStandingGrant } from '../src/core/authority/standing-grant.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import { readCapacitySnapshot, recordShadowDecision, writeCapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { AshlrConfig } from '../src/core/types.js';
import { makeGrant, signGrant, withTempHome } from './helpers/authority-310b.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** The balanced default: Claude keeps 40% of its week for Mason and stays off above 70% of its 5 h window. */
const POLICY: Pick<EffectivePolicy, 'spend'> = {
  spend: {
    maxMode: 'balanced',
    meteredUsdPerDay: 0,
    seats: {
      claude: { seatId: 'claude', enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] },
      grok: { seatId: 'grok', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer'] },
      codex: { seatId: 'codex', enabled: false, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['producer'] },
      local: { seatId: 'local', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer'] },
    },
  },
};

function claude(weekly: number | null, session: number | null, observedAt: string, extra: Partial<SeatCapacity> = {}): SeatCapacity {
  return {
    seatId: 'claude',
    engine: 'claude',
    label: 'Claude',
    free: false,
    windows: [
      { id: 'five_hour', usedPercent: session, resetsAt: null, resetDescription: '5pm', limitReached: false },
      { id: 'seven_day', usedPercent: weekly, resetsAt: null, resetDescription: 'Sat 10:27 AM', limitReached: false },
      // A spent per-model window never binds (headroom.ts): it must never read as a breach.
      { id: 'seven_day_fable', usedPercent: 100, resetsAt: null, resetDescription: null, limitReached: true },
    ],
    signedOut: false,
    reachable: null,
    contextWindow: null,
    observedAt,
    spentTodayUsd: null,
    ...extra,
  };
}

describe('detectReserveBreaches (pure)', () => {
  const NOW = Date.parse('2026-09-24T12:00:00.000Z');
  const at = new Date(NOW - MIN).toISOString();
  const used = (seats: string[]) => (seatId: string) => seats.includes(seatId);

  it('an autonomy-used seat crossing its weekly reserve line is one breach, with the signed line', () => {
    const d = detectReserveBreaches({
      seats: [claude(72, 20, at)], policy: POLICY, nowMs: NOW, state: { 'claude|weekly': { over: false, at: new Date(NOW - 10 * MIN).toISOString(), recorded: false } },
      priorBreaches: [], autonomyUsed: used(['claude']),
    });
    expect(d.breaches).toEqual([{ v: 1, seatId: 'claude', window: 'weekly', usedPercent: 72, limitPercent: 60, at }]);
    expect(d.state['claude|weekly']).toEqual({ over: true, at, recorded: true });
    expect(d.state['claude|session']).toEqual({ over: false, at, recorded: false });
  });

  it('the 5-hour ceiling is its own line', () => {
    const d = detectReserveBreaches({ seats: [claude(30, 78, at)], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: used(['claude']) });
    expect(d.breaches).toMatchObject([{ seatId: 'claude', window: 'session', usedPercent: 78, limitPercent: 70 }]);
  });

  it("Mason's own crossing (autonomy never used the seat) is NOT an autonomy breach", () => {
    const d = detectReserveBreaches({ seats: [claude(72, 85, at)], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: used([]) });
    expect(d.breaches).toEqual([]);
    expect(d.state['claude|weekly']).toEqual({ over: true, at, recorded: false });
  });

  it('an uncharged episode is re-checked: a dispatch path naming the seat later still records it, once', () => {
    const mason = detectReserveBreaches({ seats: [claude(72, 20, at)], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: used([]) });
    expect(mason.breaches).toEqual([]);
    const later = detectReserveBreaches({ seats: [claude(72, 20, at)], policy: POLICY, nowMs: NOW, state: mason.state, priorBreaches: [], autonomyUsed: used(['claude']) });
    expect(later.breaches).toHaveLength(1);
    expect(detectReserveBreaches({ seats: [claude(73, 20, at)], policy: POLICY, nowMs: NOW, state: later.state, priorBreaches: [], autonomyUsed: used(['claude']) }).breaches).toEqual([]);
  });

  it('attribution looks back ATTRIBUTION_LOOKBACK_MS from the reading', () => {
    const since: number[] = [];
    detectReserveBreaches({ seats: [claude(72, 20, at)], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: (_s, sinceMs) => { since.push(sinceMs); return false; } });
    expect(since).toEqual([Date.parse(at) - ATTRIBUTION_LOOKBACK_MS]);
  });

  it('unknown is not a breach: stale, future-dated, null or signed-less readings prove nothing', () => {
    const stale = new Date(NOW - 16 * MIN).toISOString();
    const future = new Date(NOW + 30 * MIN).toISOString();
    for (const seat of [claude(90, 90, stale), claude(90, 90, future), claude(null, null, at), { ...claude(90, 90, at), observedAt: null }]) {
      expect(detectReserveBreaches({ seats: [seat], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: used(['claude']) }).breaches).toEqual([]);
    }
  });

  it('exactly at the line is not past it; a flagged limit is 100%', () => {
    expect(detectReserveBreaches({ seats: [claude(60, 70, at)], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: used(['claude']) }).breaches).toEqual([]);
    const flagged = claude(null, 10, at);
    flagged.windows[1] = { ...flagged.windows[1]!, limitReached: true };
    expect(detectReserveBreaches({ seats: [flagged], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: used(['claude']) }).breaches)
      .toMatchObject([{ window: 'weekly', usedPercent: 100 }]);
  });

  it('seats autonomy may not use, free local seats and a 0% reserve have no line to breach', () => {
    const codex: SeatCapacity = { ...claude(95, 95, at), seatId: 'codex', engine: 'codex', windows: [{ id: 'codex_a_secondary', usedPercent: 95, resetsAt: null, resetDescription: null, limitReached: false }] };
    const grok: SeatCapacity = { ...claude(100, null, at), seatId: 'grok', engine: 'grok', windows: [{ id: 'grok_monthly', usedPercent: 100, resetsAt: null, resetDescription: null, limitReached: false }] };
    const local: SeatCapacity = { ...claude(null, null, at), seatId: 'local', engine: 'local', free: true, windows: [] };
    const unlisted: SeatCapacity = { ...claude(95, 95, at), seatId: 'claude-b' };
    expect(detectReserveBreaches({ seats: [codex, grok, local, unlisted], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: () => true }).breaches).toEqual([]);
  });

  it('one row per episode: a seat that stays over is not re-recorded; back under the line re-arms it', () => {
    const first = detectReserveBreaches({ seats: [claude(72, 20, at)], policy: POLICY, nowMs: NOW, state: {}, priorBreaches: [], autonomyUsed: used(['claude']) });
    expect(first.breaches).toHaveLength(1);
    const later = new Date(NOW + 5 * MIN).toISOString();
    const again = detectReserveBreaches({ seats: [claude(75, 20, later)], policy: POLICY, nowMs: NOW + 6 * MIN, state: first.state, priorBreaches: [], autonomyUsed: used(['claude']) });
    expect(again.breaches).toEqual([]);
    const reset = new Date(NOW + 10 * MIN).toISOString();
    const under = detectReserveBreaches({ seats: [claude(5, 20, reset)], policy: POLICY, nowMs: NOW + 11 * MIN, state: again.state, priorBreaches: [], autonomyUsed: used(['claude']) });
    expect(under.state['claude|weekly']?.over).toBe(false);
    const cross = new Date(NOW + 20 * MIN).toISOString();
    expect(detectReserveBreaches({ seats: [claude(61, 20, cross)], policy: POLICY, nowMs: NOW + 21 * MIN, state: under.state, priorBreaches: [], autonomyUsed: used(['claude']) }).breaches).toHaveLength(1);
  });

  it('a lost watch file falls back to the ledger: a breach already on record for this window is not counted twice', () => {
    const prior: Pick<LedgerEvidenceRow, 'at' | 'seatId' | 'window'>[] = [{ at: new Date(NOW - 2 * HOUR).toISOString(), seatId: 'claude', window: 'weekly' }];
    expect(detectReserveBreaches({ seats: [claude(72, 20, at)], policy: POLICY, nowMs: NOW, state: null, priorBreaches: prior, autonomyUsed: used(['claude']) }).breaches).toEqual([]);
    // A session breach 6 h ago is a different 5-hour window.
    const oldSession: Pick<LedgerEvidenceRow, 'at' | 'seatId' | 'window'>[] = [{ at: new Date(NOW - 6 * HOUR).toISOString(), seatId: 'claude', window: 'session' }];
    expect(detectReserveBreaches({ seats: [claude(10, 80, at)], policy: POLICY, nowMs: NOW, state: null, priorBreaches: oldSession, autonomyUsed: used(['claude']) }).breaches).toHaveLength(1);
  });

  it('an older snapshot never rewinds the watch', () => {
    const state = { 'claude|weekly': { over: true, at: new Date(NOW).toISOString(), recorded: true } };
    const d = detectReserveBreaches({ seats: [claude(10, 10, at)], policy: POLICY, nowMs: NOW, state, priorBreaches: [], autonomyUsed: used(['claude']) });
    expect(d.state['claude|weekly']).toEqual(state['claude|weekly']);
  });
});

describe('reserve breaches end to end (real ledger, real standing tick)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withTempHome('f2-reserve-').restore;
    probe.surface = 'b'.repeat(64);
    resetLedgerCachesForTest();
    invalidateStandingPolicyCache();
  });
  afterEach(() => {
    resetLedgerCachesForTest();
    invalidateStandingPolicyCache();
    restore();
  });

  const cfg = {} as AshlrConfig;
  const grant = makeGrant();

  function liveAt2a() {
    const installed = installStandingGrant(signGrant(grant), { surface: 'running' });
    if (!installed.ok) throw new Error(installed.reason);
    const switched = requestAutonomySwitch('autonomous', 'mason', 'test');
    if (!switched.ok) throw new Error(switched.reason);
    for (let i = 0; i < 2; i += 1) {
      expect(appendLedger({
        kind: 'gate:would-merge', actor: 'daemon', grantId: grant.grantId, repo: 'ashlrai/ashlrcode',
        data: { v: 1, proposalId: `p${i}`, repo: 'ashlrai/ashlrcode', headSha: 'f'.repeat(40), gatesDigest: 'd'.repeat(64), withheldBecause: 'shadow', risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0, at: new Date().toISOString() },
      }).ok).toBe(true);
    }
    const opened = openStandingSession(cfg);
    if (!opened.ok) throw new Error(opened.reason);
    const advanced = mintStandingTickCapability(opened.session);
    if (!advanced.ok) throw new Error(advanced.reason);
    expect(advanced.policy.rollout.stageId).toBe('2a');
    return opened.session;
  }

  function routedToClaude(): void {
    expect(recordShadowDecision({
      source: 'daemon',
      request: { task: 'review', difficulty: 'low', autonomous: true },
      decision: { seatId: 'claude', candidates: ['claude'], exclusions: [], why: 'judge', mode: 'balanced' },
      actual: { engine: 'claude-cli', seatId: 'claude' },
    })).toBe(true);
  }

  it('autonomy overshooting Claude’s weekly reserve writes a reserve:breach row and the SAME tick regresses the ladder', async () => {
    const session = liveAt2a();
    // Under the line: arms the watch, nothing recorded.
    writeCapacitySnapshot([claude(55, 30, new Date().toISOString())]);
    expect(mintStandingTickCapability(session)).toMatchObject({ ok: true, policy: { rollout: { stageId: '2a' } } });
    routedToClaude();
    writeCapacitySnapshot([claude(72, 30, new Date().toISOString())]);
    const tick = mintStandingTickCapability(session);
    expect(tick.ok).toBe(true);
    if (tick.ok) expect(tick.policy.rollout.stageId).toBe('shadow');

    const breaches = (await readLedger({ kinds: ['reserve:breach'] })).entries;
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ actor: 'daemon', grantId: grant.grantId, data: { v: 1, seatId: 'claude', window: 'weekly', usedPercent: 72, limitPercent: 60 } });
    const regressed = (await readLedger({ kinds: ['rollout:regressed'] })).entries;
    expect(regressed).toHaveLength(1);
    expect(regressed[0]!.data).toMatchObject({ fromStageId: '2a', toStageId: 'shadow', breach: '1 reserve breach in stage 2a' });

    // Same episode, next tick: no second row, no second regression.
    expect(mintStandingTickCapability(session).ok).toBe(true);
    expect((await readLedger({ kinds: ['reserve:breach'] })).entries).toHaveLength(1);
    expect((await readLedger({ kinds: ['rollout:regressed'] })).entries).toHaveLength(1);
    // The watch file is private.
    expect(JSON.parse(readFileSync(reserveWatchPath(), 'utf8')).seats['claude|weekly']).toMatchObject({ over: true, recorded: true });
  });

  it('Mason crossing the line himself (no autonomous routing to Claude) does not move the ladder', async () => {
    const session = liveAt2a();
    writeCapacitySnapshot([claude(55, 30, new Date().toISOString())]);
    mintStandingTickCapability(session);
    writeCapacitySnapshot([claude(72, 85, new Date().toISOString())]);
    const tick = mintStandingTickCapability(session);
    if (tick.ok) expect(tick.policy.rollout.stageId).toBe('2a');
    expect((await readLedger({ kinds: ['reserve:breach'] })).entries).toHaveLength(0);
  });

  it('recordReserveBreaches: the API a dispatch path calls with the seats it just used', async () => {
    liveAt2a();
    writeCapacitySnapshot([claude(20, 76, new Date().toISOString())]);
    const policy = { ...POLICY, grantId: grant.grantId } as EffectivePolicy;
    expect(await recordReserveBreaches({ capacity: readCapacitySnapshot(), policy, usedSeatIds: ['claude'] })).toBe(1);
    expect(await recordReserveBreaches({ capacity: readCapacitySnapshot(), policy, usedSeatIds: ['claude'] })).toBe(0);
    const evidence = ledgerSnapshot('full').index.evidence.filter((row) => row.kind === 'reserve:breach');
    expect(evidence).toMatchObject([{ seatId: 'claude', window: 'session' }]);
    // Garbage capacity is no evidence, never a throw.
    expect(await recordReserveBreaches({ capacity: { seats: [{ seatId: 'claude', free: true }] }, policy })).toBe(0);
    expect(await recordReserveBreaches({ capacity: 'nope', policy })).toBe(0);
  });

  it('every evidence kind the rollout counts has a production writer (no dead criterion)', () => {
    const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');
    // The ledger index lists the kinds; each needs a `kind: '<kind>'` append outside the authority plumbing.
    const writers: Record<string, string> = {
      'merge:landed': 'core/fleet/standing-merge-pass.ts',
      'gate:would-merge': 'core/fleet/standing-merge-pass.ts',
      'post-merge:result': 'core/fleet/post-merge-watch.ts',
      'revert:landed': 'core/fleet/post-merge-watch.ts',
      'revert:failed': 'core/fleet/post-merge-watch.ts',
      'sandbox:violation': 'core/sandbox/autonomous-run.ts',
      'reserve:breach': 'core/authority/reserve-breach.ts',
      // d0: written by the rollout's own helper, called from both producers below.
      'sandbox:evidence-unknown': 'core/authority/rollout.ts',
    };
    const kinds = [...src('core/authority/ledger.ts').matchAll(/^ {2}'([a-z-]+:[a-z-]+)',$/gm)].map((m) => m[1]!);
    expect(new Set(kinds)).toEqual(new Set(Object.keys(writers)));
    for (const [kind, file] of Object.entries(writers)) expect(src(file), `${kind} writer`).toContain(`kind: '${kind}'`);
    for (const producer of ['core/run/sandboxed-engine.ts', 'core/fleet/manager.ts']) {
      expect(src(producer), producer).toContain('await recordSandboxEvidenceUnknown(');
    }
    // ...and the reserve detector actually runs on every standing tick.
    expect(src('core/authority/capability.ts')).toMatch(/recordReserveBreachesUnderLock\(tx,/);
  });
});

describe('c6: reverts are charged to the stage of the merge they revert', () => {
  const NOW = Date.parse('2026-09-24T12:00:00.000Z');
  const grant = makeGrant({}, NOW);
  const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * MIN).toISOString();
  let seq = 100;
  const row = (kind: LedgerEvidenceRow['kind'], extra: Partial<LedgerEvidenceRow> = {}): LedgerEvidenceRow =>
    ({ seq: (seq += 1), at: at(60), kind, repo: 'ashlrai/ashlrcode', landingId: null, verdict: null, ...extra });
  const position = (stageIndex: number, entrySeq: number): RolloutPositionInternal =>
    ({ stageIndex, stageId: grant.rollout.stages[stageIndex]!.id, enteredAt: at(30 * 60), entrySeq });

  it('the revert of an earlier stage’s merge landing after the advance is not a 100% revert rate in the new stage', () => {
    seq = 100;
    // Stage 2a (index 1): two merges, one red; the ladder advanced to `full` at seq 200.
    const m1 = row('merge:landed', { landingId: 'L1' });
    const m2 = row('merge:landed', { landingId: 'L2' });
    seq = 200;
    const revertLandsLater = row('revert:landed', { landingId: 'R2', revertsLandingId: 'L2' });
    const ev = evaluateRollout({ grant, position: position(2, 200), evidence: [m1, m2, revertLandsLater], nowMs: NOW });
    expect(ev.progress.revertRatePct).toBeNull();
    expect(ev.decision).not.toBe('regress');
    expect(ev.breach).toBeNull();
  });

  it('a revert of THIS stage’s merge counts here', () => {
    seq = 100;
    const ev = evaluateRollout({
      grant,
      position: position(1, 100),
      evidence: [row('merge:landed', { landingId: 'A' }), row('merge:landed', { landingId: 'B' }), row('revert:landed', { landingId: 'R', revertsLandingId: 'B' })],
      nowMs: NOW,
    });
    expect(ev.progress.revertRatePct).toBe(50);
    expect(ev.decision).toBe('regress');
  });

  it('a zero-merge stage reads null green and null revert rate, not 100%', () => {
    seq = 100;
    const ev = evaluateRollout({ grant, position: position(1, 100), evidence: [row('revert:landed', { landingId: 'R', revertsLandingId: 'elsewhere' })], nowMs: NOW });
    expect(ev.progress).toMatchObject({ merges: 0, postMergeGreenPct: null, revertRatePct: null });
    expect(ev.decision).toBe('hold');
  });

  it('the stage does not advance while a red merge’s revert is still landing (bounded by REVERT_SETTLE_MS)', () => {
    const tolerant = structuredClone(grant);
    tolerant.rollout.stages[1]!.criteria = { ...tolerant.rollout.stages[1]!.criteria, minMerges: 2, minPostMergeGreenPct: 50, maxRevertRatePct: 50 };
    seq = 100;
    const base = [
      row('merge:landed', { landingId: 'A' }),
      row('merge:landed', { landingId: 'B' }),
      row('post-merge:result', { landingId: 'A', verdict: 'green' }),
      row('post-merge:result', { landingId: 'B', verdict: 'red', at: at(10) }),
    ];
    const waiting = evaluateRollout({ grant: tolerant, position: position(1, 100), evidence: base, nowMs: NOW });
    expect(waiting.decision).toBe('hold');
    expect(waiting.progress.unmet).toContain('1 revert of a red merge still landing');

    // The revert lands: it is charged to this stage (50% ≤ 50%) and the stage advances.
    const reverted = evaluateRollout({ grant: tolerant, position: position(1, 100), evidence: [...base, row('revert:landed', { landingId: 'RB', revertsLandingId: 'B' })], nowMs: NOW });
    expect(reverted.progress.revertRatePct).toBe(50);
    expect(reverted.decision).toBe('advance');

    // A failed revert settles it too.
    expect(evaluateRollout({ grant: tolerant, position: position(1, 100), evidence: [...base, row('revert:failed', { landingId: 'B' })], nowMs: NOW }).decision).toBe('advance');

    // An inherited red is never reverted: after REVERT_SETTLE_MS the stage stops waiting.
    expect(evaluateRollout({ grant: tolerant, position: position(1, 100), evidence: base, nowMs: NOW + REVERT_SETTLE_MS }).decision).toBe('advance');
  });

  it('the ledger index carries revertsLandingId and revert:failed rows', async () => {
    const { restore } = withTempHome('f2-revert-index-');
    resetLedgerCachesForTest();
    try {
      const landing = (id: string, kind: 'merge' | 'revert', reverts: string | null) => ({
        v: 1 as const, id, kind, repo: 'ashlrai/ashlrcode', baseBranch: 'main', prNumber: 1, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40),
        proposalId: kind === 'merge' ? 'p1' : null, revertsLandingId: reverts, grantId: grant.grantId, rolloutStageId: '2a', gatesDigest: 'd'.repeat(64),
        ledgerHead: 'e'.repeat(64), enforcement: 'server' as const, risk: 'low' as const, files: 1, linesAdded: 1, linesDeleted: 0, producer: null, judgeId: null,
        proposedAt: null, landedAt: new Date().toISOString(), watchUntil: new Date().toISOString(),
      });
      expect(appendLedger({ kind: 'merge:landed', actor: 'daemon', grantId: grant.grantId, repo: 'ashlrai/ashlrcode', data: landing('L1', 'merge', null) as never }).ok).toBe(true);
      expect(appendLedger({ kind: 'revert:landed', actor: 'daemon', grantId: grant.grantId, repo: 'ashlrai/ashlrcode', data: landing('R1', 'revert', 'L1') as never }).ok).toBe(true);
      expect(appendLedger({ kind: 'revert:failed', actor: 'daemon', grantId: grant.grantId, repo: 'ashlrai/ashlrcode', data: { landingId: 'L9', repo: 'ashlrai/ashlrcode', reason: 'x' } }).ok).toBe(true);
      const evidence = ledgerSnapshot('full').index.evidence;
      expect(evidence.find((r) => r.kind === 'revert:landed')).toMatchObject({ landingId: 'R1', revertsLandingId: 'L1' });
      expect(evidence.find((r) => r.kind === 'revert:failed')).toMatchObject({ landingId: 'L9' });
    } finally {
      resetLedgerCachesForTest();
      restore();
    }
  });
});
