/**
 * routes/verse/chat/ActionMenu.tsx — the chat surface's small action menu
 * (unit C2): the header's ⋯ and a sidebar row's hover / right-click menu.
 *
 * The primitives have no menu, and the ones scattered through the console
 * are each hand-rolled for one place; this one is written once for both of
 * C2's uses and follows the WAI-ARIA menu pattern properly:
 *   - `role="menu"` of `menuitem`s, focus moves INTO the menu on open;
 *   - ↑/↓ wrap, Home/End jump, a letter jumps to the next item starting
 *     with it, Enter/Space choose;
 *   - Esc, Tab, a click outside or choosing an item close it and hand focus
 *     back to whatever opened it (the ⋯ button, or the row that was
 *     right-clicked);
 *   - a disabled item stays in the list with its reason as a description, so
 *     the operator learns WHY instead of wondering where it went.
 *
 * Portalled and position:fixed so the sidebar's own overflow cannot clip it,
 * and clamped to the viewport (a right-click near the bottom opens upward).
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './ActionMenu.module.css';

export interface ActionMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** Painted as destructive (Delete). */
  danger?: boolean;
  disabled?: boolean;
  /** Shown under a disabled item. */
  reason?: string | null;
  /** A second line under the label, always shown (a cost, a consequence). */
  description?: string | null;
  /** A leading glyph. */
  icon?: ReactNode;
  /** A separator above this item. */
  separated?: boolean;
}

export interface MenuAnchor {
  /** Viewport coordinates of the menu's preferred top-left. */
  x: number;
  y: number;
}

export interface ActionMenuProps {
  label: string;
  items: readonly ActionMenuItem[];
  anchor: MenuAnchor;
  onClose: (reason: 'select' | 'dismiss') => void;
  /** Focus returns here on close. */
  returnFocus?: HTMLElement | null;
}

const EDGE = 8;

export function ActionMenu({ label, items, anchor, onClose, returnFocus = null }: ActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });
  // Read through refs: the listeners below are installed ONCE per open, and a
  // parent passing an inline onClose must not tear them down (and bounce
  // focus back to the trigger) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);

  // Clamp into the viewport once the menu has a size.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let left = anchor.x;
    let top = anchor.y;
    if (rect.width > 0 && left + rect.width > vw - EDGE) left = Math.max(EDGE, vw - EDGE - rect.width);
    if (rect.height > 0 && top + rect.height > vh - EDGE) top = Math.max(EDGE, anchor.y - rect.height);
    setPosition({ left, top });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const first = enabled[0];
    if (first !== undefined) itemRefs.current[first]?.focus();
    else ref.current?.focus();
    // Focus moves in once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return;
      onCloseRef.current('dismiss');
    };
    const onScroll = (event: Event) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return;
      onCloseRef.current('dismiss');
    };
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    const menu = ref.current;
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
      // Hand focus back only if it is still ours (in the menu, or dropped to
      // <body> by the unmount) — never yank it from a field the chosen action
      // just focused.
      const active = document.activeElement;
      const ours = active === null || active === document.body || (menu !== null && menu.contains(active));
      const back = returnFocusRef.current;
      if (ours && back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  function move(from: number, delta: number) {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(from);
    const next = at < 0 ? (delta > 0 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
    itemRefs.current[enabled[next]!]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = itemRefs.current.findIndex((node) => node === document.activeElement);
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(index, 1); return;
      case 'ArrowUp': event.preventDefault(); move(index, -1); return;
      case 'Home': event.preventDefault(); itemRefs.current[enabled[0] ?? 0]?.focus(); return;
      case 'End': event.preventDefault(); itemRefs.current[enabled[enabled.length - 1] ?? 0]?.focus(); return;
      case 'Escape': event.preventDefault(); event.stopPropagation(); onClose('dismiss'); return;
      case 'Tab': onClose('dismiss'); return;
      default:
        if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const letter = event.key.toLowerCase();
          const order = [...enabled.filter((i) => i > index), ...enabled.filter((i) => i <= index)];
          const hit = order.find((i) => items[i]!.label.toLowerCase().startsWith(letter));
          if (hit !== undefined) {
            event.preventDefault();
            itemRefs.current[hit]?.focus();
          }
        }
    }
  }

  return createPortal(
    <div ref={ref} className={styles.menu} role="menu" aria-label={label} tabIndex={-1}
      style={{ left: position.left, top: position.top }} onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}>
      {items.map((item, i) => (
        <div key={item.id} className={styles.row} data-separated={item.separated || undefined} role="none">
          <button
            ref={(node) => { itemRefs.current[i] = node; }}
            type="button"
            role="menuitem"
            className={styles.item}
            data-danger={item.danger || undefined}
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            onClick={() => {
              if (item.disabled) return;
              onClose('select');
              item.onSelect();
            }}
          >
            {item.icon ? <span className={styles.icon} aria-hidden="true">{item.icon}</span> : null}
            <span className={styles.label}>
              {item.label}
              {item.description ? <span className={styles.reason}>{item.description}</span> : null}
              {item.disabled && item.reason ? <span className={styles.reason}>{item.reason}</span> : null}
            </span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Anchor a menu under (and right-aligned to) a button. */
export function anchorBelow(node: HTMLElement, align: 'start' | 'end' = 'end', menuWidth = 220): MenuAnchor {
  const rect = node.getBoundingClientRect();
  return { x: align === 'end' ? rect.right - menuWidth : rect.left, y: rect.bottom + 4 };
}
