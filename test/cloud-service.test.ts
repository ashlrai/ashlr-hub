/**
 * 3.11 cloud lane — orchestration (src/core/cloud/service.ts) with fake deps:
 * git, gh and the PTY runner are injected, so nothing is cloned, no claude is
 * started and nothing is spent. HOME is relocated per test; the seat's
 * command.json is written there when a test needs the real seat reader.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendUserBacklogItems } from '../src/core/cloud/backlog.js';
import { BUILTIN_IMPROVEMENT_BACKLOG } from '../src/core/cloud/improvement-backlog.js';
import { cloudSeatCommandPath } from '../src/core/cloud/launcher.js';
import {
  cloudOverview,
  cloudSeatStatus,
  deriveCloudTitle,
  launchCloudTask,
  runSelfImprove,
  type CloudServiceDeps,
} from '../src/core/cloud/service.js';
import { listCloudTasks, readCloudTask, updateCloudBudget, writeCloudTask } from '../src/core/cloud/store.js';
import { CLOUD_PROMPT_MAX_CHARS, CLOUD_TASK_ID_PATTERN, type CloudLaunchRequest, type CloudTaskV1 } from '../src/core/cloud/types.js';

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  delete process.env['ASHLR_HOME'];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-service-')));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-09-24T18:00:00.000Z');
const SUCCESS = (id: string, title = 'T') => `Created cloud session: ${title}\r\nView: https://claude.ai/code/${id}?from=cli&m=0\r\nResume with: claude --teleport ${id}\r\n`;
const AUTH = 'Error: Claude Code cloud sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate…';

interface Harness {
  deps: CloudServiceDeps;
  events: string[];
  prompts: string[];
  gitCalls: string[][];
}

/** Fake world: gh knows the default branch, git "clones" by making .git, the PTY runner answers with `output`. */
function harness(opts: {
  output?: string | ((n: number) => string);
  timedOut?: boolean;
  gitStderr?: string | null;
  seat?: string[] | null;
  defaultBranch?: string | null;
  runDelayMs?: number;
} = {}): Harness {
  const events: string[] = [];
  const prompts: string[] = [];
  const gitCalls: string[][] = [];
  let runs = 0;
  const deps: CloudServiceDeps = {
    now: () => NOW,
    tracker: {
      gh: async (args) => {
        events.push(`gh ${args[0]} ${args[1]}`);
        return opts.defaultBranch === null ? { ok: false, stdout: '', stderr: 'offline' } : { ok: true, stdout: `${opts.defaultBranch ?? 'master'}\n`, stderr: '' };
      },
    },
    checkout: {
      git: async (args) => {
        gitCalls.push(args);
        events.push(`git ${args[0]}`);
        if (opts.gitStderr) return { ok: false, stdout: '', stderr: opts.gitStderr };
        if (args[0] === 'clone') fs.mkdirSync(path.join(args.at(-1)!, '.git'), { recursive: true });
        return { ok: true, stdout: '', stderr: '' };
      },
    },
    launcher: {
      seatArgv: () => (opts.seat === undefined ? ['/opt/node', '/p/launcher.mjs'] : opts.seat),
      platform: 'darwin',
      run: async (argv, runOpts) => {
        runs += 1;
        events.push('run');
        prompts.push(argv.at(-1)!);
        // The launch must happen in the prepared checkout, and the task must already be persisted as launching.
        const persisted = listCloudTasks().find((t) => t.state === 'launching');
        events.push(`persisted:${persisted ? 'launching' : 'none'}`);
        expect(runOpts.cwd).toBe(path.join(home, '.ashlr', 'cloud', 'checkouts', 'ashlrai__ashlr-hub'));
        if (opts.runDelayMs) await new Promise((r) => setTimeout(r, opts.runDelayMs));
        const output = typeof opts.output === 'function' ? opts.output(runs) : opts.output ?? SUCCESS(`session_${runs}`);
        return { output, code: opts.timedOut ? null : 0, timedOut: opts.timedOut ?? false };
      },
    },
  };
  return { deps, events, prompts, gitCalls };
}

