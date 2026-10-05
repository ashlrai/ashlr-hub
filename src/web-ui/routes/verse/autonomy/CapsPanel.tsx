/**
 * routes/verse/autonomy/CapsPanel.tsx — operator preferences, the
 * live usage against it, and an inline edit that commits on blur or Enter.
 *
 * Three behaviours the contract calls out explicitly:
 *  - **Validate before the round trip.** caps-spec.ts mirrors the server's
 *    ranges, so a bad value is refused inline instead of costing a 400.
 *  - **"Applied live" means applied live.** The daemon re-reads config each
 *    tick, so a committed cap takes effect without a restart; the confirmation
 *    says so, and clears on the next edit rather than lingering.
 *  - **A daily budget of 0 reads as "stopped".** Never as "unlimited". The
 *    usage line under the budget field says it in words as well as in the
 *    header's meter.
 *
 * Live usage is shown ONLY where the number is genuinely observable. Per-tier
 * concurrency has no live signal, so it gets no usage line — an invented
 * "0 / 8" would be worse than silence.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CAP_FIELDS,
  automaticCountsPatch,
  isCountCapKey,
  isUncappedCount,
  FOUNDRY_LIMIT_MAX_RANGE,
  capPatch,
  readCap,
  validateCap,
  validateFoundryMax,
  type CapFieldSpec,
  type CapKey,
} from './caps-spec.js';
import { updateVerseCaps } from './control-queries.js';
import { GoalPreferencesPanel } from './GoalPreferencesPanel.js';
import { LeaderPreferencesPanel } from './LeaderPreferencesPanel.js';
import { engineQuotaStanding, VERSE_UNCAPPED_COUNT_KEYS } from './control-types.js';
import type { VerseCaps, VerseControlSnapshot, VerseFoundryLimit } from './control-types.js';
import { budgetMeter, formatAge, formatCount, formatUsd } from './format.js';
import type { GuardedAction } from './use-guarded-action.js';
import styles from './autonomy.module.css';

export interface CapsPanelProps {
  caps: VerseCaps;
  snapshot: VerseControlSnapshot;
  guard: GuardedAction;
  dispatchEnabled: boolean;
}

/** What is actually measurable against each cap right now. */
function usageFor(key: CapKey, caps: VerseCaps, snapshot: VerseControlSnapshot): string | null {
  const daemon = snapshot.daemon;
  const lastTick = daemon?.ticks?.[daemon.ticks.length - 1] ?? null;
  switch (key) {
    case 'dailyBudgetUsd': {
      const cap = caps.dailyBudgetUsd;
      if (cap === 0) return 'Loop stopped ($0 budget).';
      // Same honesty rule as the status header: `todayUsd` belongs to
      // `todayDate`, and a ledger day that is not today says nothing about
      // today. budgetMeter owns that comparison for both surfaces.
      const spend = snapshot.spend;
      const meter = spend
        ? budgetMeter(spend.todayUsd, cap, spend.todayDate)
        : budgetMeter(daemon?.todaySpentUsd ?? null, cap, null);
      if (meter.state === 'unknown') return meter.note;
      return `${formatUsd(spend ? spend.todayUsd : (daemon?.todaySpentUsd ?? null))} spent today`;
    }
    case 'perTickItems':
      return lastTick ? `${formatCount(lastTick.itemsConsidered)} considered on the last tick` : null;
    case 'parallel':
      return lastTick?.dispatches ? `${lastTick.dispatches.length} dispatched on the last tick` : null;
    case 'intervalMs':
      return daemon?.lastTickAt ? `last tick ${formatAge(daemon.lastTickAt)} ago` : null;
    default:
      return null;
  }
}

