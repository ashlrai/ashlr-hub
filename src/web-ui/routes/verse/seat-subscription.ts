/**
 * routes/verse/seat-subscription.ts — "what subscription is behind this seat,
 * and how much of it is left", projected ONCE for every chat surface that
 * shows a seat: the resources panel, the seat selector, the new-chat dialog,
 * the sidebar and the chat header.
 *
 * WHY THIS MODULE EXISTS
 *
 * The resources panel showed a bare "unknown" pill for every account — the
 * most-looked-at surface in the app. Measured against a live server,
 * `GET /api/verse/accounts` had all four accounts observed, Claude with three
 * windows and Grok with one, while `bootstrap.seats[].health` was `unknown`
 * forever for Claude and Grok: seat health came from a shared-evidence file
 * scoped `codex-native-metadata`, which structurally cannot carry those two
 * providers. The live data existed and was discarded at the last hop.
 *
 * Owner S's V2.1 contract fixes the supply side — `VerseSeat.capacity`
 * (core/verse/types.ts) now carries the plan, the binding window, the full
 * window list, credits, a usability verdict, the evidence source and the
 * provider's own notes. This module is the single place the chat surfaces
 * read it, so they cannot describe one seat four different ways.
 *
 * TWO SOURCES, ONE VIEW. `capacity` is `undefined` for local seats (an Ollama
 * tag has no subscription) and for a native seat the server could not build a
 * record for. The V1 `health.windows` shape is still read as the fallback, and
 * on that path the verdict is delegated WHOLESALE to
 * `verse-model.seatCapacity` — the seat selector and the composer's seat menu
 * already render those exact words, and two implementations of one rule is
 * how the picker and the panel would drift apart again.
 *
 * HONESTY RULES (docs/VERSE-TELEMETRY-V2.md, closing section) — every one is a
 * place where the obvious projection would lie:
 *
 *  1. THE BINDING WINDOW LEADS. An account is blocked by its WORST window, not
 *     its first and not its average. Claude's weekly per-model window sat at
 *     100% while all-models read 58%; leading with 58% is a lie of emphasis.
 *  2. NO SIGNAL IS NOT ZERO. An unread window gets no meter at all. An empty
 *     bar reads "plenty left" and a full one reads "exhausted"; both are false
 *     when nothing was measured.
 *  3. THE SENTINEL 100 IS A FLAG. Codex writes `rateLimitReachedType` upstream
 *     as the value 100. `measured: false` marks it; it renders as "limit
 *     reached", never as "100% used", and carries no percentage.
 *  4. CREDITS ARE NOT THE WINDOW. A Codex account at 100% of its weekly window
 *     with a spendable balance is still usable. The server already encodes
 *     that in `usability: 'tight'`; this module reports both facts and never
 *     collapses them into one.
 *  5. ONLY A MACHINE-READABLE INSTANT MAY BE FORMATTED. Claude's `resetsAt` is
 *     structurally always null and its reset is provider prose; prose is
 *     rendered VERBATIM, never parsed and never turned into a countdown.
 *
 * Pure: no React, no I/O.
 */
import { describeResetAt } from '../../../core/verse/seat-readiness.js';
import type { VerseEngine, VerseSeat } from '../../data/api-types.js';
import { percentText } from './autonomy/format.js';
import {
  SEAT_CAPACITY_WORD,
  seatCapacity,
  seatUnavailableReason,
  seatWindowLabel,
  type SeatCapacityClass,
} from './verse-model.js';

export type { SeatCapacityClass };

/**
 * Owner S's shapes, reached through `VerseSeat` rather than imported by name.
 *
 * This is the drift guard, and it costs nothing: rename or reshape
 * `VerseSeatCapacity` in core/verse/types.ts and every read below stops
 * compiling HERE, at the seam, instead of silently degrading the panel back to
 * the "unknown" it was built to fix.
 */
type SeatCapacityRecord = NonNullable<VerseSeat['capacity']>;
type SeatCapacityWindow = SeatCapacityRecord['windows'][number];

/** One quota window, in the shape every chat surface renders. */
export interface SeatWindowView {
  id: string;
  /** Human label, derived from the provider's id. */
  label: string;
  /**
   * 0–100, or null. Null means "no reading" OR "the figure is a sentinel".
   * NEVER a substituted zero, and a view must not draw a meter for it.
   */
  usedPercent: number | null;
  /** The provider flagged the limit instead of measuring it. */
  limitReached: boolean;
  /**
   * Reset text, ready to render: provider prose VERBATIM when that is what the
   * provider published, a formatted local time when — and only when — it gave
   * a machine-readable instant, null when it gave neither.
   */
  resetText: string | null;
  /**
   * The machine-readable reset instant (ISO), when there was one. The only
   * field a countdown could ever legitimately be derived from; nothing in the
   * chat surfaces derives one today.
   */
  resetsAt: string | null;
}

