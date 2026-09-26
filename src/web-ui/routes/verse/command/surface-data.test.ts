/**
 * Fleet history is asked for in the viewer's zone. Without `tz` the route
 * buckets runs by the UTC day, so a Sep 25 evening west of UTC was charted
 * (and "dark since" dated) as Sep 26.
 */
import { describe, expect, it } from 'vitest';
import { FLEET_HISTORY_PATH, fleetHistoryPath } from './surface-data.js';
import { inTimeZone } from '../growth/time-zone.test-support.js';

describe('fleetHistoryPath', () => {
  const at = new Date('2026-09-26T02:52:00.000Z'); // 22:52 EDT, Sep 25

  it('sends the Date#getTimezoneOffset of the moment it is read', () => {
    expect(inTimeZone('America/New_York', () => fleetHistoryPath(at))).toBe(`${FLEET_HISTORY_PATH}&tz=240`);
    expect(inTimeZone('Asia/Tokyo', () => fleetHistoryPath(at))).toBe(`${FLEET_HISTORY_PATH}&tz=-540`);
    expect(inTimeZone('UTC', () => fleetHistoryPath(at))).toBe(`${FLEET_HISTORY_PATH}&tz=0`);
  });

  it('follows a DST change instead of freezing the offset at load', () => {
    const winter = new Date('2026-12-01T12:00:00.000Z');
    expect(inTimeZone('America/New_York', () => fleetHistoryPath(winter))).toBe(`${FLEET_HISTORY_PATH}&tz=300`);
  });
});
