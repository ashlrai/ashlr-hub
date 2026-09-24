/**
 * routes/verse/chat/ChapterRail.tsx — the transcript's minimap down its
 * right edge (SPEC-310C §2, unit C2). Model: chapter-model.ts.
 *
 *   ─  a turn            ━ red: it failed     ━ amber: running
 *   ◆  context compacted ↺ recovered          ⤷ continued from another chat
 *
 * Hover (or keyboard focus) shows the ask; click jumps to it.
 *
 * ONE tab stop, not one per turn: a 60-turn chat must not put 60 stops
 * between the transcript and the composer. The rail is a toolbar-style
 * group with a roving tabindex — ↑/↓ (and Home/End) move between ticks,
 * Enter or Space jumps. Every tick has a full accessible name ("Turn 4 of
 * 12, failed: …"), so the colour is never the only signal (DESIGN §6).
 */
import { memo, useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { describeTick, type ChapterMarkerKind, type ChapterModel } from './chapter-model.js';
import styles from './ChapterRail.module.css';

export interface ChapterRailProps {
  /**
   * From chapter-model `buildChapters`. The transcript rebuilds it only when
   * `chaptersSignature` moves, so a streamed token never re-renders the rail.
   */
  model: ChapterModel;
  onJumpTurn: (turnKey: string) => void;
}

const MARKER_GLYPH: Readonly<Record<ChapterMarkerKind, string>> = {
  compaction: '◆',
  recovered: '↺',
  handoff: '⤷',
};

export const ChapterRail = memo(function ChapterRail({ model, onJumpTurn }: ChapterRailProps) {
  const [active, setActive] = useState(-1);
  const [peek, setPeek] = useState<number | null>(null);
  const tickRefs = useRef(new Map<number, HTMLButtonElement>());
  const cardId = useId();
  const total = model.ticks.length;
  // The roving stop: the operator's last tick, else the newest turn.
  const stop = active >= 0 && active < total ? active : total - 1;

  const focusTick = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(total - 1, index));
    setActive(clamped);
    setPeek(clamped);
    tickRefs.current.get(clamped)?.focus();
  }, [total]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = stop;
    let next: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = current + 1;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = total - 1;
    if (next === null) return;
    event.preventDefault();
    focusTick(next);
  }

  if (total === 0) return null;
  const peeked = peek !== null ? model.ticks[peek] ?? null : null;

  return (
    <div className={styles.rail} role="toolbar" aria-orientation="vertical" aria-label="Chapters"
      onKeyDown={onKeyDown} onMouseLeave={() => setPeek(null)}>
      {model.handoff ? (
        <span className={styles.handoff} role="img" aria-label="Continued from another chat" title="Continued from another chat">
          {MARKER_GLYPH.handoff}
        </span>
      ) : null}
      <div className={styles.track}>
        {model.ticks.map((tick) => {
          const name = describeTick(tick, total);
          const markers = [...new Set(tick.markers)];
          return (
            <button
              key={tick.turnKey}
              ref={(node) => { if (node) tickRefs.current.set(tick.index, node); else tickRefs.current.delete(tick.index); }}
              type="button"
              className={styles.tick}
              data-status={tick.status}
              style={{ top: `${tick.position * 100}%` }}
              tabIndex={tick.index === stop ? 0 : -1}
              aria-label={name}
              aria-describedby={peek === tick.index ? cardId : undefined}
              onMouseEnter={() => setPeek(tick.index)}
              onFocus={() => { setActive(tick.index); setPeek(tick.index); }}
              onBlur={() => setPeek((p) => (p === tick.index ? null : p))}
              onClick={() => { setActive(tick.index); onJumpTurn(tick.turnKey); }}
            >
              <span className={styles.bar} aria-hidden="true" />
              {markers.length > 0 ? (
                <span className={styles.markers} aria-hidden="true">
                  {markers.map((m) => <span key={m} className={styles.marker} data-marker={m}>{MARKER_GLYPH[m]}</span>)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {peeked ? (
        <div id={cardId} className={styles.card} role="tooltip" style={{ top: `${peeked.position * 100}%` }}>
          <span className={styles.cardMeta}>Turn {peeked.index + 1} of {total}{peeked.status === 'error' ? ' · failed' : peeked.status === 'running' ? ' · running' : ''}</span>
          <span className={styles.cardTitle}>{peeked.title}</span>
        </div>
      ) : null}
    </div>
  );
});
