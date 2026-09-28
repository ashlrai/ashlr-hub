/**
 * routes/verse/playbooks/CommandWorkflowPicker.tsx — pick a command workflow,
 * fill it, hand back the command (3.15).
 *
 * Self-contained so the terminal panel can lazy-mount it from its menu:
 *
 *   const CommandWorkflowPicker = lazy(() =>
 *     import('../playbooks/CommandWorkflowPicker.js').then((m) => ({ default: m.CommandWorkflowPicker })));
 *   <CommandWorkflowPicker onPaste={(text) => leaf.paste(text)} onClose={close} />
 *
 * It reads the playbook list itself (the shared query cache — one read also
 * serves the Playbooks section and the composer's `!` menu); a command
 * workflow's row already carries its template and parameters, so no second
 * read. Choosing one shows CommandWorkflowForm; "Paste in terminal" calls
 * `onPaste(filled)` and then `onClose()`. Escape steps back (form → list →
 * close). It never runs anything: `onPaste` must PASTE (the terminal types
 * it at the prompt; the operator presses Enter).
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PlaybookSummary } from '../../../../core/playbooks/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { useQuery } from '../../../data/hooks.js';
import { setVerseSection } from '../verse-ui-store.js';
import { CommandWorkflowForm } from './CommandWorkflowForm.js';
import { playbooksQuery } from './playbooks-queries.js';
import styles from './Playbooks.module.css';

export interface CommandWorkflowPickerProps {
  /** The filled command, no trailing newline. Paste it — never submit it. */
  onPaste(text: string): void;
  /** Cancel / Escape, and after a paste. */
  onClose(): void;
}

type CommandRow = PlaybookSummary & { command: NonNullable<PlaybookSummary['command']> };

/** The command workflows in a playbook list (rows from an older server have no kind: none). Pure. */
export function commandWorkflowRows(rows: readonly PlaybookSummary[] | null | undefined): CommandRow[] {
  return (rows ?? []).filter((r): r is CommandRow => r.kind === 'command' && !!r.command && typeof r.command.template === 'string');
}

/** Case-insensitive filter over name, id, description and the command itself. Pure. */
export function filterCommandWorkflows(rows: readonly CommandRow[], query: string): CommandRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => [r.name, r.id, r.description, r.command.template].some((s) => s.toLowerCase().includes(q)));
}

export function CommandWorkflowPicker({ onPaste, onClose }: CommandWorkflowPickerProps) {
  const read = useQuery(playbooksQuery, { freshMs: 60_000 });
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const workflows = useMemo(() => commandWorkflowRows(read.data?.value), [read.data]);
  const visible = useMemo(() => filterCommandWorkflows(workflows, filter), [workflows, filter]);
  const chosen = workflows.find((w) => w.id === chosenId) ?? null;
  const reason = read.data && !read.data.value ? read.data.reason : read.error ? 'Playbooks could not be read.' : null;

  const back = () => {
    setChosenId(null);
    setTimeout(() => filterRef.current?.focus(), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (chosen) back();
    else onClose();
  };

  return (
    <section className={styles.workflowPicker} aria-label="Command workflows" onKeyDown={onKeyDown}>
      <header className={styles.pickerHead}>
        <h3 className={styles.pickerTitle}>{chosen ? chosen.name : 'Run command workflow'}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </header>
      {chosen ? (
        <>
          {chosen.description ? <p className={styles.meta}>{chosen.description}</p> : null}
          <CommandWorkflowForm
            key={`${chosen.id}:${chosen.latest}`}
            name={chosen.name}
            template={chosen.command.template}
            params={chosen.command.params}
            onCancel={back}
            cancelLabel="Back"
            onPaste={(text) => {
              onPaste(text);
              onClose();
            }}
          />
        </>
      ) : reason ? (
        <p className={styles.banner} data-tone="danger">{reason}</p>
      ) : read.data === undefined ? (
        <div aria-busy="true" aria-label="Loading command workflows">
          <SkeletonLine width="60%" />
          <SkeletonLine width="40%" />
        </div>
      ) : workflows.length === 0 ? (
        <div className={styles.pickerEmpty}>
          <p className={styles.meta}>
            No command workflows yet. A command workflow is a shell command with <code>{'{{param:default}}'}</code> holes you fill in, then paste here.
          </p>
          <Button variant="subtle" size="sm" onClick={() => { setVerseSection('playbooks'); onClose(); }}>Open Playbooks</Button>
        </div>
      ) : (
        <>
          <input
            ref={filterRef}
            className={styles.filter}
            type="search"
            value={filter}
            placeholder="Filter command workflows"
            aria-label="Filter command workflows"
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && visible[0]) {
                e.preventDefault();
                setChosenId(visible[0].id);
              }
            }}
          />
          <ul className={styles.pickerList}>
            {visible.map((w) => (
              <li key={w.id}>
                <button type="button" onClick={() => setChosenId(w.id)}>
                  <span className={styles.rowName}>{w.name}</span>
                  <code className={styles.rowCommand}>{w.command.template.split('\n')[0]}</code>
                </button>
              </li>
            ))}
            {visible.length === 0 ? <li className={styles.meta}>No command workflow matches “{filter}”.</li> : null}
          </ul>
        </>
      )}
    </section>
  );
}
