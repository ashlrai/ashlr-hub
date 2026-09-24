/**
 * V3.10 Track B unit B-U1 — the rollout ladder (SPEC-310B addendum §1).
 *
 * The daemon advances one stage when every criterion is met (from ledger rows
 * written while the stage was current), regresses one stage on a breach, never
 * climbs past the last signed stage, and a breach on the first rung restarts
 * its evidence window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

import { appendLedger, ledgerSnapshot, resetLedgerCachesForTest, withLedgerTransaction, type LedgerEvidenceRow } from '../src/core/authority/ledger.js';
import { evaluateRollout, rolloutPositionFor, stepRolloutUnderLock, type RolloutPositionInternal } from '../src/core/authority/rollout.js';
import { makeGrant, withTempHome } from './helpers/authority-310b.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const grant = makeGrant({}, NOW);

const at = (h: number): string => new Date(NOW - h * HOUR).toISOString();
let seq = 100;
const row = (kind: LedgerEvidenceRow['kind'], extra: Partial<LedgerEvidenceRow> = {}): LedgerEvidenceRow =>
  ({ seq: (seq += 1), at: at(1), kind, repo: 'ashlrai/ashlrcode', landingId: null, verdict: null, ...extra });

function position(stageIndex: number, entrySeq = 100, enteredHoursAgo = 30): RolloutPositionInternal {
  return { stageIndex, stageId: grant.rollout.stages[stageIndex]!.id, enteredAt: at(enteredHoursAgo), entrySeq };
}

describe('evaluateRollout (pure)', () => {
  it('shadow counts complete would-merge digests and advances when every criterion is met', () => {
    const evidence = [row('gate:would-merge'), row('gate:would-merge')];
    const ev = evaluateRollout({ grant, position: position(0), evidence, nowMs: NOW });
    expect(ev.progress).toMatchObject({ stageId: 'shadow', merges: 2, met: true, nextStageId: '2a', unmet: [] });
    expect(ev.decision).toBe('advance');
  });

  it('holds with specific unmet sentences', () => {
    const ev = evaluateRollout({ grant, position: position(0), evidence: [row('gate:would-merge')], nowMs: NOW });
    expect(ev.decision).toBe('hold');
    expect(ev.progress.unmet).toEqual(['1 of 2 would-merge digests']);
  });

  it('a merge stage ignores would-merges, waits for post-merge watches, and needs the green share', () => {
    const merged = [row('merge:landed', { landingId: 'L1' }), row('merge:landed', { landingId: 'L2' }), row('gate:would-merge')];
    const pending = evaluateRollout({ grant, position: position(1), evidence: merged, nowMs: NOW });
    expect(pending.progress.merges).toBe(2);
    expect(pending.pendingWatches).toBe(2);
    expect(pending.progress.unmet).toContain('no post-merge watch has finished yet');
    expect(pending.progress.unmet).toContain('2 post-merge watches still running');
    expect(pending.decision).toBe('hold');

    const oneRed = [...merged, row('post-merge:result', { landingId: 'L1', verdict: 'green' }), row('post-merge:result', { landingId: 'L2', verdict: 'red' })];
    const red = evaluateRollout({ grant, position: position(1), evidence: oneRed, nowMs: NOW });
    expect(red.progress.postMergeGreenPct).toBe(50);
    expect(red.decision).toBe('hold');

    const green = [...merged, row('post-merge:result', { landingId: 'L1', verdict: 'green' }), row('post-merge:result', { landingId: 'L2', verdict: 'green' })];
    expect(evaluateRollout({ grant, position: position(1), evidence: green, nowMs: NOW }).decision).toBe('advance');
  });

  it('only rows after the stage entry count', () => {
    const before = [{ ...row('gate:would-merge'), seq: 50 }, { ...row('gate:would-merge'), seq: 60 }];
    expect(evaluateRollout({ grant, position: position(0), evidence: before, nowMs: NOW }).progress.merges).toBe(0);
  });

  it('minimum hours hold the stage', () => {
    const slow = editHours(0, 12);
    const ev = evaluateRollout({ grant: slow, position: { ...position(0, 100, 5), stageId: 'shadow' }, evidence: [row('gate:would-merge'), row('gate:would-merge')], nowMs: NOW });
    expect(ev.decision).toBe('hold');
    expect(ev.progress.unmet).toEqual(['5 h of 12 h']);
  });

  it('regresses one stage on a sandbox violation, a reserve breach or a revert rate over the limit', () => {
    const violation = evaluateRollout({ grant, position: position(1), evidence: [row('sandbox:violation')], nowMs: NOW });
    expect(violation.decision).toBe('regress');
    expect(violation.breach).toMatch(/sandbox violation/);
    expect(evaluateRollout({ grant, position: position(1), evidence: [row('reserve:breach')], nowMs: NOW }).decision).toBe('regress');
    const reverts = [row('merge:landed', { landingId: 'A' }), row('merge:landed', { landingId: 'B' }), row('revert:landed', { landingId: 'R' })];
    const rate = evaluateRollout({ grant, position: position(1), evidence: reverts, nowMs: NOW });
    expect(rate.progress.revertRatePct).toBe(50);
    expect(rate.decision).toBe('regress');
    // A revert with no merges in the stage is a 100% revert rate, not "unknown".
    expect(evaluateRollout({ grant, position: position(1), evidence: [row('revert:landed')], nowMs: NOW }).progress.revertRatePct).toBe(100);
  });

  it('never advances past the last signed stage', () => {
    const last = grant.rollout.stages.length - 1;
    const plenty = Array.from({ length: 10 }, (_, i) => row('merge:landed', { landingId: `M${i}` }))
      .concat(Array.from({ length: 10 }, (_, i) => row('post-merge:result', { landingId: `M${i}`, verdict: 'green' })));
    const ev = evaluateRollout({ grant, position: position(last), evidence: plenty, nowMs: NOW });
    expect(ev.progress.met).toBe(true);
    expect(ev.progress.nextStageId).toBeNull();
    expect(ev.decision).toBe('hold');
  });
});

function editHours(stage: number, hours: number) {
  const copy = structuredClone(grant);
  copy.rollout.stages[stage]!.criteria.minHours = hours;
  return copy;
}

describe('stepRolloutUnderLock (ledger)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withTempHome('bu1-rollout-').restore;
    resetLedgerCachesForTest();
  });
  afterEach(() => {
    resetLedgerCachesForTest();
    restore();
  });

  function accept(): void {
    const ok = appendLedger({
      kind: 'grant:accepted',
      actor: 'mason',
      grantId: grant.grantId,
      repo: null,
      data: {
        grantId: grant.grantId,
        grantSeq: grant.grantSeq,
        keyId: grant.keyId,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        authoritySurfaceDigest: grant.authoritySurfaceDigest,
        stageIds: grant.rollout.stages.map((s) => s.id),
        envelopeDigest: 'e'.repeat(64),
      },
    });
    expect(ok.ok).toBe(true);
  }

  function wouldMerge(): void {
    expect(appendLedger({
      kind: 'gate:would-merge',
      actor: 'daemon',
      grantId: grant.grantId,
      repo: 'ashlrai/ashlrcode',
      data: { v: 1, proposalId: 'p', repo: 'ashlrai/ashlrcode', headSha: 'f'.repeat(40), gatesDigest: 'd'.repeat(64), withheldBecause: 'shadow', risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0, at: new Date().toISOString() },
    }).ok).toBe(true);
  }

  const step = () => {
    const result = withLedgerTransaction((tx) => stepRolloutUnderLock(tx, grant, Date.now()));
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  };

  it('starts at the first rung, advances once when criteria are met, and records it', () => {
    accept();
    expect(rolloutPositionFor(grant, ledgerSnapshot().index)).toMatchObject({ stageIndex: 0, stageId: 'shadow' });
    expect(step()?.decision).toBe('hold');
    wouldMerge();
    wouldMerge();
    const moved = step();
    expect(moved).toMatchObject({ decision: 'advance', fromStageId: 'shadow', toStageId: '2a' });
    const position2 = rolloutPositionFor(grant, ledgerSnapshot().index);
    expect(position2).toMatchObject({ stageIndex: 1, stageId: '2a' });
    // The would-merges from shadow do not count in 2a: the next step holds.
    expect(step()?.decision).toBe('hold');
  });

  it('a breach on the first rung re-enters it (the evidence window restarts)', () => {
    accept();
    expect(appendLedger({
      kind: 'reserve:breach',
      actor: 'daemon',
      grantId: grant.grantId,
      repo: null,
      data: { v: 1, seatId: 'claude', window: 'session', usedPercent: 75, limitPercent: 70, at: new Date().toISOString() },
    }).ok).toBe(true);
    expect(step()).toMatchObject({ decision: 'regress', fromStageId: 'shadow', toStageId: 'shadow' });
    // The breach row predates the new entry: the stage is clean again.
    expect(step()?.decision).toBe('hold');
  });

  it('a grant that was never accepted has no position (fail closed)', () => {
    expect(step()).toBeNull();
  });
});
