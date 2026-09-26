/**
 * routes/verse/command/SeatStrip.tsx — every seat's headroom in ONE compact
 * row on Command (audit 14): provider mark + name, what is left of the
 * binding window, the reset, and whether autonomy may use it. One glance
 * answers "will it run out?"; clicking a seat (or the head's Resources link,
 * or ⌘.) opens the Resources drawer for the detail. The burn-down charts that
 * used to fill this row live on Usage now (SeatBurnPanel).
 *
 * Its words come from seat-strip-model.ts — the same capacity projection the
 * rail's resource bar reads — so Command and the rail cannot describe one
 * seat two ways (audit 20).
 *
 * READS NOTHING NEW. The roster and the health sweep are read from the cache
 * the rail keeps warm on every surface (useCapacityData in ResourcesBar and
 * the capacity ring), never fetched from here: Command's own reads are pinned
 * by shell/surface-prefetch.test.ts, and a bootstrap read costs the server
 * ~384 ms (useSeatsRefresh.ts). The budget view is Command's own poll.
 */
import { useCallback, useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { VerseHealthResponse } from '../../../../core/verse/health-types.js';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { getQuerySnapshot, subscribeQuery } from '../../../data/cache.js';
import type { VerseSeat } from '../../../data/api-types.js';
import { VERSE_HEALTH_KEY } from '../health/health-queries.js';
import { openResources } from '../resources/resources-store.js';
import { buildCapacityRows } from '../usage/capacity-strip-model.js';
import { useViewport } from '../shell/viewport.js';
import { seatStrip, stripColumns, type SeatStripItem } from './seat-strip-model.js';
import { Card, CardNote } from './Surface.js';
import command from './command.module.css';
import styles from './seat-strip.module.css';

/** The health sweep as the rail last read it; null until it has answered once. */
function useCachedHealth(): VerseHealthResponse | null {
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeQuery(VERSE_HEALTH_KEY, listener), []),
    () => getQuerySnapshot<VerseHealthResponse>(VERSE_HEALTH_KEY),
    () => getQuerySnapshot<VerseHealthResponse>(VERSE_HEALTH_KEY),
  );
  return snapshot.data ?? null;
}

function SeatTip({ item }: { item: SeatStripItem }) {
  return (
    <div className={styles.tip}>
      <div className={styles.tipHead}>
        <ProviderLogo engine={item.engine} size={14} />
        <strong>{item.name}</strong>
      </div>
      <div>{item.status}{item.note && item.note !== item.status ? ` · ${item.note}` : ''}</div>
      {item.reserveLabel ? <div className={styles.tipLine}>{item.reserveLabel}</div> : null}
      <div className={styles.tipLine}>
        Autonomy: {item.autonomy.word}{item.autonomy.why ? ` — ${item.autonomy.why}` : ''}
      </div>
      <div className={styles.tipHint}>Click for Resources · ⌘.</div>
    </div>
  );
}

function SeatItem({ item }: { item: SeatStripItem }) {
  // Local seats have no quota: a full, quiet track when ready, an empty one otherwise.
  const fill = item.leftPercent ?? (item.engine === 'local' && item.value === 'Free' ? 100 : 0);
  const meterStyle = { '--fill': `${fill}%`, ...(item.reservePercent !== null ? { '--reserve': `${item.reservePercent}%` } : {}) } as CSSProperties;
  return (
    <Tooltip content={<SeatTip item={item} />} placement="bottom">
      <button
        type="button"
        className={styles.item}
        data-level={item.level}
        data-free={item.engine === 'local' || undefined}
        aria-label={`${item.spoken}. Open Resources`}
        aria-keyshortcuts="Meta+."
        onClick={() => openResources()}
      >
        <span className={styles.head}>
          <ProviderLogo engine={item.engine} size={14} className={styles.logo} />
          <span className={styles.name}>{item.name}</span>
          <span className={styles.value}>{item.value}</span>
        </span>
        <span className={styles.meter} style={meterStyle} aria-hidden="true">
          <span className={styles.fill} />
          {item.reservePercent !== null ? <span className={styles.reserve} /> : null}
        </span>
        <span className={styles.foot}>
          <span className={styles.note}>{item.note ?? item.status}</span>
          <span className={styles.autonomy} data-kind={item.autonomy.kind}>
            <span className={styles.dot} aria-hidden="true" />
            {item.autonomy.word}
          </span>
        </span>
      </button>
    </Tooltip>
  );
}

export function SeatStrip({ budget, seats, now }: { budget: BudgetView | null; seats: readonly VerseSeat[] | null; now: number }) {
  const health = useCachedHealth();
  const { viewport } = useViewport();
  const strip = useMemo(() => {
    let rows: ReturnType<typeof buildCapacityRows> = [];
    try {
      rows = seats && seats.length > 0 ? buildCapacityRows(seats, { health: health?.seats ?? null, budget, now }) : [];
    } catch {
      // A roster entry this client cannot read (a drifted or half-written
      // seat) must not take Command down with it: the strip falls back to the
      // budget route's seat list and says readiness is unknown.
      rows = [];
    }
    return seatStrip({ rows, budget, healthRead: health !== null, now });
  }, [seats, health, budget, now]);

  return (
    <Card
      title="Seats"
      caption={strip.headline}
      actions={
        <button type="button" className={command.linkButton} onClick={() => openResources()} aria-keyshortcuts="Meta+.">
          Resources <kbd className={command.kbd}>⌘.</kbd>
        </button>
      }
    >
      {strip.items.length === 0 ? (
        <CardNote tone="unknown">Seat capacity unavailable.</CardNote>
      ) : (
        <div
          className={styles.list}
          role="group"
          aria-label="Capacity per seat"
          style={{ '--seat-columns': stripColumns(viewport, strip.items.length) } as CSSProperties}
        >
          {strip.items.map((item) => (
            <SeatItem key={item.key} item={item} />
          ))}
        </div>
      )}
    </Card>
  );
}
