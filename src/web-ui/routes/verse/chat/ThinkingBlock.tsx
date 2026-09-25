/**
 * routes/verse/chat/ThinkingBlock.tsx — one block of model reasoning (V3.10).
 *
 * Before 3.10 reasoning arrived only when a block closed, behind a static
 * "Thinking" disclosure, usually two collapses deep inside a tool group — and
 * for Claude Opus it was almost always EMPTY (the CLI omitted the text), so
 * nothing showed at all. Now the adapters stream vendor summaries
 * (`thinking-delta`), and this block:
 *
 *   - streams them while the model thinks, open, with a live
 *     "Thinking · 12s · ~1.8k tok" line;
 *   - settles to a collapsed "Thought 12s · ~1.8k tok" once the block ends,
 *     the operator's own open/closed choice winning over the default;
 *   - says honestly when the provider withheld the text (a redacted,
 *     signature-only block): the duration is real, the words are not shown,
 *     and there is nothing to expand.
 *
 * 3.10 (SPEC-310C §2, unit C2): while it streams, the body is a THREE-LINE
 * window that follows the tail — enough to see what the model is working
 * on, not so much that a long think shoves the answer off screen. Clicking
 * the label (or the window) shows the whole stream. Once the block ends it
 * folds to "Thought 12s · ~1.8k tok ▸" — or stays open when Settings ▸ Chat
 * says Expanded (chat/reasoning-pref.ts; Hidden is handled by the
 * transcript, which then renders no reasoning at all).
 *
 * Honesty rule: an unknown duration or token count is omitted, never shown
 * as 0. A token count the CLI did not report is estimated from the text
 * (~4 characters per token) and always carries the "~".
 *
 * 3.10.1: the row opens with the same ▸ every foldable transcript row uses
 * (tool cards, activity groups), at the same x; the breathing dot appears
 * only while the block streams — a settled block has no stray bullet.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react';
import type { VerseThinkingKind } from '../../../../core/verse/types.js';
import styles from './ThinkingBlock.module.css';

export interface ThinkingBlockProps {
  text: string;
  /** Still streaming: the label counts up and the body follows new text. */
  streaming?: boolean;
  /** Client clock (ms) the block started — the live label's origin while streaming. */
  startedAt?: number | null;
  /** The provider sent the block without its text. */
  redacted?: boolean;
  durationMs?: number | null;
  /** The CLI's own estimate; null → estimated from the text when there is any. */
  estimatedTokens?: number | null;
  kind?: VerseThinkingKind | null;
  /** Initial open state; the operator's toggle wins afterwards. */
  defaultOpen?: boolean;
  /** Survives scroll restore (useScrollRestore) like every other disclosure. */
  stateKey?: string;
}

/** "~1.8k tok" — one decimal under 10k, so the figure moves visibly while it streams. */
export function formatThinkingTokens(n: number): string {
  const rounded = Math.max(0, Math.round(n));
  if (rounded < 1000) return `~${rounded} tok`;
  if (rounded < 10_000) return `~${(rounded / 1000).toFixed(1).replace(/\.0$/, '')}k tok`;
  if (rounded < 1_000_000) return `~${Math.round(rounded / 1000)}k tok`;
  return `~${(rounded / 1_000_000).toFixed(1).replace(/\.0$/, '')}M tok`;
}

/** "12s" / "1m 5s" / "<1s". */
export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Characters per token for the fallback estimate (the common English ratio). */
const CHARS_PER_TOKEN = 4;

export function thinkingTokenFigure(text: string, estimatedTokens: number | null | undefined): number | null {
  if (typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) && estimatedTokens > 0) return estimatedTokens;
  const chars = text.trim().length;
  return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : null;
}

/** The one-line label — exported so the transcript search and tests agree with the UI. */
export function thinkingLabel(opts: {
  streaming: boolean;
  elapsedMs: number | null;
  tokens: number | null;
}): string {
  const parts = [opts.streaming ? 'Thinking' : 'Thought'];
  const duration = opts.elapsedMs === null ? '' : formatThinkingDuration(opts.elapsedMs);
  if (opts.streaming) {
    if (duration) parts.push(duration);
  } else if (duration) {
    parts[0] = `Thought ${duration}`;
  }
  if (opts.tokens !== null) parts.push(formatThinkingTokens(opts.tokens));
  return parts.join(' · ');
}

