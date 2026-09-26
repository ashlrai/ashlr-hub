/**
 * routes/verse/Transcript.tsx — the conversation, in one 720px measure.
 *
 * 3.10.1: the user turn is a quiet rounded block on the right (the hover
 * ground, primary text), the assistant turn plain primary text at full
 * measure — role by placement and shape, never by colour alone. A turn ends
 * in a muted footer (how long it took, the jump to its first failure) instead
 * of a lone duration line between turns, and every path a tool touched reads
 * relative to the chat's roots (chat/path-display.ts).
 *
 * Runs of tool calls fold (verse-store groupTranscriptItems) into one
 * activity row — "Ran 12 commands · read 8 files · edited 3 files · 1 failed · 2m 14s"
 * (chat/ActivityGroup) — that opens on its failed and running calls by
 * itself, so an agentic turn reads as a summary line between two pieces of
 * prose instead of a wall of cards.
 *
 * 3.10 also adds the ChapterRail (a minimap of turns down the right edge)
 * and a screen-reader announcer that speaks turn boundaries instead of
 * every streamed token.
 *
 * On top of that the items are grouped into TURNS (`chat/turn-model.ts`),
 * which is what makes a long agentic session usable:
 *
 *   - each turn ends with a file-activity summary — the blast radius of one
 *     ask, with a click-through to the call that changed each file;
 *   - the nav strip gives the session an outline, a search over prose AND
 *     tool payloads, and a jump to the first failure;
 *   - Alt+↑/↓ (and plain ↑/↓ once a turn has focus) step between turns.
 *
 * V3.9: a native compaction renders as a divider that says what the CLI
 * reported ("Auto-compacted 812k → 41k in 1m 58s" / "Codex compacted its
 * context"), and a chat started as a handoff opens with "Continued from
 * <source>", which links back to the chat it continues.
 *
 * V3.10 — live reasoning and a transcript that costs one turn per frame:
 *
 *   - the model's reasoning streams in a ThinkingBlock ("Thinking · 12s ·
 *     ~1.8k tok"), in a three-line window that folds when the block ends
 *     (Settings ▸ Chat: Collapsed / Expanded / Hidden);
 *   - the live status line ("Running · 14s · npm test") and the engine's
 *     retry / watchdog notices sit ABOVE THE COMPOSER (Workspace), not in the
 *     log: they describe the turn you are waiting on, not its history;
 *   - the store hands the transcript over in turn SEGMENTS that keep their
 *     identity while unchanged; each segment's turn model is derived once
 *     and every finished turn is a memoized TurnView, so a streamed token
 *     re-renders the one live turn — not the session. Finished turns also
 *     get `content-visibility: auto`, so the browser skips laying out the
 *     ones scrolled out of view;
 *   - a restored conversation (`recovered`) and a trimmed log
 *     (`history-truncated`) say so in the transcript.
 *
 * Follows the newest message unless the operator scrolled up, in which case
 * a "Jump to latest" control appears.
 */
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { VerseEngine, VerseSession } from '../../data/api-types.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { ActivityGroupView, revealAnchorInGroups } from './chat/ActivityGroup.js';
import { ChapterRail } from './chat/ChapterRail.js';
import { PathRootsContext } from './chat/path-display.js';
import { buildChapters, chaptersSignature } from './chat/chapter-model.js';
import { FileActivity } from './chat/FileActivity.js';
import { useReasoningDisplay, type ReasoningDisplay } from './chat/reasoning-pref.js';
import { ThinkingBlock } from './chat/ThinkingBlock.js';
import { onTranscriptFind, onTranscriptJump, onTranscriptStep } from './chat/transcript-jump.js';
import { TranscriptNav } from './chat/TranscriptNav.js';
import { TurnAnnouncer } from './chat/TurnAnnouncer.js';
import { toolAnchorId, type ToolFacts } from './chat/tool-semantics.js';
import { buildTurns, createTurnCache, noteAnchorId, searchTurns, turnAnchorId, type TurnBlock, type TurnCache } from './chat/turn-model.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { ToolUseCard, type ToolUseCardProps } from './ToolUseCard.js';
import { ArrowDownIcon } from './verse-icons.js';
import { ENGINE_LABEL, formatDuration } from './verse-model.js';
import { formatTokens } from './verse-readouts.js';
import type { VerseLiveState } from './verse-store.js';
import {
  groupTranscriptItems,
  type ToolGroupItem,
  type ToolGroupMember,
  type Transcript as TranscriptModel,
  type TranscriptItem,
  type TranscriptRenderItem,
  type TranscriptSegment,
} from './verse-transcript.js';
import styles from './Transcript.module.css';

