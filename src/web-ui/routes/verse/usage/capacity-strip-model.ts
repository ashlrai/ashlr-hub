/**
 * routes/verse/usage/capacity-strip-model.ts — ONE projection of "how much of
 * each seat is left, what is it tied to, and how much is kept for me", for
 * every surface that shows seat capacity (SPEC-310C §4: Apps & Accounts,
 * Usage, Resources, NewChatDialog, onboarding; the rail foot's capacity ring
 * and the composer's seat chip read `scarcestSeat` / `capacityRowFor`).
 *
 * Three sources, each already cached app-wide, each read HERE and nowhere
 * else so a seat is never described two ways:
 *   - the seat itself (`VerseSeat`, from bootstrap / the /seats poll) — plan,
 *     windows, resets, credits, through `seat-subscription.ts`, which owns the
 *     honesty rules (binding window leads, no reading ≠ zero, the sentinel 100
 *     is a flag, prose resets stay prose);
 *   - A2's health report — connected / expiring / signed out / older CLI, and
 *     the command that fixes it;
 *   - A9's budget view — the reserve kept for Mason and whether autonomy may
 *     use the seat right now, through `budget-model.ts`'s own rows.
 * Any of the last two may be missing; the row then says less, never more.
 *
 * Pure: no React, no I/O.
 */
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatBudgetPolicy, SeatHeadroom } from '../../../../core/routing/types.js';
import type { SeatConnection, SeatFixKind, SeatHealthReport } from '../../../../core/verse/health-types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { ENGINE_MONOGRAM } from '../../../../core/verse/workbench-types.js';
import type { VerseEngine, VerseSeat } from '../../../data/api-types.js';
import { buildBudgetRows, STATUS_WORDS, type BudgetSeatStatus } from '../budget/budget-model.js';
import { relativePhrase } from '../context/context-model.js';
import { formatWholePercent, tidyProse } from '../autonomy/format.js';
import { CONNECTION_TONE, CONNECTION_WORD, usableAgainPhrase, type HealthTone } from '../health/health-model.js';
import { formatResetInstant, seatSubscription, type SeatCapacityClass, type SeatWindowView } from '../seat-subscription.js';
import { SEAT_CAPACITY_WORD } from '../verse-model.js';

export type { SeatCapacityClass };

type BudgetRow = ReturnType<typeof buildBudgetRows>[number];

/** Rows show at most this many windows: the binding one and the next two. */
export const CAPACITY_MAX_WINDOWS = 3;

export interface CapacityWindowRow {
  id: string;
  /** "5-hour window", "weekly window", "weekly fable window". */
  label: string;
  /** 0–100, or null = no reading (never a substituted zero). */
  usedPercent: number | null;
  /** The provider flagged the limit; no percentage exists. */
  limitReached: boolean;
  /** Provider prose verbatim, or a formatted local instant; null when neither. */
  resetText: string | null;
  /** The machine-readable reset instant (ISO), when the provider gave one. */
  resetsAt: string | null;
  /** True for the window that constrains work right now. */
  binding: boolean;
}

export interface CapacityConnection {
  connection: SeatConnection;
  word: string;
  tone: HealthTone;
  /** Plain, already-scrubbed reasons; empty when connected. */
  reasons: string[];
  fixKind: SeatFixKind;
  /** argv; null when nothing fixes it from a terminal. */
  fixCommand: string[] | null;
}

export interface CapacityReserve {
  /** Share of the binding window kept for Mason; null when autonomy is off for this seat. */
  percent: number | null;
  /** "Reserved for you 40%", "Autonomy off — all yours", "No reserve". */
  label: string;
  autonomy: BudgetSeatStatus;
  /** "Eligible", "Held back", "Off", "No reading". */
  autonomyWord: string;
  /** The router's own first reason, verbatim. */
  why: string;
}

