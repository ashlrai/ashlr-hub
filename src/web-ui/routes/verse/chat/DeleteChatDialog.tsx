/**
 * routes/verse/chat/DeleteChatDialog.tsx — "Delete this chat?", the Chat
 * surface's one confirmation.
 *
 * Its own chunk, preloaded by sections/ChatSection.tsx: it draws nothing
 * until an operator asks to delete, and as part of ChatSection it kept the
 * button primitive in the chat first-paint critical JS for this dialog alone.
 * By the time anyone can click Delete the chunk is in, and it mounts in the
 * same render that opens it.
 */
import { useId, useState } from 'react';
import type { VerseSession } from '../../../data/api-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';

export interface DeleteChatDialogProps {
  /** The chat to delete; null keeps the dialog closed. */
  target: VerseSession | null;
  /** Keep, Escape, or done: the caller clears `target`. */
  onClose: () => void;
  /** Runs the delete (token guard included); the dialog stays busy until it settles. */
  onDelete: (id: string) => Promise<unknown>;
  /** The actions row's layout (the Chat surface's stylesheet owns it). */
  actionsClassName?: string;
}

export function DeleteChatDialog({ target, onClose, onDelete, actionsClassName }: DeleteChatDialogProps) {
  const titleId = useId();
  const [deleting, setDeleting] = useState(false);
  return (
    <Dialog open={target !== null} onClose={() => { if (!deleting) onClose(); }} titleId={titleId}
      title="Delete this chat?"
      description={target ? `“${target.title || 'Untitled chat'}” and its transcript are removed from this machine. This cannot be undone.` : undefined}>
      <div className={actionsClassName}>
        <Button variant="ghost" onClick={onClose} disabled={deleting}>Keep</Button>
        <Button variant="danger" busy={deleting} onClick={async () => {
          if (!target) return;
          setDeleting(true);
          try {
            await onDelete(target.id);
          } finally {
            setDeleting(false);
            onClose();
          }
        }}>Delete</Button>
      </div>
    </Dialog>
  );
}
