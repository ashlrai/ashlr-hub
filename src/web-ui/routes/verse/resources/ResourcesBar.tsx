/**
 * routes/verse/resources/ResourcesBar.tsx — the always-on resource bar in the
 * rail foot (3.11.1).
 *
 * One row per resource the operator runs on — each paid account (provider
 * mark + a battery showing how much of its binding window is LEFT), the local
 * models, and the cloud credits — so capacity is visible on every surface
 * without opening anything. Hover (or keyboard focus) shows the detail: every
 * window with its reset, the reserve kept for Mason, the account's state.
 * Clicking a row opens the Resources drawer. The whole bar can be switched
 * off ("Hide resource bar" in ⌘K or the drawer), which brings back the rail's
 * single capacity ring.
 *
 * Loaded with the Resources chrome chunk, never on the chat first-paint path.
 * It reads the same app-wide seat + health caches the rail already keeps warm
 * plus the budget view (useCapacityData, as the drawer does) and the
 * drawer's cloud read, so it adds no poll of its own for accounts.
 */
import { useMemo, type CSSProperties } from 'react';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useQuery } from '../../../data/hooks.js';
import { usedPercentText } from '../percent-text.js';
import { useCapacityData } from '../usage/CapacityStrip.js';
import { accountStatus, bindingLeftPercent, buildCapacityRows, type AccountStatus, type CapacityRow } from '../usage/capacity-strip-model.js';
import { formatUsd } from './resources-model.js';
import { cloudCreditsQuery } from './resources-queries.js';
import { openResources } from './resources-store.js';
import styles from './ResourcesBar.module.css';

type Level = 'ok' | 'low' | 'out' | 'idle' | 'unknown';

export interface BarRow {
  key: string;
  engine: 'claude' | 'codex' | 'grok' | 'local';
  name: string;
  /** 0–100 left in the binding window; null when there is no reading. */
  leftPercent: number | null;
  level: Level;
  /** Short value beside the battery in the labelled rail: "72%", "spent", "ready". */
  value: string;
  /** Spoken + hover summary. */
  summary: string;
  detail: string[];
}

const LEVEL_OF_STATUS: Readonly<Record<AccountStatus['kind'], Level>> = {
  usable: 'ok',
  low: 'low',
  spent: 'out',
  'signed-out': 'out',
  unavailable: 'out',
  checking: 'unknown',
  'not-checked': 'unknown',
};

