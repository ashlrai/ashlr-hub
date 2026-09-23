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
 *     verbatim.
 *
 *  TWO FURTHER FACTS THE LIST WAS HIDING.
 *
 *  3. ONE BAR PER ACCOUNT. Claude's probe emits three windows — `five_hour`,
 *     `seven_day`, and a per-model `seven_day_{model}` (claude-account-usage.ts
 *     TITLES) — and Codex emits each bucket's primary and, only when the
 *     provider sent one, its secondary (provider-observations.ts), with
 *     credits as a separate fact. Folding the non-binding windows behind
 *     "N more windows" showed one bar per account. Each reported window is
 *     now its own bar with its own reset. A window that arrived without a
 *     percent says "no reading"; a window the probe did not emit is not
 *     drawn at all. Local seats still get no meter.
 *  4. SPENT SEATS START SHUT. A blocked seat (exhausted, or signed out)
 *     defaults collapsed, because that is the row the operator does not need
 *     open. Groups collapse too. Both choices persist under
 *     `ashlr.verse.resources.v1` — not the shell key, whose shape is pinned —
 *     so a refresh does not slam an opened spent seat shut again. `tight`
 *     stays open: a Codex week at its limit with spendable credits is still
 *     usable.
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
import type { VerseBootstrap, VerseEngine, VerseSeat, VerseSession } from '../../data/api-types.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { Tooltip } from '../../components/primitives/Tooltip.js';
import { useQuery, useRefresh } from '../../data/hooks.js';
import { CapacityChip, SeatWindowMeter } from './SeatCapacity.js';
import { SessionRoots } from './SessionRoots.js';
import {
  groupIsOpen,
  readResourcesCollapse,
  reportedLimitBars,
  seatIsOpen,
  toggleGroupCollapse,
  toggleSeatCollapse,
  writeResourcesCollapse,
  type ResourcesCollapseState,
} from './resources-collapse.js';
import { evidenceNote, seatSubscription, seatSubscriptionSentence, type SeatSubscriptionView } from './seat-subscription.js';
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

function useResourcesCollapse(): {
  state: ResourcesCollapseState;
  toggleGroup: (engine: VerseEngine) => void;
  toggleSeat: (seat: VerseSeat, view: SeatSubscriptionView) => void;
} {
  const [state, setState] = useState(readResourcesCollapse);
  // Functional update so two quick toggles cannot drop each other. Writing
  // here is idempotent: the same previous state always produces the same next.
  const update = (fn: (prev: ResourcesCollapseState) => ResourcesCollapseState): void => {
    setState((prev) => {
      const next = fn(prev);
      writeResourcesCollapse(next);
      return next;
    });
  };
  return {
    state,
    toggleGroup: (engine) => update((prev) => toggleGroupCollapse(prev, engine)),
    toggleSeat: (seat, view) => update((prev) => toggleSeatCollapse(prev, seat.id, view.cls)),
  };
}