export function CapsPanel({ caps, snapshot, guard, dispatchEnabled }: CapsPanelProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const current = useRef({ caps, dispatchEnabled, readOnly: guard.readOnly });
  current.current = { caps, dispatchEnabled, readOnly: guard.readOnly };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = !dispatchEnabled || guard.readOnly || guard.busy || guard.tokenOpen;

  function commit(id: string, reason: string, run: () => Promise<unknown>) {
    if (locked || running.current) return;
    setActiveKey(id);
    setAppliedKey(null);
    guard.request(async () => {
      if (!mounted.current || running.current || !current.current.dispatchEnabled || current.current.readOnly) return;
      running.current = true;
      setBusyKey(id);
      try {
        await run();
        if (mounted.current) setAppliedKey(id);
      } finally {
        running.current = false;
        if (mounted.current) setBusyKey(null);
      }
    }, reason);
  }

  async function saveCount(key: CapKey, stored: number | null) {
    if (stored === null && current.current.caps.supportsUncappedCounts !== true) {
      throw new Error('Automatic count preferences are unavailable from this server.');
    }
    const result = await updateVerseCaps(capPatch(key, stored));
    if (!result.ok || result.live !== true ||
      (current.current.caps.supportsUncappedCounts === true && result.caps.supportsUncappedCounts !== true) ||
      (stored === null ? !isUncappedCount(result.caps, key) : readCap(result.caps, key) !== stored)) {
      throw new Error('The server did not confirm the count preference. Refresh and retry.');
    }
  }
  const supportsAutomatic = caps.supportsUncappedCounts === true;
  const allAutomatic = VERSE_UNCAPPED_COUNT_KEYS.every((key) => isUncappedCount(caps, key));
  const limits = caps.foundryLimits ?? [];

  return (
    <><section className={styles.panel} aria-label="Budget and limits">
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Budget and limits</h3>
        <p className={styles.panelNote}>Committed on blur or Enter. The daemon re-reads config each tick, so changes apply live.</p>
      </div>

      {supportsAutomatic ? <div className={styles.panelHead}>
        <p className={styles.panelNote}>Automatic follows available work and resource capacity, with no operator count ceiling.</p>
        <button type="button" className={styles.button} disabled={locked || busyKey !== null || allAutomatic}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commit('automatic-counts', 'Changing count preferences requires the dispatch token.', async () => {
            if (current.current.caps.supportsUncappedCounts !== true) throw new Error('Automatic count preferences are unavailable from this server.');
            const result = await updateVerseCaps(automaticCountsPatch());
            if (!result.ok || result.live !== true || !VERSE_UNCAPPED_COUNT_KEYS.every((key) => isUncappedCount(result.caps, key))) {
              throw new Error('The server did not confirm Automatic counts. Refresh and retry.');
            }
          })}>Use Automatic counts</button>
        {appliedKey === 'automatic-counts' ? <span className={styles.capApplied}>Automatic counts applied live</span> : null}
        {activeKey === 'automatic-counts' && guard.error ? <span role="alert" className={styles.capError}>{guard.error}</span> : null}
      </div> : null}

      <div className={styles.capGrid}>
        {CAP_FIELDS.map((spec) => (
          <CapField
            key={spec.key}
            spec={spec.key === 'perTickItems' ? {
              ...spec,
              help: Number.isSafeInteger(caps.journalItemCapacity) && (caps.journalItemCapacity ?? 0) > 0
                ? `${spec.help} At most ${caps.journalItemCapacity} items are journaled per tick; remaining work continues on later ticks.`
                : `${spec.help} Journal capacity is unavailable from this server.`,
            } : spec}
            stored={readCap(caps, spec.key)}
            automatic={isUncappedCount(caps, spec.key)}
            supportsAutomatic={supportsAutomatic && isCountCapKey(spec.key)}
            usage={usageFor(spec.key, caps, snapshot)}
            disabled={locked || (busyKey !== null && busyKey !== spec.key)}
            busy={busyKey === spec.key}
            applied={appliedKey === spec.key}
            error={activeKey === spec.key ? guard.error : null}
            onCommit={(stored) =>
              commit(spec.key, `Changing ${spec.label.toLowerCase()} requires the dispatch token.`, () =>
                isCountCapKey(spec.key) ? saveCount(spec.key, stored) : updateVerseCaps(capPatch(spec.key, stored)),
              )
            }
          />
        ))}
      </div>

      <div className={`${styles.panelHead} ${styles.panelHeadSpaced}`}>
        <h3 className={styles.panelTitle}>Per-engine dispatch limits</h3>
      </div>
      {limits.length === 0 ? (
        <p className={styles.empty}>
          No per-engine dispatch limits are configured. Every engine is bounded only by the caps above and by its own
          provider quota. To cap one, add it under <code>foundry.limits</code> in <code>~/.ashlr/config.json</code>{' '}
          (a <code>max</code> and a <code>window</code>); it then appears here to edit.
        </p>
      ) : (
        <div className={styles.capGrid}>
          {limits.map((limit, index) => (
            <FoundryLimitField
              key={`${limit.engine}:${limit.window}`}
              limit={limit}
              usage={engineUsage(limit.engine, snapshot)}
              disabled={locked || (busyKey !== null && busyKey !== limitId(limit))}
              busy={busyKey === limitId(limit)}
              applied={appliedKey === limitId(limit)}
              error={activeKey === limitId(limit) ? guard.error : null}
              onCommit={(max) =>
                commit(limitId(limit), `Changing the ${limit.engine} dispatch limit requires the dispatch token.`, () => {
                  const next = limits.map((entry, i) => (i === index ? { ...entry, max } : entry));
                  return updateVerseCaps({ foundryLimits: next });
                })
              }
            />
          ))}
        </div>
      )}
    </section>
      <GoalPreferencesPanel preferences={caps.goalPreferences} focusMode={caps.goalFocusMode} focusThreshold={caps.goalFocusActiveThreshold}
        focusDefaulted={caps.defaulted.includes('goalFocusMode')} guard={guard} dispatchEnabled={dispatchEnabled && busyKey === null} />
      <LeaderPreferencesPanel preferences={caps.leaderPreferences} guard={guard} dispatchEnabled={dispatchEnabled && busyKey === null} />
    </>
  );
}

