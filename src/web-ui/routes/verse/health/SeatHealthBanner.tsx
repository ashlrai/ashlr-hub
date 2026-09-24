/**
 * routes/verse/health/SeatHealthBanner.tsx — "which of my seats can't work,
 * why, and what fixes it", in one strip (V3.10, unit A2).
 *
 * Renders NOTHING while every seat is fine: a banner that is always there is
 * a banner nobody reads. When something is wrong it names the seat, the fact
 * (signed out / out of usage / sign-in expiring / older CLI pinned), the
 * reset time when the provider gave one, and the one action that fixes it:
 *   - Reconnect (signed out, expiring) — the server opens the seat's OWN
 *     sign-in in Terminal. The app cannot and does not sign in for you.
 *   - the repin command, copyable (older CLI pinned) — repinning changes
 *     which models the seat runs, so it stays the operator's decision.
 *   - nothing but the reset time (out of usage).
 * "Check again" runs a sweep now (status commands only, zero cost).
 *
 * Two exports: `SeatHealthBanner` fetches and polls on its own;
 * `SeatHealthBannerView` renders reports it is handed (tests, or a parent
 * that already holds them).
 */
import { useState } from 'react';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconAlert, IconCopy, IconExternalLink, IconRefresh } from '../../../components/primitives/icons.js';
import type { VerseSeat } from '../../../data/api-types.js';
import { reconnectSeat, refreshSeatHealth } from './health-queries.js';
import { issuesHeadline, seatHealthIssues, shellCommandText, type SeatHealthIssue } from './health-model.js';
import { useSeatHealth } from './useSeatHealth.js';
import styles from './SeatHealth.module.css';

export interface SeatHealthBannerViewProps {
  reports: readonly SeatHealthReport[];
  /** For labels; a seat missing here is named by its id. */
  seats?: readonly VerseSeat[];
  onReconnect?: (seatId: string) => Promise<void>;
  onRefresh?: () => Promise<unknown>;
  /** Injected clock for tests. */
  now?: number;
}

type RowStatus = { text: string; error: boolean } | null;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function IssueRow({ issue, onReconnect }: { issue: SeatHealthIssue; onReconnect: (seatId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<RowStatus>(null);
  const { report } = issue;
  const command = report.fix.command && report.fix.command.length > 0 ? shellCommandText(report.fix.command) : null;

  const reconnect = async (): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await onReconnect(report.seatId);
      setStatus({ text: 'Sign-in opened in Terminal. Finish there, then choose Check again.', error: false });
    } catch (error) {
      setStatus({ text: errorText(error, 'The sign-in window could not be opened.'), error: true });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      setStatus({ text: 'Command copied.', error: false });
    } catch {
      setStatus({ text: 'Copy failed — select the command and copy it by hand.', error: true });
    }
  };

  return (
    <li className={styles.row} data-tone={issue.tone} data-seat={report.seatId}>
      <div className={styles.rowHead}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.label}>{issue.label}</span>
        <span className={styles.word}>{issue.word}</span>
        {issue.reset === null ? null : <span className={styles.reset}>{issue.reset}</span>}
      </div>
      {issue.detail === null ? null : <p className={styles.detail}>{issue.detail}</p>}
      {report.fix.kind === 'reauth' || command !== null ? (
        <div className={styles.actions}>
          {report.fix.kind === 'reauth' ? (
            <Button size="sm" variant="primary" icon={<IconExternalLink />} busy={busy} onClick={() => { void reconnect(); }}
              aria-label={`Reconnect ${issue.label}`}>
              Reconnect
            </Button>
          ) : null}
          {command !== null ? (
            <>
              <code className={styles.command}>{command}</code>
              <Button size="sm" variant="subtle" icon={<IconCopy />} onClick={() => { void copy(); }}
                aria-label={`Copy the repin command for ${issue.label}`}>
                Copy
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <p className={styles.status} aria-live="polite" data-error={status?.error ? 'true' : undefined}>
        {status?.text ?? ''}
      </p>
    </li>
  );
}

export function SeatHealthBannerView({
  reports,
  seats = [],
  onReconnect = reconnectSeat,
  onRefresh = refreshSeatHealth,
  now,
}: SeatHealthBannerViewProps) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const issues = seatHealthIssues(reports, seats, now);
  if (issues.length === 0) return null;
  const tone = issues[0]!.tone;

  const check = async (): Promise<void> => {
    setChecking(true);
    setCheckError(null);
    try {
      await onRefresh();
    } catch (error) {
      setCheckError(errorText(error, 'The check could not run.'));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className={styles.banner} data-tone={tone} aria-label="Seat health">
      <div className={styles.head}>
        <IconAlert />
        <span className={styles.headline}>{issuesHeadline(issues)}</span>
        <Button size="sm" variant="ghost" icon={<IconRefresh />} busy={checking} onClick={() => { void check(); }}>
          Check again
        </Button>
      </div>
      <ul className={styles.list}>
        {issues.map((issue) => <IssueRow key={issue.report.seatId} issue={issue} onReconnect={onReconnect} />)}
      </ul>
      {checkError === null ? null : <p className={styles.status} data-error="true" role="status">{checkError}</p>}
    </section>
  );
}

export interface SeatHealthBannerProps {
  seats?: readonly VerseSeat[];
  /** False stops polling (the last reading still renders). Default true. */
  active?: boolean;
}

/** Self-fetching banner: polls `/api/verse/health` every 30 s while visible. */
export function SeatHealthBanner({ seats = [], active = true }: SeatHealthBannerProps) {
  const health = useSeatHealth(active);
  const reports = health.data?.seats ?? [];
  return <SeatHealthBannerView reports={reports} seats={seats} />;
}
