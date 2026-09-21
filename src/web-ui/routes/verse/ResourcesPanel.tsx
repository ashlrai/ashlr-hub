/**
 * routes/verse/ResourcesPanel.tsx — the right column: every seat with its
 * subscription and how much of it is left, the local Ollama runtime, running
 * sessions with elapsed time + Stop, and the current session's cumulative
 * token usage.
 *
 * WHAT CHANGED AND WHY (docs/VERSE-TELEMETRY-V2.md).
 *
 * This list is the most-looked-at surface in the app and it showed a bare
 * "unknown" pill for every account — the health state, and nothing else. Two
 * separate faults produced that, and both are answered here:
 *
 *  1. THE WRONG FACT WAS BEING SHOWN. `health.state` is `unknown` for Claude
 *     BY CONSTRUCTION, and the shared-evidence file behind it is scoped
 *     `codex-native-metadata`, so it structurally cannot carry Claude or Grok
 *     at all. Meanwhile the windows underneath it were rendered as raw ids
 *     ("seven_day_fable") with a homemade 2px bar, all three of Claude's
 *     windows given equal weight, and a reset collapsed to a bare clock time
 *     even though Claude publishes a SENTENCE and no timestamp. So every row
 *     now leads with the seat's plan and its BINDING window — the one that
 *     actually blocks work — as a labelled <Meter>, with the reset rendered
 *     verbatim and the other windows one disclosure away rather than a
 *     navigation away.
 *  2. THE DATA NEVER REFRESHED. `bootstrap` is a mount-time snapshot with no
 *     SSE invalidation, and the collector needs ~75s to warm. Opening the app
 *     cold guaranteed "unknown" forever. The chat surfaces now poll
 *     (useSeatsRefresh), and this panel additionally says WHEN the reading
 *     was taken and offers an explicit Refresh — because a number with no
 *     timestamp is a claim about the present that nobody checked.
 *
 * Local seats are deliberately NOT given this treatment: they have no
 * subscription, no quota and no bill. They get their readiness and their
 * model, and nothing that implies a meter exists.
 */
import { useEffect, useState } from 'react';
import type { VerseBootstrap, VerseSeat, VerseSession } from '../../data/api-types.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { useQuery, useRefresh } from '../../data/hooks.js';
import { CapacityChip, SeatWindowMeter } from './SeatCapacity.js';
import { evidenceNote, seatSubscription, seatSubscriptionSentence } from './seat-subscription.js';
import { ENGINE_LABEL, formatClock, formatElapsed, groupSeats, projectName } from './verse-model.js';
import { verseBootstrapQuery } from './verse-queries.js';
import { formatTokens } from './verse-store.js';
import styles from './ResourcesPanel.module.css';

