/** Initial-session work is loaded on demand, outside the chat's paint path. */
import type { VerseCreateSessionRequest, VerseSession } from '../../../data/api-types.js';
import type { NewChatRoutingOptions } from '../NewChatDialog.js';
import { createVerseSession, sendVerseTurn } from '../verse-queries.js';
import { setVerseSession } from '../verse-store.js';
import { rememberVerseSeat } from '../verse-ui-store.js';
import { pushHistory, saveDraft } from './composer-memory.js';

type StartedChat = {
  session: VerseSession;
  firstTurn: { ok: true } | { ok: false; error: unknown };
};

/** Called inside the surface's mutation-token guard; never retries a turn. */
export async function startChat(
  req: VerseCreateSessionRequest,
  firstMessage?: string,
  routing?: NewChatRoutingOptions,
): Promise<StartedChat> {
  const autoPrefs = routing ? await import('../multimodel/useAutoSeat.js') : null;
  const session = await createVerseSession(req);
  if (routing) autoPrefs?.saveAutoPref(session.id, routing.automatic ? 'auto' : 'off');
  rememberVerseSeat(session.projectPath, { seatId: session.seatId, model: session.model });
  setVerseSession(session.id, session);
  if (!firstMessage) return { session, firstTurn: { ok: true } };

  // This first turn bypasses the mounted composer's Auto interceptor. Its
  // draft stays available in memory even when browser storage is blocked.
  saveDraft(session.id, firstMessage);
  try {
    if (routing?.automatic) {
      // Session creation may resolve workspace roots newer than the dialog's
      // snapshot. Check those authoritative roots before releasing the prompt.
      const { multimodelContextQuery } = await import('../multimodel/multimodel-queries.js');
      const context = await multimodelContextQuery({ sessionId: session.id }).fetch(new AbortController().signal);
      const privateLocal = session.engine === 'local'
        && context.local.some((badge) => badge.seatId === session.seatId && badge.private);
      if (context.localOnly.on && !privateLocal) {
        throw new Error('This chat now includes a local-only folder. Choose a private local resource before sending.');
      }
    }
    const response = await sendVerseTurn(session.id, firstMessage);
    setVerseSession(session.id, response.session, response.turnId);
    pushHistory(session.id, firstMessage);
    saveDraft(session.id, '');
    return { session, firstTurn: { ok: true } };
  } catch (error) {
    // Session creation succeeded: preserve it and the draft for an explicit
    // retry, including failed privacy reads. Never choose another hosted seat.
    return { session, firstTurn: { ok: false, error } };
  }
}