function SeatDetails({ seat, view }: { seat: VerseSeat; view: SeatSubscriptionView }) {
  const bars = reportedLimitBars(view);
  const sentence = seatSubscriptionSentence(seat, view);
  const ctx = seat.contextWindow === null ? 'ctx n/a' : `${formatTokens(seat.contextWindow)} ctx`;
  const models = `${seat.models.length} model${seat.models.length === 1 ? '' : 's'}`;
  // Provenance is a note too: a reading served from another process's shared
  // file is not a live probe and must not be presented as one.
  const provenance = evidenceNote(view.evidenceSource);
  const notes = provenance === null ? view.notes : [...view.notes, provenance];

  return (
    <>
      <div className={styles.seatMeta}>
        <span>{ENGINE_LABEL[seat.engine]}</span>
        {view.plan === null ? null : <><span aria-hidden="true">·</span><span className={styles.plan}>{view.plan}</span></>}
        <span aria-hidden="true">·</span>
        <span>{models}</span>
        <span aria-hidden="true">·</span>
        <span className={styles.num}>{ctx}</span>
      </div>

      {view.kind === 'local' || bars.length === 0 ? (
        // Nothing measured, or a local seat with no subscription at all.
        // Say so. An empty bar would read "plenty left". A local seat's
        // health summary already travels in `notes`, so it is not repeated here.
        <>
          <p className={styles.seatSummary}>{view.summary}</p>
          {view.kind === 'local' || seat.health.summary === null || seat.health.summary === view.summary
            ? null
            : <p className={styles.seatSummary}>{seat.health.summary}</p>}
        </>
      ) : (
        <div className={styles.seatWindows}>
          {bars.map((windowView) => (
            <SeatWindowMeter
              key={windowView.id}
              windowView={windowView}
              ariaPrefix={seat.label}
              prominent={view.binding?.id === windowView.id}
            />
          ))}
        </div>
      )}

      {view.credits === null ? null : (
        // Credits are not a window. A spent week with a spendable balance is
        // not a blocked account, and there is no maximum to draw a bar against
        // (docs/VERSE-TELEMETRY-V2.md, Codex).
        <p className={styles.credits} title={view.creditsTitle ?? sentence}>{view.credits}</p>
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
    </>
  );
}

function SeatRow({
  seat,
  open,
  onToggle,
}: {
  seat: VerseSeat;
  open: boolean;
  onToggle: () => void;
}) {
  const view = seatSubscription(seat);
  const sentence = seatSubscriptionSentence(seat, view);
  const bodyId = `verse-seat-${seat.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;

  return (
    <li className={`${styles.seat} ${styles[`engine-${seat.engine}`] ?? ''}`} data-engine={seat.engine}
      data-capacity={view.cls} data-open={open ? 'true' : 'false'}>
      {/* The plan, the word and the reset were on a `title` hung off the inner
          label span — reachable by mouse only, and duplicated onto the chip
          beside it. One tooltip on the CONTROL carries it once, and a
          keyboard operator tabbing the seat list now gets it too. The button
          keeps its own aria-label: this describes, it does not name. */}
      <Tooltip label={sentence} placement="left">
        <button
          type="button"
          className={styles.seatToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={seat.label}
          onClick={onToggle}
        >
          <span className={styles.twist} data-open={open ? '' : undefined} aria-hidden="true" />
          <span className={styles.seatLabel}>{seat.label}</span>
          {view.kind === 'local'
            ? <StatusBadge status={seat.health.state} tone={seat.health.state === 'ready' ? 'success' : seat.health.state === 'unavailable' ? 'danger' : 'unknown'} />
            : <CapacityChip view={view} />}
        </button>
      </Tooltip>

      {open
        ? <div id={bodyId}><SeatDetails seat={seat} view={view} /></div>
        // The one line that says WHY it is shut. The meters stay unmounted,
        // so a spent account is a row and not a page.
        : <p id={bodyId} className={styles.seatSummary}>{view.summary}</p>}
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
  const collapse = useResourcesCollapse();

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
              : groups.map((group) => {
                const open = groupIsOpen(collapse.state, group.engine);
                const listId = `verse-res-group-${group.engine}`;
                return (
                  <div key={group.engine} className={styles.engineGroup}>
                    <h4 className={styles.engineTitle}>
                      <button
                        type="button"
                        className={styles.groupToggle}
                        aria-expanded={open}
                        aria-controls={listId}
                        aria-label={`${ENGINE_LABEL[group.engine]} seats`}
                        onClick={() => collapse.toggleGroup(group.engine)}
                      >
                        <span className={styles.twist} data-open={open ? '' : undefined} aria-hidden="true" />
                        <span>{ENGINE_LABEL[group.engine]}</span>
                        <span className={styles.count}>{group.seats.length}</span>
                      </button>
                    </h4>
                    {open ? (
                      <ul id={listId} className={styles.seatList}>
                        {group.seats.map((seat) => {
                          const view = seatSubscription(seat);
                          return (
                            <SeatRow
                              key={seat.id}
                              seat={seat}
                              open={seatIsOpen(collapse.state, seat.id, view.cls)}
                              onToggle={() => collapse.toggleSeat(seat, view)}
                            />
                          );
                        })}
                      </ul>
                    ) : <ul id={listId} className={styles.seatList} hidden />}
                  </div>
                );
              })}
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

        {/* Folders this chat reaches, each with its own branch and dirty
            count — a turn that edits two repos produces two diffs, and they
            have to be attributable. Renders nothing for a single-folder chat,
            which already says its folder everywhere else. `turnCount` is the
            refresh key: a finished turn may have changed a branch. */}
        <SessionRoots session={current} refreshKey={current?.turnCount ?? 0} />

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
