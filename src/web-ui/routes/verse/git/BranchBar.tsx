/**
 * routes/verse/git/BranchBar.tsx — the row above the composer that turns a
 * chat's edits into a merged PR (unit C5; SPEC-310C §2 item 4):
 *
 *   ashlr-hub  v310-foundation  +35,079 −1,074  #463 · Open · 9/9 checks passed   [Merge ▾]
 *
 * Mounted by C2 through the `branch-bar` slot (shell/slots.tsx) with exactly
 * BranchBarProps. One row per REPOSITORY with something to do (two chat roots
 * inside one repo share a row), the first shown and the rest behind
 * "Show N more". Renders nothing at all when no root has changes — the space
 * above the composer is the chat's, not an empty toolbar's.
 *
 * The primary button is the server's `suggested` action (git-ops.ts
 * `suggestGitAction`: commit → push → create PR → merge → view), so the bar
 * never has to re-derive the ladder and can never offer Merge on a PR whose
 * checks the server has not seen pass. The ▾ menu holds the rest, each item
 * disabled WITH its reason rather than hidden.
 *
 * Every write goes through the mutation-token gate (the unlock dialog opens
 * with a sentence saying what the click will do) and answers with the fresh
 * status, which replaces the row — no refetch. Outcomes are announced in a
 * polite live region; failures in an alert, in the server's own words.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { useTokenGate } from '../context/use-token-gate.js';
import type { BranchBarProps, DiffPaneRequest } from '../shell/slots.js';
import { useViewport } from '../shell/viewport.js';
import { ActionMenu } from './ActionMenu.js';
import { CommitDialog, CreatePrDialog, MergeDialog } from './GitDialogs.js';
import {
  dedupeByRepo,
  describeGitError,
  diffstatLabel,
  formatCount,
  hasBranchActivity,
  menuItems,
  primaryAction,
  type GitStatusView,
  type MenuActionId,
} from './git-model.js';
import { commitGit, mergeGitPr, openGitPr, pushGit } from './git-queries.js';
import { PrChip } from './PrChip.js';
import { useGitStatuses, type GitStatusesOptions } from './useGitStatuses.js';
import styles from './BranchBar.module.css';

/** How long "Pushed feat/x to origin." stays before the line clears. */
const NOTICE_MS = 6_000;

type DialogState =
  | { kind: 'commit'; root: string }
  | { kind: 'pr'; root: string; draft: boolean }
  | { kind: 'merge'; root: string }
  | null;

export interface BranchBarTestProps {
  /** Test seam for the status reads. */
  statusOptions?: GitStatusesOptions;
}

