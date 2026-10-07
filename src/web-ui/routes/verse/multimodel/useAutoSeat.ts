/**
 * routes/verse/multimodel/useAutoSeat.ts — the Auto seat for one chat's
 * composer: classify the draft (rules, after a pause in typing), ask the pure
 * advisor over the seat list the app already polls, and say which seat and
 * why. Nothing here sends anything or leaves the page with the draft.
 *
 * Also the per-chat Auto preference (Off / Auto / Cheap-first), kept in
 * localStorage beside the drafts: a view preference, never a server setting.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { VerseSeat, VerseSession } from '../../../data/api-types.js';
import { capacityFromSeat } from '../../../../core/routing/headroom.js';
import { seatTier, tierRank } from '../../../../core/routing/tiers.js';
import type { BudgetPolicy } from '../../../../core/routing/types.js';
import { adviseSeat, type AdvisorSeat } from '../../../../core/verse/multimodel/advisor.js';
import { classifyPrompt } from '../../../../core/verse/multimodel/classify.js';
import type { AutoMode, LocalModelBadge, MultimodelContext, PromptClassification, SeatAdvice } from '../../../../core/verse/multimodel/types.js';
import { useQuery } from '../../../data/hooks.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { getVerseSessionHead, subscribeVerseSession } from '../verse-store.js';
import { firstRunnableModel } from '../verse-model.js';
import { multimodelContextQuery } from './multimodel-queries.js';

export type AutoPref = 'off' | 'manager' | AutoMode;
export const AUTO_PREFS: readonly AutoPref[] = ['off', 'auto', 'cheap-first', 'manager'];
const PREF_KEY = 'ashlr.verse.multimodel.v1';
const DEFAULT_PREF: AutoPref = 'auto';
/** Classify after this long without a keystroke. */
export const CLASSIFY_DEBOUNCE_MS = 250;

function readPrefs(): Record<string, AutoPref> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, AutoPref> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if ((AUTO_PREFS as readonly unknown[]).includes(v)) out[k] = v as AutoPref;
    return out;
  } catch {
    return {};
  }
}

/** A chat's own choice, else the last one made anywhere (`*`), else Auto. */
export function loadAutoPref(sessionId: string | null): AutoPref {
  const prefs = readPrefs();
  return (sessionId ? prefs[sessionId] : undefined) ?? prefs['*'] ?? DEFAULT_PREF;
}

export function saveAutoPref(sessionId: string | null, pref: AutoPref): void {
  try {
    const prefs = readPrefs();
    if (sessionId) prefs[sessionId] = pref;
    prefs['*'] = pref;
    // Bounded: the newest 200 chats keep their own choice.
    const entries = Object.entries(prefs);
    const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - 201)));
    localStorage.setItem(PREF_KEY, JSON.stringify(kept));
  } catch { /* private mode: the choice lasts for this page */ }
}

/** The chat record from the store, without opening a stream (the host already did). */
export function useSessionRecord(sessionId: string | null): VerseSession | null {
  return useSyncExternalStore(
    (listener) => (sessionId ? subscribeVerseSession(sessionId, listener) : () => undefined),
    () => getVerseSessionHead(sessionId).session,
    () => getVerseSessionHead(sessionId).session,
  );
}

function isLoopback(seat: VerseSeat, badges: readonly LocalModelBadge[] | undefined): boolean {
  // The server is the authority on the endpoint; without its badge a local
  // seat is still local, and "private" is claimed only when it said so.
  return badges?.find((b) => b.seatId === seat.id)?.private === true;
}

/**
 * The seat's first runnable model in a CHEAPER tier than `defaultId`'s — the
 * Devin CLI's free SWE next to its elite default (routing/tiers.ts). Null
 * when the seat has one tier.
 */
function cheaperModel(seat: VerseSeat, defaultId: string): string | null {
  const base = tierRank(seatTier(seat.engine, defaultId));
  const found = seat.models.find((m) => !m.unavailableReason && tierRank(seatTier(seat.engine, m.id)) > base);
  return found?.id ?? null;
}

