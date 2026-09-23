/**
 * components/primitives/Tooltip.tsx — the label for an icon-only control and
 * the numbers behind a 2px meter line.
 *
 * Rules it enforces so a tooltip never becomes the only way to read the UI:
 *   - it shows on HOVER *and* on keyboard FOCUS (a mouse-only tooltip is
 *     invisible to keyboard operators);
 *   - Escape dismisses it while the trigger keeps focus (WCAG 1.4.13);
 *   - the trigger is wired with aria-describedby, so the content is
 *     announced rather than merely drawn;
 *   - it carries description, never the accessible NAME — icon buttons still
 *     need their own aria-label.
 *
 * WHY IT RENDERS THROUGH A PORTAL. This used to be an absolutely-positioned
 * span inside a `position: relative` wrapper, which is correct right up until
 * the trigger lives inside something that clips — and the first real consumer,
 * the Verse rail, is exactly that: a 56px flex column inside a grid shell with
 * its own stacking context. A bubble anchored there is cut off at the rail's
 * edge, which is the failure the native `title=` tooltip already had. Rendering
 * into `document.body` at `position: fixed`, positioned from the trigger's
 * bounding rect, means NO ancestor can clip it: not `overflow: hidden`, not a
 * `transform`, not a lower `z-index` on a sibling pane.
 *
 * The Popover API (`popover="manual"` + the top layer) would do the same job
 * without the portal, but it is not yet safe to depend on across the WebKit
 * version bundled with the Tauri shell, and it still needs manual positioning
 * without `anchor-name`. The portal is the boring, verifiable option.
 *
 * TWO PROP SPELLINGS, on purpose. `label` + `shortcut` is the shape icon
 * controls want, and is what new call sites should use. `content` predates it
 * and takes arbitrary nodes (the Meter's numbers, for one), so it stays as the
 * other half of a union rather than being renamed out from under its callers.
 * Exactly one of the two is required.
 */
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

/**
 * Hovering across a rail of six icons must not strobe six bubbles, so the
 * POINTER waits. Focus does not: a keyboard operator has already committed to
 * the control, and a delay there just reads as lag.
 */
const OPEN_DELAY_MS = 160;
/** Distance between the trigger's edge and the bubble. */
const GAP = 8;
/** Smallest distance the bubble may sit from the viewport edge. */
const MARGIN = 8;

/** The props Tooltip clones onto its trigger. */
interface TooltipTriggerProps {
  'aria-describedby'?: string;
  /** Read, never set: a disabled trigger fires no pointer events, so the wrapper must take over. */
  disabled?: boolean;
  onMouseEnter?: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: ReactMouseEvent<HTMLElement>) => void;
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
}

interface TooltipCommonProps {
  /** Rendered as a distinct keycap beside the label, e.g. `⌘2`. */
  shortcut?: string;
  placement?: TooltipPlacement;
  /** Skip the tooltip entirely without changing the tree (e.g. the label is already visible). */
  disabled?: boolean;
  className?: string;
  /** The trigger. Tooltip adds no layout box of its own around it. */
  children: ReactElement<TooltipTriggerProps>;
}

export type TooltipProps = TooltipCommonProps &
  (
    | { label: string; content?: undefined }
    | { label?: undefined; content: ReactNode }
  );

interface Position {
  left: number;
  top: number;
  placement: TooltipPlacement;
}

/** Placement order: the caller's choice first, then its opposite, then the rest. */
function candidates(preferred: TooltipPlacement): TooltipPlacement[] {
  const opposite: Record<TooltipPlacement, TooltipPlacement> = {
    top: 'bottom', bottom: 'top', left: 'right', right: 'left',
  };
  const rest = (['top', 'bottom', 'right', 'left'] as const).filter(
    (p) => p !== preferred && p !== opposite[preferred],
  );
  return [preferred, opposite[preferred], ...rest];
}

function place(placement: TooltipPlacement, trigger: DOMRect, w: number, h: number): { left: number; top: number } {
  switch (placement) {
    case 'top': return { left: trigger.left + trigger.width / 2 - w / 2, top: trigger.top - h - GAP };
    case 'bottom': return { left: trigger.left + trigger.width / 2 - w / 2, top: trigger.bottom + GAP };
    case 'left': return { left: trigger.left - w - GAP, top: trigger.top + trigger.height / 2 - h / 2 };
    case 'right': return { left: trigger.right + GAP, top: trigger.top + trigger.height / 2 - h / 2 };
  }
}

