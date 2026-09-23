/**
 * routes/verse/ChatResizer.tsx — the drag handle between the chat
 * transcript and a side panel.
 *
 * A 1px hairline that behaves like a 9px target: the hairline is the design
 * (DESIGN-V2 has no chrome), the grab area is the ergonomics. Three things
 * about it are not obvious and are all deliberate:
 *
 * 1. IT IS A CONTROL, NOT A DECORATION. `role="separator"` with a tabindex is
 *    the ARIA window-splitter pattern: arrow keys move it, Home/End take it
 *    to its limits, and a double-click restores the default. A pointer-only
 *    resizer simply does not exist for a keyboard operator.
 *
 * 2. IT MUST NOT EAT THE macOS DRAG STRIP. The grab area overhangs ±4px into
 *    the panels either side, and the top 48px of those panels is the window's
 *    own drag region (Sidebar `.headDragStrip`, Workspace `.header`
 *    data-app-region="drag"). It is painted after them, so without the
 *    `--app-titlebar-height` inset in the stylesheet it would steal 4px of
 *    the strip AND turn the macOS double-click-to-zoom into a width reset.
 *    See desktop/README.md "Desktop shell contract".
 *
 * 3. THE DRAG IS RELEASED FROM `window`, NOT FROM THE ELEMENT. Pointer
 *    capture is requested, but it is not relied on: a capture that fails, a
 *    pointer that leaves the window, a button released over another app and
 *    a mid-drag unmount all have to end the drag, because a stuck drag state
 *    (everything selects, the cursor sticks) is the most visible bug this
 *    control can have.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import {
  CHAT_PANEL_RANGES,
  CHAT_PANEL_STEP,
  CHAT_PANEL_STEP_COARSE,
  getChatPanelSizing,
  nudgeChatPanelWidth,
  resetChatPanelWidth,
  setChatPanelWidth,
  subscribeChatPanels,
  type ChatPanelSide,
  type ChatPanelSizing,
} from './chat-panel-sizing.js';

/** The React glue over chat-panel-sizing.ts (same split as useVerseUi.ts). */
export function useChatPanelSizing(): ChatPanelSizing {
  return useSyncExternalStore(subscribeChatPanels, getChatPanelSizing, getChatPanelSizing);
}

/**
 * Marks the body for the duration of a drag so the stylesheet can suppress
 * selection app-wide. An attribute rather than an inline style: it survives
 * React re-renders, it is one line of CSS, and a test can see it.
 */
const BODY_FLAG = 'verseResizing';

function markBody(on: boolean): void {
  try {
    if (on) document.body.dataset[BODY_FLAG] = 'true';
    else delete document.body.dataset[BODY_FLAG];
  } catch {
    /* a detached document in a test teardown is not worth throwing over */
  }
}

export interface ChatResizerProps {
  side: ChatPanelSide;
  /** The control's accessible name — what it resizes, in the operator's words. */
  label: string;
  className?: string;
}

interface DragState {
  pointerId: number;
  originX: number;
  startWidth: number;
}

export function ChatResizer({ side, label, className }: ChatResizerProps) {
  const sizing = useChatPanelSizing();
  const range = CHAT_PANEL_RANGES[side];
  const width = sizing.effective[side];
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  /** The one way a drag ends. Idempotent, so every path can call it. */
  const endDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    markBody(false);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    // Primary button only: a right-click here belongs to the context menu,
    // and a middle-click must not start a drag nobody asked for.
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, originX: event.clientX, startWidth: width };
    setDragging(true);
    markBody(true);
    // Best-effort: it keeps the cursor and the events on the handle while the
    // pointer wanders. The window listeners below are the actual contract.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* unsupported, or the pointer is already gone — the window listeners cover it */
    }
  }, [width]);

  // Move/end listeners live on the window for the whole drag, so a pointer
  // that leaves the viewport or a button released over another window still
  // lands here. Unmounting mid-drag runs the cleanup and clears the body flag.
  useEffect(() => {
    if (!dragging) return undefined;

    const onMove = (event: globalThis.PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      const delta = event.clientX - state.originX;
      // The sidebar grows to the right, the resources panel to the left.
      setChatPanelWidth(side, side === 'sidebar' ? state.startWidth + delta : state.startWidth - delta);
    };
    const onEnd = (event: globalThis.PointerEvent) => {
      const state = drag.current;
      if (state && event.pointerId !== state.pointerId) return;
      endDrag();
    };
    /** Escape puts the width back where the drag started. */
    const onKey = (event: globalThis.KeyboardEvent) => {
      const state = drag.current;
      if (!state || event.key !== 'Escape') return;
      setChatPanelWidth(side, state.startWidth);
      endDrag();
    };
    // The window losing focus (⌘-tab mid-drag, an OS dialog) never delivers a
    // pointerup, so treat it as one rather than staying stuck.
    const onBlur = () => endDrag();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      markBody(false);
    };
  }, [dragging, side, endDrag]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? CHAT_PANEL_STEP_COARSE : CHAT_PANEL_STEP;
    // Left/Right are screen directions, so which one GROWS depends on which
    // edge of the transcript this handle is.
    const toward = side === 'sidebar' ? 1 : -1;
    switch (event.key) {
      case 'ArrowRight':
        nudgeChatPanelWidth(side, step * toward);
        break;
      case 'ArrowLeft':
        nudgeChatPanelWidth(side, -step * toward);
        break;
      case 'Home':
        setChatPanelWidth(side, range.min);
        break;
      case 'End':
        setChatPanelWidth(side, range.max);
        break;
      case 'Enter':
        resetChatPanelWidth(side);
        break;
      default:
        return;
    }
    event.preventDefault();
  }, [side, range.min, range.max]);

  return (
    <div
      className={className}
      data-verse-resizer={side}
      data-dragging={dragging ? 'true' : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      // The thing people reach for after over-dragging. In the desktop app a
      // double-click on a DRAG region zooms the window instead — which is why
      // the stylesheet keeps this handle's grab area out of the title bar.
      onDoubleClick={() => resetChatPanelWidth(side)}
    />
  );
}
