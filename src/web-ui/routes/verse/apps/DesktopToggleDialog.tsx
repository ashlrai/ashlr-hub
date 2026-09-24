/**
 * routes/verse/apps/DesktopToggleDialog.tsx — the confirmation in front of a
 * desktop switch (SPEC-310C §4: "Turning either on needs a confirmation that
 * shows the command and --restore").
 *
 * These switches change ANOTHER app's settings (Claude Desktop, Hermes
 * Desktop), so the dialog shows exactly what will run and exactly how to undo
 * it, and says where it runs: a Terminal window, where the tool's own prompts
 * are answered by the operator — Verse never answers them. Turning Claude
 * Desktop ON carries the recommendation against it (SPEC-310C §0.5).
 */
import { useId, useRef } from 'react';
import type { VerseAppRow } from '../../../../core/verse/workbench-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { commandText } from './launch.js';
import { CopyPill } from './CopyPill.js';
import styles from './Apps.module.css';

export function DesktopToggleDialog({
  row,
  enable,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  row: VerseAppRow | null;
  /** The direction asked for: true = switch on, false = restore. */
  enable: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (row === null || row.toggle === null) return null;
  const run = enable ? row.toggle.command : row.toggle.restoreCommand;
  const undo = enable ? row.toggle.restoreCommand : row.toggle.command;
  const title = enable ? `Turn on “${row.description}”?` : `Restore ${row.name}?`;
  return (
    <Dialog
      open
      onClose={onCancel}
      titleId={titleId}
      title={title}
      initialFocusRef={cancelRef}
      description={enable ? `This changes ${row.name}’s own settings until you restore it.` : `This puts ${row.name} back on its own defaults.`}
    >
      <div className={styles.dialogBody}>
        {row.detail ? <p>{row.detail}</p> : null}
        {enable && row.id === 'claude-desktop' ? (
          <p>
            Recommended: leave this off. Claude Desktop would run local models instead of its own, and Verse’s local
            seats already use Ollama.
          </p>
        ) : null}
        <div className={styles.commandBlock}>
          <span className={styles.commandLabel}>Runs</span>
          <CopyPill text={commandText(run)} what="the command this runs" />
        </div>
        <div className={styles.commandBlock}>
          <span className={styles.commandLabel}>{enable ? 'Undo later with' : 'Turn back on with'}</span>
          <CopyPill text={commandText(undo)} what={enable ? 'the restore command' : 'the command that turns it on'} />
        </div>
        <p>
          It opens in a Terminal window so you can answer its prompts. Verse does not answer them for you, and nothing
          changes until you do.
        </p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.dialogActions}>
          <Button ref={cancelRef} variant="subtle" onClick={onCancel}>Cancel</Button>
          <Button variant={enable ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
            {enable ? 'Open in Terminal' : 'Restore in Terminal'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
