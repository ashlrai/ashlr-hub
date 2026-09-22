/**
 * routes/verse/Transcript.tsx — the conversation, in one 720px measure.
 *
 * No bubbles (DESIGN §5): the user turn is indented behind a 2px left rule
 * in secondary text, the assistant turn is plain primary text at full
 * measure. Role is weight and rule, never a coloured box.
 *
 * Runs of tool calls fold (verse-store groupTranscriptItems) into one
 * `6 tools · Read ×4, Edit ×2 · 12s` row, so an agentic turn reads as a
 * summary line between two pieces of prose instead of a wall of cards.
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
 * Follows the newest message unless the operator scrolled up, in which case
 * a "Jump to latest" control appears.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { FileActivity } from './chat/FileActivity.js';
import { TranscriptNav } from './chat/TranscriptNav.js';
import { toolAnchorId, type ToolFacts } from './chat/tool-semantics.js';
import { buildTurns, createTurnCache, noteAnchorId, searchTurns, turnAnchorId } from './chat/turn-model.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { ToolUseCard } from './ToolUseCard.js';
import { ArrowDownIcon } from './verse-icons.js';
import { formatDuration } from './verse-model.js';
import { groupTranscriptItems, type ToolGroupItem, type ToolGroupMember, type Transcript as TranscriptModel, type TranscriptRenderItem } from './verse-store.js';
import styles from './Transcript.module.css';

export interface TranscriptProps {
  transcript: TranscriptModel;
  loaded: boolean;
  loadError: string | null;
  onRetry?: () => void;
  emptyHint?: string;
}

const FOLLOW_THRESHOLD_PX = 48;
/** Below this the session is short enough to scroll; chrome would be noise. */
const NAV_MIN_TURNS = 3;
/** How long a jumped-to element keeps its locator tint. */
const FLASH_MS = 1400;