export interface CapacityRow {
  /** A seat id, or `local` for the collapsed local row. */
  seatId: string;
  label: string;
  engine: VerseEngine;
  monogram: string;
  kind: 'subscription' | 'local';
  plan: string | null;
  cls: SeatCapacityClass;
  /** usable / tight / blocked / no reading. */
  word: string;
  /** One phrase: "62% of 5-hour window used", "signed out — reconnect this account". */
  summary: string;
  connection: CapacityConnection | null;
  windows: CapacityWindowRow[];
  credits: string | null;
  reserve: CapacityReserve | null;
  notes: string[];
  /** For the collapsed local row: how many local seats it stands for. */
  localCount: number;
  /** When this seat was last checked (health sweep, else the usage reading), ISO; null when never. */
  checkedAt: string | null;
  /** The instant a spent seat becomes usable again (ISO), when one is known. */
  resetAt: string | null;
  /** The account is signed out — by the health sweep or by its own capacity record. */
  signedOut: boolean;
}

export interface CapacityInputs {
  health?: readonly SeatHealthReport[] | null;
  budget?: BudgetView | null;
  /**
   * Local seats: `collapse` (default) folds every Ollama tag into one row —
   * they share one machine and one readiness, and twelve identical rows are
   * noise; `each` lists them; `hide` drops them.
   */
  local?: 'collapse' | 'each' | 'hide';
  /** Only these seats, in this order (the new-chat dialog passes the chosen one). */
  seatIds?: readonly string[];
}

const TONE_OF_CLASS: Record<SeatCapacityClass, HealthTone> = {
  ready: 'success',
  tight: 'warning',
  blocked: 'danger',
  unread: 'neutral',
};

/** How a capacity class reads as a tone (a word always rides with it). */
export function capacityTone(cls: SeatCapacityClass): HealthTone {
  return TONE_OF_CLASS[cls];
}

/**
 * A reset formatted from a machine instant reads the way every other reset in
 * the app does ("resets Fri 11:46 PM", via `describeResetAt`). Provider prose
 * is left exactly as given — it is only rewritten when it IS the instant
 * formatted by seat-subscription, never when the provider wrote it.
 */
function resetTextOf(w: SeatWindowView): string | null {
  if (w.resetsAt === null || w.resetText === null || w.resetText !== formatResetInstant(w.resetsAt)) return w.resetText;
  const when = describeResetAt(w.resetsAt);
  return when === null ? w.resetText : `resets ${when}`;
}

function windowRow(w: SeatWindowView, binding: boolean): CapacityWindowRow {
  return {
    id: w.id,
    label: w.label,
    usedPercent: w.usedPercent,
    limitReached: w.limitReached,
    resetText: resetTextOf(w),
    resetsAt: w.resetsAt,
    binding,
  };
}

function parseable(iso: string | null | undefined): iso is string {
  return typeof iso === 'string' && Number.isFinite(Date.parse(iso));
}

/**
 * When a spent seat comes back: the health sweep's own reset, else the
 * earliest instant among the windows that are actually spent, else the
 * binding window's. Null when no window carries a machine instant (Claude's
 * resets are prose, and prose is never parsed).
 */
function resetInstant(report: SeatHealthReport | undefined, windows: readonly CapacityWindowRow[]): string | null {
  if (parseable(report?.resetAt)) return report!.resetAt;
  const spent = windows
    .filter((w) => (w.limitReached || (w.usedPercent !== null && w.usedPercent >= 100)) && parseable(w.resetsAt))
    .map((w) => w.resetsAt!)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  if (spent.length > 0) return spent[0]!;
  const binding = windows.find((w) => w.binding) ?? null;
  return binding !== null && parseable(binding.resetsAt) ? binding.resetsAt : null;
}

function connectionOf(report: SeatHealthReport | undefined): CapacityConnection | null {
  if (!report) return null;
  return {
    connection: report.connection,
    word: CONNECTION_WORD[report.connection],
    tone: CONNECTION_TONE[report.connection],
    reasons: readableReasons(report.reasons),
    fixKind: report.fix.kind,
    fixCommand: report.fix.command && report.fix.command.length > 0 ? [...report.fix.command] : null,
  };
}

/** Reasons as printed: server sentences with any ISO instant shown in local time. */
function readableReasons(reasons: readonly string[]): string[] {
  const now = Date.now();
  return reasons.map((r) => tidyProse(r, now).trim()).filter((r) => r.length > 0);
}

function reserveOf(budgetRow: BudgetRow | undefined): CapacityReserve | null {
  if (!budgetRow || budgetRow.free) return null;
  const { policy } = budgetRow;
  const pct = Math.max(0, Math.min(100, Math.round(policy.reservePercent)));
  const label = !policy.enabled
    ? 'Autonomy off — all yours'
    : pct === 0
      ? 'No reserve — autonomy may use all of it'
      : `Reserved for you ${pct}%`;
  return {
    percent: policy.enabled ? pct : null,
    label,
    autonomy: budgetRow.status,
    autonomyWord: STATUS_WORDS[budgetRow.status],
    why: budgetRow.why,
  };
}