/** Pure: capacity rows → bar rows (exported for tests). */
export function barRows(rows: readonly CapacityRow[], opts: { healthRead: boolean; now: number }): BarRow[] {
  const out: BarRow[] = [];
  for (const row of rows) {
    if (row.kind === 'local') {
      out.push({
        key: 'local',
        engine: 'local',
        name: row.localCount > 1 ? `Local models (${row.localCount})` : 'Local model',
        leftPercent: null,
        // An unread runtime is not "ready": the battery must say what the
        // hover summary does ("readiness not reported"), as Command's strip does.
        level: row.cls === 'blocked' ? 'out' : row.cls === 'unread' ? 'unknown' : 'idle',
        value: row.cls === 'blocked' ? 'offline' : row.cls === 'unread' ? 'not reported' : 'ready',
        summary: `${row.label}: ${row.summary}`,
        detail: ['No usage limits — runs on this Mac.', ...row.notes],
      });
      continue;
    }
    const status = accountStatus(row, { healthRead: opts.healthRead, now: opts.now });
    const level = LEVEL_OF_STATUS[status.kind] ?? 'unknown';
    const left = bindingLeftPercent(row);
    const value = level === 'out' ? (status.kind === 'spent' ? 'spent' : status.label.toLowerCase())
      : left === null ? '—' : `${usedPercentText(left)} left`;
    const detail = row.windows.map((w) => {
      const used = w.limitReached ? 'limit reached' : w.usedPercent === null ? 'no reading' : `${usedPercentText(w.usedPercent)} used`;
      return `${w.label.charAt(0).toUpperCase()}${w.label.slice(1)}: ${used}${w.resetText ? ` · resets ${w.resetText}` : ''}`;
    });
    if (row.reserve) detail.push(row.reserve.label);
    if (status.usableAgain) detail.push(`Usable again ${status.usableAgain}`);
    if (status.checked) detail.push(`Checked ${status.checked}`);
    out.push({
      key: row.seatId,
      engine: row.engine,
      name: row.label,
      leftPercent: level === 'out' ? 0 : left,
      level,
      value,
      summary: `${row.label}: ${status.label}${status.detail ? ` · ${status.detail}` : ''}`,
      detail,
    });
  }
  // Usable first, then running low, then unknown, then spent / signed out; local last among the usable.
  const rank: Record<Level, number> = { ok: 0, low: 1, idle: 2, unknown: 3, out: 4 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

function Battery({ left, level, vertical }: { left: number | null; level: Level; vertical: boolean }) {
  const fill = left === null ? (level === 'idle' ? 100 : 0) : Math.max(left > 0 ? 6 : 0, left);
  return (
    <span className={styles.battery} data-level={level} data-vertical={vertical || undefined} aria-hidden="true">
      <span className={styles.cell} style={{ '--fill': `${fill}%` } as CSSProperties} />
      <span className={styles.nub} />
    </span>
  );
}

function RowTip({ row }: { row: BarRow }) {
  return (
    <div className={styles.tip}>
      <div className={styles.tipHead}>
        <ProviderLogo engine={row.engine} size={14} />
        <strong>{row.name}</strong>
      </div>
      <div className={styles.tipSummary}>{row.summary.slice(row.name.length + 2)}</div>
      {row.detail.map((line) => (
        <div key={line} className={styles.tipLine}>{line}</div>
      ))}
      <div className={styles.tipHint}>Click for Resources · ⌘.</div>
    </div>
  );
}

export function ResourcesBar({ expanded }: { expanded: boolean }) {
  // With the budget view, like the drawer: for seats like Claude and Grok the
  // window readings arrive through it, so without it the batteries read empty.
  const data = useCapacityData();
  const cloudRead = useQuery(cloudCreditsQuery);
  const now = Date.now();
  const rows = useMemo(
    () => (data.loading ? [] : barRows(buildCapacityRows(data.seats, { health: data.health, budget: data.budget, local: 'collapse', now }), { healthRead: data.health !== null, now })),
    // `now` moves every render; the rows only need to follow the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.loading, data.seats, data.health, data.budget],
  );
  const cloud = cloudRead.data?.credits ?? null;
  const cloudLeft = cloud && cloud.totalUsd > 0 ? (cloud.remainingUsd / cloud.totalUsd) * 100 : null;
  const cloudLevel: Level = !cloud ? 'unknown' : cloud.remainingUsd <= 0 ? 'out' : (cloudLeft ?? 0) < 20 ? 'low' : 'ok';

  if (rows.length === 0 && !cloud) return null;
  return (
    <div className={styles.bar} data-expanded={expanded || undefined} role="group" aria-label="Resources at a glance">
      {rows.map((row) => (
        <Tooltip key={row.key} content={<RowTip row={row} />} placement="right">
          <button
            type="button"
            className={styles.row}
            data-level={row.level}
            aria-label={`${row.summary}. Open Resources`}
            onClick={() => openResources()}
          >
            {expanded ? (
              <>
                <span className={styles.line}>
                  <ProviderLogo engine={row.engine} size={14} className={styles.logo} />
                  <span className={styles.name}>{row.name}</span>
                </span>
                <span className={styles.line}>
                  <Battery left={row.leftPercent} level={row.level} vertical={false} />
                  <span className={styles.value}>{row.value}</span>
                </span>
              </>
            ) : (
              <>
                <ProviderLogo engine={row.engine} size={14} className={styles.logo} />
                <Battery left={row.leftPercent} level={row.level} vertical />
              </>
            )}
          </button>
        </Tooltip>
      ))}
      {cloud ? (
        <Tooltip
          content={
            <div className={styles.tip}>
              <div className={styles.tipHead}><ProviderLogo engine="claude" size={14} /><strong>Cloud credits</strong></div>
              <div className={styles.tipSummary}>{formatUsd(cloud.remainingUsd)} of {formatUsd(cloud.totalUsd)} left · estimate</div>
              <div className={styles.tipLine}>{cloud.running} running · {cloud.sessionsToday} today</div>
              <div className={styles.tipHint}>Click for Resources · ⌘.</div>
            </div>
          }
          placement="right"
        >
          <button
            type="button"
            className={styles.row}
            data-level={cloudLevel}
            aria-label={`Cloud credits: about ${formatUsd(cloud.remainingUsd)} of ${formatUsd(cloud.totalUsd)} left. Open Resources`}
            onClick={() => openResources()}
          >
            {expanded ? (
              <>
                <span className={styles.line}>
                  <span className={styles.cloudLogo}><ProviderLogo engine="claude" size={14} className={styles.logo} /></span>
                  <span className={styles.name}>Cloud credits</span>
                </span>
                <span className={styles.line}>
                  <Battery left={cloudLeft} level={cloudLevel} vertical={false} />
                  <span className={styles.value}>{formatUsd(cloud.remainingUsd)} left</span>
                </span>
              </>
            ) : (
              <>
                <span className={styles.cloudLogo}><ProviderLogo engine="claude" size={14} className={styles.logo} /></span>
                <Battery left={cloudLeft} level={cloudLevel} vertical />
              </>
            )}
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