const REQ: CloudLaunchRequest = { repo: 'ashlrai/ashlr-hub', prompt: 'Fix the flaky tracker test.\nMore detail here.', origin: 'operator' };

describe('launchCloudTask — success', () => {
  it('validates, gates, persists queued, checks out the base, launches with the contract, persists running', async () => {
    const h = harness();
    const res = await launchCloudTask({ ...REQ, baseBranch: 'v3110-cloud' }, h.deps);
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    expect(res.failure).toBeNull();
    const task = res.task!;
    expect(task.id).toMatch(CLOUD_TASK_ID_PATTERN);
    expect(task).toMatchObject({
      repo: 'ashlrai/ashlr-hub', baseBranch: 'v3110-cloud', branch: `ashlr-cloud/${task.id}`, title: 'Fix the flaky tracker test.',
      prompt: REQ.prompt, origin: 'operator', requestedBy: 'mason', seat: 'claude-a', state: 'running', failure: null,
      sessionId: 'session_1', sessionUrl: 'https://claude.ai/code/session_1?from=cli&m=0', estimatedCostUsd: 3,
      createdAt: NOW.toISOString(), launchedAt: NOW.toISOString(), backlogItemId: null, needsYouId: null, pr: null, report: null,
    });
    expect(readCloudTask(task.id)).toEqual(task);
    // Given a base branch, gh is never asked for the default.
    expect(h.events).toEqual(['git clone', 'git remote', 'git remote', 'git fetch', 'git checkout', 'git branch', 'git clean', 'run', 'persisted:launching']);
    expect(h.gitCalls.find((a) => a[0] === 'fetch')).toContain('+refs/heads/v3110-cloud:refs/remotes/origin/v3110-cloud');
    // The session gets the task text AND the delivery contract for this task's branch.
    expect(h.prompts[0]!.startsWith(REQ.prompt)).toBe(true);
    expect(h.prompts[0]).toContain(`Create branch \`${task.branch}\` from \`v3110-cloud\``);
  });

  it('uses the repo\'s default branch from GitHub when none is given, falling back to main', async () => {
    const h = harness({ defaultBranch: 'master' });
    expect((await launchCloudTask(REQ, h.deps)).task!.baseBranch).toBe('master');
    expect(h.events[0]).toBe('gh repo view');
    const offline = harness({ defaultBranch: null });
    expect((await launchCloudTask(REQ, offline.deps)).task!.baseBranch).toBe('main');
  });

  it('truncates the prompt, derives the title from the first line, and prefers an explicit title', async () => {
    const long = `${'word '.repeat(30)}\n${'x'.repeat(CLOUD_PROMPT_MAX_CHARS)}`;
    const res = await launchCloudTask({ ...REQ, prompt: `\n\n  ${long}` }, harness().deps);
    expect(res.task!.prompt.length).toBe(CLOUD_PROMPT_MAX_CHARS);
    expect(res.task!.title.length).toBeLessThanOrEqual(80);
    expect(res.task!.title.endsWith('word…')).toBe(true);
    expect((await launchCloudTask({ ...REQ, title: '  Short title  ' }, harness().deps)).task!.title).toBe('Short title');
  });

  it('records requestedBy and the backlog / Needs-you links for internal launches', async () => {
    const leader = await launchCloudTask({ ...REQ, origin: 'leader', needsYouId: 'ny_123', backlogItemId: 'leader-m1-1' }, harness().deps);
    expect(leader.task).toMatchObject({ origin: 'leader', requestedBy: 'leader', needsYouId: 'ny_123', backlogItemId: 'leader-m1-1' });
    expect((await launchCloudTask({ ...REQ, origin: 'chat' }, harness().deps)).task!.requestedBy).toBe('mason');
  });
});