function limitId(limit: VerseFoundryLimit): string {
  return `foundry:${limit.engine}:${limit.window}`;
}

function engineUsage(engine: string, snapshot: VerseControlSnapshot): string | null {
  // `/api/verse/control` sends raw frontier-usage rows; the standing word
  // ("ok"/"warn"/"over"/"unlimited") is derived here rather than served, so
  // the client and the server cannot disagree about a threshold they both own.
  const row = snapshot.quota?.find((e) => e.engine === engine);
  if (!row) return null;
  const standing = engineQuotaStanding(row);
  const quota = standing === 'unlimited' ? 'no limit configured' : standing;
  // `callsToday` is NOT a 24h figure: frontier-usage counts it over the
  // CONFIGURED limit window, which the row carries as `limitWindow`. Saying
  // "24h" under a field labelled "dispatches / 1h" described one number two
  // contradictory ways.
  return `${formatCount(row.callsToday)} dispatched in the last ${row.limitWindow ?? '1d'} · ${quota}`;
}

interface FieldShellProps {
  id: string;
  label: string;
  unit: string;
  help?: string;
  usage: string | null;
  value: string;
  invalid: string | null;
  disabled: boolean;
  busy: boolean;
  applied: boolean;
  error: string | null;
  onChange: (next: string) => void;
  onCommit: () => void;
  step: number;
  min: number;
  max: number;
  action?: ReactNode;
  placeholder?: string;
}

function FieldShell(props: FieldShellProps) {
  const describedBy = [props.usage ? `${props.id}-usage` : null, props.help ? `${props.id}-help` : null]
    .filter((x): x is string => x !== null)
    .join(' ');
  return (
    <div className={styles.cap}>
      <label className={styles.capLabel} htmlFor={props.id}>
        {props.label}
      </label>
      <div className={styles.capRow}>
        <input
          id={props.id}
          type="number"
          inputMode="decimal"
          className={`${styles.capInput} ${props.invalid ? styles.capInputInvalid : ''}`}
          value={props.value}
          placeholder={props.placeholder}
          step={props.step}
          min={props.min}
          max={props.max}
          disabled={props.disabled || props.busy}
          aria-invalid={props.invalid ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              props.onCommit();
            }
          }}
        />
        <span className={styles.capUnit}>{props.unit}</span>
      </div>
      {props.usage ? (
        <span className={styles.capUsage} id={`${props.id}-usage`}>
          {props.usage}
        </span>
      ) : null}
      {props.help ? (
        <span className={styles.capHelp} id={`${props.id}-help`}>
          {props.help}
        </span>
      ) : null}
      {props.action}
      {props.invalid ? (
        <span className={styles.capError} role="alert">
          {props.invalid}
        </span>
      ) : null}
      {props.error && !props.invalid ? (
        <span className={styles.capError} role="alert">
          {props.error}
        </span>
      ) : null}
      {props.applied && !props.invalid && !props.error ? <span className={styles.capApplied}>applied live</span> : null}
    </div>
  );
}

