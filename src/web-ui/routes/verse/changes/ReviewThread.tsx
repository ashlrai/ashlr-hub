/**
 * routes/verse/changes/ReviewThread.tsx — the inline pieces of review
 * comments in the Changes pane (3.15): a thread of drafted comments on one
 * line or hunk (each editable and deletable until sent), and the comment
 * editor. HunkPatch places them in the patch grid; review-comments.ts holds
 * the anchors, the messages and the draft store.
 *
 * Styles are the Review pane's comment styles (../git/DiffPane.module.css),
 * so a comment looks the same in both panes.
 *
 * KEYBOARD. In the editor ⌘/Ctrl+Enter saves and Escape cancels; focus goes
 * back to whatever opened it. Every action is a labelled button.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { anchorWhere, COMMENT_MAX_CHARS, type ReviewComment } from './review-comments.js';
import review from '../git/DiffPane.module.css';
import styles from './ChangesPanel.module.css';

export interface CommentEditorProps {
  /** The visible label of the text box ("Comment on line 42"). */
  label: string;
  initial?: string;
  submitLabel: string;
  /** Rendered above the text box (the line picker). */
  picker?: ReactNode;
  onSave: (body: string) => void;
  onCancel: () => void;
}

export function CommentEditor({ label, initial = '', submitLabel, picker, onSave, onCancel }: CommentEditorProps) {
  const [body, setBody] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  // Where focus was when the editor opened, so closing it returns there.
  const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const restore = () => {
    const el = opener.current;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  };
  const save = () => {
    const text = body.trim();
    if (!text) return;
    onSave(text);
    restore();
  };
  const cancel = () => {
    onCancel();
    restore();
  };

  return (
    <div className={`${review.editor} ${styles.commentEditor}`}>
      {picker}
      <label htmlFor={id} className={review.editorLabel}>{label}</label>
      <textarea
        id={id}
        ref={ref}
        className={review.editorInput}
        rows={2}
        value={body}
        maxLength={COMMENT_MAX_CHARS}
        placeholder="What should change here?"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
      />
      <div className={review.editorActions}>
        <span className={review.editorHint}>⌘Enter saves · Esc cancels · drafts are kept until you send them</span>
        <button type="button" className={review.linkButton} onClick={cancel}>Cancel</button>
        <button type="button" className={review.saveButton} onClick={save} disabled={!body.trim()}>{submitLabel}</button>
      </div>
    </div>
  );
}

export interface ThreadActions {
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  /** Add another comment on the same anchor. */
  onReply: (head: ReviewComment) => void;
}

/** One anchor's comments, oldest first. */
export function ReviewThread({ path, comments, actions, replying }: { path: string; comments: readonly ReviewComment[]; actions: ThreadActions; replying: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const head = comments[0];
  if (!head) return null;
  const where = anchorWhere(head);
  return (
    <div className={styles.thread} role="group" aria-label={`Review comments on ${where} of ${path}`}>
      {comments.map((c, i) => (
        editing === c.id ? (
          <CommentEditor
            key={c.id}
            label={`Edit the comment on ${where.toLowerCase()}`}
            initial={c.body}
            submitLabel="Save"
            onCancel={() => setEditing(null)}
            onSave={(body) => {
              actions.onEdit(c.id, body);
              setEditing(null);
            }}
          />
        ) : (
          <div key={c.id} className={`${review.comment} ${styles.threadComment}`}>
            <span className={review.commentWhere}>{i === 0 ? where : 'Reply'}</span>
            <p className={review.commentText}>{c.body}</p>
            <span className={styles.commentActions}>
              <button type="button" className={review.linkButton} onClick={() => setEditing(c.id)}
                aria-label={`Edit the comment on ${where.toLowerCase()} of ${path}`}>Edit</button>
              <button type="button" className={review.linkButton} data-tone="danger" onClick={() => actions.onDelete(c.id)}
                aria-label={`Delete the comment on ${where.toLowerCase()} of ${path}`}>Delete</button>
            </span>
          </div>
        )
      ))}
      {!replying && editing === null ? (
        <button type="button" className={`${review.linkButton} ${styles.replyButton}`} onClick={() => actions.onReply(head)}
          aria-label={`Add another comment on ${where.toLowerCase()} of ${path}`}>Add a comment</button>
      ) : null}
    </div>
  );
}
