/**
 * routes/verse/growth/time-zone.test-support.ts — run a check in a named
 * time zone, whatever zone the suite itself runs in.
 *
 * Day-label bugs only show on one side of UTC (a UTC-midnight bucket reads a
 * day early WEST of it; a local label reads a day late far EAST). A test that
 * only passes through the runner's own zone proves nothing on a UTC CI box,
 * so the calendar-day tests walk these zones explicitly. Node re-reads
 * `process.env.TZ` on assignment; vitest runs one file's tests one at a time,
 * and the zone is restored before the next.
 */

/** West of UTC (Denver, Samoa), UTC, east of it (Tokyo, Kiritimati at UTC+14). */
export const TEST_ZONES = ['America/Denver', 'Pacific/Pago_Pago', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati'] as const;

export function inTimeZone<T>(zone: string, fn: () => T): T {
  const saved = process.env['TZ'];
  process.env['TZ'] = zone;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env['TZ'];
    else process.env['TZ'] = saved;
  }
}
