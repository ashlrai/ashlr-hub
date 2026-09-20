/**
 * routes/verse/QuickSwitcher.tsx — ⌘K. A minimal listbox over existing
 * chats plus a "New chat on <seat>" row per selectable seat. The shared
 * CommandPalette is bound to the HashRouter nav table, which this
 * full-bleed console does not mount, so this is the small list the contract
 * allows instead — same Dialog primitive, same keyboard model.
 *
 * Each row carries the same 2px engine marker the sidebar uses, so the
 * switcher reads as the same list seen from a different angle.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { VerseEngine, VerseProject, VerseSeat, VerseSession } from '../../data/api-types.js';
import { Dialog } from '../../components/primitives/Dialog.js';
import type { SeatChoice } from './SeatSelector.js';
import { formatRelative, projectName, seatLabel } from './verse-model.js';
import styles from './QuickSwitcher.module.css';

export interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
  sessions: readonly VerseSession[];
  seats: readonly VerseSeat[];
  projects: readonly VerseProject[];
  onSelectSession: (id: string) => void;
  onNewChat: (seat: SeatChoice | null) => void;
}

interface Row {
  id: string;
  kind: 'session' | 'seat';
  engine: VerseEngine;
  primary: string;
  secondary: string;
  trailing: string;
  run: () => void;
}

export function QuickSwitcher({ open, onClose, sessions, seats, projects, onSelectSession, onNewChat }: QuickSwitcherProps) {
  const titleId = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const sessionRows: Row[] = [...sessions]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: `session:${s.id}`,
        kind: 'session' as const,
        engine: s.engine,
        primary: s.title || 'Untitled chat',
        secondary: `${projectName(s.projectPath, projects)} · ${seatLabel(seats, s)} · ${s.model}`,
        trailing: formatRelative(s.updatedAt),
        run: () => { onSelectSession(s.id); onClose(); },
      }));
    const seatRows: Row[] = seats
      .filter((seat) => seat.health.state !== 'unavailable' && seat.models.length > 0)
      .map((seat) => ({
        id: `seat:${seat.id}`,
        kind: 'seat' as const,
        engine: seat.engine,
        primary: `New chat on ${seat.label}`,
        secondary: seat.models[0]!.label,
        trailing: '⌘N',
        run: () => { onNewChat({ seatId: seat.id, model: seat.models[0]!.id }); onClose(); },
      }));
    const all = [...sessionRows, ...seatRows];
    if (!q) return all;
    return all.filter((r) => r.primary.toLowerCase().includes(q) || r.secondary.toLowerCase().includes(q));
  }, [query, sessions, seats, projects, onSelectSession, onNewChat, onClose]);

  useEffect(() => {
    if (active >= rows.length) setActive(0);
  }, [rows.length, active]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      rows[active]?.run();
    }
  }

  return (
    <Dialog open={open} onClose={onClose} titleId={titleId} title="Switch chat" initialFocusRef={input} widthClassName={styles.width}>
      <input ref={input} className={styles.input} value={query} placeholder="Search chats or start one on a seat…"
        role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list" autoComplete="off" onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown} />
      <ul id={listId} role="listbox" className={styles.list} aria-label="Chats and seats">
        {rows.length === 0 ? <li className={styles.emptyRow}>Nothing matches.</li> : rows.map((row, i) => (
          <li key={row.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
            className={`${styles.row} ${styles[`engine-${row.engine}`] ?? ''} ${i === active ? styles.rowActive : ''}`}
            data-kind={row.kind}
            onMouseEnter={() => setActive(i)} onMouseDown={(event) => event.preventDefault()} onClick={row.run}>
            <span className={styles.marker} aria-hidden="true" />
            <span className={styles.rowText}>
              <span className={styles.rowPrimary}>{row.primary}</span>
              <span className={styles.rowSecondary}>{row.secondary}</span>
            </span>
            <span className={styles.rowTrailing} aria-hidden="true">{row.trailing}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
