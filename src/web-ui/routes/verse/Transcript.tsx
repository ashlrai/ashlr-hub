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
 * Follows the newest message unless the operator scrolled up, in which case
 * a "Jump to latest" control appears.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { ToolUseCard } from './ToolUseCard.js';
import { ArrowDownIcon } from './verse-icons.js';
import { formatDuration } from './verse-model.js';
import { groupTranscriptItems, type ToolGroupItem, type ToolGroupMember, type Transcript as TranscriptModel } from './verse-store.js';
import styles from './Transcript.module.css';

export interface TranscriptProps {
  transcript: TranscriptModel;
  loaded: boolean;
  loadError: string | null;
  onRetry?: () => void;
  emptyHint?: string;
}

const FOLLOW_THRESHOLD_PX = 48;

export function Transcript({ transcript, loaded, loadError, onRetry, emptyHint }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const lastCount = useRef(0);
  const rendered = useMemo(() => groupTranscriptItems(transcript.items), [transcript.items]);

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

  return (
    <div className={styles.transcriptWrap}>
      <div ref={scroller} className={styles.transcript} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions text">
        {transcript.items.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Say something to begin.</p>
            <p className={styles.emptyBody}>{emptyHint ?? 'The agent can read and edit this project. Ask for a change, a review, or an explanation.'}</p>
          </div>
        ) : null}
        <ol className={styles.list}>
          {rendered.map((item) => {
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
                    <ToolUseCard name={item.name} input={item.input} result={item.result} toolUseId={item.toolUseId} durationMs={item.durationMs} />
                  </li>
                );
              case 'toolGroup':
                return (
                  <li key={item.key} className={styles.item} data-kind="tool-group">
                    <ToolGroup item={item} />
                  </li>
                );
              case 'error':
                return (
                  <li key={item.key} className={styles.item} data-kind="error">
                    <div role="alert" className={`${styles.note} ${styles.noteError}`}>{item.message}</div>
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
                    <div className={`${styles.note} ${styles.noteError}`}>Turn ended without a result (<span className={styles.noteDuration}>{formatDuration(item.durationMs)}</span>).</div>
                  </li>
                );
              default:
                return null;
            }
          })}
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
function ToolGroup({ item }: { item: ToolGroupItem }) {
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
                ? <ToolUseCard name={member.name} input={member.input} result={member.result} toolUseId={member.toolUseId} durationMs={member.durationMs} />
                : <ThinkingBlock item={member} />}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
