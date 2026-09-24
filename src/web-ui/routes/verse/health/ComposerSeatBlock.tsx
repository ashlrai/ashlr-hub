/**
 * routes/verse/health/ComposerSeatBlock.tsx — the Composer's "this seat can't
 * run a turn" block (V3.10, unit A2; mounted by the Composer's owner, A6).
 *
 * The session engine refuses a turn on a signed-out or exhausted seat with a
 * 409 (`getSeatReadiness`, core/verse/seats.ts). This block says so BEFORE
 * the operator types a message into a dead end: the reason, the reset time
 * when there is one, Reconnect for a signed-out seat, and the ranked
 * alternatives — computed by the SAME function the engine uses
 * (core/verse/seat-readiness.ts), so the block never offers a seat the server
 * would then refuse.
 *
 * Sessions are seat-bound, so an alternative starts a NEW chat on that seat —
 * the same action as the Composer seat menu's "New chat on …" (`onSeatChange`).
 *
 * Renders nothing while the seat is ready.
 */
import { useState } from 'react';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import { rankSeatAlternatives, seatBlock } from '../../../../core/verse/seat-readiness.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import type { VerseSeat } from '../../../data/api-types.js';
import type { SeatChoice } from '../SeatSelector.js';
import { firstRunnableModel } from '../verse-model.js';
import { reconnectSeat } from './health-queries.js';
import { useSeatHealth } from './useSeatHealth.js';
import styles from './SeatHealth.module.css';

/** At most this many alternatives are offered inline. */
const INLINE_ALTERNATIVES = 3;

export interface ComposerSeatBlockViewProps {
  seats: readonly VerseSeat[];
  /** The seat this chat is bound to. */
  seatId: string;
  reports?: readonly SeatHealthReport[] | null;
  /** Start a new chat on another seat (Composer's `onSeatChange`). */
  onSeatChange: (choice: SeatChoice) => void;
  onReconnect?: (seatId: string) => Promise<void>;
  now?: number;
}

export function ComposerSeatBlockView({
  seats,
  seatId,
  reports = null,
  onSeatChange,
  onReconnect = reconnectSeat,
  now = Date.now(),
}: ComposerSeatBlockViewProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const seat = seats.find((candidate) => candidate.id === seatId) ?? null;
  if (seat === null) return null;
  const report = reports?.find((candidate) => candidate.seatId === seatId) ?? null;
  const block = seatBlock(seat, report, now);
  if (block === null) return null;

  const alternatives = rankSeatAlternatives(seatId, seats, reports, now)
    .map((id) => seats.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is VerseSeat => candidate !== undefined)
    .slice(0, INLINE_ALTERNATIVES);

  const reconnect = async (): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await onReconnect(seatId);
      setStatus({ text: 'Sign-in opened in Terminal. Send again once you have finished there.', error: false });
    } catch (error) {
      setStatus({ text: error instanceof Error && error.message ? error.message : 'The sign-in window could not be opened.', error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.block} role="alert" data-connection={block.connection}>
      <p className={styles.blockReason}>{block.reason}</p>
      <div className={styles.alternatives}>
        {block.connection === 'signed-out' ? (
          <Button size="sm" variant="primary" icon={<IconExternalLink />} busy={busy} onClick={() => { void reconnect(); }}>
            Reconnect {seat.label}
          </Button>
        ) : null}
        {alternatives.length > 0 ? (
          <>
            <span className={styles.alternativesLabel}>Continue in a new chat on</span>
            {alternatives.map((alternative) => {
              const model = firstRunnableModel(alternative);
              if (model === null) return null;
              return (
                <Button key={alternative.id} size="sm" variant="subtle"
                  onClick={() => onSeatChange({ seatId: alternative.id, model: model.id })}>
                  {alternative.label}
                </Button>
              );
            })}
          </>
        ) : (
          <span className={styles.alternativesLabel}>No other seat is ready right now.</span>
        )}
      </div>
      {status === null ? null : (
        <p className={styles.status} aria-live="polite" data-error={status.error ? 'true' : undefined}>{status.text}</p>
      )}
    </div>
  );
}

export type ComposerSeatBlockProps = Omit<ComposerSeatBlockViewProps, 'reports' | 'now'> & {
  /** False stops polling health (the seat's own capacity still decides). Default true. */
  active?: boolean;
};

/** Self-fetching: reads the live health reports (polled every 30 s while visible). */
export function ComposerSeatBlock({ active = true, ...props }: ComposerSeatBlockProps) {
  const health = useSeatHealth(active);
  return <ComposerSeatBlockView {...props} reports={health.data?.seats ?? null} />;
}