function seatRow(
  seat: VerseSeat,
  health: ReadonlyMap<string, SeatHealthReport>,
  budget: ReadonlyMap<string, BudgetRow>,
): CapacityRow {
  const view = seatSubscription(seat);
  const windows: CapacityWindowRow[] = [];
  if (view.binding) windows.push(windowRow(view.binding, true));
  for (const w of view.others) {
    if (windows.length >= CAPACITY_MAX_WINDOWS) break;
    windows.push(windowRow(w, false));
  }
  const report = health.get(seat.id);
  const connection = connectionOf(report);
  // A seat A2 found signed out or out of usage cannot run a turn, whatever
  // its last window reading says (the engine's readiness gate refuses it —
  // seat-readiness.ts SEAT_BLOCKING_CONNECTIONS). Counting it "usable"
  // would promise a chat the engine will refuse.
  const blockedByHealth = connection !== null && (connection.connection === 'signed-out' || connection.connection === 'exhausted');
  return {
    seatId: seat.id,
    label: seat.label,
    engine: seat.engine,
    monogram: ENGINE_MONOGRAM[seat.engine],
    kind: view.kind,
    plan: view.plan,
    cls: blockedByHealth ? 'blocked' : view.cls,
    word: blockedByHealth ? SEAT_CAPACITY_WORD.blocked : view.word,
    summary: blockedByHealth ? (connection.reasons[0] ?? connection.word) : view.summary,
    connection,
    windows,
    credits: view.credits,
    reserve: reserveOf(budget.get(seat.id)),
    notes: [...view.notes],
    localCount: 1,
    checkedAt: parseable(report?.checkedAt) ? report!.checkedAt : parseable(view.observedAt) ? view.observedAt : null,
    resetAt: resetInstant(report, windows),
    signedOut: connection?.connection === 'signed-out' || seat.capacity?.usability === 'signed-out',
  };
}

function collapsedLocal(seats: readonly VerseSeat[], health: ReadonlyMap<string, SeatHealthReport>): CapacityRow {
  const rows = seats.map((s) => seatSubscription(s));
  const ready = rows.filter((r) => r.cls === 'ready').length;
  const blocked = rows.filter((r) => r.cls === 'blocked').length;
  const cls: SeatCapacityClass = ready > 0 ? 'ready' : blocked === rows.length ? 'blocked' : 'unread';
  // One runtime behind every tag: the first report that says anything speaks for it.
  const report = seats.map((s) => health.get(s.id)).find((r) => r !== undefined);
  const count = seats.length;
  return {
    seatId: 'local',
    label: 'Local models',
    engine: 'local',
    monogram: ENGINE_MONOGRAM.local,
    kind: 'local',
    plan: null,
    cls,
    word: rows.find((r) => r.cls === cls)?.word ?? 'no reading',
    summary: cls === 'ready'
      ? `${count} ${count === 1 ? 'model' : 'models'} on this machine · free`
      : cls === 'blocked'
        ? (rows[0]?.summary ?? 'local runtime unavailable')
        : 'readiness not reported',
    connection: connectionOf(report),
    windows: [],
    credits: null,
    reserve: null,
    notes: [],
    localCount: count,
    checkedAt: parseable(report?.checkedAt)
      ? report!.checkedAt
      : rows.map((r) => r.observedAt).filter(parseable).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
    resetAt: null,
    signedOut: false,
  };
}

