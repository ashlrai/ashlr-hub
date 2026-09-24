/**
 * routes/verse/composer/AttachmentChips.tsx — thumbnail chips for the files
 * attached to the message being written (unit C3).
 *
 * An image shows its thumbnail (an object URL of the LOCAL file — the stored
 * copy is private and never served back to the page); anything else shows its
 * extension. Each chip says its state in words: uploading, attached (with
 * size), or why it failed. × removes the chip, the token in the text and the
 * stored copy.
 */
import { IconX } from '../../../components/primitives/icons.js';
import { formatBytes } from './composer-text.js';
import type { AttachmentDraft } from './useComposerData.js';
import styles from './composer.module.css';

export interface AttachmentChipsProps {
  drafts: readonly AttachmentDraft[];
  onRemove: (key: string) => void;
  disabled?: boolean;
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
}

export function AttachmentChips({ drafts, onRemove, disabled = false }: AttachmentChipsProps) {
  if (drafts.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label="Attachments">
      {drafts.map((draft) => {
        const state = draft.status === 'uploading'
          ? 'uploading'
          : draft.status === 'error'
            ? (draft.error ?? 'not attached')
            : formatBytes(draft.bytes);
        return (
          <li key={draft.key} className={styles.chip} data-status={draft.status}>
            {draft.previewUrl ? (
              <img className={styles.chipThumb} src={draft.previewUrl} alt="" />
            ) : (
              <span className={styles.chipExt} aria-hidden="true">{extension(draft.name)}</span>
            )}
            <span className={styles.chipText}>
              <span className={styles.chipName} title={draft.name}>{draft.name}</span>
              <span className={styles.chipMeta} role={draft.status === 'error' ? 'alert' : undefined}>
                {draft.status === 'uploading' ? <span className={styles.chipSpinner} aria-hidden="true" /> : null}
                {state}
              </span>
            </span>
            <button type="button" className={styles.chipRemove} disabled={disabled && draft.status !== 'error'}
              aria-label={`Remove ${draft.name}`} onClick={() => onRemove(draft.key)}>
              <IconX width={12} height={12} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
