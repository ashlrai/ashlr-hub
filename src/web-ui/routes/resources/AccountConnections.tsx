import type { ResourceAccountConnection, ResourceConnectionsSnapshot } from '../../../core/resources/connection-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { resourceTime } from './CapacityBoard.js';
import { summarizeAccountUsage } from './account-usage-summary.js';
import styles from './AccountConnections.module.css';

const PROVIDERS = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok' } as const;

function timestamp(value: string | null): number {
  return value === null ? NaN : Date.parse(value);
}

function planLabel(value: string | null): string {
  // Provider diagnostics and new plan identifiers must not become arbitrary UI text.
  switch (value?.toLowerCase()) {
    case 'free': return 'Free';
    case 'go': return 'Go';
    case 'plus': return 'Plus';
    case 'pro': return 'Pro';
    case 'prolite': return 'Pro Lite';
    case 'max': return 'Max';
    case 'team': return 'Team';
    case 'business': return 'Business';
    case 'self_serve_business_usage_based': return 'Business (usage-based)';
    case 'enterprise': return 'Enterprise';
    case 'enterprise_cbp_usage_based': return 'Enterprise (usage-based)';
    case 'edu': return 'Education';
    case 'supergrok': return 'SuperGrok';
    case 'supergrok heavy':
    case 'supergrokheavy': return 'SuperGrok Heavy';
    case 'supergrok pro':
    case 'supergrokpro': return 'SuperGrok Pro';
    case 'supergrok plus':
    case 'supergrokplus': return 'SuperGrok Plus';
    case 'supergrok lite':
    case 'supergroklite': return 'SuperGrok Lite';
    case 'grokpro': return 'Grok Pro';
    case 'xpremiumplus': return 'X Premium+';
    case 'xpremium': return 'X Premium';
    case 'xbasic': return 'X Basic';
    default: return 'Plan not reported';
  }
}

function windowLabel(provider: ResourceAccountConnection['provider'], id: string): string {
  if (id === 'five_hour' || id === 'five-hour') return '5-hour window';
  if (id === 'seven_day' || id === 'seven-day') return '7-day window';
  if (provider === 'claude' && /^seven_day_(sonnet|opus|fable)$/.test(id)) {
    const model = id.slice('seven_day_'.length);
    return `7-day window · ${model[0]!.toUpperCase()}${model.slice(1)}`;
  }
  if (id === 'weekly') return 'Weekly window';
  if (id === 'monthly') return 'Monthly window';
  if (provider === 'codex') {
    const match = /^codex_(.+)_(primary|secondary)$/.exec(id);
    if (match) return `${match[1] === 'codex' ? '' : `${match[1]!.replaceAll('_', ' ')} `}${match[2] === 'primary' ? 'Primary' : 'Secondary'} window`;
    if (id === 'primary' || id === 'secondary') return `${id === 'primary' ? 'Primary' : 'Secondary'} window`;
  }
  if (provider === 'grok') {
    const match = /^grok_(credits|unified|build)(?:_(weekly|monthly))?$/.exec(id);
    if (match) {
      const scope = match[1] === 'unified' ? 'shared quota' : match[1] === 'build' ? 'build quota' : 'credits quota';
      return match[2] ? `${match[2] === 'weekly' ? 'Weekly' : 'Monthly'} ${scope}` : scope[0]!.toUpperCase() + scope.slice(1);
    }
  }
  // Primary/secondary encode order, not duration. Unknown native IDs remain
  // identifiable rather than gaining an invented rolling window or allowance.
  return id;
}

function missingQuotaAction(account: ResourceAccountConnection, current: boolean): string | null {
  if (account.reason === 'connection-monitor-stopped') return 'The connection monitor stopped. Restart the scoped console to collect a new sample.';
  if (account.provider === 'claude' && account.reason === 'usage-version-unsupported') return 'This Claude version has not been verified for automatic usage reads. Check /usage in the native client; Hub will not send an unverified command.';
  if (account.provider === 'claude' && account.reason === 'usage-account-changed') return 'The native account changed. Verify the intended profile and restart the scoped console before collecting usage.';
  if (account.provider === 'claude' && ['usage-output-invalid', 'usage-process-failed', 'usage-identity-unavailable'].includes(account.reason)) {
    return 'Claude’s native usage report could not be verified. Check /usage in the intended native account; Hub will not estimate allowance.';
  }
  if (account.provider === 'claude' && current && account.authentication === 'signed-in' && account.reason === 'status-login-observed') {
    return 'Native auth status confirms sign-in but does not report allowance. Check usage in this account’s native Claude session.';
  }
  if (['probe-quota-invalid', 'probe-protocol-unsupported'].includes(account.reason)) {
    return 'Native usage metadata could not be read. Check usage in the native client; this view has no verified allowance.';
  }
  return null;
}

