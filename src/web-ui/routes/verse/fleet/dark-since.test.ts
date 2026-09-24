import { describe, expect, it } from 'vitest';
import { sinceLabel } from '../../../components/charts/ChartFrame.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { verdictParts } from '../command/authority-model.js';
import { darkSinceDay, darkSinceLabel, fleetDarkSince, fleetDarkStatus, quietSinceStatus } from './dark-since.js';
import { fleetStatus } from './FleetCards.js';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import { TEST_ZONES, inTimeZone } from '../growth/time-zone.test-support.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');

describe('fleetDarkSince — the one "Fleet dark since"', () => {
  it('is the server\'s darkSince when it sends one, even over lastActivityAt', () => {
    const live = { ...fleetLive('dark', NOW), darkSince: '2026-08-30T15:00:00.000Z' };
    expect(fleetDarkSince(live)).toBe('2026-08-30T15:00:00.000Z');
  });

  it('applies the same rule to a pre-3.10.1 payload: lastActivityAt, only while dark', () => {
    const dark = fleetLive('dark', NOW);
    expect(dark.darkSince).toBeUndefined();
    expect(fleetDarkSince(dark)).toBe(dark.lastActivityAt);
    // An idle or running fleet is never dark, however long ago it produced.
    expect(fleetDarkSince(fleetLive('live', NOW))).toBeNull();
    expect(fleetDarkSince({ ...fleetLive('live', NOW), darkSince: null })).toBeNull();
    expect(fleetDarkSince(null)).toBeNull();
  });

  it('names the same local day on the verdict line and in the Fleet charts', () => {
    // 02:30 UTC is the previous evening anywhere west of UTC — the case where a
    // UTC slice and the verdict's local date used to disagree.
    const iso = '2026-09-02T02:30:00.000Z';
    const live = { ...fleetLive('dark', NOW), darkSince: iso };
    for (const zone of TEST_ZONES) {
      inTimeZone(zone, () => {
        const status = fleetStatus({ value: live, available: true, reason: null }, 'empty', false);
        expect(status.kind, zone).toBe('dark');
        const chartDay = sinceLabel((status as { since: string }).since);
        const verdict = verdictParts({ authority: null, building: 0, mergedToday: 0, revertsToday: 0, reserve: null, darkSince: fleetDarkSince(live) });
        expect(chartDay, zone).toBe(darkSinceLabel(iso));
        expect(verdict.find((p) => p.key === 'dark')!.text, zone).toBe(`fleet dark since ${darkSinceLabel(iso)}`);
        const local = new Date(Date.parse(iso));
        expect(darkSinceDay(iso), zone).toBe(`${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`);
      });
    }
    // West of UTC that is Sep 1; far east, Sep 2.
    expect(inTimeZone('America/Los_Angeles', () => darkSinceLabel(iso))).toBe('Sep 1');
    expect(inTimeZone('Asia/Tokyo', () => darkSinceLabel(iso))).toBe('Sep 2');
  });

  it('says just "Fleet dark." — as Command does — when the server knows no dark-since instant, never "since <today>"', () => {
    const dark = fleetLive('dark', NOW);
    const detail = dark.stateReason!;
    const read = (value: FleetLiveSnapshotV1) => fleetStatus({ value, available: true, reason: null }, 'empty', false);
    // A 3.10.1 server: dark, but no recorded activity (fresh install, cleared ledger and journal).
    expect(read({ ...dark, darkSince: null })).toEqual({ kind: 'empty', message: `Fleet dark. ${detail}` });
    expect(fleetDarkStatus({ ...dark, darkSince: null, stateReason: null })).toEqual({ kind: 'empty', message: 'Fleet dark.' });
    // A pre-3.10.1 server with no lastActivityAt, and an unparsable instant, read the same.
    expect(read({ ...dark, lastActivityAt: null })).toEqual({ kind: 'empty', message: `Fleet dark. ${detail}` });
    expect(read({ ...dark, darkSince: 'not a time' })).toEqual({ kind: 'empty', message: `Fleet dark. ${detail}` });
    // Never the snapshot's own generatedAt passed off as the dark day.
    expect(JSON.stringify(read({ ...dark, darkSince: null }))).not.toMatch(/since/);
    // With an instant it is the dated dark state.
    expect(read({ ...dark, darkSince: '2026-08-30T15:00:00.000Z' })).toEqual({ kind: 'dark', since: darkSinceDay('2026-08-30T15:00:00.000Z'), detail });
  });
});

describe('quietSinceStatus — history\'s "last run or proposal" is not "dark"', () => {
  it('re-words the history dark state and passes everything else through', () => {
    const quiet = quietSinceStatus({ kind: 'dark', since: '2026-08-18T16:00:00.000Z' });
    expect(quiet).toEqual({ kind: 'empty', message: `No fleet runs or proposals since ${darkSinceLabel('2026-08-18T16:00:00.000Z')}.` });
    expect(JSON.stringify(quiet)).not.toMatch(/dark/i);
    expect(quietSinceStatus({ kind: 'ready' })).toEqual({ kind: 'ready' });
    expect(quietSinceStatus({ kind: 'unknown', reason: 'x' })).toEqual({ kind: 'unknown', reason: 'x' });
  });
});
