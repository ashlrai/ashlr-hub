/**
 * routes/verse/cloud/RunInCloudAction.tsx — "Run in cloud" in the composer's
 * ⋯ sheet (3.11 unit C3; lazy-loaded by composer/ControlsSheet.tsx the first
 * time the sheet opens, so none of this is chat first-paint).
 *
 * It launches the message typed in the box as a cloud task on the chat
 * project's GitHub origin, from the branch the chat is on. Both come from the
 * chat's roots read (chat/use-session-roots — the read behind the header's
 * `repo › branch` and the Branch bar), which is already in the cache when the
 * chat is open. After a launch the draft is cleared, a toast confirms it, and
 * the sheet shows the session link in place of the button.
 *
 * Disabled — with the reason as its tooltip AND as a line under it (a
 * disabled button takes no focus, so a keyboard user would never see the
 * tooltip) — when the project has no GitHub origin, the Claude seat is not
 * ready, the budget gate is closed, or the box is empty.
 */
import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { CloudTaskV1 } from '../../../../core/cloud/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useQuery } from '../../../data/hooks.js';
import { useSessionRoots } from '../chat/use-session-roots.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { useVerseUi } from '../useVerseUi.js';
import { getVerseSessionHead, subscribeVerseSession } from '../verse-store.js';
import { formatDollars, runInCloudBlock, safeHref } from './cloud-model.js';
import { cloudQuery, launchCloudTask } from './cloud-queries.js';
import { clearComposerDraft, readComposerDraft } from './composer-draft.js';
import styles from './cloud.module.css';

const NO_SUBSCRIPTION = () => () => {};

/** The shell's toast when there is one; tests and bare mounts have none, and a launch must not throw for want of it. */
function useOptionalToast(): ReturnType<typeof useToast> | null {
  try {
    return useToast();
  } catch {
    return null;
  }
}

export function RunInCloudAction({ root }: { root?: ParentNode } = {}) {
  const { activeSessionId } = useVerseUi();
  const head = useSyncExternalStore(
    useCallback((listener: () => void) => (activeSessionId ? subscribeVerseSession(activeSessionId, listener) : NO_SUBSCRIPTION()), [activeSessionId]),
    () => getVerseSessionHead(activeSessionId),
    () => getVerseSessionHead(activeSessionId),
  );
  const roots = useSessionRoots(head.session);
  const read = useQuery(cloudQuery, { freshMs: 15_000 });
  const gate = useTokenGate();
  const toast = useOptionalToast();
  // The sheet is modal, so the box cannot change while it is open: one read
  // once mounted (after commit, never during render) is the draft this
  // button launches — and it is re-read on press anyway.
  const [prompt, setPrompt] = useState('');
  useLayoutEffect(() => setPrompt(readComposerDraft(root)), [root]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<CloudTaskV1 | null>(null);

  const primary = roots.data?.roots.find((r) => r.primary) ?? roots.data?.roots[0] ?? null;
  const repo = primary?.git?.remote ?? null;
  const branch = primary?.git?.branch ?? null;
  const overview = read.data?.value ?? null;
  const block = runInCloudBlock({
    overview,
    overviewReason: read.data ? read.data.reason : 'Reading the cloud lane…',
    repo,
    rootsLoading: head.session !== null && roots.data === null && roots.error === null,
    prompt,
  });
  const estimate = overview?.budget.budget.estimatedCostPerSessionUsd ?? null;

  const launch = async () => {
    const text = readComposerDraft(root).trim() || prompt.trim();
    if (!repo || !text) return;
    setBusy(true);
    setError(null);
    try {
      const response = await gate.run('Run this message as a Claude Code cloud session on your Claude account.', () =>
        launchCloudTask({ repo, ...(branch ? { baseBranch: branch } : {}), prompt: text, origin: 'chat' }),
      );
      if (response === null) return; // the unlock dialog was dismissed: nothing was sent
      clearComposerDraft(root);
      setLaunched(response.task);
      const link = safeHref(response.task.sessionUrl, 'claude.ai');
      toast?.show(`Cloud task started: ${response.task.title}.${link ? ` ${link}` : ''}`, 'success');
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setBusy(false);
    }
  };

  const session = launched ? safeHref(launched.sessionUrl, 'claude.ai') : null;
  return (
    <div className={styles.sheetAction}>
      {launched ? (
        <p className={styles.notice} data-tone="success" role="status">
          Started “{launched.title}” in the cloud. The draft was cleared.{' '}
          {session ? (
            <a className={styles.link} href={session} target="_blank" rel="noreferrer noopener">
              Open in Claude <IconExternalLink width={12} height={12} aria-hidden="true" />
            </a>
          ) : (
            'Its session link appears on Command once the session is created.'
          )}
        </p>
      ) : (
        <>
          <Tooltip label={block ?? `Launch this message as a cloud session on ${repo}${branch ? ` from ${branch}` : ''}`}>
            <Button block disabled={block !== null} busy={busy} onClick={() => void launch()}>
              Run in cloud
            </Button>
          </Tooltip>
          <p className={styles.muted}>
            {block ??
              `Runs on ${repo} from ${branch ?? 'its default branch'} as a Claude Code cloud session and delivers a draft PR.${estimate !== null ? ` Estimated at ${formatDollars(estimate)}.` : ''}`}
          </p>
        </>
      )}
      {error ? <p className={styles.notice} data-tone="danger" role="alert">{error}</p> : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </div>
  );
}
