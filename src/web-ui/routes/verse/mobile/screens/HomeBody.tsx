/**
 * routes/verse/mobile/screens/HomeBody.tsx — Home's cards: is the fleet
 * moving (and the one button that matters), what is waiting on you, who is
 * working right now, what today cost, and how much each seat has left.
 *
 * Reads, all shared with the workbench (same cache keys, so the Mac's own
 * views and this screen never disagree):
 *   activity   the shell's loop (useMobile().activity) — needs-you, running, autonomy badge
 *   control    GET /api/verse/control — daemon, pause, kill switch, today's spend
 *   fleet live GET /api/verse/fleet/live — the fleet's state and reason
 *   seats      the bootstrap's seats (HomeSeats, a chunk of its own)
 *
 * A preloaded chunk of its own (HomeScreen.tsx): the frame paints at once
 * over skeletons in these cards' shape, and these arrive a beat later, the
 * same arrangement the workbench's Chat section uses for its workspace.
 *
 * Unknown is shown as unknown: a figure the Mac did not report is "—", never 0.
 */
import { lazy, Suspense, useCallback } from 'react';
import { refetchQuery } from '../../../../data/cache.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { verseControlQuery } from '../../autonomy/control-queries.js';
import { fleetLiveQuery } from '../../command/surface-data.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { verseBootstrapQuery } from '../../verse-bootstrap-query.js';
import { runFleetAction } from '../fleet-actions.js';
import { fleetStateView, type FleetHeadline } from '../fleet-state.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { Button, SkeletonList } from '../ui.js';
import { Badge, Row, Section, ui, type Tone } from '../ui-parts.js';
import styles from './HomeScreen.module.css';

const HomeSeats = lazy(() => import('./HomeSeats.js').then((m) => ({ default: m.HomeSeats })));

export const HOME_POLL_MS = 15_000;

const HEADLINE_TONE: Readonly<Record<FleetHeadline, Tone>> = {
  running: 'running',
  paused: 'warning',
  stopped: 'neutral',
  blocked: 'danger',
  unknown: 'neutral',
};

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

/** "3m", "1h 12m" — how long a run has been going. */
export function elapsedText(startedAt: string | null, now: number = Date.now()): string | null {
  const t = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Pull-to-refresh on Home: every read the cards show, forced fresh. */
export function refreshHome(): Promise<unknown> {
  return Promise.all([
    refetchQuery(verseControlQuery.key, () => verseControlQuery.fetch(), true),
    refetchQuery(fleetLiveQuery.key, () => fleetLiveQuery.fetch(), true),
    refetchQuery(verseBootstrapQuery.key, () => verseBootstrapQuery.fetch(), true),
  ]);
}

function Stat({ label, value, hint, onClick, tone }: { label: string; value: string; hint?: string; onClick?: () => void; tone?: 'alert' }) {
  const body = (
    <>
      <span className={styles.statValue} data-tone={tone}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </>
  );
  return onClick ? (
    <button type="button" className={styles.stat} onClick={onClick}>{body}</button>
  ) : (
    <div className={styles.stat}>{body}</div>
  );
}

export function HomeBody() {
  const { activity, permissions, navigate, needsCount } = useMobile();
  const control = useQuery(verseControlQuery);
  const live = useQuery(fleetLiveQuery);
  const refetchControl = useRefetch(verseControlQuery);
  const refetchLive = useRefetch(fleetLiveQuery);
  const poll = useCallback(() => {
    refetchControl();
    refetchLive();
  }, [refetchControl, refetchLive]);
  usePollWhileVisible(poll, HOME_POLL_MS);

  const data = activity.data;
  const fleet = fleetStateView({
    control: control.data ?? null,
    live: live.data?.value ?? null,
    badge: data?.autonomy ?? null,
  });
  const fleetLoading = (control.status === 'loading' || live.status === 'loading') && fleet.headline === 'unknown';
  const running = data?.running ?? [];
  const spend = control.data?.spend;
  const canAct = canShowActions(permissions);
  const action = fleet.action;
  const showAction = action !== null && (action.kind === 'open-fleet' || canAct);

  return (
    <>
      <section className={`${ui.card} ${styles.fleet}`} aria-label="Fleet">
        <div className={ui.spread}>
          <span className={styles.fleetTitle}>Fleet</span>
          {fleetLoading ? (
            <span className={`skeleton ${styles.badgeSkeleton}`} aria-hidden="true" />
          ) : (
            <Badge tone={HEADLINE_TONE[fleet.headline]} dot pulse={fleet.headline === 'running' && (fleet.building ?? 0) > 0}>{fleet.label}</Badge>
          )}
        </div>
        <p className={styles.fleetDetail}>{fleetLoading ? 'Checking the fleet…' : fleet.detail}</p>
        {showAction && action ? (
          action.kind === 'open-fleet' ? (
            <Button variant="tinted" block onClick={() => navigate({ screen: 'fleet' })}>{action.label}</Button>
          ) : (
            <Button variant={action.destructive ? 'destructiveTinted' : 'tinted'} block onClick={() => runFleetAction(action)}>{action.label}</Button>
          )
        ) : null}
      </section>

      <div className={styles.stats}>
        <Stat
          label="Needs you"
          value={needsCount === null ? '—' : String(needsCount)}
          tone={needsCount ? 'alert' : undefined}
          onClick={() => navigate({ screen: 'needs' })}
        />
        <Stat label="Working" value={data ? String(data.counts.running) : '—'} onClick={() => navigate({ screen: 'agents' })} />
        <Stat
          label="Spent today"
          value={formatUsd(spend?.todayUsd)}
          hint={spend && spend.dailyBudgetUsd > 0 ? `of ${formatUsd(spend.dailyBudgetUsd)}` : undefined}
        />
      </div>

      <Section title="Working now" trailing={running.length > 0 ? <button type="button" className={`${ui.btn} ${ui.plain}`} onClick={() => navigate({ screen: 'agents' })}>All</button> : undefined}>
        {activity.status === 'loading' || activity.status === 'idle' ? (
          <SkeletonList rows={2} label="Loading running agents" />
        ) : running.length === 0 ? (
          <Row title="No agent is running" subtitle={canAct ? 'Start one with + above.' : 'Agents you start on your Mac show here.'} />
        ) : (
          running.slice(0, 5).map((r) => {
            const doing = r.live?.tool ? `Using ${r.live.tool}` : r.live?.phase ? r.live.phase : 'Working';
            const elapsed = elapsedText(r.startedAt);
            return (
              <Row
                key={r.sessionId}
                title={r.title || 'Untitled chat'}
                subtitle={`${r.engine} · ${doing}`}
                trailing={elapsed ?? undefined}
                onClick={() => navigate({ screen: 'agent', id: r.sessionId, pane: 'transcript' })}
              />
            );
          })
        )}
      </Section>

      <Suspense fallback={<Section title="Seats" flat><SkeletonList rows={3} label="Loading seats" /></Section>}>
        <HomeSeats />
      </Suspense>
    </>
  );
}
