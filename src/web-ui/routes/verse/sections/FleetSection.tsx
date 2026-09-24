/**
 * routes/verse/sections/FleetSection.tsx — ⌘2 Fleet (SPEC-310B §6,
 * SPEC-310C §5; unit C7). What is running where, why that seat, what is
 * waiting, and per-repo control.
 *
 *   Live swimlane by lane × phase                                  (12)
 *   Gate funnel + refusal reasons (7) | Why this seat (5)
 *   Parked Gantt (7)                  | Overnight (5)
 *   Repo table: stage, last merge, green% sparkline, holds, pause/resume (12)
 *   ▸ Advanced — the eleven legacy Autonomy panels, fetched only when opened
 *
 * At 375 px: one column in that order; the repo table becomes cards.
 * The live view polls every 5 s while Fleet is the visible surface.
 */
import { Suspense, lazy, useId, useState } from 'react';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { IconChevronRight } from '../../../components/primitives/icons.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { overnightQuery } from '../autonomy/overnight-queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import { budgetPreviewQuery, budgetQuery } from '../budget/budget-queries.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { Cell, Surface } from '../command/Surface.js';
import { fleetLiveQuery } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useViewport } from '../shell/viewport.js';
import { GateFunnelCards, LanesStrip, LiveSwimlane, OvernightCard, ParkedCard, WhySeatCard } from '../fleet/FleetCards.js';
import { RepoTable } from '../fleet/RepoTable.js';
import styles from '../fleet/fleet.module.css';

export const FLEET_POLL_MS = 5_000;
export const FLEET_SLOW_POLL_MS = 30_000;

// The legacy cockpit is ~74 KB of panels: its own chunk, loaded on open.
const FleetAdvanced = lazy(() => import('../fleet/Advanced.js').then((m) => ({ default: () => <m.FleetAdvanced embedded /> })));

export function FleetSection() {
  const { compact } = useViewport();
  const fleet = useQuery(fleetLiveQuery);
  const overnight = useQuery(overnightQuery);
  const budget = useQuery(budgetQuery, { freshMs: 15_000 });
  const preview = useQuery(budgetPreviewQuery, { freshMs: 15_000 });
  const refetchFleet = useRefetch(fleetLiveQuery);
  const refetchOvernight = useRefetch(overnightQuery);
  const refetchPreview = useRefetch(budgetPreviewQuery);
  usePollWhileVisible(refetchFleet, FLEET_POLL_MS);
  usePollWhileVisible(() => {
    refetchOvernight();
    refetchPreview();
  }, FLEET_SLOW_POLL_MS);

  const now = useNow(15_000);
  const actions = useSurfaceActions();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedId = useId();
  const live = fleet.data?.value ?? null;

  function openAdvanced(): void {
    setAdvancedOpen(true);
    requestAnimationFrame(() => document.getElementById(advancedId)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  }

  return (
    <Surface
      title="Fleet"
      actions={fleet.status === 'refreshing' ? <RefreshIndicator /> : null}
      lead={
        <>
          <ActionStatus actions={actions} />
          <LanesStrip live={live} />
        </>
      }
    >
      <Cell span={12}>
        <LiveSwimlane read={fleet.data} now={now} hours={compact ? 6 : 12} />
      </Cell>
      <Cell span={7}>
        <GateFunnelCards read={fleet.data} />
      </Cell>
      <Cell span={5}>
        <WhySeatCard read={fleet.data} preview={preview.data ?? null} view={budget.data ?? null} />
      </Cell>
      <Cell span={7}>
        <ParkedCard read={fleet.data} now={now} />
      </Cell>
      <Cell span={5}>
        <OvernightCard read={overnight.data} onOpenAdvanced={openAdvanced} />
      </Cell>
      <Cell span={12}>
        <RepoTable read={fleet.data} actions={actions} now={now} compact={compact} />
      </Cell>
      <Cell span={12}>
        <div className={styles.advanced}>
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            onClick={() => setAdvancedOpen((o) => !o)}
          >
            <IconChevronRight className={styles.chevron} width={14} height={14} aria-hidden="true" />
            Advanced
            <span className={styles.disclosureNote}>daemon, overnight, local runtime, caps, scope, activity, safety, goals</span>
          </button>
          <div id={advancedId} hidden={!advancedOpen}>
            {advancedOpen ? (
              <Suspense fallback={<p className={styles.muted} aria-busy="true">Loading the advanced panels…</p>}>
                <FleetAdvanced />
              </Suspense>
            ) : null}
          </div>
        </div>
      </Cell>
      {actions.dialogs}
    </Surface>
  );
}