export function BranchBar({ roots, onOpenDiff, statusOptions }: BranchBarProps & BranchBarTestProps) {
  const { statuses, replace } = useGitStatuses(roots, statusOptions);
  const { compact } = useViewport();
  const gate = useTokenGate();
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busyRoot, setBusyRoot] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const listId = useId();

  // A confirmation fades after a few seconds; an error stays until the next action.
  useEffect(() => {
    if (notice?.tone !== 'ok') return;
    const id = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

  const rows = dedupeByRepo(statuses).filter(hasBranchActivity);
  const statusFor = (root: string) => statuses.find((s) => s.root === root) ?? null;

  /**
   * Run one git write: token gate → request → swap in the answered status.
   * From a dialog, a refusal stays IN the dialog (the operator fixes and
   * retries); from a one-click action it goes to the bar's alert line.
   */
  const act = useCallback(
    async (root: string, reason: string, request: () => Promise<{ status: GitStatusView }>, done: (s: GitStatusView) => string, inDialog: boolean) => {
      setBusyRoot(root);
      setDialogError(null);
      setNotice(null);
      try {
        const result = await gate.run(reason, request);
        if (result === null) return; // unlock dismissed: nothing happened
        replace(root, result.status);
        setDialog(null);
        setNotice({ text: done(result.status), tone: 'ok' });
      } catch (err) {
        console.warn('[verse] git action failed', err);
        const text = describeGitError(err);
        if (inDialog) setDialogError(text);
        else setNotice({ text, tone: 'error' });
      } finally {
        setBusyRoot(null);
      }
    },
    [gate, replace],
  );

  const push = (s: GitStatusView) =>
    act(s.root, `Push ${s.branch ?? 'this branch'} to ${s.upstream ?? 'origin'}.`, () => pushGit(s.root), (next) => `Pushed ${next.branch ?? 'the branch'} to ${next.upstream ?? 'origin'}.`, false);

  const openDiff = (request: DiffPaneRequest) => onOpenDiff(request);

  const onPrimary = (s: GitStatusView) => {
    switch (s.suggested) {
      case 'commit':
        setDialogError(null);
        setDialog({ kind: 'commit', root: s.root });
        break;
      case 'push':
        void push(s);
        break;
      case 'create-pr':
        setDialogError(null);
        setDialog({ kind: 'pr', root: s.root, draft: false });
        break;
      case 'merge':
        setDialogError(null);
        setDialog({ kind: 'merge', root: s.root });
        break;
      case 'view-pr':
        if (s.pr) window.open(s.pr.url, '_blank', 'noopener,noreferrer');
        break;
      default:
        break;
    }
  };

  const onMenu = (s: GitStatusView, id: MenuActionId) => {
    switch (id) {
      case 'draft-pr':
        setDialogError(null);
        setDialog({ kind: 'pr', root: s.root, draft: true });
        break;
      case 'commit':
        setDialogError(null);
        setDialog({ kind: 'commit', root: s.root });
        break;
      case 'push':
        void push(s);
        break;
      case 'open-github':
        if (s.pr) window.open(s.pr.url, '_blank', 'noopener,noreferrer');
        break;
      case 'copy-branch':
        if (s.branch) {
          void navigator.clipboard?.writeText(s.branch).then(
            () => setNotice({ text: `Copied ${s.branch}.`, tone: 'ok' }),
            () => setNotice({ text: 'Could not copy the branch name.', tone: 'error' }),
          );
        }
        break;
      case 'review':
        openDiff({ root: s.root, scope: s.dirty > 0 && s.diffstat.files === 0 ? 'working' : 'branch' });
        break;
    }
  };

  if (rows.length === 0 && !notice) return null;

  const shown = expanded ? rows : rows.slice(0, 1);
  const hiddenCount = rows.length - shown.length;
  const dialogStatus = dialog ? statusFor(dialog.root) : null;

  return (
    <section className={styles.bar} aria-label="Branches" data-compact={compact ? 'true' : 'false'}>
      <ul id={listId} className={styles.rows}>
        {shown.map((s) => (
          <BranchRow
            key={s.gitRoot ?? s.root}
            status={s}
            compact={compact}
            busy={busyRoot === s.root}
            onPrimary={() => onPrimary(s)}
            onMenu={(id) => onMenu(s, id)}
            onOpenDiff={() => openDiff({ root: s.root, scope: 'branch' })}
          />
        ))}
      </ul>
      {rows.length > 1 ? (
        <button type="button" className={styles.more} aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show ${hiddenCount} more`}
        </button>
      ) : null}
      <p className={styles.notice} role={notice?.tone === 'error' ? 'alert' : 'status'} aria-live={notice?.tone === 'error' ? 'assertive' : 'polite'} data-tone={notice?.tone ?? 'ok'}>
        {notice?.text ?? ''}
      </p>

      {dialogStatus && dialog?.kind === 'commit' ? (
        <CommitDialog
          open
          status={dialogStatus}
          busy={busyRoot === dialog.root}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(message) =>
            void act(dialog.root, `Commit ${dialogStatus.dirty} changed files on ${dialogStatus.branch ?? 'this branch'}.`, () => commitGit({ root: dialog.root, message }), (next) => `Committed on ${next.branch ?? 'the branch'}.`, true)
          }
        />
      ) : null}
      {dialogStatus && dialog?.kind === 'pr' ? (
        <CreatePrDialog
          open
          draft={dialog.draft}
          status={dialogStatus}
          busy={busyRoot === dialog.root}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(req) =>
            void act(
              dialog.root,
              `Push ${dialogStatus.branch ?? 'this branch'} and open a pull request into ${req.base}.`,
              async () => {
                const res = await openGitPr({ root: dialog.root, title: req.title, base: req.base, ...(req.body.trim() ? { body: req.body } : {}), ...(req.draft ? { draft: true } : {}) });
                return { status: { ...res.status, pr: res.pr ?? res.status.pr } };
              },
              (next) => (next.pr ? `Opened #${next.pr.number}.` : 'Opened the pull request.'),
              true,
            )
          }
        />
      ) : null}
      {dialogStatus && dialog?.kind === 'merge' && dialogStatus.pr ? (
        <MergeDialog
          open
          status={dialogStatus}
          busy={busyRoot === dialog.root}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={() => {
            const pr = dialogStatus.pr!;
            void act(
              dialog.root,
              `Squash-merge #${pr.number} into ${pr.baseRef}.`,
              async () => {
                const res = await mergeGitPr({ root: dialog.root, number: pr.number, headSha: pr.headSha ?? '' });
                return { status: { ...res.status, pr: res.pr ?? res.status.pr } };
              },
              () => `Merged #${pr.number} into ${pr.baseRef}.`,
              true,
            );
          }}
        />
      ) : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </section>
  );
}

