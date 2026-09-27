/**
 * routes/verse/reasoning/sources-queries.ts — the write behind a transcript
 * turn's "Sources" list (core/verse/sources-api.ts).
 *
 *   POST /api/verse/sources/open {sessionId, path, line?} → {ok} (editor at a line)
 *
 * The server confines `path` to the chat's own folders; a refusal surfaces as
 * the apiPost error. Pulls the held mutation token and touches the hold.
 */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiPost } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const SOURCES_OPEN_PATH = '/api/verse/sources/open';

function token(): string {
  const t = getMutationToken();
  if (!t) throw new VerseMutationLockedError();
  return t;
}

export async function openSourceFile(sessionId: string, path: string, line?: number): Promise<void> {
  await apiPost<{ ok: true }>(SOURCES_OPEN_PATH, line === undefined ? { sessionId, path } : { sessionId, path, line }, token());
  touchMutationHold();
}
