/**
 * components/command-palette/CommandPalette.tsx — ⌘K. Navigate anywhere,
 * run any action, all from the keyboard (foundation brief item 6: "treat
 * it as core, not a nice-to-have").
 *
 * Global open/close is owned here via a document-level keydown listener
 * (mounted once from App.tsx) rather than requiring every view to know the
 * palette exists.
 *
 * Guarded actions (pause/resume fleet, approve/reject a proposal) go
 * through the same confirm → token → execute sequence their regular UI
 * uses (see ConfirmDialog + MutationTokenDialog below) — the palette is a
 * second entry point, never a shortcut around either gate. The sequence
 * mirrors FleetView.tsx's requestAction/confirmIntent/effect pattern: show
 * the confirm dialog first (regardless of token state), and only after
 * it's accepted check whether the token hold is live; if not, prompt for
 * it and auto-run the pending command once the hold appears.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { filterCommands, buildContextCommands, warmJumpCaches, type Command } from './commands.js';
import { hasMutationHold } from '../../data/auth-store.js';
import { useMutationHold } from '../../data/hooks.js';
import { MutationTokenDialog } from '../auth/MutationTokenDialog.js';
import { ConfirmDialog } from '../../routes/inbox/ConfirmDialog.js';
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const mutationHold = useMutationHold();

  const contextCommands = useMemo(() => (open ? buildContextCommands(location.pathname) : []), [open, location.pathname]);
  const results = useMemo(() => filterCommands(query, contextCommands), [query, contextCommands]);

  // Open: capture whatever had focus so it can be restored on close (same
  // contract as the shared Dialog primitive), reset search state, warm the
  // jump-search caches, and focus the input a tick after the portal mounts.
  // Close: restore focus to whatever opened the palette.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setQuery('');
    setActiveIndex(0);
    warmJumpCaches();
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(results.length - 1, 0)));
  }, [results.length]);

  async function runCommand(cmd: Command) {
    try {
      await cmd.run((path, opts) => navigate(path, opts));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Command failed.', 'danger');
    } finally {
      setPendingCommand(null);
    }
  }

  function requestExecute(cmd: Command) {
    onClose();
    if (cmd.requiresConfirm) {
      setPendingCommand(cmd);
      setConfirmOpen(true);
      return;
    }
    if (cmd.requiresMutationToken && !hasMutationHold()) {
      setPendingCommand(cmd);
      setTokenOpen(true);
      return;
    }
    void runCommand(cmd);
  }

  function onConfirmAccept() {
    setConfirmOpen(false);
    if (!pendingCommand) return;
    if (pendingCommand.requiresMutationToken && !hasMutationHold()) {
      setTokenOpen(true);
    } else {
      void runCommand(pendingCommand);
    }
  }

  function onConfirmCancel() {
    setConfirmOpen(false);
    setPendingCommand(null);
  }

  // Mirrors FleetView.tsx's post-token-dialog effect: once the token dialog
  // closes, either the hold now exists (run the command that was waiting on
  // it) or the operator backed out (drop it — never re-prompt silently).
  useEffect(() => {
    if (tokenOpen) return;
    if (!pendingCommand) return;
    if (!pendingCommand.requiresMutationToken) return;
    if (mutationHold.hasHold) void runCommand(pendingCommand);
    else setPendingCommand(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenOpen, mutationHold.hasHold]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      // The input is the only natively focusable element in the panel
      // (options are hover/Enter-driven, not individually tabbable) — trap
      // Tab here instead of letting focus escape to whatever the portal
      // happens to sit next to in the DOM.
      e.preventDefault();
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
      if (cmd) requestExecute(cmd);
    }
  }

  return (
    <>
      {open
        ? createPortal(
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
                          requestExecute(cmd);
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
          )
        : null}

      {pendingCommand?.requiresConfirm ? (
        <ConfirmDialog
          open={confirmOpen}
          onClose={onConfirmCancel}
          title={pendingCommand.requiresConfirm.title}
          body={pendingCommand.requiresConfirm.body}
          confirmLabel={pendingCommand.requiresConfirm.confirmLabel}
          destructive={pendingCommand.requiresConfirm.destructive}
          onConfirm={onConfirmAccept}
        />
      ) : null}

      <MutationTokenDialog
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        reason={pendingCommand ? `"${pendingCommand.title}" requires the dispatch token.` : undefined}
      />
    </>
  );
}