export interface SeatSubscriptionView {
  /**
   * Local seats have no subscription, no quota and no bill — only a readiness
   * — and must not be dressed in meters that imply otherwise.
   */
  kind: 'subscription' | 'local';
  /** Plan tier as the provider names it: "max", "pro", "SuperGrok". */
  plan: string | null;
  cls: SeatCapacityClass;
  /** The class as a word. State is never communicated by colour alone. */
  word: string;
  /**
   * One short phrase for an option label, a pill title or a menu row —
   * "92% of weekly fable window used", "primary window limit reached".
   */
  summary: string;
  /** The window that actually constrains work. Null when nothing was read. */
  binding: SeatWindowView | null;
  /** Every other window, in provider order. */
  others: SeatWindowView[];
  /** Codex credits as a rendered phrase. Independent of the window. */
  credits: string | null;
  /** The provider's raw balance string, kept verbatim for a title attribute. */
  creditsTitle: string | null;
  /**
   * The provider's own plain-language facts. Owner S's contract says these
   * must be SHOWN rather than left to imply a fault, so they travel here and
   * the panel prints them.
   */
  notes: string[];
  /**
   * Where the windows came from, so nothing implies freshness it lacks.
   * Null on the V1 fallback path, which has no provenance to report.
   */
  evidenceSource: SeatCapacityRecord['evidenceSource'] | null;
  /** When the reading was taken, ISO. Null when nothing was observed. */
  observedAt: string | null;
  /** True when the seat carried owner S's `capacity` record. */
  extended: boolean;
}

/**
 * S's five-state verdict, mapped onto the four words this app already uses.
 *
 * `signed-out` is BLOCKED-by-action, not unread: we know exactly why there is
 * no capacity and what to do about it. `unknown` is the only genuinely unread
 * state — nobody told us anything, and calling that blocked would assert an
 * outage we never observed.
 *
 * Typed as a total map over S's union, so adding a verdict upstream fails the
 * build here rather than falling through to a silent default.
 */
const USABILITY_CLASS: Record<SeatCapacityRecord['usability'], SeatCapacityClass> = {
  ready: 'ready',
  tight: 'tight',
  exhausted: 'blocked',
  'signed-out': 'blocked',
  unknown: 'unread',
};

/**
 * A machine-readable instant, formatted — in the app's ONE reset wording,
 * `describeResetAt`'s: "resets today 11:46 PM", "resets Fri 11:46 PM",
 * "resets Sep 26, 11:46 PM". (A second wording here — "resets Sep 25 at
 * 11:46 PM" — once reached the chat header and the seat meters while Accounts
 * said "resets Fri 11:46 PM" for the same instant.) Prose resets never reach
 * this — they are passed through untouched, because the provider's sentence
 * already carries the timezone it means and reformatting it would be a guess.
 */
export function formatResetInstant(iso: string, now: number = Date.now()): string | null {
  const when = describeResetAt(iso, now);
  return when === null ? null : `resets ${when}`;
}

/**
 * Window ids arrive provider-prefixed and sometimes doubly so
 * (`codex_codex_primary`, `grok_unified_weekly`). Strip the engine's own name
 * off the front before handing the rest to the shared labeller, so the panel
 * reads "primary window" rather than "codex codex primary window".
 *
 * Only the `capacity` path uses this. The V1 fallback goes through
 * `seatWindowLabel` unaltered, because the seat selector's wording is pinned
 * to it by test.
 */
export function seatCapacityWindowLabel(engine: VerseEngine, id: string): string {
  const prefix = `${engine}_`;
  let rest = id;
  while (rest.startsWith(prefix) && rest.length > prefix.length) rest = rest.slice(prefix.length);
  return seatWindowLabel(rest);
}

function toWindowView(engine: VerseEngine, w: SeatCapacityWindow, now: number): SeatWindowView {
  const reset = w.resetDescription ?? (w.resetsAt === null ? null : formatResetInstant(w.resetsAt, now));
  return {
    id: w.id,
    label: seatCapacityWindowLabel(engine, w.id),
    // A flagged limit, and any unmeasured figure, is a sentinel — not a reading.
    usedPercent: w.limitReached || !w.measured ? null : w.usedPercent,
    limitReached: w.limitReached,
    resetText: reset,
    resetsAt: w.resetsAt,
  };
}

