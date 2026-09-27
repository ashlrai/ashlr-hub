import { describe, expect, it } from 'vitest';
import {
  ago,
  cloudTaskFor,
  grantExpiry,
  ladderView,
  lastEvent,
  narrowDecisions,
  narrowLadder,
  prUrl,
  recentRegressions,
  sizeLine,
  stageLabel,
} from './ladder-model.js';
import { authorityStatus } from './fixtures.test-support.js';
import { decisionsView, defaultLadder, refusedDecision, shadowStatus, wouldMergeDecision } from './ladder-fixtures.test-support.js';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('ladderView', () => {
  it('draws the just-activated state: Shadow · 1 of 8, nothing merges, 0/5 digests and 0/12 h', () => {
    const view = ladderView(shadowStatus(NOW))!;
    expect(view.stageName).toBe('Shadow');
    expect(view.position).toBe('1 of 8');
    expect(view.rungs.map((r) => [r.label, r.state])).toEqual([
      ['Shadow', 'current'], ['2a', 'next'], ['2b', 'later'], ['2c', 'later'], ['3a', 'later'], ['3b', 'later'], ['3c', 'later'], ['3d', 'later'],
    ]);
    expect(view.rungs[0]!.mergeLine).toBe('Nothing merges — propose only');
    expect(view.rungs[0]!.proposeLine).toBe('Proposing: ashlrcode, fleet-canary, binshield');
    expect(view.rungs[0]!.capLine).toBe('low risk · ≤ 4 files / 150 lines');
    expect(view.rungs[0]!.exitLine).toBe('Leaves after 5 would-merge digests, 12 h');
    expect(view.rungs[1]!.mergeLine).toBe('Merging: ashlrcode, fleet-canary');
    expect(view.rungs[7]!.aria).toMatch(/^Stage 8, 3d\. Merging: .*ashlr-hub\. Proposing: ashlr-pulse, ashlr-cortex\. medium risk · ≤ 10 files \/ 300 lines · ≤ 12 merges\/repo\/day\. Leaves after 10 merges, 24 h, ≥ 95% green\.$/);
    expect(view.bars).toEqual([
      { key: 'evidence', label: 'Would-merge digests', value: 0, max: 5, text: '0 / 5', met: false },
      { key: 'hours', label: 'Hours in stage', value: 0, max: 12, text: '0 h / 12 h', met: false },
    ]);
    // The two bar criteria are not repeated as prose.
    expect(view.otherUnmet).toEqual([]);
    expect(view.nextStageName).toBe('2a');
    expect(view.nextLine).toBe('2a lets ashlrcode, fleet-canary merge');
  });

  it('caps the hours bar at its target and keeps a decimal', () => {
    const view = ladderView(shadowStatus(NOW, { digests: 3, hours: 14.5 }))!;
    expect(view.bars[0]).toMatchObject({ text: '3 / 5', met: false });
    expect(view.bars[1]).toMatchObject({ value: 12, text: '14.5 h / 12 h', met: true });
  });

  it('keeps criteria other than the bars as prose', () => {
    const status = shadowStatus(NOW, { digests: 5, hours: 13 });
    status.rollout!.unmet = ['1 run with unknown sandbox evidence in the last 24 h'];
    expect(ladderView(status)!.otherUnmet).toEqual(['1 run with unknown sandbox evidence in the last 24 h']);
  });

  it('is null unless the grant is active and the ladder agrees with the rollout', () => {
    expect(ladderView(null)).toBeNull();
    expect(ladderView(authorityStatus('dark', NOW))).toBeNull();
    // A server without the ladder field (pre-3.14): nothing, never a half-drawn ladder.
    expect(ladderView(authorityStatus('live', NOW))).toBeNull();
    const mismatch = shadowStatus(NOW);
    mismatch.rollout = { ...mismatch.rollout!, stageId: '2a' };
    expect(ladderView(mismatch)).toBeNull();
    const paused = shadowStatus(NOW);
    paused.grant = { ...paused.grant, state: 'paused' };
    expect(ladderView(paused)).toBeNull();
  });

  it('says so on the last signed stage', () => {
    const status = shadowStatus(NOW);
    status.ladder = { ...defaultLadder(status.grant.grantId!, 7) };
    status.rollout = { ...status.rollout!, stageId: '3d', stageIndex: 7, nextStageId: null };
    const view = ladderView(status)!;
    expect(view.nextStageName).toBeNull();
    expect(view.nextLine).toBeNull();
    expect(view.rungs.slice(0, 7).every((r) => r.state === 'done')).toBe(true);
  });
});

