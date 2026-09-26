/**
 * routes/verse/resources/CloudCredits.tsx — Claude cloud credits in the
 * Resources drawer (unit 3.11 C6): estimated remaining of the total, the
 * sessions running now and launched today, and the link to the real balance
 * on claude.ai. The balance is not readable programmatically (core/cloud
 * types.ts), so every figure is labelled an ESTIMATE, with the server's own
 * note beside it.
 *
 * GET /api/verse/cloud lands with another unit; until it does, this card says
 * "Cloud lane not available yet" — a designed state, not an error.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { usedPercentText } from '../percent-text.js';
import { approxCredits, CLOUD_NOT_SET_UP_WORD, notSetUpLine } from '../cloud/cloud-model.js';
import { formatUsd, type CloudCreditsView } from './resources-model.js';
import { cloudCreditsQuery, RESOURCES_POLL_MS } from './resources-queries.js';
import styles from './ResourcesDrawer.module.css';

/** Below this share of the total left, the meter turns amber. */
const LOW_AT = 20;

/**
 * The seat is missing, so nothing launches: the blocker is the state and the
 * credits a plain approximate figure — no "left" meter reading as headroom
 * (cloud/cloud-model.ts, "Standing").
 */
function NotSetUp({ credits, sessions }: { credits: CloudCreditsView; sessions: string }) {
  return (
    <>
      <p className={styles.status} data-tone="warning" title={notSetUpLine(credits.remainingUsd)}>
        <span className={styles.statusDot} aria-hidden="true" />
        <span className={styles.statusLabel}>{CLOUD_NOT_SET_UP_WORD}</span>
        <span className={styles.subtle}>· {approxCredits(credits.remainingUsd)}</span>
        <span className={styles.pill} data-tone="neutral" title={credits.estimateNote}>estimate</span>
      </p>
      <p className={styles.subtle}>{credits.seatReason ?? SEAT_NOT_SET_UP}</p>
      <p className={styles.subtle}>{sessions}</p>
    </>
  );
}

const SEAT_NOT_SET_UP = "The Claude seat isn't set up on this Mac.";

function Credits({ credits }: { credits: CloudCreditsView }) {
  const left = credits.remainingPercent;
  const level = left <= 0 ? 'limit' : left < LOW_AT ? 'tight' : 'ok';
  const headline = `${formatUsd(credits.remainingUsd)} of ${formatUsd(credits.totalUsd)} left`;
  const sessions = [
    `${credits.running} running`,
    credits.maxSessionsPerDay !== null ? `${credits.sessionsToday} of ${credits.maxSessionsPerDay} today` : `${credits.sessionsToday} today`,
  ].join(' · ');
  if (!credits.seatReady) {
    return (
      <>
        <NotSetUp credits={credits} sessions={sessions} />
        <p className={styles.fine}>{credits.estimateNote}</p>
        <BalanceLink href={credits.balanceUrl} />
      </>
    );
  }
  const blocker = !credits.canLaunch ? credits.canLaunchReason : null;
  return (
    <>
      <p className={styles.creditsHead}>
        <span className={styles.creditsAmount}>{headline}</span>
        <span className={styles.pill} data-tone="neutral" title={credits.estimateNote}>estimate</span>
      </p>
      <div className={styles.meter} data-level={level} data-single>
        <span
          className={styles.meterTrack}
          role="img"
          aria-label={`Cloud credits: an estimated ${formatUsd(credits.remainingUsd)} of ${formatUsd(credits.totalUsd)} left, ${usedPercentText(left)}`}
        >
          <span className={styles.meterFill} data-kind="left" style={{ width: `${Math.round(left)}%` }} />
        </span>
        <span className={styles.meterValue} aria-hidden="true">{usedPercentText(left)} left</span>
      </div>
      <p className={styles.subtle}>{sessions}</p>
      {blocker !== null ? (
        <p className={styles.status} data-tone="warning"><span className={styles.statusDot} aria-hidden="true" /><span>{blocker}</span></p>
      ) : null}
      <p className={styles.fine}>{credits.estimateNote}</p>
      <BalanceLink href={credits.balanceUrl} />
    </>
  );
}

function BalanceLink({ href }: { href: string }) {
  return (
    <a className={styles.external} href={href} target="_blank" rel="noopener noreferrer">
      Real balance on claude.ai
      <IconExternalLink />
      <span className={styles.visuallyHidden}> (opens in a new tab)</span>
    </a>
  );
}

export function CloudCredits() {
  const read = useQuery(cloudCreditsQuery);
  const refetch = useRefetch(cloudCreditsQuery);
  usePollWhileVisible(refetch, RESOURCES_POLL_MS.cloud);
  const loading = read.data === undefined && read.status !== 'error';
  const available = read.data?.available ?? false;
  const credits = read.data?.credits ?? null;
  return (
    <li className={styles.card} data-resource="cloud" data-cloud={loading ? 'loading' : !available ? 'unavailable' : credits ? 'ready' : 'unrecognised'}>
      <div className={styles.cardHead}>
        <MonogramTile monogram="C" engine="claude" size="sm" />
        <h4 className={styles.cardName}>
          <span>Claude cloud credits</span>
          <span className={styles.plan}>claude.ai</span>
        </h4>
      </div>
      {loading ? (
        <p className={styles.subtle} aria-busy="true">Reading cloud credits…</p>
      ) : !available ? (
        <>
          <p className={styles.status} data-tone="neutral">
            <span className={styles.statusDot} aria-hidden="true" />
            <span className={styles.statusLabel}>Cloud lane not available yet</span>
          </p>
          <p className={styles.fine}>Credits show here once this build has the cloud lane.</p>
        </>
      ) : credits === null ? (
        <p className={styles.subtle}>Unrecognized response — update Ashlr.</p>
      ) : (
        <Credits credits={credits} />
      )}
    </li>
  );
}
