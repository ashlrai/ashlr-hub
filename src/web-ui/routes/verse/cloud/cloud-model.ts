/**
 * routes/verse/cloud/cloud-model.ts — the cloud lane's words and decisions as
 * pure functions (3.11 unit C3), so the card, the Usage panel, the Fleet chip
 * and the composer action say the same thing and the copy is tested as a
 * table. No React here.
 *
 * Copy rules (DESIGN §13.8, and the cloud contract's own):
 *   - spend is ALWAYS an estimate and says so — Claude does not expose the
 *     credit balance, so every dollar figure carries "estimate" beside it;
 *   - server prose (gate reasons, state reasons, report summaries) is scrubbed
 *     for secrets before `tidyProse` makes ISO instants readable in local time;
 *   - times are local and relative ("started 5m ago"), never ISO;
 *   - a state is always a WORD beside any colour.
 */
import {
  CLOUD_PROMPT_MAX_CHARS,
  CLOUD_TERMINAL_STATES,
  DEFAULT_CLOUD_BUDGET,
  type CloudBudgetUpdate,
  type CloudBudgetV1,
  type CloudBudgetView,
  type CloudSeatStatus,
  type CloudTaskState,
  type CloudTaskV1,
} from '../../../../core/cloud/types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { scrubSecrets } from '../../../../core/util/scrub.js';
import type { Tone } from '../../../components/primitives/StatusBadge.js';
import type { MeterTone } from '../../../components/primitives/Meter.js';
import { tidyProse } from '../autonomy/format.js';
import { relativePhrase } from '../context/context-model.js';
import { usedPercentText } from '../percent-text.js';

/** Cloud text can originate in a PR body; keep every card reason safe even outside the HTTP sanitizer. */
function safeCloudProse(text: string, now?: number): string {
  return tidyProse(scrubSecrets(text), now);
}

/** The repo a new task targets unless the operator names another (the self-improvement default). */
export const CLOUD_DEFAULT_REPO = DEFAULT_CLOUD_BUDGET.selfImprove.repo;

/** Same rule the service enforces (core/cloud/service.ts), checked here so the dialog can say so first. */
export const CLOUD_REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * A branch name git would accept, conservatively: no spaces or control
 * characters, no `..`, no leading `-` or `/`, no trailing `/` or `.lock`.
 * The server re-checks it against origin; this only catches typing slips.
 */
