/**
 * routes/verse/git/ActionMenu.tsx — the branch bar's split button: one
 * primary action beside a ▾ menu of the rest (unit C5; SPEC-310C §2).
 *
 * WAI-ARIA menu-button pattern, keyboard first:
 *   ▾ / Enter / Space / ↓ open the menu on the first enabled item, ↑ on the
 *   last; ↑ ↓ Home End move; Enter or Space runs; Escape closes and returns
 *   focus to ▾; Tab closes and lets focus move on; a click outside closes.
 *
 * A disabled item stays in the menu with its reason as visible text under
 * the label (never colour alone, never only a tooltip) and is skipped by the
 * arrow keys — so the operator can always see why Push is not offered.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { IconChevronDown } from '../../../components/primitives/icons.js';
import styles from './BranchBar.module.css';

export interface ActionMenuItem<Id extends string> {
  id: Id;
  label: string;
  disabledReason: string | null;
}

export interface ActionMenuProps<Id extends string> {
  /** The primary button; null renders the menu button alone. */
  primary: { label: string; disclosure: string; onClick: () => void; busy?: boolean; tone?: 'primary' | 'subtle' } | null;
  items: ReadonlyArray<ActionMenuItem<Id>>;
  onSelect: (id: Id) => void;
  /** Names the menu button for screen readers ("More git actions for ashlr-hub"). */
  menuLabel: string;
  disabled?: boolean;
  children?: ReactNode;
}

export function ActionMenu<Id extends string>({ primary, items, onSelect, menuLabel, disabled = false }: ActionMenuProps<Id>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const menuId = useId();
  const disclosureId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const enabled = items.map((it, i) => (it.disabledReason === null ? i : -1)).filter((i) => i >= 0);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (refocus) buttonRef.current?.focus();
  }, []);

  const openAt = (which: 'first' | 'last') => {
    setOpen(true);
    setActive(enabled.length === 0 ? -1 : which === 'first' ? enabled[0]! : enabled[enabled.length - 1]!);
  };

  useEffect(() => {
    if (!open) return;
    if (active >= 0) itemRefs.current[active]?.focus();
    else menuRef.current?.focus();
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

  const move = (delta: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    const next = at === -1 ? (delta === 1 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
    setActive(enabled[next]!);
  };

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
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        if (enabled.length) setActive(enabled[0]!);
        break;
      case 'End':
        e.preventDefault();
        if (enabled.length) setActive(enabled[enabled.length - 1]!);
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

  const run = (item: ActionMenuItem<Id>) => {
    if (item.disabledReason !== null) return;
    close(true);
    onSelect(item.id);
  };

  return (
    <div className={styles.split} data-open={open ? 'true' : 'false'}>
      {primary ? (
        <button
          type="button"
          className={styles.primary}
          data-tone={primary.tone ?? 'primary'}
          onClick={primary.onClick}
          disabled={disabled || primary.busy}
          aria-busy={primary.busy || undefined}
          aria-describedby={disclosureId}
          title={primary.disclosure}
        >
          {primary.busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
          {primary.label}
        </button>
      ) : null}
      <span id={disclosureId} className={styles.visuallyHidden}>{primary?.disclosure ?? ''}</span>
      <button
        ref={buttonRef}
        type="button"
        className={styles.menuButton}
        data-alone={primary ? 'false' : 'true'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={menuLabel}
        disabled={disabled}
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={onButtonKey}
      >
        <IconChevronDown width={14} height={14} aria-hidden="true" />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-label={menuLabel} className={styles.menu} tabIndex={-1} onKeyDown={onMenuKey}>
          {items.map((item, i) => (
            <button
              key={item.id}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              tabIndex={i === active ? 0 : -1}
              aria-disabled={item.disabledReason !== null || undefined}
              onClick={() => run(item)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  run(item);
                }
              }}
            >
              <span className={styles.menuLabel}>{item.label}</span>
              {item.disabledReason ? <span className={styles.menuReason}>{item.disabledReason}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
