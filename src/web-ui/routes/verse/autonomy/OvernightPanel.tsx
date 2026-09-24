/**
 * routes/verse/autonomy/OvernightPanel.tsx — the control the operator arms
 * when they leave the computer, so local models keep working the enrolled
 * repos while they are asleep.
 *
 * It has to answer four things, and it answers them in this order because
 * that is the order they are asked at 11pm and again at 7am:
 *
 *   1. **What am I authorising?** Stated in full, always visible, above the
 *      Arm button — never behind a dialog. While a run is armed it merges to
 *      master on its own behind a test/lint/typecheck gate. That is the
 *      designed behaviour and the operator's considered choice, so it is
 *      written as a description, not a warning: no red, no destructive
 *      styling, no "are you sure". It is also not hidden. A person arming
 *      this should be able to read exactly what they are agreeing to without
 *      clicking anything, which is strictly more than a confirm dialog
 *      achieves — DaemonControls already makes this argument for Pause
 *      ("a dialog here would only teach the operator to click through
 *      dialogs"), and it applies with more force to a control that is used
 *      once a night.
 *
 *   2. **How does it stop?** Exactly one rule per run — until paused, at a
 *      wall-clock time, or after N iterations — chosen in a radiogroup, so
 *      the choice has single-selection semantics for a screen reader and the
 *      form cannot express two rules at once.
 *
 *   3. **What is it doing right now?** Which repo, what activity, how long it
 *      has been running, how far it is from its stop condition, what it has
 *      merged, what it has discarded and why.
 *
 *   4. **How do I stop it right now?** With PAUSE — `~/.ashlr/daemon.paused`
 *      via `runDaemonAction('pause')`. The halt sits at the TOP of the armed
 *      block, before any of the reading material, so it is never below the
 *      fold.
 *
 * WHY THE HALT IS PAUSE AND NOT "STOP LOOP". `stopDaemon()` is literally
 * `setKill(true)` (core/daemon/loop.ts), i.e. the ordinary stop engages the
 * SAME global sentinel as the emergency stop and takes the agent's own write
 * tools down with it. Wiring a woken-at-3am operator's first instinct to that
 * would mean the cheapest reaction to "it is doing something I do not like"
 * has the widest blast radius in the app. Pause halts autonomous dispatch and
 * nothing else, and undoes in one click.
 *
 * WHY THERE IS NO EMERGENCY STOP BUTTON HERE. It is one panel up, in
 * Controls, under a rule and danger-styled, and a second copy of it would
 * both duplicate that ladder and put two identically-named buttons on one
 * screen. It is named in prose instead, with its true blast radius, so it
 * stays reachable and stays visibly heavier than the halt this panel offers.
 *
 * WHY DISARM IS NOT THE HALT EITHER. Disarming stops the ARRANGEMENT; the run
 * already in flight keeps going. Two different questions, two different
 * controls, and the panel says which is which at the point of the click.
 *
 * THE BACKEND DOES NOT EXIST YET. `GET/POST /api/verse/overnight` are being
 * written in parallel by other owners, so an absent route is a designed state
 * of this panel ("not available in this build"), never a spinner that never
 * resolves and never a crash. See overnight-contract.ts for the shapes this
 * is coded against.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Meter } from '../../../components/primitives/Meter.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { runDaemonAction } from './control-queries.js';
import type { VerseControlSnapshot } from './control-types.js';
import type { OptionalFleetRead } from './fleet-contract.js';
import { asClause, formatStamp, repoDisplayName, tidyProse, UNKNOWN } from './format.js';
import type { OvernightStatus, OvernightStopRule, OvernightStopRuleKind } from './overnight-contract.js';
import { armOvernight, disarmOvernight } from './overnight-queries.js';
import {
  ITERATIONS_MAX,
  ITERATIONS_MIN,
  describeStopRule,
  formatRunElapsed,
  gateChecks,
  gateUnstated,
  joinPhrase,
  resolveStopAt,
  stopProgress,
} from './overnight-model.js';
import { useNow } from './use-ticker.js';
import type { GuardedAction } from './use-guarded-action.js';
import autonomy from './autonomy.module.css';
import styles from './overnight.module.css';

const STOP_OPTIONS: ReadonlyArray<{ value: OvernightStopRuleKind; label: string }> = [
  { value: 'until-paused', label: 'Until I pause it' },
  { value: 'at-time', label: 'At a time' },
  { value: 'after-iterations', label: 'After N iterations' },
];

/** A sensible 7am, so the common case is one click away from correct. */
const DEFAULT_STOP_TIME = '07:00';
const DEFAULT_ITERATIONS = '20';

