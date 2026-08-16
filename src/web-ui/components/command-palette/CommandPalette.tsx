/**
 * components/command-palette/CommandPalette.tsx — ⌘K. Navigate anywhere,
 * run any action, all from the keyboard (foundation brief item 6: "treat
 * it as core, not a nice-to-have").
 *
 * Global open/close is owned here via a document-level keydown listener
 * (mounted once from App.tsx) rather than requiring every view to know the
 * palette exists.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { filterCommands, type Command } from './commands.js';
import { hasMutationHold } from '../../data/auth-store.js';
import { MutationTokenDialog } from '../auth/MutationTokenDialog.js';
import { useToast } from '../primitives/Toast.js';
import styles from './CommandPalette.module.css';

export function useCommandPaletteShortcut(setOpen: (open: boolean) => void) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isModK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isModK) {
        e.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingCommand, setPendingCommand] = useState<Command | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const navigate = useNavigate();
  const toast = useToast();

  const results = useMemo(() => filterCommands(query), [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Portal content mounts after this effect; defer focus a tick.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  async function execute(cmd: Command) {
    if (cmd.requiresMutationToken && !hasMutationHold()) {
      setPendingCommand(cmd);
      onClose();
      return;
    }
    onClose();
    try {
      await cmd.run((path) => navigate(path));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Command failed.', 'danger');
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[activeIndex];
      if (cmd) void execute(cmd);
    }
  }

  if (!open) {
    return pendingCommand ? (
      <MutationTokenDialog
        open
        reason={`"${pendingCommand.title}" requires the dispatch token.`}
        onClose={() => setPendingCommand(null)}
      />
    ) : null;
  }

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Navigate or run a command…"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[activeIndex] ? `cmd-${results[activeIndex].id}` : undefined}
          autoComplete="off"
        />
        <ul id={listId} role="listbox" className={styles.list}>
          {results.length === 0 ? (
            <li className={styles.empty}>No matching commands.</li>
          ) : (
            results.map((cmd, i) => (
              <li
                key={cmd.id}
                id={`cmd-${cmd.id}`}
                role="option"
                aria-selected={i === activeIndex}
                className={`${styles.item} ${i === activeIndex ? styles.active : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void execute(cmd);
                }}
              >
                <span className={styles.itemTitle}>{cmd.title}</span>
                {cmd.subtitle ? <span className={styles.itemSubtitle}>{cmd.subtitle}</span> : null}
                <span className={styles.itemGroup}>{cmd.group}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