export interface ResourcesPanelProps {
  bootstrap: VerseBootstrap | undefined;
  sessions: readonly VerseSession[];
  current: VerseSession | null;
  onStop: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onClose: () => void;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * The newest instant any seat was actually observed at. NOT the time of the
 * last HTTP read: a successful request for a stale collector reading would
 * otherwise stamp old numbers as fresh, which is the one thing a freshness
 * line exists to prevent.
 */
function newestObservation(seats: readonly VerseSeat[]): string | null {
  let newest: string | null = null;
  for (const seat of seats) {
    const at = seatSubscription(seat).observedAt;
    if (at === null) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

function SeatRow({ seat }: { seat: VerseSeat }) {
  const view = seatSubscription(seat);
  const sentence = seatSubscriptionSentence(seat, view);
  const ctx = seat.contextWindow === null ? 'ctx n/a' : `${formatTokens(seat.contextWindow)} ctx`;
  const models = `${seat.models.length} model${seat.models.length === 1 ? '' : 's'}`;
  // Provenance is a note too: a reading served from another process's shared
  // file is not a live probe and must not be presented as one.
  const provenance = evidenceNote(view.evidenceSource);
  const notes = provenance === null ? view.notes : [...view.notes, provenance];

  return (
    <li className={`${styles.seat} ${styles[`engine-${seat.engine}`] ?? ''}`} data-engine={seat.engine}
      data-capacity={view.cls}>
      <div className={styles.seatHead}>
        <span className={styles.seatLabel} title={sentence}>{seat.label}</span>
        {view.kind === 'local'
          ? <StatusBadge status={seat.health.state} tone={seat.health.state === 'ready' ? 'success' : seat.health.state === 'unavailable' ? 'danger' : 'unknown'} />
          : <CapacityChip view={view} title={sentence} />}
      </div>

      <div className={styles.seatMeta}>
        <span>{ENGINE_LABEL[seat.engine]}</span>
        {view.plan === null ? null : <><span aria-hidden="true">·</span><span className={styles.plan}>{view.plan}</span></>}
        <span aria-hidden="true">·</span>
        <span>{models}</span>
        <span aria-hidden="true">·</span>
        <span className={styles.num}>{ctx}</span>
      </div>

      {view.kind === 'local' ? (
        // No subscription, no quota, no bill — say that, rather than leaving
        // a gap where a meter would be on every other row.
        <p className={styles.seatSummary}>{view.summary}</p>
      ) : view.binding === null ? (
        // Nothing to meter. Say so, and hand over whatever the provider DID
        // say, rather than drawing an empty bar that would read "plenty left".
        <>
          <p className={styles.seatSummary}>{view.summary}</p>
          {seat.health.summary === null || seat.health.summary === view.summary
            ? null
            : <p className={styles.seatSummary}>{seat.health.summary}</p>}
        </>
      ) : (
        <div className={styles.seatWindows}>
          <SeatWindowMeter windowView={view.binding} ariaPrefix={seat.label} prominent />
          {view.others.length === 0 ? null : (
            <details className={styles.more}>
              <summary className={styles.moreSummary}>
                {view.others.length} more window{view.others.length === 1 ? '' : 's'}
              </summary>
              <ul className={styles.windows}>
                {view.others.map((w) => (
                  <li key={w.id}><SeatWindowMeter windowView={w} ariaPrefix={seat.label} /></li>
                ))}
              </ul>
            </details>
          )}
          {view.credits === null ? null : (
            // Two distinct facts: a spent window with a spendable balance is
            // not a blocked account (docs/VERSE-TELEMETRY-V2.md, Codex).
            <p className={styles.credits} title={view.creditsTitle ?? undefined}>{view.credits}</p>
          )}
        </div>
      )}

      {/* The provider's own plain-language facts. Owner S's contract requires
          these be SHOWN — a version-pinned probe or a paused collector is an
          explanation, and swallowing it is what made every row read "unknown"
          with no way to find out why. */}
      {notes.length === 0 ? null : (
        <ul className={styles.notes}>
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </li>
  );
}

export function ResourcesPanel({ bootstrap, sessions, current, onStop, onOpen, onClose }: ResourcesPanelProps) {
  const running = sessions.filter((s) => s.status === 'running');
  const now = useNow(running.length > 0);
  const groups = bootstrap ? groupSeats(bootstrap.seats) : [];
  const local = bootstrap?.localRuntime.ollama;

  // Subscribed only for the refreshing/settled signal — ChatSection owns the
  // data and passes it in. Same cache key, so this costs no extra request.
  const live = useQuery(verseBootstrapQuery);
  const refresh = useRefresh(verseBootstrapQuery);
  const observedAt = bootstrap ? newestObservation(bootstrap.seats) : null;
  const observedClock = observedAt === null ? null : formatClock(observedAt);

  return (
    <aside className={styles.panel} aria-label="Resources">
      <header className={styles.head}>
        <h2 className={styles.title}>Resources</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Hide resources">×</button>
      </header>
      <div className={styles.scroll}>
        <section className={styles.section} aria-labelledby="verse-res-seats">
          <h3 id="verse-res-seats" className={styles.sectionTitle}>
            <span>Seats</span>
            {/* A reading with no timestamp is a claim about the present that
                nobody checked. Say when, or say that nothing was read. */}
            <span className={styles.asOf}>
              {observedClock === null ? 'no reading yet' : `as of ${observedClock}`}
            </span>
            {live.status === 'refreshing' ? <RefreshIndicator label="Refreshing seats" /> : null}
            <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
          </h3>
          {!bootstrap ? <div className={styles.skeleton}><SkeletonLine width="70%" /><SkeletonLine width="50%" /><SkeletonLine width="64%" /></div>
            : groups.length === 0 ? <p className={styles.muted}>No seats discovered. Connect an account with <code>ashlr accounts</code> or start Ollama.</p>
              : groups.map((group) => (
                <div key={group.engine} className={styles.engineGroup}>
                  <h4 className={styles.engineTitle}>{ENGINE_LABEL[group.engine]}</h4>
                  <ul className={styles.seatList}>{group.seats.map((seat) => <SeatRow key={seat.id} seat={seat} />)}</ul>
                </div>
              ))}
        </section>

        <section className={styles.section} aria-labelledby="verse-res-local">
          <h3 id="verse-res-local" className={styles.sectionTitle}>Local runtime</h3>
          {!local ? <SkeletonLine width="60%" /> : (
            <div className={styles.local}>
              <div className={styles.seatHead}>
                <span className={styles.seatLabel}>Ollama</span>
                <StatusBadge status={local.reachable ? 'ready' : 'unavailable'} tone={local.reachable ? 'success' : 'danger'}>
                  {local.reachable ? 'reachable' : 'unreachable'}
                </StatusBadge>
              </div>
              <p className={styles.mono} title={local.baseUrl}>{local.baseUrl}</p>
              {local.reachable ? (
                local.models.length > 0
                  ? <ul className={styles.models}>{local.models.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
                  : <p className={styles.muted}>No models pulled yet.</p>
              ) : <p className={styles.muted}>Start Ollama to enable local seats.</p>}
            </div>
          )}
        </section>

        <section className={styles.section} aria-labelledby="verse-res-running">
          <h3 id="verse-res-running" className={styles.sectionTitle}>Running <span className={styles.count}>{running.length}</span></h3>
          {running.length === 0 ? <p className={styles.muted}>Nothing running.</p> : (
            <ul className={styles.runningList}>
              {running.map((s) => (
                <li key={s.id} className={styles.runningRow}>
                  <button type="button" className={styles.runningOpen} onClick={() => onOpen(s.id)} title={s.title}>
                    <span className={styles.runningDot} role="img" aria-label="Running" />
                    <span className={styles.runningTitle}>{s.title || 'Untitled chat'}</span>
                    <span className={styles.runningMeta}>{projectName(s.projectPath, bootstrap?.projects ?? [])} · {formatElapsed(now - new Date(s.updatedAt).getTime())}</span>
                  </button>
                  <button type="button" className={styles.stop} onClick={() => onStop(s.id)} aria-label={`Stop ${s.title || 'chat'}`}>Stop</button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="verse-res-usage">
          <h3 id="verse-res-usage" className={styles.sectionTitle}>This chat</h3>
          {!current ? <p className={styles.muted}>Select a chat to see its usage.</p> : (
            <dl className={styles.usage}>
              <div><dt>Input</dt><dd>{formatTokens(current.usage.inputTokens)}</dd></div>
              <div><dt>Output</dt><dd>{formatTokens(current.usage.outputTokens)}</dd></div>
              <div><dt>Cache read</dt><dd>{formatTokens(current.usage.cacheReadTokens)}</dd></div>
              <div><dt>Cache write</dt><dd>{formatTokens(current.usage.cacheCreationTokens)}</dd></div>
              <div><dt>Turns</dt><dd>{current.turnCount}</dd></div>
              <div><dt>Context</dt><dd>{formatTokens(current.usage.contextTokens)}{current.usage.contextWindow ? ` / ${formatTokens(current.usage.contextWindow)}` : ''}</dd></div>
            </dl>
          )}
        </section>
      </div>
    </aside>
  );
}