function referenceDifference(used: number, ceiling: number): string {
  const difference = Math.round(Math.abs(ceiling - used) * 100) / 100;
  return difference === 0 ? `At the ${ceiling}% reference ceiling`
    : `${difference} percentage ${difference === 1 ? 'point' : 'points'} ${used < ceiling ? 'below' : 'above'} the ${ceiling}% reference`;
}

function AccountRow({ account, sampledAt, historical, ceiling }: {
  account: ResourceAccountConnection; sampledAt: string; historical: boolean; ceiling: number | null;
}) {
  const sampled = timestamp(sampledAt);
  const observed = timestamp(account.observedAt);
  const expires = timestamp(account.expiresAt);
  const fresh = !historical && Number.isFinite(sampled) && Number.isFinite(observed) && Number.isFinite(expires)
    && observed <= sampled && expires > sampled;
  // A previous successful sample cannot turn a failed or in-progress check green.
  const current = fresh && (account.state === 'observed' || account.state === 'signed-out');
  const signedIn = current && account.authentication === 'signed-in' && account.state === 'observed';
  const signedOut = current && account.authentication === 'signed-out';
  const reachable = current && account.health === 'reachable';
  const freshness = historical ? 'Historical snapshot' : account.state === 'checking' ? 'Checking connection'
    : account.state === 'unavailable' ? 'Check unavailable' : !fresh ? 'Evidence expired or missing'
      : account.provider === 'claude' ? 'Fresh sign-in observation' : 'Fresh observation';
  const provider = PROVIDERS[account.provider];
  const executionIntegrated = account.provider !== 'grok' && account.executionSupported;
  const missingAction = missingQuotaAction(account, current);
  const usageSummary = summarizeAccountUsage(account, { sampledAt, ceilingPercent: ceiling, historical });

  return <li className={styles.account} aria-label={`${account.label} connection`} data-current={current}>
    <div className={styles.identity}>
      <h3>{account.label}</h3>
      <p>{provider} <span aria-hidden="true">·</span> {planLabel(account.planType)}</p>
      <span className={styles.adapter}>{executionIntegrated ? 'Hub transport available' : 'Execution not integrated'}</span>
      <div className={styles.connection}>
      <span className={styles.caption}>Native account</span>
      <div className={styles.badges}>
        <StatusBadge status={signedIn ? 'Signed in' : signedOut ? 'Sign-in required' : 'Sign-in unverified'}
          tone={signedIn ? 'info' : signedOut ? 'warning' : 'unknown'} />
        <StatusBadge status={reachable ? 'Metadata reachable' : account.health === 'unavailable' ? 'Metadata unavailable' : 'Health unverified'}
          tone={reachable ? 'info' : 'unknown'} />
      </div>
      <p>{signedOut ? 'Sign in through this account’s native launcher, then wait for a new check.'
        : account.state === 'checking' ? 'A metadata check is in progress; no task is being started.'
          : !current ? 'Current sign-in and connection health are not established.'
            : 'Sign-in metadata is not proof of task readiness.'}</p>
      {account.provider === 'grok' ? <p>Grok metadata does not enable Hub execution.</p> : null}
      {account.onDemandEnabled !== null ? <p className={account.onDemandEnabled ? styles.warning : undefined}>
        {current ? '' : 'Last reported: '}{account.onDemandEnabled ? 'On-demand billing enabled' : 'On-demand billing disabled'}</p> : null}
      </div>
    </div>
    <div className={styles.quotas} aria-label={`${account.label} reported usage`}>
      <span className={styles.caption}>{current ? 'Reported usage' : 'Last reported usage'}</span>
      <section className={styles.window} aria-label={`${account.label} account reference summary`}>
        <span className={styles.caption}>Account reference summary</span>
        {usageSummary.state === 'known' && usageSummary.headroomPercent !== null && ceiling !== null ? <>
          <strong className={usageSummary.atOrAboveCeiling ? styles.overReference : styles.comparison}>
            {usageSummary.atOrAboveCeiling ? `No margin below the ${ceiling}% reference.`
              : usageSummary.headroomPercent === 0 ? `Less than 0.01 percentage point below the ${ceiling}% reference across reported windows.`
                : `${usageSummary.headroomPercent} percentage ${usageSummary.headroomPercent === 1 ? 'point' : 'points'} below the ${ceiling}% reference across reported windows.`}
          </strong>
          <p>Most-used {usageSummary.limitingWindowIds.length === 1 ? 'window' : 'windows'}: {usageSummary.limitingWindowIds.map((id) => windowLabel(account.provider, id)).join(' · ')}.</p>
          <p>Reference comparison only; not dispatch eligibility or a token allowance.</p>
        </> : <p>Account reference summary unavailable: verified usage, freshness and a saved reference are required for every window.</p>}
      </section>
      {account.windows.some((window) => window.nativeReport) ? <p className={styles.quotaAction}>
        Native /usage report. Percentages are rounded down and may be cached. Quota freshness is unverified; not used for dispatch or ceiling comparison.</p> : null}
      {account.windows.length ? account.windows.map((window) => {
        const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
          && window.usedPercent >= 0 && window.usedPercent <= 100 ? window.usedPercent : null;
        const resetPassed = timestamp(window.resetsAt) <= sampled;
        const windowCurrent = signedIn && !window.nativeReport && Number.isFinite(timestamp(window.resetsAt)) && !resetPassed;
        const label = windowLabel(account.provider, window.id);
        const compare = windowCurrent && used !== null && ceiling !== null;
        return <div key={window.id} className={styles.window}>
          <div className={styles.windowHeading}><span title={window.id}>{label}</span><strong>{used === null ? 'Unknown' : `${window.nativeReport ? '≈ ' : ''}${used}% used`}</strong></div>
          {used === null ? <div className={styles.unknownMeter} aria-hidden="true" />
            : <div className={styles.track} data-over-reference={compare && used > ceiling}>
              <meter className={styles.meter} data-historical={!windowCurrent} min={0} max={100} value={used}
                aria-label={`${account.label} ${label} ${windowCurrent ? 'reported' : 'last reported'} usage`} />
              {compare ? <><span className={styles.referenceRegion} aria-hidden="true" style={{ left: `${ceiling}%`, width: `${100 - ceiling}%` }} />
                <span className={styles.referenceTick} aria-hidden="true" style={{ left: `${ceiling}%` }} /></> : null}
            </div>}
          {ceiling !== null && !window.nativeReport ? <p className={compare && used >= ceiling ? styles.overReference : styles.comparison}>
            {compare ? referenceDifference(used, ceiling) : 'Reference comparison unavailable until quota and freshness are known.'}</p> : null}
          <p>Resets: {window.nativeReport ? window.nativeReport.resetDescription ?? 'Not reported by native client' : resourceTime(window.resetsAt)}</p>
          {resetPassed ? <p>Reset passed; a new quota sample is needed.</p> : null}
        </div>;
      }) : <div className={styles.window}><strong>Quota unknown</strong><div className={styles.unknownMeter} aria-hidden="true" />
        <p>No quota windows reported. Available capacity is not established.</p>
        {missingAction ? <p className={styles.quotaAction}>{missingAction}</p> : null}</div>}
    </div>
    <div className={styles.freshness}>
      <span className={styles.caption}>{account.provider === 'claude' ? 'Sign-in evidence' : 'Evidence'}</span>
      <StatusBadge status={freshness} tone={current ? 'neutral' : 'unknown'} />
      <dl><div><dt>Observed</dt><dd>{resourceTime(account.observedAt)}</dd></div>
        <div><dt>Expires</dt><dd>{resourceTime(account.expiresAt)}</dd></div></dl>
    </div>
  </li>;
}

