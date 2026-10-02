/**
 * `ashlr devin` — the 3.15 Devin lane: connect a Devin (Cognition) API key,
 * launch Devin sessions that deliver a PR through the standing gates, track
 * them, and keep ACU spend inside the budget.
 *
 *   ashlr devin connect [--org org-…]      hidden prompt; key → macOS Keychain; lane on
 *   ashlr devin disconnect                 remove the key and the connection
 *   ashlr devin enable | disable           the `devin.enabled` switch
 *   ashlr devin fleet on | off             may the fleet launch Devin sessions itself
 *   ashlr devin status [--json]
 *   ashlr devin launch "<task>" [--repo owner/name] [--base branch] [--title t] [--json]
 *   ashlr devin list [--all] [--json]
 *   ashlr devin refresh [--json]
 *   ashlr devin message <task-id> "<text>"
 *   ashlr devin budget [--acu N] [--spent N] [--per-session N] [--per-day N] [--reserve N]
 *                      [--pause-at PCT] [--usd-per-acu N] [--max-concurrent N] [--max-per-day N]
 *                      [--fleet-concurrent N] [--fleet-per-day N] [--json]
 *
 * In-process (src/core/devin/*), never through the Verse server, and never
 * imports devin-api.ts (that module starts the background refresher). The key
 * is only ever typed at a hidden prompt — never an argument, never an env
 * var — and goes straight to the Keychain. Output is for people; `--json`
 * prints the service's shapes. Exit codes: 0 ok, 1 error / refused, 2 usage.
 */
import type {
  DevinBudgetUpdate,
  DevinBudgetV1,
  DevinBudgetView,
  DevinLaunchRequest,
  DevinLaunchResponse,
  DevinStatus,
  DevinTaskState,
  DevinTaskV1,
} from '../core/devin/types.js';
import type { DevinConnectResult, DevinMessageResult } from '../core/devin/service.js';
import { localWhen, readOriginRepo } from './cloud.js';
import { isTty } from './ui.js';