// ---------------------------------------------------------------------------
// Tolerant readers
// ---------------------------------------------------------------------------
//
// WHY THESE EXIST. The strip is mounted on five surfaces (Apps, Usage,
// onboarding, NewChatDialog, the rail ring via scarcestSeat) and renders
// synchronously from three cached server reads. The types say what a healthy
// server sends, but the cache holds whatever arrived: a `{}` from a budget
// route that has not landed on an older sidecar, a half-written health file,
// a future field shape. One `undefined.map` inside `useMemo` takes the whole
// surface down with it (INT6 found exactly that with `/api/verse/budget` →
// `{}`). So each optional source is checked HERE, at the one boundary every
// view shares, and the rule is the module's own: a source that cannot be
// read makes the row say LESS, never crash and never invent. A bad entry is
// dropped on its own; the rest of the source still speaks.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nullablePercent = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function readHeadroom(value: unknown): SeatHeadroom | null {
  if (!isRecord(value) || typeof value['seatId'] !== 'string') return null;
  const binding = value['bindingWindow'];
  return {
    seatId: value['seatId'],
    sessionUsedPercent: nullablePercent(value['sessionUsedPercent']),
    weeklyUsedPercent: nullablePercent(value['weeklyUsedPercent']),
    bindingWindow: binding === 'session' || binding === 'weekly' ? binding : null,
    autonomyHeadroomPercent: nullablePercent(value['autonomyHeadroomPercent']),
    resetAt: typeof value['resetAt'] === 'string' ? value['resetAt'] : null,
    // Only an explicit `true` makes a seat eligible — a garbled flag is "not known to be eligible".
    eligibleForAutonomy: value['eligibleForAutonomy'] === true,
    reasons: Array.isArray(value['reasons']) ? value['reasons'].filter((r): r is string => typeof r === 'string') : [],
  };
}

function readPolicy(seatId: string, value: unknown): SeatBudgetPolicy | null {
  if (!isRecord(value) || typeof value['enabled'] !== 'boolean') return null;
  const reserve = value['reservePercent'];
  if (typeof reserve !== 'number' || !Number.isFinite(reserve)) return null;
  const out: SeatBudgetPolicy = { seatId, enabled: value['enabled'], reservePercent: reserve };
  const session = value['maxSessionWindowPercent'];
  if (typeof session === 'number' && Number.isFinite(session)) out.maxSessionWindowPercent = session;
  return out;
}

/**
 * The budget view → rows keyed by seat, or an empty map when the view cannot
 * be read. A seat whose policy entry is present but malformed is DROPPED
 * rather than handed to budget-model's "no policy → off" default: that default
 * is right for a seat the server genuinely has no policy for, but for a
 * garbled entry it would print "Autonomy off — all yours", a claim nobody
 * made.
 */
export function readBudgetRows(view: unknown): Map<string, BudgetRow> {
  if (!isRecord(view) || !Array.isArray(view['seatInfo'])) return new Map();
  const effectiveIn = isRecord(view['effective']) ? view['effective'] : {};
  const effective: Record<string, SeatBudgetPolicy> = {};
  const seatInfo: BudgetView['seatInfo'] = [];
  for (const info of view['seatInfo']) {
    if (!isRecord(info) || typeof info['seatId'] !== 'string') continue;
    const seatId = info['seatId'];
    const engine = info['engine'];
    if (engine !== 'claude' && engine !== 'codex' && engine !== 'grok' && engine !== 'local') continue;
    if (Object.prototype.hasOwnProperty.call(effectiveIn, seatId)) {
      const policy = readPolicy(seatId, effectiveIn[seatId]);
      if (policy === null) continue;
      effective[seatId] = policy;
    }
    seatInfo.push({
      seatId,
      label: typeof info['label'] === 'string' ? info['label'] : seatId,
      engine,
      free: info['free'] === true,
    });
  }
  const headroom = Array.isArray(view['headroom'])
    ? view['headroom'].map(readHeadroom).filter((h): h is SeatHeadroom => h !== null)
    : [];
  const safe = { ...(view as unknown as BudgetView), seatInfo, effective, headroom };
  try {
    return new Map(buildBudgetRows(safe).map((r) => [r.seatId, r]));
  } catch {
    // Belt and braces: budget-model is pure and the input is now well-typed,
    // but a reserve line is never worth a blank strip.
    return new Map();
  }
}

