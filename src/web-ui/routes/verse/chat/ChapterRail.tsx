/**
 * routes/verse/chat/ChapterRail.tsx — the transcript's minimap down its
 * right edge (SPEC-310C §2, unit C2). Model: chapter-model.ts.
 *
 *   ─  a turn            ━ red: it failed     ━ amber: running
 *   ◆  context compacted ↺ recovered          ⤷ continued from another chat
 *   (the three markers are inline SVG — see MARKER_PATH)
 *
 * Hover (or keyboard focus) shows the ask; click jumps to it.
 *
 * ONE tab stop, not one per turn: a 60-turn chat must not put 60 stops
 * between the transcript and the composer. The rail is a toolbar-style
 * group with a roving tabindex — ↑/↓ (and Home/End) move between ticks,
 * Enter or Space jumps. Every tick has a full accessible name ("Turn 4 of
 * 12, failed: …"), so the colour is never the only signal (DESIGN §6).
 */
import { memo, useCallback, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
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

/**
 * The markers are drawn, not typed. WHY (review 3.10 c18, SPEC-310A §1 fonts
 * ≤ 150 KB): as text, ◆ ⤷ are in neither UI font and ↺ is only in the 230 KB
 * full Plex face, so a chat with one compaction or recovery made the browser
 * fetch that face on first paint just to draw a 6px mark. A 1em SVG in
 * currentColor keeps the size and the per-kind colour the CSS already sets.
 */
const MARKER_PATH: Readonly<Record<ChapterMarkerKind, ReactElement>> = {
  // ◆ a filled diamond: the context was compacted here.
  compaction: <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" fill="currentColor" />,
  // ↺ an open circle with its arrowhead: recovered.
  recovered: <path d="M4.2 5.2A5 5 0 1 1 3 8.5M4.2 1.8v3.4h3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  // ⤷ down, then right: continued from another chat.
  handoff: <path d="M4 2.5V9a2 2 0 0 0 2 2h7M10.5 8.5 13 11l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
};

function MarkerIcon({ kind }: { kind: ChapterMarkerKind }) {
  return <svg className={styles.markerIcon} viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">{MARKER_PATH[kind]}</svg>;
}

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
          <MarkerIcon kind="handoff" />
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
                  {markers.map((m) => <span key={m} className={styles.marker} data-marker={m}><MarkerIcon kind={m} /></span>)}
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