export interface TranscriptProps {
  transcript: TranscriptModel;
  loaded: boolean;
  loadError: string | null;
  onRetry?: () => void;
  emptyHint?: string;
  /** Names the CLI in compaction dividers whose counts are unknown ("Codex compacted its context"). */
  engine?: VerseEngine;
  /** V3.9: this chat was started as a handoff; the header links back to the source. */
  handoffFrom?: VerseSession['handoffFrom'] | null;
  /** Opens another chat (the handoff source). Absent → the source is named but not a link. */
  onOpenSession?: (sessionId: string) => void;
  /** V3.10: transient signals of the running turn (the streaming reasoning block). */
  live?: VerseLiveState | null;
  /**
   * 3.10.1: the chat's roots, primary first. Tool paths under one of them are
   * drawn relative to it (the full path stays in the tooltip). Absent → the
   * roots already in context (Workspace provides them). Keep the array
   * identity stable — every card showing a path re-renders when it changes.
   */
  projectRoots?: readonly string[];
}

type CompactionItem = Extract<TranscriptItem, { kind: 'compaction' }>;

/**
 * One line for a native compaction, from exactly what the CLI reported:
 * "Auto-compacted 812k → 41k in 1m 58s" when claude/grok sent the counts,
 * "Codex compacted its context" when the CLI records only that it happened.
 * Never a number the CLI did not give.
 */
export function describeCompaction(item: Pick<CompactionItem, 'trigger' | 'preTokens' | 'postTokens' | 'durationMs'>, engine?: VerseEngine): string {
  const verb = item.trigger === 'manual' ? 'Compacted on request' : 'Auto-compacted';
  const took = item.durationMs !== null && item.durationMs > 0 ? ` in ${formatDuration(item.durationMs)}` : '';
  if (item.preTokens !== null && item.postTokens !== null) {
    return `${verb} ${formatTokens(item.preTokens)} → ${formatTokens(item.postTokens)}${took}`;
  }
  if (item.preTokens !== null) return `${verb} at ${formatTokens(item.preTokens)}${took}`;
  const who = engine ? ENGINE_LABEL[engine] : 'The CLI';
  return `${who} compacted its context${took}`;
}

/**
 * What an error `code` (V3.10, VERSE_ERROR_CODES) means for the operator.
 * The message itself is the CLI's own words; this is the "so what now".
 */
export function errorCodeHint(code: string | null): string | null {
  switch (code) {
    case 'native-thread-missing':
      return 'The CLI no longer has this chat’s saved conversation (it may have expired). Continue in a fresh chat — the transcript here is intact.';
    case 'session-in-use':
      return 'The CLI says this chat’s native session is still held by another process. Wait for it to finish, or continue in a fresh chat.';
    default:
      return null;
  }
}

const FOLLOW_THRESHOLD_PX = 48;
/** Below this the session is short enough to scroll; chrome would be noise. */
const NAV_MIN_TURNS = 3;
/** How long a jumped-to element keeps its locator tint. */
const FLASH_MS = 1400;

/** One segment's derived turns — computed once per segment object. */
interface SegmentModel {
  turns: TurnBlock[];
  facts: Map<string, ToolFacts>;
  errorAnchors: string[];
  /** turn-done items already explained by a preceding Stop / error in the same turn. */
  explained: ReadonlySet<string>;
}

