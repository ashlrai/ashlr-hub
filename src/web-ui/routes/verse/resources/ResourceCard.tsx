/**
 * routes/verse/resources/ResourceCard.tsx — one paid account in the Resources
 * drawer (unit 3.11 C6):
 *
 *   [C] Claude Max · max
 *       ● Spent · resets Sat 11:46 PM · usable again in 1d 7h
 *       checked 2m ago
 *       5-hour  ▇▇▇▇▇▇▇▇▇▇▇▇│▨▨  limit reached
 *               resets Sat 11:46 PM
 *       Weekly  ▇▇▇▇░░░░░░░░       40%
 *       Reserved for you 40% · balanced mode
 *       [Check again]
 *
 * Every word comes from the shared capacity projection — `accountStatus` for
 * the status line, the row's windows for the meters (resets already worded by
 * `describeResetAt`), `usedPercentText` for every percent, `accountActions`
 * for what the account needs — so this card and Apps & Accounts can never
 * disagree about one seat. Text wraps at word boundaries; anything long also
 * carries its full text as a tooltip.
 */
import { estimatedCreditValue, CODEX_CREDIT_VALUE_SOURCE, CODEX_CREDIT_VALUE_CHECKED } from './codex-credit-value.js';
import type { BudgetMode } from '../../../../core/routing/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { accountActions, type AccountAction } from '../apps/apps-model.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { usedPercentText } from '../percent-text.js';
import { windowSentence, type AccountStatus, type CapacityRow, type CapacityWindowRow } from '../usage/capacity-strip-model.js';
import type { ResourceReadinessRow } from '../../../../core/routing/readiness-types.js';
import { ReadinessLines } from './ReadinessLines.js';
import { ResourceFacts } from './ResourceFacts.js';
import type { ResourceFactsView } from './resources-model.js';
import { SchedulingEvidence } from './SchedulingEvidence.js';
import type { SchedulingEvidenceView } from './scheduling-model.js';
import styles from './ResourcesDrawer.module.css';
import { lazy, Suspense } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
const ResetSpendingAccountControl = lazy(() => import('../budget/ResetSpendingControl.js').then(module => ({ default: module.ResetSpendingAccountControl })));

/** Above this share of a window the meter turns amber (the capacity strip's own line). */
const TIGHT_AT = 90;

const MODE_WORD: Readonly<Record<BudgetMode, string>> = {
  'all-in': 'all-in mode',
  balanced: 'balanced mode',
  reserve: 'reserve mode',
};

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function StatusLine({ status }: { status: AccountStatus }) {
  const parts = [status.detail, status.usableAgain].filter((p): p is string => p !== null && p.length > 0);
  const full = [status.label, ...parts].join(' · ');
  return (
    <p className={styles.status} data-tone={status.tone} data-status={status.kind} title={full}>
      <span className={styles.statusDot} aria-hidden="true" />
      <span>
        <span className={styles.statusLabel}>{status.label}</span>
        {parts.map((p) => (
          <span key={p} className={styles.statusDetail}>{` · ${p}`}</span>
        ))}
      </span>
    </p>
  );
}

function WindowMeter({ row, w, reservePercent }: { row: CapacityRow; w: CapacityWindowRow; reservePercent: number | null }) {
  const sentence = windowSentence(row, w, w.binding ? reservePercent : null);
  const ceiling = w.binding && reservePercent !== null && reservePercent > 0 ? 100 - clamp(reservePercent) : null;
  const label = w.label.replace(/ window$/, '');
  let level: 'ok' | 'tight' | 'limit' | 'unknown';
  let value: string;
  let used = 0;
  if (w.limitReached) {
    level = 'limit';
    value = 'limit reached';
    used = 100;
  } else if (w.usedPercent === null) {
    level = 'unknown';
    value = 'no reading';
  } else {
    used = clamp(w.usedPercent);
    level = used >= TIGHT_AT ? 'tight' : 'ok';
    value = usedPercentText(w.usedPercent);
  }
  return (
    <div className={styles.meter} data-binding={w.binding || undefined} data-level={level}>
      <span className={styles.meterLabel} title={w.label}>{label.charAt(0).toUpperCase() + label.slice(1)}</span>
      <span className={styles.meterTrack} role="img" aria-label={sentence} data-unknown={level === 'unknown' || undefined}>
        {ceiling !== null ? <span className={styles.meterReserve} style={{ left: `${ceiling}%`, width: `${100 - ceiling}%` }} /> : null}
        {level !== 'unknown' ? <span className={styles.meterFill} style={{ width: `${used}%` }} /> : null}
        {ceiling !== null ? <span className={styles.meterTick} style={{ left: `${ceiling}%` }} /> : null}
      </span>
      <span className={styles.meterValue} aria-hidden="true">{value}</span>
      {w.resetText !== null ? <span className={styles.meterReset} title={w.resetText} aria-hidden="true">{w.resetText}</span> : null}
    </div>
  );
}

export interface ResourceCardProps {
  row: CapacityRow;
  /** Worded against the drawer's clock, with any running check applied. */
  status: AccountStatus;
  /** The status with no check applied, so a button does not vanish while its own check runs. */
  settled: AccountStatus;
  mode: BudgetMode | null;
  busy: { seatId: string; kind: AccountAction['kind'] } | null;
  onAction: (row: CapacityRow, action: AccountAction) => void;
  /**
   * This account's row of GET /api/verse/budget/readiness (3.14). Its
   * reconnect / check-again fixes are NOT repeated here — `accountActions`
   * already offers them below — only a literal command is.
   */
  readiness?: ResourceReadinessRow | null;
  /** 3.15: tier · cost basis · models — the facts row every card carries. */
  facts?: ResourceFactsView | null;
  scheduling?: SchedulingEvidenceView;
  resetBudget?: BudgetView | null;
  resetNowMs?: number;
  onReviewGrant?: () => void;
}

