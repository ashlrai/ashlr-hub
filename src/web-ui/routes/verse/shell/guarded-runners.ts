/**
 * routes/verse/shell/guarded-runners.ts — what the shell's own guarded
 * commands DO once the operator has confirmed (and unlocked): stop every
 * running chat, stop the fleet.
 *
 * Split from run-command.ts, which still owns the guard itself (confirm →
 * token → run, through guarded-action.tsx). run-command is on the chat
 * first-paint path — the shell's key handler runs through it — while these
 * run only after a confirmation, so run-command loads this module with
 * import() when a run starts. Keep SHELL_GUARDED_COMMAND_IDS in
 * run-command.ts in step with GUARDED_RUNNERS below.
 */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { cancelVerseTurn } from '../verse-queries.js';
import { shellNotify } from './run-command.js';
import { getActivityState, refreshActivity } from './useActivity.js';

function requireToken(path: string): string {
  const token = getMutationToken();
  if (!token) throw new ApiError('Mutation token was rejected.', 401, path);
  return token;
}

/** Stop every running chat. Stops what activity says is running NOW, one cancel each. */
async function stopRunningChats(): Promise<void> {
  await refreshActivity();
  const running = getActivityState().data?.running ?? [];
  if (running.length === 0) {
    shellNotify('Nothing is running.', 'neutral');
    return;
  }
  requireToken('/api/verse/sessions');
  const results = await Promise.allSettled(running.map((r) => cancelVerseTurn(r.sessionId)));
  touchMutationHold();
  const failed = results.filter((r) => r.status === 'rejected').length;
  void refreshActivity();
  if (failed > 0) throw new Error(`Stopped ${running.length - failed} of ${running.length} chats; ${failed} did not answer.`);
  shellNotify(running.length === 1 ? 'Stopped 1 chat.' : `Stopped ${running.length} chats.`, 'success');
}

/**
 * Stop the fleet: the authority route's `stop` (B-U1) when this build has it;
 * otherwise the daemon's ordinary stop, which engages the kill switch
 * (control-api.ts `POST /api/verse/daemon {action:'stop'}`). Both stop
 * autonomous work only — chats keep running.
 */
async function stopFleet(): Promise<void> {
  const token = requireToken('/api/verse/authority');
  let body: unknown = null;
  try {
    body = await apiPost<unknown>('/api/verse/authority', { action: 'stop' }, token);
  } catch (err) {
    // A CODELESS 404 from the authority route = not in this build (or no
    // dispatch, which the daemon route will then report on its own).
    if (!(err instanceof ApiError && err.status === 404 && err.code === null)) throw err;
    await apiPost<unknown>('/api/verse/daemon', { action: 'stop' }, token);
  }
  touchMutationHold();
  void refreshActivity();
  shellNotify(describeFleetStop(body), 'success');
}

/**
 * The toast after Stop, from B-U1's StopResult (`{ result: { stop } }` on
 * the authority route). Stop arms KILL at once but does not wait for agents
 * admitted before it (waitMs 0), so "stopped" alone would claim more than the
 * server knows (B-U6 request 8): the drain state and any armed merge it could
 * not revoke are said out loud. The daemon fallback has no such fields and
 * gets the plain sentence.
 */
export function describeFleetStop(body: unknown): string {
  const base = 'Fleet stopped. It stays stopped until you resume it.';
  const stop = (body as { result?: { stop?: unknown } } | null)?.result?.stop;
  if (typeof stop !== 'object' || stop === null) return base;
  const { quiesced, liveExecutionLeases, mergeRevokeFailures } = stop as {
    quiesced?: unknown;
    liveExecutionLeases?: unknown;
    mergeRevokeFailures?: unknown;
  };
  const parts = [base];
  if (quiesced === false) {
    const n = typeof liveExecutionLeases === 'number' && Number.isFinite(liveExecutionLeases) && liveExecutionLeases > 0 ? liveExecutionLeases : null;
    // Unknown counts as still running (the server fails closed the same way).
    parts.push(n === null ? 'Agents already running are finishing.' : `${n} agent${n === 1 ? ' is' : 's are'} still finishing work started before Stop.`);
  }
  if (Array.isArray(mergeRevokeFailures) && mergeRevokeFailures.length > 0) {
    const m = mergeRevokeFailures.length;
    parts.push(`${m} armed merge${m === 1 ? '' : 's'} could not be revoked; Stop still blocks ${m === 1 ? 'it' : 'them'}.`);
  }
  return parts.join(' ');
}

export const GUARDED_RUNNERS: Readonly<Record<string, () => Promise<void>>> = {
  'chats.stop-all': stopRunningChats,
  'fleet.stop': stopFleet,
};

/** Run the shell's runner for a confirmed guarded command. */
export function runGuardedShellCommand(id: string): Promise<void> {
  const runner = GUARDED_RUNNERS[id];
  if (!runner) return Promise.reject(new Error(`No shell runner for ${id}.`));
  return runner();
}
