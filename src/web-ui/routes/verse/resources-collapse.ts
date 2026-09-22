/**
 * routes/verse/resources-collapse.ts — which resource-panel groups and seats
 * the operator left open.
 *
 * WHY THIS IS NOT `ashlr.verse.ui.v2`. That key's shape is the shell contract
 * (docs/VERSE-CONTRACT-V2.md) and verse-ui-store.test pins it field for field.
 * Collapse is a preference about the seat list, so it lives under its own key.
 *
 * WHY IT IS PERSISTED AT ALL. A spent seat starts collapsed because that is
 * the one the operator does not need open — two Codex accounts pinned at
 * their limit were hundreds of pixels of dead weight above the seat that
 * still had room. A data refresh, and a browser refresh, must not re-derive
 * that default over an explicit choice: opening a spent seat to read its
 * reset, then clicking Refresh, would otherwise slam it shut again.
 *
 * Defaults are applied at read time, never written. A seat that later
 * becomes usable opens itself unless the operator had collapsed it on purpose.
 *
 * Pure aside from the two localStorage functions. No React.
 */
import type { VerseEngine } from '../../data/api-types.js';
import { isVerseEngine } from './verse-model.js';
import type { SeatCapacityClass, SeatSubscriptionView, SeatWindowView } from './seat-subscription.js';

export const RESOURCES_COLLAPSE_KEY = 'ashlr.verse.resources.v1';

/** Bounded so a long-lived browser cannot accumulate a seat id per deleted account. */
const SEAT_CHOICE_LIMIT = 80;
const SEAT_ID_MAX = 200;

export interface ResourcesCollapseState {
  /** Engines the operator collapsed. Absent means open — groups start open. */
  collapsedGroups: readonly VerseEngine[];
  /**
   * Explicit per-seat choices. `true` is open, `false` is closed.
   * A missing id means "use the default", which depends on the live verdict.
   */
  seats: Readonly<Record<string, boolean>>;
}

export function emptyResourcesCollapse(): ResourcesCollapseState {
  return { collapsedGroups: [], seats: {} };
}

/**
 * Exhausted and signed-out both project to `blocked` (seat-subscription.ts).
 * That is the seat that cannot take a turn, and it is the one that starts shut.
 * `tight` stays open: a Codex week at its limit with spendable credits is
 * still usable, and hiding that fact is the lie the credits rule exists to prevent.
 */
export function seatDefaultOpen(cls: SeatCapacityClass): boolean {
  return cls !== 'blocked';
}

export function groupIsOpen(state: ResourcesCollapseState, engine: VerseEngine): boolean {
  return !state.collapsedGroups.includes(engine);
}

export function seatIsOpen(state: ResourcesCollapseState, seatId: string, cls: SeatCapacityClass): boolean {
  const choice = state.seats[seatId];
  return typeof choice === 'boolean' ? choice : seatDefaultOpen(cls);
}

export function toggleGroupCollapse(state: ResourcesCollapseState, engine: VerseEngine): ResourcesCollapseState {
  const collapsedGroups = state.collapsedGroups.includes(engine)
    ? state.collapsedGroups.filter((item) => item !== engine)
    : [...state.collapsedGroups, engine];
  return { ...state, collapsedGroups };
}

export function toggleSeatCollapse(
  state: ResourcesCollapseState,
  seatId: string,
  cls: SeatCapacityClass,
): ResourcesCollapseState {
  if (!isSeatId(seatId)) return state;
  const seats = { ...state.seats, [seatId]: !seatIsOpen(state, seatId, cls) };
  return { ...state, seats: boundSeats(seats) };
}

/**
 * One bar per window the seat actually carries, binding first.
 *
 * The probes omit a limit they did not report — Codex does not emit a
 * secondary window when `secondary` is null (provider-observations.ts), and
 * Claude only emits `five_hour`, `seven_day`, and whichever per-model week
 * the CLI printed (claude-account-usage.ts `TITLES`). Nothing here adds a
 * window the seat does not have. An unmeasured window stays in the list so
 * the panel can say "no reading" instead of drawing an empty bar.
 */
export function reportedLimitBars(
  view: Pick<SeatSubscriptionView, 'kind' | 'binding' | 'others'>,
): SeatWindowView[] {
  if (view.kind === 'local') return [];
  if (view.binding === null) return [...view.others];
  return [view.binding, ...view.others.filter((window) => window.id !== view.binding!.id)];
}

function isSeatId(value: string): boolean {
  return value.length > 0 && value.length <= SEAT_ID_MAX
    && value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
}

function boundSeats(seats: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const entries = Object.entries(seats);
  if (entries.length <= SEAT_CHOICE_LIMIT) return { ...seats };
  return Object.fromEntries(entries.slice(entries.length - SEAT_CHOICE_LIMIT));
}

export function parseResourcesCollapse(raw: string | null): ResourcesCollapseState {
  if (raw === null || raw === '') return emptyResourcesCollapse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyResourcesCollapse();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyResourcesCollapse();
  const record = parsed as Record<string, unknown>;

  const collapsedGroups: VerseEngine[] = [];
  if (Array.isArray(record.collapsedGroups)) {
    for (const engine of record.collapsedGroups) {
      if (typeof engine === 'string' && isVerseEngine(engine) && !collapsedGroups.includes(engine)) {
        collapsedGroups.push(engine);
      }
    }
  }

  const seats: Record<string, boolean> = {};
  const rawSeats = record.seats;
  if (rawSeats && typeof rawSeats === 'object' && !Array.isArray(rawSeats)) {
    for (const [id, choice] of Object.entries(rawSeats as Record<string, unknown>)) {
      if (!isSeatId(id) || typeof choice !== 'boolean') continue;
      if (Object.keys(seats).length >= SEAT_CHOICE_LIMIT) break;
      Object.defineProperty(seats, id, { value: choice, enumerable: true, writable: true, configurable: true });
    }
  }

  return { collapsedGroups, seats };
}

export function readResourcesCollapse(): ResourcesCollapseState {
  try {
    return parseResourcesCollapse(localStorage.getItem(RESOURCES_COLLAPSE_KEY));
  } catch {
    return emptyResourcesCollapse();
  }
}

export function writeResourcesCollapse(state: ResourcesCollapseState): void {
  try {
    localStorage.setItem(RESOURCES_COLLAPSE_KEY, JSON.stringify({
      collapsedGroups: state.collapsedGroups,
      seats: state.seats,
    }));
  } catch {
    /* a private window without storage still runs the app */
  }
}
