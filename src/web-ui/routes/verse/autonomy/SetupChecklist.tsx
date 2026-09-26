/**
 * routes/verse/autonomy/SetupChecklist.tsx — the live `ashlr authority setup`
 * checklist inside the "Autonomy is off" state and onboarding step 4.
 *
 *   NEXT  GitHub App   Browser · GitHub
 *   The ashlr-fleet key is in custody, but the App is not installed on …
 *   [ $ ashlr authority setup                                  ⧉ Copy ]
 *   Open the install page ↗
 *   ▸ 6 of 15 ready  ✓✓✓✓✓✓●○○○○○○○×
 *       ✓ Custody helper
 *       ● GitHub App                Browser · GitHub
 *       ○ Claude token              Terminal
 *       × Resident runtime          blocked   Terminal
 *
 * The next step leads, with what it needs from you and the one action (the
 * caller's: a copyable command, or Approve grant). The full list folds away
 * under its count so the state stays one calm card. Loaded lazily — it is
 * never on the chat first-paint path. Decisions live in
 * setup-checklist-model.ts.
 */
import type { ReactNode } from 'react';
import type { AuthoritySetupReportV1 } from '../../../../core/authority/types.js';
import { IconCheck, IconX } from '../../../components/primitives/icons.js';
import { detailParts, nextRow, safeSetupLink, setupProgress, setupRows, type SetupRow, type SetupRowMark } from './setup-checklist-model.js';
import styles from './setup-checklist.module.css';

const MARK_WORD: Readonly<Record<SetupRowMark, string>> = Object.freeze({
  done: 'done',
  next: 'next',
  todo: 'to do',
  blocked: 'blocked',
  failed: 'failed',
});

function Needs({ needs }: { needs: SetupRow['needs'] }) {
  if (needs.length === 0) return null;
  return (
    <span className={styles.needs} aria-label={`Needs ${needs.map((n) => n.label).join(', ')}`}>
      {needs.map((n) => (
        <span key={n.id} className={styles.need} data-need={n.id}>
          {n.label}
        </span>
      ))}
    </span>
  );
}

function Mark({ mark }: { mark: SetupRowMark }) {
  return (
    <span className={styles.mark} data-mark={mark} aria-hidden="true">
      {mark === 'done' ? <IconCheck size={10} strokeWidth={2.5} /> : mark === 'blocked' || mark === 'failed' ? <IconX size={10} strokeWidth={2.5} /> : null}
    </span>
  );
}

function linkLabel(row: SetupRow): string {
  if (row.id === 'github-app') return 'Open the install page';
  if (row.id === 'trust-root') return 'Open the pull request';
  return 'Open on GitHub';
}

export interface SetupChecklistProps {
  report: AuthoritySetupReportV1;
  /** The one action for the next step (a copyable command, Approve grant…), rendered right under it. */
  action?: ReactNode;
  /** Show every step unfolded (onboarding); the "off" state keeps them folded under the count. */
  open?: boolean;
}

export function SetupChecklist({ report, action = null, open = false }: SetupChecklistProps) {
  const rows = setupRows(report);
  const next = nextRow(report);
  const { ready, total } = setupProgress(report);
  const link = next ? safeSetupLink(next.link) : null;
  return (
    <div className={styles.checklist} data-testid="setup-checklist">
      {next ? (
        <div className={styles.next} data-mark={next.mark}>
          <div className={styles.nextHead}>
            <span className={styles.nextLabel}>{next.mark === 'failed' ? 'Failed' : next.mark === 'blocked' ? 'Blocked' : 'Next'}</span>
            <span className={styles.nextTitle}>{next.label}</span>
            <Needs needs={next.needs} />
          </div>
          <p className={styles.nextDetail}>
            {detailParts(next.detail).map((part, i) => (part.code ? <code key={i} className={styles.inlineCode}>{part.text}</code> : <span key={i}>{part.text}</span>))}
          </p>
        </div>
      ) : null}
      {action}
      {next && link ? (
        <a className={styles.link} href={link} target="_blank" rel="noreferrer noopener">
          {linkLabel(next)} ↗
        </a>
      ) : null}
      <details className={styles.all} open={open || undefined}>
        <summary className={styles.summary}>
          <span className={styles.count}>
            {ready} of {total} ready
          </span>
          <span className={styles.pips} aria-hidden="true">
            {rows.map((row) => (
              <span key={row.id} className={styles.pip} data-mark={row.mark} />
            ))}
          </span>
        </summary>
        <ol className={styles.steps} aria-label={`Setup: ${ready} of ${total} ready`}>
          {rows.map((row) => (
            <li key={row.id} className={styles.step} data-mark={row.mark} aria-current={row.mark === 'next' ? 'step' : undefined}>
              <Mark mark={row.mark} />
              <span className={styles.stepLabel}>{row.label}</span>
              {row.mark === 'blocked' ? <span className={styles.stepNote}>blocked</span> : null}
              {row.mark !== 'done' ? <Needs needs={row.needs} /> : null}
              {row.mark === 'blocked' ? null : <span className={styles.visuallyHidden}>{` — ${MARK_WORD[row.mark]}`}</span>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

export default SetupChecklist;