/** Project the polled seats into what the advisor ranks. Every chat engine, Devin included. */
export function toAdvisorSeats(seats: readonly VerseSeat[], badges?: readonly LocalModelBadge[]): AdvisorSeat[] {
  return seats.flatMap((seat) => {
    if (seat.health.state === 'unavailable') return [];
    const model = firstRunnableModel(seat);
    if (!model) return [];
    const local = seat.engine === 'local';
    const badge = badges?.find((b) => b.seatId === seat.id);
    const cheaper = cheaperModel(seat, model.id);
    return [{
      seatId: seat.id,
      engine: seat.engine,
      label: seat.label,
      model: model.id,
      local,
      private: local && isLoopback(seat, badges),
      supportsTools: badge?.supportsTools ?? null,
      capacity: capacityFromSeat(seat, undefined, model.id),
      ...(cheaper ? { cheaper: { model: cheaper, capacity: capacityFromSeat(seat, undefined, cheaper) } } : {}),
    }];
  });
}

function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return out;
}

export interface AutoSeatState {
  session: VerseSession | null;
  context: MultimodelContext | null;
  policy: BudgetPolicy | null;
  classification: PromptClassification | null;
  advice: SeatAdvice | null;
  advisorSeats: AdvisorSeat[];
  /** Re-advise with a label from the decision layer (once per send). */
  adviseWith(classification: PromptClassification, pinnedSeatId?: string | null): SeatAdvice | null;
}

const FALLBACK_POLICY: BudgetPolicy = { mode: 'balanced', seats: {}, updatedAt: new Date(0).toISOString() };

export function useAutoSeat(input: {
  sessionId: string | null;
  seats: readonly VerseSeat[];
  text: string;
  pref: AutoPref;
  pinnedSeatId: string | null;
}): AutoSeatState {
  const session = useSessionRecord(input.sessionId);
  // By chat id: the server checks EVERY root the chat reaches, not just the primary.
  const context = useQuery(multimodelContextQuery(input.sessionId ? { sessionId: input.sessionId } : { projectPath: null })).data ?? null;
  const budget = useQuery(budgetQuery).data ?? null;
  const policy: BudgetPolicy | null = budget ? { mode: budget.mode, seats: budget.seats, updatedAt: budget.updatedAt } : null;
  const draft = useDebounced(input.text.trim(), CLASSIFY_DEBOUNCE_MS);
  const contextTokens = session?.usage?.contextTokens ?? 0;
  const advisorSeats = useMemo(() => toAdvisorSeats(input.seats, context?.local), [input.seats, context?.local]);

  const classification = useMemo(
    () => (draft && input.pref !== 'off' && input.pref !== 'manager' ? classifyPrompt(draft, { contextTokens }) : null),
    [draft, input.pref, contextTokens],
  );

  const adviseWith = (cls: PromptClassification, pinnedSeatId: string | null = input.pinnedSeatId): SeatAdvice | null => {
    // No advice until the privacy check (context) has answered: a local-only
    // repo must never be routed off this Mac on a guess.
    if (input.pref === 'off' || input.pref === 'manager' || context === null) return null;
    return adviseSeat({
      classification: cls,
      seats: advisorSeats,
      policy: policy ?? FALLBACK_POLICY,
      mode: input.pref,
      nowMs: Date.now(),
      currentSeatId: session?.seatId ?? null,
      turnCount: session?.turnCount ?? 0,
      contextTokens,
      localOnly: context?.localOnly ?? null,
      learned: context?.learned ?? null,
      roi: context?.roi ?? null,
      pinnedSeatId,
    });
  };

  // Recomputed per render on purpose: capacity readings age, and the advisor
  // is cheap (a sort over a handful of seats).
  const advice = classification ? adviseWith(classification) : null;
  return { session, context, policy, classification, advice, advisorSeats, adviseWith };
}