const USAGE = `ashlr devin — Devin (Cognition) sessions that deliver PRs through the standing gates

Usage:
  ashlr devin connect [--org org-…]
      Paste your Devin API key (cog_…, hidden). Verified with Devin, stored in the macOS Keychain, lane turned on.
      Create a key at app.devin.ai: Settings > Devin API (a service user with the Member role, or a personal access token).
  ashlr devin disconnect
      Remove the key from the Keychain and forget the connection.
  ashlr devin enable | disable
      Turn the Devin lane on or off (the key stays).
  ashlr devin fleet on | off
      Let the fleet launch Devin on well-scoped backlog work (default off). Also needs a standing grant
      that names Devin (\`ashlr authority draft\` includes it once this is on). On an elite model (SWE-2,
      GPT-6) under an elite-direct grant Devin PRs land on green tests; otherwise they merge only
      when two judges from different families ship them.
  ashlr devin status [--json]
  ashlr devin launch "<task>" [--repo owner/name] [--base branch] [--title "short title"] [--json]
      Start a Devin session. The repo defaults to this folder's GitHub origin; the base to its default branch.
  ashlr devin list [--all] [--json]
  ashlr devin refresh [--json]
      Read each live session's status and ACUs, and ask GitHub for its PR.
  ashlr devin message <task-id> "<text>"
      Reply to a Devin session that is waiting for you.
  ashlr devin budget [--acu N] [--spent N] [--per-session N] [--per-day N] [--reserve N] [--pause-at PCT]
                     [--usd-per-acu N] [--max-concurrent N] [--max-per-day N]
                     [--fleet-concurrent N] [--fleet-per-day N] [--json]
      Show ACU use and limits; any flag updates them first.

Dollar figures are estimates; ACUs come from Devin's own readings.`;

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface DevinCliDeps {
  connect: (input: { key: string; orgId: string | null }) => Promise<DevinConnectResult>;
  disconnect: () => Promise<{ removedKey: boolean }>;
  setConfig: (patch: { enabled?: boolean; fleet?: boolean }) => void;
  status: () => Promise<DevinStatus>;
  launch: (req: DevinLaunchRequest) => Promise<DevinLaunchResponse>;
  listTasks: (limit?: number) => DevinTaskV1[];
  refresh: () => Promise<{ checked: number; updated: number }>;
  message: (taskId: string, text: string) => Promise<DevinMessageResult>;
  readBudget: () => DevinBudgetV1;
  updateBudget: (update: DevinBudgetUpdate) => DevinBudgetV1;
  budgetView: (tasks: readonly DevinTaskV1[], budget: DevinBudgetV1, now: Date) => DevinBudgetView;
  /** Hidden terminal input (raw mode, no echo). */
  readSecret: (prompt: string) => Promise<string>;
  originRepo: (cwd: string) => string | null;
  cwd: () => string;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

async function defaultDeps(): Promise<DevinCliDeps> {
  const [service, store, budget, tracker] = await Promise.all([
    import('../core/devin/service.js'),
    import('../core/devin/store.js'),
    import('../core/devin/budget.js'),
    import('../core/devin/tracker.js'),
  ]);
  return {
    connect: (input) => service.connectDevin(input),
    disconnect: () => service.disconnectDevin(),
    setConfig: (patch) => { service.updateDevinConfig(patch); },
    status: () => service.devinStatus(),
    launch: (req) => service.launchDevinTask(req),
    listTasks: (limit) => store.listDevinTasks(limit),
    refresh: () => tracker.refreshDevinTasks(),
    message: (taskId, text) => service.messageDevinTask(taskId, text),
    readBudget: () => store.readDevinBudget(),
    updateBudget: (update) => store.updateDevinBudget(update),
    budgetView: (tasks, b, now) => budget.devinBudgetView(tasks, b, now),
    readSecret: readHiddenLine,
    originRepo: readOriginRepo,
    cwd: () => process.cwd(),
    now: () => new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

/**
 * Hidden input: raw mode, nothing echoed, Ctrl-C cancels, backspace works.
 * The same technique as `ashlr authority` (cli/authority.ts realReadSecret),
 * kept separate so the Devin lane adds nothing to the authority CLI.
 */
export async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !isTty()) throw new Error('the Devin key can only be entered in an interactive terminal');
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  try {
    return await new Promise<string>((done, fail) => {
      let value = '';
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            stdin.off('data', onData);
            process.stdout.write('\n');
            done(value);
            return;
          }
          if (ch === '\u0003') {
            stdin.off('data', onData);
            process.stdout.write('\n');
            fail(new Error('cancelled'));
            return;
          }
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

// ---------------------------------------------------------------------------
// Helpers
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

function takeNumber(args: string[], name: string, opts: { whole?: boolean; safe?: boolean } = {}): number | null {
  const raw = takeOption(args, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new UsageError(`${name} must be a number of 0 or more.`);
  if (opts.whole && !Number.isInteger(value)) throw new UsageError(`${name} must be a whole number.`);
  if (opts.safe && !Number.isSafeInteger(value)) throw new UsageError(`${name} must be a safe whole number.`);
  return value;
}

function rejectLeftovers(args: string[]): void {
  if (args.length > 0) throw new UsageError(`Unexpected ${args[0]!.startsWith('--') ? 'option' : 'argument'} ${args[0]}.`);
}

function json(deps: DevinCliDeps, value: unknown): void {
  deps.out(JSON.stringify(value, null, 2));
}

const acu = (n: number): string => `${Math.round(n * 100) / 100} ACU${Math.round(n * 100) / 100 === 1 ? '' : 's'}`;

const STATE_WORDS: Readonly<Record<DevinTaskState, string>> = {
  queued: 'queued',
  launching: 'starting',
  running: 'working',
  blocked: 'waiting for you',
  'pr-open': 'PR open',
  merged: 'merged',
  closed: 'closed',
  failed: 'failed',
  expired: 'no PR',
};

/** Recent or unfinished tasks unless `all`. */
export function devinTasksToList(tasks: readonly DevinTaskV1[], now: Date, all: boolean): DevinTaskV1[] {
  if (all) return [...tasks];
  const cutoff = now.getTime() - 3 * 24 * 60 * 60 * 1000;
  return tasks.filter((task) => !['merged', 'closed', 'failed', 'expired'].includes(task.state) || Date.parse(task.updatedAt) >= cutoff);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdConnect(deps: DevinCliDeps, args: string[]): Promise<number> {
  const org = takeOption(args, '--org');
  rejectLeftovers(args);
  deps.out('Paste your Devin API key (cog_…). It is not shown, never stored in a file, and goes to the macOS Keychain.');
  let key: string;
  try {
    key = (await deps.readSecret('Devin API key: ')).trim();
  } catch (err) {
    deps.err(err instanceof Error && err.message === 'cancelled' ? 'Cancelled.' : `Could not read the key: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (key === '') {
    deps.err('No key entered.');
    return 1;
  }
  const result = await deps.connect({ key, orgId: org });
  deps.setConfig({ enabled: true });
  const who = result.principal === 'service_user' ? 'service user' : result.principal === 'pat_user' ? 'personal access token' : 'key';
  deps.out(`Connected to Devin as ${result.principalName ? `${result.principalName} (${who})` : `a ${who}`} in ${result.orgId}.`);
  deps.out('The Devin lane is on. Set its ACU budget with: ashlr devin budget --acu <n>');
  deps.out('Devin needs its GitHub integration installed on the repos it works on (app.devin.ai: Settings > Integrations).');
  return 0;
}

async function cmdDisconnect(deps: DevinCliDeps, args: string[]): Promise<number> {
  rejectLeftovers(args);
  const { removedKey } = await deps.disconnect();
  deps.setConfig({ enabled: false, fleet: false });
  deps.out(removedKey ? 'Disconnected: the Devin key was removed from the Keychain and the lane is off.' : 'Disconnected: no key was in the Keychain; the lane is off.');
  return 0;
}

function cmdSwitch(deps: DevinCliDeps, enabled: boolean, args: string[]): number {
  rejectLeftovers(args);
  deps.setConfig(enabled ? { enabled: true } : { enabled: false });
  deps.out(enabled ? 'The Devin lane is on.' : 'The Devin lane is off. Running sessions keep going on Devin; nothing new starts.');
  return 0;
}

function cmdFleet(deps: DevinCliDeps, args: string[]): number {
  const value = args.shift();
  rejectLeftovers(args);
  if (value !== 'on' && value !== 'off') throw new UsageError('Say `ashlr devin fleet on` or `ashlr devin fleet off`.');
  deps.setConfig({ fleet: value === 'on' });
  deps.out(value === 'on'
    ? 'The fleet may launch Devin on well-scoped backlog work — within the ACU budget, its reserve and the fleet caps, under a standing grant that names Devin (run `ashlr authority draft` to include it). On an elite model (SWE-2, GPT-6) under an elite-direct grant its PRs land on green tests; otherwise they merge only when two judges from different families ship them.'
    : 'The fleet will not launch Devin sessions.');
  return 0;
}

async function cmdStatus(deps: DevinCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  rejectLeftovers(args);
  const status = await deps.status();
  const view = deps.budgetView(deps.listTasks(Number.MAX_SAFE_INTEGER), deps.readBudget(), deps.now());
  if (asJson) {
    json(deps, { status, budget: view });
    return 0;
  }
  deps.out(`Devin: ${status.state === 'ready' ? 'ready' : status.state.replace('-', ' ')} — ${status.reason}`);
  if (status.orgId) deps.out(`  Organization: ${status.orgId}${status.principalName ? ` · ${status.principalName}` : ''} · key in the ${status.keyStore === 'keychain' ? 'macOS Keychain' : 'custody helper'}`);
  deps.out(`  ${status.chatLine}`);
  deps.out(`  ${status.fleetLine}`);
  deps.out(`  ACUs: ${acu(view.acuUsed)} of ${acu(view.acuBudgetTotal)} accounted for · ${acu(view.acuToday)} today, used or held · ${view.running} running`);
  if (view.reportedAcuUsed !== undefined && view.unconfirmedAcuExposure !== undefined) {
    deps.out(`  ${acu(view.reportedAcuUsed)} reported usage + adjustment · ${acu(view.unconfirmedAcuExposure)} held exposure · ≈ $${view.estimatedUsdUsed} for recorded usage (estimate)`);
  } else deps.out('  Usage and reservations are not separated; recorded cost coverage is unavailable.');
  if (!view.canLaunch.ok) deps.out(`  Launches refused: ${view.canLaunch.reason}`);
  return 0;
}

async function cmdLaunch(deps: DevinCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  const repoFlag = takeOption(args, '--repo');
  const base = takeOption(args, '--base');
  const title = takeOption(args, '--title');
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown) throw new UsageError(`Unknown option ${unknown}.`);
  const prompt = args.join(' ').trim();
  if (!prompt) throw new UsageError('Describe the task: ashlr devin launch "<task>".');
  const repo = repoFlag ?? deps.originRepo(deps.cwd());
  if (!repo) {
    deps.err('This folder has no GitHub origin. Pass --repo owner/name.');
    return 2;
  }
  const req: DevinLaunchRequest = { repo, prompt, origin: 'cli' };
  if (base !== null) req.baseBranch = base;
  if (title !== null) req.title = title;
  const result = await deps.launch(req);
  if (asJson) {
    json(deps, result);
    return result.ok ? 0 : 1;
  }
  if (!result.ok || !result.task) {
    deps.err(`Not launched: ${result.error ?? 'the Devin session could not be started.'}`);
    return 1;
  }
  const task = result.task;
  deps.out(`Launched Devin task: ${task.title}`);
  if (task.sessionUrl) deps.out(`  Open in Devin: ${task.sessionUrl}`);
  deps.out(`  It delivers a PR from branch ${task.branch} into ${task.baseBranch} on ${task.repo}; capped at ${acu(task.maxAcu)}.`);
  deps.out('  Track it with: ashlr devin list');
  return 0;
}

function cmdList(deps: DevinCliDeps, args: string[]): number {
  const asJson = takeFlag(args, '--json');
  const all = takeFlag(args, '--all');
  rejectLeftovers(args);
  const now = deps.now();
  const tasks = devinTasksToList(deps.listTasks(all ? 500 : undefined), now, all);
  if (asJson) {
    json(deps, tasks);
    return 0;
  }
  if (tasks.length === 0) {
    deps.out(all ? 'No Devin tasks yet.' : 'No Devin tasks in flight or finished in the last 3 days. Use --all for older ones.');
    return 0;
  }
  for (const task of tasks) {
    const used = task.session?.acusConsumed;
    deps.out(`${task.id}  ${STATE_WORDS[task.state].padEnd(15)} ${task.repo}  ${task.title}`);
    const bits = [localWhen(task.launchedAt ?? task.createdAt, now), typeof used === 'number' ? `${acu(used)} of ${acu(task.maxAcu)}` : `cap ${acu(task.maxAcu)}`];
    if (task.pr) bits.push(`PR #${task.pr.number} ${task.pr.url}`);
    else if (task.sessionUrl) bits.push(task.sessionUrl);
    deps.out(`    ${bits.join(' · ')}`);
    if (task.stateReason) deps.out(`    ${task.stateReason}`);
  }
  return 0;
}

async function cmdRefresh(deps: DevinCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  rejectLeftovers(args);
  const result = await deps.refresh();
  if (asJson) json(deps, result);
  else deps.out(`Checked ${result.checked} Devin task(s); ${result.updated} changed.`);
  return 0;
}

async function cmdMessage(deps: DevinCliDeps, args: string[]): Promise<number> {
  const id = args.shift();
  const text = args.join(' ').trim();
  if (!id || !text) throw new UsageError('Say which task and what to tell it: ashlr devin message <task-id> "<text>".');
  const result = await deps.message(id, text);
  if (!result.ok) {
    deps.err(`Not sent: ${result.error}`);
    return 1;
  }
  deps.out('Sent. Devin picks it up in the session.');
  return 0;
}

function cmdBudget(deps: DevinCliDeps, args: string[]): number {
  const asJson = takeFlag(args, '--json');
  const update: DevinBudgetUpdate = {};
  const set = <K extends keyof DevinBudgetUpdate>(key: K, value: number | null): void => {
    if (value !== null) update[key] = value as DevinBudgetUpdate[K];
  };
  set('acuBudgetTotal', takeNumber(args, '--acu'));
  set('acuSpentAdjustment', takeNumber(args, '--spent'));
  set('maxAcuPerSession', takeNumber(args, '--per-session', { whole: true }));
  set('maxAcuPerDay', takeNumber(args, '--per-day'));
  set('reserveAcu', takeNumber(args, '--reserve'));
  const pauseAt = takeNumber(args, '--pause-at');
  if (pauseAt !== null) update.pauseAtFraction = pauseAt > 1 ? pauseAt / 100 : pauseAt;
  set('usdPerAcu', takeNumber(args, '--usd-per-acu'));
  set('maxConcurrent', takeNumber(args, '--max-concurrent', { whole: true, safe: true }));
  set('maxSessionsPerDay', takeNumber(args, '--max-per-day', { whole: true, safe: true }));
  set('fleetMaxConcurrent', takeNumber(args, '--fleet-concurrent', { whole: true, safe: true }));
  set('fleetMaxSessionsPerDay', takeNumber(args, '--fleet-per-day', { whole: true, safe: true }));
  rejectLeftovers(args);
  const budget = Object.keys(update).length > 0 ? deps.updateBudget(update) : deps.readBudget();
  const view = deps.budgetView(deps.listTasks(Number.MAX_SAFE_INTEGER), budget, deps.now());
  if (asJson) {
    json(deps, view);
    return 0;
  }
  deps.out(`Devin budget: ${acu(view.acuUsed)} of ${acu(view.acuBudgetTotal)} accounted for · ${acu(view.acuRemaining)} left before in-flight reservations${view.paused ? ' · PAUSED' : ''}`);
  deps.out(`  Today: ${acu(view.acuToday)} of ${acu(budget.maxAcuPerDay)} (used + unresolved exposure) · ${view.sessionsToday} of ${budget.maxSessionsPerDay} sessions`);
  deps.out(`  Each session capped at ${acu(budget.maxAcuPerSession)} · ${view.running} of ${budget.maxConcurrent} running · reserve ${acu(budget.reserveAcu)} kept for you · pauses at ${Math.round(budget.pauseAtFraction * 100)}%`);
  deps.out(`  Fleet: ${view.fleetRunning} of ${budget.fleetMaxConcurrent} running · ${view.fleetSessionsToday} of ${budget.fleetMaxSessionsPerDay} today · ${view.canFleetLaunch.ok ? 'fleet launches allowed' : `fleet launches refused: ${view.canFleetLaunch.reason}`}`);
  if (view.reportedAcuUsed !== undefined && view.unconfirmedAcuExposure !== undefined) {
    deps.out(`  ${acu(view.reportedAcuUsed)} reported usage + adjustment · ${acu(view.unconfirmedAcuExposure)} held exposure`);
    deps.out(`  ≈ $${view.estimatedUsdUsed} for recorded usage at $${budget.usdPerAcu}/ACU (estimate).`);
  } else deps.out('  Usage and reservations are not separated; recorded cost coverage is unavailable.');
  deps.out(`  ${view.canLaunch.ok ? 'Launches allowed.' : `Launches refused: ${view.canLaunch.reason}`}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const DEP_KEYS: readonly (keyof DevinCliDeps)[] = [
  'connect', 'disconnect', 'setConfig', 'status', 'launch', 'listTasks', 'refresh', 'message',
  'readBudget', 'updateBudget', 'budgetView', 'readSecret', 'originRepo', 'cwd', 'now', 'out', 'err',
];

function isComplete(deps: Partial<DevinCliDeps>): deps is DevinCliDeps {
  return DEP_KEYS.every((key) => deps[key] !== undefined);
}

/** No absolute home paths and no key-shaped text in output. */
function clean(text: string): string {
  const home = process.env['HOME'];
  const noHome = home && home.length > 1 ? text.split(home).join('~') : text;
  return noHome.replace(/\bcog_[A-Za-z0-9_-]+/g, '[REDACTED]');
}

export async function runDevinCli(argv: string[], injected?: Partial<DevinCliDeps>): Promise<number> {
  const args = [...argv];
  const sub = args.shift();
  const print = injected?.out ?? ((line: string) => console.log(line));
  const printErr = injected?.err ?? ((line: string) => console.error(line));
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    (sub ? print : printErr)(USAGE);
    return sub ? 0 : 2;
  }
  const known = ['connect', 'disconnect', 'enable', 'disable', 'fleet', 'status', 'launch', 'list', 'ls', 'refresh', 'message', 'budget'];
  if (!known.includes(sub)) {
    printErr(`Unknown devin command "${sub}".\n\n${USAGE}`);
    return 2;
  }
  const deps: DevinCliDeps = injected && isComplete(injected) ? injected : { ...(await defaultDeps()), ...injected };
  try {
    switch (sub) {
      case 'connect': return await cmdConnect(deps, args);
      case 'disconnect': return await cmdDisconnect(deps, args);
      case 'enable': return cmdSwitch(deps, true, args);
      case 'disable': return cmdSwitch(deps, false, args);
      case 'fleet': return cmdFleet(deps, args);
      case 'status': return await cmdStatus(deps, args);
      case 'launch': return await cmdLaunch(deps, args);
      case 'list':
      case 'ls': return cmdList(deps, args);
      case 'refresh': return await cmdRefresh(deps, args);
      case 'message': return await cmdMessage(deps, args);
      default: return cmdBudget(deps, args);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      deps.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    deps.err(`devin ${sub} failed: ${clean(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}
