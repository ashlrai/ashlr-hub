/**
 * routes/verse/changes/UndoDialog.tsx — the confirmation for Undo turn and
 * Redo: what will be restored, what will be removed, what is left alone, and
 * — for every file someone edited after the agent — a three-way preview and
 * a decision (keep what is there / take the checkpoint / merge both).
 *
 * The confirm button stays disabled until every conflict has a decision. A
 * conflict that merges cleanly starts on "merge" (it keeps the later edit and
 * reverts the agent's); every other one starts undecided. Nothing here writes
 * a file: the server applies the plan, and refuses if anything moved since
 * this preview was taken.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { VerseCheckpointPlanConflict, VerseCheckpointPreviewResponse, VerseCheckpointResolution } from '../../../../core/verse/checkpoint-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { initialResolutions, planCounts, plural, undecided, type Resolutions } from './changes-model.js';
import styles from './ChangesPanel.module.css';

export interface UndoDialogProps {
  open: boolean;
  preview: VerseCheckpointPreviewResponse | null;
  /** "Turn 3" — what the operator is undoing. */
  turnLabel: string;
  /** rootId → display name. */
  rootNames: Readonly<Record<string, string>>;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (resolutions: Resolutions) => void;
}

const CHOICES: ReadonlyArray<{ value: VerseCheckpointResolution; label: string; hint: string }> = [
  { value: 'merge', label: 'Merge both', hint: 'Keep the later edits and revert the agent’s' },
  { value: 'keep', label: 'Keep current', hint: 'Leave the file exactly as it is on disk' },
  { value: 'checkpoint', label: 'Use checkpoint', hint: 'Overwrite with the checkpoint (later edits are lost; Redo brings them back)' },
];

