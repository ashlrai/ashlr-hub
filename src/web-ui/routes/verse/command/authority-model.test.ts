import { describe, expect, it } from 'vitest';
import { actionForDraft, classifySwitch, stopOutcomeSentence, grantChip, switchOptions, timeLeft, verdictParts } from './authority-model.js';
import { authorityStatus, fleetLive } from './fixtures.test-support.js';
import { darkSinceLabel, fleetDarkSince } from '../fleet/dark-since.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const DAY = 86_400_000;

describe('classifySwitch — I1: only a grant raises; lowering is instant', () => {
  it('lowers without a grant, raises within the grant, asks for Touch ID past it', () => {
    const s = { switch: 'propose', maxSwitchWithoutGrant: 'propose' } as const;
    expect(classifySwitch(s, 'off')).toBe('lower');
    expect(classifySwitch(s, 'propose')).toBe('same');
    expect(classifySwitch(s, 'autonomous')).toBe('raise-needs-grant');
    expect(classifySwitch({ switch: 'off', maxSwitchWithoutGrant: 'autonomous' }, 'autonomous')).toBe('raise');
    // Even with no grant at all, Off is one click away.
    expect(classifySwitch({ switch: 'autonomous', maxSwitchWithoutGrant: 'off' }, 'off')).toBe('lower');
  });

  it('marks exactly the positions past the grant as needing Touch ID, in words', () => {
    const opts = switchOptions({ switch: 'off', maxSwitchWithoutGrant: 'propose' });
    expect(opts.map((o) => [o.value, o.needsGrant])).toEqual([
      ['off', false],
      ['propose', false],
      ['autonomous', true],
    ]);
    expect(opts[2]!.ariaLabel).toBe('Autonomous (needs a new grant — Touch ID)');
  });
});

describe('grantChip', () => {
  it('reads days left, warns inside 3 days and offers renewal', () => {
    const s = authorityStatus('live', NOW);
    expect(grantChip(s, NOW)).toMatchObject({ label: '23d', tone: 'success', action: null });
    const soon = authorityStatus('live', NOW, { grant: { ...s.grant, expiresAt: new Date(NOW + 2 * DAY + 3 * 3_600_000).toISOString() } });
    expect(grantChip(soon, NOW)).toMatchObject({ label: '2d 3h', tone: 'warning', action: 'grant' });
  });

  it('says paused / none / unknown in words and routes to the right Touch ID flow', () => {
    const s = authorityStatus('live', NOW);
    const paused = authorityStatus('live', NOW, { grant: { ...s.grant, state: 'paused', reason: 'Authority code changed — re-approve.' } });
    expect(grantChip(paused, NOW)).toMatchObject({ label: 'Paused, re-approve', tone: 'warning', action: 're-approve' });
    expect(grantChip(authorityStatus('dark', NOW), NOW)).toMatchObject({ label: 'No grant', action: 'grant' });
    expect(grantChip(null, NOW)).toMatchObject({ label: 'Grant unknown', tone: 'unknown', action: null });
  });

  it('formats time left coarsely', () => {
    expect(timeLeft(40 * 60_000)).toBe('40m');
    expect(timeLeft(5 * 3_600_000)).toBe('5h');
    expect(timeLeft(DAY)).toBe('1d');
    expect(timeLeft(10 * DAY)).toBe('10d');
  });
});

