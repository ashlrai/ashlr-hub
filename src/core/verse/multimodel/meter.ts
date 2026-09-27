/**
 * The per-chat meter: what one conversation has used ACROSS SEATS — its own
 * turns, the chats it was handed off from and to, and every Compare answer,
 * review, draft and escalation linked to it.
 *
 * A "thread" is the connected component of one chat under two edges:
 *   - `handoffFrom` (pinned on the session record by the handoff route);
 *   - thread links (compare / review / draft / escalate), recorded when those
 *     chats are created.
 * Bounded (THREAD_MAX_SESSIONS) so a pathological link graph cannot make a
 * meter read expensive.
 *
 * MONEY IS AN EQUIVALENT. Claude Max, Codex and SuperGrok are subscriptions:
 * nothing here is billed per token. `listUsd` is what the same tokens would
 * cost at the provider's API list price — useful for comparing seats and for
 * "cheap-first saved ≈$X", and labelled as exactly that. Subscription use is
 * shown as what it really is: the binding window's percent.
 *
 * PURE: the caller passes sessions, links, prices and seat readings.
 */
import type { VerseSession } from '../types.js';
import { listCostUsd, type ListPrice } from './escalation.js';
import type { ChatMeter, ChatMeterSeat, ChatMeterSession, ThreadLink } from './types.js';

export const THREAD_MAX_SESSIONS = 50;

type ThreadSession = Pick<VerseSession, 'id' | 'title' | 'seatId' | 'engine' | 'model' | 'usage' | 'handoffFrom'>;

/** Every session in `rootId`'s thread, root's own relation first. */
export function threadOf(
  rootId: string,
  sessions: readonly ThreadSession[],
  links: readonly ThreadLink[],
): Array<{ session: ThreadSession; relation: ChatMeterSession['relation'] }> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  if (!byId.has(rootId)) return [];
  const edges = new Map<string, Array<{ to: string; relation: ChatMeterSession['relation'] }>>();
  const edge = (a: string, b: string, relation: ChatMeterSession['relation']) => {
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a)!.push({ to: b, relation });
  };
  for (const s of sessions) {
    const from = s.handoffFrom?.sessionId;
    if (from && byId.has(from)) {
      edge(from, s.id, 'handoff');
      edge(s.id, from, 'handoff');
    }
  }
  for (const l of links) {
    if (!byId.has(l.parentSessionId) || !byId.has(l.childSessionId)) continue;
    edge(l.parentSessionId, l.childSessionId, l.relation);
    edge(l.childSessionId, l.parentSessionId, 'handoff');
  }
  const out: Array<{ session: ThreadSession; relation: ChatMeterSession['relation'] }> = [];
  const seen = new Set<string>([rootId]);
  const queue: Array<{ id: string; relation: ChatMeterSession['relation'] }> = [{ id: rootId, relation: 'root' }];
  while (queue.length > 0 && out.length < THREAD_MAX_SESSIONS) {
    const next = queue.shift()!;
    out.push({ session: byId.get(next.id)!, relation: next.relation });
    for (const e of edges.get(next.id) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      // A link's relation describes the CHILD; walking back up a link reads as the chat it came from.
      const link = links.find((l) => l.parentSessionId === next.id && l.childSessionId === e.to);
      queue.push({ id: e.to, relation: link ? link.relation : 'handoff' });
    }
  }
  return out;
}

export interface MeterInput {
  sessionId: string;
  sessions: readonly ThreadSession[];
  links: readonly ThreadLink[];
  /** API list price for a seat's model; null = unknown or free. */
  priceOf(engine: string, model: string): ListPrice | null;
  /** Seat readings for the seats this thread used. */
  seats: readonly ChatMeterSeat[];
  budgetMode: string;
}

export function buildChatMeter(input: MeterInput): ChatMeter {
  const thread = threadOf(input.sessionId, input.sessions, input.links);
  const rows: ChatMeterSession[] = thread.map(({ session, relation }) => {
    const local = session.engine === 'local';
    const price = local ? null : input.priceOf(session.engine, session.model);
    const inputTokens = (session.usage?.inputTokens ?? 0) + (session.usage?.cacheCreationTokens ?? 0);
    const outputTokens = session.usage?.outputTokens ?? 0;
    const cacheReadTokens = session.usage?.cacheReadTokens ?? 0;
    return {
      sessionId: session.id,
      title: session.title,
      seatId: session.seatId,
      engine: session.engine,
      model: session.model,
      relation,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      listUsd: price ? listCostUsd({ input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens }, price) : null,
      local,
    };
  });

  // The frontier rate cheap-first is measured against: the dearest paid seat
  // this thread actually used, else the root's own seat price.
  const paidPrices = rows.filter((r) => !r.local).map((r) => input.priceOf(r.engine, r.model)).filter((p): p is ListPrice => p !== null);
  const frontier = paidPrices.sort((a, b) => (b.inPerM + b.outPerM) - (a.inPerM + a.outPerM))[0] ?? null;
  const localRows = rows.filter((r) => r.local);
  const localTokens = localRows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  const savedUsd = frontier
    ? localRows.reduce((sum, r) => sum + listCostUsd({ input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens }, frontier), 0)
    : 0;
  const listUsd = rows.reduce((sum, r) => sum + (r.listUsd ?? 0), 0);

  const used = new Set(rows.map((r) => r.seatId));
  return {
    sessionId: input.sessionId,
    sessions: rows,
    totals: {
      inputTokens: rows.reduce((sum, r) => sum + r.inputTokens, 0),
      outputTokens: rows.reduce((sum, r) => sum + r.outputTokens, 0),
      listUsd: Math.round(listUsd * 100) / 100,
      localTokens,
      savedUsd: Math.round(savedUsd * 100) / 100,
    },
    seats: input.seats.filter((s) => used.has(s.seatId)),
    budgetMode: input.budgetMode,
    note: 'Dollar figures are API list-price equivalents; subscription seats are billed by plan, and use shows as their window percent. Your chats may use the fleet reserve — it is kept for you.',
  };
}
