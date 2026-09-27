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
import { useCallback, useMemo, useRef } from 'react';
import { requestTranscriptJump } from '../chat/transcript-jump.js';
import { toolAnchorId } from '../chat/tool-semantics.js';
import { buildTurns, createTurnCache, turnAnchorId, type TurnBlock, type TurnCache } from '../chat/turn-model.js';
import { useVerseTranscript } from '../useVerseTranscript.js';
import { groupTranscriptItems } from '../verse-transcript.js';
import { openSourceFile } from './sources-queries.js';

/**
 * The chat's turns. `active: false` (a pane kept alive behind another tab)
 * unsubscribes from the stream and keeps the last turns it derived, so a
 * hidden pane does no work per token; it catches up when shown again.
 */
export function useChatTurns(sessionId: string | null, active = true): TurnBlock[] {
  const transcript = useVerseTranscript(active ? sessionId : null);
  const cache = useRef<{ sessionId: string | null; cache: TurnCache }>({ sessionId, cache: createTurnCache() });
  const last = useRef<{ sessionId: string | null; turns: TurnBlock[] }>({ sessionId, turns: [] });
  return useMemo(() => {
    if (!active) return last.current.sessionId === sessionId ? last.current.turns : [];
    if (cache.current.sessionId !== sessionId) cache.current = { sessionId, cache: createTurnCache() };
    const turns = buildTurns(groupTranscriptItems(transcript.items), cache.current.cache).turns;
    last.current = { sessionId, turns };
    return turns;
  }, [transcript, active, sessionId]);
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
