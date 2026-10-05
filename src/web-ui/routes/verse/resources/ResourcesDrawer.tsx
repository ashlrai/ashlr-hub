/**
 * routes/verse/resources/ResourcesDrawer.tsx — RESOURCES: every account,
 * local runtime and cloud credit the operator can spend, on every surface
 * (unit 3.11 C6). A lazy chunk: the shell mounts it only while open.
 *
 *   overlay  ~360px from the right edge over the surface. Esc, a click
 *            outside or ⌘. closes it; focus is trapped inside and returned
 *            to whatever opened it.
 *   docked   PINNED: a right-hand column beside the surface (the shell gives
 *            it a grid track, so the surface shrinks rather than hides).
 *            Not modal — no trap, no backdrop, Esc is the surface's.
 *
 * 3.15 — ONE TIER MODEL, ONE CARD ANATOMY. Cards are grouped by tier
 * (routing/tiers.ts), never by provider or by when a provider was added:
 *
 *   Elite         Claude Code, every Codex account, Devin (cloud + CLI),
 *                 Claude cloud credits — and the local runtime when it runs
 *                 the elite Qwen 3.8 27B
 *   Fast          Grok
 *   Free · local  the local runtime otherwise
 *   Decision layer  Jev (it routes; it is not a seat)
 *
 * Inside a tier: stable roster order, so refreshes never move an account. Every card carries the same rows: facts
 * (tier · cost basis · models · reserve), status, usage against its window
 * or budget, and the Chat / Fleet readiness lines with their fixing command.
 *
 * Data is the app-wide caches (useCapacityData: bootstrap seats, /health,
 * /budget) plus the owners' local and cloud reads — nothing polls unless the
 * drawer is open, because nothing here is mounted unless it is.
 *
 * Writes go through the shell's guard (confirm where the regular UI confirms,
 * then the mutation token): Reconnect opens the provider's own sign-in in
 * Terminal, Check again is the zero-cost health sweep.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../../../components/primitives/Button.js';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import { IconRefresh, IconX } from '../../../components/primitives/icons.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import type { ReadinessFix, ResourceReadinessRow } from '../../../../core/routing/readiness-types.js';
import type { AccountAction } from '../apps/apps-model.js';
import { servingRuntimeQuery } from '../autonomy/fleet-queries.js';
import { reconnectSeat, refreshSeatHealth, verseHealthQuery } from '../health/health-queries.js';
import { findCommand, formatChord } from '../shell/command-catalog.js';
import { isGuardOpen, requestGuarded } from '../shell/guarded-action.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ACCOUNT_CLOCK_MS, useCapacityData } from '../usage/CapacityStrip.js';
import { accountStatus, accountStatusRank, buildCapacityRows, capacityHeadline, type CapacityRow } from '../usage/capacity-strip-model.js';
import { COST_BASIS_RANK, costBasisOf, engineTier, TIER_BLURBS, TIER_LABELS, type ResourceTier } from '../../../../core/routing/tiers.js';
import { refreshSeats } from '../useSeatsRefresh.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { devinQuery } from '../devin/devin-queries.js';
import { verseLocalModelsQuery } from '../usage/usage-queries.js';
import { setVerseSection, type VerseSectionId } from '../verse-ui-store.js';
import { CloudCredits } from './CloudCredits.js';
import { CreditPools } from './CreditPools.js';
import { DevinResource } from './DevinResource.js';
import { JevResource } from './JevResource.js';
import { LocalResources } from './LocalResources.js';
import { ResourceCard } from './ResourceCard.js';
import { schedulingEvidence } from './scheduling-model.js';
import { cloudCreditsQuery, resourceReadinessQuery, RESOURCES_POLL_MS } from './resources-queries.js';
import { costBases, groupByTier, mergedFacts, readinessStatusRank, seatFacts, type ResourceFactsView, type TierEntry } from './resources-model.js';
import { closeResources, setResourcesBar, setResourcesPinned, useResourcesUi } from './resources-store.js';
import styles from './ResourcesDrawer.module.css';
import { refreshDevinConsumption } from '../devin/devin-queries.js';

export const RESOURCES_EMPTY_TEXT =
  'No accounts connected yet. Sign in to Claude Code, Codex, Devin or Grok in a terminal — they show up here within a minute.';

/** One card in a tier section. */
type DrawerEntry = TierEntry & (
  | { kind: 'account'; row: CapacityRow; facts: ResourceFactsView }
  | { kind: 'devin'; facts: ResourceFactsView; bases: ReturnType<typeof costBases> }
  | { kind: 'cloud'; facts: ResourceFactsView }
  | { kind: 'local'; facts: ResourceFactsView }
);

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 2.5h4l-.5 4 2.25 2.25H4.25L6.5 6.5z" />
      <path d="M8 8.75v4.75" fill="none" />
    </svg>
  );
}