/**
 * First placement whose bubble fits the viewport wins; if none fits we keep
 * the preferred one and clamp, which is still readable — a bubble nudged
 * inward beats a bubble half off-screen.
 */
function resolve(trigger: DOMRect, w: number, h: number, preferred: TooltipPlacement): Position {
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  let fallback: Position | null = null;
  for (const placement of candidates(preferred)) {
    const { left, top } = place(placement, trigger, w, h);
    if (!fallback) fallback = { left, top, placement };
    const fits = left >= MARGIN && top >= MARGIN && left + w <= vw - MARGIN && top + h <= vh - MARGIN;
    if (fits) return { left, top, placement };
  }
  const chosen = fallback!;
  return {
    placement: chosen.placement,
    left: Math.max(MARGIN, Math.min(chosen.left, vw - w - MARGIN)),
    top: Math.max(MARGIN, Math.min(chosen.top, vh - h - MARGIN)),
  };
}

export function Tooltip(props: TooltipProps) {
  const { label, content, shortcut, placement = 'top', disabled = false, className, children } = props;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelTimer();
    setOpen(false);
    setPosition(null);
  }, [cancelTimer]);

  // Unmounting mid-delay must not fire setOpen on a dead component.
  useEffect(() => cancelTimer, [cancelTimer]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const rect = trigger.getBoundingClientRect();
    setPosition(resolve(rect, bubble.offsetWidth, bubble.offsetHeight, placement));
  }, [placement]);

  // Measure AFTER the bubble exists but BEFORE paint, so it is never seen at
  // its unpositioned origin first.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  // Escape closes while the trigger keeps focus (WCAG 1.4.13). Held at the
  // document so it works wherever the keystroke lands, and a scroll or resize
  // under an open bubble re-anchors it rather than leaving it stranded.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    // Capture: a scroll inside any ancestor moves the trigger too, and scroll
    // events from those do not bubble to window.
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, close, reposition]);

  const body = label ?? content;
  const empty = body === null || body === undefined || body === '';
  if (disabled || empty) return children;

  function openAfterDelay(element: HTMLElement) {
    triggerRef.current = element;
    cancelTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  }

  function openNow(element: HTMLElement) {
    triggerRef.current = element;
    cancelTimer();
    setOpen(true);
  }

  const triggerDisabled = children.props.disabled === true;
  const describedBy = open ? id : undefined;

  const trigger = cloneElement(children, {
    'aria-describedby': describedBy,
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event);
      openAfterDelay(event.currentTarget);
    },
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event);
      close();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      openNow(event.currentTarget);
    },
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      close();
    },
  });

  return (
    <>
      {/*
        `display: contents` — the wrapper exists in the DOM but generates no
        box, so it cannot disturb the trigger's own flex/grid placement. It is
        here only to carry the describedby relationship at the trigger's parent
        as well as on the trigger itself; the behaviour all lives on the cloned
        child, which is what actually has a hover target.
      */}
      <span
        className={`${styles.wrapper} ${className ?? ''}`}
        aria-describedby={describedBy}
        /*
          A DISABLED trigger emits no pointer events at all, so handlers on the
          cloned child can never fire and its tooltip could never open — which
          is precisely the tooltip that matters, since it is the one explaining
          WHY the control is disabled. When the child is disabled the wrapper
          stops being `display: contents`, takes a box of its own, and carries
          the hover itself. Focus is not mirrored here: a disabled control is
          not focusable, so there is no focus to mirror.
        */
        data-disabled-trigger={triggerDisabled ? 'true' : undefined}
        onMouseOver={triggerDisabled ? (event) => openNow(event.currentTarget) : undefined}
        onMouseOut={triggerDisabled ? close : undefined}
      >
        {trigger}
      </span>
      {open
        ? createPortal(
            <div
              ref={bubbleRef}
              role="tooltip"
              id={id}
              className={styles.bubble}
              data-placement={position?.placement ?? placement}
              style={{
                // Inline, though the stylesheet says it too: `left`/`top`
                // below are VIEWPORT coordinates, and they only mean that
                // under `fixed`. The two travel together or the bubble lands
                // somewhere arbitrary.
                position: 'fixed',
                left: position ? `${position.left}px` : '0px',
                top: position ? `${position.top}px` : '0px',
                // Hidden until measured, but still laid out — the measurement
                // needs a real offsetWidth, and `visibility` gives one where
                // `display: none` would not.
                visibility: position ? 'visible' : 'hidden',
              }}
            >
              <span className={styles.label}>{body}</span>
              {shortcut ? <kbd className={styles.shortcut}>{shortcut}</kbd> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