function explainedKeys(items: readonly TranscriptItem[]): Set<string> {
  // A `turn-done ok:false` that follows the same turn's `cancelled`/`error`
  // note is already explained; a second red "ended without a result" line
  // would make every Stop look like a failure.
  const out = new Set<string>();
  let last: { turnId: string | null; kind: string } | null = null;
  for (const item of items) {
    // A compaction between a Stop and its turn-done explains nothing and
    // hides nothing; it must not break the pairing.
    if (item.kind === 'compaction') continue;
    if (item.kind === 'turn-done' && !item.ok && last && last.turnId === item.turnId && (last.kind === 'cancelled' || last.kind === 'error')) {
      out.add(item.key);
    }
    last = { turnId: item.turnId, kind: item.kind };
  }
  return out;
}

function deriveSegment(segment: TranscriptSegment, cache: TurnCache): SegmentModel {
  const model = buildTurns(groupTranscriptItems(segment.items), cache);
  return { turns: model.turns, facts: model.facts, errorAnchors: model.errorAnchors, explained: explainedKeys(segment.items) };
}

export function Transcript({ transcript, loaded, loadError, onRetry, emptyHint, engine, handoffFrom = null, onOpenSession, live = null,
  projectRoots }: TranscriptProps) {
  const reasoning = useReasoningDisplay();
  const inheritedRoots = useContext(PathRootsContext);
  const scroller = useRef<HTMLDivElement>(null);
  const turnNodes = useRef(new Map<string, HTMLElement>());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(-1);
  const [focusToken, setFocusToken] = useState(0);
  const lastVersion = useRef('');

  // Per-segment derivation. The store returns an unchanged segment as the
  // SAME object, so only the live turn's segment misses this cache while a
  // reply streams; the tool-facts cache below additionally keeps a rebuilt
  // segment from re-deriving tool calls whose results already landed.
  const turnCache = useRef(createTurnCache());
  const segmentModels = useRef(new WeakMap<TranscriptSegment, SegmentModel>());
  const segments = useMemo<TranscriptSegment[]>(
    () => transcript.segments ?? [{ key: 'all', items: transcript.items }],
    [transcript],
  );
  const perSegment = useMemo(() => segments.map((segment) => {
    let model = segmentModels.current.get(segment);
    if (!model) {
      model = deriveSegment(segment, turnCache.current);
      segmentModels.current.set(segment, model);
    }
    return model;
  }), [segments]);
  const turns = useMemo(() => perSegment.flatMap((m) => m.turns), [perSegment]);
  /** Index of each segment's first turn in `turns` (for the per-turn ordinal). */
  const turnOffsets = useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (const m of perSegment) {
      out.push(n);
      n += m.turns.length;
    }
    return out;
  }, [perSegment]);
  const errorAnchors = useMemo(() => perSegment.flatMap((m) => m.errorAnchors), [perSegment]);
  // The rail's model, rebuilt only when what it draws changes (never per token).
  const turnsForRail = useRef(turns);
  turnsForRail.current = turns;
  const railSignature = chaptersSignature(turns, handoffFrom !== null);
  const chapters = useMemo(
    () => buildChapters(turnsForRail.current, { handoff: handoffFrom !== null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature IS the dependency
    [railSignature],
  );
  const matches = useMemo(
    () => searchTurns(turns, query, turnCache.current),
    [turns, query],
  );
  const matchKeys = useMemo(() => new Set(matches.map((m) => m.turnKey)), [matches]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const node = scroller.current;
    if (!node) return;
    // jsdom has no Element.scrollTo; fall back to the property for tests.
    if (typeof node.scrollTo === 'function') node.scrollTo({ top: node.scrollHeight, behavior });
    else node.scrollTop = node.scrollHeight;
  }, []);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distance <= FOLLOW_THRESHOLD_PX;
    setFollowing(atBottom);
    if (atBottom) setUnseen(false);
  }

  // ---- jumping -------------------------------------------------------------
  /** Scroll an element into view and tint it briefly so the eye can find it. */
  const reveal = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    setFollowing(false);
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (typeof node.focus === 'function') node.focus({ preventScroll: true });
    node.setAttribute('data-flash', 'true');
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => node.removeAttribute('data-flash'), FLASH_MS);
  }, []);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const jumpToTurn = useCallback((turnKey: string) => {
    reveal(turnNodes.current.get(turnKey) ?? null);
  }, [reveal]);

  /**
   * Open the disclosure chain around a tool call before revealing it. A call
   * folded inside a collapsed activity group is not in the DOM at all: the
   * group is asked to open (revealAnchorInGroups) and the jump retried on
   * the next frame, once it has rendered its members.
   */
  const jumpToAnchor = useCallback((id: string, retried = false): boolean => {
    const node = scroller.current?.ownerDocument?.getElementById(id) ?? null;
    if (!node) {
      if (!retried && revealAnchorInGroups(id)) {
        requestAnimationFrame(() => { jumpToAnchor(id, true); });
        return true;
      }
      return false;
    }
    for (let el: Element | null = node; el; el = el.parentElement) {
      if (el instanceof HTMLDetailsElement) el.open = true;
      if (el === scroller.current) break;
    }
    reveal(node);
    return true;
  }, [reveal]);

  // The dock's Tasks pane (and anything else outside this subtree) jumps
  // through the bus; ⌘K "Find in chat" focuses the search the same way ⌘F does.
  useEffect(() => onTranscriptJump((id) => jumpToAnchor(id)), [jumpToAnchor]);
  const findable = turns.length >= NAV_MIN_TURNS;
  useEffect(() => onTranscriptFind(() => {
    if (!findable) return false;
    setFocusToken((n) => n + 1);
    return true;
  }), [findable]);

  const jumpToTool = useCallback((toolUseId: string) => jumpToAnchor(toolAnchorId(toolUseId)), [jumpToAnchor]);

  const jumpToFirstError = useCallback(() => {
    const anchor = errorAnchors[0];
    if (anchor) jumpToAnchor(anchor);
  }, [errorAnchors, jumpToAnchor]);

  const registerTurn = useCallback((key: string, node: HTMLElement | null) => {
    if (node) turnNodes.current.set(key, node);
    else turnNodes.current.delete(key);
  }, []);

  const stepMatch = useCallback((delta: number) => {
    if (matches.length === 0) return;
    const next = matchIndex < 0
      ? (delta > 0 ? 0 : matches.length - 1)
      : (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    jumpToTurn(matches[next]!.turnKey);
  }, [matches, matchIndex, jumpToTurn]);

  useEffect(() => { setMatchIndex(-1); }, [query]);

  // Read through a ref so the handlers below stay stable while a reply
  // streams (`turns` is a new array every frame); otherwise the document
  // keydown listener would be torn down and re-added per token.
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  /** Move focus n turns from whichever turn currently holds it. */
  const stepTurn = useCallback((delta: number) => {
    const list = turnsRef.current;
    if (list.length === 0) return;
    const active = scroller.current?.ownerDocument?.activeElement;
    const currentKey = active instanceof HTMLElement ? active.getAttribute('data-turn-key') : null;
    const index = currentKey ? list.findIndex((t) => t.key === currentKey) : -1;
    const next = index < 0
      ? (delta > 0 ? 0 : list.length - 1)
      : Math.max(0, Math.min(list.length - 1, index + delta));
    jumpToTurn(list[next]!.key);
  }, [jumpToTurn]);

  useEffect(() => onTranscriptStep((delta) => {
    if (turnsRef.current.length === 0) return false;
    stepTurn(delta);
    return true;
  }), [stepTurn]);

  // ⌘F focuses the in-chat search; Alt+↑/↓ steps turns from anywhere EXCEPT a
  // text field, where the OS already owns those chords for word/paragraph
  // movement and the composer must keep them.
  useEffect(() => {
    if (turns.length === 0) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      // The shell's key handler routes these through the command bus (and
      // back here via onTranscriptStep / onTranscriptFind); an event it
      // already took must not step twice.
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
        || target?.isContentEditable === true;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        if (turns.length < NAV_MIN_TURNS) return;
        event.preventDefault();
        setFocusToken((n) => n + 1);
        return;
      }
      if (event.altKey && !event.metaKey && !event.ctrlKey && !typing) {
        if (event.key === 'ArrowDown') { event.preventDefault(); stepTurn(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); stepTurn(-1); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [turns.length, stepTurn]);

  /** Plain ↑/↓ once a turn container itself has focus. */
  function onListKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    const target = event.target as HTMLElement | null;
    if (!target?.hasAttribute('data-turn-key')) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); stepTurn(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); stepTurn(-1); }
    else if (event.key === 'Home') { event.preventDefault(); jumpToTurn(turns[0]!.key); }
    else if (event.key === 'End') { event.preventDefault(); jumpToTurn(turns[turns.length - 1]!.key); }
  }

  // ---- live turn -----------------------------------------------------------
  // The live STATUS line moved above the composer in 3.10 (Workspace
  // LiveRow); what stays here is the reasoning streaming into the turn.
  const running = transcript.live;
  const liveThinking = running && reasoning !== 'hidden' && live?.thinking && live.thinking.turnId === live.turnId ? live.thinking : null;
  const lastTurn = turns.length > 0 ? turns[turns.length - 1]! : null;

  // Auto-follow new content only while pinned to the bottom. "New content"
  // includes the live parts: streamed reasoning and a notice appearing.
  const lastItem = transcript.items[transcript.items.length - 1];
  const version = `${transcript.items.length}:${lastItem?.kind === 'assistant' ? lastItem.text.length : 0}:${liveThinking?.text.length ?? -1}:${running ? 1 : 0}`;
  useLayoutEffect(() => {
    if (version === lastVersion.current) return;
    lastVersion.current = version;
    if (following) scrollToBottom();
    else setUnseen(true);
  }, [version, following, scrollToBottom]);

  useEffect(() => {
    if (loaded) scrollToBottom();
  }, [loaded, scrollToBottom]);

  if (!loaded && !loadError) {
    return (
      <div className={styles.transcript} aria-busy="true">
        <div className={styles.skeleton}>
          <div className={styles.skeletonUser}><SkeletonLine width="42%" /></div>
          <SkeletonLine width="88%" /><SkeletonLine width="72%" /><SkeletonLine width="80%" />
          <div className={styles.skeletonUser}><SkeletonLine width="30%" /></div>
          <SkeletonLine width="64%" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.transcript}>
        <div role="alert" className={styles.loadError}>
          <p><span className={styles.noteLead}>Couldn’t load this chat.</span> {loadError}</p>
          {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
        </div>
      </div>
    );
  }

  const activeMatchKey = matchIndex >= 0 ? matches[matchIndex]?.turnKey ?? null : null;

  return (
    <PathRootsContext.Provider value={projectRoots ?? inheritedRoots}>
    <div className={styles.transcriptWrap}>
      {turns.length >= NAV_MIN_TURNS ? (
        <TranscriptNav turns={turns} query={query} onQuery={setQuery} matches={matches} matchIndex={matchIndex}
          onStepMatch={stepMatch} errorCount={errorAnchors.length} onJumpError={jumpToFirstError}
          onJumpTurn={jumpToTurn} focusToken={focusToken} />
      ) : null}
      {/* The log is NOT a live region (3.10): streamed tokens announced one by
          one made a screen reader unusable mid-turn. TurnAnnouncer says only
          when a turn starts, finishes, fails or is stopped. */}
      <TurnAnnouncer running={running} lastStatus={lastTurn?.status ?? null} lastKey={lastTurn?.key ?? null} />
      <div className={styles.scrollArea}>
      <div ref={scroller} className={styles.transcript} onScroll={onScroll} role="log" aria-live="off"
        aria-label="Conversation" data-has-rail={turns.length >= NAV_MIN_TURNS || undefined}>
        {handoffFrom ? (
          <p className={styles.continued} data-kind="handoff-from">
            <span className={styles.continuedLabel}>Continued from</span>{' '}
            {onOpenSession ? (
              <button type="button" className={styles.continuedLink} onClick={() => onOpenSession(handoffFrom.sessionId)}
                title="Open the chat this one continues">
                {handoffFrom.title || 'Untitled chat'}
              </button>
            ) : <span className={styles.continuedTitle}>{handoffFrom.title || 'Untitled chat'}</span>}
          </p>
        ) : null}
        {transcript.items.length === 0 && !running ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{handoffFrom ? 'Review the handoff, then send it.' : 'Say something to begin.'}</p>
            <p className={styles.emptyBody}>{emptyHint ?? (handoffFrom
              ? 'The note in the message box was drafted from the previous chat\'s log. Edit it freely — nothing is sent until you press Send.'
              : 'The agent can read and edit this project. Ask for a change, a review, or an explanation.')}</p>
          </div>
        ) : null}
        <ol className={styles.list} onKeyDown={onListKeyDown}>
          {perSegment.map((segment, s) => segment.turns.map((turn, t) => (
            <TurnView key={turn.key} turn={turn} index={turnOffsets[s]! + t} facts={segment.facts} explained={segment.explained}
              engine={engine} match={matchKeys.has(turn.key) ? (turn.key === activeMatchKey ? 'active' : 'true') : undefined}
              reasoning={reasoning} onJumpTool={jumpToTool} onJumpAnchor={jumpToAnchor} registerNode={registerTurn} />
          )))}
          {/* The reasoning streaming right now — it becomes an ordinary
              thinking item the moment its persisted block lands. */}
          {liveThinking ? (
            <li className={styles.item} data-kind="thinking-live">
              <ThinkingBlock key={`live-${liveThinking.startedAt}`} text={liveThinking.text} streaming startedAt={liveThinking.startedAt}
                estimatedTokens={liveThinking.estimatedTokens} defaultOpen />
            </li>
          ) : null}
        </ol>
      </div>
      {turns.length >= NAV_MIN_TURNS ? (
        <ChapterRail model={chapters} onJumpTurn={jumpToTurn} />
      ) : null}
      </div>
      {!following ? (
        <button type="button" className={`${styles.jump} ${unseen ? styles.jumpUnseen : ''}`}
          onClick={() => { setFollowing(true); setUnseen(false); scrollToBottom('smooth'); }}>
          <ArrowDownIcon size={12} /> Jump to latest
        </button>
      ) : null}
    </div>
    </PathRootsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

