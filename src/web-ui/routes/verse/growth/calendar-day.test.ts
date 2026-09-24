import { describe, expect, it } from 'vitest';
import { calendarDayStart } from './calendar-day.js';
import { formatDayLabel, formatTimeLabel } from '../../../components/charts/format.js';
import { TEST_ZONES, inTimeZone } from './time-zone.test-support.js';

describe('calendarDayStart — a day bucket on a local time axis', () => {
  it('stamps the day at local midnight, so the local label names that same day in every zone', () => {
    for (const zone of TEST_ZONES) {
      inTimeZone(zone, () => {
        for (const day of ['2026-09-24', '2026-01-01', '2026-03-08', '2026-11-01', '2024-02-29']) {
          const at = calendarDayStart(day);
          const local = new Date(at);
          expect(local.getHours(), `${zone} ${day}`).toBe(0);
          expect(formatTimeLabel(at), `${zone} ${day}`).toBe(formatDayLabel(day));
        }
      });
    }
  });

  it('reads the regression the old UTC stamp caused: Denver sees "Sep 23" for a UTC-midnight "2026-09-24"', () => {
    inTimeZone('America/Denver', () => {
      expect(formatTimeLabel(Date.parse('2026-09-24T00:00:00Z'))).toBe('Sep 23');
      expect(formatTimeLabel(calendarDayStart('2026-09-24'))).toBe('Sep 24');
    });
  });

  it('is NaN for anything that is not a real calendar day', () => {
    for (const bad of ['', '2026-9-24', '2026-09-24T00:00:00Z', '2026-02-30', '2026-13-01', '0026-01-01', 'not a day']) {
      expect(calendarDayStart(bad), bad).toBeNaN();
    }
  });
});
