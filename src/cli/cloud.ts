/**
 * `ashlr cloud` — the 3.11 cloud lane (unit C2): launch Claude Code cloud
 * sessions that deliver a draft PR, track them, and keep spend inside the
 * operator's budget.
 *
 *   ashlr cloud launch "<task>" [--repo owner/name] [--base branch] [--title t] [--json]
 *   ashlr cloud list [--all] [--json]
 *   ashlr cloud refresh [--json]
 *   ashlr cloud improve [--count N] [--json]
 *   ashlr cloud budget [--total N] [--spent N] [--per-session N] [--max-per-day N]
 *                      [--max-concurrent N] [--self-improve on|off]
 *                      [--self-improve-max N] [--reserve N] [--json]
 *   ashlr cloud backlog [--json]
 *
 * Talks to the cloud service in-process (src/core/cloud/*), NOT to the Verse
 * server, and never imports cloud-api.ts — that module starts the background
 * scheduler, which belongs to the long-running server, not to a one-shot CLI.
 *
 * Output is for people: local times, no ISO stamps, no absolute paths.
 * `--json` prints the service's own shapes for scripts. `launch` and
 * `improve` start real cloud sessions that spend Claude credits (an estimate
 * is charged against the budget); nothing here ever merges.
 * Exit codes: 0 success, 1 error / refused, 2 bad usage.
 */
import { execFileSync } from 'node:child_process';

import type {
  CloudBacklogView,
  CloudBudgetUpdate,
  CloudBudgetV1,
  CloudBudgetView,
  CloudImproveResponse,
  CloudLaunchRequest,
  CloudLaunchResponse,
  CloudSeatStatus,
  CloudTaskState,
  CloudTaskV1,
} from '../core/cloud/types.js';
import { makeColors, isTty } from './ui.js';

const USAGE = `ashlr cloud — Claude Code cloud sessions that deliver draft PRs

Usage:
  ashlr cloud launch "<task>" [--repo owner/name] [--base branch] [--title "short title"] [--json]
      Start a cloud session on the task. The repo defaults to this folder's GitHub origin.
  ashlr cloud list [--all] [--json]
      Tasks in flight and recently finished (--all: every task).
  ashlr cloud refresh [--json]
      Ask GitHub for each open task's pull request now.
  ashlr cloud improve [--count N] [--json]
      Launch the next N (1–5, default 1) self-improvement backlog items.
  ashlr cloud budget [--total N] [--spent N] [--per-session N] [--max-per-day N] [--max-concurrent N]
                     [--self-improve on|off] [--self-improve-max N] [--reserve N] [--json]
      Show the estimated credits and limits; any flag updates them first.
  ashlr cloud backlog [--json]
      The self-improvement backlog and what each item's latest task did.

Spend is an estimate: Claude doesn't expose the credit balance.`;

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface CloudCliDeps {
  launch: (req: CloudLaunchRequest) => Promise<CloudLaunchResponse>;
  listTasks: (limit?: number) => CloudTaskV1[];
  readBudget: () => CloudBudgetV1;
  updateBudget: (update: CloudBudgetUpdate) => CloudBudgetV1;
  budgetView: (tasks: readonly CloudTaskV1[], budget: CloudBudgetV1, now: Date) => CloudBudgetView;
  refresh: () => Promise<{ checked: number; updated: number }>;
  improve: (opts: { count?: number; auto: boolean }) => Promise<CloudImproveResponse>;
  backlog: (tasks: readonly CloudTaskV1[], now: Date) => CloudBacklogView;
  seat: () => CloudSeatStatus;
  /** `owner/name` of the folder's GitHub origin, or null. */
  originRepo: (cwd: string) => string | null;
  cwd: () => string;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
  color: boolean;
}

