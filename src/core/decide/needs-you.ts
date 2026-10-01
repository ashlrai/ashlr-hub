/**
 * decide/needs-you.ts — what deserves Mason's attention, and when.
 *
 *   prioritizeNeedsYou(items)        → items reordered by urgency (ONE call)
 *   worthInterrupting(item, context) → should this push to Telegram NOW?
 *
 * BOUNDS (never a safety gate, and never a way to hide something):
 *   - Prioritization reorders WITHIN a severity band only. Severity is the
 *     deterministic risk ranking (a high-risk approval stays above every warn
 *     item no matter what Jev thinks). Jev only replaces the tie-breaks.
 *   - Interrupt worthiness is escalate-only for high-severity or blocking
 *     items: Jev can never suppress a push the deterministic rule would send
 *     for them. It may suppress low-value info/warn noise, and may promote an
 *     item the rule would have held.
 */

import type { TypeSafeChoiceQuestion } from '../classify/typesafe-client.js';
import { decide, decideEach, type BatchItem } from './decide.js';
import { cacheKey } from './cache.js';
import { NEEDS_YOU_PRIORITIES } from './registry.js';
import type { DecideOptions, Decision, DecisionFallbackReason } from './types.js';

export type NeedsYouPriority = (typeof NEEDS_YOU_PRIORITIES)[number];
export type AttentionSeverity = 'info' | 'warn' | 'high';

/** Structurally compatible with verse/workbench-types NeedsYouItem. */
export interface AttentionItem {
  readonly id: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly kind?: string;
  readonly source?: string;
  readonly severity?: AttentionSeverity;
  /** ISO time it appeared. */
  readonly since?: string | null;
  /** ISO time it stops being actionable (e.g. a veto window closing). */
  readonly expiresAt?: string | null;
  /** Something is blocked until Mason acts. */
  readonly blocking?: boolean;
}

export interface RankedAttentionItem<I extends AttentionItem = AttentionItem> {
  readonly item: I;
  readonly priority: NeedsYouPriority;
  readonly path: 'jev' | 'fallback';
  readonly confidence: number;
  /** Lets the polled view retry transport failures sooner than completed answers. */
  readonly reason?: DecisionFallbackReason;
}

const SEVERITY_RANK: Readonly<Record<AttentionSeverity, number>> = { high: 0, warn: 1, info: 2 };
const PRIORITY_RANK: Readonly<Record<NeedsYouPriority, number>> = { now: 0, today: 1, 'this-week': 2, whenever: 3 };
const HOUR = 3_600_000;

function ts(iso: string | null | undefined, missing: number): number {
  if (!iso) return missing;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : missing;
}

/** Pure, offline, never throws. The deterministic urgency of one item. */
export function needsYouPriorityHeuristic(item: AttentionItem, nowMs: number = Date.now()): NeedsYouPriority {
  const expires = ts(item.expiresAt, Number.POSITIVE_INFINITY);
  if (expires - nowMs <= 2 * HOUR) return 'now';
  if (item.severity === 'high' || item.blocking) return 'now';
  if (expires - nowMs <= 24 * HOUR) return 'today';
  if (item.severity === 'warn') return 'today';
  return 'this-week';
}

/** The ordering used everywhere: severity band first, then priority, then expiry, then newest. */
export function compareRanked(a: RankedAttentionItem, b: RankedAttentionItem): number {
  const sev = SEVERITY_RANK[a.item.severity ?? 'info'] - SEVERITY_RANK[b.item.severity ?? 'info'];
  if (sev !== 0) return sev;
  const pri = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pri !== 0) return pri;
  const ea = ts(a.item.expiresAt, Number.POSITIVE_INFINITY);
  const eb = ts(b.item.expiresAt, Number.POSITIVE_INFINITY);
  if (ea !== eb) return ea - eb;
  const sa = ts(a.item.since, 0);
  const sb = ts(b.item.since, 0);
  if (sa !== sb) return sb - sa;
  return a.item.id.localeCompare(b.item.id);
}

function itemText(item: AttentionItem, nowMs: number): string {
  const lines = [item.title];
  if (item.detail) lines.push(item.detail.slice(0, 400));
  const facts: string[] = [];
  if (item.kind) facts.push(`kind=${item.kind}`);
  if (item.severity) facts.push(`severity=${item.severity}`);
  if (item.blocking) facts.push('blocking=yes');
  const expires = ts(item.expiresAt, Number.NaN);
  if (Number.isFinite(expires)) facts.push(`expires in ${Math.max(0, Math.round((expires - nowMs) / 60_000))} min`);
  const since = ts(item.since, Number.NaN);
  if (Number.isFinite(since)) facts.push(`waiting ${Math.max(0, Math.round((nowMs - since) / 60_000))} min`);
  if (facts.length) lines.push(`(${facts.join(', ')})`);
  return lines.join('\n');
}

