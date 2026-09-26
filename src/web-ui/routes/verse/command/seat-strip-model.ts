/**
 * routes/verse/command/seat-strip-model.ts — the one compact row of seats on
 * Command (audit 14 + 20). Pure: no React, no I/O.
 *
 * WHY THIS IS NOT BUILT FROM THE BURN-DOWNS. Command used to draw one tall
 * burn-down per seat from the budget route alone, and its free-seat card said
 * "Takes autonomous work" whatever the local runtime's readiness was — while
 * the rail said "readiness not reported" about the same seat. Every account
 * fact here now comes from the SAME projection the rail, the Resources drawer
 * and Apps & Accounts read (usage/capacity-strip-model.ts: `buildCapacityRows`,
 * `accountStatus`, `bindingLeftPercent`, `orderAccountRows`), so Command can
 * no longer describe a seat differently from the rail beside it.
 *
 * The one thing the budget route adds is autonomy eligibility (the router's
 * own verdict). When it says a seat takes autonomous work but readiness says
 * the seat cannot run (signed out, spent, offline, never reported), the two
 * sources disagree — and the strip says "Status unknown" and names both
 * claims, rather than picking the rosier one.
 *
 * The full burn-down charts live on Usage (SeatBurnPanel).
 */
import type { BudgetView } from '../../../../core/routing/policy.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { STATUS_WORDS, type BudgetSeatRow as BudgetRow, type BudgetSeatStatus } from '../budget/budget-model.js';
import { usedPercentText } from '../percent-text.js';
import {
  accountStatus,
  bindingLeftPercent,
  capacityHeadline,
  orderAccountRows,
  readBudgetRows,
  type AccountStatus,
  type CapacityRow,
} from '../usage/capacity-strip-model.js';
import { resetWords } from './command-model.js';

/** How the item's meter and value are toned. A word always rides with it. */
export type SeatLevel = 'ok' | 'low' | 'out' | 'unknown';

/**
 *   eligible / held / off / no-reading  the budget route's own verdict
 *   conflict   the budget says eligible, readiness says the seat cannot run
 *   none       the budget route has not answered
 */
export type SeatAutonomyKind = 'eligible' | 'held' | 'off' | 'no-reading' | 'conflict' | 'none';

export interface SeatAutonomy {
  kind: SeatAutonomyKind;
  /** Short chip text: "Eligible", "Held back", "Off", "No reading", "Status unknown", "Not reported". */
  word: string;
  /** The router's reason, or — for a conflict — both sources' claims. Null when there is nothing to add. */
  why: string | null;
}

export interface SeatStripItem {
  key: string;
  engine: 'claude' | 'codex' | 'grok' | 'local';
  name: string;
  /** 0–100 left in the binding window; null when there is no reading (never a substituted zero). */
  leftPercent: number | null;
  level: SeatLevel;
  /** The value beside the name: "72% left", "Spent", "Signed out", "Free", "—". */
  value: string;
  /** "resets Fri 11:46 PM", the provider's own words, or the status phrase when no reset applies. */
  note: string | null;
  /** The rail's status label for the same seat ("Connected", "Checking…", "Ready", "Not checked"). */
  status: string;
  autonomy: SeatAutonomy;
  /**
   * The share of the binding window kept for the operator (0–100), drawn as a
   * tick on the meter: autonomy stops where the remaining share meets it.
   * Null when there is no reserve or autonomy is off for the seat.
   */
  reservePercent: number | null;
  /** "Reserved for you 40%" / "Autonomy off — all yours"; null when the budget has no policy row. */
  reserveLabel: string | null;
  /** The item's accessible name (the button also says it opens Resources). */
  spoken: string;
}

export interface SeatStrip {
  items: SeatStripItem[];
  /** "2 of 3 accounts usable · local models ready" — the strip's caption. */
  headline: string;
}

const LEVEL_OF_STATUS: Readonly<Record<AccountStatus['kind'], SeatLevel>> = {
  usable: 'ok',
  low: 'low',
  spent: 'out',
  'signed-out': 'out',
  unavailable: 'out',
  checking: 'unknown',
  'not-checked': 'unknown',
};