interface TurnViewProps {
  turn: TurnBlock;
  index: number;
  facts: Map<string, ToolFacts>;
  explained: ReadonlySet<string>;
  engine?: VerseEngine;
  match: 'active' | 'true' | undefined;
  reasoning: ReasoningDisplay;
  onJumpTool: (toolUseId: string) => void;
  onJumpAnchor: (id: string) => boolean;
  registerNode: (key: string, node: HTMLElement | null) => void;
}

/**
 * Memoized on its props, all of which are stable for a finished turn: the
 * TurnBlock comes from a cached segment model, the callbacks are stable, and
 * `match` only changes for turns a search touches. So a streamed token
 * re-renders exactly one TurnView.
 */
const TurnView = memo(function TurnView({ turn, index, facts, explained, engine, match, reasoning, onJumpTool, onJumpAnchor, registerNode }: TurnViewProps) {
  const running = turn.status === 'running';
  // How long a settled turn took (turn-model: from its turn-done; unknown →
  // null, never 0). The turn's footer, not a line of its own between turns.
  const tookMs = running ? null : turn.durationMs;
  const errorJump = turn.errorCount > 0 && turn.firstErrorAnchor ? turn.firstErrorAnchor : null;
  return (
    <li
      id={turnAnchorId(turn.key)}
      ref={(node) => registerNode(turn.key, node)}
      // A settled turn no longer changes: let the browser skip its layout
      // and paint while it is off screen (Transcript.module.css .turnSettled).
      className={`${styles.turn} ${running ? '' : styles.turnSettled}`}
      data-turn-key={turn.key}
      data-status={turn.status}
      data-match={match}
      tabIndex={-1}
      aria-label={`Turn ${index + 1}`}
    >
      <ol className={styles.turnItems}>
        {turn.items.map((item) => renderItem(item, facts, explained, reasoning, engine))}
      </ol>
      {turn.files.length > 0 ? <FileActivity files={turn.files} onJump={onJumpTool} /> : null}
      {tookMs !== null || errorJump ? (
        <footer className={styles.turnFoot} data-kind="turn-meta">
          {tookMs !== null ? (
            <span><span className="visually-hidden">Turn took </span><span>{formatDuration(tookMs)}</span></span>
          ) : null}
          {errorJump ? (
            <button type="button" className={styles.turnErrorJump} onClick={() => onJumpAnchor(errorJump)}>
              {turn.errorCount} failure{turn.errorCount === 1 ? '' : 's'} in this turn — jump to the first
            </button>
          ) : null}
        </footer>
      ) : null}
    </li>
  );
});

