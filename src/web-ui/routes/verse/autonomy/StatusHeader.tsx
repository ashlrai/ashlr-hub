/**
 * routes/verse/autonomy/StatusHeader.tsx — the five questions the cockpit has
 * to answer before the operator reads anything else: is it running, what is it
 * doing, what has it spent, when does it move next, and is the leash on.
 *
 * Epistemic rule enforced here: the daemon's run state is only stated when
 * `sourceQuality` says the observation is healthy AND complete. A degraded
 * read renders "unknown" — never "stopped", which would read as a fact.
 * The kill switch outranks everything: while it is engaged the header says so
 * regardless of what the daemon ledger claims.
 */
import { isKnown } from '../../../components/primitives/Epistemic.js';
import type { VerseControlSnapshot } from './control-types.js';
import { budgetMeter, countdownLabel, describeTickOutcome, formatInterval, formatRelative, formatStamp, nextTickAt, UNKNOWN } from './format.js';
import { useNow } from './use-ticker.js';
import styles from './autonomy.module.css';

export type RunState = 'running' | 'stopped' | 'unknown' | 'killed';

export function runStateOf(snapshot: VerseControlSnapshot): { state: RunState; label: string } {
  // "Kill switch engaged", not "Emergency stop engaged". The sentinel has two
  // authors — the Emergency stop button and the ordinary `Stop loop`, which
  // `stopDaemon()` implements as `setKill(true)` — and the snapshot cannot
  // tell them apart. Naming the switch rather than the button states the fact
  // both paths share instead of accusing an operator who only pressed Stop.
  if (snapshot.killSwitch?.state === 'active') return { state: 'killed', label: 'Kill switch engaged' };
  const daemon = snapshot.daemon;
  if (!daemon || !isKnown(daemon.sourceQuality)) return { state: 'unknown', label: 'Run state unknown' };
  if (daemon.runtimeState === 'running') return { state: 'running', label: 'Running' };
  if (daemon.runtimeState === 'stopped') return { state: 'stopped', label: 'Stopped' };
  return { state: 'unknown', label: 'Run state unknown' };
}

export function StatusHeader({ snapshot }: { snapshot: VerseControlSnapshot }) {
  const now = useNow(1000);
  const { state, label } = runStateOf(snapshot);
  const daemon = snapshot.daemon;
  const observed = isKnown(daemon?.sourceQuality);

  const lastTick = daemon?.ticks?.[daemon.ticks.length - 1] ?? null;
  const outcome = describeTickOutcome(lastTick?.reason);
  const directionMode = snapshot.fleet?.directionMode ?? lastTick?.directionMode ?? null;

  // The enrollment registry arrives as `scope.repos`; a missing scope block is
  // unknown (UNKNOWN), which is not the same as an enrolled-zero registry.
  const repos = snapshot.scope?.repos ?? null;

  const interval = snapshot.caps?.intervalMs ?? null;
  const next = state === 'running' ? nextTickAt(daemon?.lastTickAt, interval) : null;
  // `spend.todayUsd` belongs to `spend.todayDate`, and the daemon writes that
  // figure once a day and leaves it there. Handing the meter the date lets it
  // say "nothing recorded today" instead of presenting a three-week-old ledger
  // day as today's spend. When only the legacy daemon observation exists there
  // is no date to check, so it is passed as null and the meter behaves as before.
  const spend = snapshot.spend;
  const budget = spend
    ? budgetMeter(spend.todayUsd, snapshot.caps?.dailyBudgetUsd ?? null, spend.todayDate)
    : budgetMeter(daemon?.todaySpentUsd ?? null, snapshot.caps?.dailyBudgetUsd ?? null, null);

  return (
    <section className={styles.status} aria-label="Autonomy status">
      <div className={styles.statusTop}>
        <span className={styles.runState} data-state={state}>
          <span className={styles.runDot} aria-hidden="true" />
          {label}
        </span>
        <div className={styles.facts}>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Direction</span>
            <span className={styles.factValue}>{directionMode ?? 'default'}</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Last tick</span>
            <span className={styles.factValue} data-tone={outcome.tone}>
              {/* formatStamp: a loop idle since yesterday must not show a bare "03:12:44" as if it ticked today. */}
              {observed && daemon?.lastTickAt ? `${formatStamp(daemon.lastTickAt)} · ${outcome.label}` : outcome.label}
            </span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Next tick</span>
            <span className={styles.factValue}>
              {state === 'running' ? countdownLabel(next, now) : state === 'killed' ? 'blocked' : 'not scheduled'}
            </span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Interval</span>
            <span className={styles.factValue}>{formatInterval(interval)}</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Scope</span>
            <span className={styles.factValue} data-tone={(repos?.length ?? 0) === 0 ? 'warning' : undefined}>
              {repos ? `${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}` : UNKNOWN}
            </span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Awaiting you</span>
            <span className={styles.factValue}>
              {typeof snapshot.pendingApprovals === 'number'
                ? `${snapshot.pendingApprovals} ${snapshot.pendingApprovals === 1 ? 'approval' : 'approvals'}`
                : UNKNOWN}
            </span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Started</span>
            <span className={styles.factValue}>{observed ? formatRelative(daemon?.startedAt) : UNKNOWN}</span>
          </div>
        </div>
      </div>

      <div className={styles.budget}>
        <div className={styles.budgetLine}>
          <span className={styles.budgetLabel}>{budget.label}</span>
          <span className={styles.budgetNote}>{budget.note}</span>
        </div>
        <div
          className={styles.meter}
          data-state={budget.state}
          role="meter"
          aria-label="Today's spend against the daily budget"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={budget.percent ?? undefined}
          aria-valuetext={`${budget.label}. ${budget.note}`}
        >
          <div className={styles.meterFill} style={{ width: `${budget.percent ?? 0}%` }} />
        </div>
      </div>
    </section>
  );
}