describe('verdictParts', () => {
  it('reads like the spec example', () => {
    const parts = verdictParts({ authority: authorityStatus('live', NOW), building: 5, mergedToday: 7, revertsToday: 0, reserve: { label: 'Claude', percent: 46 }, darkSince: null });
    expect(parts.map((p) => p.text).join(' · ')).toBe('Autonomous · 5 building · 7 merged today · 0 reverts · Claude 46% reserved for you');
  });

  it('leaves unknown numbers out instead of printing zeros, and says when the fleet is unknown', () => {
    expect(verdictParts({ authority: null, building: null, mergedToday: null, revertsToday: null, reserve: null, darkSince: null }).map((p) => p.text)).toEqual([
      'Autonomy unknown',
      'fleet status unknown',
    ]);
    const partial = verdictParts({ authority: authorityStatus('sparse', NOW), building: 1, mergedToday: null, revertsToday: null, reserve: null, darkSince: null });
    expect(partial.map((p) => p.text)).toEqual(['Propose', '1 building']);
  });

  it('puts Stopped first when KILL is on, and the dark date when dark', () => {
    const stopped = verdictParts({ authority: authorityStatus('live', NOW, { kill: true }), building: 0, mergedToday: 0, revertsToday: 0, reserve: null, darkSince: null });
    expect(stopped[0]).toMatchObject({ text: 'Stopped', tone: 'danger' });
    const dark = verdictParts({ authority: authorityStatus('dark', NOW), building: 0, mergedToday: 0, revertsToday: 0, reserve: null, darkSince: '2026-09-01T19:10:00Z' });
    expect(dark.map((p) => p.text)).toEqual(['Off', 'fleet dark since Sep 1']);
  });

  it('dates "dark since" from THE fleet dark-since instant, as the viewer\'s local day', () => {
    // The live snapshot's darkSince (fleet/dark-since.ts), not history's
    // "quiet since"; labelled exactly as the Fleet charts label it.
    const live = { ...fleetLive('dark', NOW), darkSince: '2026-09-02T02:30:00.000Z' };
    const parts = verdictParts({ authority: authorityStatus('dark', NOW), building: 0, mergedToday: 0, revertsToday: 0, reserve: null, darkSince: fleetDarkSince(live) });
    expect(parts[1]!.text).toBe(`fleet dark since ${darkSinceLabel('2026-09-02T02:30:00.000Z')}`);
    // An idle fleet is not dark, whatever history says.
    expect(fleetDarkSince(fleetLive('live', NOW))).toBeNull();
  });
});

describe('actionForDraft', () => {
  const draft = (kind?: string) => ({ payload: {} as never, digest: 'a'.repeat(64), ...(kind ? { kind } : {}) });
  it('the draft\'s own kind decides grant vs re-approve (the server refuses a mismatch)', () => {
    expect(actionForDraft(draft('new'), 're-approve')).toBe('grant');
    expect(actionForDraft(draft('reapprove'), 'grant')).toBe('re-approve');
  });
  it('falls back to the clicked intent when the server sends no kind', () => {
    expect(actionForDraft(draft(), 're-approve')).toBe('re-approve');
    expect(actionForDraft(draft('other'), 'grant')).toBe('grant');
  });
});

describe('stopOutcomeSentence — the Stop UI shows what the drain did', () => {
  const res = (stop: Record<string, unknown>) => ({ v: 1, result: { stop } });
  it('says how many agents are still finishing, never "stopped" alone', () => {
    expect(stopOutcomeSentence(res({ quiesced: false, liveExecutionLeases: 2, mergesRevoked: null, mergeRevokeFailures: [] })))
      .toBe('Stopped. 2 agents started before Stop are still finishing; no new work starts.');
    expect(stopOutcomeSentence(res({ quiesced: true, liveExecutionLeases: 0, mergesRevoked: 1, mergeRevokeFailures: ['m1'] })))
      .toBe('Stopped. No agent is still running. 1 armed merge was revoked. 1 armed merge could not be revoked; Stop still blocks it.');
  });
  it('an unknown lease count is not reported as drained', () => {
    expect(stopOutcomeSentence(res({ quiesced: false }))).toBe('Stopped. Agents started before Stop may still be finishing; no new work starts.');
  });
  it('no stop result → nothing to say', () => {
    expect(stopOutcomeSentence({ v: 1 })).toBeNull();
    expect(stopOutcomeSentence(null)).toBeNull();
  });
});
