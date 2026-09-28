/**
 * terminal/HistoryPalette.tsx — Ctrl+R for the Verse terminal (3.15), and the
 * "Generate command…" prompt. Built from the ⌘K palette's primitives (its
 * stylesheet, the focus trap, the combobox + listbox pattern), so it looks
 * and moves exactly like it.
 *
 *   history  every command the operator's shells finished (the server's
 *            history, ranked for this shell's cwd: prefix → here → repo →
 *            succeeded → recent). ↩ puts the command in the input editor —
 *            it does NOT run it. Ctrl+R again gives the search to the shell's
 *            own Ctrl+R (fzf, atuin …) with what was typed.
 *   assist   a request in plain words → the configured model → ONE command, shown
 *            for review. ↩ inserts it for editing; nothing runs.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { VerseTerminalAssistMode, VerseTerminalAssistResponse, VerseTerminalHistoryEntry } from '../../../data/api-types.js';
import { assistDisclosure, assistLoadingLabel } from './assist-disclosure.js';
import { ApiError } from '../../../data/client.js';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import { ReturnKeyIcon } from '../verse-icons.js';
import type { PanelTerminalApi } from './panel-client.js';
import { Button } from '../../../components/primitives/Button.js';
import styles from '../shell/CommandPalette.module.css';
import own from './HistoryPalette.module.css';

export type TerminalPaletteMode = 'history' | 'assist';

export interface HistoryPaletteProps {
  mode: TerminalPaletteMode;
  assistMode: VerseTerminalAssistMode;
  api: PanelTerminalApi;
  tabId: string | null;
  cwd: string | null;
  /** What was typed in the editor when it opened (the first query). */
  initialQuery: string;
  /** A command to put in the editor (or paste at the prompt). Never run. */
  onPick: (command: string) => void;
  /** Ctrl+R again: hand the search to the shell's own Ctrl+R, with this text. */
  onPassThrough?: (query: string) => void;
  onClose: () => void;
  /** Turn history on (shown when it is off). */
  onEnableHistory?: () => void;
}

const QUERY_DEBOUNCE_MS = 70;

function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}

function historySubtitle(e: VerseTerminalHistoryEntry): string {
  const parts: string[] = [];
  if (e.here) parts.push('here');
  else if (e.sameRepo) parts.push('this repo');
  if (e.exit !== null && e.exit !== 0) parts.push(`exit ${e.exit}`);
  if (e.count > 1) parts.push(`${e.count}×`);
  const when = ago(e.ts);
  if (when) parts.push(when);
  return parts.join(' · ');
}

function assistError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Unlock actions with the mutation token to generate commands.';
    if (err.detail) return err.detail;
  }
  return 'The command could not be generated.';
}