describe('launchCloudTask — validation (nothing persisted, nothing run)', () => {
  it.each([
    ['a bad repo', { ...REQ, repo: 'https://github.com/ashlrai/ashlr-hub' }, /owner\/name/],
    ['a repo with a space', { ...REQ, repo: 'ashlrai/ashlr hub' }, /owner\/name/],
    ['an empty prompt', { ...REQ, prompt: '   ' }, /Describe the task/],
    ['an unsafe base branch', { ...REQ, baseBranch: '--upload-pack=x' }, /branch name/],
    ['an unknown origin', { ...REQ, origin: 'web' as 'chat' }, /unknown place/],
  ])('refuses %s', async (_label, req, message) => {
    const h = harness();
    const res = await launchCloudTask(req, h.deps);
    expect(res).toMatchObject({ ok: false, task: null, failure: null });
    expect(res.error).toMatch(message);
    expect(listCloudTasks()).toEqual([]);
    expect(h.events.filter((e) => e !== 'gh repo view')).toEqual([]);
  });
});

describe('launchCloudTask — gates come before persisting and launching', () => {
  it('refuses when the seat is not set up (seat-unavailable), persisting nothing', async () => {
    const h = harness({ seat: null });
    const res = await launchCloudTask({ ...REQ, baseBranch: 'master' }, h.deps);
    expect(res).toEqual({ ok: false, task: null, error: "The Claude seat isn't set up on this Mac.", failure: 'seat-unavailable' });
    expect(listCloudTasks()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('refuses over budget (failure budget, plain reason), persisting nothing', async () => {
    updateCloudBudget({ creditsTotalUsd: 2 });
    const h = harness();
    const res = await launchCloudTask({ ...REQ, baseBranch: 'master' }, h.deps);
    expect(res).toEqual({ ok: false, task: null, failure: 'budget', error: 'About $2 of estimated credits is left — not enough for another session at $3 each.' });
    expect(listCloudTasks()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('a self-improve origin through the public entry point is held to the self-improvement gate', async () => {
    updateCloudBudget({ selfImprove: { enabled: false } });
    const res = await launchCloudTask({ ...REQ, origin: 'self-improve', baseBranch: 'master' }, harness().deps);
    expect(res).toMatchObject({ ok: false, failure: 'budget', error: 'Self-improvement is turned off.' });
  });

  it('two racing launches cannot both pass a concurrency cap of one', async () => {
    updateCloudBudget({ maxConcurrent: 1 });
    const h = harness({ runDelayMs: 20 });
    const [a, b] = await Promise.all([
      launchCloudTask({ ...REQ, baseBranch: 'master' }, h.deps),
      launchCloudTask({ ...REQ, repo: 'ashlrai/other', baseBranch: 'master' }, h.deps),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ failure: 'budget', error: '1 of 1 cloud session is already running.' });
  });

  it('serialises launches for the same repo', async () => {
    const h = harness({ runDelayMs: 15 });
    let active = 0;
    let peak = 0;
    const run = h.deps.launcher!.run!;
    h.deps.launcher!.run = async (argv, o) => { active += 1; peak = Math.max(peak, active); try { return await run(argv, o); } finally { active -= 1; } };
    const results = await Promise.all([1, 2, 3].map(() => launchCloudTask({ ...REQ, baseBranch: 'master' }, h.deps)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(1);
    expect(new Set(results.map((r) => r.task!.sessionId)).size).toBe(3);
  });
});

describe('launchCloudTask — each launch failure is persisted as failed with a plain reason', () => {
  it.each([
    ['auth', { output: AUTH }],
    ['not-enabled', { output: 'Error: Cloud sessions are not enabled for your account.' }],
    ['rate-limited', { output: 'Error: usage limit reached' }],
    ['no-remote', { output: 'fatal: not a git repository' }],
    ['timeout', { output: 'Connecting…', timedOut: true }],
    ['unparsed', { output: 'Welcome to Claude Code' }],
    ['unknown', { output: 'Error: something odd happened' }],
    ['no-remote', { gitStderr: "fatal: Remote branch master not found in upstream origin" }],
    ['checkout-failed', { gitStderr: 'fatal: unable to write' }],
  ] as const)('%s', async (failure, opts) => {
    const h = harness(opts);
    const res = await launchCloudTask({ ...REQ, baseBranch: 'master' }, h.deps);
    expect(res.ok).toBe(false);
    expect(res.failure).toBe(failure);
    expect(res.error).toBeTruthy();
    expect(res.error).not.toMatch(/\/tmp|\/home|\/Users/);
    expect(res.task).toMatchObject({ state: 'failed', failure, stateReason: res.error, sessionId: null, launchedAt: null });
    expect(readCloudTask(res.task!.id)).toMatchObject({ state: 'failed', failure });
  });
});

describe('runSelfImprove', () => {
  const firstBuiltin = [...BUILTIN_IMPROVEMENT_BACKLOG].map((it, i) => ({ it, i })).sort((a, b) => a.it.priority - b.it.priority || a.i - b.i).map(({ it }) => it);

  it('auto: does nothing when self-improvement is off', async () => {
    updateCloudBudget({ selfImprove: { enabled: false } });
    const h = harness();
    const res = await runSelfImprove({ auto: true }, h.deps);
    expect(res.launched).toEqual([]);
    expect(res.skipped).toEqual([{ itemId: firstBuiltin[0]!.id, reason: 'Self-improvement is turned off.' }]);
    expect(listCloudTasks()).toEqual([]);
  });

  it('manual: the Improve button launches even when auto self-improvement is off', async () => {
    updateCloudBudget({ selfImprove: { enabled: false } });
    const res = await runSelfImprove({ auto: false }, harness().deps);
    expect(res.launched).toHaveLength(1);
    expect(res.launched[0]).toMatchObject({
      origin: 'self-improve', requestedBy: 'self-improve', backlogItemId: firstBuiltin[0]!.id, title: firstBuiltin[0]!.title,
      repo: 'ashlrai/ashlr-hub', baseBranch: 'master', prompt: firstBuiltin[0]!.prompt,
    });
  });

  it('launches the next items in order, each claiming its item, capped at 5', async () => {
    updateCloudBudget({ maxConcurrent: 10 });
    const res = await runSelfImprove({ auto: false, count: 99 }, harness().deps);
    expect(res.launched.map((t) => t.backlogItemId)).toEqual(firstBuiltin.slice(0, 5).map((i) => i.id));
    expect(res.skipped).toEqual([]);
  });

  it('the operator path still stops at the concurrency cap', async () => {
    const res = await runSelfImprove({ auto: false, count: 5 }, harness().deps);
    expect(res.launched).toHaveLength(4);
    expect(res.skipped).toEqual([{ itemId: firstBuiltin[4]!.id, reason: '4 of 4 cloud sessions are already running.' }]);
  });

  it('auto: stops at the daily self-improvement cap', async () => {
    updateCloudBudget({ selfImprove: { maxPerDay: 2 } });
    const res = await runSelfImprove({ auto: true, count: 4 }, harness().deps);
    expect(res.launched).toHaveLength(2);
    expect(res.skipped).toEqual([{ itemId: firstBuiltin[2]!.id, reason: '2 of 2 self-improvement launches used today.' }]);
  });

  it('stops the batch at the first failed launch instead of burning through the backlog', async () => {
    const res = await runSelfImprove({ auto: false, count: 3 }, harness({ output: AUTH }).deps);
    expect(res.launched).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.itemId).toBe(firstBuiltin[0]!.id);
    expect(listCloudTasks()).toHaveLength(1);
  });

  it('targets budget.selfImprove.repo and honours repo-scoped user items', async () => {
    updateCloudBudget({ selfImprove: { repo: 'ashlrai/other' } });
    appendUserBacklogItems([{ id: 'other-1', title: 'Other repo item', prompt: 'Do it.', area: 'x', priority: 1, repo: 'ashlrai/other' }]);
    const h = harness();
    // Launches from the other repo's checkout; the harness asserts the ashlr-hub folder, so relax it here.
    h.deps.launcher!.run = async () => ({ output: SUCCESS('session_o'), code: 0, timedOut: false });
    const res = await runSelfImprove({ auto: false }, h.deps);
    expect(res.launched[0]).toMatchObject({ repo: 'ashlrai/other', backlogItemId: firstBuiltin[0]!.id });
  });

  it('returns nothing when the backlog is exhausted', async () => {
    const now = NOW.toISOString();
    let n = 0;
    for (const item of BUILTIN_IMPROVEMENT_BACKLOG) {
      n += 1;
      const id = `ct_20260924T1800_${String(n).padStart(6, '0')}`;
      const t: CloudTaskV1 = {
        v: 1, id, repo: 'ashlrai/ashlr-hub', baseBranch: 'master', branch: `ashlr-cloud/${id}`, title: 't', prompt: 'p', origin: 'self-improve',
        requestedBy: 'self-improve', seat: 'claude-a', sessionId: 's', sessionUrl: null, state: 'merged', stateReason: null, failure: null,
        createdAt: '2026-09-01T00:00:00.000Z', launchedAt: '2026-09-01T00:00:00.000Z', updatedAt: now, pr: null, report: null,
        estimatedCostUsd: 0, backlogItemId: item.id, needsYouId: null,
      };
      writeCloudTask(t);
    }
    expect(await runSelfImprove({ auto: true, count: 3 }, harness().deps)).toEqual({ launched: [], skipped: [] });
  });
});

describe('cloudOverview and cloudSeatStatus', () => {
  it('seat: not ready without command.json, ready once it parses to an argv array — without running anything', () => {
    expect(cloudSeatStatus()).toEqual({ id: 'claude-a', ready: false, reason: "The Claude seat isn't set up on this Mac." });
    const file = cloudSeatCommandPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '"node launcher.mjs"', { mode: 0o600 });
    expect(cloudSeatStatus().ready).toBe(false);
    fs.writeFileSync(file, JSON.stringify(['/opt/node', '/p/launcher.mjs']), { mode: 0o600 });
    expect(cloudSeatStatus()).toEqual({ id: 'claude-a', ready: true, reason: null });
  });

  it('returns tasks newest first (≤ 100), the budget view, the backlog and the seat — reading disk only', async () => {
    const h = harness();
    await launchCloudTask({ ...REQ, baseBranch: 'master' }, h.deps);
    await launchCloudTask({ ...REQ, baseBranch: 'master' }, harness({ output: AUTH }).deps);
    h.events.length = 0;
    const overview = await cloudOverview({ now: () => NOW });
    expect(overview.generatedAt).toBe(NOW.toISOString());
    expect(overview.tasks).toHaveLength(2);
    expect(overview.budget).toMatchObject({ estimatedSpentUsd: 3, estimatedRemainingUsd: 247, sessionsToday: 1, running: 1 });
    expect(overview.backlog.items.length).toBe(BUILTIN_IMPROVEMENT_BACKLOG.length);
    expect(overview.seat.ready).toBe(false);
    expect(h.events).toEqual([]);
    // No absolute paths leak into what the API will serve.
    expect(JSON.stringify(overview)).not.toContain(home);
  });

  it('answers on an empty home', async () => {
    const overview = await cloudOverview();
    expect(overview.tasks).toEqual([]);
    expect(overview.budget.canLaunch.ok).toBe(true);
    expect(overview.backlog.nextUp).not.toBeNull();
  });
});

describe('deriveCloudTitle', () => {
  it('first non-empty line, collapsed, ≤ 80 chars at a word boundary', () => {
    expect(deriveCloudTitle('\n  Fix   the\tthing  \nmore')).toBe('Fix the thing');
    const t = deriveCloudTitle('alpha '.repeat(30));
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t).toMatch(/alpha…$/);
    expect(deriveCloudTitle('x'.repeat(200))).toHaveLength(80);
  });
});
