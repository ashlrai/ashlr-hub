/**
 * routes/verse/reasoning/pane-data.ts — what a Sources / Reasoning pane needs
 * when it is mounted OUTSIDE the transcript (a dock pane, a split), from
 * nothing but the session id.
 *
 * Turns are derived with the same pipeline the transcript uses
 * (groupTranscriptItems → buildTurns) over the same memoized transcript, with
 * a per-hook TurnCache so a streamed token re-derives only the live turn.
 * Jumps go through the transcript's own bus (chat/transcript-jump.ts), so a
 * click in a pane lands on the call or turn with the same reveal machinery
 * (opening a folded activity group, the locator flash).
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { VerseSession } from '../../../../core/verse/types.js';
import { requestTranscriptJump } from '../chat/transcript-jump.js';
import { toolAnchorId } from '../chat/tool-semantics.js';
import { buildTurns, createTurnCache, turnAnchorId, type TurnBlock } from '../chat/turn-model.js';
import { useSessionSubscription } from '../useVerseSession.js';
import { useVerseTranscript } from '../useVerseTranscript.js';
import { getVerseSessionHead } from '../verse-store.js';
import { groupTranscriptItems } from '../verse-transcript.js';
import { openSourceFile } from './sources-queries.js';

export function useChatTurns(sessionId: string | null): TurnBlock[] {
  const transcript = useVerseTranscript(sessionId);
  const cache = useRef(createTurnCache());
  return useMemo(() => buildTurns(groupTranscriptItems(transcript.items), cache.current).turns, [transcript]);
}

export function useSessionRecord(sessionId: string | null): VerseSession | null {
  const subscribe = useSessionSubscription(sessionId);
  const read = () => getVerseSessionHead(sessionId).session;
  return useSyncExternalStore(subscribe, read, read);
}

export interface PaneActions {
  openFile: (path: string, line: number | undefined) => Promise<void>;
  jumpToTool: (toolUseId: string) => void;
  jumpToTurn: (turnKey: string) => void;
}

export function usePaneActions(sessionId: string | null): PaneActions {
  const openFile = useCallback(async (path: string, line: number | undefined) => {
    if (!sessionId) throw new Error('no chat is open');
    await openSourceFile(sessionId, path, line);
  }, [sessionId]);
  const jumpToTool = useCallback((toolUseId: string) => { requestTranscriptJump(toolAnchorId(toolUseId)); }, []);
  const jumpToTurn = useCallback((turnKey: string) => { requestTranscriptJump(turnAnchorId(turnKey)); }, []);
  return useMemo(() => ({ openFile, jumpToTool, jumpToTurn }), [openFile, jumpToTool, jumpToTurn]);
}