export function UndoDialog({ open, preview, turnLabel, rootNames, busy, error, onClose, onConfirm }: UndoDialogProps) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [resolutions, setResolutions] = useState<Resolutions>({});
  useEffect(() => {
    if (preview) setResolutions(initialResolutions(preview));
  }, [preview]);

  const counts = useMemo(() => (preview ? planCounts(preview) : null), [preview]);
  const missing = preview ? undecided(preview, resolutions) : [];
  const redo = preview?.kind === 'redo';
  const multiRoot = (preview?.roots.length ?? 0) > 1;
  const nothing = counts !== null && counts.restore + counts.remove + counts.conflicts === 0;

  const choose = (rootId: string, path: string, value: VerseCheckpointResolution) => {
    setResolutions((prev) => ({ ...prev, [rootId]: { ...(prev[rootId] ?? {}), [path]: value } }));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      titleId={titleId}
      title={redo ? `Redo ${turnLabel}` : `Undo ${turnLabel}`}
      description={
        redo
          ? 'Puts back the files exactly as they were before the undo.'
          : 'Restores the files to the checkpoint taken before this turn (and undoes every turn after it). The current state is kept, so you can redo.'
      }
      initialFocusRef={confirmRef}
      widthClassName={styles.undoDialog}
    >
      {!preview || !counts ? null : (
        <div className={styles.undoBody}>
          <ul className={styles.facts} aria-label="What this will do">
            {counts.restore > 0 ? <li>Restores {plural(counts.restore, 'file')}.</li> : null}
            {counts.remove > 0 ? <li>Removes {plural(counts.remove, 'file')} the {redo ? 'undo' : 'agent'} created.</li> : null}
            {counts.conflicts > 0 ? (
              <li data-tone="warning">
                <strong>{plural(counts.conflicts, 'file')}</strong> changed again after the {redo ? 'undo' : 'agent'} — choose for each below.
              </li>
            ) : null}
            {counts.kept > 0 ? <li>Leaves {plural(counts.kept, 'file')} alone: only you changed {counts.kept === 1 ? 'it' : 'them'} since.</li> : null}
            {counts.uncaptured > 0 ? (
              <li data-tone="warning">{plural(counts.uncaptured, 'file')} {counts.uncaptured === 1 ? 'was' : 'were'} too large to checkpoint and will not be touched.</li>
            ) : null}
            {nothing ? <li>Nothing to restore: the files already match.</li> : null}
          </ul>

          {preview.roots.map((root) => {
            const name = rootNames[root.rootId] ?? 'repository';
            if (root.unavailable) {
              return (
                <p key={root.rootId} className={styles.rootNote} role="note">
                  <strong>{name}</strong>: {root.unavailable}
                </p>
              );
            }
            const empty = root.apply.length + root.conflicts.length + root.kept.length + root.uncaptured.length === 0;
            if (empty) return null;
            return (
              <section key={root.rootId} className={styles.undoRoot} aria-label={multiRoot ? name : undefined}>
                {multiRoot ? <h3 className={styles.undoRootName}>{name}</h3> : null}
                {root.apply.length > 0 ? (
                  <details className={styles.undoList} open={root.apply.length <= 12}>
                    <summary>{plural(root.apply.length, 'file')} to {redo ? 'put back' : 'restore'}</summary>
                    <ul>
                      {root.apply.map((f) => (
                        <li key={f.path}>
                          <code>{f.path}</code>
                          {f.action === 'delete' ? <span className={styles.badge}>removed</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {root.conflicts.map((c) => (
                  <ConflictCard
                    key={c.path}
                    conflict={c}
                    value={resolutions[root.rootId]?.[c.path] ?? null}
                    onChoose={(v) => choose(root.rootId, c.path, v)}
                  />
                ))}
                {root.kept.length > 0 ? (
                  <details className={styles.undoList}>
                    <summary>{plural(root.kept.length, 'file')} left as {root.kept.length === 1 ? 'is' : 'they are'}</summary>
                    <ul>{root.kept.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
                  </details>
                ) : null}
                {root.uncaptured.length > 0 ? (
                  <details className={styles.undoList}>
                    <summary>{plural(root.uncaptured.length, 'file')} not captured</summary>
                    <ul>{root.uncaptured.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
                  </details>
                ) : null}
              </section>
            );
          })}

          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          <div className={styles.dialogActions}>
            {missing.length > 0 ? (
              <span className={styles.hint} role="status">
                Choose what to do with {plural(missing.length, 'file')} first.
              </span>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              ref={confirmRef}
              variant={redo ? 'primary' : 'danger'}
              busy={busy}
              disabled={missing.length > 0 || nothing}
              onClick={() => onConfirm(resolutions)}
            >
              {redo ? 'Redo' : `Undo ${turnLabel.toLowerCase()}`}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ConflictCard({
  conflict,
  value,
  onChoose,
}: {
  conflict: VerseCheckpointPlanConflict;
  value: VerseCheckpointResolution | null;
  onChoose: (v: VerseCheckpointResolution) => void;
}) {
  const group = useId();
  const [view, setView] = useState<'merge' | 'diff'>(conflict.merge.text !== null ? 'merge' : 'diff');
  const why = conflict.kind === 'unverified'
    ? 'There is no after-turn checkpoint to tell the agent’s edits from later ones.'
    : conflict.merge.text === null
      ? 'Edited after the agent; a line merge is not possible here (binary, too large, or deleted on one side).'
      : conflict.merge.clean
        ? 'Edited after the agent. The edits do not overlap, so both can be kept.'
        : `Edited after the agent, in the same lines (${plural(conflict.merge.conflicts, 'conflict')}).`;
  return (
    <fieldset className={styles.conflict} data-decided={value ? 'true' : undefined}>
      <legend className={styles.conflictPath}>
        <code>{conflict.path}</code>
        {conflict.action === 'delete' ? <span className={styles.badge}>the checkpoint has no such file</span> : null}
      </legend>
      <p className={styles.conflictWhy}>{why}</p>
      <div className={styles.conflictTabs} role="tablist" aria-label={`Preview for ${conflict.path}`}>
        {conflict.merge.text !== null ? (
          <button type="button" role="tab" aria-selected={view === 'merge'} className={styles.tab} onClick={() => setView('merge')}>
            {conflict.merge.clean ? 'Merged result' : 'Three-way (with markers)'}
          </button>
        ) : null}
        <button type="button" role="tab" aria-selected={view === 'diff'} className={styles.tab} onClick={() => setView('diff')}>
          Disk now → checkpoint
        </button>
      </div>
      <pre className={styles.conflictText} tabIndex={0} aria-label={view === 'merge' ? 'Merge preview' : 'Diff from the file on disk to the checkpoint'}>
        {view === 'merge' ? conflict.merge.text : conflict.diff || 'No text diff (binary file).'}
      </pre>
      <div className={styles.choices} role="radiogroup" aria-label={`What to do with ${conflict.path}`}>
        {CHOICES.map((c) => {
          const disabled = c.value === 'merge' && !conflict.merge.clean;
          return (
            <label key={c.value} className={styles.choice} data-disabled={disabled ? 'true' : undefined} title={c.hint}>
              <input
                type="radio"
                name={group}
                value={c.value}
                checked={value === c.value}
                disabled={disabled}
                onChange={() => onChoose(c.value)}
              />
              <span>{c.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
