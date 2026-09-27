/**
 * routes/verse/devin/DevinStopDialog.tsx — Stop in a Devin (cloud) chat (3.15).
 *
 * A Devin turn is Verse WATCHING a remote session; the work happens in
 * Devin's machine. So Stop asks which one is meant: stop watching (Devin
 * keeps working, the next message checks in) or terminate the session —
 * irreversible ("a terminated session cannot be resumed"), so it is the red
 * button and focus opens on Cancel. Lazy-loaded: never on first paint.
 */
import { useId, useRef } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import styles from './DevinStopDialog.module.css';

export interface DevinStopDialogProps {
  open: boolean;
  /** Chat title, for the sentence. */
  chatLabel: string;
  /** A turn is running (else only Terminate applies). */
  running: boolean;
  onCancel: () => void;
  onStopWatching: () => void;
  onTerminate: () => void;
}

export function DevinStopDialog({ open, chatLabel, running, onCancel, onStopWatching, onTerminate }: DevinStopDialogProps) {
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onClose={onCancel} titleId={titleId} title="Stop Devin?" initialFocusRef={cancel}
      description={<>Devin works in its own session for <strong>{chatLabel}</strong>. Stopping here can mean two things.</>}>
      <ul className={styles.list}>
        {running ? <li><strong>Stop watching</strong> — Devin keeps working; send a message later to check in.</li> : null}
        <li><strong>Terminate the session</strong> — Devin stops for good and the session can’t be resumed. A pull request it already opened stays open.</li>
      </ul>
      <div className={styles.actions}>
        <Button ref={cancel} variant="subtle" onClick={onCancel}>Cancel</Button>
        {running ? <Button variant="subtle" onClick={onStopWatching}>Stop watching</Button> : null}
        <Button variant="danger" onClick={onTerminate}>Terminate session</Button>
      </div>
    </Dialog>
  );
}
