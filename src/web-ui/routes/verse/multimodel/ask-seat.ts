/**
 * routes/verse/multimodel/ask-seat.ts — "Ask <seat>": send one message to a
 * named seat, from anywhere in the workbench (3.15: a terminal block's
 * "Ask…", review comments' "Send N comments" and "Re-review with…").
 *
 * A turn cannot change its chat's seat, so the message goes to:
 *   - the chat itself, when the chat is already on that seat;
 *   - otherwise a NEW chat on that seat, on the same pinned folders, linked
 *     to the source chat (so the thread view shows where it came from).
 * Built from the same ordinary calls a typed message makes (multimodel-flows'
 * FlowApi), so the spend chokepoint, readiness gate, local-only gate and
 * mutation token all apply. Nothing here runs a command.
 */
import type { VerseSeat, VerseSession } from '../../../data/api-types.js';
import type { ThreadRelation } from '../../../../core/verse/multimodel/types.js';
import { firstRunnableModel } from '../verse-model.js';
import { siblingRequest, type FlowApi, type FlowTarget } from './multimodel-flows.js';

export type AskSeatApi = Pick<FlowApi, 'createSession' | 'sendTurn' | 'link'>;

export interface AskSeatResult {
  sessionId: string;
  /** True when a new chat was created for the seat. */
  created: boolean;
  label: string;
}

/**
 * Every seat a message can be sent to, in the bootstrap's order: seats that
 * are not `unavailable` and have a runnable model. `ready` marks the ones
 * whose health is `ready` (the others may still answer; the server's
 * readiness gate is the authority and refuses with a reason).
 */
export function askableSeats(seats: readonly VerseSeat[]): Array<FlowTarget & { ready: boolean }> {
  return seats.flatMap((seat) => {
    if (seat.health.state === 'unavailable') return [];
    const model = firstRunnableModel(seat);
    if (!model) return [];
    return [{ seatId: seat.id, model: model.id, label: seat.label, engine: seat.engine, ready: seat.health.state === 'ready' }];
  });
}

/** Seats of one engine family, for the "Ask Claude Code / Codex / Devin" chips: the first askable seat per engine. */
export function firstSeatPerEngine(seats: readonly VerseSeat[], engines: readonly string[]): Array<FlowTarget & { ready: boolean }> {
  const all = askableSeats(seats);
  return engines.flatMap((engine) => {
    const hit = all.find((s) => s.engine === engine && s.ready) ?? all.find((s) => s.engine === engine);
    return hit ? [hit] : [];
  });
}

export async function askSeat(
  api: AskSeatApi,
  input: { source: VerseSession; target: FlowTarget; text: string; title?: string; relation?: ThreadRelation },
): Promise<AskSeatResult> {
  const { source, target, text } = input;
  if (source.seatId === target.seatId) {
    await api.sendTurn(source.id, text);
    return { sessionId: source.id, created: false, label: target.label };
  }
  const title = input.title ?? `${source.title.slice(0, 80)} · ${target.label}`;
  const session = await api.createSession(siblingRequest(source, target, title));
  // The link is bookkeeping: a failure there never loses the message.
  void api.link({ parentSessionId: source.id, childSessionId: session.id, relation: input.relation ?? 'compare' }).catch(() => false);
  await api.sendTurn(session.id, text);
  return { sessionId: session.id, created: true, label: target.label };
}