interface BranchRowProps {
  status: GitStatusView;
  compact: boolean;
  busy: boolean;
  onPrimary: () => void;
  onMenu: (id: MenuActionId) => void;
  onOpenDiff: () => void;
}

function BranchRow({ status: s, compact, busy, onPrimary, onMenu, onOpenDiff }: BranchRowProps) {
  const primary = primaryAction(s);
  const items = menuItems(s);
  const hasStat = s.diffstat.files > 0;
  const checking = s.pr === null && s.prLookup === 'pending' && s.branch !== null && s.suggested === 'none';
  return (
    <li className={styles.row} aria-label={`${s.name}, ${s.branch ? `branch ${s.branch}` : 'detached HEAD'}`}>
      <span className={styles.ident}>
        <BranchGlyph />
        <span className={styles.repo}>{s.name}</span>
        <span className={styles.branch} title={s.branch ?? undefined}>
          {s.branch ?? 'detached HEAD'}
        </span>
        {s.behind > 0 ? <span className={styles.drift}>{s.behind} behind</span> : null}
      </span>
      {hasStat ? (
        <button
          type="button"
          className={styles.stat}
          onClick={onOpenDiff}
          aria-label={`${diffstatLabel(s.diffstat.files, s.diffstat.additions, s.diffstat.deletions)}. Open the branch diff.`}
          title="Open the branch diff"
        >
          <span className={styles.add}>+{formatCount(s.diffstat.additions)}</span>
          <span className={styles.del}>{'\u2212'}{formatCount(s.diffstat.deletions)}</span>
        </button>
      ) : null}
      {s.pr ? <PrChip pr={s.pr} counts={s.prCheckCounts ?? null} showTitle={!compact} /> : null}
      {checking ? <span className={styles.checking}>Checking GitHub…</span> : null}
      {(s.conflicts ?? 0) > 0 ? <span className={styles.conflicts}>{s.conflicts} conflicted</span> : null}
      <span className={styles.spacer} />
      <ActionMenu
        primary={primary ? { label: primary.label, disclosure: primary.disclosure, onClick: onPrimary, busy, tone: primary.action === 'view-pr' ? 'subtle' : 'primary' } : null}
        items={items}
        onSelect={onMenu}
        menuLabel={`More git actions for ${s.name}`}
        disabled={busy}
      />
    </li>
  );
}

function BranchGlyph() {
  return (
    <svg className={styles.glyph} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.7" />
      <circle cx="4.5" cy="12.5" r="1.7" />
      <circle cx="11.5" cy="5" r="1.7" />
      <path d="M4.5 5.2v5.6M11.5 6.7c0 3-3.5 2.7-6.3 4.6" />
    </svg>
  );
}
