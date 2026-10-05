/** Host work is execution ownership, not where a model's inference happens.
 * Vendor CLI and local-model chat orchestration need this host; Devin cloud
 * sessions execute elsewhere. Unknown Devin lane remains unknown.
 */
import type { VerseSession } from './types.js';
export function localChatRuns(sessions: readonly Pick<VerseSession, 'status' | 'engine' | 'remote'>[]): number | null {
  let count = 0;
  let unknown = false;
  for (const session of sessions) {
    if (session.status !== 'running') continue;
    if (session.engine === 'devin') {
      if (!session.remote?.lane) { unknown = true; continue; }
      if (session.remote.lane === 'cloud') continue;
    }
    count += 1;
  }
  return unknown && count === 0 ? null : count;
}

/** Preserve positive known host work even when the independent source is unknown. */
export function combineLocalRuns(chats: number | null, fleet: number | null): number | null {
  if (chats === null || fleet === null) {
    const known = (chats ?? 0) + (fleet ?? 0);
    return known > 0 ? known : null;
  }
  return chats + fleet;
}

export function localWorkCounts(chatRuns: number | null, fleetRuns: number | null) {
  return { sourceVersion: 1 as const, localRuns: combineLocalRuns(chatRuns, fleetRuns), chatRuns, fleetRuns };
}
