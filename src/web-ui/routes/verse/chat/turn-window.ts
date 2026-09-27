/**
 * routes/verse/chat/turn-window.ts — transcript windowing: a long chat
 * renders only the turns near the viewport (V3.15).
 *
 * 3.10 made a streamed token re-render one turn (memoized TurnViews, segment
 * caching) and let the browser skip laying out off-screen turns
 * (`content-visibility: auto`). What neither removes is the DOM itself: a
 * 300-turn chat still mounts every card, diff and citation list, which is the
 * mount time and memory a long session pays. So past WINDOW_MIN_TURNS a turn
 * far from the viewport is a placeholder `<li>` holding its measured height
 * (and its anchor id, so the outline, rail and search still land on it):
 *
 *   - the last WINDOW_TAIL turns and the running turn always render in full;
 *   - an IntersectionObserver on the scroller (WINDOW_MARGIN_PX ahead in
 *     both directions) renders a turn in full as it approaches and returns
 *     it to a placeholder — at the height it last had — once it is far away;
 *   - a jump INTO a placeholder (a tool call, an error note, the outline)
 *     pins the turn in full first (`pin` + `anchorTurnKey`), then scrolls;
 *     the pin lasts until the operator has seen the turn and scrolled away.
 *
 * Without IntersectionObserver (jsdom, very old engines) nothing is windowed:
 * the transcript is exactly what it was before this existed.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ToolGroupItem } from '../verse-transcript.js';
import { toolAnchorId } from './tool-semantics.js';
import { noteAnchorId, turnAnchorId, type TurnBlock } from './turn-model.js';

/** Below this many turns everything renders — windowing a short chat buys nothing. */
export const WINDOW_MIN_TURNS = 40;
/** The newest turns are always in full: that is where the operator reads and the stream lands. */
export const WINDOW_TAIL = 10;
/** How far ahead of the viewport (px, both directions) a turn is rendered in full. */
export const WINDOW_MARGIN_PX = 1600;
/** A never-measured placeholder's height — the same guess `.turnSettled` gives `contain-intrinsic-size`. */
export const PLACEHOLDER_ESTIMATE_PX = 320;

/** The turn that renders the DOM anchor `anchorId` (turn, tool call or note), or null. */
export function anchorTurnKey(turns: readonly TurnBlock[], anchorId: string): string | null {
  for (const turn of turns) {
    if (turnAnchorId(turn.key) === anchorId) return turn.key;
    for (const item of turn.items) {
      const members = item.kind === 'toolGroup' ? (item as ToolGroupItem).items : [item];
      for (const m of members) {
        if (m.kind === 'tool' && toolAnchorId(m.toolUseId) === anchorId) return turn.key;
        if ((m.kind === 'error' || m.kind === 'turn-done') && noteAnchorId(m.key) === anchorId) return turn.key;
      }
    }
  }
  return null;
}

export interface TurnWindow {
  enabled: boolean;
  /** Whether a turn renders in full. */
  isFull(key: string, index: number, running: boolean): boolean;
  /** The height a placeholder holds for this turn. */
  heightOf(key: string): number;
  /** Render a windowed-out turn in full (a jump into it). True when this changed anything. */
  pin(key: string): boolean;
  /** Ref hook for every turn `<li>` (full or placeholder). Stable. */
  observe(key: string, node: HTMLElement | null): void;
}

export function useTurnWindow(scroller: RefObject<HTMLElement | null>, turnCount: number): TurnWindow {
  const enabled = turnCount >= WINDOW_MIN_TURNS && typeof IntersectionObserver === 'function';
  const [, setVersion] = useState(0);
  const near = useRef(new Set<string>());
  const pinned = useRef(new Set<string>());
  /** Pinned turns the operator has actually had in view — only those unpin when they leave. */
  const seen = useRef(new Set<string>());
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLElement>());
  const io = useRef<IntersectionObserver | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled || !scroller.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = entry.target.getAttribute('data-turn-key');
        if (!key) continue;
        const height = entry.boundingClientRect.height;
        if (!entry.target.hasAttribute('data-turn-placeholder') && height > 0) heights.current.set(key, Math.round(height));
        if (entry.isIntersecting) {
          if (!near.current.has(key)) { near.current.add(key); changed = true; }
          if (pinned.current.has(key)) seen.current.add(key);
        } else {
          if (near.current.delete(key)) changed = true;
          if (pinned.current.has(key) && seen.current.has(key)) {
            pinned.current.delete(key);
            seen.current.delete(key);
            changed = true;
          }
        }
      }
      if (changed) setVersion((v) => v + 1);
    }, { root: scroller.current, rootMargin: `${WINDOW_MARGIN_PX}px 0px` });
    io.current = observer;
    for (const node of nodes.current.values()) observer.observe(node);
    return () => {
      observer.disconnect();
      io.current = null;
    };
  }, [enabled, scroller]);

  const observe = useCallback((key: string, node: HTMLElement | null) => {
    const previous = nodes.current.get(key);
    if (previous && previous !== node) io.current?.unobserve(previous);
    if (node) {
      nodes.current.set(key, node);
      io.current?.observe(node);
    } else {
      nodes.current.delete(key);
    }
  }, []);

  const pin = useCallback((key: string) => {
    if (!enabledRef.current || near.current.has(key) || pinned.current.has(key)) return false;
    pinned.current.add(key);
    setVersion((v) => v + 1);
    return true;
  }, []);

  return {
    enabled,
    isFull: (key, index, running) => !enabled || running || index >= turnCount - WINDOW_TAIL
      || near.current.has(key) || pinned.current.has(key),
    heightOf: (key) => heights.current.get(key) ?? PLACEHOLDER_ESTIMATE_PX,
    pin,
    observe,
  };
}