export function Transcript({ transcript, loaded, loadError, onRetry, emptyHint }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const turnNodes = useRef(new Map<string, HTMLElement>());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(-1);
  const [focusToken, setFocusToken] = useState(0);
  const lastCount = useRef(0);

  // `transcript.items` is a fresh array on every streamed token, so both memos
  // below miss on every frame. The cache is what keeps that from meaning "and
  // therefore re-derive every tool call in the session, LCS diffs included".
  // It is keyed by `toolUseId`, which outlives the rebuilt item objects.
  const turnCache = useRef(createTurnCache());
  const rendered = useMemo(() => groupTranscriptItems(transcript.items), [transcript.items]);
  const model = useMemo(() => buildTurns(rendered, turnCache.current), [rendered]);
  const matches = useMemo(
    () => searchTurns(model.turns, query, turnCache.current),
    [model.turns, query],
  );
  const matchKeys = useMemo(() => new Set(matches.map((m) => m.turnKey)), [matches]);

  // A `turn-done ok:false` that follows the same turn's `cancelled`/`error`
  // note is already explained; a second red "ended without a result" line
  // would make every Stop look like a failure.
  const explained = useMemo(() => {
    const out = new Set<string>();
    let last: { turnId: string | null; kind: string } | null = null;
    for (const item of transcript.items) {
      if (item.kind === 'turn-done' && !item.ok && last && last.turnId === item.turnId && (last.kind === 'cancelled' || last.kind === 'error')) {
        out.add(item.key);
      }
      last = { turnId: item.turnId, kind: item.kind };
    }
    return out;
  }, [transcript.items]);

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

  /** Open the disclosure chain around a tool call before revealing it. */
  const jumpToAnchor = useCallback((id: string) => {
    const node = scroller.current?.ownerDocument?.getElementById(id) ?? null;
    if (!node) return;
    for (let el: Element | null = node; el; el = el.parentElement) {
      if (el instanceof HTMLDetailsElement) el.open = true;
      if (el === scroller.current) break;
    }
    reveal(node);
  }, [reveal]);

  const jumpToTool = useCallback((toolUseId: string) => jumpToAnchor(toolAnchorId(toolUseId)), [jumpToAnchor]);

  const jumpToFirstError = useCallback(() => {
    const anchor = model.errorAnchors[0];
    if (anchor) jumpToAnchor(anchor);
  }, [model.errorAnchors, jumpToAnchor]);

  const stepMatch = useCallback((delta: number) => {
    if (matches.length === 0) return;
    const next = matchIndex < 0
      ? (delta > 0 ? 0 : matches.length - 1)
      : (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    jumpToTurn(matches[next]!.turnKey);
  }, [matches, matchIndex, jumpToTurn]);

  useEffect(() => { setMatchIndex(-1); }, [query]);

  /** Move focus n turns from whichever turn currently holds it. */
  const stepTurn = useCallback((delta: number) => {
    const turns = model.turns;
    if (turns.length === 0) return;
    const active = scroller.current?.ownerDocument?.activeElement;
    const currentKey = active instanceof HTMLElement ? active.getAttribute('data-turn-key') : null;
    const index = currentKey ? turns.findIndex((t) => t.key === currentKey) : -1;
    const next = index < 0
      ? (delta > 0 ? 0 : turns.length - 1)
      : Math.max(0, Math.min(turns.length - 1, index + delta));
    jumpToTurn(turns[next]!.key);
  }, [model.turns, jumpToTurn]);

  // ⌘F focuses the in-chat search; Alt+↑/↓ steps turns from anywhere EXCEPT a
  // text field, where the OS already owns those chords for word/paragraph
  // movement and the composer must keep them.
  useEffect(() => {
    if (model.turns.length === 0) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
        || target?.isContentEditable === true;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        if (model.turns.length < NAV_MIN_TURNS) return;
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
  }, [model.turns.length, stepTurn]);

  /** Plain ↑/↓ once a turn container itself has focus. */
  function onListKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    const target = event.target as HTMLElement | null;
    if (!target?.hasAttribute('data-turn-key')) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); stepTurn(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); stepTurn(-1); }
    else if (event.key === 'Home') { event.preventDefault(); jumpToTurn(model.turns[0]!.key); }
    else if (event.key === 'End') { event.preventDefault(); jumpToTurn(model.turns[model.turns.length - 1]!.key); }
  }

  // Auto-follow new content only while pinned to the bottom.
  useLayoutEffect(() => {
    const count = transcript.items.length;
    const lastItem = transcript.items[count - 1];
    const grew = count !== lastCount.current || lastItem?.kind === 'assistant' && lastItem.streaming;
    lastCount.current = count;
    if (!grew) return;
    if (following) scrollToBottom();
    else setUnseen(true);
  }, [transcript, following, scrollToBottom]);

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
          <p>{loadError}</p>
          {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
        </div>
      </div>
    );
  }

  const activeMatchKey = matchIndex >= 0 ? matches[matchIndex]?.turnKey ?? null : null;

  return (
    <div className={styles.transcriptWrap}>
      {model.turns.length >= NAV_MIN_TURNS ? (
        <TranscriptNav turns={model.turns} query={query} onQuery={setQuery} matches={matches} matchIndex={matchIndex}
          onStepMatch={stepMatch} errorCount={model.errorAnchors.length} onJumpError={jumpToFirstError}
          onJumpTurn={jumpToTurn} focusToken={focusToken} />
      ) : null}
      <div ref={scroller} className={styles.transcript} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions text">
        {transcript.items.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Say something to begin.</p>
            <p className={styles.emptyBody}>{emptyHint ?? 'The agent can read and edit this project. Ask for a change, a review, or an explanation.'}</p>
          </div>
        ) : null}
        <ol className={styles.list} onKeyDown={onListKeyDown}>
          {model.turns.map((turn, index) => (
            <li
              key={turn.key}
              id={turnAnchorId(turn.key)}
              ref={(node) => {
                if (node) turnNodes.current.set(turn.key, node);
                else turnNodes.current.delete(turn.key);
              }}
              className={styles.turn}
              data-turn-key={turn.key}
              data-status={turn.status}
              data-match={matchKeys.has(turn.key) ? (turn.key === activeMatchKey ? 'active' : 'true') : undefined}
              tabIndex={-1}
              aria-label={`Turn ${index + 1} of ${model.turns.length}`}
            >
              <ol className={styles.turnItems}>
                {turn.items.map((item) => renderItem(item, model.facts, explained))}
              </ol>
              {turn.files.length > 0 ? <FileActivity files={turn.files} onJump={jumpToTool} /> : null}
              {turn.errorCount > 0 && turn.firstErrorAnchor ? (
                <button type="button" className={styles.turnErrorJump}
                  onClick={() => jumpToAnchor(turn.firstErrorAnchor!)}>
                  {turn.errorCount} failure{turn.errorCount === 1 ? '' : 's'} in this turn — jump to the first
                </button>
              ) : null}
            </li>
          ))}
          {/* Waiting for the first token: the caret alone. No skeletons mid-stream (DESIGN §5). */}
          {transcript.live && !transcript.items.some((i) => i.kind === 'assistant' && i.streaming) ? (
            <li className={`${styles.item} ${styles.assistant}`} data-kind="pending" aria-label="Waiting for the agent">
              <span className={styles.caret} aria-hidden="true" />
            </li>
          ) : null}
        </ol>
      </div>
      {!following ? (
        <button type="button" className={`${styles.jump} ${unseen ? styles.jumpUnseen : ''}`}
          onClick={() => { setFollowing(true); setUnseen(false); scrollToBottom('smooth'); }}>
          <ArrowDownIcon size={12} /> Jump to latest
        </button>
      ) : null}
    </div>
  );
}

