/**
 * routes/verse/shell/NeedsYouList.tsx — the rows of the Needs-you drawer
 * (unit C1). A listbox with ONE tab stop and aria-activedescendant, so J / K
 * move the selection without moving focus (and without the page scrolling
 * under the drawer). Presentational: selection and keys belong to the drawer.
 *
 * Each row says what, where, and how urgent — severity is a word AND a colour
 * (never colour alone), and an item with a deadline shows it counting down.
 */
import { forwardRef, useEffect, useRef } from 'react';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { NEEDS_YOU_ACTION_KEYS } from '../../../../core/verse/workbench-types.js';
import { ago, until } from './needs-you-model.js';
import styles from './NeedsYouDrawer.module.css';

const SEVERITY_WORD: Readonly<Record<NeedsYouItem['severity'], string>> = { high: 'Urgent', warn: 'Soon', info: 'When you can' };

const SOURCE_WORD: Readonly<Record<NeedsYouItem['source'], string>> = {
  approvals: 'Approval',
  authority: 'Autonomy',
  fleet: 'Fleet',
  leader: 'Leader',
  chats: 'Chat',
  accounts: 'Account',
};

export interface NeedsYouListProps {
  items: readonly NeedsYouItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  now: number;
  label: string;
}

export const NeedsYouList = forwardRef<HTMLDivElement, NeedsYouListProps>(function NeedsYouList(
  { items, selectedId, onSelect, onOpen, now, label },
  ref,
) {
  const listId = 'verse-needs-you-list';
  const rowsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedId) return;
    // Matched by dataset, not a selector: ids come from other units' producers.
    const rows = rowsRef.current?.querySelectorAll<HTMLElement>('[data-item-id]') ?? [];
    const row = [...rows].find((el) => el.dataset['itemId'] === selectedId);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  return (
    <div
      ref={(node) => {
        rowsRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      id={listId}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={selectedId ? `${listId}-${items.findIndex((i) => i.id === selectedId)}` : undefined}
      className={styles.rows}
    >
      {items.map((item, index) => {
        const keyed = item.actions
          .map((a) => NEEDS_YOU_ACTION_KEYS[a.kind])
          .filter((k): k is 'A' | 'R' | 'V' | 'E' => k !== undefined);
        return (
          <div
            key={item.id}
            id={`${listId}-${index}`}
            data-item-id={item.id}
            role="option"
            aria-selected={item.id === selectedId}
            className={styles.row}
            data-severity={item.severity}
            onClick={() => onOpen(item.id)}
            onMouseMove={() => item.id !== selectedId && onSelect(item.id)}
          >
            <span className={styles.rule} aria-hidden="true" />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{item.title}</span>
              <span className={styles.rowMeta}>
                <span className={styles.severity} data-severity={item.severity}>{SEVERITY_WORD[item.severity]}</span>
                <span>{SOURCE_WORD[item.source]}</span>
                {item.subject.repo ? <span className={styles.mono}>{item.subject.repo}</span> : null}
                {item.subject.pr ? <span>#{item.subject.pr}</span> : null}
                <span>{ago(item.since, now)}</span>
                {item.expiresAt ? <span className={styles.deadline}>closes {until(item.expiresAt, now)}</span> : null}
              </span>
            </span>
            {item.id === selectedId && keyed.length > 0 ? (
              <span className={styles.rowKeys} aria-hidden="true">
                {keyed.map((k) => (
                  <kbd key={k} className={styles.key}>{k}</kbd>
                ))}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});
