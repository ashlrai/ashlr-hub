/**
 * routes/verse/autonomy/overnight-model.ts — the pure half of the Overnight
 * panel: narrow the server's body, resolve the operator's stop rule, and
 * derive the one line that says how far the run is from stopping.
 *
 * Framework-free so it unit-tests without a DOM, and separate from the panel
 * because two of these functions are where the panel can most easily start
 * lying:
 *
 *  - `projectOvernight` NARROWS, it does not cast. The route is being written
 *    by another owner in parallel with this surface, so a field that drifts in
 *    name or type has to degrade to `null` — which the panel renders as "not
 *    stated" — rather than reach a render as `undefined` and crash, or reach
 *    it as `0` and read as a fact. Same discipline as `fleet-model.ts`.
 *  - `stopProgress` never invents a denominator. "Until I pause it" has no
 *    progress, and drawing a bar for it would be a picture of a finish line
 *    that does not exist.
 */
import { formatDuration, UNKNOWN } from './format.js';
import type {
  OvernightDiscard,
  OvernightGate,
  OvernightMerge,
  OvernightRun,
  OvernightStatus,
  OvernightStopRule,
  OvernightStopRuleKind,
} from './overnight-contract.js';

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** A count. Negative and non-finite are not counts, so they are not observed. */
function count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function projectStopRule(raw: unknown): OvernightStopRule | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw['kind']);
  if (kind === 'until-paused') return { kind: 'until-paused' };
  if (kind === 'at-time') {
    const at = str(raw['at']);
    // An unparseable instant is worse than no rule: it would render as a
    // countdown to NaN. Refuse it here so the panel can say "not stated".
    if (at === null || Number.isNaN(Date.parse(at))) return null;
    return { kind: 'at-time', at };
  }
  if (kind === 'after-iterations') {
    const iterations = count(raw['iterations']);
    if (iterations === null || iterations <= 0) return null;
    return { kind: 'after-iterations', iterations };
  }
  return null;
}

function projectMerges(raw: unknown): OvernightMerge[] {
  if (!Array.isArray(raw)) return [];
  const out: OvernightMerge[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) continue;
    const repo = str(item['repo']);
    if (repo === null) continue;
    out.push({
      id: str(item['id']) ?? `${repo}:${index}`,
      repo,
      title: str(item['title']) ?? 'untitled change',
      at: str(item['at']),
      commit: str(item['commit']),
    });
  }
  return out;
}

function projectDiscards(raw: unknown): OvernightDiscard[] {
  if (!Array.isArray(raw)) return [];
  const out: OvernightDiscard[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) continue;
    const repo = str(item['repo']);
    if (repo === null) continue;
    out.push({
      id: str(item['id']) ?? `${repo}:${index}`,
      repo,
      title: str(item['title']) ?? 'untitled change',
      at: str(item['at']),
      // A discard with no stated reason is the one row an operator will ask
      // about in the morning, so it says that it has none rather than being
      // rendered as a blank cell.
      reason: str(item['reason']) ?? 'no reason recorded',
    });
  }
  return out;
}

function projectGate(raw: unknown): OvernightGate | null {
  if (!isRecord(raw)) return null;
  return {
    tests: bool(raw['tests']),
    lint: bool(raw['lint']),
    typecheck: bool(raw['typecheck']),
    autoMerge: bool(raw['autoMerge']),
    branch: str(raw['branch']),
  };
}

function projectRun(raw: unknown): OvernightRun | null {
  if (!isRecord(raw)) return null;
  const runId = str(raw['runId']);
  if (runId === null) return null;
  return {
    runId,
    startedAt: str(raw['startedAt']),
    stopRule: projectStopRule(raw['stopRule']),
    iterationsDone: count(raw['iterationsDone']),
    repo: str(raw['repo']),
    activity: str(raw['activity']),
    merged: projectMerges(raw['merged']),
    discarded: projectDiscards(raw['discarded']),
  };
}

/**
 * `GET /api/verse/overnight` → a status, or null when the body is not one.
 *
 * `armed` is the single field this refuses to guess: a body that does not say
 * whether a run is armed is not a status, because "nothing is armed" is
 * exactly the claim a person checks before closing the laptop.
 */
export function projectOvernight(raw: unknown): OvernightStatus | null {
  if (!isRecord(raw)) return null;
  const armed = bool(raw['armed']);
  if (armed === null) return null;
  return {
    armed,
    run: projectRun(raw['run']),
    repos: count(raw['repos']),
    gate: projectGate(raw['gate']),
  };
}

// ---------------------------------------------------------------------------
// The operator's side of the stop rule
// ---------------------------------------------------------------------------

/** Smallest and largest iteration cap the form will send. */
export const ITERATIONS_MIN = 1;
export const ITERATIONS_MAX = 500;

/**
 * Turn an `<input type="time">` value ("23:30") into the next occurrence of
 * that wall-clock time, as an absolute instant.
 *
 * The whole point of arming this at 11pm is that "07:00" means tomorrow
 * morning. Resolving it on the client, in the operator's own zone, is what
 * makes that unambiguous by the time it reaches a server that may not share
 * the zone — and rounds to the minute, so a run armed at 06:59:58 for 07:00
 * does not stop two seconds later.
 */
export function resolveStopAt(value: string, now: Date = new Date()): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

