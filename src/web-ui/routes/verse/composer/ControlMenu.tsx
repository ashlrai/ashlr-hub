/**
 * routes/verse/composer/ControlMenu.tsx — one picker in the composer footer
 * (Permission ▾, Model ▾, Effort ▾; unit C3).
 *
 * An ARIA menu button whose items are `menuitemradio`s:
 *   - ↑/↓ move (wrapping), Home/End jump, a letter jumps to the next item
 *     starting with it, Enter/Space choose, Esc closes and returns focus to
 *     the button, Tab closes and lets focus move on;
 *   - an UNAVAILABLE option is shown, focusable and announced, but cannot be
 *     chosen — its reason sits under its label (never a hover-only tooltip),
 *     because "why can't I pick Max?" is exactly the question the menu must
 *     answer;
 *   - a DANGER option (bypass) is painted red and says so in words.
 *
 * `openRequest` lets the owner open it from a shortcut (⌘⇧M/⌘⇧I/⌘⇧E) or a
 * slash command: every new value opens the menu with focus on the checked item.
 *
 * `variant="list"` renders the same items as a plain radio list, for the 375px
 * sheet where a popover over a popover would be unusable.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { VerseControlOption } from '../../../../core/verse/workbench-types.js';
import styles from './composer.module.css';

export interface ControlMenuProps<T extends string> {
  /** Accessible name of the picker ("Permission mode"). */
  label: string;
  /** What the button shows for the current value. */
  valueLabel: string;
  options: readonly VerseControlOption<T>[];
  /** The checked option; null = none (e.g. effort at the CLI default). */
  value: T | null;
  onChange: (id: T) => void;
  /** An extra first item that resets to the default (effort "Default"). */
  defaultOption?: { label: string; description?: string; onSelect: () => void } | null;
  disabled?: boolean;
  /** Why the whole picker is disabled — shown as its title. */
  disabledReason?: string | null;
  /** Shortcut hint shown in the menu header ("⇧⌘M"). */
  shortcut?: string;
  /** Bumped to open the menu programmatically. */
  openRequest?: number;
  /** A leading glyph for the button. */
  icon?: ReactNode;
  /** Paint the button as dangerous (bypass is on). */
  danger?: boolean;
  /** One sentence under the header: when a change applies. */
  note?: string | null;
  variant?: 'menu' | 'list';
  /** Collapse the button to its icon (the compact footer). */
  iconOnly?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ControlMenu<T extends string>({
  label, valueLabel, options, value, onChange, defaultOption = null, disabled = false, disabledReason = null,
  shortcut, openRequest, icon, danger = false, note = null, variant = 'menu', iconOnly = false, onOpenChange,
}: ControlMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const seenRequest = useRef(openRequest);

  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  const close = useCallback((refocus: boolean) => {
    setOpenState(false);
    if (refocus) button.current?.focus();
  }, [setOpenState]);

  // Programmatic open (shortcut / slash command).
  useEffect(() => {
    if (openRequest === undefined || openRequest === seenRequest.current) return;
    seenRequest.current = openRequest;
    if (!disabled && variant === 'menu') setOpenState(true);
  }, [openRequest, disabled, variant, setOpenState]);

  // Focus the checked item (else the first) when the menu opens.
  useEffect(() => {
    if (!open) return;
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const checked = items.find((item) => item.getAttribute('aria-checked') === 'true');
    (checked ?? items[0])?.focus();
  }, [open]);

  // Outside click closes without stealing focus back.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  function choose(option: VerseControlOption<T>) {
    if (!option.available) return;
    if (variant === 'menu') close(true);
    onChange(option.id);
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusAt(index + 1); return;
      case 'ArrowUp': event.preventDefault(); focusAt(index - 1); return;
      case 'Home': event.preventDefault(); focusAt(0); return;
      case 'End': event.preventDefault(); focusAt(items.length - 1); return;
      case 'Escape':
        if (variant === 'menu') {
          event.preventDefault();
          // Handled here: the composer's own Escape (stop the turn) must not also fire.
          event.stopPropagation();
          close(true);
        }
        return;
      case 'Tab':
        if (variant === 'menu') close(false);
        return;
      default:
        if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const letter = event.key.toLowerCase();
          for (let step = 1; step <= items.length; step++) {
            const candidate = items[(index + step) % items.length]!;
            if ((candidate.dataset['label'] ?? '').toLowerCase().startsWith(letter)) {
              event.preventDefault();
              candidate.focus();
              return;
            }
          }
        }
    }
  }

  // In the sheet's plain lists, ONE item per list is in the tab order (the
  // checked one, else the first) and the arrows move within it — a roving
  // tabindex, so Tab walks list → list instead of through every option.
  const checkedId: string | null = value === null ? (defaultOption ? '__default' : null) : value;
  const tabStop = variant === 'list' ? (checkedId ?? (defaultOption ? '__default' : options[0]?.id ?? null)) : null;
  const items = (
    <>
      {defaultOption ? (
        <MenuItem label={defaultOption.label} description={defaultOption.description ?? null} checked={value === null}
          available danger={false} tabbable={tabStop === '__default'}
          onSelect={() => { if (variant === 'menu') close(true); defaultOption.onSelect(); }} />
      ) : null}
      {options.map((option) => (
        <MenuItem key={option.id} label={option.label} description={option.available ? (option.danger ? 'Skips every permission check — confirmed for this chat only' : null) : (option.reason ?? 'Unavailable on this seat')}
          checked={value === option.id} available={option.available} danger={option.danger === true}
          tabbable={tabStop === option.id}
          onSelect={() => choose(option)} />
      ))}
    </>
  );

  if (variant === 'list') {
    return (
      <div ref={wrap} className={styles.controlList} role="menu" aria-label={label} onKeyDown={onMenuKey}>
        {/* No per-list note: the sheet says once, above all three, when changes apply. */}
        <p className={styles.menuHeading}>{label}</p>
        {items}
      </div>
    );
  }

  return (
    <div ref={wrap} className={styles.controlWrap}>
      <button ref={button} type="button" className={`${styles.control} ${danger ? styles.controlDanger : ''} ${iconOnly ? styles.controlIconOnly : ''}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={`${label}: ${valueLabel}`} disabled={disabled}
        title={disabled && disabledReason ? disabledReason : undefined}
        onClick={() => setOpenState(!open)}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !open) {
            event.preventDefault();
            setOpenState(true);
          }
        }}>
        {icon ? <span className={styles.controlIcon} aria-hidden="true">{icon}</span> : null}
        {iconOnly ? null : <span className={styles.controlText}>{valueLabel}</span>}
        <span className={styles.caret} aria-hidden="true" />
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label={label} className={styles.menu} onKeyDown={onMenuKey}>
          <p className={styles.menuHeading}>
            <span>{label}</span>
            {shortcut ? <kbd className={styles.menuKbd}>{shortcut}</kbd> : null}
          </p>
          {note ? <p className={styles.menuNote}>{note}</p> : null}
          {items}
        </div>
      ) : null}
    </div>
  );
}

interface MenuItemProps {
  /** In the tab order (the list variant's roving tab stop). */
  tabbable?: boolean;
  label: string;
  description: string | null;
  checked: boolean;
  available: boolean;
  danger: boolean;
  onSelect: () => void;
}

function MenuItem({ tabbable = false, label, description, checked, available, danger, onSelect }: MenuItemProps) {
  const descId = useId();
  return (
    <div role="menuitemradio" tabIndex={tabbable ? 0 : -1} aria-checked={checked} aria-disabled={available ? undefined : true}
      aria-describedby={description ? descId : undefined} data-label={label}
      className={`${styles.menuItem} ${danger ? styles.menuItemDanger : ''}`}
      onClick={() => { if (available) onSelect(); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          if (available) onSelect();
        }
      }}>
      <span className={styles.menuCheck} aria-hidden="true">{checked ? '✓' : ''}</span>
      <span className={styles.menuText}>
        <span className={styles.menuLabel}>{label}</span>
        {description ? <span id={descId} className={styles.menuDesc}>{description}</span> : null}
      </span>
    </div>
  );
}