const PRIORITY_QUESTION: TypeSafeChoiceQuestion = {
  type: 'choice',
  instructions: 'How soon does the operator need to act on this item?',
  criteria: {
    now: 'Blocking work or expiring within hours; waiting costs something real.',
    today: 'Should be handled today but nothing breaks in the next hour or two.',
    'this-week': 'Worth doing soon; no deadline pressure.',
    whenever: 'Informational or cosmetic; can wait indefinitely.',
  },
};

export type PrioritizeNeedsYouOptions = Omit<DecideOptions<NeedsYouPriority>, 'fallback' | 'interpret' | 'escalateOnly'> & {
  readonly nowMs?: number;
};

/**
 * Rank items by urgency: ONE Jev call per 10 items, each item gated
 * independently. Returns every item exactly once, in display order. NEVER THROWS.
 *
 * STABLE API — the Leader / Telegram agent and the Needs-you view call this.
 */
export async function prioritizeNeedsYou<I extends AttentionItem>(
  items: readonly I[],
  opts: PrioritizeNeedsYouOptions = {},
): Promise<RankedAttentionItem<I>[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const batch: BatchItem<NeedsYouPriority>[] = items.map((item) => ({
    id: item.id,
    text: itemText(item, nowMs),
    fallback: () => needsYouPriorityHeuristic(item, nowMs),
  }));
  let decisions: Decision<NeedsYouPriority>[];
  try {
    decisions = items.length > 1
      ? await decideEach<NeedsYouPriority>('needs-you-priority', batch, PRIORITY_QUESTION, {
        ...opts,
        preamble: 'Each item below is waiting on the operator of an autonomous engineering system.',
      })
      : [];
  } catch {
    decisions = [];
  }
  const ranked = items.map((item, i): RankedAttentionItem<I> => {
    const d = decisions[i];
    return d
      ? { item, priority: d.value, path: d.path, confidence: d.confidence, ...(d.reason ? { reason: d.reason } : {}) }
      : { item, priority: needsYouPriorityHeuristic(item, nowMs), path: 'fallback', confidence: 1 };
  });
  return ranked.sort(compareRanked);
}

// ---------------------------------------------------------------------------
// Worth interrupting Mason now?
// ---------------------------------------------------------------------------

export interface InterruptContext {
  /** Local quiet hours are in effect. */
  readonly quietHours?: boolean;
  /** Minutes since the last push to Mason, when known. */
  readonly minutesSinceLastPush?: number | null;
  /** Mason is actively using Verse right now (a push is redundant). */
  readonly operatorActive?: boolean;
  /** Pushes already sent today. */
  readonly pushesToday?: number;
}

export type WorthInterruptingOptions = Omit<DecideOptions<boolean>, 'fallback' | 'interpret' | 'escalateOnly'>;

function mustNotSuppress(item: AttentionItem): boolean {
  return item.severity === 'high' || item.blocking === true;
}

/** Pure, offline, never throws. */
export function worthInterruptingHeuristic(item: AttentionItem, context: InterruptContext = {}, nowMs: number = Date.now()): boolean {
  if (mustNotSuppress(item)) return true;
  const expires = ts(item.expiresAt, Number.POSITIVE_INFINITY);
  if (expires - nowMs <= 2 * HOUR) return !context.operatorActive;
  if (context.operatorActive) return false;
  if (item.severity === 'warn') return !context.quietHours;
  return false;
}

/**
 * Should this item interrupt Mason (Telegram push) right now? NEVER THROWS.
 * High-severity or blocking items always return true.
 *
 * STABLE API — the Leader / Telegram agent calls this.
 */
export async function worthInterrupting(
  item: AttentionItem,
  context: InterruptContext = {},
  opts: WorthInterruptingOptions & { readonly nowMs?: number } = {},
): Promise<Decision<boolean>> {
  const nowMs = opts.nowMs ?? Date.now();
  const lines = [itemText(item, nowMs)];
  if (context.quietHours) lines.push('It is currently the operator\'s quiet hours.');
  if (context.operatorActive) lines.push('The operator is actively using the app right now.');
  if (typeof context.minutesSinceLastPush === 'number') lines.push(`Last notification was ${Math.round(context.minutesSinceLastPush)} minutes ago.`);
  if (typeof context.pushesToday === 'number') lines.push(`${context.pushesToday} notifications were already sent today.`);
  // Nothing to decide for an item that may never be suppressed.
  const state = mustNotSuppress(item) ? '' : lines.join('\n');
  return decide<boolean>('interrupt-worthiness', state, {
    interrupt: {
      type: 'noul',
      instructions:
        'Is this worth interrupting the operator with a phone notification right now, rather than waiting until they next check in? '
        + 'Say yes only if acting soon matters.',
    },
  }, {
    ...opts,
    fallback: () => worthInterruptingHeuristic(item, context, nowMs),
    // Rank true above false: for must-not-suppress items (handled above) and
    // as a general rule, Jev may only suppress when the rule allows it.
    ...(mustNotSuppress(item) ? { escalateOnly: (v: boolean) => (v ? 1 : 0) } : {}),
    interpret: (answers) => {
      const a = answers['interrupt'];
      if (!a || a.type !== 'noul') return undefined;
      return { value: a.noul >= 0.5, confidence: Math.max(a.noul, 1 - a.noul), label: a.noul >= 0.5 ? 'interrupt' : 'hold' };
    },
  });
}