/** The V1 `health.windows` shape, for a seat with no `capacity` record. */
function legacyWindowView(w: VerseSeat['health']['windows'][number], now: number): SeatWindowView {
  const used = typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
    ? Math.max(0, Math.min(100, w.usedPercent))
    : null;
  // Upstream writes a denial as 100, so on this shape a bare 100 cannot be
  // told apart from a measured 100 — and the safe reading of both is "spent".
  const flagged = used !== null && used >= 100;
  return {
    id: w.id,
    label: seatWindowLabel(w.id),
    usedPercent: flagged ? null : used,
    limitReached: flagged,
    resetText: w.resetsAt === null ? null : formatResetInstant(w.resetsAt, now),
    resetsAt: w.resetsAt,
  };
}

function creditsPhrase(credits: SeatCapacityRecord['credits']): { phrase: string | null; title: string | null } {
  if (credits === null) return { phrase: null, title: null };
  if (credits.unlimited) return { phrase: 'credits unlimited', title: null };
  if (!credits.hasCredits) return { phrase: null, title: null };
  if (credits.balance === null) return { phrase: 'credits available', title: null };
  const parsed = Number.parseFloat(credits.balance);
  if (!Number.isFinite(parsed)) return { phrase: 'credits available', title: credits.balance };
  // The provider publishes a long decimal ("2048.4196250000"). Two places is a
  // rendering choice, not a new number — the raw string rides in the title.
  return { phrase: `${parsed.toFixed(2)} credits left`, title: credits.balance };
}

function localView(seat: VerseSeat): SeatSubscriptionView {
  const unavailable = seatUnavailableReason(seat);
  const ready = seat.health.state === 'ready';
  const cls: SeatCapacityClass = unavailable !== null ? 'blocked' : ready ? 'ready' : 'unread';
  return {
    kind: 'local',
    plan: null,
    cls,
    word: SEAT_CAPACITY_WORD[cls],
    summary: unavailable ?? (ready ? 'runs on this machine' : 'readiness not reported'),
    binding: null,
    others: [],
    credits: null,
    creditsTitle: null,
    notes: seat.health.summary === null ? [] : [seat.health.summary],
    evidenceSource: null,
    observedAt: seat.health.observedAt,
    extended: false,
  };
}

/** The V1 path: no `capacity` record, so the V1 rule decides, unchanged. */
function fallbackView(seat: VerseSeat, now: number): SeatSubscriptionView {
  const legacy = seatCapacity(seat);
  const windows = seat.health.windows.map((w) => legacyWindowView(w, now));
  const flagged = windows.find((w) => w.limitReached) ?? null;
  const measured = windows.filter((w) => w.usedPercent !== null);
  const worst = measured.length === 0
    ? null
    : measured.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a));
  const binding = flagged ?? worst;
  const unavailable = seatUnavailableReason(seat);
  const cls = unavailable !== null ? 'blocked' : legacy.cls;
  return {
    kind: 'subscription',
    plan: null,
    cls,
    word: SEAT_CAPACITY_WORD[cls],
    summary: unavailable ?? legacy.text,
    binding,
    others: binding === null ? windows : windows.filter((w) => w.id !== binding.id),
    credits: null,
    creditsTitle: null,
    notes: [],
    evidenceSource: null,
    observedAt: seat.health.observedAt,
    extended: false,
  };
}

/**
 * The whole projection. Local seats short-circuit: they have no subscription,
 * so everything below the readiness line is deliberately empty rather than
 * zeroed. `now` is the clock the reset wording is relative to ("today" vs a
 * weekday); it defaults to the real one.
 */
