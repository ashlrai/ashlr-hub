/**
 * routes/verse/changes/ReReviewMenu.tsx — "Re-review with…": the Changes
 * pane's menu of OTHER seats that can review a turn's diff (3.15).
 *
 * WAI-ARIA menu button, as git/ActionMenu.tsx: Enter / Space / ↓ open on the
 * first seat, ↑ on the last; ↑ ↓ Home End move; Enter or Space picks;
 * Escape closes and returns focus to the button; Tab or a click outside
 * closes. A seat whose health is not `ready` stays pickable (the server's
 * readiness gate is the authority) and says so under its name.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { IconChevronDown } from '../../../components/primitives/icons.js';
import type { FlowTarget } from '../multimodel/multimodel-flows.js';
import styles from './ChangesPanel.module.css';

export interface ReReviewMenuProps {
  seats: ReadonlyArray<FlowTarget & { ready: boolean }>;
  onPick: (seat: FlowTarget) => void;
  disabled?: boolean;
  busy?: boolean;
  /** Why the menu is off (shown as the button's title). */
  disabledReason?: string;
}

export function ReReviewMenu({ seats, onPick, disabled = false, busy = false, disabledReason }: ReReviewMenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  const openAt = (which: 'first' | 'last') => {
    if (seats.length === 0) return;
    setActive(which === 'first' ? 0 : seats.length - 1);
    setOpen(true);
  };

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openAt('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAt('last');
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = seats.length;
    if (n === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => (a + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => (a - 1 + n) % n);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(n - 1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  };

  const pick = (seat: FlowTarget) => {
    close(true);
    onPick(seat);
  };

  const off = disabled || seats.length === 0;
  return (
    <div className={styles.menuWrap}>
      <Button
        ref={buttonRef}
        size="sm"
        variant="ghost"
        trailingIcon={<IconChevronDown width={14} height={14} aria-hidden="true" />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={off}
        busy={busy}
        title={off ? (disabledReason ?? (seats.length === 0 ? 'No other seat is available to review' : undefined)) : 'Ask another seat to review these changes (read-only, in a new chat)'}
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={onButtonKey}
      >
        Re-review with…
      </Button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-label="Re-review with" className={styles.menu} tabIndex={-1} onKeyDown={onMenuKey}>
          {seats.map((seat, i) => (
            <button
              key={seat.seatId}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              tabIndex={i === active ? 0 : -1}
              onClick={() => pick(seat)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  pick(seat);
                }
              }}
            >
              <span className={styles.menuLabel}>{seat.label}</span>
              {seat.ready ? null : <span className={styles.menuNote}>Not reported ready — it may decline</span>}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