// ---------------------------------------------------------------------------
// Sync ordering for a polled view (the Verse Needs-you list)
// ---------------------------------------------------------------------------

/**
 * The Needs-you list is rebuilt on every Verse poll, which is exactly the
 * "hot path" the contract keeps Jev off. So the view never awaits Jev: it
 * orders synchronously with whatever ranking is already known for THIS exact
 * set of items, and — when the facts change or expire — kicks off one background
 * `prioritizeNeedsYou` (single-flight per signature) whose answer the next poll
 * uses. Unkeyed, the background pass falls back with no network and the
 * deterministic order is returned unchanged.
 */
const ANSWER_RETRY_MS = 15 * 60_000;
const TRANSPORT_RETRY_MS = 60_000;
const MAX_ORDERING_ENTRIES = 128;
interface OrderingAttempt {
  at: number;
  retryMs: number;
  priorities: ReadonlyMap<string, NeedsYouPriority>;
}
const attempts = new Map<string, OrderingAttempt>();
const inflight = new Set<string>();
let generation = 0;

function signatureOf(items: readonly AttentionItem[], nowMs: number): string {
  // Keep only a hash, never the classified text. Minute-by-minute waiting age
  // is deliberately excluded; real deadline urgency changes invalidate immediately.
  const facts = items.map((i) => JSON.stringify([
    i.id, i.title, i.detail?.slice(0, 400) ?? '', i.kind ?? '', i.severity ?? 'info',
    i.blocking === true, i.since ?? '', i.expiresAt ?? '', needsYouPriorityHeuristic(i, nowMs),
  ])).sort();
  return cacheKey(facts);
}

function rememberAttempt(signature: string, ranked: readonly RankedAttentionItem[], at: number): void {
  // Successful low-confidence answers deserve the same quiet interval as winners.
  // Transport, disabled/unkeyed and budget failures must recover after one minute.
  const transient = ranked.some((r) => r.path === 'fallback'
    && r.reason !== 'below-threshold' && r.reason !== 'no-answer' && r.reason !== 'escalate-only');
  attempts.delete(signature);
  attempts.set(signature, {
    at, retryMs: transient ? TRANSPORT_RETRY_MS : ANSWER_RETRY_MS,
    priorities: new Map(ranked.filter((r) => r.path === 'jev').map((r) => [r.item.id, r.priority])),
  });
  while (attempts.size > MAX_ORDERING_ENTRIES) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

/**
 * Re-order an already deterministically sorted list using the last Jev
 * ranking for this exact item set (within severity bands only). Pure except
 * for scheduling the background refresh. Never throws; never awaits.
 */
export function orderNeedsYouWithJev<I extends AttentionItem>(sorted: readonly I[], nowMs: number = Date.now()): I[] {
  try {
    if (sorted.length < 2) return [...sorted];
    const signature = signatureOf(sorted, nowMs);
    const attempt = attempts.get(signature);
    if (attempt && nowMs >= attempt.at && nowMs - attempt.at < attempt.retryMs) {
      attempts.delete(signature);
      attempts.set(signature, attempt);
      const priorities = attempt.priorities;
      const position = new Map(sorted.map((item, i) => [item.id, i] as const));
      return [...sorted].sort((a, b) => {
        const sev = SEVERITY_RANK[a.severity ?? 'info'] - SEVERITY_RANK[b.severity ?? 'info'];
        if (sev !== 0) return sev;
        const pa = priorities.get(a.id);
        const pb = priorities.get(b.id);
        if (pa && pb && pa !== pb) return PRIORITY_RANK[pa] - PRIORITY_RANK[pb];
        return (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0);
      });
    }
    attempts.delete(signature);
    if (!inflight.has(signature) && inflight.size < MAX_ORDERING_ENTRIES) {
      inflight.add(signature);
      const startedGeneration = generation;
      void prioritizeNeedsYou(sorted, { nowMs })
        .then((ranked) => {
          if (startedGeneration === generation) rememberAttempt(signature, ranked, nowMs);
        })
        .catch(() => undefined)
        .finally(() => {
          if (startedGeneration === generation) inflight.delete(signature);
        });
    }
    return [...sorted];
  } catch {
    return [...sorted];
  }
}

/** Test seam. */
export function resetNeedsYouOrderingForTests(): void {
  generation++;
  attempts.clear();
  inflight.clear();
}
