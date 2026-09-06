/**
 * components/charts/format.ts — number formatting shared by every chart and
 * stat tile. Proportional figures everywhere EXCEPT columns that must align
 * vertically (table cells, axis ticks) — see marks-and-anatomy.md "Proportional
 * figures for big numbers; tabular only in columns." Callers apply
 * `font-variant-numeric: tabular-nums` via CSS where that applies; these
 * functions only produce the string.
 */

/** Auto-compact a count: 1,284 / 12.9K / 4.2M. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}K`;
  if (abs >= 1_000) return n.toLocaleString('en-US');
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Auto-compact USD: $4.20 / $1.2K / $4.2M. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Fraction (0..1) as a percentage. */
export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Signed delta for a stat tile: "+12" / "-3" / "0". */
export function formatSignedCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const s = formatCompact(Math.abs(n));
  if (n > 0) return `+${s}`;
  if (n < 0) return `-${s}`;
  return s;
}

/** YYYY-MM-DD -> short label, e.g. "Aug 14". Local-independent (UTC parse). */
export function formatDayLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const d = new Date(`${day}T00:00:00Z`);
  // Date normalizes impossible dates; compare the padded UTC date to reject rollover.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return day;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Epoch ms -> short label for axis ticks. */
export function formatTimeLabel(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
