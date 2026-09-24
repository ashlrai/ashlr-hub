/**
 * routes/verse/git/GitDialogs.tsx — Commit, Create PR and Merge, each a
 * short dialog that says exactly what the click will do BEFORE it happens
 * (unit C5; the before-click disclosure pattern of github-proposal.ts,
 * SPEC-310C research r5/panes.md §3).
 *
 * Push has no dialog: it never forces, it only publishes commits the operator
 * already made, and the button's own description says where they go.
 *
 * Keys: ⌘/Ctrl+Enter submits from any field; Escape closes (Dialog). The
 * submit button stays disabled while a request runs, so a double press is one
 * action — the server would refuse the second with a 409 anyway.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { defaultPrTitle, diffstatText, formatCount, type GitStatusView } from './git-model.js';
import styles from './GitDialogs.module.css';

interface BaseProps {
  open: boolean;
  status: GitStatusView;
  onClose: () => void;
  /** The server's refusal, shown in the dialog so the operator can fix and retry. */
  error: string | null;
  busy: boolean;
}

/** ⌘Enter / Ctrl+Enter from any field in the form submits it. */
function submitOnModEnter(e: ReactKeyboardEvent<HTMLFormElement>): void {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.currentTarget.requestSubmit();
  }
}

function Facts({ children }: { children: ReactNode }) {
  return <ul className={styles.facts}>{children}</ul>;
}

function Fact({ tone = 'neutral', children }: { tone?: 'neutral' | 'warning'; children: ReactNode }) {
  return (
    <li className={styles.fact} data-tone={tone}>
      {tone === 'warning' ? <span className={styles.factWord}>Note</span> : null}
      <span>{children}</span>
    </li>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className={styles.error}>
      {error}
    </p>
  );
}

function Branch({ name }: { name: string | null }) {
  return <code className={styles.ref}>{name ?? 'HEAD'}</code>;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitDialogProps extends BaseProps {
  onSubmit: (message: string) => void;
}

export function CommitDialog({ open, status, onClose, onSubmit, error, busy }: CommitDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const [message, setMessage] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) setMessage('');
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (message.trim() && !busy) onSubmit(message.trim());
  };

  return (
    <Dialog open={open} onClose={onClose} titleId={titleId} title="Commit changes" initialFocusRef={ref}>
      <form className={styles.form} onSubmit={submit} onKeyDown={submitOnModEnter}>
        <Facts>
          <Fact>
            {formatCount(status.dirty)} changed {status.dirty === 1 ? 'file' : 'files'} in <strong>{status.name}</strong> on <Branch name={status.branch} />, untracked files included.
          </Fact>
        </Facts>
        <label className={styles.label} htmlFor={messageId}>
          Message
        </label>
        <textarea
          id={messageId}
          ref={ref}
          className={styles.textarea}
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What changed, and why"
          maxLength={10_000}
          required
        />
        <p className={styles.hint}>
          Git hooks in this repository run as usual. <kbd>⌘</kbd>
          <kbd>Enter</kbd> commits.
        </p>
        <ErrorLine error={error} />
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!message.trim()}>
            Commit
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create PR
// ---------------------------------------------------------------------------

export interface CreatePrDialogProps extends BaseProps {
  /** Opened from "Create draft PR…". */
  draft: boolean;
  onSubmit: (req: { title: string; body: string; base: string; draft: boolean }) => void;
}

export function CreatePrDialog({ open, status, onClose, onSubmit, error, busy, draft: initialDraft }: CreatePrDialogProps) {
  const titleId = useId();
  const fieldTitle = useId();
  const fieldBody = useId();
  const fieldBase = useId();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(initialDraft);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(defaultPrTitle(status));
    setBody('');
    setBase(status.base ?? '');
    setDraft(initialDraft);
    // Seeded once per open: a background status refresh must not wipe what the operator typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const needsPush = status.upstream === null || status.ahead > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim() && base.trim() && !busy) onSubmit({ title: title.trim(), body, base: base.trim(), draft });
  };

  return (
    <Dialog open={open} onClose={onClose} titleId={titleId} title={draft ? 'Create draft pull request' : 'Create pull request'} initialFocusRef={ref}>
      <form className={styles.form} onSubmit={submit} onKeyDown={submitOnModEnter}>
        <Facts>
          {needsPush ? (
            <Fact>
              Pushes <Branch name={status.branch} /> to {status.upstream ?? 'origin'} first
              {status.upstream && status.ahead > 0 ? ` (${formatCount(status.ahead)} ${status.ahead === 1 ? 'commit' : 'commits'})` : ''}.
            </Fact>
          ) : null}
          <Fact>
            Then opens a PR from <Branch name={status.branch} /> into <Branch name={base.trim() || null} />:{' '}
            {formatCount(status.diffstat.files)} {status.diffstat.files === 1 ? 'file' : 'files'}, {diffstatText(status.diffstat.additions, status.diffstat.deletions)}.
          </Fact>
          {status.dirty > 0 ? (
            <Fact tone="warning">
              {formatCount(status.dirty)} uncommitted {status.dirty === 1 ? 'change is' : 'changes are'} not in the PR. Commit first to include {status.dirty === 1 ? 'it' : 'them'}.
            </Fact>
          ) : null}
        </Facts>
        <label className={styles.label} htmlFor={fieldTitle}>
          Title
        </label>
        <input id={fieldTitle} ref={ref} className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={256} required />
        <label className={styles.label} htmlFor={fieldBody}>
          Description <span className={styles.optional}>optional</span>
        </label>
        <textarea id={fieldBody} className={styles.textarea} rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={60_000} />
        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={fieldBase}>
              Base branch
            </label>
            <input
              id={fieldBase}
              className={`${styles.input} ${styles.mono}`}
              value={base}
              onChange={(e) => setBase(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              required
            />
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Draft
          </label>
        </div>
        <ErrorLine error={error} />
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!title.trim() || !base.trim()}>
            {draft ? 'Create draft PR' : 'Create PR'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergeDialogProps extends BaseProps {
  onSubmit: () => void;
}

export function MergeDialog({ open, status, onClose, onSubmit, error, busy }: MergeDialogProps) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const pr = status.pr;
  if (!pr) return null;
  const counts = status.prCheckCounts;
  const shortSha = pr.headSha ? pr.headSha.slice(0, 7) : '—';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      titleId={titleId}
      title={`Merge #${pr.number}?`}
      description={pr.title}
      initialFocusRef={confirmRef}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onSubmit();
        }}
        onKeyDown={submitOnModEnter}
      >
        <Facts>
          <Fact>
            Squash-merges <Branch name={pr.headRef || status.branch} /> into <Branch name={pr.baseRef || status.base} /> on GitHub.
          </Fact>
          <Fact>
            Head <code className={styles.ref}>{shortSha}</code>, {counts && counts.total > 0 ? `${counts.passed}/${counts.total} checks passed` : 'checks passed'}, no conflicts.
          </Fact>
          <Fact>GitHub re-checks the head first: if a commit landed after this, nothing merges. Admin overrides are never used.</Fact>
        </Facts>
        <ErrorLine error={error} />
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button ref={confirmRef} type="submit" variant="primary" busy={busy}>
            Merge #{pr.number}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
