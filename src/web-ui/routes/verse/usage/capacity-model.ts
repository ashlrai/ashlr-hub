/**
 * routes/verse/usage/capacity-model.ts — "what can I run right now", in one
 * pure projection.
 *
 * The Usage section already answers this per seat, one card at a time. This
 * module answers it for the WHOLE ROSTER in one line, because the operator's
 * first question on opening the view is not "how is Codex A doing" — it is
 * "do I have anything to run, and if not, when does that change".
 *
 * Four rules, each one a place where the obvious summary would lie:
 *
 *  1. A COUNT IS NOT A CAPACITY. "3 of 5 seats usable" is only true if the
 *     other two were actually read. Seats with no reading are counted in their
 *     own bucket and named in the sentence, never folded into "blocked" — an
 *     unread seat might be perfectly usable.
 *  2. ONLY A MACHINE-READABLE INSTANT MAY BECOME A COUNTDOWN. Claude's reset
 *     is provider prose and `resetsAt` is structurally null
 *     (docs/VERSE-TELEMETRY-V2.md), so prose resets travel in their own
 *     channel and are rendered verbatim. Nothing here parses a sentence into
 *     a time.
 *  3. A RESET IN THE PAST IS NOT A RESET. A `resetsAt` that has already
 *     elapsed means the reading predates the rollover; it is reported as
 *     overdue rather than as a negative countdown or as "now".
 *  4. LOCAL HEADROOM IS NOT "BUDGET MINUS RESIDENT" UNLESS BOTH ARE KNOWN.
 *     One unknown makes the headroom unknown, and the strip says so.
 *
 * Pure: no React, no I/O, no formatting of currency/percent.
 */
import type { AccountCardModel, AccountVerdictState, LocalCardModel, WindowView } from './accounts-model.js';
import type { LocalModelsView } from './local-model.js';

/**
 * The four buckets the strip counts in. Deliberately coarser than
 * `AccountVerdictState`: at a glance there are only four useful answers, and
 * the card below carries the nuance.
 */
export type CapacityClass = 'ready' | 'tight' | 'blocked' | 'unread';

/**
 * `signed-out` and `probe-unsupported` are BLOCKED-by-action, not unread: in
 * both cases we know exactly why there is no capacity and what to do about
 * it. `unknown` is the only genuinely unread state — nobody told us anything,
 * so counting it as blocked would assert an outage we did not observe.
 */
export const CAPACITY_CLASS: Record<AccountVerdictState, CapacityClass> = {
  available: 'ready',
  credits: 'ready',
  tight: 'tight',
  exhausted: 'blocked',
  'signed-out': 'blocked',
  'probe-unsupported': 'blocked',
  unknown: 'unread',
};

export interface SeatCapacity {
  id: string;
  label: string;
  kind: 'account' | 'local';
  /** Engine hue — used only for the 2px marker, never for text. */
  color: string;
  cls: CapacityClass;
  /** The card's own verdict headline, so the strip and the card agree. */
  headline: string;
  /**
   * The binding window's percent, when it is a real measurement. Null for an
   * unread seat AND for a flagged limit, whose sentinel 100 is not a reading.
   */
  usedPct: number | null;
  /** False when `usedPct` is null because the figure would be a sentinel. */
  measured: boolean;
}

/** A reset the provider gave as a real instant, so a countdown is honest. */
export interface ResetInstant {
  seatLabel: string;
  windowLabel: string;
  /**
   * Epoch ms — the ONLY durable fact here. `inMs`/`overdue` below are a
   * snapshot taken when the model was built; a view that renders a countdown
   * must derive it from `atMs` against a live clock instead, or it will print
   * whatever the elapsed time happened to be when the memo last ran.
   */
  atMs: number;
  /** Signed ms until the reset AT BUILD TIME. Selection only — never rendered. */
  inMs: number;
  /** True when `inMs <= 0` AT BUILD TIME. Selection only — never rendered. */
  overdue: boolean;
}

/** A reset whose ONLY signal is provider prose. Rendered verbatim, never parsed. */
export interface ResetProse {
  seatLabel: string;
  windowLabel: string;
  text: string;
}

export interface LocalCapacity {
  reachable: boolean;
  residentCount: number;
  installedCount: number;
  /** Models that can actually drive an agentic session. */
  agenticCount: number;
  /** Models whose runtime did not report a capability list. Never "cannot". */
  unknownToolCount: number;
  residentBytes: number | null;
  memoryBudgetBytes: number | null;
  /** Budget minus resident. Null when either side is unknown. */
  headroomBytes: number | null;
  /** The machine's own reported free memory, which is not the same figure. */
  freeMemoryBytes: number | null;
  usedPct: number | null;
}