/** Re-render once a second while `active` — the label's clock, not a network poll. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** How close to the bottom the body must be for new text to keep it pinned there. */
const FOLLOW_PX = 24;

export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming = false,
  startedAt = null,
  redacted = false,
  durationMs = null,
  estimatedTokens = null,
  kind = null,
  defaultOpen = false,
  stateKey,
}: ThinkingBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  /** The operator opened or closed it by hand; from then on their choice wins over `defaultOpen`. */
  const chosen = useRef(false);
  /** The operator asked for the whole stream instead of the three-line window. */
  const [full, setFull] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const now = useSecondTick(streaming && startedAt !== null);

  const elapsed = streaming
    ? (startedAt !== null ? Math.max(0, now - startedAt) : null)
    : durationMs;
  const tokens = thinkingTokenFigure(text, estimatedTokens);
  const label = thinkingLabel({ streaming, elapsedMs: elapsed, tokens });
  const hasText = text.trim().length > 0;

  // Follow the stream inside the body unless the operator scrolled up in it.
  const windowed = streaming && open && !full;
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    // Fade the top line only when something is actually cut off above it.
    if (windowed && node.scrollHeight > node.clientHeight + 1) node.setAttribute('data-clipped', '');
    else node.removeAttribute('data-clipped');
    if (!streaming || (!following.current && !windowed)) return;
    node.scrollTop = node.scrollHeight;
  }, [text, streaming, open, windowed]);

  function onScroll() {
    const node = body.current;
    if (!node) return;
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_PX;
  }

  // Open while its turn runs, folded once it finishes — unless the operator
  // already decided for this block.
  useEffect(() => {
    if (!chosen.current) setOpen(defaultOpen);
  }, [defaultOpen]);

  // While windowed, the first click on the label means "show me all of it",
  // not "hide it": folding the one thing the operator is trying to read
  // would be the opposite of the gesture.
  function onSummaryClick(event: MouseEvent<HTMLElement>) {
    if (!windowed) return;
    event.preventDefault();
    chosen.current = true;
    setFull(true);
  }

  function onToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const next = event.currentTarget.open;
    // A toggle event also follows OUR prop change; only a mismatch is a click.
    if (next !== open) chosen.current = true;
    setOpen(next);
  }

  if (!hasText) {
    // Nothing to expand: a redacted block, or the CLI's token count before
    // any summary text arrived. One quiet line that still says it happened.
    return (
      <div className={styles.thinking} data-streaming={streaming || undefined} data-redacted={redacted || undefined}
        data-thinking-kind={kind ?? undefined}>
        <span className={styles.line}>
          {streaming ? <span className={styles.glyph} aria-hidden="true" /> : null}
          <span className={styles.label}>{label}</span>
          {redacted ? (
            <span className={styles.hidden} title="The provider returned this reasoning without its text; only how long it took is known.">
              reasoning hidden by the provider
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <details className={styles.thinking} open={open} onToggle={onToggle} data-state-key={stateKey}
      data-streaming={streaming || undefined} data-thinking-kind={kind ?? undefined}>
      <summary className={styles.summary} onClick={onSummaryClick} aria-label={windowed ? `${label} — show all` : undefined}>
        <span className={styles.chevron} aria-hidden="true" />
        {streaming ? <span className={styles.glyph} aria-hidden="true" /> : null}
        <span className={styles.label}>{label}</span>
        {kind === 'summary' ? <span className={styles.kind} title="A summary the provider wrote of the model's reasoning, not its raw chain of thought.">summary</span> : null}
      </summary>
      <div ref={body} className={styles.body} onScroll={onScroll} data-window={windowed || undefined}
        onClick={windowed ? () => { chosen.current = true; setFull(true); } : undefined}>{text}</div>
    </details>
  );
});