/** Readiness kinds that do not contradict "autonomy may use it now". */
const RUNNABLE: ReadonlySet<AccountStatus['kind']> = new Set(['usable', 'low', 'checking']);


function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Eligibility for one row: its own budget row, or — for the folded local row — every free seat's. */
function budgetFor(row: CapacityRow, budget: ReadonlyMap<string, BudgetRow>): { status: BudgetSeatStatus; why: string } | null {
  const own = budget.get(row.seatId);
  if (own) return { status: own.status, why: own.why };
  if (row.kind !== 'local') return null;
  const locals = [...budget.values()].filter((b) => b.free || b.engine === 'local');
  if (locals.length === 0) return null;
  // One runtime behind every local tag: any tag autonomy may use means the runtime is wanted.
  const pick = (s: BudgetSeatStatus) => locals.find((b) => b.status === s);
  const chosen = pick('eligible') ?? pick('held') ?? pick('unknown') ?? locals[0]!;
  return { status: chosen.status, why: chosen.why };
}

const AUTONOMY_KIND: Readonly<Record<BudgetSeatStatus, SeatAutonomyKind>> = {
  eligible: 'eligible',
  held: 'held',
  off: 'off',
  unknown: 'no-reading',
};

/**
 * The autonomy chip. Exported for tests: the conflict rule is the point of
 * this module (audit 20).
 */
export function seatAutonomy(budget: { status: BudgetSeatStatus; why: string } | null, status: AccountStatus, budgetRead: boolean): SeatAutonomy {
  if (!budget) return { kind: 'none', word: 'Not reported', why: budgetRead ? 'The budget route does not list this seat.' : null };
  if (budget.status === 'eligible' && !RUNNABLE.has(status.kind)) {
    const readiness = `${status.label}${status.detail ? ` — ${status.detail}` : ''}`;
    return {
      kind: 'conflict',
      word: 'Status unknown',
      why: `The router lists it as eligible for autonomy, but its readiness check says: ${readiness}.`,
    };
  }
  return { kind: AUTONOMY_KIND[budget.status], word: STATUS_WORDS[budget.status], why: budget.why ? sentence(budget.why) : null };
}

/** The reset phrase for a row: the binding window's own wording, always led by "resets". */
function resetOf(row: CapacityRow, status: AccountStatus): string | null {
  // A spent seat's status already names the reset that brings it back (the LAST spent window's).
  if (status.kind === 'spent') return status.detail;
  const binding = row.windows.find((w) => w.binding) ?? null;
  return binding?.resetText ? resetWords(binding.resetText) : null;
}

function itemFor(row: CapacityRow, budget: ReadonlyMap<string, BudgetRow>, opts: { healthRead: boolean; budgetRead: boolean; now: number }): SeatStripItem {
  const status = accountStatus(row, { healthRead: opts.healthRead, now: opts.now });
  const autonomy = seatAutonomy(budgetFor(row, budget), status, opts.budgetRead);
  const level = LEVEL_OF_STATUS[status.kind] ?? 'unknown';
  const statusPhrase = `${status.label}${status.detail ? ` · ${status.detail}` : ''}`;
  let left: number | null;
  let value: string;
  let note: string | null;
  if (row.kind === 'local') {
    // No quota to run out of: the value is what the runtime is, never a percent.
    left = null;
    value = status.kind === 'usable' ? 'Free' : status.kind === 'unavailable' ? 'Offline' : '—';
    note = status.kind === 'usable' ? 'Runs on this machine' : status.kind === 'checking' ? 'Checking…' : status.detail ?? status.label;
  } else {
    left = level === 'out' ? 0 : bindingLeftPercent(row);
    value = level === 'out' ? status.label : left === null ? '—' : `${usedPercentText(left)} left`;
    note = resetOf(row, status) ?? (left === null ? statusPhrase : null);
  }
  const name = row.kind === 'local' && row.localCount > 1 ? `Local models (${row.localCount})` : row.label;
  const spoken = [
    `${name}: ${value}`,
    note && note !== statusPhrase ? note : null,
    statusPhrase,
    `Autonomy: ${autonomy.word}`,
  ].filter((p): p is string => p !== null).join('. ');
  const kept = row.reserve?.percent ?? null;
  const reservePercent = kept !== null && kept > 0 ? kept : null;
  return {
    key: row.seatId,
    engine: row.engine,
    name,
    leftPercent: left,
    level,
    value,
    note,
    status: status.label,
    autonomy,
    reservePercent,
    reserveLabel: row.reserve?.label ?? null,
    spoken,
  };
}

