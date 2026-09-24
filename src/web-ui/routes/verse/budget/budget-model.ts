/**
 * routes/verse/budget/budget-model.ts — pure view-model for the Budget panel.
 *
 * Turns a `BudgetView` (GET /api/verse/budget) into one row per seat: who it
 * is, the policy in force, a one-line verdict, and the geometry of its
 * headroom bars. No React, no fetch — so every honesty rule is unit-tested
 * here rather than asserted through the DOM.
 *
 * HONESTY RULES (docs/VERSE-TELEMETRY-V2.md):
 *  - Unknown is not zero. A window with no reading renders as `unknown`
 *    (dashed track + words), never an empty bar ("plenty left") or a full one
 *    ("exhausted").
 *  - The verdict is always a WORD (Eligible / Held back / Off / No reading);
 *    colour only reinforces it.
 *  - The "why" line is the server's own sentence, verbatim.
 */
import {
  MODE_DESCRIPTIONS,
  type BudgetEngine,
  type BudgetView,
} from '../../../../core/routing/policy.js';
import type { BudgetMode, SeatBudgetPolicy, SeatHeadroom } from '../../../../core/routing/types.js';

export type BudgetSeatStatus = 'eligible' | 'held' | 'off' | 'unknown';

export const STATUS_WORDS: Readonly<Record<BudgetSeatStatus, string>> = {
  eligible: 'Eligible',
  held: 'Held back',
  off: 'Off',
  unknown: 'No reading',
};

/** One horizontal headroom bar (a usage window against its autonomy ceiling). */
export interface BudgetBar {
  kind: 'weekly' | 'session';
  label: string;
  /** 0–100, or null when this window has no reading. */
  usedPercent: number | null;
  /** Where autonomy stops (0–100). 100 = no ceiling. */
  ceilingPercent: number;
  /** Plain-language summary for screen readers and the table view. */
  description: string;
  /** True when this bar is the one binding autonomy right now. */
  binding: boolean;
}

export interface BudgetSeatRow {
  seatId: string;
  label: string;
  engine: BudgetEngine;
  free: boolean;
  policy: SeatBudgetPolicy;
  headroom: SeatHeadroom | null;
  status: BudgetSeatStatus;
  /** First server reason, verbatim. */
  why: string;
  /** Remaining server reasons, verbatim. */
  more: string[];
  bars: BudgetBar[];
  /** Whether the 5-hour ceiling control applies (subscription seats with a short window). */
  hasSessionCeiling: boolean;
}

export const BUDGET_MODE_OPTIONS: ReadonlyArray<{ value: BudgetMode; label: string; description: string }> = [
  { value: 'reserve', label: 'Reserve', description: MODE_DESCRIPTIONS.reserve },
  { value: 'balanced', label: 'Balanced', description: MODE_DESCRIPTIONS.balanced },
  { value: 'all-in', label: 'All-in', description: MODE_DESCRIPTIONS['all-in'] },
];

function round(n: number): number {
  return Math.round(n);
}

function statusOf(free: boolean, policy: SeatBudgetPolicy, headroom: SeatHeadroom | null): BudgetSeatStatus {
  if (!policy.enabled) return 'off';
  if (headroom?.eligibleForAutonomy) return 'eligible';
  if (!free && (headroom === null || (headroom.sessionUsedPercent === null && headroom.weeklyUsedPercent === null))) {
    return 'unknown';
  }
  return 'held';
}

function barsFor(engine: BudgetEngine, free: boolean, policy: SeatBudgetPolicy, h: SeatHeadroom | null): BudgetBar[] {
  if (free || h === null) return [];
  const bars: BudgetBar[] = [];
  const reserveCeiling = 100 - policy.reservePercent;
  const hasWeekly = h.weeklyUsedPercent !== null || engine === 'claude' || engine === 'grok';
  if (hasWeekly) {
    const used = h.weeklyUsedPercent;
    bars.push({
      kind: 'weekly',
      label: engine === 'grok' ? 'Billing period' : 'Weekly',
      usedPercent: used,
      ceilingPercent: reserveCeiling,
      binding: h.bindingWindow === 'weekly',
      description: used === null
        ? 'Weekly window: no reading.'
        : `Weekly window ${round(used)}% used; autonomy stops at ${round(reserveCeiling)}%, ${round(policy.reservePercent)}% kept for you.`,
    });
  }
  if (h.sessionUsedPercent !== null || engine === 'claude') {
    const used = h.sessionUsedPercent;
    const sessionCeiling = policy.maxSessionWindowPercent ?? 100;
    const ceiling = hasWeekly ? sessionCeiling : Math.min(sessionCeiling, reserveCeiling);
    bars.push({
      kind: 'session',
      label: '5-hour',
      usedPercent: used,
      ceilingPercent: ceiling,
      binding: h.bindingWindow === 'session',
      description: used === null
        ? '5-hour window: no reading.'
        : `5-hour window ${round(used)}% used; ${ceiling >= 100 ? 'no autonomy ceiling' : `autonomy stops at ${round(ceiling)}%`}.`,
    });
  }
  return bars;
}

/** Rows in the server's seat order (which lists the operator's preferred local tags first). */
export function buildBudgetRows(view: BudgetView): BudgetSeatRow[] {
  const headroomById = new Map(view.headroom.map((h) => [h.seatId, h]));
  return view.seatInfo.map((info) => {
    const policy = view.effective[info.seatId] ?? { seatId: info.seatId, enabled: false, reservePercent: 100 };
    const headroom = headroomById.get(info.seatId) ?? null;
    const reasons = headroom?.reasons ?? [];
    return {
      seatId: info.seatId,
      label: info.label,
      engine: info.engine,
      free: info.free,
      policy,
      headroom,
      status: statusOf(info.free, policy, headroom),
      why: reasons[0] ?? (info.free ? 'Local model — free.' : 'No reading yet.'),
      more: reasons.slice(1),
      bars: barsFor(info.engine, info.free, policy, headroom),
      hasSessionCeiling: !info.free && (info.engine === 'claude' || info.engine === 'codex'),
    };
  });
}

/** Headline counts for the panel summary ("3 of 7 seats can take autonomous work"). */
export function budgetSummary(rows: readonly BudgetSeatRow[]): { eligible: number; total: number; sentence: string } {
  const eligible = rows.filter((r) => r.status === 'eligible').length;
  const total = rows.length;
  if (total === 0) return { eligible, total, sentence: 'No seats are known yet.' };
  const paid = rows.filter((r) => r.status === 'eligible' && !r.free).length;
  const free = eligible - paid;
  const parts: string[] = [];
  if (paid > 0) parts.push(`${paid} paid`);
  if (free > 0) parts.push(`${free} local`);
  return {
    eligible,
    total,
    sentence: eligible === 0
      ? 'No seat can take autonomous work right now.'
      : `${eligible} of ${total} seats can take autonomous work (${parts.join(', ')}).`,
  };
}

/** Human age of the readings, e.g. "just now", "4 min ago". */
export function readingAge(sampledAt: string, nowMs: number): string {
  const t = Date.parse(sampledAt);
  if (!Number.isFinite(t)) return 'unknown';
  const minutes = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 120) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** Clamp a slider value to the range the API accepts. */
export function clampPercent(value: number, low = 0, high = 100): number {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, Math.round(value)));
}
