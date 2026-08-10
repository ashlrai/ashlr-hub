/**
 * Tick-local USD admission for daemon dispatches.
 *
 * Reservations are synchronous so concurrent async workers cannot all observe
 * the same unreserved headroom. This ledger is intentionally process-local: the
 * durable daemon spend guard remains the crash/restart authority.
 */

import { canonicalModelTag, KNOWN_MODELS } from '../run/model-catalog.js';

const USD_MICROS = 1_000_000;

/**
 * Worst per-token price in the authoritative model catalog. maxTokens is a
 * combined input+output cap, so max(input price, output price) is the safe
 * conversion: every token is charged in one category, never both.
 */
export const DAEMON_SPEND_USD_PER_MILLION_TOKENS = Math.max(
  ...KNOWN_MODELS.flatMap((model) => [model.costPerMTokIn, model.costPerMTokOut]),
);

/** Smallest useful producer envelope; smaller launches fail closed. */
export const DAEMON_MIN_DISPATCH_TOKENS = 1_000;

export const DAEMON_MIN_DISPATCH_USD =
  (DAEMON_MIN_DISPATCH_TOKENS * DAEMON_SPEND_USD_PER_MILLION_TOKENS) / USD_MICROS;

const KNOWN_ZERO_DAILY_SPEND_ENGINES = new Set([
  'builtin',
  // These CLI engines are subscription-governed separately by the daemon.
  'claude',
  'codex',
]);

/**
 * Return a catalog-authoritative per-token price, or null when the daemon
 * cannot prove a route fits the reservation conversion. Unknown-priced routes
 * must not launch under this ledger.
 */
export function daemonRouteUsdPerMillionTokenCeiling(
  engine: string,
  model: string | null | undefined,
): number | null {
  if (KNOWN_ZERO_DAILY_SPEND_ENGINES.has(engine)) return 0;
  const canonical = canonicalModelTag(engine, model);
  if (!canonical) return null;
  const entry = KNOWN_MODELS.find((candidate) => {
    if (candidate.engine !== engine) return false;
    const knownTag = canonicalModelTag(engine, candidate.id);
    if (knownTag === canonical) return true;
    // Registry-local quantization suffixes describe the same free model.
    return candidate.costPerMTokIn === 0 && candidate.costPerMTokOut === 0 &&
      canonical.startsWith(`${knownTag}-`);
  });
  if (!entry) return null;
  const ceiling = Math.max(entry.costPerMTokIn, entry.costPerMTokOut);
  return Number.isFinite(ceiling) && ceiling >= 0 &&
    ceiling <= DAEMON_SPEND_USD_PER_MILLION_TOKENS
    ? ceiling
    : null;
}

export interface DaemonSpendReservation {
  readonly id: string;
  readonly ceilingUsd: number;
  readonly maxTokens: number;
}

export interface DaemonSpendChildEnvelope {
  readonly reservationId: string;
  readonly childCount: number;
  readonly ceilingUsdPerChild: number;
  readonly aggregateCeilingUsd: number;
  readonly maxTokensPerChild: number;
}

export interface DaemonSpendReservationLedger {
  /** Synchronous. Returns null without consuming headroom. */
  tryReserve(id: string, requestedCeilingUsd: number): DaemonSpendReservation | null;
  /**
   * Divide one admitted outer envelope across child producers. Returns null
   * when even one child would fall below the minimum useful token envelope.
   */
  childEnvelope(
    reservation: DaemonSpendReservation,
    childCount: number,
  ): DaemonSpendChildEnvelope | null;
  /**
   * Settle exactly once. null means launched spend is ambiguous, so the full
   * ceiling remains charged. Callers invoke this only from their finally block.
   */
  reconcile(reservation: DaemonSpendReservation, actualSpentUsd: number | null): boolean;
  readonly headroomUsd: number;
  readonly reservedUsd: number;
  readonly chargedUsd: number;
  readonly availableUsd: number;
}

function finiteMicrosFloor(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const micros = Math.floor(value * USD_MICROS);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

function finiteMicrosCeil(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const micros = Math.ceil(value * USD_MICROS);
  return Number.isSafeInteger(micros) && micros >= 0 ? micros : null;
}

function usd(micros: number): number {
  return micros / USD_MICROS;
}

function maxTokensForMicros(micros: number): number {
  // usd * 1M / ($/1M) simplifies to micro-usd / ($/1M).
  return Math.floor(micros / DAEMON_SPEND_USD_PER_MILLION_TOKENS);
}

/** Build a fresh ledger for one daemon tick's already-computed daily headroom. */
export function createDaemonSpendReservationLedger(
  headroomUsd: number,
): DaemonSpendReservationLedger {
  const headroomMicros = finiteMicrosFloor(headroomUsd) ?? 0;
  let reservedMicros = 0;
  let chargedMicros = 0;
  const active = new Map<string, { envelope: DaemonSpendReservation; micros: number }>();
  const seen = new Set<string>();

  const availableMicros = (): number =>
    Math.max(0, headroomMicros - reservedMicros - chargedMicros);

  return {
    tryReserve(id, requestedCeilingUsd) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return null;
      const requestedMicros = finiteMicrosFloor(requestedCeilingUsd);
      if (requestedMicros === null) return null;
      const maxTokens = maxTokensForMicros(requestedMicros);
      if (maxTokens < DAEMON_MIN_DISPATCH_TOKENS || requestedMicros > availableMicros()) {
        return null;
      }
      const envelope = Object.freeze({
        id,
        ceilingUsd: usd(requestedMicros),
        maxTokens,
      });
      active.set(id, { envelope, micros: requestedMicros });
      seen.add(id);
      reservedMicros += requestedMicros;
      return envelope;
    },

    childEnvelope(reservation, childCount) {
      const entry = active.get(reservation.id);
      if (entry?.envelope !== reservation || !Number.isSafeInteger(childCount) || childCount < 1) {
        return null;
      }
      const childMicros = Math.floor(entry.micros / childCount);
      const maxTokensPerChild = maxTokensForMicros(childMicros);
      if (maxTokensPerChild < DAEMON_MIN_DISPATCH_TOKENS) return null;
      return Object.freeze({
        reservationId: reservation.id,
        childCount,
        ceilingUsdPerChild: usd(childMicros),
        aggregateCeilingUsd: usd(childMicros * childCount),
        maxTokensPerChild,
      });
    },

    reconcile(reservation, actualSpentUsd) {
      const entry = active.get(reservation.id);
      if (entry?.envelope !== reservation) return false;
      active.delete(reservation.id);
      reservedMicros -= entry.micros;
      const actualMicros = actualSpentUsd === null ? null : finiteMicrosCeil(actualSpentUsd);
      // Invalid/ambiguous launched accounting is never interpreted as a refund.
      chargedMicros += actualMicros ?? entry.micros;
      return true;
    },

    get headroomUsd() { return usd(headroomMicros); },
    get reservedUsd() { return usd(reservedMicros); },
    get chargedUsd() { return usd(chargedMicros); },
    get availableUsd() { return usd(availableMicros()); },
  };
}