export interface CapacityOverview {
  seats: SeatCapacity[];
  ready: number;
  tight: number;
  blocked: number;
  unread: number;
  total: number;
  /**
   * Every dated reset, so a view can re-select the soonest one against a live
   * clock rather than against the instant this model was built.
   */
  resets: ResetInstant[];
  /** The soonest real reset across every seat, or null when none is dated. */
  nextReset: ResetInstant | null;
  /** Every window whose reset is prose only, deduplicated by sentence. */
  proseResets: ResetProse[];
  local: LocalCapacity | null;
  /** The one-line answer. Never claims anything about an unread seat. */
  headline: string;
  /** True when nothing is ready and nothing is merely tight. */
  noCapacity: boolean;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The strip's sentence. Written by cases rather than by template because each
 * case has a different honest claim to make, and a single interpolated string
 * ended up asserting "0 usable" over a roster nobody had read.
 */
export function capacityHeadline(input: {
  ready: number;
  tight: number;
  blocked: number;
  unread: number;
  total: number;
  local: LocalCapacity | null;
}): string {
  const { ready, tight, blocked, unread, total, local } = input;
  if (total === 0) {
    return 'No seats are reported at all. This is an empty roster, not a set of seats at zero.';
  }

  const localClause =
    local === null
      ? ''
      : local.reachable && local.residentCount > 0
        ? ` ${local.residentCount} local ${plural(local.residentCount, 'model is', 'models are')} resident and answer with no load delay.`
        : local.reachable && local.agenticCount > 0
          ? ` No local model is resident, but ${local.agenticCount} installed ${plural(local.agenticCount, 'one can', 'ones can')} drive a session after a load.`
          : local.reachable
            ? ' No local model is resident.'
            : ' The local runtime did not answer, so local capacity is unknown.';

  const unreadClause =
    unread === 0
      ? ''
      : ` ${unread} ${plural(unread, 'seat has', 'seats have')} no reading at all — unread, not exhausted.`;

  if (ready > 0) {
    return `${ready} of ${total} ${plural(total, 'seat is', 'seats are')} usable right now.${unreadClause}${localClause}`;
  }
  if (tight > 0) {
    return `No seat is clear: ${tight} ${plural(tight, 'is', 'are')} running tight and ${blocked} ${plural(blocked, 'is', 'are')} blocked.${unreadClause}${localClause}`;
  }
  if (blocked > 0) {
    return `No cloud seat reports headroom — ${blocked} blocked.${unreadClause}${localClause}`;
  }
  return `No seat reported a usable window.${unreadClause}${localClause}`;
}

function seatFromCard(card: AccountCardModel): SeatCapacity {
  const binding = card.binding;
  return {
    id: card.id,
    label: card.label,
    kind: 'account',
    color: card.color,
    cls: CAPACITY_CLASS[card.verdict.state],
    headline: card.verdict.headline,
    usedPct: binding && binding.measured && !binding.limitReached ? binding.usedPct : null,
    measured: binding !== null && binding.measured && !binding.limitReached,
  };
}

function seatFromLocal(card: LocalCardModel): SeatCapacity {
  return {
    id: 'local',
    label: 'Local',
    kind: 'local',
    color: card.color,
    cls: CAPACITY_CLASS[card.verdict.state],
    headline: card.verdict.headline,
    usedPct: card.usedPct,
    measured: card.usedPct !== null,
  };
}

/**
 * Collect reset signals, keeping the two channels apart.
 *
 * A window contributes to `instants` ONLY through `resetsAt`, an ISO string
 * the provider actually gave. `resetText` alone — Claude's entire reset
 * signal — contributes to `prose` and is never parsed.
 */
export function collectResets(
  seats: readonly { label: string; windows: readonly WindowView[] }[],
  nowMs: number,
): { instants: ResetInstant[]; prose: ResetProse[] } {
  const instants: ResetInstant[] = [];
  const prose: ResetProse[] = [];
  const seenProse = new Set<string>();

  for (const seat of seats) {
    for (const w of seat.windows) {
      if (w.resetsAt !== null) {
        const atMs = Date.parse(w.resetsAt);
        if (!Number.isNaN(atMs)) {
          const inMs = atMs - nowMs;
          instants.push({
            seatLabel: seat.label,
            windowLabel: w.label,
            atMs,
            inMs,
            overdue: inMs <= 0,
          });
          continue;
        }
      }
      if (w.resetText !== null) {
        const key = `${seat.label}|${w.label}|${w.resetText}`;
        if (seenProse.has(key)) continue;
        seenProse.add(key);
        prose.push({ seatLabel: seat.label, windowLabel: w.label, text: w.resetText });
      }
    }
  }
  return { instants, prose };
}

/**
 * The soonest reset still ahead of us. An overdue instant is never chosen as
 * "next" — it is in the past — but if EVERY instant is overdue the most recent
 * one is returned so the strip can say the readings predate a rollover rather
 * than silently showing nothing.
 */
export function nextReset(instants: readonly ResetInstant[]): ResetInstant | null {
  const ahead = instants.filter((r) => !r.overdue);
  if (ahead.length > 0) {
    return ahead.reduce((soonest, r) => (r.inMs < soonest.inMs ? r : soonest));
  }
  if (instants.length === 0) return null;
  return instants.reduce((latest, r) => (r.atMs > latest.atMs ? r : latest));
}

/**
 * The same choice as {@link nextReset}, but judged against a clock the caller
 * supplies rather than against the `overdue` flag frozen into each instant.
 * This is what a rendering countdown must use: a reset that was 40s away when
 * the model was built is in the PAST a minute later, and picking it as "next"
 * would keep a positive number on screen for a window that already rolled.
 */
export function nextResetAt(instants: readonly ResetInstant[], nowMs: number): ResetInstant | null {
  const ahead = instants.filter((r) => r.atMs > nowMs);
  if (ahead.length > 0) {
    return ahead.reduce((soonest, r) => (r.atMs < soonest.atMs ? r : soonest));
  }
  if (instants.length === 0) return null;
  return instants.reduce((latest, r) => (r.atMs > latest.atMs ? r : latest));
}

function buildLocalCapacity(
  card: LocalCardModel | null,
  view: LocalModelsView | null,
): LocalCapacity | null {
  if (card === null && view === null) return null;
  const residentBytes = card?.residentBytes ?? view?.residentBytes ?? null;
  const budget = card?.memoryBudgetBytes ?? view?.memoryBudgetBytes ?? null;
  return {
    reachable: view?.reachable ?? card?.verdict.state !== 'unknown',
    residentCount: card?.residentCount ?? view?.rows.filter((r) => r.resident).length ?? 0,
    installedCount: card?.installedCount ?? view?.rows.length ?? 0,
    agenticCount: view?.agenticCount ?? 0,
    unknownToolCount: view?.unknownToolCount ?? 0,
    residentBytes,
    memoryBudgetBytes: budget,
    // One unknown side makes the difference unknown. Treating a missing
    // resident figure as 0 would report the whole machine as free.
    headroomBytes:
      residentBytes !== null && budget !== null ? Math.max(0, budget - residentBytes) : null,
    freeMemoryBytes: view?.freeMemoryBytes ?? null,
    usedPct: card?.usedPct ?? view?.memoryUsedPct ?? null,
  };
}

export function buildCapacityOverview(input: {
  cards: readonly AccountCardModel[];
  localCard: LocalCardModel | null;
  localView: LocalModelsView | null;
  nowMs?: number;
}): CapacityOverview {
  const nowMs = input.nowMs ?? Date.now();
  const seats: SeatCapacity[] = input.cards.map(seatFromCard);
  if (input.localCard) seats.push(seatFromLocal(input.localCard));

  const count = (cls: CapacityClass): number => seats.filter((s) => s.cls === cls).length;
  const ready = count('ready');
  const tight = count('tight');
  const blocked = count('blocked');
  const unread = count('unread');

  const { instants, prose } = collectResets(
    input.cards.map((c) => ({ label: c.label, windows: c.allWindows })),
    nowMs,
  );

  const local = buildLocalCapacity(input.localCard, input.localView);

  return {
    seats,
    ready,
    tight,
    blocked,
    unread,
    total: seats.length,
    resets: instants,
    nextReset: nextReset(instants),
    proseResets: prose,
    local,
    headline: capacityHeadline({ ready, tight, blocked, unread, total: seats.length, local }),
    noCapacity: seats.length > 0 && ready === 0 && tight === 0,
  };
}

/**
 * "in 2h 14m" material for a dated reset. Kept beside the model rather than in
 * `chartFormat` because it is a duration, not a chart number, and because the
 * overdue case must not read as a negative time.
 */
export function formatUntil(inMs: number): string {
  if (!Number.isFinite(inMs)) return '—';
  if (inMs <= 0) return 'overdue';
  const total = Math.floor(inMs / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}
