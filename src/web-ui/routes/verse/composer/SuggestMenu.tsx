/**
 * routes/verse/composer/SuggestMenu.tsx — the listbox the `@` file finder and
 * the `/` commands open above the message box (unit C3).
 *
 * Focus NEVER leaves the textarea: it owns the keys (↑/↓ move, Enter/Tab
 * accept, Esc closes — see Composer's onKeyDown) and points at the active
 * option with `aria-activedescendant`, the combobox pattern, so typing keeps
 * narrowing the list. A pointer can pick too; mousedown is prevented so the
 * click does not blur the textarea first.
 */
import type { ReactNode } from 'react';
import styles from './composer.module.css';

export interface SuggestItem {
  id: string;
  primary: ReactNode;
  secondary?: ReactNode;
  /** Shown disabled with this reason (a command this chat cannot run). */
  disabledReason?: string | null;
}

export interface SuggestMenuProps {
  id: string;
  label: string;
  items: readonly SuggestItem[];
  activeIndex: number;
  /** Shown instead of the list: "Searching…", "No files match". */
  status?: string | null;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

export function suggestOptionId(menuId: string, index: number): string {
  return `${menuId}-opt-${index}`;
}

export function SuggestMenu({ id, label, items, activeIndex, status = null, onPick, onHover }: SuggestMenuProps) {
  return (
    <div className={styles.suggest}>
      <p className={styles.suggestHeading}>{label}</p>
      {items.length === 0 ? (
        <p className={styles.suggestStatus} role="status">{status ?? 'Nothing matches'}</p>
      ) : (
        <ul id={id} role="listbox" aria-label={label} className={styles.suggestList}>
          {items.map((item, index) => (
            <li key={item.id} id={suggestOptionId(id, index)} role="option" aria-selected={index === activeIndex}
              aria-disabled={item.disabledReason ? true : undefined}
              className={styles.suggestItem}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(index)}>
              <span className={styles.suggestPrimary}>{item.primary}</span>
              {item.disabledReason ? <span className={styles.suggestSecondary}>{item.disabledReason}</span>
                : item.secondary ? <span className={styles.suggestSecondary}>{item.secondary}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && status ? <p className={styles.suggestStatus} role="status">{status}</p> : null}
    </div>
  );
}
