import { describe, expect, it } from 'vitest';
import type { UniversePortfolioControllerView as View } from '../../core/web/universe-console-types.js';
import { compareControllerObservations as compare } from './controller-observation-delta.js';

const at = '2026-09-09T10:00:00.000Z';
const later = '2026-09-09T10:01:00.000Z';
function report(patch: Partial<View> = {}): View {
  return { schemaVersion: 1, controllerId: 'fleet', sourceState: 'healthy', status: 'incomplete',
    createdAt: at, observedAt: at, deadlineAt: '2026-09-10T10:00:00.000Z', reasons: [],
    outcomes: [{ campaignId: 'build', state: 'pending', attempted: false, reasonCode: 'dependency-held' }], ...patch };
}
const changed = (patch: Partial<View> = {}) => report({ observedAt: later, ...patch });

describe('accepted controller observation comparison', () => {
  it('establishes a baseline without inventing changes', () => {
    expect(compare(null, report())).toMatchObject({ kind: 'baseline', clockWarning: false, changes: [], changedCampaigns: 0 });
  });
  it.each([{ controllerId: 'other' }, { createdAt: later }, { createdAt: null }])('withholds comparisons when identity or registration changes (%j)', (patch) => {
    expect(compare(report(), changed(patch))).toMatchObject({ kind: 'incomparable', changes: [], changedCampaigns: 0, notice: expect.stringContaining('continuity') });
  });
  it('compares unchanged evidence without counting observation time as work', () => {
    expect(compare(report(), changed())).toEqual({ kind: 'compared', notice: null, clockWarning: false, changes: [], changedCampaigns: 0 });
  });
  it.each([at, '2026-09-09T09:59:00.000Z'])('flags equal or backward observation clocks (%s)', (observedAt) => {
    expect(compare(report(), changed({ observedAt }))).toMatchObject({ kind: 'compared', clockWarning: true, changes: [] });
  });
  it('compares all three outcome fields while counting a campaign only once', () => {
    const next = changed({ outcomes: [{ campaignId: 'build', state: 'in-flight', attempted: true, reasonCode: 'dispatch-unresolved' }] });
    expect(compare(report(), next)).toMatchObject({ changedCampaigns: 1, changes: [
      { key: 'campaign:build:state', before: 'Pending', after: 'Unresolved intent', campaignId: 'build' },
      { key: 'campaign:build:reason', before: 'dependency-held', after: 'dispatch-unresolved', campaignId: 'build' },
      { key: 'campaign:build:attempted', before: 'Not recorded', after: 'Recorded', campaignId: 'build' },
    ] });
  });
  it.each([{ reasonCode: 'owner-paused' }, { attempted: true }])('preserves reason-only and intent-only changes (%j)', (patch) => {
    const result = compare(report(), changed({ outcomes: [{ ...report().outcomes[0], ...patch }] }));
    expect(result.changedCampaigns).toBe(1); expect(result.changes).toHaveLength(1);
  });
  it('compares rows by identity and reports ordering independently of campaign changes', () => {
    const first = report(); const second = { ...first.outcomes[0], campaignId: 'ship' };
    first.outcomes.push(second);
    const result = compare(first, changed({ outcomes: [...first.outcomes].reverse() }));
    expect(result.changedCampaigns).toBe(0);
    expect(result.changes).toEqual([{ key: 'controller:campaign-order', label: 'Recorded campaign order', before: 'build, ship', after: 'ship, build' }]);
  });
  it('describes membership as observation presence without invented outcome transitions', () => {
    const next = changed({ outcomes: [{ ...report().outcomes[0], campaignId: 'ship' }] });
    const result = compare(report(), next);
    expect(result.changedCampaigns).toBe(2);
    expect(result.changes.filter((row) => row.campaignId)).toEqual([
      { key: 'campaign:ship:presence', label: 'Campaign presence', before: 'Not observed', after: 'Present', campaignId: 'ship' },
      { key: 'campaign:build:presence', label: 'Campaign presence', before: 'Present', after: 'Not observed', campaignId: 'build' },
    ]);
  });
  it.each(['missing', 'degraded'] as const)('warns about %s evidence on either side', (sourceState) => {
    for (const [before, after] of [[report({ sourceState }), changed()], [report(), changed({ sourceState, outcomes: [] })]]) {
      expect(compare(before, after).notice).toContain('does not establish deletion, completion or execution');
    }
  });
  it('compares incomplete registration evidence with an explicit continuity warning', () => {
    expect(compare(report({ createdAt: null }), changed({ createdAt: null }))).toMatchObject({ kind: 'compared', notice: expect.stringContaining('continuity is not established') });
  });
  it('reports deadline differences without implying renewed execution authority', () => {
    const result = compare(report(), changed({ deadlineAt: null }));
    expect(result.notice).toContain('does not establish registration continuity or renew execution authority');
    expect(result.changes).toContainEqual({ key: 'controller:deadline', label: 'Recorded deadline', before: report().deadlineAt, after: 'Not recorded' });
  });
  it('compares controller status, source health and unordered evidence reasons', () => {
    const result = compare(report({ reasons: ['b', 'a'] }), changed({ status: 'completed', sourceState: 'degraded', reasons: ['a', 'b'] }));
    expect(result.changes.map((row) => row.key)).toEqual(['controller:status', 'controller:health']);
    expect(compare(report(), changed({ reasons: ['a'] })).changes[0]).toMatchObject({ before: 'None recorded', after: 'a' });
  });
  it('reports each changed admission field, including absent control', () => {
    const control = { mode: 'drain' as const, sequence: 2, requestedAt: later, acknowledgedAt: at };
    const result = compare(report(), changed({ control }));
    expect(result.changes.map((row) => row.key)).toEqual(['control:mode', 'control:sequence', 'control:requestedAt', 'control:acknowledgedAt']);
    expect(result.changes.every((row) => row.before === 'Not recorded')).toBe(true);
    expect(compare(report({ control }), changed({ control: { ...control, acknowledgedAt: null } })).changes).toEqual([
      { key: 'control:acknowledgedAt', label: 'Admission acknowledged at', before: at, after: 'Not recorded' },
    ]);
  });
  it('distinguishes unavailable topology from available empty evidence', () => {
    expect(compare(report({ outcomes: [] }), changed({ outcomes: [], topology: [] })).changes).toEqual([
      { key: 'controller:topology', label: 'Dependency evidence', before: 'Unavailable', after: 'Available' },
    ]);
  });
  it('compares dependency sets independent of node or edge ordering', () => {
    const topology = [{ campaignId: 'build', dependsOn: ['a', 'b'], prerequisites: ['a', 'b'] }];
    const result = compare(report({ topology }), changed({ topology: [{ ...topology[0], dependsOn: ['b', 'a'], prerequisites: ['b', 'a'] }] }));
    expect(result.changes).toEqual([]);
    const delta = compare(report({ topology }), changed({ topology: [{ ...topology[0], dependsOn: ['a'], prerequisites: ['a'] }] }));
    expect(delta.changedCampaigns).toBe(1);
    expect(delta.changes.map((row) => [row.label, row.before, row.after])).toEqual([
      ['Direct dependencies', 'a, b', 'a'], ['Effective prerequisites', 'a, b', 'a'],
    ]);
  });
  it('does not interpret missing topology members as empty dependency lists', () => {
    const topology = [{ campaignId: 'build', dependsOn: [], prerequisites: [] }];
    expect(compare(report({ topology }), changed({ outcomes: [], topology: [] })).changes.some((row) => row.key.endsWith(':dependencies'))).toBe(false);
  });
  it('supports all 64 campaigns with deterministic unique keys and no mutation', () => {
    const outcomes = Array.from({ length: 64 }, (_, index) => ({ ...report().outcomes[0], campaignId: `campaign-${index}` }));
    const before = report({ outcomes }); const after = changed({ outcomes: outcomes.map((row) => ({ ...row, attempted: true })) });
    const originals = structuredClone([before, after]);
    function freeze(value: object) { Object.values(value).forEach((child) => { if (child && typeof child === 'object') freeze(child); }); Object.freeze(value); }
    freeze(before); freeze(after);
    const result = compare(before, after);
    expect(result.changedCampaigns).toBe(64); expect(result.changes).toHaveLength(64);
    expect(new Set(result.changes.map((row) => row.key)).size).toBe(64);
    expect([before, after]).toEqual(originals); expect(compare(before, after)).toEqual(result);
  });
});
