/**
 * routes/verse/autonomy/format.ts — the small pure functions the cockpit's
 * numerals go through. Kept framework-free so they unit-test without a DOM,
 * and kept in ONE place so "unknown" never renders as 0 in one panel and as
 * an em-dash in the next.
 *
 * The rule every function here obeys: absent is not zero. A null spend is
 * "—", a null budget is "not configured", and a budget of exactly 0 is
 * "stopped" — which is the single most misread number in the whole product.
 */
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { formatDayLabel, formatPercent } from '../../../components/charts/format.js';
import { isAbsolutePath, projectName } from '../verse-model.js';
import { usedPercentText } from '../percent-text.js';

/** What we render when a value genuinely is not known. */
export const UNKNOWN = '—';

/**
 * A share as a whole percentage — "18%" — except a non-zero share under one
 * percent, which reads "<1%". One precision per panel: "0%" for a sliver of
 * real spend or progress would state that nothing happened.
 */
export function formatWholePercent(fraction: number | null | undefined): string {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return UNKNOWN;
  if (fraction > 0 && fraction < 0.01) return '<1%';
  return formatPercent(fraction);
}

/**
 * THE ONE PERCENT RULE — a measured share of a window (or of anything capped
 * at 100), printed the same way on every panel: a whole percent, except that a
 * real reading under 1% is "<1%" (never "0%", which would read as "untouched")
 * and one just short of 100 is "99%" (never a rounded "100%", which would read
 * as "spent"). `used` is 0–100 and is clamped; not a number is "—".
 *
 * Every place that prints a used percent goes through this — a bar reading
 * "99%" beside a summary reading "100% of 5-hour window used" is one seat
 * described two ways. Bar WIDTHS stay numeric; only the words use this.
 */
export function percentText(used: number): string {
  return usedPercentText(used);
}

/** An ISO-8601 instant (a date WITH a time) anywhere inside a sentence. */
const ISO_INSTANT_IN_TEXT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\w:])/g;

/**
 * What may end a sentence right before its full stop: a letter, a digit, a
 * percent sign, an ellipsis, or a closing quote / bracket / backtick. NOT a
 * dot, a slash or a space — so a path segment (`../x`, `cd ..;`) never looks
 * like doubled punctuation.
 */
const SENTENCE_END = String.raw`[\p{L}\p{N}%…)\]"'’”\x60]`;
/** "failed.; next" / "failed..; next" → "failed; next". */
const STOP_BEFORE_SEMICOLON = new RegExp(`(${SENTENCE_END})\\.{1,2}\\s*;`, 'gu');
/**
 * "failed.. Next" / "exhausted.." → one stop. The pair must be FOLLOWED by
 * whitespace or the end, so a git range (`a1b2c3d..e4f5a6b`, `HEAD~1..HEAD`)
 * and a traversal (`x/../y`) pass through untouched; a third dot (`...`) is
 * an ellipsis, not a doubled stop.
 */
const DOUBLED_STOP = new RegExp(`(${SENTENCE_END})\\.\\.(?=\\s|$)`, 'gu');

/**
 * Server prose made fit to print: every ISO instant becomes the viewer's
 * local time ("today 11:46 PM", "Fri 11:46 PM", "Sep 26, 11:46 PM" — the
 * wording `describeResetAt` gives resets everywhere else), and the ".;" / ".."
 * that a sentence joined onto another sentence leaves behind is collapsed.
 *
 * For text the server wrote for a person (`ApiError.detail`, action notes,
 * audit summaries, fleet notes): it is shown verbatim otherwise. That matters
 * on the trust surfaces this runs on (approval summaries, the audit trail):
 * a `../../.ssh/authorized_keys` rewritten to `././.ssh/…` would hide the very
 * traversal the operator is deciding about, so only sentence punctuation is
 * ever touched.
 */
export function tidyProse(text: string, now: number = Date.now()): string {
  return text
    .replace(ISO_INSTANT_IN_TEXT, (iso) => describeResetAt(iso, now) ?? iso)
    .replace(STOP_BEFORE_SEMICOLON, '$1;')
    .replace(DOUBLED_STOP, '$1.');
}

/**
 * A sentence ready to be embedded in another one: trimmed, with its own
 * closing period dropped so "… unavailable: quota exhausted." does not become
 * "quota exhausted..". An ellipsis is kept — it is not a full stop.
 */