/**
 * Before the seat roster has loaded (or on a server without one), the budget
 * route alone: name, the binding window's remaining share and its reset — and
 * readiness said to be unknown, never assumed.
 */
function budgetOnlyItems(view: BudgetView, now: number): SeatStripItem[] {
  const rows = readBudgetRows(view);
  const out: SeatStripItem[] = [];
  for (const b of rows.values()) {
    const h = b.headroom;
    const used = h?.bindingWindow === 'weekly' ? h.weeklyUsedPercent : h?.bindingWindow === 'session' ? h.sessionUsedPercent : null;
    const left = b.free || used === null || used === undefined ? null : Math.max(0, Math.min(100, 100 - used));
    const when = describeResetAt(h?.resetAt ?? null, now);
    const autonomy: SeatAutonomy = { kind: AUTONOMY_KIND[b.status], word: STATUS_WORDS[b.status], why: b.why ? sentence(b.why) : null };
    const value = b.free ? '—' : left === null ? '—' : `${usedPercentText(left)} left`;
    const note = b.free ? 'Readiness not reported' : when ? `resets ${when}` : null;
    out.push({
      key: b.seatId,
      engine: b.engine,
      name: b.label,
      leftPercent: left,
      level: left === null ? 'unknown' : left <= 0 ? 'out' : 'ok',
      value,
      note,
      status: 'Readiness not reported',
      autonomy,
      reservePercent: null,
      reserveLabel: null,
      spoken: [`${b.label}: ${value}`, note, 'Readiness not reported', `Autonomy: ${autonomy.word}`].filter(Boolean).join('. '),
    });
  }
  return out.sort((a, b) => Number(a.engine === 'local') - Number(b.engine === 'local') || a.name.localeCompare(b.name));
}

export interface SeatStripInputs {
  /** Capacity rows (`buildCapacityRows`) — the rail's own projection of the roster. */
  rows: readonly CapacityRow[];
  /** The budget view, for autonomy eligibility; null before it answers. */
  budget: BudgetView | null;
  /** False until the health sweep has answered once. */
  healthRead: boolean;
  now: number;
}

export function seatStrip({ rows, budget, healthRead, now }: SeatStripInputs): SeatStrip {
  if (rows.length === 0) {
    const items = budget ? budgetOnlyItems(budget, now) : [];
    return { items, headline: items.length === 0 ? 'No seats reported yet' : 'Seat roster not loaded — readiness unknown' };
  }
  const budgetRows = readBudgetRows(budget);
  const ordered = orderAccountRows(rows, { healthRead, now });
  return {
    items: ordered.map((row) => itemFor(row, budgetRows, { healthRead, budgetRead: budget !== null, now })),
    headline: capacityHeadline(rows),
  };
}

/**
 * How many equal columns the strip uses, so every row is full or nearly so
 * (audit 15: no blank half-rows): all seats on one line when they fit, else
 * balanced rows — four seats are 4 across when wide and 2 x 2 at medium,
 * never 3 + a lonely 1. Compact is one per line.
 */
export function stripColumns(viewport: 'compact' | 'medium' | 'wide', count: number): number {
  const n = Math.max(1, Math.floor(count));
  if (viewport === 'compact') return 1;
  const perRow = viewport === 'medium' ? 3 : 5;
  if (n <= perRow) return viewport === 'medium' && n === 4 ? 2 : n;
  const rows = Math.ceil(n / perRow);
  return Math.ceil(n / rows);
}
