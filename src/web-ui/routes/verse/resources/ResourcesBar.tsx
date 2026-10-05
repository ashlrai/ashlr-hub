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
import { estimatedCreditValue } from './codex-credit-value.js';
import { useMemo, useState, type CSSProperties } from 'react';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useQuery } from '../../../data/hooks.js';
import { usedPercentText } from '../percent-text.js';
import { historicalLeftPercent } from './resource-usage-history.js';
import { ACCOUNT_CLOCK_MS, useCapacityData } from '../usage/CapacityStrip.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { bindingLeftPercent } from '../usage/binding-left.js';
import { accountStatus, buildCapacityRows, type AccountStatus, type CapacityRow } from '../usage/capacity-strip-model.js';
import { formatUsd } from './resources-model.js';
import { cloudCreditsQuery } from './resources-queries.js';
import { devinConsumptionEvidence, devinUsageEvidence, formatAcu } from '../devin/devin-model.js';
import { devinQuery } from '../devin/devin-queries.js';
import { openResources } from './resources-store.js';
import styles from './ResourcesBar.module.css';

type Level = 'ok' | 'low' | 'out' | 'idle' | 'unknown';

export interface BarRow {
  key: string;
  engine: 'claude' | 'codex' | 'grok' | 'local' | 'devin';
  name: string;
  /** 0–100 left in the binding window; null when there is no reading. */
  leftPercent: number | null;
  level: Level;
  /** Subscription usage or qualified organization consumption; never a credit balance. */
  value: string;
  /** Independent Codex credit reading, including unknown/unconfirmed states. */
  creditLabel?: string;
  creditHeld?: boolean;
  /** Spoken + hover summary. */
  summary: string;
  detail: string[];
}

const LEVEL_OF_STATUS: Readonly<Record<AccountStatus['kind'], Level>> = {
  usable: 'ok',
  low: 'low',
  spent: 'out',
  'signed-out': 'out',
  unavailable: 'unknown',
  checking: 'unknown',
  'not-checked': 'unknown',
};