/**
 * A tool card re-renders only when what it shows changed. `result` is a
 * fresh object on every rebuild of the live turn, so identity is not enough;
 * `input` and `facts` are stable (the event's own object, the facts cache).
 */
const MemoToolUseCard = memo(ToolUseCard, (a: ToolUseCardProps, b: ToolUseCardProps) =>
  a.name === b.name && a.input === b.input && a.toolUseId === b.toolUseId && a.durationMs === b.durationMs &&
  a.facts === b.facts && a.result?.output === b.result?.output && a.result?.isError === b.result?.isError &&
  (a.result === null) === (b.result === null));

function renderItem(item: TranscriptRenderItem, facts: Map<string, ToolFacts>, explained: ReadonlySet<string>, reasoning: ReasoningDisplay, engine?: VerseEngine) {
  switch (item.kind) {
    case 'user':
      return (
        <li key={item.key} className={`${styles.item} ${styles.user}`} data-kind="user">
          <div className={styles.userText}>{item.text}</div>
        </li>
      );
    case 'assistant':
      return (
        <li key={item.key} className={`${styles.item} ${styles.assistant}`} data-kind="assistant" data-streaming={item.streaming || undefined}>
          <MessageMarkdown text={item.text} streaming={item.streaming} />
        </li>
      );
    case 'thinking':
      if (reasoning === 'hidden') return null;
      return (
        <li key={item.key} className={styles.item} data-kind="thinking">
          <ThinkingBlock text={item.text} redacted={item.redacted} durationMs={item.durationMs}
            estimatedTokens={item.estimatedTokens} kind={item.thinkingKind}
            // 3.10: a settled block folds (it streamed in its three-line
            // window while it ran) unless Settings ▸ Chat says Expanded.
            defaultOpen={reasoning === 'expanded'} stateKey={`thinking:${item.key}`} />
        </li>
      );
    case 'tool':
      return (
        <li key={item.key} className={styles.item} data-kind="tool">
          <MemoToolUseCard name={item.name} input={item.input} result={item.result} toolUseId={item.toolUseId}
            durationMs={item.durationMs} facts={facts.get(item.toolUseId)} startedAt={item.at} />
        </li>
      );
    case 'toolGroup':
      return (
        <li key={item.key} className={styles.item} data-kind="tool-group">
          <ActivityGroup item={item} facts={facts} reasoning={reasoning} />
        </li>
      );
    case 'error': {
      const hint = errorCodeHint(item.code);
      return (
        <li key={item.key} className={styles.item} data-kind="error" data-code={item.code ?? undefined}>
          <div id={noteAnchorId(item.key)} role="alert" className={`${styles.note} ${styles.noteError}`}>
            {/* The state in words — unless the CLI's own message already opens with it. */}
            {/^error\b/i.test(item.message) ? null : <><span className={styles.noteLead}>Error</span>{' '}</>}{item.message}
            {hint ? <span className={styles.noteHint}>{hint}</span> : null}
          </div>
        </li>
      );
    }
    case 'compaction':
      // A divider, not a message: the conversation continues on both sides of
      // it, but the agent sees everything above it only as a summary.
      return (
        <li key={item.key} className={`${styles.item} ${styles.compaction}`} data-kind="compaction">
          <span className={styles.compactionRule} aria-hidden="true" />
          <span className={styles.compactionText}>
            <span className={styles.compactionTitle}>{describeCompaction(item, engine)}</span>
            <span className={styles.compactionNote}>Earlier turns now reach the agent only as a summary; the full transcript stays here.</span>
          </span>
          <span className={styles.compactionRule} aria-hidden="true" />
        </li>
      );
    case 'truncated':
      return (
        <li key={item.key} className={`${styles.item} ${styles.compaction}`} data-kind="history-truncated">
          <span className={styles.compactionRule} aria-hidden="true" />
          <span className={styles.compactionText}>
            <span className={styles.compactionTitle}>Older history trimmed</span>
            <span className={styles.compactionNote}>This chat’s log reached its size cap, so its oldest turns were dropped here. The agent’s own conversation is unaffected.</span>
          </span>
          <span className={styles.compactionRule} aria-hidden="true" />
        </li>
      );
    case 'recovered':
      return (
        <li key={item.key} className={styles.item} data-kind="recovered">
          <div className={`${styles.note} ${styles.noteRecovered}`} role="status">
            <span className={styles.noteLead}>{item.how === 'handoff' ? 'Recovered from the handoff note' : 'Recovered in a new session'}</span>
            {' — '}{item.message}
          </div>
        </li>
      );
    case 'cancelled':
      return (
        <li key={item.key} className={styles.item} data-kind="cancelled">
          <div className={styles.note}>Stopped.</div>
        </li>
      );
    case 'turn-done':
      // A clean (or already-explained) end is not a line of its own, and how
      // long ANY turn took is its footer (TurnView), never this item.
      if (item.ok || explained.has(item.key)) return null;
      return (
        <li key={item.key} className={styles.item} data-kind="turn-done">
          <div id={noteAnchorId(item.key)} className={`${styles.note} ${styles.noteError}`}>
            <span className={styles.noteLead}>Failed</span> Turn ended without a result.
          </div>
        </li>
      );
    default:
      return null;
  }
}