function CapField({
  spec,
  stored,
  automatic,
  supportsAutomatic,
  usage,
  disabled,
  busy,
  applied,
  error,
  onCommit,
}: {
  spec: CapFieldSpec;
  stored: number | null;
  automatic: boolean;
  supportsAutomatic: boolean;
  usage: string | null;
  disabled: boolean;
  busy: boolean;
  applied: boolean;
  error: string | null;
  onCommit: (stored: number | null) => void;
}) {
  const canonical = stored === null ? '' : String(spec.toDisplay(stored));
  const [draft, setDraft] = useState(canonical);
  const [invalid, setInvalid] = useState<string | null>(null);

  // The server is the authority: when its value changes under us (another tab,
  // another cap's POST returning a fresh snapshot) adopt it, unless the
  // operator is mid-edit with something invalid they still need to see.
  useEffect(() => {
    if (invalid === null) setDraft(canonical);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adopt server value only when it actually changes
  }, [canonical, automatic]);

  function commit() {
    if (draft === canonical) {
      setInvalid(null);
      return;
    }
    const result = validateCap(spec, draft);
    if (!result.ok) {
      setInvalid(result.error);
      return;
    }
    setInvalid(null);
    onCommit(result.stored);
  }

  return (
    <FieldShell
      id={`cap-${spec.key.replace('.', '-')}`}
      label={spec.label}
      unit={spec.unit}
      help={spec.help}
      usage={usage}
      value={draft}
      placeholder={automatic ? 'Automatic' : stored === null ? 'Not configured' : undefined}
      action={supportsAutomatic ? <button type="button" className={styles.button}
        aria-label={`Use Automatic for ${spec.label}`} aria-pressed={automatic}
        onMouseDown={(event) => event.preventDefault()}
        disabled={disabled || busy || automatic}
        onClick={() => { setInvalid(null); onCommit(null); }}>
        {automatic ? 'Automatic · resource capacity applies' : 'Automatic'}
      </button> : null}
      invalid={invalid}
      // `stored === null` means "not configured yet" — the ONE state this
      // control most needs to be editable in. Disabling it made Max
      // concurrent and all three tiers permanently uneditable on a default
      // config, which is the default. `commit()` already handles an empty
      // untouched field: `draft === canonical` is `'' === ''`, so it posts
      // nothing until something is typed.
      disabled={disabled}
      busy={busy}
      applied={applied}
      error={error}
      step={spec.step}
      min={spec.min}
      max={spec.max}
      onChange={(next) => {
        setDraft(next);
        if (invalid) setInvalid(null);
      }}
      onCommit={commit}
    />
  );
}

function FoundryLimitField({
  limit,
  usage,
  disabled,
  busy,
  applied,
  error,
  onCommit,
}: {
  limit: VerseFoundryLimit;
  usage: string | null;
  disabled: boolean;
  busy: boolean;
  applied: boolean;
  error: string | null;
  onCommit: (max: number) => void;
}) {
  const canonical = String(limit.max);
  const [draft, setDraft] = useState(canonical);
  const [invalid, setInvalid] = useState<string | null>(null);

  useEffect(() => {
    if (invalid === null) setDraft(canonical);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adopt server value only when it actually changes
  }, [canonical]);

  function commit() {
    if (draft === canonical) {
      setInvalid(null);
      return;
    }
    const result = validateFoundryMax(draft, limit.engine);
    if (!result.ok) {
      setInvalid(result.error);
      return;
    }
    setInvalid(null);
    onCommit(result.stored);
  }

  return (
    <FieldShell
      id={`cap-foundry-${limit.engine}-${limit.window}`}
      label={limit.engine}
      unit={`dispatches / ${limit.window}`}
      usage={usage}
      value={draft}
      invalid={invalid}
      disabled={disabled}
      busy={busy}
      applied={applied}
      error={error}
      step={1}
      min={FOUNDRY_LIMIT_MAX_RANGE.min}
      max={FOUNDRY_LIMIT_MAX_RANGE.max}
      onChange={(next) => {
        setDraft(next);
        if (invalid) setInvalid(null);
      }}
      onCommit={commit}
    />
  );
}
