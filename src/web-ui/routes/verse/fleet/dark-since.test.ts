import { describe, expect, it } from 'vitest';
import { sinceLabel } from '../../../components/charts/ChartFrame.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { verdictParts } from '../command/authority-model.js';
import { darkSinceDay, darkSinceLabel, fleetDarkSince, quietSinceStatus } from './dark-since.js';
import { fleetStatus } from './FleetCards.js';

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
    const status = fleetStatus({ value: live, available: true, reason: null }, 'empty', false);
    expect(status.kind).toBe('dark');
    const chartDay = sinceLabel((status as { since: string }).since);
    const verdict = verdictParts({ authority: null, building: 0, mergedToday: 0, revertsToday: 0, reserve: null, darkSince: fleetDarkSince(live) });
    expect(chartDay).toBe(darkSinceLabel(iso));
    expect(verdict.find((p) => p.key === 'dark')!.text).toBe(`fleet dark since ${darkSinceLabel(iso)}`);
    const local = new Date(Date.parse(iso));
    expect(darkSinceDay(iso)).toBe(`${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`);
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
