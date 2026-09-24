/**
 * routes/verse/shell/GearTray.tsx — the rail foot's ⚙ menu (unit C1;
 * SPEC-310C §0.1): Settings (⌘,), Apps & Accounts, Usage and Keyboard
 * shortcuts (⌘/), plus the two shell preferences that used to sit on the rail
 * itself (rail labels, theme).
 *
 * A real menu: role="menu" with menuitem / menuitemcheckbox / menuitemradio,
 * one roving tab stop, ↑ ↓ Home End to move, Enter / Space to choose, Esc
 * closes and puts focus back on the gear (a press outside just closes).
 * Portalled to <body> so the 56px rail cannot clip it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../../../data/hooks.js';
import type { ThemePreference } from '../../../data/theme-store.js';
import { useVerseUi } from '../useVerseUi.js';
import { AppsIcon, SettingsIcon, UsageIcon } from '../verse-icons.js';
import { IconKeyboard } from '../../../components/primitives/icons.js';
import { openVerseOverlay, setVerseSection, toggleVerseRail } from '../verse-ui-store.js';
import { detectKeyPlatform, findCommand, formatChord } from './command-catalog.js';
import styles from './GearTray.module.css';

export interface GearTrayProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Phone layout: the rail is a bottom bar, so the menu rises from it. */
  compact: boolean;
}

interface Entry {
  key: string;
  role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
  label: string;
  icon?: ReactNode;
  shortcut?: string | null;
  checked?: boolean;
  run: () => void;
  /** Keep the menu open after choosing (theme / rail toggles). */
  stay?: boolean;
}

function shortcutOf(id: string): string | null {
  const chord = findCommand(id)?.keys[0];
  return chord ? formatChord(chord, detectKeyPlatform()) : null;
}

const THEMES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function GearTray({ open, anchorRef, onClose, compact }: GearTrayProps) {
  const ui = useVerseUi();
  const theme = useTheme();
  const menuRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);

  const entries: Entry[] = [
    { key: 'settings', role: 'menuitem', label: 'Settings', icon: <SettingsIcon />, shortcut: shortcutOf('section.settings'), run: () => setVerseSection('settings') },
    { key: 'apps', role: 'menuitem', label: 'Apps & Accounts', icon: <AppsIcon />, run: () => setVerseSection('apps') },
    { key: 'usage', role: 'menuitem', label: 'Usage', icon: <UsageIcon />, run: () => setVerseSection('usage') },
    { key: 'shortcuts', role: 'menuitem', label: 'Keyboard shortcuts', icon: <IconKeyboard />, shortcut: shortcutOf('shortcuts.open'), run: () => openVerseOverlay('shortcuts') },
    ...(compact
      ? []
      : [{ key: 'rail', role: 'menuitemcheckbox' as const, label: 'Show rail labels', shortcut: shortcutOf('rail.toggle-labels'), checked: ui.railExpanded, run: toggleVerseRail, stay: true }]),
    ...THEMES.map((t) => ({
      key: `theme-${t.value}`,
      role: 'menuitemradio' as const,
      label: t.label,
      checked: theme.theme === t.value,
      run: () => theme.set(t.value),
      stay: true,
    })),
  ];

  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(
      compact
        ? { left: 8, bottom: Math.max(8, window.innerHeight - rect.top + 8) }
        : { left: rect.right + 8, bottom: Math.max(8, window.innerHeight - rect.bottom) },
    );
  }, [open, anchorRef, compact]);

  // Every open starts on the first item. Reset while rendering (React's
  // "adjust state when a prop changes"), not in an effect: an effect runs
  // after the focus effect below has already focused wherever the LAST open
  // left off, so focus would hop there and then back to the first item.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setActive(0);
  }

  // The latest onClose, without re-subscribing the outside-press listener:
  // the shell passes an inline closure and re-renders on every activity poll.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, anchorRef]);

  // Focus follows the roving tab stop — once the menu is placed. Until the
  // layout effect above has measured the gear, the menu renders
  // visibility:hidden and a browser will not focus it; the placed re-render
  // follows in the same task, before paint, and this effect runs again then.
  // (This used to be a requestAnimationFrame that focused item 0 whatever
  // `active` was: an arrow key pressed before that frame moved the tab stop,
  // then the frame pulled focus back to the first item, so focus and the tab
  // stop sat on different items and Enter chose the wrong one.)
  const placed = position !== null;
  useEffect(() => {
    if (!open || !placed) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active, open, placed]);

  // Escape hands focus back to the gear AFTER the close has rendered, not in
  // the key handler. The shell turns the gear's tooltip off while the tray is
  // open and back on when it closes, and that re-creates the gear <button>:
  // focusing `anchorRef.current` synchronously focused the button that was
  // about to leave the document, and focus fell to <body>. This effect runs
  // after the shell's commit, when the ref already points at the live button.
  const refocusOnClose = useRef(false);
  useEffect(() => {
    if (open || !refocusOnClose.current) return;
    refocusOnClose.current = false;
    anchorRef.current?.focus();
  }, [open, anchorRef]);

  if (!open) return null;

  function close(restoreFocus = true) {
    refocusOnClose.current = restoreFocus;
    onClose();
  }

  function choose(entry: Entry) {
    entry.run();
    if (!entry.stay) close(false);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const count = entries.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((i) => (i + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((i) => (i - 1 + count) % count);
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(count - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case 'Tab':
        // A menu is one tab stop: Tab leaves it (and closes it).
        close(false);
        break;
      default:
        break;
    }
  }

  const themeStart = entries.findIndex((e) => e.key.startsWith('theme-'));

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Settings and more"
      className={styles.menu}
      data-compact={compact || undefined}
      style={position ? { left: position.left, bottom: position.bottom } : { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => (
        <div key={entry.key} role="none">
          {index === themeStart ? (
            <div role="separator" className={styles.separator}>
              <span className={styles.groupLabel}>Theme</span>
            </div>
          ) : null}
          {entry.key === 'rail' ? <div role="separator" className={styles.separator} /> : null}
          <button
            type="button"
            role={entry.role}
            data-index={index}
            tabIndex={index === active ? 0 : -1}
            aria-checked={entry.role === 'menuitem' ? undefined : entry.checked === true}
            className={styles.item}
            onClick={() => choose(entry)}
            onMouseMove={() => index !== active && setActive(index)}
          >
            <span className={styles.icon} aria-hidden="true">
              {entry.role === 'menuitem' ? entry.icon : entry.checked ? <span className={styles.check} /> : null}
            </span>
            <span className={styles.label}>{entry.label}</span>
            {entry.shortcut ? <kbd className={styles.key}>{entry.shortcut}</kbd> : null}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