export function ResourceCard({ row, status, settled, mode, busy, onAction, readiness = null, facts = null, scheduling, resetBudget = null, resetNowMs = Date.now(), onReviewGrant }: ResourceCardProps) {
  // Budget editing lives in Apps & Accounts; the drawer offers what the seat needs now.
  const actions = accountActions(row, settled).filter((a) => a.kind !== 'edit-budget');
  const reserve = row.reserve;
  const primaryWindow = row.windows.find((w) => w.binding) ?? row.windows[0] ?? null;
  const otherWindows = row.windows.filter((w) => w !== primaryWindow);
  const reserveText = reserve === null ? null : reserve.percent !== null && mode !== null ? `${reserve.label} · ${MODE_WORD[mode]}` : reserve.label;
  return (
    <li className={styles.card} data-status={status.kind} data-seat={row.seatId} data-verse-anchor={`resources:${row.seatId}`}>
      <div className={styles.cardHead}>
        <MonogramTile monogram={row.monogram} engine={row.engine} size="sm" />
        <h4 className={styles.cardName}>
          <span title={row.label}>{row.label}</span>
          {row.plan !== null ? <span className={styles.plan}>{row.plan}</span> : null}
        </h4>
      </div>
      <StatusLine status={status} />
      {row.credits !== null ? <p className={styles.subtle}>{row.credits}</p> : null}
      {status.checked !== null ? (
        <p className={styles.stamp} title={status.checkedTitle ?? undefined}>{status.checked}</p>
      ) : null}
      {row.windows.length > 0 ? (
        <div className={styles.meters}>
          {primaryWindow !== null ? <WindowMeter row={row} w={primaryWindow} reservePercent={reserve?.percent ?? null} /> : null}
        </div>
      ) : <p className={styles.subtle}>Usage not reported by this resource.</p>}
      {row.lastReading ? <p className={styles.subtle}>Last known usage · latest check failed.</p> : null}
      {row.windows.length === 0 && row.historicalUsage && !row.signedOut ? <div className={styles.fine}>
        <p>Last known usage · current availability unconfirmed.</p>
        <p>Recorded <time dateTime={row.historicalUsage.observedAt} title={row.historicalUsage.observedAt}>{new Date(row.historicalUsage.observedAt).toLocaleString()}</time></p>
        {row.historicalUsage.windows.map(window => <p key={window.id}>{window.id}: {window.limitReached ? 'limit was flagged' : window.usedPercent === null ? 'usage unknown' : `${usedPercentText(window.usedPercent)} used`}
          {window.resetsAt ? <> · recorded reset <time dateTime={window.resetsAt} title={window.resetsAt}>{new Date(window.resetsAt).toLocaleString()}</time></> : null}</p>)}
      </div> : null}
      <details className={styles.usageDetails}>
        <summary tabIndex={0} aria-label={`Usage details: ${row.label}`}>Usage details</summary>
        <div className={styles.usageDetailBody}>
          {facts !== null ? <ResourceFacts facts={facts} /> : null}
          {scheduling ? <SchedulingEvidence view={scheduling} /> : null}
          {otherWindows.length > 0 ? <div className={styles.meters}>{otherWindows.map((w) => <WindowMeter key={w.id} row={row} w={w} reservePercent={reserve?.percent ?? null} />)}</div> : null}
          {row.windows.length === 0 ? <p className={styles.subtle}>Connection status and usage are separate. No percentage has been supplied.</p> : null}
          {row.engine === 'codex' && row.creditState !== undefined && row.creditState !== 'unknown' ? <p className={styles.subtle}>
            {row.creditState === 'none' ? 'Native provider reports no available credits. ' : ''}
            {row.creditBalance !== null && row.creditBalance !== undefined ? `Native balance ${row.creditBalance} credit units. ` : ''}
            Estimated credit value: {estimatedCreditValue(row.creditBalance, row.plan) ?? 'unknown'}.
            {' '}Personal-plan reference $0.04 per credit; not actual purchase price or attributed spend.
            {' '}<a href={CODEX_CREDIT_VALUE_SOURCE} target="_blank" rel="noreferrer">Published reference</a> checked {CODEX_CREDIT_VALUE_CHECKED}.
          </p> : null}
          {row.notes.map((note) => <p key={note} className={styles.subtle}>{note}</p>)}
          {reserveText !== null || row.credits !== null ? (
            <p className={styles.reserveLine}>
              {reserveText !== null ? <span title={reserve?.why}>{reserveText}</span> : null}
              {reserveText !== null && row.credits !== null ? ' · ' : null}
              {row.credits !== null ? <span>{row.credits}</span> : null}
            </p>
          ) : null}
        </div>
      </details>
      <ReadinessLines row={readiness} />
      {resetBudget?.resetSpendingStatus ? <Suspense fallback={null}>
        <ResetSpendingAccountControl view={resetBudget} nowMs={resetNowMs} seatId={row.seatId} label={row.label} onReviewGrant={onReviewGrant} />
      </Suspense> : null}
      {actions.length > 0 ? (
        <div className={styles.cardActions}>
          {actions.map((action) => (
            <Button
              key={action.kind}
              size="sm"
              variant={action.primary ? 'primary' : 'ghost'}
              busy={busy?.seatId === row.seatId && busy.kind === action.kind}
              aria-label={`${action.kind === 'fix' ? 'Fix in Apps' : action.label}: ${row.label}`}
              onClick={() => onAction(row, action)}
            >
              {action.kind === 'fix' ? 'Fix in Apps' : action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
