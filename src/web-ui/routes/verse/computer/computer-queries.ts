/**
 * routes/verse/computer/computer-queries.ts — the Verse window's calls to the
 * computer-use relay (core/verse/computer-api.ts). Same conventions as the
 * Browser pane's (browser/browser-queries.ts): writes pull the held mutation
 * token and throw `VerseMutationLockedError` when none is held; reads carry
 * the read-client proof.
 *
 * ONE poller for the whole window, not one per chat: the sidecar queues every
 * chat's commands on the same relay, and polling is also how it knows the
 * Verse window is present.
 *
 * Everything is injectable (`ComputerApi`) so the runner and the component
 * are tested on fakes.
 */
import { getMutationToken, hasMutationHold, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import {
  VERSE_COMPUTER_COMMANDS_PATH,
  VERSE_COMPUTER_KILL_PATH,
  VERSE_COMPUTER_RESULT_PATH,
  VERSE_COMPUTER_REVOKE_PATH,
  VERSE_COMPUTER_STATE_PATH,
  type VerseComputerCommandResult,
  type VerseComputerCommandsResponse,
  type VerseComputerState,
} from '../../../../core/verse/computer-types.js';
import { VerseMutationLockedError } from '../verse-queries.js';

/** The long-poll's server-side wait (the route caps it at 20 s). */
export const COMPUTER_POLL_WAIT_MS = 20_000;

/** The relay's refusal when a result arrives after the command timed out. */
export const COMMAND_GONE_CODE = 'VERSE_COMPUTER_COMMAND_GONE';

export interface ComputerApi {
  /** The long-poll. Resolves `{ commands: [] }` after the server's wait. */
  commands(signal?: AbortSignal): Promise<VerseComputerCommandsResponse>;
  /** Answer one command. A command that already timed out is not an error. */
  result(result: VerseComputerCommandResult): Promise<void>;
  state(signal?: AbortSignal): Promise<VerseComputerState>;
  revoke(sessionId: string, bundleId?: string): Promise<VerseComputerState>;
  /** KILL: revoke every grant of every chat and fail everything waiting. */
  kill(): Promise<VerseComputerState>;
  /** True when a mutation token is held (commands can be answered). */
  canWrite(): boolean;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token, signal);
  touchMutationHold();
  return result;
}

export function isCommandGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === COMMAND_GONE_CODE;
}

export const computerApi: ComputerApi = {
  commands: (signal) => apiGet(`${VERSE_COMPUTER_COMMANDS_PATH}?wait=${COMPUTER_POLL_WAIT_MS}`, signal),
  result: async (result) => {
    try {
      await post(VERSE_COMPUTER_RESULT_PATH, result);
    } catch (err) {
      // The sidecar gave up on it already (its own timeout, or KILL): the
      // agent was told; there is nobody left to answer.
      if (isCommandGone(err)) return;
      throw err;
    }
  },
  state: (signal) => apiGet(VERSE_COMPUTER_STATE_PATH, signal),
  revoke: (sessionId, bundleId) => post(VERSE_COMPUTER_REVOKE_PATH, bundleId ? { sessionId, bundleId } : { sessionId }),
  kill: () => post(VERSE_COMPUTER_KILL_PATH, {}),
  canWrite: () => hasMutationHold(),
};