const BRANCH_CHARS = /^[A-Za-z0-9._/+-]{1,200}$/;
export function isBranchName(value: string): boolean {
  if (!BRANCH_CHARS.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  return !value.includes('..') && !value.includes('//');
}

/** Only these hosts become links: the ids came from a CLI's stdout and gh's JSON. */
export function safeHref(url: string | null | undefined, host: 'claude.ai' | 'github.com'): string | null {
  if (typeof url !== 'string' || url.length > 2_048) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === host ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Money and the credits meter
// ---------------------------------------------------------------------------

/** "$250", "$12.50" — whole dollars stay whole; never "-$0". */
export function formatDollars(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const text = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(2);
  return `${v < 0 ? '−' : ''}$${text}`;
}

export interface CreditsMeterView {
  /** Remaining, clamped at 0 for the bar (the text says when it went below). */
  value: number;
  max: number | null;
  /** "$212 of $250 · estimate" */
  text: string;
  /** "15% used" — the one percent rule. */
  usedText: string;
  tone: MeterTone;
  /** A plain sentence when the estimate is at or under the self-improvement reserve. */
  warning: string | null;
}

export function creditsMeter(view: CloudBudgetView): CreditsMeterView {
  const total = view.creditsTotalUsd;
  const remaining = view.estimatedRemainingUsd;
  const reserve = view.budget.selfImprove.reserveUsd;
  const max = total > 0 ? total : null;
  const used = max === null ? null : ((total - Math.max(0, remaining)) / total) * 100;
  const tone: MeterTone = remaining <= 0 ? 'danger' : remaining < reserve ? 'warning' : 'accent';
  const warning = remaining <= 0
    ? 'The estimate says the credits are spent. Check the real balance on claude.ai and adjust the budget.'
    : remaining < reserve
      ? `Under the ${formatDollars(reserve)} reserve, so Verse stops launching self-improvement tasks.`
      : null;
  return {
    value: Math.max(0, remaining),
    max,
    text: `${formatDollars(Math.max(0, remaining))} of ${formatDollars(total)} · estimate`,
    usedText: used === null ? 'no credit total set' : `${usedPercentText(used)} used`,
    tone,
    warning,
  };
}

/** The next local midnight — when the per-day caps start counting again. */
export function nextLocalMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** "3 of 20 sessions today · 1 running" plus when the daily count resets. */
export function sessionsLine(view: CloudBudgetView, now: number = Date.now()): string {
  const reset = describeResetAt(new Date(nextLocalMidnight(now)).toISOString(), now);
  const running = view.running === 1 ? '1 running' : `${view.running} running`;
  return `${view.sessionsToday} of ${view.budget.maxSessionsPerDay} sessions today · ${running}${reset ? ` · resets ${reset}` : ''}`;
}

export function selfImproveLine(view: CloudBudgetView): string {
  const si = view.budget.selfImprove;
  if (!si.enabled) return 'Self-improvement is off. Verse launches cloud tasks only when you ask.';
  return `${view.selfImproveToday} of ${si.maxPerDay} self-improvement launches today, on ${si.repo}. Stops under a ${formatDollars(si.reserveUsd)} estimated balance.`;
}

/** A gate's reason, fit to print (null when the gate is open). */
export function gateText(gate: { ok: boolean; reason: string | null }, fallback: string): string | null {
  if (gate.ok) return null;
  return gate.reason ? safeCloudProse(gate.reason) : fallback;
}

export const SEAT_NOT_READY = "The Claude seat isn't set up on this Mac.";

export function seatText(seat: CloudSeatStatus): string | null {
  if (seat.ready) return null;
  return seat.reason ? safeCloudProse(seat.reason) : SEAT_NOT_READY;
}

// ---------------------------------------------------------------------------
// Standing: what the credit figure MEANS while the lane cannot launch
// ---------------------------------------------------------------------------
//
// The credit figure is always an estimate (a flat per-session cost counted
// against the total the operator typed in; the real balance is not
// readable). While the lane can launch, that estimate is headroom and a meter
// is the honest picture. While the Claude seat is NOT set up nothing can
// launch, so "$250 of $250 left" beside "the seat isn't set up" read as live
// headroom the operator could not use. Then the setup blocker is the STATE,
// and the credits a secondary, visibly approximate figure:
//
//   Cloud: not set up · ~$250 credits
//
// Shared by Command's Cloud card, Usage's Cloud credits panel and the
// Resources drawer's cloud card.

/** The state word shown in place of the meter while the seat is missing. */
export const CLOUD_NOT_SET_UP_WORD = 'Not set up';

/**
 * "~$250 credits" — whole dollars, because an estimate that cannot be spent
 * yet has no business showing cents. Never negative.
 */
export function approxCredits(remainingUsd: number): string {
  const v = Number.isFinite(remainingUsd) ? Math.max(0, Math.round(remainingUsd)) : 0;
  return `~$${v} credits`;
}

/** "Cloud: not set up · ~$250 credits" — the one-line summary of a lane that cannot launch. */
export function notSetUpLine(remainingUsd: number): string {
  return `Cloud: not set up · ${approxCredits(remainingUsd)}`;
}

/**
 * Why a launch button is disabled right now, or null when it may be pressed.
 * Seat first (nothing launches without it), then the budget gate.
 */
export function launchBlock(seat: CloudSeatStatus, budget: CloudBudgetView): string | null {
  return seatText(seat) ?? gateText(budget.canLaunch, 'The cloud budget does not allow another launch right now.');
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const STATE_WORD: Record<CloudTaskState, string> = {
  queued: 'Queued',
  launching: 'Launching',
  running: 'Running',
  'pr-open': 'PR open',
  merged: 'Merged',
  closed: 'Closed',
  failed: 'Failed',
  expired: 'Expired',
};

export const STATE_TONE: Record<CloudTaskState, Tone> = {
  queued: 'info',
  launching: 'info',
  running: 'running',
  'pr-open': 'warning',
  merged: 'success',
  closed: 'neutral',
  failed: 'danger',
  expired: 'unknown',
};

/** A draft PR reads "Draft PR", not "PR open": the session may still be pushing. */
export function stateWord(task: Pick<CloudTaskV1, 'state' | 'pr'>): string {
  if (task.state === 'pr-open' && !task.pr) return 'PR unverified';
  if (task.state === 'pr-open' && task.pr?.draft) return 'Draft PR';
  return STATE_WORD[task.state] ?? task.state;
}

export function isTerminal(state: CloudTaskState): boolean {
  return CLOUD_TERMINAL_STATES.includes(state);
}

/** In flight: counted by the Fleet chip and the "running" line. */
export function isInFlight(state: CloudTaskState): boolean {
  return state === 'queued' || state === 'launching' || state === 'running';
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many tasks the card lists before "N more on GitHub". */
export const CARD_TASK_LIMIT = 6;

/**
 * What the card lists: everything still moving or waiting on review, then
 * anything that ended in the last 24 h (a failure you have not seen yet),
 * newest first. Older finished tasks live in `ashlr cloud list --all`.
 */
export function cardTasks(tasks: readonly CloudTaskV1[], now: number = Date.now()): { shown: CloudTaskV1[]; hidden: number } {
  const recent = (t: CloudTaskV1) => {
    const at = Date.parse(t.updatedAt);
    return Number.isFinite(at) && now - at < DAY_MS;
  };
  const listed = tasks
    .filter((t) => !isTerminal(t.state) || recent(t))
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return { shown: listed.slice(0, CARD_TASK_LIMIT), hidden: Math.max(0, listed.length - CARD_TASK_LIMIT) };
}

export function inFlightCount(tasks: readonly CloudTaskV1[]): number {
  return tasks.filter((t) => isInFlight(t.state)).length;
}

/** "ashlrai/ashlr-hub from master · started 5m ago" */
export function taskMeta(task: CloudTaskV1, now: number = Date.now()): string {
  const when = task.state === 'queued' || task.state === 'launching' ? task.createdAt : task.launchedAt ?? task.createdAt;
  const phrase = relativePhrase(when, now);
  const verb = task.state === 'queued' ? 'queued' : task.state === 'failed' ? 'tried' : 'started';
  return `${task.repo} from ${task.baseBranch}${phrase ? ` · ${verb} ${phrase}` : ''}`;
}

/** The one line under a task's title: the report for a PR, else the state's reason. */
export function taskDetail(task: CloudTaskV1, now: number = Date.now()): string | null {
  if (task.report?.summary && (task.state === 'pr-open' || task.state === 'merged')) return `Cloud session reports (unverified): ${safeCloudProse(task.report.summary, now)}`;
  return task.stateReason ? safeCloudProse(task.stateReason, now) : null;
}

/** Dismiss is offered for anything Verse is still tracking; merged and closed tasks are already done. */
export function canDismiss(task: Pick<CloudTaskV1, 'state'>): boolean {
  return task.state !== 'merged' && task.state !== 'closed';
}

// ---------------------------------------------------------------------------
// The launch form
// ---------------------------------------------------------------------------

export interface LaunchDraft {
  repo: string;
  baseBranch: string;
  prompt: string;
}

export type LaunchErrors = Partial<Record<keyof LaunchDraft, string>>;

export type LaunchValidation =
  | { ok: true; request: { repo: string; baseBranch?: string; prompt: string } }
  | { ok: false; errors: LaunchErrors };

const COUNT = new Intl.NumberFormat('en-US');

export function validateLaunch(draft: LaunchDraft): LaunchValidation {
  const errors: LaunchErrors = {};
  const repo = draft.repo.trim();
  const base = draft.baseBranch.trim();
  const prompt = draft.prompt.trim();
  if (!repo) errors.repo = 'Enter the GitHub repository as owner/name.';
  else if (!CLOUD_REPO_PATTERN.test(repo)) errors.repo = 'Use the GitHub owner/name form, like ashlrai/ashlr-hub.';
  if (base && !isBranchName(base)) errors.baseBranch = "That isn't a branch name git accepts.";
  if (!prompt) errors.prompt = 'Describe the task for the cloud session.';
  else if (prompt.length > CLOUD_PROMPT_MAX_CHARS) {
    errors.prompt = `The task is ${COUNT.format(prompt.length)} characters; the limit is ${COUNT.format(CLOUD_PROMPT_MAX_CHARS)}.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, request: { repo, ...(base ? { baseBranch: base } : {}), prompt } };
}

// ---------------------------------------------------------------------------
// The budget form (Edit budget popover and the Usage panel share it)
// ---------------------------------------------------------------------------

export interface BudgetForm {
  total: string;
  spent: string;
  perSession: string;
  maxPerDay: string;
  maxConcurrent: string;
  selfImprove: boolean;
  selfImproveMax: string;
  reserve: string;
}

export type BudgetFormField = Exclude<keyof BudgetForm, 'selfImprove'>;
export type BudgetErrors = Partial<Record<BudgetFormField, string>>;

/** Field → label and bounds. Bounds are the form's sanity check; the server clamps as well. */
export const BUDGET_FIELDS: ReadonlyArray<{
  field: BudgetFormField;
  label: string;
  hint: string;
  money: boolean;
  integer: boolean;
  min: number;
  max: number;
}> = [
  { field: 'total', label: 'Credits on the account', hint: 'What claude.ai says you have.', money: true, integer: false, min: 0, max: 100_000 },
  { field: 'spent', label: 'Already spent', hint: 'Spent before Verse tracked it, or a correction after checking.', money: true, integer: false, min: -100_000, max: 100_000 },
  { field: 'perSession', label: 'Estimate per session', hint: 'Flat cost Verse counts for each launch.', money: true, integer: false, min: 0.01, max: 1_000 },
  { field: 'maxPerDay', label: 'Sessions per day', hint: 'From every origin, counted per local day.', money: false, integer: true, min: 0, max: 500 },
  { field: 'maxConcurrent', label: 'Running at once', hint: 'Launching or running together.', money: false, integer: true, min: 1, max: 50 },
  { field: 'selfImproveMax', label: 'Self-improvement per day', hint: 'Launches Verse may make on its own.', money: false, integer: true, min: 0, max: 100 },
  { field: 'reserve', label: 'Reserve', hint: 'Self-improvement stops under this estimated balance.', money: true, integer: false, min: 0, max: 100_000 },
];

function numText(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function budgetFormFrom(b: CloudBudgetV1): BudgetForm {
  return {
    total: numText(b.creditsTotalUsd),
    spent: numText(b.creditsSpentAdjustmentUsd),
    perSession: numText(b.estimatedCostPerSessionUsd),
    maxPerDay: numText(b.maxSessionsPerDay),
    maxConcurrent: numText(b.maxConcurrent),
    selfImprove: b.selfImprove.enabled,
    selfImproveMax: numText(b.selfImprove.maxPerDay),
    reserve: numText(b.selfImprove.reserveUsd),
  };
}

export type BudgetPatch = { ok: true; update: CloudBudgetUpdate; changed: boolean } | { ok: false; errors: BudgetErrors };

/**
 * The form as ONE update carrying only what changed — so two people editing
 * different fields never overwrite each other's numbers with stale ones.
 */
export function budgetPatch(form: BudgetForm, current: CloudBudgetV1): BudgetPatch {
  const errors: BudgetErrors = {};
  const values: Partial<Record<BudgetFormField, number>> = {};
  for (const spec of BUDGET_FIELDS) {
    const raw = form[spec.field].trim().replace(/^\$/, '');
    const n = raw === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(n)) errors[spec.field] = 'Enter a number.';
    else if (spec.integer && !Number.isInteger(n)) errors[spec.field] = 'Enter a whole number.';
    else if (n < spec.min || n > spec.max) {
      errors[spec.field] = spec.money
        ? `Between ${formatDollars(spec.min)} and ${formatDollars(spec.max)}.`
        : `Between ${COUNT.format(spec.min)} and ${COUNT.format(spec.max)}.`;
    } else values[spec.field] = n;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const update: CloudBudgetUpdate = {};
  const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
  if (!same(values.total!, current.creditsTotalUsd)) update.creditsTotalUsd = values.total!;
  if (!same(values.spent!, current.creditsSpentAdjustmentUsd)) update.creditsSpentAdjustmentUsd = values.spent!;
  if (!same(values.perSession!, current.estimatedCostPerSessionUsd)) update.estimatedCostPerSessionUsd = values.perSession!;
  if (!same(values.maxPerDay!, current.maxSessionsPerDay)) update.maxSessionsPerDay = values.maxPerDay!;
  if (!same(values.maxConcurrent!, current.maxConcurrent)) update.maxConcurrent = values.maxConcurrent!;
  const selfImprove: NonNullable<CloudBudgetUpdate['selfImprove']> = {};
  if (form.selfImprove !== current.selfImprove.enabled) selfImprove.enabled = form.selfImprove;
  if (!same(values.selfImproveMax!, current.selfImprove.maxPerDay)) selfImprove.maxPerDay = values.selfImproveMax!;
  if (!same(values.reserve!, current.selfImprove.reserveUsd)) selfImprove.reserveUsd = values.reserve!;
  if (Object.keys(selfImprove).length > 0) update.selfImprove = selfImprove;
  return { ok: true, update, changed: Object.keys(update).length > 0 };
}

// ---------------------------------------------------------------------------
// The composer's "Run in cloud"
// ---------------------------------------------------------------------------

export interface RunInCloudInputs {
  /** The cloud overview, or null when the route did not answer. */
  overview: { seat: CloudSeatStatus; budget: CloudBudgetView } | null;
  /** Why the overview is missing, when it is. */
  overviewReason: string | null;
  /** The chat project's GitHub `owner/name`, or null when it has none. */
  repo: string | null;
  /** True while the chat's roots have not been read yet. */
  rootsLoading: boolean;
  prompt: string;
}

/** Null when "Run in cloud" may be pressed; otherwise the tooltip saying why not. */
export function runInCloudBlock(inputs: RunInCloudInputs): string | null {
  if (!inputs.overview) return inputs.overviewReason ?? 'The cloud lane did not answer.';
  const seat = seatText(inputs.overview.seat);
  if (seat) return seat;
  if (!inputs.repo) {
    return inputs.rootsLoading
      ? "Reading this chat's project…"
      : "This chat's project has no GitHub origin, so a cloud session has nothing to clone.";
  }
  const gate = gateText(inputs.overview.budget.canLaunch, 'The cloud budget does not allow another launch right now.');
  if (gate) return gate;
  if (!inputs.prompt.trim()) return 'Type the task in the message box first.';
  if (inputs.prompt.trim().length > CLOUD_PROMPT_MAX_CHARS) {
    return `The message is over ${COUNT.format(CLOUD_PROMPT_MAX_CHARS)} characters — trim it to run it in the cloud.`;
  }
  return null;
}
