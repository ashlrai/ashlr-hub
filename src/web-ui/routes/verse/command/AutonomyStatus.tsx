/**
 * routes/verse/command/AutonomyStatus.tsx — what the ACTIVE fleet is doing
 * on its rollout ladder, on Command (3.14). It stands where the "Autonomy is
 * off" banner stands while autonomy is off, under the top bar (whose switch
 * and Stop it does not repeat):
 *
 *   AUTONOMY  Shadow · 1 of 8   ● Autonomous          Grant 23 d left
 *   [Shadow][2a][2b][2c][3a][3b][3c][3d]      ← hover / focus: who merges, caps, exit
 *   Would-merge digests 2 / 5 ▓▓░░░   Hours in stage 3.5 h / 12 h ▓░░   Next: 2a lets …
 *   Last  Would merge ashlrcode #12 — every gate passed. · 2 h ago     All decisions →
 *
 * Every number is the server's (authority/rollout.ts evaluates the criteria;
 * core/verse/autonomy-ladder.ts shapes the ladder). Under 7 days the grant
 * line offers Re-approve, which opens the bar's ONE Touch ID sheet.
 *
 * LAZY: CommandSection loads this with React.lazy, only while a grant is
 * active — none of it is on the chat first-paint path.
 */
import { useId, useMemo } from 'react';
import type { AuthorityStatusV1 } from '../../../../core/authority/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Meter } from '../../../components/primitives/Meter.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { SWITCH_LABEL } from './authority-model.js';
import { ago, grantExpiry, ladderView, lastEvent, narrowLadder, type RungView } from './ladder-model.js';
import { DECISIONS_POLL_MS, decisionsQuery } from './ladder-queries.js';
import { goToSection } from './nav.js';
import { ChipDot } from './AutonomyBar.js';
import styles from './autonomy-ladder.module.css';

export interface AutonomyStatusProps {
  status: AuthorityStatusV1;
  now: number;
  /** Opens the bar's Touch ID sheet with the re-approve intent. */
  onReapprove: (why: string) => void;
  /** Read-only session or another action in flight: Re-approve is disabled, with this reason. */
  blocked: string | null;
}

function Rung({ rung }: { rung: RungView }) {
  return (
    <li className={styles.rungItem}>
      <Tooltip
        placement="bottom"
        content={
          <span className={styles.rungTip}>
            <strong>{rung.label}</strong>
            <span>{rung.mergeLine}</span>
            {rung.proposeLine ? <span>{rung.proposeLine}</span> : null}
            <span>{rung.capLine}</span>
            <span>{rung.exitLine}</span>
          </span>
        }
      >
        <span className={styles.rung} data-state={rung.state} tabIndex={0} aria-label={rung.aria} aria-current={rung.state === 'current' ? 'step' : undefined}>
          {rung.label}
        </span>
      </Tooltip>
    </li>
  );
}

function switchWord(status: AuthorityStatusV1): { text: string; tone: 'success' | 'neutral' | 'danger' | 'warning' } {
  if (status.kill) return { text: 'Stopped', tone: 'danger' };
  if (status.effectiveSwitch === 'autonomous') return { text: SWITCH_LABEL.autonomous, tone: 'success' };
  if (status.effectiveSwitch === 'propose') return { text: 'Propose only', tone: 'neutral' };
  return { text: 'Off', tone: 'warning' };
}

export function AutonomyStatus({ status, now, onReapprove, blocked }: AutonomyStatusProps) {
  const titleId = useId();
  const view = useMemo(() => ladderView(status), [status]);
  const ladder = useMemo(() => narrowLadder(status), [status]);
  const decisions = useQuery(decisionsQuery, { freshMs: 15_000 });
  const refetch = useRefetch(decisionsQuery);
  usePollWhileVisible(refetch, DECISIONS_POLL_MS, { enabled: view !== null });
  if (!view) return null;

  const expiry = grantExpiry(status, now);
  const sw = switchWord(status);
  const last = lastEvent(ladder, decisions.data ? decisions.data.value : undefined);
  const held = status.effectiveSwitch !== status.switch && status.effectiveReason ? status.effectiveReason : null;
  const reapproveWhy = expiry ? `The standing grant has ${expiry.text.replace(/ left$/, '')} left. Re-approving continues the ladder from ${view.stageName}.` : '';

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <header className={styles.head}>
        <span id={titleId} className={styles.micro}>Autonomy</span>
        <span className={styles.stage}>
          {view.stageName} <span className={styles.position}>· {view.position}</span>
        </span>
        <span className={styles.switchState} data-tone={sw.tone} title={held ?? undefined}>
          <ChipDot tone={sw.tone} />
          {sw.text}
          {held ? <span className={styles.held}> — {held.replace(/[.]$/, '')}</span> : null}
        </span>
        <span className={styles.spacer} />
        {expiry ? (
          <span className={styles.grant} data-tone={expiry.tone} title={`Grant active until ${expiry.until}`}>
            Grant {expiry.text}
            {expiry.warn ? (
              <Button
                size="sm"
                variant={expiry.tone === 'danger' ? 'primary' : 'subtle'}
                disabled={blocked !== null}
                title={blocked ?? undefined}
                onClick={() => onReapprove(reapproveWhy)}
              >
                Re-approve
              </Button>
            ) : null}
          </span>
        ) : null}
      </header>

      <ol className={styles.ladder} aria-label={`Rollout ladder: stage ${view.position}`}>
        {view.rungs.map((r) => <Rung key={r.id} rung={r} />)}
      </ol>

      <div className={styles.progress}>
        {view.nextStageName ? (
          <>
            {view.bars.map((bar) => (
              <Meter
                key={bar.key}
                className={styles.meter}
                value={bar.value}
                max={bar.max}
                label={bar.label}
                valueText={bar.text}
                tone={bar.met ? 'running' : 'accent'}
                aria-label={`${bar.label}: ${bar.text}${bar.met ? ', met' : ''}`}
              />
            ))}
            <p className={styles.next}>
              {view.met ? `Every criterion met — ${view.nextStageName} on the next tick.` : view.nextLine ? `Next: ${view.nextLine}.` : `Next: ${view.nextStageName}.`}
              {view.otherUnmet.length > 0 ? <span className={styles.unmet}> Also waiting on {view.otherUnmet.join('; ')}.</span> : null}
            </p>
          </>
        ) : (
          <p className={styles.next}>Last signed stage — the ladder climbs no further under this grant.</p>
        )}
      </div>

      <p className={styles.last} data-tone={last.tone} role="status">
        <span className={styles.micro}>Last</span>
        <span className={styles.lastText}>
          {last.text}
          {last.at ? <span className={styles.when}> · {ago(last.at, now)}</span> : null}
        </span>
        <button type="button" className={styles.linkButton} onClick={() => goToSection('fleet', 'shadow-decisions')}>
          All decisions →
        </button>
      </p>
    </section>
  );
}

export default AutonomyStatus;