/** Health reports keyed by seat, keeping only reports that can be described honestly. */
export function readHealthReports(reports: unknown): Map<string, SeatHealthReport> {
  const out = new Map<string, SeatHealthReport>();
  if (!Array.isArray(reports)) return out;
  for (const r of reports) {
    if (!isRecord(r) || typeof r['seatId'] !== 'string') continue;
    const connection = r['connection'];
    // An unknown connection word has no tone or wording — describing it
    // would mean guessing; the row falls back to its window reading.
    if (typeof connection !== 'string' || !Object.prototype.hasOwnProperty.call(CONNECTION_WORD, connection)) continue;
    const fix = isRecord(r['fix']) ? r['fix'] : {};
    const kind = fix['kind'];
    const command = Array.isArray(fix['command']) && fix['command'].every((a) => typeof a === 'string')
      ? (fix['command'] as string[])
      : undefined;
    out.set(r['seatId'], {
      ...(r as unknown as SeatHealthReport),
      reasons: Array.isArray(r['reasons']) ? r['reasons'].filter((x): x is string => typeof x === 'string') : [],
      fix: {
        kind: kind === 'reauth' || kind === 'repin' || kind === 'wait' ? kind : 'none',
        ...(command ? { command } : {}),
      },
    });
  }
  return out;
}

/** Seats → rows, in the roster's own order (the server lists the operator's preferred seats first). */
export function buildCapacityRows(seats: readonly VerseSeat[], inputs: CapacityInputs = {}): CapacityRow[] {
  const health = readHealthReports(inputs.health);
  const budget = readBudgetRows(inputs.budget);
  // The roster comes from bootstrap; a malformed one reads as "no seats yet",
  // the strip's honest empty state, rather than a crash.
  const roster = Array.isArray(seats)
    ? seats.filter((s): s is VerseSeat => isRecord(s) && typeof (s as { id?: unknown }).id === 'string')
    : [];
  const localMode = inputs.local ?? 'collapse';
  let chosen: readonly VerseSeat[] = roster;
  if (inputs.seatIds) {
    const byId = new Map(roster.map((s) => [s.id, s]));
    chosen = inputs.seatIds.map((id) => byId.get(id)).filter((s): s is VerseSeat => s !== undefined);
  }
  const out: CapacityRow[] = [];
  const locals: VerseSeat[] = [];
  let localIndex = -1;
  for (const seat of chosen) {
    if (seat.engine === 'local') {
      if (localMode === 'hide') continue;
      if (localMode === 'collapse') {
        if (localIndex === -1) localIndex = out.length;
        locals.push(seat);
        continue;
      }
    }
    out.push(seatRow(seat, health, budget));
  }
  if (locals.length > 0) {
    // A single local seat keeps its own name; several fold into one row.
    const row = locals.length === 1 ? seatRow(locals[0]!, health, budget) : collapsedLocal(locals, health);
    out.splice(localIndex, 0, row);
  }
  return out;
}

/**
 * The strip's one sentence: how many paid seats are usable, and what local
 * adds. Counts only what was READ — an unread seat is named as unread, never
 * folded into "blocked".
 */
export function capacityHeadline(rows: readonly CapacityRow[]): string {
  const paid = rows.filter((r) => r.kind === 'subscription');
  const local = rows.filter((r) => r.kind === 'local');
  const usable = paid.filter((r) => r.cls === 'ready' || r.cls === 'tight').length;
  const unread = paid.filter((r) => r.cls === 'unread').length;
  const parts: string[] = [];
  if (paid.length === 0) parts.push('No accounts connected');
  else parts.push(`${usable} of ${paid.length} ${paid.length === 1 ? 'account' : 'accounts'} usable`);
  if (unread > 0) parts.push(`${unread} not read yet`);
  if (local.some((r) => r.cls === 'ready')) parts.push('local models ready');
  else if (local.length > 0) parts.push('local models not ready');
  return parts.join(' · ');
}

/**
 * The seat closest to running out — the rail foot's capacity ring (C1).
 * Blocked beats tight beats a measured percent; unread seats never win,
 * because an empty ring would claim headroom nobody measured.
 */
export function scarcestSeat(rows: readonly CapacityRow[]): CapacityRow | null {
  let best: { row: CapacityRow; score: number } | null = null;
  for (const row of rows) {
    if (row.kind !== 'subscription') continue;
    const binding = row.windows.find((w) => w.binding) ?? null;
    let score: number;
    if (row.cls === 'blocked' || binding?.limitReached) score = 300;
    else if (binding?.usedPercent != null) score = (row.cls === 'tight' ? 100 : 0) + binding.usedPercent;
    else continue;
    if (best === null || score > best.score) best = { row, score };
  }
  return best?.row ?? null;
}

