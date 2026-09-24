/**
 * routes/verse/health/health-model.ts — how a seat health report reads on
 * screen (V3.10, unit A2). Pure: no React, no I/O.
 *
 * Every surface that shows seat health (the banner, the Composer block, the
 * seat picker) takes its words from here so one seat is never described two
 * ways. State is never carried by colour alone: every tone comes with a word.
 */
import type { SeatConnection, SeatHealthReport } from '../../../../core/verse/health-types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import type { VerseSeat } from '../../../data/api-types.js';

export type HealthTone = 'danger' | 'warning' | 'neutral' | 'success';

export const CONNECTION_WORD: Record<SeatConnection, string> = {
  connected: 'connected',
  expiring: 'sign-in expiring',
  'signed-out': 'signed out',
  exhausted: 'out of usage',
  'binary-skew': 'older CLI pinned',
  unknown: 'not checked',
};

export const CONNECTION_TONE: Record<SeatConnection, HealthTone> = {
  connected: 'success',
  expiring: 'warning',
  'signed-out': 'danger',
  exhausted: 'danger',
  'binary-skew': 'warning',
  unknown: 'neutral',
};

/** Most urgent first: what blocks work, then what will, then what could be better. */
const SEVERITY: Record<SeatConnection, number> = {
  'signed-out': 0,
  exhausted: 1,
  expiring: 2,
  'binary-skew': 3,
  unknown: 4,
  connected: 5,
};

export interface SeatHealthIssue {
  report: SeatHealthReport;
  /** The seat's human label (falls back to the id when the seat is not in the roster). */
  label: string;
  word: string;
  tone: HealthTone;
  /** The first, most specific reason, or null. */
  detail: string | null;
  /** "resets Fri 2:25 PM" when the provider gave an instant. */
  reset: string | null;
}

/**
 * Is this report worth interrupting the operator for? Every non-connected
 * state is, EXCEPT an `unknown` with nothing to say (a sweep that has not run
 * yet is not a fault, and saying "not checked" about every seat at boot would
 * teach the operator to ignore the banner).
 */
export function needsAttention(report: SeatHealthReport): boolean {
  if (report.connection === 'connected') return false;
  if (report.connection === 'unknown') {
    return report.reasons.length > 0 && !report.reasons[0]!.includes('has not reached this seat');
  }
  return true;
}

export function seatHealthIssues(
  reports: readonly SeatHealthReport[],
  seats: readonly VerseSeat[] = [],
  now: number = Date.now(),
): SeatHealthIssue[] {
  const labels = new Map(seats.map((seat) => [seat.id, seat.label]));
  return reports
    .filter(needsAttention)
    .map((report) => {
      const when = describeResetAt(report.resetAt, now);
      return {
        report,
        label: labels.get(report.seatId) ?? report.seatId,
        word: CONNECTION_WORD[report.connection],
        tone: CONNECTION_TONE[report.connection],
        detail: report.reasons[0] ?? null,
        reset: when === null ? null : `resets ${when}`,
      };
    })
    .sort((a, b) => SEVERITY[a.report.connection] - SEVERITY[b.report.connection]);
}

/**
 * An argv rendered for copy-paste into a POSIX shell. Plain words stay bare;
 * anything else is single-quoted. A leading `~/` stays OUTSIDE the quotes so
 * the shell still expands it.
 */
export function shellCommandText(argv: readonly string[]): string {
  return argv.map((arg) => {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
    if (arg.startsWith('~/') && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg)) return arg;
    if (arg.startsWith('~/')) return `~/'${arg.slice(2).replaceAll("'", "'\\''")}'`;
    return `'${arg.replaceAll("'", "'\\''")}'`;
  }).join(' ');
}

/** One line summarising the whole roster for a collapsed banner. */
export function issuesHeadline(issues: readonly SeatHealthIssue[]): string {
  if (issues.length === 0) return 'All seats are connected.';
  const blocked = issues.filter((issue) => issue.tone === 'danger').length;
  if (blocked > 0) {
    return blocked === 1 ? `${issues.find((i) => i.tone === 'danger')!.label} can't run turns right now.`
      : `${blocked} seats can't run turns right now.`;
  }
  return issues.length === 1 ? `${issues[0]!.label} needs attention.` : `${issues.length} seats need attention.`;
}