async function defaultDeps(): Promise<CloudCliDeps> {
  const [service, store, budget, backlog, tracker] = await Promise.all([
    import('../core/cloud/service.js'),
    import('../core/cloud/store.js'),
    import('../core/cloud/budget.js'),
    import('../core/cloud/backlog.js'),
    import('../core/cloud/tracker.js'),
  ]);
  return {
    launch: (req) => service.launchCloudTask(req),
    listTasks: (limit) => store.listCloudTasks(limit),
    readBudget: () => store.readCloudBudget(),
    updateBudget: (update) => store.updateCloudBudget(update),
    budgetView: (tasks, b, now) => budget.cloudBudgetView(tasks, b, now),
    refresh: () => tracker.refreshCloudTasks(),
    improve: (opts) => service.runSelfImprove(opts),
    backlog: (tasks, now) => backlog.readCloudBacklog(tasks, now),
    seat: () => service.cloudSeatStatus(),
    originRepo: readOriginRepo,
    cwd: () => process.cwd(),
    now: () => new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    color: isTty(),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * `owner/name` from a GitHub remote URL — https, scp-style ssh and ssh://
 * forms, with or without `.git`. Null for anything that is not github.com:
 * a cloud session can only clone from GitHub.
 */
export function parseGithubRepo(url: string): string | null {
  const trimmed = url.trim();
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function readOriginRepo(cwd: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return parseGithubRepo(url);
  } catch {
    return null;
  }
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "today 2:05 PM", "yesterday 9:40 AM", "Sep 21 4:00 PM" — the operator's local time, never ISO. */
export function localWhen(iso: string | null | undefined, now: Date): string {
  if (!iso) return 'unknown time';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown time';
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameLocalDay(at, now)) return `today ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameLocalDay(at, yesterday)) return `yesterday ${time}`;
  const day = at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day} ${time}`;
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

const TERMINAL: ReadonlySet<CloudTaskState> = new Set(['merged', 'closed', 'failed', 'expired']);
/** Default `list` window for finished tasks. */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000;

const STATE_LABEL: Readonly<Record<CloudTaskState, string>> = {
  queued: 'queued',
  launching: 'launching',
  running: 'running',
  'pr-open': 'PR open',
  merged: 'merged',
  closed: 'closed',
  failed: 'failed',
  expired: 'expired',
};

/** Tasks `list` shows: everything in flight plus what finished recently; `all` shows every task. */
export function tasksToList(tasks: readonly CloudTaskV1[], now: Date, all: boolean): CloudTaskV1[] {
  if (all) return [...tasks];
  return tasks.filter((t) => {
    if (!TERMINAL.has(t.state)) return true;
    const at = Date.parse(t.updatedAt);
    return !Number.isNaN(at) && now.getTime() - at <= RECENT_MS;
  });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value.`);
  args.splice(i, 2);
  return value;
}

function takeNumber(args: string[], name: string, whole: boolean): number | null {
  const raw = takeOption(args, name);
  if (raw === null) return null;
  const value = Number(raw.replace(/^\$/, ''));
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0) throw new UsageError(`${name} must be a number of zero or more.`);
  if (whole && !Number.isInteger(value)) throw new UsageError(`${name} must be a whole number.`);
  return value;
}

function rejectLeftovers(args: string[]): void {
  const unknown = args.find((a) => a.startsWith('-'));
  if (unknown) throw new UsageError(`Unknown option ${unknown}.`);
  if (args.length > 0) throw new UsageError(`Unexpected argument "${args[0]}".`);
}

/** Budget flags → a CloudBudgetUpdate (empty when no flag was given). Exported for tests. */
export function parseBudgetFlags(args: string[]): CloudBudgetUpdate {
  const update: CloudBudgetUpdate = {};
  const total = takeNumber(args, '--total', false);
  if (total !== null) update.creditsTotalUsd = total;
  const spent = takeNumber(args, '--spent', false);
  if (spent !== null) update.creditsSpentAdjustmentUsd = spent;
  const perSession = takeNumber(args, '--per-session', false);
  if (perSession !== null) update.estimatedCostPerSessionUsd = perSession;
  const perDay = takeNumber(args, '--max-per-day', true);
  if (perDay !== null) update.maxSessionsPerDay = perDay;
  const concurrent = takeNumber(args, '--max-concurrent', true);
  if (concurrent !== null) update.maxConcurrent = concurrent;
  const self: NonNullable<CloudBudgetUpdate['selfImprove']> = {};
  const toggle = takeOption(args, '--self-improve');
  if (toggle !== null) {
    if (toggle !== 'on' && toggle !== 'off') throw new UsageError('--self-improve takes on or off.');
    self.enabled = toggle === 'on';
  }
  const selfMax = takeNumber(args, '--self-improve-max', true);
  if (selfMax !== null) self.maxPerDay = selfMax;
  const reserve = takeNumber(args, '--reserve', false);
  if (reserve !== null) self.reserveUsd = reserve;
  if (Object.keys(self).length > 0) update.selfImprove = self;
  return update;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function printTask(deps: CloudCliDeps, task: CloudTaskV1): void {
  const c = makeColors(deps.color);
  const now = deps.now();
  const tone = task.state === 'failed' ? c.red : task.state === 'pr-open' ? c.green : TERMINAL.has(task.state) ? c.dim : c.cyan;
  deps.out(`${tone(STATE_LABEL[task.state].padEnd(9))}  ${task.title}`);
  const facts = [task.repo, `started ${localWhen(task.createdAt, now)}`];
  if (task.state !== 'queued' && task.state !== 'launching' && !TERMINAL.has(task.state)) {
    facts.push(`updated ${localWhen(task.updatedAt, now)}`);
  }
  deps.out(`           ${c.dim(facts.join(' · '))}  ${c.dim(task.id)}`);
  if (task.pr) deps.out(`           PR #${task.pr.number}: ${task.pr.url}`);
  else if (task.sessionUrl) deps.out(`           Session: ${task.sessionUrl}`);
  if (task.report) deps.out(`           Report (${task.report.status}): ${task.report.summary}`);
  if (task.stateReason) deps.out(`           ${task.stateReason}`);
}

function gateLine(ok: boolean, reason: string | null): string {
  return ok ? 'allowed' : `blocked — ${reason ?? 'no reason given'}`;
}

function printBudget(view: CloudBudgetView, out: (line: string) => void): void {
  const b = view.budget;
  out(`Cloud credits (estimate): ${usd(view.estimatedRemainingUsd)} of ${usd(view.creditsTotalUsd)} left · ${usd(view.estimatedSpentUsd)} spent`);
  out(`  ${view.estimateNote}`);
  out(`  Real balance: ${view.balanceUrl}`);
  out(`Sessions today: ${view.sessionsToday} of ${b.maxSessionsPerDay} · running now: ${view.running} of ${b.maxConcurrent} at once`);
  out(`  Estimated cost per session: ${usd(b.estimatedCostPerSessionUsd)}${b.creditsSpentAdjustmentUsd > 0 ? ` · spent before tracking: ${usd(b.creditsSpentAdjustmentUsd)}` : ''}`);
  const self = b.selfImprove;
  out(`Self-improvement: ${self.enabled ? 'on' : 'off'} · ${view.selfImproveToday} of ${self.maxPerDay} today · ${self.repo} · pauses below ${usd(self.reserveUsd)} left`);
  out(`Launch now: ${gateLine(view.canLaunch.ok, view.canLaunch.reason)}`);
  out(`Self-improve now: ${gateLine(view.canSelfImprove.ok, view.canSelfImprove.reason)}`);
}

function json(deps: CloudCliDeps, value: unknown): void {
  deps.out(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdLaunch(deps: CloudCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  const repoFlag = takeOption(args, '--repo');
  const base = takeOption(args, '--base');
  const title = takeOption(args, '--title');
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown) throw new UsageError(`Unknown option ${unknown}.`);
  const prompt = args.join(' ').trim();
  if (!prompt) throw new UsageError('Describe the task: ashlr cloud launch "<task>".');
  const repo = repoFlag ?? deps.originRepo(deps.cwd());
  if (!repo) {
    deps.err('This folder has no GitHub origin. Pass --repo owner/name.');
    return 2;
  }
  const req: CloudLaunchRequest = { repo, prompt, origin: 'cli' };
  if (base !== null) req.baseBranch = base;
  if (title !== null) req.title = title;
  const result = await deps.launch(req);
  if (asJson) {
    json(deps, result);
    return result.ok ? 0 : 1;
  }
  if (!result.ok || !result.task) {
    deps.err(`Not launched: ${result.error ?? 'the cloud session could not be started.'}`);
    return 1;
  }
  const task = result.task;
  deps.out(`Launched cloud task: ${task.title}`);
  if (task.sessionUrl) deps.out(`  Open in Claude: ${task.sessionUrl}`);
  deps.out(`  It delivers a draft PR from branch ${task.branch} into ${task.baseBranch} on ${task.repo}.`);
  deps.out(`  Estimated cost: ${usd(task.estimatedCostUsd)}. Track it with: ashlr cloud list`);
  return 0;
}

function cmdList(deps: CloudCliDeps, args: string[]): number {
  const asJson = takeFlag(args, '--json');
  const all = takeFlag(args, '--all');
  rejectLeftovers(args);
  const tasks = tasksToList(deps.listTasks(all ? 500 : undefined), deps.now(), all);
  if (asJson) {
    json(deps, tasks);
    return 0;
  }
  if (tasks.length === 0) {
    deps.out(all ? 'No cloud tasks yet.' : 'No cloud tasks in flight or finished in the last 3 days. Use --all for older ones.');
    return 0;
  }
  for (const task of tasks) printTask(deps, task);
  return 0;
}

async function cmdRefresh(deps: CloudCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  rejectLeftovers(args);
  const result = await deps.refresh();
  if (asJson) json(deps, result);
  else deps.out(`Checked ${result.checked} ${result.checked === 1 ? 'task' : 'tasks'} on GitHub; ${result.updated} changed.`);
  return 0;
}

async function cmdImprove(deps: CloudCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  const count = takeNumber(args, '--count', true);
  rejectLeftovers(args);
  if (count !== null && (count < 1 || count > 5)) throw new UsageError('--count must be from 1 to 5.');
  const result = await deps.improve({ count: count ?? 1, auto: false });
  if (asJson) {
    json(deps, result);
    return result.launched.length > 0 || result.skipped.length === 0 ? 0 : 1;
  }
  if (result.launched.length === 0 && result.skipped.length === 0) {
    deps.out('Nothing to launch: the backlog has no available items.');
    return 0;
  }
  for (const task of result.launched) {
    deps.out(`Launched: ${task.title}${task.sessionUrl ? ` — ${task.sessionUrl}` : ''}`);
  }
  for (const skip of result.skipped) deps.out(`Skipped ${skip.itemId}: ${skip.reason}`);
  return result.launched.length > 0 ? 0 : 1;
}

function cmdBudget(deps: CloudCliDeps, args: string[]): number {
  const asJson = takeFlag(args, '--json');
  const update = parseBudgetFlags(args);
  rejectLeftovers(args);
  const budget = Object.keys(update).length > 0 ? deps.updateBudget(update) : deps.readBudget();
  const view = deps.budgetView(deps.listTasks(), budget, deps.now());
  if (asJson) json(deps, view);
  else {
    if (Object.keys(update).length > 0) deps.out('Cloud budget updated.');
    printBudget(view, deps.out);
    const seat = deps.seat();
    if (!seat.ready) deps.out(`Seat ${seat.id}: not ready — ${seat.reason ?? 'unknown reason'}`);
  }
  return 0;
}

function cmdBacklog(deps: CloudCliDeps, args: string[]): number {
  const asJson = takeFlag(args, '--json');
  rejectLeftovers(args);
  const view = deps.backlog(deps.listTasks(), deps.now());
  if (asJson) {
    json(deps, view);
    return 0;
  }
  const c = makeColors(deps.color);
  if (view.items.length === 0) {
    deps.out('The self-improvement backlog is empty.');
    return 0;
  }
  deps.out(`Self-improvement backlog · next up: ${view.nextUp ?? 'nothing available'}`);
  for (const item of view.items) {
    const status = item.claimedBy
      ? c.dim(` (${item.lastState ? STATE_LABEL[item.lastState] : 'claimed'} · ${item.claimedBy})`)
      : '';
    const marker = item.id === view.nextUp ? c.green('→') : ' ';
    deps.out(`${marker} P${item.priority}  ${item.title}${status}`);
    deps.out(`       ${c.dim(`${item.id} · ${item.area}${item.repo ? ` · ${item.repo}` : ''}`)}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runCloudCli(argv: string[], injected?: Partial<CloudCliDeps>): Promise<number> {
  const args = [...argv];
  const sub = args.shift();
  const print = injected?.out ?? ((line: string) => console.log(line));
  const printErr = injected?.err ?? ((line: string) => console.error(line));
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    (sub ? print : printErr)(USAGE);
    return sub ? 0 : 2;
  }
  const known = ['launch', 'list', 'ls', 'refresh', 'improve', 'budget', 'backlog'];
  if (!known.includes(sub)) {
    printErr(`Unknown cloud command "${sub}".\n\n${USAGE}`);
    return 2;
  }
  // Only a known verb pays for loading the cloud core.
  const deps: CloudCliDeps = injected && isComplete(injected) ? injected : { ...(await defaultDeps()), ...injected };
  try {
    switch (sub) {
      case 'launch': return await cmdLaunch(deps, args);
      case 'list':
      case 'ls': return cmdList(deps, args);
      case 'refresh': return await cmdRefresh(deps, args);
      case 'improve': return await cmdImprove(deps, args);
      case 'budget': return cmdBudget(deps, args);
      default: return cmdBacklog(deps, args);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      deps.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    deps.err(`cloud ${sub} failed: ${withoutHome(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

/** No absolute home paths in output: an error from the checkout or store can quote one. */
function withoutHome(text: string): string {
  const home = process.env['HOME'];
  return home && home.length > 1 ? text.split(home).join('~') : text;
}

const DEP_KEYS: readonly (keyof CloudCliDeps)[] = [
  'launch', 'listTasks', 'readBudget', 'updateBudget', 'budgetView', 'refresh', 'improve', 'backlog',
  'seat', 'originRepo', 'cwd', 'now', 'out', 'err', 'color',
];

function isComplete(deps: Partial<CloudCliDeps>): deps is CloudCliDeps {
  return DEP_KEYS.every((key) => deps[key] !== undefined);
}