export function asClause(text: string): string {
  const trimmed = text.trim();
  if (trimmed.endsWith('...') || trimmed.endsWith('…')) return trimmed;
  return trimmed.replace(/\.+$/, '');
}

/**
 * One sentence: trimmed and closed by exactly one full stop — added only when
 * the text does not already end in `.`, `!`, `?` or `…` (a trailing ";", ","
 * or ":" is dropped first). The fix for "local Qwen offline.." when a server
 * reason already carries its own stop. Never re-cased — a sentence may open on
 * a seat id.
 */
export function asSentence(text: string): string {
  const t = text.trim().replace(/[\s;,:]+$/, '');
  if (!t) return '';
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/**
 * What a repo cell shows: the folder's own name for an absolute checkout path
 * (the full path belongs in the cell's `title`), and a `owner/name` slug or a
 * bare name as it came — cutting a slug to its last segment would drop the
 * owner, which is half of what identifies it.
 */
export function repoDisplayName(repo: string): string {
  return isAbsolutePath(repo) ? projectName(repo) : repo;
}

export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN;
  return `$${value.toFixed(2)}`;
}

export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN;
  return String(value);
}

/** "4m 12s" / "1h 06m" / "12s" — for durations and countdowns alike. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Compact age for dense table cells: "42s", "7m", "3h", "5d". */
export function formatAge(iso: string | null | undefined): string {
  if (!iso) return UNKNOWN;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function formatRelative(iso: string | null | undefined): string {
  const age = formatAge(iso);
  return age === UNKNOWN ? UNKNOWN : `${age} ago`;
}

/** Local wall-clock time, for the audit table's second column. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return UNKNOWN;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The viewer's local calendar day as `YYYY-MM-DD` — NOT the UTC slice. */
export function localDateKey(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Is `todayDate` still the current ledger day?
 *
 * The daemon stamps it in UTC (`resetDayIfNeeded` in core/daemon/state.ts is
 * `new Date().toISOString().slice(0, 10)`) but the operator reads the screen
 * in local time, and the two disagree for part of every day at any offset but
 * zero. Comparing against the local day alone would announce "nothing has been
 * recorded today" every evening west of UTC — a false alarm on the meter whose
 * whole purpose is to be trustworthy.
 *
 * So either spelling counts as current. That is deliberately conservative: it
 * can call a day current for a few hours after the UTC rollover, and it will
 * never call a genuinely current day stale. The case this exists for is a
 * ledger day weeks old, which neither spelling matches.
 */
export function isCurrentLedgerDay(todayDate: string, now: Date = new Date()): boolean {
  return todayDate === localDateKey(now) || todayDate === now.toISOString().slice(0, 10);
}

/**
 * Time-of-day for a row from today; date + time for anything older.
 *
 * `formatClock` alone is only honest inside a single-day window, and the
 * tables that use it are not one: the audit trail defaults to 200 rows and
 * offers 500, which on a real machine spans days. Two rows reading "03:12:44"
 * could be last night and last week, and the only date was in a hover title
 * that a touch viewport never fires.
 */
export function formatStamp(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return UNKNOWN;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  const at = new Date(ms);
  const clock = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (localDateKey(at) === localDateKey(now)) return clock;
  const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} ${clock}`;
}

/** Human tick interval, e.g. "every 15m". */
export function formatInterval(intervalMs: number | null | undefined): string {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) return UNKNOWN;
  // A configured interval is a round number far more often than not; "every
  // 15m" reads better than "every 15m 00s" and loses nothing when it isn't.
  return `every ${formatDuration(intervalMs).replace(/ 00[ms]$/, '')}`;
}

export type BudgetState = 'stopped' | 'unknown' | 'ok' | 'warn' | 'over';

export interface BudgetMeter {
  state: BudgetState;
  /** 0-100, clamped. Null when there is nothing honest to draw. */
  percent: number | null;
  /** One line: "$4.50 of $25.00 today · 18%". */
  label: string;
  /** The plain-language verdict shown next to the meter. */
  note: string;
}

const BUDGET_WARN_PERCENT = 70;

/**
 * Today's spend against the configured daily cap, as ONE line.
 *
 * A cap of exactly 0 is the contract's guard rail: it means the loop is
 * stopped, and it must never render as an empty (i.e. "plenty left") meter.
 *
 * `todayDate` is the ledger day `spend.todayUsd` was counted for. It is NOT
 * optional decoration: the daemon writes the figure once per day and leaves it
 * there, so a machine that last ticked three weeks ago answers
 * `{todayUsd: 0, todayDate: "2026-09-01"}`. Rendering that as "$0.00 of $50.00
 * today" is a fabricated statement about today on the one number an operator
 * checks before walking away from an autonomous loop. Pass `null` only when
 * the source genuinely has no date to offer (the legacy daemon observation).
 */
export function budgetMeter(
  spentUsd: number | null | undefined,
  capUsd: number | null | undefined,
  todayDate?: string | null,
  now: Date = new Date(),
): BudgetMeter {
  const spend = typeof spentUsd === 'number' && Number.isFinite(spentUsd) ? Math.max(0, spentUsd) : null;
  const cap = typeof capUsd === 'number' && Number.isFinite(capUsd) ? capUsd : null;
  // A cap of 0 is a statement about configuration, not about the ledger, so
  // it still reads true on a stale day and is checked first.
  const stale = typeof todayDate === 'string' && !isCurrentLedgerDay(todayDate, now);

  if (cap === 0) {
    return {
      state: 'stopped',
      percent: 100,
      label: `${formatUsd(spend)} spent today · budget $0.00`,
      note: 'Daily budget is $0 — the loop is stopped.',
    };
  }
  if (stale) {
    return {
      state: 'unknown',
      percent: null,
      label: `${UNKNOWN} spent today · budget ${formatUsd(cap)}`,
      // "Sep 1", not "2026-09-01": the ledger day is a calendar date, so it is
      // read as one (formatDayLabel parses it in UTC and cannot shift a day).
      note: `Nothing has been recorded today — the last ledger day is ${formatDayLabel(todayDate)}.`,
    };
  }
  if (cap === null || spend === null) {
    return {
      state: 'unknown',
      percent: null,
      label: cap === null ? `${formatUsd(spend)} spent today · budget ${UNKNOWN}` : `${UNKNOWN} spent today · budget ${formatUsd(cap)}`,
      note: cap === null ? 'Daily budget is not configured.' : "Today's spend is not observable right now.",
    };
  }

  const raw = (spend / cap) * 100;
  const percent = Math.min(100, Math.round(raw));
  const state: BudgetState = raw >= 100 ? 'over' : raw >= BUDGET_WARN_PERCENT ? 'warn' : 'ok';
  return {
    state,
    percent,
    // The text follows the one percent rule ("<1%", "99%" short of the cap); `percent` (the bar) stays numeric.
    label: `${formatUsd(spend)} of ${formatUsd(cap)} today · ${percentText((spend / cap) * 100)}`,
    note:
      state === 'over'
        ? 'Daily budget reached — the loop idles until the date rolls over.'
        : state === 'warn'
          ? `${formatUsd(cap - spend)} left before the loop idles today.`
          : `${formatUsd(cap - spend)} left today.`,
  };
}

/** Epoch ms of the next expected tick, or null when it cannot be derived. */
export function nextTickAt(lastTickAt: string | null | undefined, intervalMs: number | null | undefined): number | null {
  if (!lastTickAt) return null;
  const last = Date.parse(lastTickAt);
  if (Number.isNaN(last)) return null;
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  return last + intervalMs;
}

/** "in 4m 12s" / "due now" / "overdue by 2m 03s". */
export function countdownLabel(nextAt: number | null, now: number): string {
  if (nextAt === null) return UNKNOWN;
  const delta = nextAt - now;
  if (delta > 1000) return `in ${formatDuration(delta)}`;
  if (delta > -1000) return 'due now';
  return `overdue by ${formatDuration(-delta)}`;
}

/** Last tick outcome, phrased the way a person would say it out loud. */
export function describeTickOutcome(reason: string | null | undefined): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'unknown' } {
  if (!reason) return { label: 'no tick recorded', tone: 'unknown' };
  switch (reason) {
    case 'ok':
      return { label: 'ok', tone: 'success' };
    case 'kill-switch':
      return { label: 'refused — emergency stop engaged', tone: 'danger' };
    case 'budget-exhausted':
      return { label: 'stopped — daily budget spent', tone: 'warning' };
    case 'no-enrolled-repos':
      return { label: 'nothing to do — no repos enrolled', tone: 'warning' };
    case 'no-backlog':
      return { label: 'nothing to do — backlog empty', tone: 'neutral' };
    case 'dry-run':
      return { label: 'dry run', tone: 'neutral' };
    default:
      return { label: reason, tone: 'neutral' };
  }
}