function sameMembers(a: ToolGroupItem, b: ToolGroupItem, fa: Map<string, ToolFacts>, fb: Map<string, ToolFacts>): boolean {
  if (a === b) return fa === fb || a.items.every((m) => m.kind !== 'tool' || fa.get(m.toolUseId) === fb.get(m.toolUseId));
  if (a.key !== b.key || a.items.length !== b.items.length || a.errorCount !== b.errorCount || a.pending !== b.pending ||
    a.spanMs !== b.spanMs || a.summary !== b.summary) return false;
  for (let i = 0; i < a.items.length; i += 1) {
    const x = a.items[i]!;
    const y = b.items[i]!;
    if (x.key !== y.key || x.kind !== y.kind) return false;
    if (x.kind === 'tool' && y.kind === 'tool') {
      if (x.result?.output !== y.result?.output || x.result?.isError !== y.result?.isError || x.durationMs !== y.durationMs) return false;
      if (fa.get(x.toolUseId) !== fb.get(y.toolUseId)) return false;
    } else if (x.kind === 'thinking' && y.kind === 'thinking') {
      if (x.text !== y.text || x.durationMs !== y.durationMs || x.estimatedTokens !== y.estimatedTokens) return false;
    }
  }
  return true;
}

/**
 * One member of a folded run: a tool card, or the reasoning that explained
 * the next call (hidden when Settings ▸ Chat says so).
 */
