/**
 * routes/verse/growth/calendar-day.ts — where a day bucket sits on a time
 * axis (3.10.1 review).
 *
 * A server day bucket is a CALENDAR day (`YYYY-MM-DD`; the reasoning digest
 * and fleet history bucket by the machine's local day). Growth and Mind used
 * to stamp it at UTC midnight (`Date.parse(`${day}T00:00:00Z`)`) and then
 * label it through the chart kit's time labels, which read the viewer's LOCAL
 * zone (AreaTrend's default `formatTimeLabel`, and every rung of
 * `timeLabelLadder`). West of UTC that midnight is still the previous evening,
 * so "2026-09-24" read "Sep 23" on the axis, the tooltip and the table.
 *
 * Stamping the bucket at LOCAL midnight gives the bucket and every local
 * label the same calendar semantics: whatever rung a label lands on, it names
 * the day the server meant.
 *
 * Framework-free; tested directly.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Epoch ms of LOCAL midnight on calendar day `day` (`YYYY-MM-DD`); NaN for
 * anything that is not a real calendar day (the chart kit drops a NaN x
 * rather than drawing it). Where a zone skips midnight (a DST change at
 * 00:00), this is the first instant of that day that exists — still that day.
 */
export function calendarDayStart(day: string): number {
  const m = DAY.exec(day);
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = new Date(y, mo, d);
  // `new Date` rolls impossible days over (Feb 30 → Mar 2) and maps years
  // 0–99 onto 1900–1999: either way it is not the day asked for.
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== d) return NaN;
  return at.getTime();
}
