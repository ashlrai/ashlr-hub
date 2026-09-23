/**
 * routes/verse/sections/UsageSection.tsx — the Usage rail section
 * (docs/VERSE-CONTRACT-V2.md). Takes no props, per the shell contract; every
 * read is cache-backed so switching rails is instant.
 *
 * This view exists to answer ONE question at a glance: WHICH ACCOUNT CAN I
 * ACTUALLY USE RIGHT NOW, AND WHAT WILL IT COST ME. Everything is ordered
 * against that: account cards first, each led by its binding constraint and
 * sorted most-usable-first; then local availability; then the token and spend
 * series; then the accounting panels.
 *
 * Sources, in priority order:
 *   GET /api/verse/accounts      per-account state, windows, credits, plan
 *   GET /api/verse/local-models  resident vs installed, VRAM split, tools
 *   GET /api/verse/usage-series  DailyUsage[] behind every chart here
 *   GET /api/control             local/cloud split, localSavingsUsd, limits
 *   GET /api/verse/control       configured caps + today's spend
 *   GET /api/usage               per-engine frontier usage (fallback + limits)
 *   GET /api/verse/bootstrap     the seat roster (fallback roster only)
 *
 * V3.9 adds one panel computed entirely in the browser: CONTEXT EFFICIENCY
 * per seat (cache-hit ratio, compactions, the fullest context), aggregated
 * from the session records `bootstrap` already carries — no new route, no
 * spend (usage/context-model.ts `seatEfficiency`).
 *
 * The first three are owner T's and are landing in parallel. When they are
 * absent this section degrades to the pre-V2 sources through ONE card model
 * (see accounts-model.ts `buildFallbackAccountCards`) and says so in a banner
 * — it never renders two different card designs, and it never silently
 * presents coarser data as if it were per-account.
 *
 * Every honesty decision lives in the model modules, not here.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { controlSnapshotQuery } from '../../../data/queries.js';
import { SkeletonCardGrid, SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatTile, chartFormat } from '../../../components/charts/index.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import { AccountCard } from '../usage/AccountCard.js';
import { AccountDetail } from '../usage/AccountDetail.js';
import { CapacityStrip } from '../usage/CapacityStrip.js';
import { EfficiencyPanel } from '../usage/EfficiencyPanel.js';
import { seatEfficiency } from '../usage/context-model.js';
import { LimitsPanel } from '../usage/LimitsPanel.js';
import { LocalCloudPanel } from '../usage/LocalCloudPanel.js';
import { LocalCard, LocalModelsPanel } from '../usage/LocalModelsPanel.js';
import { SeriesPanel } from '../usage/SeriesPanel.js';
import { SpendPanel } from '../usage/SpendPanel.js';
import {
  frontierUsageQuery,
  usageSeriesQuery,
  verseAccountsQuery,
  verseControlQuery,
  verseLocalModelsQuery,
} from '../usage/usage-queries.js';
import {
  FALLBACK_SOURCE_NOTE,
  buildAccountCards,
  buildFallbackAccountCards,
  buildLocalCard,
  collectAccountNotes,
} from '../usage/accounts-model.js';
import { buildLocalModelsView, localStaleness } from '../usage/local-model.js';
import { buildCapacityOverview } from '../usage/capacity-model.js';
import {
  projectAccountsSnapshot,
  projectLocalModels,
  projectUsageSeries,
  type SeriesWindow,
} from '../usage/usage-contract.js';
import {
  buildDailySpendSeries,
  buildLimitRows,
  buildLocalCloudSplit,
  projectVerseControl,
  unavailableVerseControl,
} from '../usage/usage-model.js';
import { LOCAL_SAVINGS_NOTE } from '../usage/series-model.js';
import styles from '../usage/usage.module.css';

function isUnauthorized(err: Error | undefined): boolean {
  return err instanceof ApiError && err.status === 401;
}

function StateBlock({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className={styles.stateBlock} role="status">
      <p className={styles.stateTitle}>{title}</p>
      <p className={styles.stateBody}>{body}</p>
      {action ? <div className={styles.stateActions}>{action}</div> : null}
    </div>
  );
}

/**
 * How often the probe-spawning reads re-run while this section is on screen.
 *
 * Matches the collector's own cycle: reading faster cannot surface anything
 * newer, and each read costs a handful of short-lived process spawns (zero
 * tokens, zero paid quota — see docs/VERSE-TELEMETRY-V2.md).
 */