function renderMember(member: ToolGroupMember, facts: Map<string, ToolFacts>, reasoning: ReasoningDisplay) {
  if (member.kind === 'tool') {
    return (
      <MemoToolUseCard name={member.name} input={member.input} result={member.result}
        toolUseId={member.toolUseId} durationMs={member.durationMs} facts={facts.get(member.toolUseId)} startedAt={member.at} />
    );
  }
  if (reasoning === 'hidden') return null;
  return (
    <ThinkingBlock text={member.text} redacted={member.redacted} durationMs={member.durationMs}
      estimatedTokens={member.estimatedTokens} kind={member.thinkingKind} defaultOpen={reasoning === 'expanded'}
      stateKey={`thinking:${member.key}`} />
  );
}

/**
 * The folded run (3.10: chat/ActivityGroup — "Ran 12 commands · read 8 files ·
 * edited 3 files · 1 failed"). Re-rendered only when a member's visible facts
 * changed: the live turn rebuilds its item objects on every token, and
 * `sameMembers` compares what the row shows rather than object identity.
 */
const ActivityGroup = memo(function ActivityGroup({ item, facts, reasoning }: { item: ToolGroupItem; facts: Map<string, ToolFacts>; reasoning: ReasoningDisplay }) {
  const render = useCallback((member: ToolGroupMember) => renderMember(member, facts, reasoning), [facts, reasoning]);
  return <ActivityGroupView item={item} facts={facts} renderMember={render} />;
}, (a, b) => a.reasoning === b.reasoning && sameMembers(a.item, b.item, a.facts, b.facts));
