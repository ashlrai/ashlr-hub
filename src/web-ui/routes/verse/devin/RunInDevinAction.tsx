/**
 * routes/verse/devin/RunInDevinAction.tsx — "Run in Devin" in the composer's
 * ⋯ sheet, beside "Run in cloud" (3.15; lazy-loaded by
 * composer/ControlsSheet.tsx, never on the chat first-paint path).
 *
 * It launches the message in the box as a Devin session on the chat
 * project's GitHub origin. The session delivers a PR on `ashlr-devin/<id>`
 * against the repo's DEFAULT branch (the server resolves it), which then goes
 * through the standing gates — never merged by the fleet. After a launch the
 * draft is cleared and the session link replaces the button.
 *
 * Disabled — with the reason as tooltip AND as a line under it — when Devin
 * is not connected or turned off, the project has no GitHub origin, the ACU
 * budget refuses, or the box is empty.
 */
import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { DevinTaskV1 } from '../../../../core/devin/types.js';
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
import { clearComposerDraft, readComposerDraft } from '../cloud/composer-draft.js';
import styles from '../cloud/cloud.module.css';
import { formatAcu, runInDevinBlock, safeDevinHref } from './devin-model.js';
import { devinQuery, launchDevinTask } from './devin-queries.js';

const NO_SUBSCRIPTION = () => () => {};

function useOptionalToast(): ReturnType<typeof useToast> | null {
  try {
    return useToast();
  } catch {
    return null;
  }
}

export function RunInDevinAction({ root }: { root?: ParentNode } = {}) {
  const { activeSessionId } = useVerseUi();
  const head = useSyncExternalStore(
    useCallback((listener: () => void) => (activeSessionId ? subscribeVerseSession(activeSessionId, listener) : NO_SUBSCRIPTION()), [activeSessionId]),
    () => getVerseSessionHead(activeSessionId),
    () => getVerseSessionHead(activeSessionId),
  );
  const roots = useSessionRoots(head.session);
  const read = useQuery(devinQuery, { freshMs: 15_000 });
  const gate = useTokenGate();
  const toast = useOptionalToast();
  const [prompt, setPrompt] = useState('');
  useLayoutEffect(() => setPrompt(readComposerDraft(root)), [root]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<DevinTaskV1 | null>(null);

  const primary = roots.data?.roots.find((r) => r.primary) ?? roots.data?.roots[0] ?? null;
  const repo = primary?.git?.remote ?? null;
  const overview = read.data?.value ?? null;
  // A build without the lane renders nothing: "Run in cloud" is right above.
  if (read.data && !read.data.available) return null;
  const block = runInDevinBlock({
    overview,
    overviewReason: read.data ? read.data.reason : 'Reading the Devin lane…',
    repo,
    rootsLoading: head.session !== null && roots.data === null && roots.error === null,
    prompt,
  });
  const cap = overview?.budget.budget.maxAcuPerSession ?? null;

  const launch = async () => {
    const text = readComposerDraft(root).trim() || prompt.trim();
    if (!repo || !text) return;
    setBusy(true);
    setError(null);
    try {
      const response = await gate.run('Run this message as a Devin session (spends Devin ACUs).', () =>
        launchDevinTask({ repo, prompt: text, origin: 'chat' }),
      );
      if (response === null) return;
      clearComposerDraft(root);
      setLaunched(response.task);
      const link = safeDevinHref(response.task.sessionUrl, 'app.devin.ai');
      toast?.show(`Devin task started: ${response.task.title}.${link ? ` ${link}` : ''}`, 'success');
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setBusy(false);
    }
  };

  const session = launched ? safeDevinHref(launched.sessionUrl, 'app.devin.ai') : null;
  return (
    <div className={styles.sheetAction} data-lane="devin">
      {launched ? (
        <p className={styles.notice} data-tone="success" role="status">
          Started “{launched.title}” in Devin. The draft was cleared.{' '}
          {session ? (
            <a className={styles.link} href={session} target="_blank" rel="noreferrer noopener">
              Open in Devin <IconExternalLink width={12} height={12} aria-hidden="true" />
            </a>
          ) : null}
        </p>
      ) : (
        <>
          <Tooltip label={block ?? `Launch this message as a Devin session on ${repo}`}>
            <Button block disabled={block !== null} busy={busy} onClick={() => void launch()}>
              Run in Devin
            </Button>
          </Tooltip>
          <p className={styles.muted}>
            {block ??
              `Runs on ${repo} as a Devin session; its PR against the default branch goes through the standing gates (never auto-merged).${cap !== null ? ` Capped at ${formatAcu(cap)}.` : ''}`}
          </p>
        </>
      )}
      {error ? <p className={styles.notice} data-tone="danger" role="alert">{error}</p> : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </div>
  );
}