/** One seat's row (the composer's seat chip, C3), or null when the seat is not in the roster. */
export function capacityRowFor(seats: readonly VerseSeat[], seatId: string, inputs: Omit<CapacityInputs, 'seatIds' | 'local'> = {}): CapacityRow | null {
  return buildCapacityRows(seats, { ...inputs, seatIds: [seatId], local: 'each' })[0] ?? null;
}

/**
 * A measured share, printed the same way on every capacity surface: a whole
 * percent, except that a real reading under 1% is "<1%" (never "0%", which
 * would read as "untouched") and one just short of 100 is "99%" (never a
 * rounded "100%", which would read as "spent").
 */
export function percentText(used: number): string {
  if (!Number.isFinite(used)) return '—';
  const clamped = Math.max(0, Math.min(100, used));
  if (clamped > 99 && clamped < 100) return '99%';
  // The "<1%" rule is the app-wide one (autonomy/format `formatWholePercent`).
  return formatWholePercent(clamped / 100);
}

/** The accessible sentence for one window bar. */
export function windowSentence(row: Pick<CapacityRow, 'label'>, w: CapacityWindowRow, reservePercent: number | null): string {
  const head = `${row.label} ${w.label}`;
  const reset = w.resetText === null ? '' : `, ${w.resetText}`;
  if (w.limitReached) return `${head}: limit reached${reset}`;
  if (w.usedPercent === null) return `${head}: no reading${reset}`;
  const kept = reservePercent !== null && reservePercent > 0 ? `; ${reservePercent}% kept for you` : '';
  return `${head}: ${percentText(w.usedPercent)} used${kept}${reset}`;
}

// ---------------------------------------------------------------------------
// Account status (Apps & Accounts)
// ---------------------------------------------------------------------------

/**
 * - `usable`       — connected (or read as usable) with room left;
 * - `low`          — usable, but tight: past the warning line, or spent and running on credits;
 * - `spent`        — the binding window is used up; comes back at `resetAt`;
 * - `signed-out`   — needs the provider's own sign-in (Reconnect);
 * - `unavailable`  — blocked for another reason (runtime down, CLI missing);
 * - `not-checked`  — the health sweep has answered but said nothing usable about this seat;
 * - `checking`     — nothing has answered yet, or a check is running right now.
 */
export type AccountStatusKind = 'usable' | 'low' | 'spent' | 'signed-out' | 'unavailable' | 'not-checked' | 'checking';

export interface AccountStatus {
  kind: AccountStatusKind;
  /** Sentence case, leads the row: "Connected", "Spent", "Signed out", "Checking…". */
  label: string;
  /** Rides after a middle dot: "usable now", "resets Fri 11:46 PM", "reconnect to use it". */
  detail: string | null;
  tone: HealthTone;
  /** "usable again in 7h 12m" — only for a spent seat whose reset is still ahead. */
  usableAgain: string | null;
  /** "checked 2m ago"; null when the seat was never checked. */
  checked: string | null;
  /** The last check as a local date and time, for a tooltip. */
  checkedTitle: string | null;
  /** True when `label` already says what the connection word would (signed out, out of usage). */
  coversConnection: boolean;
}

export interface AccountStatusOptions {
  /** False until the health sweep has answered once: an unanswered seat is "Checking…", not "Not checked". */
  healthRead: boolean;
  /** A check of this seat is running right now. */
  checking?: boolean;
  now?: number;
}

const STATUS_TONE: Record<AccountStatusKind, HealthTone> = {
  usable: 'success',
  low: 'warning',
  spent: 'danger',
  'signed-out': 'danger',
  unavailable: 'danger',
  'not-checked': 'neutral',
  checking: 'neutral',
};

/** Usable first, then what will come back by itself, then what needs you. Used by `orderAccountRows`. */
const STATUS_RANK: Record<AccountStatusKind, number> = {
  usable: 0,
  low: 1,
  checking: 2,
  'not-checked': 3,
  spent: 4,
  unavailable: 5,
  'signed-out': 6,
};

function isSpentWindow(w: CapacityWindowRow): boolean {
  return w.limitReached || (w.usedPercent !== null && w.usedPercent >= 100);
}