function renderItem(item: TranscriptRenderItem, facts: Map<string, ToolFacts>, explained: Set<string>) {
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
      return (
        <li key={item.key} className={styles.item} data-kind="thinking">
          <ThinkingBlock item={item} />
        </li>
      );
    case 'tool':
      return (
        <li key={item.key} className={styles.item} data-kind="tool">
          <ToolUseCard name={item.name} input={item.input} result={item.result} toolUseId={item.toolUseId}
            durationMs={item.durationMs} facts={facts.get(item.toolUseId)} />
        </li>
      );
    case 'toolGroup':
      return (
        <li key={item.key} className={styles.item} data-kind="tool-group">
          <ToolGroup item={item} facts={facts} />
        </li>
      );
    case 'error':
      return (
        <li key={item.key} className={styles.item} data-kind="error">
          <div id={noteAnchorId(item.key)} role="alert" className={`${styles.note} ${styles.noteError}`}>{item.message}</div>
        </li>
      );
    case 'cancelled':
      return (
        <li key={item.key} className={styles.item} data-kind="cancelled">
          <div className={styles.note}>Stopped.</div>
        </li>
      );
    case 'turn-done':
      if (item.ok || explained.has(item.key)) {
        return item.durationMs > 0 ? (
          <li key={item.key} className={`${styles.item} ${styles.meta}`} data-kind="turn-done">
            <span className={styles.metaText}>{formatDuration(item.durationMs)}</span>
          </li>
        ) : null;
      }
      return (
        <li key={item.key} className={styles.item} data-kind="turn-done">
          <div id={noteAnchorId(item.key)} className={`${styles.note} ${styles.noteError}`}>Turn ended without a result (<span className={styles.noteDuration}>{formatDuration(item.durationMs)}</span>).</div>
        </li>
      );
    default:
      return null;
  }
}

function ThinkingBlock({ item }: { item: Extract<ToolGroupMember, { kind: 'thinking' }> }) {
  return (
    <details className={styles.thinking} data-state-key={`thinking:${item.key}`}>
      <summary className={styles.thinkingSummary}>Thinking</summary>
      <div className={styles.thinkingBody}>{item.text}</div>
    </details>
  );
}

/**
 * The folded run: `6 tools · Read ×4, Edit ×2 · 12s`. Failures tint the left
 * rule and say so in words — never the colour on its own (DESIGN §6).
 */
function ToolGroup({ item, facts }: { item: ToolGroupItem; facts: Map<string, ToolFacts> }) {
  const state = item.pending
    ? 'running'
    : item.errorCount > 0
      ? `${item.errorCount} failed`
      : item.spanMs !== null && item.spanMs > 0
        ? formatDuration(item.spanMs)
        : 'done';
  const label = `${item.toolCount} tool${item.toolCount === 1 ? '' : 's'}`;
  return (
    <details className={`${styles.toolRun} ${item.errorCount > 0 ? styles.toolFailed : ''}`} data-state-key={`toolgroup:${item.key}`}>
      <summary className={styles.toolLine} aria-label={`${label}: ${item.summary} (${state})`}>
        <span className={styles.toolGlyph} aria-hidden="true" />
        <span className={styles.toolName}>{label}</span>
        {item.summary ? <span className={styles.toolArg} title={item.summary}>{item.summary}</span> : null}
        <span className={styles.toolState}>{state}</span>
      </summary>
      <div className={styles.toolRunBody}>
        <ol className={styles.toolRunList}>
          {item.items.map((member) => (
            <li key={member.key} data-member={member.kind}>
              {member.kind === 'tool'
                ? <ToolUseCard name={member.name} input={member.input} result={member.result}
                    toolUseId={member.toolUseId} durationMs={member.durationMs} facts={facts.get(member.toolUseId)} />
                : <ThinkingBlock item={member} />}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