export function HistoryPalette({ mode, assistMode, api, tabId, cwd, initialQuery, onPick, onPassThrough, onClose, onEnableHistory }: HistoryPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [entries, setEntries] = useState<VerseTerminalHistoryEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [assist, setAssist] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; result: VerseTerminalAssistResponse | null; error: string | null }>({ state: 'idle', result: null, error: null });
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const labelId = useId();
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useFocusTrap({ open: true, containerRef: panelRef, onClose, initialFocusRef: inputRef });

  // History: ask the server as the query changes (debounced; the latest answer wins).
  useEffect(() => {
    if (mode !== 'history' || !api.history) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api.history!({ q: query, cwd, limit: 100 }, controller.signal).then((res) => {
        if (!mounted.current || controller.signal.aborted) return;
        setEntries(res.entries);
        setEnabled(res.enabled);
        setActive(0);
      }, () => { /* offline / locked: keep what is shown */ }).finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });
    }, QUERY_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, cwd, mode, query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const generate = useCallback(async (request: string) => {
    if (!api.assist || !request.trim()) return;
    setAssist({ state: 'loading', result: null, error: null });
    try {
      const result = await api.assist({ request: request.trim(), ...(tabId ? { tabId } : {}), ...(cwd ? { cwd } : {}), ...(assistMode === 'auto' ? { cloudAllowed: true } : {}) });
      if (mounted.current) setAssist({ state: 'done', result, error: null });
    } catch (err) {
      if (mounted.current) setAssist({ state: 'error', result: null, error: assistError(err) });
    }
  }, [api, assistMode, cwd, tabId]);

  const pick = (command: string) => {
    onClose();
    onPick(command);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const count = mode === 'history' ? entries.length : assist.result ? 1 : 0;
    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      if (mode === 'history' && onPassThrough) {
        onClose();
        onPassThrough(query);
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count > 0) setActive((i) => (i + 1) % count);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) setActive((i) => (i - 1 + count) % count);
        return;
      case 'Enter': {
        event.preventDefault();
        if (mode === 'history') {
          const entry = entries[active];
          if (entry) pick(entry.cmd);
          return;
        }
        // Assist: the first ↩ asks, the next inserts what came back (for review).
        if (assist.state === 'done' && assist.result && !event.shiftKey) pick(assist.result.command);
        else if (assist.state !== 'loading') void generate(query);
        return;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      default:
        return;
    }
  };

  const title = mode === 'history' ? 'Command history' : 'Generate a command';
  const placeholder = mode === 'history' ? 'Search commands you ran' : 'Describe what you want to do, in plain words';
  const activeId = (mode === 'history' ? entries[active] : assist.result) ? `${listId}-${active}` : undefined;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={labelId} data-verse-overlay={`terminal-${mode}`}>
        <h2 id={labelId} className="visually-hidden">{title}</h2>
        <div className={styles.field}>
          <span className={styles.crumb}>{mode === 'history' ? 'History' : 'Command'}<span aria-hidden="true"> ›</span></span>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              if (mode === 'assist' && assist.state !== 'loading') setAssist({ state: 'idle', result: null, error: null });
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={listRef} id={listId} className={styles.list} role="listbox" aria-label={title} aria-busy={loading || assist.state === 'loading' || undefined}>
          {mode === 'history' ? (
            !enabled ? (
              <p className={styles.empty}>
                Command history is off.{' '}
                {onEnableHistory ? <Button size="sm" variant="subtle" onClick={onEnableHistory}>Turn it on</Button> : null}
              </p>
            ) : entries.length === 0 ? (
              <p className={styles.empty}>{loading ? 'Searching…' : query ? `No command matches “${query}”.` : 'Commands you run in the terminal appear here.'}</p>
            ) : (
              <div role="group" aria-label="Commands" className={styles.group}>
                {entries.map((entry, i) => (
                  <div
                    key={entry.cmd}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    className={styles.item}
                    data-tone={entry.exit !== null && entry.exit !== 0 ? 'warn' : undefined}
                    onMouseMove={() => i !== active && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(entry.cmd)}
                  >
                    <span className={styles.lead} aria-hidden="true"><span className={styles.bullet} data-kind={entry.here ? 'running' : 'command'} /></span>
                    <span className={styles.text}>
                      <span className={`${styles.title} ${own.command}`}>{entry.cmd}</span>
                      <span className={styles.subtitle}>{historySubtitle(entry)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : assist.state === 'loading' ? (
            <p className={styles.empty} role="status">{assistLoadingLabel(assistMode)}</p>
          ) : assist.state === 'error' ? (
            <p className={styles.empty} role="alert">{assist.error}</p>
          ) : assist.result ? (
            <div role="group" aria-label="Suggested command" className={styles.group}>
              <div
                id={`${listId}-0`}
                data-index={0}
                role="option"
                aria-selected="true"
                className={styles.item}
                data-tone={assist.result.risky ? 'danger' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(assist.result!.command)}
              >
                <span className={styles.lead} aria-hidden="true"><span className={styles.bullet} data-kind="command" /></span>
                <span className={styles.text}>
                  <span className={`${styles.title} ${own.command} ${own.wrap}`}>{assist.result.command}</span>
                  <span className={styles.subtitle}>
                    {[assist.result.risky ? 'Changes or deletes things — read it before running' : null, assist.result.explanation, `from ${assist.result.provider}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </div>
            </div>
          ) : (
            <p className={styles.empty}>
              {api.assist ? `Press Return to ask. ${assistDisclosure(assistMode)} The command comes back for you to review; nothing runs until you run it.` : 'This server cannot generate commands.'}
            </p>
          )}
        </div>
        <div className={styles.foot} aria-hidden="true">
          <span><kbd className={styles.key}>↑↓</kbd> move</span>
          {mode === 'history'
            ? <span><kbd className={styles.key}><ReturnKeyIcon /></kbd> insert (does not run)</span>
            : <span><kbd className={styles.key}><ReturnKeyIcon /></kbd> {assist.state === 'done' ? 'insert for review' : 'generate'}</span>}
          {mode === 'history' && onPassThrough ? <span><kbd className={styles.key}>Ctrl+R</kbd> shell’s own search</span> : null}
          <span><kbd className={styles.key}>esc</kbd> close</span>
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">
          {mode === 'history' ? (entries.length === 1 ? '1 command' : `${entries.length} commands`) : assist.state === 'done' ? 'Command ready' : ''}
        </p>
      </div>
    </div>,
    document.body,
  );
}