/** "07:00" as the operator's locale writes it — never a raw ISO string. */
export function formatStopClock(iso: string | null): string {
  if (!iso) return UNKNOWN;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** True when the resolved instant is not today — "07:00 tomorrow". */
export function isNextDay(iso: string | null, now: Date = new Date()): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toDateString() !== now.toDateString();
}

/**
 * The sentence the Arm button is committing to, before the click.
 *
 * It restates the rule the operator chose in the operator's own units, so the
 * button is never the only description of what is about to be authorised.
 */
export function describeStopRule(rule: OvernightStopRule, now: Date = new Date()): string {
  switch (rule.kind) {
    case 'until-paused':
      return 'Runs until you pause it — no stop time, no iteration limit.';
    case 'at-time':
      return `Stops at ${formatStopClock(rule.at)}${isNextDay(rule.at, now) ? ' tomorrow' : ''}.`;
    case 'after-iterations':
      return `Stops after ${rule.iterations} ${rule.iterations === 1 ? 'iteration' : 'iterations'}.`;
  }
}

/** The short label each stop rule wears in the armed summary. */
export function stopRuleLabel(kind: OvernightStopRuleKind): string {
  switch (kind) {
    case 'until-paused':
      return 'Until paused';
    case 'at-time':
      return 'At a set time';
    case 'after-iterations':
      return 'After N iterations';
  }
}

// ---------------------------------------------------------------------------
// How far to the stop condition
// ---------------------------------------------------------------------------

export interface StopProgress {
  /** The rule, restated: "Stops at 07:00". */
  headline: string;
  /** How much is left: "4h 12m left", "12 of 20 done". */
  remaining: string;
  /** 0-100 for a meter, or null when there is no honest denominator. */
  percent: number | null;
  /** True once the condition is met and the loop should be winding down. */
  reached: boolean;
}

/**
 * How far the run is from its stop condition.
 *
 * `percent` is null for "until I pause it" on purpose: an open-ended run has
 * no finish line, and a bar with no denominator is the exact kind of confident
 * graphic this cockpit is not allowed to draw.
 */
export function stopProgress(
  rule: OvernightStopRule | null,
  run: OvernightRun | null,
  now: number = Date.now(),
): StopProgress {
  if (rule === null) {
    return {
      headline: 'Stop rule not stated',
      remaining: UNKNOWN,
      percent: null,
      reached: false,
    };
  }

  if (rule.kind === 'until-paused') {
    return {
      headline: 'Runs until you pause it',
      remaining: 'no stop time, no iteration limit',
      percent: null,
      reached: false,
    };
  }

  if (rule.kind === 'at-time') {
    const at = Date.parse(rule.at);
    if (Number.isNaN(at)) {
      return { headline: 'Stop time not readable', remaining: UNKNOWN, percent: null, reached: false };
    }
    const headline = `Stops at ${formatStopClock(rule.at)}`;
    const left = at - now;
    if (left <= 0) {
      return { headline, remaining: 'stop time reached', percent: 100, reached: true };
    }
    const startedAt = run?.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    // Elapsed over the run's whole window — which needs a start. Without one
    // the countdown is still true, so it is shown; only the bar is withheld.
    const percent =
      Number.isNaN(startedAt) || at <= startedAt
        ? null
        : Math.min(100, Math.max(0, Math.round(((now - startedAt) / (at - startedAt)) * 100)));
    return { headline, remaining: `${formatDuration(left)} left`, percent, reached: false };
  }

  const done = run?.iterationsDone;
  const headline = `Stops after ${rule.iterations} ${rule.iterations === 1 ? 'iteration' : 'iterations'}`;
  if (typeof done !== 'number') {
    return {
      headline,
      remaining: `${UNKNOWN} of ${rule.iterations} done`,
      percent: null,
      reached: false,
    };
  }
  return {
    headline,
    remaining: `${done} of ${rule.iterations} done`,
    percent: Math.min(100, Math.round((done / rule.iterations) * 100)),
    reached: done >= rule.iterations,
  };
}

/** "3h 04m" since the run started, or UNKNOWN when it never said. */
export function formatRunElapsed(startedAt: string | null | undefined, now: number = Date.now()): string {
  if (!startedAt) return UNKNOWN;
  const ms = Date.parse(startedAt);
  if (Number.isNaN(ms)) return UNKNOWN;
  return formatDuration(Math.max(0, now - ms));
}

/**
 * The checks named as one phrase: "tests, lint and typecheck".
 *
 * Only checks the server said `true` about are named. A `null` check is not
 * named as running AND not named as skipped — `gateCaveat` below says so in
 * words instead, because a gate an operator believes is running when it is not
 * is the single most expensive misreading this panel could cause.
 */
export function gateChecks(gate: OvernightGate | null): string[] {
  if (gate === null) return [];
  const named: string[] = [];
  if (gate.tests === true) named.push('tests');
  if (gate.lint === true) named.push('lint');
  if (gate.typecheck === true) named.push('typecheck');
  return named;
}

/** The checks the server would not commit to, if any. */
export function gateUnstated(gate: OvernightGate | null): string[] {
  if (gate === null) return ['tests', 'lint', 'typecheck'];
  const unstated: string[] = [];
  if (gate.tests === null) unstated.push('tests');
  if (gate.lint === null) unstated.push('lint');
  if (gate.typecheck === null) unstated.push('typecheck');
  return unstated;
}

export function joinPhrase(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