describe('narrowing', () => {
  it('drops a malformed ladder and malformed decision rows', () => {
    expect(narrowLadder({ ...shadowStatus(NOW), ladder: { v: 1, stages: [{ id: 'x' }] } } as never)).toBeNull();
    const raw = { ...decisionsView(NOW), decisions: [wouldMergeDecision(NOW), { proposalId: 1 }] };
    expect(narrowDecisions(raw)!.decisions).toHaveLength(1);
    expect(narrowDecisions({ v: 2 })).toBeNull();
    expect(narrowDecisions(shadowStatus(NOW))).toBeNull();
  });
});

describe('grantExpiry', () => {
  it('counts down and offers Re-approve under 7 days', () => {
    expect(grantExpiry(shadowStatus(NOW), NOW)).toMatchObject({ text: '30 d left', tone: 'success', warn: false });
    expect(grantExpiry(shadowStatus(NOW, { expiresInMs: 6 * DAY }), NOW)).toMatchObject({ text: '6 d left', tone: 'warning', warn: true });
    expect(grantExpiry(shadowStatus(NOW, { expiresInMs: 2 * DAY + 5 * HOUR }), NOW)).toMatchObject({ text: '2 d 5 h left', warn: true });
    expect(grantExpiry(shadowStatus(NOW, { expiresInMs: 5 * HOUR }), NOW)).toMatchObject({ text: '5 h left', tone: 'danger' });
    expect(grantExpiry(authorityStatus('dark', NOW), NOW)).toBeNull();
  });
});

describe('lastEvent', () => {
  const ladder = defaultLadder('g');

  it('prefers the newest of move and decision, and words each', () => {
    expect(lastEvent(ladder, decisionsView(NOW))).toEqual({ text: 'Would merge ashlrcode #12 — every gate passed.', tone: 'success', at: wouldMergeDecision(NOW).at });
    const regressed = { move: 'regressed' as const, fromStageId: '2a', toStageId: 'shadow', at: new Date(NOW - HOUR).toISOString(), breach: '1 sandbox violation in stage 2a.' };
    expect(lastEvent({ ...ladder, lastMove: regressed }, decisionsView(NOW))).toEqual({
      text: 'Dropped back to Shadow from 2a: 1 sandbox violation in stage 2a.',
      tone: 'danger',
      at: regressed.at,
    });
    expect(lastEvent(ladder, decisionsView(NOW, { decisions: [refusedDecision(NOW)] })).text).toBe('fleet-canary: Refused at G2: The diff touches a protected path.');
  });

  it('is honest about loading, unavailable and empty', () => {
    expect(lastEvent(ladder, undefined).text).toBe('Reading the latest decision…');
    expect(lastEvent(ladder, null).text).toBe('The latest decision could not be read.');
    expect(lastEvent(ladder, decisionsView(NOW, { decisions: [] })).text).toBe('Nothing has reached the merge gates yet under this grant.');
  });
});

describe('small words', () => {
  it('formats stage names, ages, sizes and links', () => {
    expect(stageLabel('shadow')).toBe('Shadow');
    expect(stageLabel('2a')).toBe('2a');
    expect(ago(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
    expect(ago(new Date(NOW - 3 * HOUR).toISOString(), NOW)).toBe('3 h ago');
    expect(ago('nope', NOW)).toBe('at an unknown time');
    expect(sizeLine(wouldMergeDecision(NOW))).toBe('+30 −4 · 2 files · low risk');
    expect(sizeLine(refusedDecision(NOW))).toBeNull();
    expect(prUrl(wouldMergeDecision(NOW))).toBe('https://github.com/ashlrai/ashlrcode/pull/12');
    expect(prUrl(refusedDecision(NOW))).toBeNull();
    expect(prUrl({ repo: '/Users/x/repo', prNumber: 3 })).toBeNull();
  });

  it('lists regressions only, newest first, and links a proposal to the cloud task that filed it', () => {
    const view = decisionsView(NOW, {
      moves: [
        { move: 'regressed', fromStageId: '2a', toStageId: 'shadow', at: 't2', breach: 'b' },
        { move: 'advanced', fromStageId: 'shadow', toStageId: '2a', at: 't1', breach: null },
      ],
    });
    expect(recentRegressions(view).map((m) => m.at)).toEqual(['t2']);
    const tasks = [
      { id: 'ct_1', title: 'Fix it', repo: 'ashlrai/ashlrcode', intake: { headSha: 'x', proposalId: 'prop-ashlrcode-1', diffHash: null, refused: null, at: 't' } },
      { id: 'ct_2', title: 'Other', repo: 'ashlrai/ashlrcode' },
    ] as never;
    expect(cloudTaskFor(wouldMergeDecision(NOW), tasks)).toEqual({ id: 'ct_1', title: 'Fix it' });
    expect(cloudTaskFor(refusedDecision(NOW), tasks)).toBeNull();
    expect(cloudTaskFor(wouldMergeDecision(NOW), null)).toBeNull();
  });
});