function checkedParts(row: Pick<CapacityRow, 'checkedAt'>, now: number): { checked: string | null; checkedTitle: string | null } {
  const phrase = relativePhrase(row.checkedAt, now);
  if (phrase === null || row.checkedAt === null) return { checked: null, checkedTitle: null };
  const at = new Date(row.checkedAt);
  return {
    checked: `checked ${phrase}`,
    checkedTitle: `Last checked ${at.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
  };
}

/**
 * The one status an account row leads with, in the operator's words:
 *
 *   Connected · usable now            Spent · resets Fri 11:46 PM
 *   Connected · running low           Signed out · reconnect to use it
 *   Connected · usable on credits     Checking…
 *
 * Built from the row alone (no second reading of the seat), against a clock
 * the caller passes, because "usable again in 7h" must keep counting down
 * while the rows themselves are memoized on the data.
 */
export function accountStatus(row: CapacityRow, opts: AccountStatusOptions): AccountStatus {
  const now = opts.now ?? Date.now();
  const { checked, checkedTitle } = checkedParts(row, now);
  const make = (kind: AccountStatusKind, label: string, detail: string | null, extra: Partial<AccountStatus> = {}): AccountStatus => ({
    kind,
    label,
    detail,
    tone: STATUS_TONE[kind],
    usableAgain: null,
    checked,
    checkedTitle,
    coversConnection: false,
    ...extra,
  });

  if (opts.checking) return make('checking', 'Checking…', null);

  if (row.kind === 'local') {
    if (row.cls === 'ready') {
      return make('usable', 'Ready', row.localCount > 1 ? `${row.localCount} models on this machine · free` : 'runs on this machine · free');
    }
    if (row.cls === 'blocked') return make('unavailable', 'Not running', row.summary);
    return opts.healthRead ? make('not-checked', 'Not checked', 'readiness not reported yet') : make('checking', 'Checking…', null);
  }

  const c = row.connection?.connection ?? null;
  if (row.signedOut) return make('signed-out', 'Signed out', 'reconnect to use it', { coversConnection: true });

  const binding = row.windows.find((w) => w.binding) ?? null;
  const spent = c === 'exhausted' || (row.cls === 'blocked' && binding !== null && isSpentWindow(binding));
  if (spent) {
    const when = describeResetAt(row.resetAt, now);
    const ahead = row.resetAt !== null && Date.parse(row.resetAt) > now;
    // No instant: the provider's own reset prose, verbatim, is the next best thing.
    const prose = binding?.resetText ?? null;
    const detail = when !== null
      ? (ahead ? `resets ${when}` : `was due to reset ${when}`)
      : (prose ?? 'reset time not reported');
    return make('spent', 'Spent', detail, {
      usableAgain: usableAgainPhrase(row.resetAt, now),
      coversConnection: c === 'exhausted',
    });
  }

  if (row.cls === 'blocked') return make('unavailable', 'Unavailable', row.summary);

  // A seat nobody has read is not "fine" and not "broken": it is waiting on a check.
  if (row.cls === 'unread') {
    if (!opts.healthRead) return make('checking', 'Checking…', null);
    if (c === null || c === 'unknown') return make('not-checked', 'Not checked', 'no reading yet');
    return make('usable', 'Connected', 'no usage reading yet');
  }

  const lead = c === null || c === 'unknown' ? 'Usable' : 'Connected';
  if (row.cls === 'tight') {
    const onCredits = binding !== null && isSpentWindow(binding) && row.credits !== null;
    if (lead === 'Usable') return make('low', 'Usable', onCredits ? 'on credits' : 'running low');
    return make('low', lead, onCredits ? 'usable on credits' : 'running low');
  }
  return lead === 'Usable' ? make('usable', 'Usable now', null) : make('usable', 'Connected', 'usable now');
}

/**
 * Usable accounts first, then the ones that come back on their own, then the
 * ones that need you — stable within each group (the roster's own order), and
 * paid seats ahead of local ones of the same standing. Ordered on the settled
 * status (never on a running check), so a row does not jump while "Checking…".
 */
export function orderAccountRows(rows: readonly CapacityRow[], opts: Omit<AccountStatusOptions, 'checking'>): CapacityRow[] {
  const ranked = rows.map((row, index) => ({
    row,
    index,
    rank: STATUS_RANK[accountStatus(row, { ...opts, checking: false }).kind],
    local: row.kind === 'local' ? 1 : 0,
  }));
  ranked.sort((a, b) => a.rank - b.rank || a.local - b.local || a.index - b.index);
  return ranked.map((r) => r.row);
}