const USAGE_POLL_MS = 30_000;

/**
 * The account detail spans the whole card row it sits in.
 *
 * Module scope so it is one frozen object rather than a fresh literal per
 * render, and inline rather than a new class because `usage.module.css` is not
 * this change's to edit — `.cards` is already
 * `repeat(auto-fit, minmax(280px, 1fr))`, and `1 / -1` spans it at every width
 * with no stylesheet rule to keep in sync.
 */
const DETAIL_ROW: CSSProperties = { gridColumn: '1 / -1' };

/**
 * Re-read on an interval, but only while the document is actually visible.
 *
 * Accounts and local models have no server-side change signal to ride — there
 * is no SSE event that means "a provider's window moved" — so without this the
 * whole section was a mount-only snapshot: a Usage screen left open while the
 * loop worked overnight showed the capacity it had at mount, looking live.
 * Gating on visibility keeps a backgrounded window from spawning probes
 * forever, and `useRefetch` coalesces with any read already in flight.
 */
function useVisiblePoll(refetch: () => void, intervalMs: number): void {
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const sync = (): void => {
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
      if (visible && id === null) id = setInterval(refetch, intervalMs);
      else if (!visible) stop();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      stop();
    };
  }, [refetch, intervalMs]);
}

export function UsageSection(): ReactNode {
  const [seriesWindow, setSeriesWindow] = useState<SeriesWindow>('7d');
  /** Which account card has its detail view open. Null = none. */
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const accounts = useQuery(verseAccountsQuery);
  const localModels = useQuery(verseLocalModelsQuery);
  const seriesRead = useQuery(usageSeriesQuery(seriesWindow));
  const frontier = useQuery(frontierUsageQuery);
  const control = useQuery(controlSnapshotQuery);
  const verseControl = useQuery(verseControlQuery);
  const bootstrap = useQuery(verseBootstrapQuery);

  const refetchAccounts = useRefresh(verseAccountsQuery);
  const refetchLocalModels = useRefresh(verseLocalModelsQuery);
  const refetchSeries = useRefresh(usageSeriesQuery(seriesWindow));
  const refetchFrontier = useRefresh(frontierUsageQuery);
  const refetchControl = useRefresh(controlSnapshotQuery);
  const refetchVerseControl = useRefresh(verseControlQuery);
  const refetchBootstrap = useRefresh(verseBootstrapQuery);

  // Live without a server signal. Kept to the two reads that actually go stale
  // on their own; everything else rides the daemon SSE event (data/sse.ts) or
  // the Refresh button.
  const pollAccounts = useRefetch(verseAccountsQuery);
  const pollLocalModels = useRefetch(verseLocalModelsQuery);
  useVisiblePoll(pollAccounts, USAGE_POLL_MS);
  useVisiblePoll(pollLocalModels, USAGE_POLL_MS);

  const refreshAll = (): void => {
    refetchAccounts();
    refetchLocalModels();
    refetchSeries();
    refetchFrontier();
    refetchControl();
    refetchVerseControl();
    refetchBootstrap();
  };

  // ---- projections -------------------------------------------------------

  const accountsSnapshot = useMemo(
    () => (accounts.data?.available ? projectAccountsSnapshot(accounts.data.raw) : null),
    [accounts.data],
  );
  const localSnapshot = useMemo(
    () => (localModels.data?.available ? projectLocalModels(localModels.data.raw) : null),
    [localModels.data],
  );
  const series = useMemo(
    () => (seriesRead.data?.available ? projectUsageSeries(seriesRead.data.raw, seriesWindow) : null),
    [seriesRead.data, seriesWindow],
  );

  const caps = useMemo(
    () =>
      verseControl.data
        ? verseControl.data.available
          ? projectVerseControl(verseControl.data.raw, verseControl.data.reason)
          : unavailableVerseControl(verseControl.data.reason ?? 'Configured caps unavailable.')
        : unavailableVerseControl('Configured caps not loaded yet.'),
    [verseControl.data],
  );

  // The real roster when owner T's route answered; otherwise the same card
  // model built from the coarser pre-V2 sources, with a banner saying so.
  const usingFallbackRoster = accountsSnapshot === null;
  const cards = useMemo(
    () =>
      accountsSnapshot
        ? buildAccountCards(accountsSnapshot)
        : buildFallbackAccountCards({
            bootstrap: bootstrap.data,
            control: control.data,
            frontier: frontier.data,
          }),
    [accountsSnapshot, bootstrap.data, control.data, frontier.data],
  );

  const localView = useMemo(() => buildLocalModelsView(localSnapshot), [localSnapshot]);
  const localCard = useMemo(() => buildLocalCard(localSnapshot), [localSnapshot]);

  // The server's own caveats about how to read these meters. Deduplicated and
  // shown once for the panel rather than repeated on every card that carries
  // the same sentence.
  const accountNotes = useMemo(() => collectAccountNotes(accountsSnapshot), [accountsSnapshot]);

  // The local seat competes for the same attention as the cloud accounts —
  // when it is resident and they are exhausted, it IS the answer — so it sorts
  // into the same grid on the same rank scale rather than being parked last.
  const gridCards = useMemo(() => {
    const entries: Array<
      { key: string; rank: number; label: string } & (
        | { kind: 'account'; card: (typeof cards)[number] }
        | { kind: 'local'; card: NonNullable<typeof localCard> }
      )
    > = cards.map((card) => ({ key: card.id, rank: card.rank, label: card.label, kind: 'account', card }));
    if (localCard) entries.push({ key: 'local', rank: localCard.rank, label: 'Local', kind: 'local', card: localCard });
    return entries.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  }, [cards, localCard]);

  // The two-second answer, over the same card models the grid renders — so
  // the strip and the cards can never disagree about a seat's state.
  const capacity = useMemo(
    () => buildCapacityOverview({ cards, localCard, localView }),
    [cards, localCard, localView],
  );

  const localStale = useMemo(() => localStaleness(localView?.runtimes ?? []), [localView]);

  // The selection is held as an ID, never as a card object: a refresh rebuilds
  // every model, and a captured card would keep rendering readings the next
  // poll already replaced. The detail renders from the card the grid is holding
  // at that moment, so an account that disappears simply takes its panel with
  // it.
  const toggleAccount = (id: string): void => {
    setSelectedAccountId((current) => (current === id ? null : id));
  };

  /**
   * Close the detail and hand focus back to the card that opened it.
   *
   * Without this, dismissing the panel from its own Close button dropped focus
   * onto `<body>` — the element under the cursor ceases to exist — and the next
   * Tab restarted at the top of the document. A disclosure must return focus to
   * its trigger; closing by clicking the card again already does, because the
   * trigger is what was clicked.
   */
  const closeAccount = useCallback((): void => {
    // Read the id from the closure, not inside the updater: a state updater
    // must stay pure (StrictMode calls it twice), and the trigger is still
    // mounted at this point either way.
    const id = selectedAccountId;
    setSelectedAccountId(null);
    if (id !== null && typeof document !== 'undefined') {
      document.getElementById(`verse-account-trigger-${id}`)?.focus();
    }
  }, [selectedAccountId]);

  // Per-seat context efficiency, from the session records bootstrap already
  // carries. Held back (with the reason) when the chat list never arrived:
  // an empty table there would read "no chats" when the truth is "not read".
  const efficiencyRows = useMemo(
    () => seatEfficiency(bootstrap.data?.sessions ?? [], bootstrap.data?.seats ?? []),
    [bootstrap.data],
  );
  const efficiencyUnavailable = bootstrap.data
    ? null
    : bootstrap.status === 'error'
      ? `The chat list could not be read${bootstrap.error?.message ? ` (${bootstrap.error.message})` : ''}, so efficiency cannot be computed.`
      : 'Reading the chat list…';

  const split = useMemo(() => buildLocalCloudSplit(control.data?.usage), [control.data]);
  const limitRows = useMemo(
    () => buildLimitRows(control.data?.limits, caps.foundryLimits),
    [control.data, caps.foundryLimits],
  );
  const daemonSeries = useMemo(
    () => buildDailySpendSeries(control.data?.daemonObservation),
    [control.data],
  );

  // Gate the legacy fallback on AVAILABILITY, not on nullness: when the
  // contract's `spend` block is present, `todayUsd` is null — never 0 — for an
  // unreadable ledger, and a `??` here would print a different snapshot's
  // number under the word "today".
  const todaySpentUsd = caps.available ? caps.todaySpentUsd : (control.data?.daemon.todaySpentUsd ?? null);
  const todaySpentDate = caps.available ? caps.todaySpentDate : null;

  // ---- surface states ----------------------------------------------------

  const unauthorized =
    isUnauthorized(accounts.error) ||
    isUnauthorized(localModels.error) ||
    isUnauthorized(seriesRead.error) ||
    isUnauthorized(frontier.error) ||
    isUnauthorized(control.error) ||
    isUnauthorized(bootstrap.error);

  // Only a total loss of BOTH aggregate sources is a dead section: the new
  // routes are optional by construction, so their absence is degradation.
  const bothFailed =
    !unauthorized &&
    frontier.status === 'error' &&
    control.status === 'error' &&
    frontier.data === undefined &&
    control.data === undefined;

  const firstLoad =
    !unauthorized &&
    !bothFailed &&
    accounts.data === undefined &&
    frontier.data === undefined &&
    control.data === undefined &&
    (accounts.status === 'loading' ||
      accounts.status === 'idle' ||
      frontier.status === 'loading' ||
      control.status === 'loading' ||
      frontier.status === 'idle' ||
      control.status === 'idle');

  const refreshing =
    accounts.status === 'refreshing' ||
    frontier.status === 'refreshing' ||
    control.status === 'refreshing';

  const generatedAt =
    accountsSnapshot?.sampledAt ?? frontier.data?.generatedAt ?? control.data?.ts ?? null;

  return (
    <section className={styles.section} aria-label="Usage">
      <header className={styles.header} data-app-region="drag">
        <h2 className={styles.headerTitle}>Usage</h2>
        <div className={styles.headerMeta}>
          {generatedAt ? (
            <span>
              {refreshing ? 'refreshing · ' : ''}
              as of {new Date(generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : null}
          <button type="button" className={styles.ghostButton} onClick={refreshAll}>
            Refresh
          </button>
        </div>
      </header>

      <div className={styles.scroll}>
        {unauthorized ? (
          <StateBlock
            title="Read session expired"
            body="Usage data needs an authenticated read session. Unlock the console with the read token ashlr verse printed, then refresh."
            action={
              <button type="button" className={styles.ghostButton} onClick={refreshAll}>
                Try again
              </button>
            }
          />
        ) : bothFailed ? (
          <StateBlock
            title="Usage sources unreachable"
            body={`Neither /api/usage nor /api/control answered. ${control.error?.message ?? frontier.error?.message ?? ''}`.trim()}
            action={
              <button type="button" className={styles.ghostButton} onClick={refreshAll}>
                Retry
              </button>
            }
          />
        ) : firstLoad ? (
          <div aria-busy="true">
            <SkeletonLine width="30%" />
            <div className={styles.skeletonGrid} style={{ marginTop: 'var(--space-4)' }}>
              <SkeletonCardGrid count={5} />
            </div>
          </div>
        ) : (
          <>
            <CapacityStrip
              overview={capacity}
              selectedId={selectedAccountId}
              onSelectSeat={toggleAccount}
            />

            <section className={styles.panel} aria-labelledby="verse-usage-accounts">
              <div className={styles.panelHead}>
                <h3 id="verse-usage-accounts" className={styles.panelTitle}>
                  Accounts
                </h3>
                <p className={styles.panelNote}>
                  Ordered by what you can use right now. Each card leads with its binding constraint —
                  the window with the highest used percent, because that is what blocks work.
                </p>
              </div>

              {usingFallbackRoster && accounts.data && !accounts.data.available ? (
                <p className={styles.muted}>
                  {accounts.data.reason} {FALLBACK_SOURCE_NOTE}
                </p>
              ) : null}
              {accountsSnapshot?.collectorNote ? (
                <p className={styles.muted}>{accountsSnapshot.collectorNote}</p>
              ) : null}
              {accountNotes.length > 0 ? (
                <ul className={styles.noteList}>
                  {accountNotes.map((note) => (
                    <li key={note} className={styles.muted}>
                      {note}
                    </li>
                  ))}
                </ul>
              ) : null}

              {cards.length === 0 && localCard === null ? (
                <p className={styles.muted}>
                  No accounts and no local runtime were reported. Connect an account or start Ollama,
                  then refresh — this is an empty roster, not a set of accounts at zero.
                </p>
              ) : (
                <>
                  <div className={styles.cards}>
                    {gridCards.map((entry) => {
                      if (entry.kind !== 'account') {
                        return <LocalCard key={entry.key} card={entry.card} staleness={localStale} />;
                      }
                      const open = selectedAccountId === entry.key;
                      return (
                        <Fragment key={entry.key}>
                          <AccountCard
                            card={entry.card}
                            onOpen={toggleAccount}
                            expanded={open}
                            triggerId={`verse-account-trigger-${entry.key}`}
                            detailId={`verse-account-detail-${entry.key}`}
                          />
                          {/*
                            The detail belongs BESIDE the card it explains.
                            Rendered after the whole grid it opened up to four
                            rows below the thing clicked, frequently off-screen,
                            with nothing connecting the two on the page — the
                            grid is `auto-fit minmax(280px, 1fr)`, so at a wide
                            window the card that was clicked and the panel that
                            answered could be a screen apart. Spanning the full
                            row in place keeps it under its own card at every
                            width, and needs no new rule in the stylesheet.
                          */}
                          {open ? (
                            <div id={`verse-account-detail-${entry.key}`} style={DETAIL_ROW}>
                              <AccountDetail
                                card={entry.card}
                                headingId={`verse-account-heading-${entry.key}`}
                                onClose={closeAccount}
                              />
                            </div>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </div>
                </>
              )}
            </section>

            <LocalModelsPanel view={localView} />

            <SeriesPanel
              series={series}
              window={seriesWindow}
              onWindowChange={setSeriesWindow}
              unavailableReason={
                seriesRead.data && !seriesRead.data.available ? seriesRead.data.reason : null
              }
              loading={seriesRead.status === 'loading' || seriesRead.status === 'idle'}
            />

            <EfficiencyPanel rows={efficiencyRows} unavailableReason={efficiencyUnavailable} />

            {split ? (
              <LocalCloudPanel split={split} savingsNote={LOCAL_SAVINGS_NOTE} />
            ) : (
              <section className={styles.panel} aria-labelledby="verse-usage-split-missing">
                <div className={styles.panelHead}>
                  <h3 id="verse-usage-split-missing" className={styles.panelTitle}>
                    Local vs cloud
                  </h3>
                </div>
                <div className={styles.tiles}>
                  <StatTile
                    label="Not spent (ran locally)"
                    value={<span className={styles.num}>unknown</span>}
                    caption="/api/control did not answer, so the split is unavailable"
                  />
                </div>
              </section>
            )}

            <LimitsPanel rows={limitRows} capsNote={caps.available ? null : caps.reason} />

            <SpendPanel
              series={daemonSeries}
              todaySpentUsd={todaySpentUsd}
              todaySpentDate={todaySpentDate}
              dailyBudgetUsd={caps.dailyBudgetUsd}
              // The real per-day spend chart lives in the series panel above.
              // The daemon tick ledger is only worth drawing when that series
              // could not be read at all — otherwise it is a narrower, capped
              // second line about the same money.
              showSeries={series === null}
            />

            {caps.available && caps.subscriptionMaxPercent !== null ? (
              <p className={styles.muted}>
                Subscription throttle threshold is{' '}
                <span className={styles.num}>
                  {chartFormat.formatPercent(caps.subscriptionMaxPercent / 100)}
                </span>
                . It only applies to engines that publish a real window reading — no seat is ever
                throttled on a guess.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
