/**
 * routes/verse/composer/QueueRow.tsx — "Queued, sends when this turn ends
 * [Edit] [Send now] [×]" above the composer (SPEC-310C §2; unit C3).
 *
 * Hidden when empty. Two states, both said in words:
 *   - waiting: the follow-ups send one by one as each turn ends cleanly;
 *   - HELD: the last turn failed or was stopped, so nothing is sent blind —
 *     the row says why and [Send now] is the way on.
 *
 * Edit pulls the text back into the composer (and off the queue), so a
 * follow-up can be reworded after reading the reply it was waiting for.
 */
import { IconX } from '../../../components/primitives/icons.js';
import type { VerseQueueResponse } from '../../../../core/verse/workbench-types.js';
import styles from './composer.module.css';

export interface QueueRowProps {
  queue: VerseQueueResponse | null;
  running: boolean;
  disabled?: boolean;
  onEdit: (queueId: string, text: string) => void;
  onSendNow: (queueId: string) => void;
  onRemove: (queueId: string) => void;
}

/** One line of the queued text, trimmed for the row (the full text is its title). */
function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function QueueRow({ queue, running, disabled = false, onEdit, onSendNow, onRemove }: QueueRowProps) {
  if (!queue || queue.items.length === 0) return null;
  const held = queue.held;
  const count = queue.items.length;
  const heading = held
    ? `Held — ${queue.heldReason ?? 'the last turn did not finish cleanly.'}`
    : running
      ? `Queued · sends when this turn ends`
      : `Queued · sending next`;
  return (
    <section className={`${styles.queue} ${held ? styles.queueHeld : ''}`} aria-label={`${count} queued follow-up${count === 1 ? '' : 's'}`}>
      <p className={styles.queueHeading} role="status">{heading}</p>
      <ol className={styles.queueList}>
        {queue.items.map((item, index) => (
          <li key={item.id} className={styles.queueItem}>
            <span className={styles.queueIndex} aria-hidden="true">{index + 1}</span>
            <span className={styles.queueText} title={item.text}>{preview(item.text)}</span>
            <span className={styles.queueActions}>
              <button type="button" className={styles.queueButton} disabled={disabled}
                aria-label={`Edit queued message ${index + 1}`} onClick={() => onEdit(item.id, item.text)}>Edit</button>
              <button type="button" className={`${styles.queueButton} ${styles.queueButtonPrimary}`} disabled={disabled}
                aria-label={running ? `Stop the turn and send queued message ${index + 1} now` : `Send queued message ${index + 1} now`}
                onClick={() => onSendNow(item.id)}>Send now</button>
              <button type="button" className={styles.queueRemove} disabled={disabled}
                aria-label={`Remove queued message ${index + 1}`} onClick={() => onRemove(item.id)}>
                <IconX width={12} height={12} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
