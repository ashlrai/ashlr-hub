/**
 * routes/verse/leader/DirectivesStrip.tsx — Mason's standing instructions to
 * the Leader, pinned above the conversation as chips.
 *
 *   DIRECTIVES  [Ship binshield before new goals ×] [No spend raises at night ×]  + Add directive
 *
 * × retires one (token, no confirmation: a directive can be added back in a
 * second, and retiring one only removes an instruction). "+ Add directive"
 * opens an inline box: Enter adds, Escape cancels. Both go through the
 * surface's actions (token prompt, read-only explanation, the server's own
 * refusal sentence on the Mind action line).
 *
 * The box counts against the server's own limit (OPERATOR_DIRECTIVE_MAX,
 * shared with leader-operator.ts): "142/300", amber near the limit, red and
 * Add disabled over it. No `maxLength` on the input — a paste that runs long
 * stays visible and editable instead of being silently cut.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { IconPlus, IconX } from '../../../components/primitives/icons.js';
import type { SurfaceActions } from '../command/actions.js';
import type { OptionalRead } from '../command/surface-data.js';
import { addLeaderDirective, retireLeaderDirective } from './thread-data.js';
import { CHANNEL_LABEL } from './thread-model.js';
import { OPERATOR_DIRECTIVE_MAX, type DirectiveChip } from './thread-types.js';
import styles from './leader.module.css';

/** The server's limit (leader-thread-types.ts) — one number for both sides. */
export const DIRECTIVE_MAX = OPERATOR_DIRECTIVE_MAX;
/** The counter turns to a warning at this share of the limit. */
const DIRECTIVE_NEAR = 0.9;

export interface DirectivesStripProps {
  read: OptionalRead<DirectiveChip[]> | undefined;
  actions: SurfaceActions;
  /** The inline add box is open (the panel opens it for ⌘K "Add Leader directive…"). */
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
}

export function DirectivesStrip({ read, actions, adding, onAddingChange }: DirectivesStripProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const list = read?.value ?? null;
  const disabled = actions.busy || actions.readOnly;
  const length = draft.trim().length;
  const over = length > DIRECTIVE_MAX;
  const near = !over && length >= Math.floor(DIRECTIVE_MAX * DIRECTIVE_NEAR);

  function add() {
    const text = draft.trim();
    if (!text || text.length > DIRECTIVE_MAX) return;
    actions.act(() => addLeaderDirective(text), 'Adding a Leader directive requires the dispatch token.', {
      onDone: () => {
        setDraft('');
        onAddingChange(false);
      },
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDraft('');
      onAddingChange(false);
      return;
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      add();
    }
  }

  return (
    <div className={styles.directives} role="group" aria-label="Directives">
      <span className={styles.micro}>Directives</span>
      {!read ? (
        <span className={styles.muted} aria-busy="true">Reading…</span>
      ) : list === null ? (
        <span className={styles.muted}>{read.reason ?? 'Directives did not answer.'}</span>
      ) : list.length === 0 && !adding ? (
        <span className={styles.muted}>None standing — the Leader works from its own judgment.</span>
      ) : (
        <ul className={styles.chips}>
          {list.map((d) => (
            <li key={d.id} className={styles.directiveChip} title={[d.text, d.channel ? `added from ${CHANNEL_LABEL[d.channel]}` : null].filter(Boolean).join(' — ')}>
              <span className={styles.pin} aria-hidden="true" />
              <span className={styles.directiveText}>{d.text}</span>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Retire directive: ${d.text}`}
                disabled={disabled}
                onClick={() => actions.act(() => retireLeaderDirective(d.id), 'Retiring a Leader directive requires the dispatch token.')}
              >
                <IconX />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <span className={styles.addDirective}>
          <input
            ref={inputRef}
            className={styles.directiveInput}
            aria-label="New directive"
            placeholder="e.g. No new goals until binshield ships"
            value={draft}
            aria-invalid={over || undefined}
            aria-describedby="leader-directive-counter"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // An empty box closes on blur; words typed stay until Escape or Add.
              if (!draft.trim()) onAddingChange(false);
            }}
          />
          <span
            id="leader-directive-counter"
            className={styles.counter}
            data-near={near ? 'true' : undefined}
            data-over={over ? 'true' : undefined}
            aria-live="polite"
          >
            {length}/{DIRECTIVE_MAX}
          </span>
          <button type="button" className={styles.textButton} disabled={disabled || length === 0 || over} onClick={add}>
            Add
          </button>
        </span>
      ) : list !== null ? (
        <button type="button" className={styles.textButton} disabled={actions.readOnly} onClick={() => onAddingChange(true)}>
          <IconPlus /> Add directive
        </button>
      ) : null}
    </div>
  );
}
