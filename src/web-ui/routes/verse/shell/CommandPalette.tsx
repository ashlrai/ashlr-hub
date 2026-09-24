/**
 * routes/verse/shell/CommandPalette.tsx — ⌘K (unit C1; SPEC-310C §1).
 *
 * Lives in the SHELL chunk (VerseApp imports it statically), so opening it
 * costs one render — no chunk to fetch, no surface to mount — which is how
 * it opens inside the 50 ms budget. It NEVER switches surface on its own:
 * opening it on Fleet leaves Fleet on screen (the pre-3.10 switcher jumped to
 * Chat first). Only running an item navigates, and only when that is what
 * the item is.
 *
 * Keys (the palette owns every key while open):
 *   ↑ ↓ move · ↩ run · ⇥ fill the argument ("New chat on…" → a seat) ·
 *   ⌫ on an empty argument query steps back · Esc closes (or leaves the
 *   argument step) · ⌘K closes.
 *
 * Accessibility: a combobox driving a listbox through aria-activedescendant
 * (focus never leaves the input); group headings are presentational labels
 * the options reference, and the result count is announced politely.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import { useQuery } from '../../../data/hooks.js';
import { verseBootstrapQuery, verseSessionsQuery } from '../verse-queries.js';
import { useVerseUi } from '../useVerseUi.js';
import { ReturnKeyIcon } from '../verse-icons.js';
import { closeVerseOverlay, openVerseNeedsYou, openVerseSession, requestVerseCommand } from '../verse-ui-store.js';
import { detectKeyPlatform, findCommand, type WorkbenchCommand } from './command-catalog.js';
import { argumentItems, buildPaletteItems, paletteView, type PaletteItem } from './palette-model.js';
import { executeCatalogCommand } from './run-command.js';
import { useActivity } from './useActivity.js';
import styles from './CommandPalette.module.css';

export interface CommandPaletteProps {
  onClose?: () => void;
}

export function CommandPalette({ onClose = closeVerseOverlay }: CommandPaletteProps) {
  const ui = useVerseUi();
  const activity = useActivity();
  const sessions = useQuery(verseSessionsQuery);
  const bootstrap = useQuery(verseBootstrapQuery);
  const platform = useMemo(() => detectKeyPlatform(), []);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [argFor, setArgFor] = useState<WorkbenchCommand | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const labelId = useId();

  // The trap owns Escape (it listens in the capture phase, before the input
  // sees the key), so "Esc leaves the argument step first" lives here.
  const argRef = useRef<WorkbenchCommand | null>(null);
  argRef.current = argFor;
  const trapClose = useCallback(() => {
    if (argRef.current) setArgFor(null);
    else onClose();
  }, [onClose]);
  useFocusTrap({ open: true, containerRef: panelRef, onClose: trapClose, initialFocusRef: inputRef });

  const input = useMemo(
    () => ({
      needsYou: activity.data?.needsYou ?? [],
      running: activity.data?.running ?? [],
      sessions: sessions.data ?? bootstrap.data?.sessions ?? [],
      seats: bootstrap.data?.seats ?? [],
      projects: bootstrap.data?.projects ?? [],
      recentActions: ui.recentActions,
      platform,
    }),
    [activity.data, sessions.data, bootstrap.data, ui.recentActions, platform],
  );

  const view = useMemo(() => {
    if (argFor?.argument) {
      const candidates = argumentItems(argFor.argument.kind, input);
      const shown = paletteView(candidates, `>${query}`, [], platform);
      return { ...shown, prefix: null };
    }
    return paletteView(buildPaletteItems(input), query, ui.recentActions, platform);
  }, [argFor, input, query, ui.recentActions, platform]);

  // Keep the highlight on a real row as results change.
  useEffect(() => {
    setActive((i) => (view.flat.length === 0 ? 0 : Math.min(i, view.flat.length - 1)));
  }, [view.flat.length]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  function enterArgument(command: WorkbenchCommand) {
    setArgFor(command);
    setQuery('');
    setActive(0);
  }

  function run(item: PaletteItem | undefined) {
    if (!item) return;
    const payload = item.payload;
    if (payload.kind === 'command') {
      const command = findCommand(payload.commandId);
      // Enter on an argument command asks for the argument, like Tab.
      if (command?.argument) {
        enterArgument(command);
        return;
      }
      onClose();
      executeCatalogCommand(payload.commandId, { via: 'palette' });
      return;
    }
    onClose();
    switch (payload.kind) {
      case 'needs-you':
        openVerseNeedsYou({ split: 'all', focusId: payload.itemId });
        break;
      case 'chat':
        openVerseSession(payload.sessionId);
        break;
      case 'seat':
        executeCatalogCommand('chat.new-on', { via: 'palette', argument: { kind: 'seat', id: payload.seatId, label: payload.label } });
        break;
      case 'project':
        requestVerseCommand('new-chat', { projectPath: payload.path });
        break;
      case 'argument':
        if (argFor) executeCatalogCommand(argFor.id, { via: 'palette', argument: payload.argument });
        break;
      default:
        break;
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    const count = view.flat.length;
    const key = event.key;
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'k') {
      event.preventDefault();
      onClose();
      return;
    }
    switch (key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count > 0) setActive((i) => (i + 1) % count);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) setActive((i) => (i - 1 + count) % count);
        return;
      case 'Home':
        if (count > 0) { event.preventDefault(); setActive(0); }
        return;
      case 'End':
        if (count > 0) { event.preventDefault(); setActive(count - 1); }
        return;
      case 'Enter':
        event.preventDefault();
        run(view.flat[active]);
        return;
      case 'Tab': {
        // Tab never moves focus out of the palette: it fills an argument or does nothing.
        event.preventDefault();
        const item = view.flat[active];
        const command = item?.payload.kind === 'command' ? findCommand(item.payload.commandId) : null;
        if (command?.argument) enterArgument(command);
        return;
      }
      case 'Backspace':
        if (argFor && query === '') {
          event.preventDefault();
          setArgFor(null);
        }
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        if (argFor) setArgFor(null);
        else onClose();
        return;
      default:
        return;
    }
  }

  const activeItem = view.flat[active];
  const placeholder = argFor?.argument
    ? `${argFor.argument.prompt}…`
    : 'Search chats, actions and places';
  let index = -1;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={labelId} data-verse-overlay="palette">
        <h2 id={labelId} className="visually-hidden">Command palette</h2>
        <div className={styles.field}>
          {argFor ? (
            <span className={styles.crumb}>
              {argFor.title.replace(/…$/, '')}
              <span aria-hidden="true"> ›</span>
            </span>
          ) : null}
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            placeholder={placeholder}
            aria-label={argFor?.argument ? argFor.argument.prompt : 'Search commands'}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? `${listId}-${active}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={listRef} id={listId} className={styles.list} role="listbox" aria-label="Results">
          {view.flat.length === 0 ? (
            <p className={styles.empty}>
              {argFor ? `No ${argFor.argument?.prompt.toLowerCase() ?? 'match'} matches “${query}”.` : `Nothing matches “${query.trim()}”.`}
            </p>
          ) : (
            view.groups.map((group) => (
              <div key={group.id} role="group" aria-label={argFor ? (argFor.argument?.prompt ?? group.label) : group.label} className={styles.group}>
                <div className={styles.groupLabel} aria-hidden="true">
                  {argFor ? argFor.argument?.prompt : group.label}
                </div>
                {group.items.map((item) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={item.key}
                      id={`${listId}-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={i === active}
                      className={styles.item}
                      data-tone={item.tone}
                      onMouseMove={() => i !== active && setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => run(item)}
                    >
                      <span className={styles.lead} aria-hidden="true">
                        {item.monogram ? (
                          <span className={styles.monogram} data-engine={item.engine ?? undefined}>{item.monogram}</span>
                        ) : (
                          <span className={styles.bullet} data-kind={item.kind} />
                        )}
                      </span>
                      <span className={styles.text}>
                        <span className={styles.title}>{item.title}</span>
                        {item.subtitle ? <span className={styles.subtitle}>{item.subtitle}</span> : null}
                      </span>
                      <span className={styles.trail}>
                        {item.argument ? <kbd className={styles.key}>⇥</kbd> : null}
                        {item.shortcut ? <kbd className={styles.key}>{item.shortcut}</kbd> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className={styles.foot} aria-hidden="true">
          <span><kbd className={styles.key}>↑↓</kbd> move</span>
          <span><kbd className={styles.key}><ReturnKeyIcon /></kbd> run</span>
          {activeItem?.argument ? <span><kbd className={styles.key}>⇥</kbd> {activeItem.argument.prompt.toLowerCase()}</span> : null}
          <span><kbd className={styles.key}>esc</kbd> {argFor ? 'back' : 'close'}</span>
          {argFor ? null : <span><kbd className={styles.key}>&gt;</kbd> actions only · <kbd className={styles.key}>#</kbd> chats only</span>}
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">
          {view.flat.length === 1 ? '1 result' : `${view.flat.length} results`}
        </p>
      </div>
    </div>,
    document.body,
  );
}
