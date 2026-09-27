/**
 * routes/verse/mobile/screens/HomeSeats.tsx — Home's seat meters: every seat
 * the Mac has (Claude, both Codex accounts, Grok, Devin, local models) plus
 * Claude cloud credits. A chunk of its own, below the fold, so the meters'
 * models never weigh on the first paint.
 *
 * Each meter is the workbench's own reading (seat-subscription.ts): the
 * BINDING window — the one that actually stops work — with the provider's
 * reset text. A seat with no reading shows "unknown", never an empty 0%;
 * a local model shows readiness, never a quota it does not have.
 */
import { useQuery } from '../../../../data/hooks.js';
import { cloudCreditsQuery } from '../../resources/resources-queries.js';
import { seatSubscription } from '../../seat-subscription.js';
import { useSeatsRefresh } from '../../useSeatsRefresh.js';
import { verseBootstrapQuery } from '../../verse-bootstrap-query.js';
import type { VerseSeat } from '../../../../data/api-types.js';
import { SkeletonList } from '../ui.js';
import { Meter, Section, ui } from '../ui-parts.js';
import styles from './HomeScreen.module.css';

const ENGINE_ORDER = ['claude', 'codex', 'grok', 'devin', 'local'] as const;

export function orderSeats(seats: readonly VerseSeat[]): VerseSeat[] {
  const rank = (s: VerseSeat) => {
    const i = (ENGINE_ORDER as readonly string[]).indexOf(s.engine);
    return i === -1 ? ENGINE_ORDER.length : i;
  };
  return [...seats].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

function SeatMeter({ seat }: { seat: VerseSeat }) {
  const view = seatSubscription(seat);
  if (view.kind === 'local') {
    return <Meter label={seat.label} percent={null} valueText={view.word} note={view.summary} />;
  }
  const binding = view.binding;
  const valueText = binding === null
    ? view.word
    : binding.limitReached
      ? 'limit reached'
      : binding.usedPercent === null ? 'unknown' : `${Math.round(binding.usedPercent)}% used`;
  const noteParts = [binding ? `${binding.label} window` : null, binding?.resetText ? `resets ${binding.resetText}` : null, view.credits].filter(Boolean);
  return (
    <Meter
      label={`${seat.label}${view.plan ? ` · ${view.plan}` : ''}`}
      percent={binding?.limitReached ? 100 : binding?.usedPercent ?? null}
      valueText={valueText}
      note={noteParts.length > 0 ? noteParts.join(' · ') : view.summary}
    />
  );
}

export function HomeSeats() {
  useSeatsRefresh(true);
  const bootstrap = useQuery(verseBootstrapQuery);
  const cloud = useQuery(cloudCreditsQuery);
  const seats = bootstrap.data ? orderSeats(bootstrap.data.seats) : null;
  const credits = cloud.data?.credits ?? null;

  return (
    <Section title="Seats" flat>
      {seats === null ? (
        <SkeletonList rows={3} label="Loading seats" />
      ) : (
        <div className={`${ui.card} ${styles.seats}`}>
          {seats.length === 0 ? <p className={ui.muted}>No seats are configured on your Mac.</p> : null}
          {seats.map((seat) => <SeatMeter key={seat.id} seat={seat} />)}
          {credits ? (
            <Meter
              label="Cloud credits"
              percent={100 - credits.remainingPercent}
              valueText={`$${credits.remainingUsd.toFixed(2)} left`}
              note={`${credits.running} running · ${credits.sessionsToday} today`}
            />
          ) : cloud.data && !cloud.data.available ? null : cloud.status === 'loading' ? (
            <Meter label="Cloud credits" percent={null} valueText="…" />
          ) : null}
        </div>
      )}
    </Section>
  );
}
