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
 *   Accounts        one card per paid seat, usable first (orderAccountRows)
 *   Local models    the local seat, the serving runtime, installed models
 *   Cloud credits   GET /api/verse/cloud, or "Cloud lane not available yet"
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
import { useRefetch } from '../../../data/hooks.js';
import type { AccountAction } from '../apps/apps-model.js';
import { servingRuntimeQuery } from '../autonomy/fleet-queries.js';
import { reconnectSeat, refreshSeatHealth, verseHealthQuery } from '../health/health-queries.js';
import { findCommand, formatChord } from '../shell/command-catalog.js';
import { isGuardOpen, requestGuarded } from '../shell/guarded-action.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ACCOUNT_CLOCK_MS, useCapacityData } from '../usage/CapacityStrip.js';
import { accountStatus, buildCapacityRows, capacityHeadline, orderAccountRows, type CapacityRow } from '../usage/capacity-strip-model.js';
import { verseLocalModelsQuery } from '../usage/usage-queries.js';
import { setVerseSection, type VerseSectionId } from '../verse-ui-store.js';
import { CloudCredits } from './CloudCredits.js';
import { LocalResources } from './LocalResources.js';
import { ResourceCard } from './ResourceCard.js';
import { cloudCreditsQuery } from './resources-queries.js';
import { closeResources, setResourcesBar, setResourcesPinned, useResourcesUi } from './resources-store.js';
import styles from './ResourcesDrawer.module.css';

export const RESOURCES_EMPTY_TEXT =
  'No accounts connected yet. Sign in to Claude Code, Codex or Grok in a terminal — they show up here within a minute.';

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

  const refetchHealth = useRefetch(verseHealthQuery);
  const refetchLocal = useRefetch(verseLocalModelsQuery);
  const refetchRuntime = useRefetch(servingRuntimeQuery);
  const refetchCloud = useRefetch(cloudCreditsQuery);

  const rows = useMemo(
    () => buildCapacityRows(data.seats, { health: data.health, budget: data.budget, now }),
    [data.seats, data.health, data.budget, now],
  );
  const paid = useMemo(() => orderAccountRows(rows.filter((r) => r.kind === 'subscription'), { healthRead, now }), [rows, healthRead, now]);
  const localRow = rows.find((r) => r.kind === 'local') ?? null;
  const mode_ = data.budget?.mode ?? null;

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
          else await refreshSeatHealth();
        } finally {
          setBusy(null);
        }
      },
      onDone: () =>
        setNote({
          tone: 'neutral',
          text: reconnect
            ? `Opened the sign-in for ${row.label} in Terminal. Finish it there; this drawer picks it up.`
            : `Checked ${row.label} again.`,
        }),
      onError: (message) => setNote({ tone: 'danger', text: message }),
    });
  };

  const refreshAll = () => {
    setNote(null);
    refetchHealth();
    refetchLocal();
    refetchRuntime();
    refetchCloud();
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
        <section className={styles.group} aria-labelledby={`${titleId}-accounts`}>
          <h3 id={`${titleId}-accounts`} className={styles.groupTitle}>Accounts</h3>
          {data.loading ? (
            <p className={styles.subtle} aria-busy="true">Reading accounts…</p>
          ) : paid.length === 0 ? (
            <p className={styles.subtle}>{RESOURCES_EMPTY_TEXT}</p>
          ) : (
            <ul className={styles.cards}>
              {paid.map((row) => {
                const settled = accountStatus(row, { healthRead, now });
                const checking = busy?.seatId === row.seatId && busy.kind === 'check-again';
                const status = checking ? accountStatus(row, { healthRead, now, checking: true }) : settled;
                return <ResourceCard key={row.seatId} row={row} status={status} settled={settled} mode={mode_} busy={busy} onAction={onAction} />;
              })}
            </ul>
          )}
          <p className={note ? styles.note : styles.visuallyHidden} data-tone={note?.tone} role="status" aria-live="polite">{note?.text ?? ''}</p>
        </section>

        <section className={styles.group} aria-labelledby={`${titleId}-local`}>
          <h3 id={`${titleId}-local`} className={styles.groupTitle}>Local</h3>
          <ul className={styles.cards}>
            <LocalResources status={localRow ? accountStatus(localRow, { healthRead, now }) : null} onOpenUsage={() => go('usage')} now={now} />
          </ul>
        </section>

        <section className={styles.group} aria-labelledby={`${titleId}-cloud`}>
          <h3 id={`${titleId}-cloud`} className={styles.groupTitle}>Cloud</h3>
          <ul className={styles.cards}>
            <CloudCredits />
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
