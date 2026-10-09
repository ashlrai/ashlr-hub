import { useId, useState } from 'react';
import { formatDecimalMetric } from '../../../components/charts/format-metric.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useNow } from '../autonomy/use-ticker.js';
import { apiGrantDisplay, apiGrantUsdDecimal, creditPoolDisplay } from './credit-pool-model.js';
import { creditPoolsQuery } from './credit-pools-query.js';
export { creditPoolsQuery, narrowCreditPoolsEnvelope } from './credit-pools-query.js';
import styles from './credit-pools.module.css';

function CreditPoolReading({ accountNames }: { accountNames: ReadonlyMap<string, string> }) {
  const reading = useQuery(creditPoolsQuery, { freshMs: 15_000 });
  const refetch = useRefetch(creditPoolsQuery);
  const [openedAt] = useState(() => Date.now());
  const now = useNow(2_000);
  const value = reading.data?.value;
  usePollWhileVisible(refetch, value?.state === 'warming' && now - openedAt < 30_000 ? 2_000 : 15_000);
  const pools = value?.pools;
  const apiGrants = value?.v === 2 ? value.apiGrants : null;
  if (!pools && !apiGrants) return <p className={styles.note}>{reading.data?.reason ?? (value?.state === 'unavailable'
    ? 'Credit balance records are unavailable. Balances are unknown.' : 'Reading recorded credit balances…')}</p>;
  return <div className={styles.body}>
    {!pools ? <p className={styles.note}>Reading other recorded credit balances…</p> : pools.sourceState !== 'healthy' || !pools.rows.length ? <p className={styles.note}>
      {pools.sourceState === 'unavailable' ? 'The credit balance record could not be read. Balances are unknown.'
        : 'No verified credit balance records yet. Balances are unknown.'}</p> : <ul className={styles.rows}>
      {pools.rows.map(row => {
        const display = creditPoolDisplay(row, now);
        return <li key={`${row.provider}:${row.accountId}:${row.poolId}`}>
          <div className={styles.heading}><strong>{display.title}</strong><span>{accountNames.get(row.accountId) ?? row.accountId}</span></div>
          <p className={styles.amount} title={row.amount === null ? undefined : `Recorded reading: ${display.amountText}`}>{display.amountText}</p>
          {row.total !== null && row.identityState === 'matched' ? <p className={styles.note} title={`Recorded total: ${formatDecimalMetric(row.total)} USD`}>Recorded {row.kind === 'gifted-cloud' ? 'grant' : 'total'}: ${formatDecimalMetric(row.total)}</p> : null}
          <p className={styles.note}>{display.sourceText}</p>
          <p className={styles.note}>Captured <time dateTime={display.capturedAt} title={display.capturedAt}>{new Date(display.capturedAt).toLocaleString()}</time></p>
          <p className={styles.note}>{display.expiryText}{display.expiresAt ? <> · <time dateTime={display.expiresAt} title={display.expiresAt}>{new Date(display.expiresAt).toLocaleString()}</time></> : null}</p>
          <p className={styles.note}>{display.scopeText}</p>
        </li>;
      })}
    </ul>}
    {apiGrants ? apiGrants.state !== 'healthy' || !apiGrants.rows.length ? <p className={styles.note}>
      API promotional balance records are unavailable. Balances are unknown.</p> : <ul className={styles.rows}>
      {apiGrants.rows.map((row, index) => {
        const display = apiGrantDisplay(row);
        return <li key={`api-promotion:${index}`}>
          <div className={styles.heading}><strong>Claude API promotion</strong><span>API credits</span></div>
          <p className={styles.amount} title={row.remainingUsdMicros === null ? undefined : `Recorded balance: ${display.amountText.replace(' last recorded', '')}`}>{display.amountText}</p>
          {row.totalUsdMicros !== null ? <p className={styles.note} title={`Recorded grant: ${formatDecimalMetric(apiGrantUsdDecimal(row.totalUsdMicros))} USD`}>Recorded API grant: ${formatDecimalMetric(apiGrantUsdDecimal(row.totalUsdMicros))}</p> : null}
          {row.capturedAt ? <p className={styles.note}>Captured <time dateTime={row.capturedAt} title={row.capturedAt}>{new Date(row.capturedAt).toLocaleString()}</time></p> : null}
          <p className={styles.note}>{display.expiryText}</p>
          {row.admissionCutoff ? <p className={styles.note}>Phantom stops new API work {row.cutoffPolicy === 'expiry-day-start/v1' ? 'at the start of the expiry date (UTC)' : 'at the verified expiry time'}.
            <time dateTime={row.admissionCutoff} title={row.admissionCutoff}> {new Date(row.admissionCutoff).toLocaleString()}</time></p> : null}
          <p className={styles.note}>Automatic use held · billing, account binding and signed API authority need verification.</p>
        </li>;
      })}
    </ul> : null}
    {value?.state === 'stale' ? <p className={styles.note}>Showing the last reading while it refreshes.</p> : null}
    <p className={styles.note}>Subscription windows, API promotions, cloud gifts and purchased credits are separate. Recorded balances do not establish current spendability.</p>
    <Button size="sm" variant="ghost" onClick={refetch}>Refresh balances</Button>
  </div>;
}
/** This disclosure shares its recorded-balance cache with the visible resource bar. */
export function CreditPools({ accountNames = new Map() }: { accountNames?: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return <details className={styles.panel} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary id={titleId}>Credit balances <span>API promotions, gifts and purchased credits</span></summary>
    {open ? <CreditPoolReading accountNames={accountNames} /> : null}
  </details>;
}
