/**
 * THE ONE PERCENT RULE, dependency-free.
 *
 * A measured share of a window (or anything capped at 100) printed the same
 * way everywhere: a whole percent, except that a real reading under 1% is
 * "<1%" (never "0%", which reads as "untouched") and one just short of 100 is
 * "99%" (never a rounded "100%", which reads as "spent"). `used` is 0–100 and
 * is clamped; not a number is "—".
 *
 * This module imports nothing so the rail, composer and chat header can use
 * it without pulling panel code into chat first paint. `autonomy/format.ts`
 * `percentText` delegates here, so there is one rule, not two.
 */
export function usedPercentText(used: number | null | undefined): string {
  if (typeof used !== 'number' || !Number.isFinite(used)) return '—';
  const clamped = Math.max(0, Math.min(100, used));
  if (clamped > 0 && clamped < 1) return '<1%';
  if (clamped > 99 && clamped < 100) return '99%';
  return `${Math.round(clamped)}%`;
}