/** Pure: capacity rows → bar rows (exported for tests). */
export function barRows(rows: readonly CapacityRow[], opts: { healthRead: boolean; now: number; pendingSeatIds?: readonly string[]; devinConsumption?: unknown }): BarRow[] {
  const out: BarRow[] = [];
  for (const row of rows) {
    if (row.engine === 'devin' && row.seatId === 'devin') {
      const consumption = devinConsumptionEvidence(opts.devinConsumption, opts.now);
      out.push({ key: row.seatId, engine: 'devin', name: row.label, leftPercent: null, level: 'unknown',
        value: consumption?.value ?? 'consumption not reported',
        summary: `${row.label}: ${consumption?.value ?? 'consumption not reported'} · remaining quota unknown`,
        detail: consumption?.lines ?? ['Organization consumption is not reported by this server. Balance, subscription limits and resets are unknown.'] });
      continue;
    }
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
        detail: ['No metered usage — runs on this Mac.', ...row.notes],
      });
      continue;
    }
    const status = accountStatus(row, { healthRead: opts.healthRead, now: opts.now });
    // Quota history does not determine freshness of the independent credit read.
    const currentCredits = !row.lastReading && !row.signedOut;
    const creditValue = currentCredits && (row.creditState === 'none' || row.credits !== null) ? estimatedCreditValue(row.creditBalance, row.plan) : null;
    const creditLabel = row.engine !== 'codex' ? undefined : !currentCredits ? 'Credits unconfirmed'
      : row.credits !== null ? creditValue === null ? row.credits : `Credits ≈${creditValue}`
      : row.creditState === 'none' ? 'No credits reported' : 'Credits not reported';
    const creditHeld = row.engine === 'codex' && currentCredits && row.creditSpendControlReached === true;
    const creditSummary = creditLabel ? ` · ${creditLabel}${creditHeld ? ' · credit spending held' : ''}` : '';
    const creditDetail: string[] = [];
    if (row.credits !== null && currentCredits) creditDetail.push(row.credits, 'Credit units are independent of subscription usage; autonomous credit spending is not admitted.');
    if (row.engine === 'codex' && currentCredits && row.creditState === 'none') creditDetail.push('Native provider reports no available credits.');
    if (creditValue !== null) creditDetail.push(`Estimated credit value ${creditValue} · personal-plan $0.04/credit reference; not attributed spend.`);
    const history = row.windows.length === 0 && !row.signedOut ? row.historicalUsage : null;
    if (history) {
      const recordedLeft = historicalLeftPercent(history);
      const historicalUsed = history.windows.reduce<number | null>((most, window) => window.usedPercent === null
        ? most : Math.max(most ?? 0, window.usedPercent), null);
      // Cached limit flags may carry a sentinel 100, which is not a measured percent.
      const historicalValue = history.windows.some(window => window.limitReached) ? 'limit was reached · last'
        : historicalUsed === null ? 'last reading' : `${usedPercentText(historicalUsed)} used · last`;
      out.push({ key: row.seatId, engine: row.engine, name: row.label, leftPercent: recordedLeft, level: 'unknown',
        value: row.engine === 'codex' ? historicalValue : recordedLeft === null ? 'last reading' : `${usedPercentText(recordedLeft)} last`,
        ...(creditLabel === undefined ? {} : { creditLabel, creditHeld }),
        summary: `${row.label}: last known usage · current usage unconfirmed${creditSummary}`,
        detail: [`Recorded ${new Date(history.observedAt).toLocaleString()}`, 'Historical reading; current availability and resets are unconfirmed.',
          ...history.windows.map(window => `${window.id}: ${window.limitReached ? 'limit was flagged' : window.usedPercent === null ? 'usage unknown' : `${usedPercentText(window.usedPercent)} used`}${window.resetsAt ? ` · recorded reset ${new Date(window.resetsAt).toLocaleString()}` : ''}`), ...creditDetail],
      });
      continue;
    }
    const left = bindingLeftPercent(row);
    // Match binding-left's selected window, but a limit flag is not a measured
    // percentage: keep its reported percent (if any) separate from blocked access.
    const measured = row.windows.filter(window => window.usedPercent !== null || window.limitReached);
    const binding = measured.find(window => window.binding) ?? (measured.length === 0 ? null
      : measured.reduce((a, b) => (b.usedPercent ?? 100) > (a.usedPercent ?? 100) ? b : a));
    const subscriptionUsed = binding?.usedPercent;
    const subscriptionValue = subscriptionUsed !== null && subscriptionUsed !== undefined
      ? `${usedPercentText(subscriptionUsed)} used${binding?.limitReached && subscriptionUsed < 100 ? ' · limit reached' : ''}`
      : binding?.limitReached ? 'limit reached' : null;
    // Credit availability/holds do not change the subscription battery's state.
    const level = row.engine === 'codex' && !row.lastReading && !row.signedOut
      ? left === null ? 'unknown' : left === 0 ? 'out' : left < 20 ? 'low' : 'ok' : LEVEL_OF_STATUS[status.kind] ?? 'unknown';
    const value = row.engine === 'codex' && subscriptionValue !== null && !row.signedOut
      ? `${subscriptionValue}${row.lastReading ? ' · last' : ''}`
      : level === 'out' ? (status.kind === 'spent' ? 'spent' : status.label.toLowerCase())
      : left === null ? (opts.pendingSeatIds?.includes(row.seatId) ? 'reading…' : status.kind === 'unavailable' ? 'unavailable' : 'no usage') : `${usedPercentText(left)} left${row.lastReading ? ' · last' : ''}`;
    const detail = row.windows.map((w) => {
      const used = w.limitReached ? 'limit reached' : w.usedPercent === null ? 'no reading' : `${usedPercentText(w.usedPercent)} used`;
      // The accounts model already words it "resets Fri 2:25 PM"; don't say it twice.
      const reset = w.resetText ? w.resetText.replace(/^resets\s+/i, '') : '';
      return `${w.label.charAt(0).toUpperCase()}${w.label.slice(1)}: ${used}${reset ? ` · resets ${reset}` : ''}`;
    });
    detail.push(...creditDetail);
    if (row.windows.length === 0) detail.push('Usage is not reported by this resource.');
    if (row.lastReading) detail.push('Last known usage · latest check failed.');
    if (row.reserve) detail.push(row.reserve.label);
    if (status.usableAgain) detail.push(`Usable again ${status.usableAgain}`);
    if (status.checked) detail.push(`Checked ${status.checked}`);
    out.push({
      key: row.seatId,
      engine: row.engine,
      name: row.label,
      leftPercent: row.signedOut ? null : row.engine === 'codex' ? left : row.windows.some((w) => w.binding && w.limitReached) || status.kind === 'spent' ? 0 : left,
      level: left === null && level === 'ok' ? 'unknown' : level,
      value,
      ...(creditLabel === undefined ? {} : { creditLabel, creditHeld }),
      summary: `${row.label}: ${status.label}${status.detail ? ` · ${status.detail}` : ''}${row.engine === 'codex' ? ` · subscription ${value}` : ''}${creditSummary}${creditValue !== null ? ` · estimated credit value ${creditValue}` : ''}`,
      detail,
    });
  }
  // Keep roster order: a new reading must never move the resource under a pointer.
  return out;
}