export interface OvernightPanelProps {
  read: OptionalFleetRead<OvernightStatus> | null;
  /** For the pause sentinel and the enrolled-repo count — the same snapshot
   *  every other panel here reads, so this one cannot disagree with them. */
  snapshot: VerseControlSnapshot;
  guard: GuardedAction;
  dispatchEnabled: boolean;
  loading?: boolean;
}

export function OvernightPanel({
  read,
  snapshot,
  guard,
  dispatchEnabled,
  loading = false,
}: OvernightPanelProps): ReactNode {
  const now = useNow(1000);
  const [kind, setKind] = useState<OvernightStopRuleKind>('until-paused');
  const [timeValue, setTimeValue] = useState(DEFAULT_STOP_TIME);
  const [iterationsValue, setIterationsValue] = useState(DEFAULT_ITERATIONS);
  const [formError, setFormError] = useState<string | null>(null);
  const [note, setNoteRaw] = useState<string | null>(null);
  // Every action note is the server's own sentence: shown verbatim, except
  // that an ISO instant in it is read as local time.
  const setNote = (next: string | null): void => setNoteRaw(next ? tidyProse(next) : null);

  const status = read?.value ?? null;
  const run = status?.run ?? null;

  // The pause sentinel has three states and `unknown` FAILS SAFE as paused —
  // the daemon treats an unreadable sentinel as paused, so this must too
  // rather than drawing a running loop over a signal nobody could read.
  const pauseState = snapshot.pause?.state ?? 'unknown';
  const paused = pauseState !== 'running';
  const pauseUnknown = pauseState === 'unknown';
  const killed = snapshot.killSwitch?.state === 'active';

  const locked = !dispatchEnabled || guard.readOnly;
  const disabled = locked || guard.busy;

  const repos = status?.repos ?? snapshot.scope?.repos?.length ?? null;
  // Counted APART from repos: a mirror is the fleet's clone of a repo, not
  // another repo, so the sentence never adds the two (overnight-contract.ts).
  const mirrors = status?.mirrors;
  const gate = status?.gate ?? null;
  const checks = gateChecks(gate);
  const unstated = gateUnstated(gate);
  const branch = gate?.branch ?? 'master';

  const rule = buildRule(kind, timeValue, iterationsValue);
  const progress = stopProgress(run?.stopRule ?? null, run, now);

  // Only the reasons the button is actually DISABLED for. An incomplete stop
  // rule leaves the button live — clicking it says what is missing, which is
  // more use than a dead control — and the visible preview line already says
  // what to enter, so a tooltip repeating it would be noise.
  const armDisabledReason = locked
    ? 'This server runs without dispatch, so an overnight run cannot be armed from here.'
    : killed
      ? 'Release the emergency stop before arming an overnight run.'
      : '';

  const halt = (): void => {
    setFormError(null);
    guard.request(
      () => runDaemonAction('pause'),
      'Pausing autonomous dispatch requires the dispatch token.',
      (result) => setNote(result.note || null),
    );
  };

  const resume = (): void => {
    setFormError(null);
    guard.request(
      () => runDaemonAction('resume'),
      'Resuming autonomous dispatch requires the dispatch token.',
      (result) => setNote(result.note || null),
    );
  };

  const arm = (): void => {
    if (rule === null) {
      setFormError(
        kind === 'at-time'
          ? 'Enter a stop time as HH:MM before arming.'
          : `Enter a number of iterations between ${ITERATIONS_MIN} and ${ITERATIONS_MAX} before arming.`,
      );
      return;
    }
    setFormError(null);
    guard.request(
      () => armOvernight(rule),
      'Arming an overnight run requires the dispatch token.',
      (result) => setNote(result.note || null),
    );
  };

  const disarm = (): void => {
    setFormError(null);
    guard.request(
      () => disarmOvernight(),
      'Disarming the overnight run requires the dispatch token.',
      (result) => setNote(result.note || null),
    );
  };

  /** The permanent, unavoidable statement of what an armed run does. */
  const authorisation = (
    <div className={styles.authorisation}>
      <h4 className={styles.authorisationTitle}>What it does while you sleep</h4>
      <p className={styles.authorisationBody}>
        Local models work through{' '}
        <strong>{repos === null ? 'your enrolled repositories' : `your ${repos} enrolled ${repos === 1 ? 'repository' : 'repositories'}`}</strong>{' '}
        unattended. Each change it writes is put through the gate
        {checks.length > 0 ? (
          <>
            {' '}— <strong>{joinPhrase(checks)}</strong> must pass
          </>
        ) : null}
        . A change that passes the gate is <strong>merged to {branch} without asking you</strong>. A
        change that fails is discarded and the repository is left as it was.
      </p>
      {typeof mirrors === 'number' && mirrors > 0 ? (
        <p className={styles.authorisationBody} data-testid="overnight-mirrors">
          Fleet mirrors: <strong>{mirrors}</strong> — the standing fleet&rsquo;s own{' '}
          {mirrors === 1 ? 'clone' : 'clones'} of enrolled repositories, counted apart. A mirror is not an
          additional repository.
        </p>
      ) : mirrors === null && status?.armed ? (
        <p className={styles.authorisationCaveat} data-testid="overnight-mirrors">
          Fleet mirrors were not recorded for this run, so how many the standing fleet works in is unknown.
        </p>
      ) : null}
      {unstated.length > 0 ? (
        <p className={styles.authorisationCaveat}>
          This build did not state whether {joinPhrase(unstated)}{' '}
          {unstated.length === 1 ? 'runs' : 'run'} in the gate, so {unstated.length === 1 ? 'it is' : 'they are'} shown as
          unstated rather than as passing checks you can rely on.
        </p>
      ) : null}
      {gate?.autoMerge === false ? (
        <p className={styles.authorisationCaveat}>
          This build reports that passing changes are <strong>not</strong> merged automatically — they
          wait for you in Approvals.
        </p>
      ) : null}
    </div>
  );

  return (
    <section className={autonomy.panel} aria-labelledby="verse-overnight-title">
      <div className={autonomy.panelHead}>
        <h3 id="verse-overnight-title" className={autonomy.panelTitle}>
          Overnight
        </h3>
        <p className={autonomy.panelNote}>
          Arm this when you walk away. One stop rule per run; pause halts it at any time.
        </p>
      </div>

      {loading && read === null ? (
        <p className={autonomy.empty}>Reading the overnight lane…</p>
      ) : read === null || (!read.available && read.value === null) ? (
        <p className={autonomy.empty}>
          <span className={autonomy.emptyStrong}>Not available in this build. </span>
          {read?.reason ??
            'Nothing answered for the overnight lane, so a run cannot be armed or reported here. Nothing is running because of this panel.'}
        </p>
      ) : status === null ? (
        <p className={autonomy.empty}>
          <span className={autonomy.emptyStrong}>Unreadable reading. </span>
          {read.reason ??
            'The overnight reading could not be narrowed, so whether a run is armed is not stated rather than guessed.'}
        </p>
      ) : status.armed ? (
        <>
          {/* The halt comes FIRST, before anything there is to read. */}
          <div className={styles.armedTop}>
            <span className={styles.armedState}>
              <StatusBadge status={paused ? 'paused' : 'running'} tone={paused ? 'warning' : 'running'}>
                {paused ? 'armed — dispatch paused' : 'armed — running'}
              </StatusBadge>
            </span>
            <div className={styles.haltRow}>
              {paused ? (
                <button
                  type="button"
                  className={`${autonomy.button} ${autonomy.buttonPrimary}`}
                  disabled={disabled}
                  onClick={resume}
                >
                  Resume now
                </button>
              ) : (
                <button
                  type="button"
                  className={`${autonomy.button} ${autonomy.buttonPrimary}`}
                  disabled={disabled}
                  onClick={halt}
                >
                  Pause now
                </button>
              )}
              <button type="button" className={autonomy.button} disabled={disabled} onClick={disarm}>
                Disarm
              </button>
            </div>
          </div>

          <p className={styles.haltNote}>
            {paused
              ? pauseUnknown
                ? 'Treated as paused: the pause sentinel could not be read, and the daemon fails safe rather than running on an unreadable signal. Nothing is being dispatched.'
                : 'Autonomous dispatch is paused. The loop parks between iterations; your own write tools are unaffected and the global kill switch is not engaged.'
              : 'Pause halts autonomous dispatch and nothing else — it undoes in one click. Disarm stops the next run from starting but leaves this one going.'}
          </p>

          <dl className={styles.facts}>
            <Fact label="Doing now" value={run?.activity ? tidyProse(run.activity) : UNKNOWN} wide />
            {/* The checkout's folder name; the full path is the tooltip. */}
            <Fact
              label="Repository"
              value={run?.repo ? repoDisplayName(run.repo) : UNKNOWN}
              title={run?.repo ?? undefined}
              mono
            />
            <Fact label="Running for" value={formatRunElapsed(run?.startedAt, now)} />
          </dl>

          <div className={styles.stop}>
            <div className={styles.stopHead}>
              <span className={styles.stopHeadline}>{progress.headline}</span>
              <span className={styles.stopRemaining}>{progress.remaining}</span>
            </div>
            {progress.percent === null ? (
              <p className={styles.stopDetail}>
                No progress is drawn for an open-ended run: there is no finish line to draw it
                against.
              </p>
            ) : (
              <Meter
                value={progress.percent}
                max={100}
                variant="line"
                tone={progress.reached ? 'warning' : 'accent'}
                aria-label="Progress toward the stop condition"
              />
            )}
          </div>

          <Ledger
            title="Merged"
            empty="Nothing merged yet. Changes that pass the gate land here as they merge."
            rows={(run?.merged ?? []).map((m) => ({
              id: m.id,
              repo: m.repo,
              title: m.title,
              // A short sha, like every git surface; the full one is the tooltip.
              meta: metaLine(m.commit ? m.commit.slice(0, 7) : null, m.at),
              metaTitle: m.commit ?? undefined,
            }))}
          />
          <Ledger
            title="Discarded"
            empty="Nothing discarded yet. A change that fails the gate is listed here with the reason."
            rows={(run?.discarded ?? []).map((d) => ({
              id: d.id,
              repo: d.repo,
              title: d.title,
              // The reason is a sentence of its own, often several joined by
              // the server: tidied so it never reads ".;" or ". ·".
              meta: metaLine(asClause(tidyProse(d.reason)), d.at),
            }))}
          />

          {authorisation}
        </>
      ) : (
        <>
          <div className={styles.form}>
            <div className={styles.field}>
              <span className={styles.fieldLabel} id="verse-overnight-stop-label">
                Stop rule
              </span>
              <Segmented
                options={STOP_OPTIONS}
                value={kind}
                onChange={(next) => {
                  setKind(next);
                  setFormError(null);
                }}
                aria-labelledby="verse-overnight-stop-label"
                size="sm"
              />
            </div>

            {kind === 'at-time' ? (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="verse-overnight-time">
                  Stop at
                </label>
                <input
                  id="verse-overnight-time"
                  type="time"
                  className={styles.input}
                  value={timeValue}
                  disabled={disabled}
                  onChange={(e) => {
                    setTimeValue(e.target.value);
                    setFormError(null);
                  }}
                />
              </div>
            ) : null}

            {kind === 'after-iterations' ? (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="verse-overnight-iterations">
                  Iterations
                </label>
                <input
                  id="verse-overnight-iterations"
                  type="number"
                  inputMode="numeric"
                  min={ITERATIONS_MIN}
                  max={ITERATIONS_MAX}
                  className={styles.input}
                  value={iterationsValue}
                  disabled={disabled}
                  onChange={(e) => {
                    setIterationsValue(e.target.value);
                    setFormError(null);
                  }}
                />
              </div>
            ) : null}
          </div>

          <p className={styles.rulePreview}>
            {rule === null
              ? kind === 'at-time'
                ? 'Enter a stop time as HH:MM.'
                : `Enter a number of iterations between ${ITERATIONS_MIN} and ${ITERATIONS_MAX}.`
              : describeStopRule(rule, new Date(now))}
          </p>

          {authorisation}

          <div className={styles.armRow}>
            {/* WHY IS THIS GREYED OUT — the one thing a disabled control has
                to be able to say. `disabled` eats pointer events on the button
                itself, so the Tooltip listens on its wrapper; it carries a
                DESCRIPTION, and the button keeps its own visible text as its
                accessible name. */}
            <Tooltip label={armDisabledReason}>
              <button
                type="button"
                className={`${autonomy.button} ${autonomy.buttonPrimary}`}
                disabled={disabled || killed}
                onClick={arm}
              >
                Arm overnight run
              </button>
            </Tooltip>
            {paused ? (
              <button
                type="button"
                className={autonomy.button}
                disabled={disabled}
                onClick={resume}
              >
                Resume now
              </button>
            ) : null}
          </div>

          {paused ? (
            <p className={styles.haltNote} role="status">
              {pauseUnknown
                ? 'Autonomous dispatch is treated as paused — the sentinel could not be read. An armed run would park rather than work until that is resolved.'
                : 'Autonomous dispatch is paused, so an armed run would park rather than work. Resume before walking away.'}
            </p>
          ) : null}

          <p className={styles.heavier}>
            Pause is the halt for this run and it undoes in one click.{' '}
            <strong>Emergency stop</strong>, in Controls above, is heavier on purpose: it engages the
            global kill switch, which also stops the agent&rsquo;s own write tools from editing
            anything, anywhere, until you release it.
          </p>
        </>
      )}

      {formError ? (
        <p className={autonomy.capError} role="alert">
          {formError}
        </p>
      ) : null}

      {guard.error ? (
        <p className={autonomy.capError} role="alert">
          {guard.error}
        </p>
      ) : null}

      {note && !guard.error ? (
        <p className={autonomy.actionNote} role="status">
          {note}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The form state as a rule, or null when it is not yet a rule.
 *
 * Null is the single source of "cannot arm yet" — the preview line, the
 * disabled Arm button's tooltip and the submit guard all read it, so they
 * cannot disagree about whether the form is complete.
 */
function buildRule(
  kind: OvernightStopRuleKind,
  timeValue: string,
  iterationsValue: string,
): OvernightStopRule | null {
  if (kind === 'until-paused') return { kind: 'until-paused' };
  if (kind === 'at-time') {
    const at = resolveStopAt(timeValue);
    return at === null ? null : { kind: 'at-time', at };
  }
  const iterations = Number(iterationsValue);
  if (!Number.isInteger(iterations) || iterations < ITERATIONS_MIN || iterations > ITERATIONS_MAX) {
    return null;
  }
  return { kind: 'after-iterations', iterations };
}

/** "abc1234 · 03:12:44" — a missing part is left out, never printed as "—". */
function metaLine(lead: string | null, at: string | null): string {
  const stamp = at ? formatStamp(at) : null;
  return [lead, stamp === UNKNOWN ? null : stamp].filter((part): part is string => Boolean(part)).join(' · ');
}

function Fact({
  label,
  value,
  title,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  /** The full text when `value` is a shortened form (a path shown by its folder name). */
  title?: string;
  mono?: boolean;
  wide?: boolean;
}): ReactNode {
  return (
    <div className={`${styles.fact} ${wide ? styles.factWide : ''}`}>
      <dt className={styles.factLabel}>{label}</dt>
      {/* A mono or wide value can be cut with an ellipsis, so it always carries its full text as a tooltip. */}
      <dd className={`${styles.factValue} ${mono ? styles.factMono : ''}`} title={title ?? (mono || wide ? value : undefined)}>
        {value}
      </dd>
    </div>
  );
}

interface LedgerRow {
  id: string;
  repo: string;
  title: string;
  meta: string;
  /** Full text behind a shortened meta (the whole commit sha). */
  metaTitle?: string;
}

/** What it merged, and what it threw away — same row shape for both. */
function Ledger({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: readonly LedgerRow[];
}): ReactNode {
  return (
    <div className={styles.ledger}>
      <h4 className={styles.ledgerTitle}>
        {title} <span className={styles.ledgerCount}>{rows.length}</span>
      </h4>
      {rows.length === 0 ? (
        <p className={styles.ledgerEmpty}>{empty}</p>
      ) : (
        <ul className={styles.ledgerList}>
          {rows.map((row) => (
            <li key={row.id} className={styles.ledgerRow}>
              {/* The repo cell truncates: its folder name (or owner/name) shows, the full value is the tooltip. */}
              <span className={styles.ledgerRepo} title={row.repo}>{repoDisplayName(row.repo)}</span>
              <span className={styles.ledgerChange}>{row.title}</span>
              {row.meta ? <span className={styles.ledgerMeta} title={row.metaTitle}>{row.meta}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