/** Presentation only: the resource desk owns polling; native login stays outside the browser. */
export function AccountConnections({ connections, historical = false, ceilingPercent }: {
  connections: ResourceConnectionsSnapshot | null | undefined; historical?: boolean; ceilingPercent?: number | null;
}) {
  if (!connections) return null;
  const ceiling = !historical && typeof ceilingPercent === 'number' && Number.isSafeInteger(ceilingPercent)
    && ceilingPercent >= 0 && ceilingPercent <= 100 ? ceilingPercent : null;
  return <section className={styles.panel} aria-label="Account connections">
    <header className={styles.heading}><div><h2>Account connections</h2>
      <p>Native sign-in and usage, separate from worker admission.</p></div>
      <span className={styles.refresh}>{historical ? 'Last successful console read' : connections.refreshing ? 'Checking account metadata…' : `Sampled ${resourceTime(connections.sampledAt)}`}</span></header>
    {ceiling !== null ? <div className={styles.referenceLegend}><span className={styles.legendTick} aria-hidden="true" />
      <strong>{ceiling}% saved pool reference</strong><span>{100 - ceiling}% personal headroom target</span>
      <span>Comparison only, not account dispatch eligibility.</span></div> : null}
    {connections.accounts.length ? <ul className={styles.accounts}>{connections.accounts.map((account) =>
      <AccountRow key={account.id} account={account} sampledAt={connections.sampledAt} historical={historical} ceiling={ceiling} />)}</ul>
      : <p className={styles.empty}>No accounts configured for connection checks.</p>}
    <p className={styles.note}>Names are operator labels, not verified identities. Accounts may share allowances; percentages are not added together.
      {' '}Transport availability does not mean a worker is enrolled or ready to execute.</p>
  </section>;
}