function Battery({ left, level, vertical }: { left: number | null; level: Level; vertical: boolean }) {
  const fill = left === null ? (level === 'idle' ? 100 : 0) : Math.max(left > 0 ? 6 : 0, left);
  return (
    <span className={styles.battery} data-level={level} data-unknown={left === null && level !== 'idle' || undefined} data-vertical={vertical || undefined} aria-hidden="true">
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
  const devinRead = useQuery(devinQuery);
  const devin = devinRead.data?.value ?? null;
  const [, setClock] = useState(() => Date.now());
  // The poll triggers expiry renders; query arrivals use the actual render time,
  // so a freshly retrieved reading is not rejected by an older clock tick.
  usePollWhileVisible(() => setClock(Date.now()), ACCOUNT_CLOCK_MS);
  const now = Date.now();
  const rows = useMemo(
    () => (data.loading ? [] : barRows(buildCapacityRows(data.seats, { health: data.health, budget: data.budget, local: 'collapse', now }), { healthRead: data.health !== null, now, pendingSeatIds: data.pendingSeatIds, devinConsumption: devin?.consumption })),
    [data.loading, data.seats, data.health, data.budget, data.pendingSeatIds, now, devin?.consumption],
  );
  const cloud = cloudRead.data?.credits ?? null;
  const cloudLeft = cloud && cloud.totalUsd > 0 ? (cloud.remainingUsd / cloud.totalUsd) * 100 : null;
  const cloudLevel: Level = !cloud ? 'unknown' : cloud.remainingUsd <= 0 ? 'out' : (cloudLeft ?? 0) < 20 ? 'low' : 'ok';
  // 3.15: Devin joins the bar only once it is connected and turned on.
  const devinShown = devin !== null && devin.status.enabled && devin.status.connected;
  const devinUsage = devin ? devinUsageEvidence(devin.budget) : null;
  const devinAvailable = devinUsage?.free ?? (devin ? Math.max(0, devin.budget.acuRemaining - Math.max(0, devin.budget.acuInFlight)) : 0);
  const devinLeft = devin && devin.budget.acuBudgetTotal > 0 ? (devinAvailable / devin.budget.acuBudgetTotal) * 100 : null;
  const devinLevel: Level = !devin ? 'unknown' : devin.budget.paused || devinAvailable <= 0 ? 'out' : (devinLeft ?? 0) < 20 ? 'low' : 'ok';
  // Admission is separate from tracked capacity and from provider quota readings.
  const devinNewChatPause = devin?.budget.canLaunch?.ok === false
    ? devin.budget.canLaunch.reason ?? 'The Devin budget refused another session.' : null;

  if (rows.length === 0 && !cloud && !devinShown) return null;
  return (
    <div className={styles.bar} data-expanded={expanded || undefined} role="group" aria-label="Resources at a glance" aria-busy={data.refreshing || undefined}>
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
                {row.creditLabel ? <span className={styles.credits}>
                  <span>{row.creditLabel}</span>
                  {row.creditHeld ? <span className={styles.creditHold}>Held</span> : null}
                </span> : null}
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
              <div className={styles.tipHead}><ProviderLogo engine="claude" size={14} /><strong>Cloud estimate</strong></div>
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
            aria-label={`Cloud estimate: about ${formatUsd(cloud.remainingUsd)} of ${formatUsd(cloud.totalUsd)} left. Open Resources`}
            onClick={() => openResources()}
          >
            {expanded ? (
              <>
                <span className={styles.line}>
                  <span className={styles.cloudLogo}><ProviderLogo engine="claude" size={14} className={styles.logo} /></span>
                  <span className={styles.name}>Cloud estimate</span>
                </span>
                <span className={styles.line}>
                  <Battery left={cloudLeft} level={cloudLevel} vertical={false} />
                  <span className={styles.value}>{formatUsd(cloud.remainingUsd)} est.</span>
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
      {devinShown && devin ? (
        <Tooltip
          content={
            <div className={styles.tip}>
              <div className={styles.tipHead}><ProviderLogo engine="devin" size={14} className={styles.logo} /><strong>Devin</strong></div>
              <div className={styles.tipSummary}>{formatAcu(devinAvailable)} of {formatAcu(devin.budget.acuBudgetTotal)} {devinUsage ? 'available' : 'left'} · tracked budget{devin.budget.paused ? ' · paused' : ''}</div>
              {devinUsage ? <div className={styles.tipLine}>{formatAcu(devinUsage.reported)} reported usage + adjustment · {formatAcu(devinUsage.held)} held exposure</div> : null}
              <div className={styles.tipLine}>{devin.budget.running} running · {devin.budget.sessionsToday} today</div>
              {devinNewChatPause ? <div className={styles.tipLine}>New chats paused: {devinNewChatPause}</div> : null}
              <div className={styles.tipHint}>Click for Resources · ⌘.</div>
            </div>
          }
          placement="right"
        >
          <button
            type="button"
            className={styles.row}
            data-level={devinLevel}
            data-resource="devin"
            aria-label={`Devin tracked budget: ${formatAcu(devinAvailable)} of ${formatAcu(devin.budget.acuBudgetTotal)} ${devinUsage ? 'available' : 'left'}${devinUsage ? `, ${formatAcu(devinUsage.held)} held exposure` : ''}${devinNewChatPause ? `. New chats paused: ${devinNewChatPause}` : ''}. Open Resources`}
            onClick={() => openResources()}
          >
            {expanded ? (
              <>
                <span className={styles.line}>
                  <ProviderLogo engine="devin" size={14} className={styles.logo} />
                  <span className={styles.name}>Devin</span>
                </span>
                <span className={styles.line}>
                  <Battery left={devinLeft} level={devinLevel} vertical={false} />
                  <span className={styles.value}>{formatAcu(devinAvailable)} budget</span>
                </span>
                {devinNewChatPause ? <span className={styles.line}><span className={styles.value}>New chats paused</span></span> : null}
              </>
            ) : (
              <>
                <ProviderLogo engine="devin" size={14} className={styles.logo} />
                <Battery left={devinLeft} level={devinLevel} vertical />
              </>
            )}
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