export function seatSubscription(seat: VerseSeat, now: number = Date.now()): SeatSubscriptionView {
  if (seat.engine === 'local') return localView(seat);
  const capacity = seat.capacity;
  if (capacity === undefined) return fallbackView(seat, now);

  const windows = capacity.windows.map((w) => toWindowView(seat.engine, w, now));
  // Resolve the server's CHOICE of binding window back to this seat's own
  // view of it, so the two can never disagree about a reset or a label.
  const served = capacity.binding;
  const binding = served === null
    ? null
    : (windows.find((w) => w.id === served.id) ?? toWindowView(seat.engine, served, now));
  const others = binding === null ? windows : windows.filter((w) => w.id !== binding.id);
  const credits = creditsPhrase(capacity.credits);

  const unavailable = seatUnavailableReason(seat);
  const cls: SeatCapacityClass = unavailable !== null ? 'blocked' : USABILITY_CLASS[capacity.usability];

  let summary: string;
  // Signed out is checked FIRST, before the generic unavailable reason: owner
  // S maps `signed-out` onto `health.state: 'unavailable'` (it is the one
  // account state worth a red dot, because it has a remedy), and the generic
  // reason there is a bare "seat unavailable" that says nothing about the fix.
  // A signed-out account has no measurement at all — it is an action, never a
  // 0% meter and never a bare "unknown".
  if (capacity.usability === 'signed-out') {
    summary = 'signed out — reconnect this account';
  } else if (unavailable !== null) {
    summary = unavailable;
  } else if (binding === null) {
    summary = 'no capacity reading';
  } else if (binding.limitReached) {
    // The server already weighed credits against the spent window; `tight`
    // there means "spent, but there is still something to spend".
    summary = capacity.usability === 'tight' && credits.phrase !== null
      ? `${binding.label} limit reached · credits still spendable`
      : `${binding.label} limit reached`;
  } else if (binding.usedPercent === null) {
    summary = 'no capacity reading';
  } else {
    // The one percent rule: "99%", never a rounded "100%" beside a "99%" bar.
    summary = `${percentText(binding.usedPercent)} of ${binding.label} used`;
  }

  return {
    kind: 'subscription',
    plan: capacity.planType,
    cls,
    word: SEAT_CAPACITY_WORD[cls],
    summary,
    binding,
    others,
    credits: credits.phrase,
    creditsTitle: credits.title,
    notes: [...capacity.notes],
    evidenceSource: capacity.evidenceSource,
    observedAt: capacity.observedAt ?? seat.health.observedAt,
    extended: true,
  };
}

/**
 * How much of a freshness claim the evidence supports. A reading served from
 * another process's shared file, or from an operator-seeded baseline, is not
 * a live probe and must not be presented as one.
 */
export function evidenceNote(source: SeatSubscriptionView['evidenceSource']): string | null {
  switch (source) {
    case 'collector':
      return null;
    case 'shared-evidence':
      return 'read from another collector’s shared evidence, not probed here';
    case 'baseline':
      return 'operator-seeded baseline, not a live reading';
    case 'none':
      return 'no evidence source — nothing here was measured';
    default:
      return null;
  }
}

function parseableInstant(iso: string | null | undefined): iso is string {
  return typeof iso === 'string' && Number.isFinite(Date.parse(iso));
}

function isSpentWindow(w: Pick<SeatWindowView, 'limitReached' | 'usedPercent'>): boolean {
  return w.limitReached || (w.usedPercent !== null && w.usedPercent >= 100);
}

/**
 * When a spent seat is usable again. A seat reopens only once EVERY spent
 * window has reset — a Codex seat whose 5-hour window resets in 2h but whose
 * weekly window is also spent until Wednesday is still spent in 2h — so this
 * is the LATEST reset among the spent windows, matching Fleet's "eligible
 * again" (fleet/why-seat-model `eligibleAgain`) and the router's headroom
 * `lastReset`. Every surface that says "resets …" / "usable again in …" for
 * a spent seat (Accounts, the health banner) asks here.
 *
 *   - a spent window with only provider prose (Claude) → null: when "all of
 *     them" have reset is unknown, and prose is never parsed;
 *   - `reported` (the health sweep's instant, which is its binding window's)
 *     is folded in — it may know of a window this seat record does not — but
 *     it can never make the answer EARLIER than a spent window's reset;
 *   - nothing spent → `reported`, else the binding window's own instant.
 */
export function seatReopensAt(view: Pick<SeatSubscriptionView, 'binding' | 'others'>, reported?: string | null): string | null {
  const known = parseableInstant(reported) ? reported : null;
  const windows = view.binding === null ? view.others : [view.binding, ...view.others];
  const spent = windows.filter(isSpentWindow);
  if (spent.length > 0) {
    if (spent.some((w) => !parseableInstant(w.resetsAt))) return null;
    const instants = spent.map((w) => w.resetsAt as string);
    if (known !== null) instants.push(known);
    return instants.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  }
  if (known !== null) return known;
  return view.binding !== null && parseableInstant(view.binding.resetsAt) ? view.binding.resetsAt : null;
}

/**
 * One sentence for a `title` attribute or a screen-reader name: the seat, its
 * plan, its verdict and the evidence behind it.
 */
export function seatSubscriptionSentence(seat: VerseSeat, view: SeatSubscriptionView): string {
  const parts = [seat.label];
  if (view.plan !== null) parts.push(view.plan);
  parts.push(view.word);
  parts.push(view.summary);
  if (view.credits !== null) parts.push(view.credits);
  if (view.binding?.resetText != null) parts.push(view.binding.resetText);
  return parts.join(' · ');
}

/** Tight and blocked are worth surfacing outside the panel; the rest is noise. */
export function worthFlagging(cls: SeatCapacityClass): boolean {
  return cls === 'tight' || cls === 'blocked';
}
