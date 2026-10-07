/**
 * routes/verse/multimodel/LocalSeatBadge.tsx — what a local model IS, where a
 * seat is chosen (the new-chat dialog): runs on this Mac and stays private,
 * its context window, its measured speed, and Warm up (load it now so the
 * first turn does not pay the cold start). Also says when the chosen folder
 * is a local-only repo, so a remote seat is not picked for it by habit.
 *
 * Lazy: only rendered when a local seat is chosen or the repo is local-only.
 */
import { useState } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { formatTokens } from '../verse-readouts.js';
import { multimodelContextQuery, warmLocalSeat } from './multimodel-queries.js';
import { localSpeedReadout, localWarmReadout } from './local-speed-readout.js';
import styles from './multimodel.module.css';

export function LocalSeatBadge({ seatId, projectPath }: { seatId: string | null; projectPath: string | null }) {
  const context = useQuery(multimodelContextQuery({ projectPath })).data ?? null;
  const [state, setState] = useState<{ busy: boolean; text: string | null; error: boolean }>({ busy: false, text: null, error: false });
  const badge = seatId ? context?.local.find((b) => b.seatId === seatId) ?? null : null;
  const localOnly = context?.localOnly.on === true;
  if (!badge && !localOnly) return null;

  async function warm(id: string) {
    setState({ busy: true, text: null, error: false });
    try {
      const r = await warmLocalSeat(id);
      setState({ busy: false, error: !r.ok, text: r.ok ? localWarmReadout(r) : r.error ?? 'Could not warm it.' });
    } catch (err) {
      setState({ busy: false, error: true, text: err instanceof Error ? err.message : 'Could not warm it.' });
    }
  }

  return (
    <div className={styles.bar} role="group" aria-label="Local model">
      {localOnly ? (
        <span className={`${styles.chip} ${styles.chipWarn}`} title={context?.localOnly.reason ?? undefined}>
          Local-only repo — Auto keeps it on local models
        </span>
      ) : null}
      {badge ? (
        <>
          <span className={`${styles.chip} ${badge.private ? styles.chipPrivate : ''}`}>
            {badge.private ? 'Runs on this Mac — private' : 'Local runtime (not loopback)'}
          </span>
          {badge.contextWindow ? <span className={styles.meter}>{formatTokens(badge.contextWindow)} context</span> : null}
          <span className={styles.meter}>
            {localSpeedReadout(badge, context?.sampledAt ?? '')}
          </span>
          <button type="button" className={styles.chip} disabled={state.busy} onClick={() => { void warm(badge.seatId); }}>
            {state.busy ? 'Warming…' : 'Warm up'}
          </button>
        </>
      ) : null}
      {state.text ? <span className={`${styles.notice} ${state.error ? styles.noticeError : ''}`} role={state.error ? 'alert' : 'status'}>{state.text}</span> : null}
    </div>
  );
}

export default LocalSeatBadge;