type Note = { tone: 'neutral' | 'danger'; text: string } | null;

export interface ResourcesDrawerProps {
  mode: 'overlay' | 'docked';
  /** Phone-width window: the overlay takes the whole screen and cannot be pinned. */
  compact?: boolean;
  /** Injected clock for tests; otherwise the drawer re-reads the clock every ACCOUNT_CLOCK_MS. */
  now?: number;
}

export function ResourcesDrawer({ mode, compact = false, now: fixedNow }: ResourcesDrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const overlay = mode === 'overlay';
  const data = useCapacityData();
  const [tick, setTick] = useState(() => Date.now());
  usePollWhileVisible(() => setTick(Date.now()), ACCOUNT_CLOCK_MS, { enabled: fixedNow === undefined });
  const now = fixedNow ?? tick;
  const healthRead = data.health !== null;
  const [busy, setBusy] = useState<{ seatId: string; kind: AccountAction['kind'] } | null>(null);
  const [note, setNote] = useState<Note>(null);

  const refetchHealth = useRefresh(verseHealthQuery);
  const refetchLocal = useRefresh(verseLocalModelsQuery);
  const refetchRuntime = useRefresh(servingRuntimeQuery);
  const refetchCloud = useRefresh(cloudCreditsQuery);
  // 3.14: "ready for chat?" / "ready for the fleet?" per resource. An older
  // server has no route; every card then simply omits the two lines.
  const readinessRead = useQuery(resourceReadinessQuery);
  const refetchReadiness = useRefetch(resourceReadinessQuery);
  const refreshReadiness = useRefresh(resourceReadinessQuery);
  const refreshBudget = useRefresh(budgetQuery);
  const refreshDevin = useRefresh(devinQuery);
  usePollWhileVisible(refetchReadiness, RESOURCES_POLL_MS.readiness);
  const readinessById = useMemo(() => {
    const map = new Map<string, ResourceReadinessRow>();
    for (const r of readinessRead.data?.value?.resources ?? []) map.set(r.id, r);
    return map;
  }, [readinessRead.data]);

  const rows = useMemo(
    () => buildCapacityRows(data.seats, { health: data.health, budget: data.budget, now }),
    [data.seats, data.health, data.budget, now],
  );
  // Devin's two chat seats are ONE provider card (DevinResource), not two
  // generic account cards; every other paid seat is a generic card.
  const paid = useMemo(() => rows.filter((r) => r.kind === 'subscription' && r.engine !== 'devin'), [rows]);
  const devinRows = useMemo(() => rows.filter((r) => r.engine === 'devin'), [rows]);
  const localRow = rows.find((r) => r.kind === 'local') ?? null;
  const mode_ = data.budget?.mode ?? null;

  const sections = useMemo(() => {
    const seats = data.seats;
    const entries: DrawerEntry[] = [];
    const marginal = (facts: ResourceFactsView) => COST_BASIS_RANK[facts.basis];
    paid.forEach((row, index) => {
      const seat = seats.find((s) => s.id === row.seatId);
      const facts: ResourceFactsView = seat
        ? seatFacts(seat)
        : { tier: engineTier(row.engine), basis: costBasisOf(row.engine), models: [], reserve: null };
      entries.push({ kind: 'account', key: `account:${row.seatId}`, row, facts, tier: facts.tier, index,
        statusRank: accountStatusRank(accountStatus(row, { healthRead, now }).kind), marginal: marginal(facts) });
    });
    const devinSeats = seats.filter((s) => s.engine === 'devin');
    const devinFacts = mergedFacts(devinSeats) ?? { tier: 'elite' as ResourceTier, basis: 'credits' as const, models: [], reserve: null };
    const devinRank = devinRows.length > 0
      ? Math.min(...devinRows.map((r) => accountStatusRank(accountStatus(r, { healthRead, now }).kind)))
      : readinessStatusRank(null);
    entries.push({ kind: 'devin', key: 'devin', facts: devinFacts, bases: costBases(devinSeats), tier: devinFacts.tier,
      statusRank: devinRank, marginal: marginal(devinFacts), index: paid.length });
    const cloudFacts: ResourceFactsView = { tier: 'elite', basis: 'credits', models: [], reserve: null };
    entries.push({ kind: 'cloud', key: 'cloud', facts: cloudFacts, tier: 'elite', marginal: marginal(cloudFacts), index: paid.length + 1,
      statusRank: readinessStatusRank(readinessById.get('cloud')?.chat.ready ?? null) });
    // The local card lists its own models; its tier is the best local seat's
    // (the elite Qwen 3.8 27B puts it in Elite, anything else in Free).
    const localFacts = { ...(mergedFacts(seats.filter((s) => s.engine === 'local')) ?? { tier: 'free' as ResourceTier, basis: 'free' as const, models: [], reserve: null }), models: [] };
    entries.push({ kind: 'local', key: 'local', facts: localFacts, tier: localFacts.tier, marginal: 0, index: paid.length + 2,
      statusRank: localRow ? accountStatusRank(accountStatus(localRow, { healthRead, now }).kind) : readinessStatusRank(null) });
    // Stable within each tier: refreshed readiness never reorders a card.
    return groupByTier(entries).map((section) => ({ ...section, entries: section.entries.sort((a, b) => a.index - b.index) }));
  }, [data.seats, paid, devinRows, localRow, readinessById, healthRead, now]);

  // ── close: Esc (overlay), outside click, the close button, ⌘. ─────────
  const close = useCallback(() => {
    closeResources();
  }, []);
  const trapClose = useCallback(() => {
    // Esc in a dialog opened FROM the drawer (a confirmation, the token
    // prompt) belongs to that dialog: every trap hears Escape, and this one
    // registered first.
    if (isGuardOpen() || document.querySelector('[aria-modal="true"]:not([data-verse-overlay])')) return;
    closeResources();
  }, []);
  useFocusTrap({ open: overlay, containerRef: panelRef, onClose: trapClose });
  // Focus goes back to whatever opened the drawer (the trap does that). When
  // that is gone — the palette that ran "Open Resources" unmounts — it lands
  // on the edge handle rather than on <body>.
  useEffect(() => {
    if (!overlay) return undefined;
    return () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) document.querySelector<HTMLElement>('[data-resources-handle]')?.focus({ preventScroll: true });
      }, 0);
    };
  }, [overlay]);

  const go = (section: VerseSectionId, anchor: string | null = null) => {
    if (overlay) closeResources();
    setVerseSection(section, anchor);
  };

  const onAction = (row: CapacityRow, action: AccountAction) => {
    setNote(null);
    if (action.kind === 'fix' || action.kind === 'edit-budget') {
      go('apps', `seat:${row.seatId}`);
      return;
    }
    const reconnect = action.kind === 'reconnect';
    requestGuarded({
      title: reconnect ? `Reconnect ${row.label}?` : `Check ${row.label} again?`,
      body: '',
      confirmLabel: action.label,
      destructive: false,
      skipConfirm: true,
      token: true,
      tokenReason: reconnect
        ? `Open the sign-in for ${row.label} in Terminal`
        : `Check ${row.label} again (status commands only — nothing is spent)`,
      run: async () => {
        setBusy({ seatId: row.seatId, kind: action.kind });
        try {
          if (reconnect) await reconnectSeat(row.seatId);
          else if (row.engine === 'devin') {
            if (row.seatId !== 'devin') throw new Error('Devin CLI usage is not reported. Organization API consumption belongs to the connected cloud account.');
            await refreshDevinConsumption();
          } else await refreshSeatHealth();
        } finally {
          setBusy(null);
        }
      },
      onDone: () => {
        refetchReadiness();
        setNote({
          tone: 'neutral',
          text: reconnect
            ? `Opened the sign-in for ${row.label} in Terminal. Finish it there; this drawer picks it up.`
            : row.engine === 'devin' ? 'Updated the Devin organization consumption status.' : `Checked ${row.label} again.`,
        });
      },
      onError: (message) => setNote({ tone: 'danger', text: message }),
    });
  };

  /** A readiness fix that is a Verse action (the cloud card's Reconnect): the same guarded flow as a card button. */
  const onReadinessAction = (fix: ReadinessFix) => {
    if (fix.kind === 'command' || !fix.seatId) return;
    const target = rows.find((r) => r.seatId === fix.seatId);
    if (!target) return;
    onAction(target, { kind: fix.kind, label: fix.label, command: null, primary: true });
  };

  const refreshAll = () => {
    setNote(null);
    void refreshSeats();
    refreshBudget();
    refreshDevin();
    refetchHealth();
    refetchLocal();
    refetchRuntime();
    refetchCloud();
    refreshReadiness();
    setTick(Date.now());
  };

  const chord = findCommand('resources.toggle')?.keys[0];
  const shortcut = chord ? formatChord(chord) : undefined;
  const canPin = !compact;
  const pinned = mode === 'docked';

  const panel = (
    <div
      ref={panelRef}
      className={styles.panel}
      data-mode={mode}
      data-presentation={compact ? 'full' : 'side'}
      data-verse-overlay="resources"
      {...(overlay
        ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, tabIndex: -1 }
        : { role: 'complementary', 'aria-labelledby': titleId })}
    >
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 id={titleId} className={styles.title}>Resources</h2>
          {!data.loading && rows.length > 0 ? <p className={styles.headline}>{capacityHeadline(rows)}</p> : null}
        </div>
        <div className={styles.headActions}>
          <Tooltip label="Read everything again" placement="bottom">
            <IconButton variant="ghost" size="sm" icon={<IconRefresh />} aria-label="Read everything again" onClick={refreshAll} />
          </Tooltip>
          {canPin ? (
            <Tooltip label={pinned ? 'Unpin — float over the page' : 'Pin beside the page'} placement="bottom">
              <IconButton
                variant="ghost"
                size="sm"
                icon={<PinIcon pinned={pinned} />}
                aria-label={pinned ? 'Unpin resources' : 'Pin resources beside the page'}
                aria-pressed={pinned}
                data-resources-pin
                onClick={() => setResourcesPinned(!pinned)}
              />
            </Tooltip>
          ) : null}
          <Tooltip label="Close resources" shortcut={shortcut} placement="bottom">
            <IconButton variant="ghost" size="sm" icon={<IconX />} aria-label="Close resources" onClick={close} />
          </Tooltip>
        </div>
      </header>

      <div className={styles.body}>
        {data.refreshing ? <p className={styles.subtle} role="status">Updating readings…</p> : null}
        {data.readFailed ? <p className={styles.subtle} role="status">Refresh unavailable{data.rosterUnavailable ? '.' : ' · showing last readings.'}</p> : null}
        {data.loading ? (
          <p className={styles.subtle} aria-busy="true">Reading accounts…</p>
        ) : !data.rosterUnavailable && paid.length === 0 && devinRows.length === 0 ? (
          <p className={styles.subtle}>{RESOURCES_EMPTY_TEXT}</p>
        ) : null}
        <CreditPools accountNames={new Map(data.seats.map(seat => [seat.id, seat.label]))} />
        {sections.map((section) => (
          <section key={section.tier} className={styles.group} aria-labelledby={`${titleId}-${section.tier}`} data-tier-section={section.tier}>
            <h3 id={`${titleId}-${section.tier}`} className={styles.groupTitle}>{TIER_LABELS[section.tier]}</h3>
            <p className={styles.groupBlurb}>{TIER_BLURBS[section.tier]}</p>
            <ul className={styles.cards}>
              {section.entries.map((entry) => {
                switch (entry.kind) {
                  case 'account': {
                    const row = entry.row;
                    if (data.loading) return null;
                    const settled = accountStatus(row, { healthRead, now });
                    const checking = busy?.seatId === row.seatId && busy.kind === 'check-again';
                    const status = checking ? accountStatus(row, { healthRead, now, checking: true }) : settled;
                    return (
                      <ResourceCard
                        key={entry.key}
                        row={row}
                        status={status}
                        settled={settled}
                        mode={mode_}
                        busy={busy}
                        onAction={onAction}
                        readiness={readinessById.get(row.seatId) ?? null}
                        facts={entry.facts}
                        scheduling={schedulingEvidence(data.budget, row, now)}
                      />
                    );
                  }
                  case 'devin':
                    return <DevinResource key={entry.key} facts={entry.facts} bases={entry.bases} />;
                  case 'cloud':
                    return (
                      <CloudCredits
                        key={entry.key}
                        facts={entry.facts}
                        readiness={readinessById.get('cloud') ?? null}
                        onReadinessAction={onReadinessAction}
                        readinessBusy={busy !== null && busy.seatId === readinessById.get('cloud')?.chat.fix?.seatId}
                      />
                    );
                  case 'local':
                    return (
                      <LocalResources
                        key={entry.key}
                        facts={entry.facts}
                        status={localRow ? accountStatus(localRow, { healthRead, now }) : null}
                        onOpenUsage={() => go('usage')}
                        now={now}
                        readiness={readinessById.get('local') ?? null}
                      />
                    );
                  default:
                    return null;
                }
              })}
            </ul>
          </section>
        ))}
        <p className={note ? styles.note : styles.visuallyHidden} data-tone={note?.tone} role="status" aria-live="polite">{note?.text ?? ''}</p>

        <section className={styles.group} aria-labelledby={`${titleId}-decisions`}>
          <h3 id={`${titleId}-decisions`} className={styles.groupTitle}>Decision layer</h3>
          <ul className={styles.cards}>
            <JevResource />
          </ul>
        </section>
      </div>

      <footer className={styles.foot}>
        <button type="button" className={styles.linkButton} onClick={() => go('apps')}>Apps &amp; Accounts</button>
        <button type="button" className={styles.linkButton} onClick={() => go('usage')}>Usage</button>
        <BarToggle />
      </footer>
    </div>
  );

  if (!overlay) return panel;
  return createPortal(
    <div className={styles.backdrop} data-presentation={compact ? 'full' : 'side'} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      {panel}
    </div>,
    document.body,
  );
}

/** Footer switch for the always-on resource bar in the rail (3.11.1). */
function BarToggle() {
  const { bar } = useResourcesUi();
  return (
    <button
      type="button"
      className={styles.linkButton}
      style={{ marginLeft: 'auto' }}
      aria-pressed={bar}
      onClick={() => setResourcesBar(!bar)}
    >
      {bar ? 'Hide resource bar' : 'Show resource bar'}
    </button>
  );
}
