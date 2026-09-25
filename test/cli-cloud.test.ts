/**
 * 3.11 cloud lane, unit C2 — `ashlr cloud` (src/cli/cloud.ts).
 *
 * Every dependency is injected: nothing here reads a real task store, runs
 * `git` or `gh`, or launches (and pays for) a cloud session. HOME is still
 * relocated so a regression that reached the real store could only write
 * into a temp folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { localWhen, parseBudgetFlags, parseGithubRepo, runCloudCli, tasksToList, type CloudCliDeps } from '../src/cli/cloud.js';
import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';
import { HELP_ENTRIES } from '../src/cli/help.js';
import {
  DEFAULT_CLOUD_BUDGET,
  type CloudBudgetUpdate,
  type CloudBudgetV1,
  type CloudBudgetView,
  type CloudTaskV1,
} from '../src/core/cloud/types.js';

// Local noon, so "today"/"yesterday" hold in any time zone the suite runs in.
const NOW = new Date(2026, 8, 25, 12, 0, 0);
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-cli-cloud-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function task(over: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  seq += 1;
  const id = over.id ?? `ct_20260925T1200_${String(seq).padStart(6, '0')}`;
  return {
    v: 1,
    id,
    repo: 'ashlrai/ashlr-hub',
    baseBranch: 'main',
    branch: `ashlr-cloud/${id}`,
    title: 'Fix the flaky test',
    prompt: 'Fix the flaky test.',
    origin: 'cli',
    requestedBy: 'mason',
    seat: 'claude-a',
    sessionId: 'session_01abc',
    sessionUrl: 'https://claude.ai/code/session_01abc',
    state: 'running',
    stateReason: null,
    failure: null,
    createdAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    launchedAt: new Date(NOW.getTime() - 59 * 60_000).toISOString(),
    updatedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    pr: null,
    report: null,
    estimatedCostUsd: 3,
    backlogItemId: null,
    needsYouId: null,
    ...over,
  };
}

function budget(over: Partial<CloudBudgetV1> = {}): CloudBudgetV1 {
  return { ...DEFAULT_CLOUD_BUDGET, selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove }, updatedAt: NOW.toISOString(), ...over };
}

function view(b: CloudBudgetV1): CloudBudgetView {
  return {
    creditsTotalUsd: b.creditsTotalUsd,
    estimatedSpentUsd: 12,
    estimatedRemainingUsd: b.creditsTotalUsd - 12,
    sessionsToday: 4,
    selfImproveToday: 2,
    running: 1,
    canLaunch: { ok: true, reason: null },
    canSelfImprove: { ok: false, reason: '4 of 4 self-improvement launches used today.' },
    estimateNote: 'Estimated at $3 per session — Claude doesn\'t expose the credit balance. Check it on claude.ai and adjust here.',
    balanceUrl: 'https://claude.ai/settings/usage',
    budget: b,
  };
}

interface Harness {
  deps: CloudCliDeps;
  out: string[];
  err: string[];
  tasks: CloudTaskV1[];
}

function harness(over: Partial<CloudCliDeps> = {}): Harness {
  const h: Harness = { deps: null as unknown as CloudCliDeps, out: [], err: [], tasks: [] };
  h.deps = {
    launch: vi.fn(async () => ({ ok: true, task: task(), error: null, failure: null })),
    listTasks: vi.fn(() => h.tasks),
    readBudget: vi.fn(() => budget()),
    updateBudget: vi.fn((u: CloudBudgetUpdate) => budget({ ...u, selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove, ...u.selfImprove } } as Partial<CloudBudgetV1>)),
    budgetView: vi.fn((_t, b) => view(b)),
    refresh: vi.fn(async () => ({ checked: 3, updated: 1 })),
    improve: vi.fn(async () => ({ launched: [], skipped: [] })),
    backlog: vi.fn(() => ({ items: [], nextUp: null })),
    seat: vi.fn(() => ({ id: 'claude-a', ready: true, reason: null })),
    originRepo: vi.fn(() => 'ashlrai/ashlr-hub'),
    cwd: () => path.join(home, 'work', 'ashlr-hub'),
    now: () => NOW,
    out: (line) => { h.out.push(line); },
    err: (line) => { h.err.push(line); },
    color: false,
    ...over,
  };
  return h;
}

const text = (lines: string[]): string => lines.join('\n');

describe('pure helpers', () => {
  it.each([
    ['https://github.com/ashlrai/ashlr-hub.git', 'ashlrai/ashlr-hub'],
    ['https://github.com/ashlrai/ashlr-hub', 'ashlrai/ashlr-hub'],
    ['https://x-access-token:abc@github.com/ashlrai/ashlr-hub.git\n', 'ashlrai/ashlr-hub'],
    ['git@github.com:ashlrai/ashlr.hub.git', 'ashlrai/ashlr.hub'],
    ['ssh://git@github.com/ashlrai/ashlr-hub.git', 'ashlrai/ashlr-hub'],
    ['ssh://git@github.com:22/ashlrai/ashlr-hub', 'ashlrai/ashlr-hub'],
    ['https://gitlab.com/ashlrai/ashlr-hub.git', null],
    ['/Users/mason/repos/ashlr-hub', null],
    ['https://github.com/ashlrai', null],
  ])('parseGithubRepo(%j) = %j', (url, expected) => {
    expect(parseGithubRepo(url)).toBe(expected);
  });

  it('localWhen speaks local time, never ISO', () => {
    const today = new Date(2026, 8, 25, 9, 5).toISOString();
    const yesterday = new Date(2026, 8, 24, 21, 40).toISOString();
    const earlier = new Date(2026, 8, 20, 16, 0).toISOString();
    const lastYear = new Date(2025, 11, 31, 8, 0).toISOString();
    expect(localWhen(today, NOW)).toBe('today 9:05 AM');
    expect(localWhen(yesterday, NOW)).toBe('yesterday 9:40 PM');
    expect(localWhen(earlier, NOW)).toBe('Sep 20 4:00 PM');
    expect(localWhen(lastYear, NOW)).toBe('Dec 31, 2025 8:00 AM');
    expect(localWhen(null, NOW)).toBe('unknown time');
    expect(localWhen('garbage', NOW)).toBe('unknown time');
  });

  it('tasksToList keeps work in flight and recent endings unless --all', () => {
    const running = task({ state: 'running', updatedAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() });
    const recent = task({ state: 'merged', updatedAt: new Date(NOW.getTime() - 86_400_000).toISOString() });
    const old = task({ state: 'closed', updatedAt: new Date(NOW.getTime() - 4 * 86_400_000).toISOString() });
    expect(tasksToList([running, recent, old], NOW, false)).toEqual([running, recent]);
    expect(tasksToList([running, recent, old], NOW, true)).toEqual([running, recent, old]);
  });

  it('parseBudgetFlags maps every flag and consumes it', () => {
    const args = ['--total', '300', '--spent', '$12.50', '--per-session', '2.5', '--max-per-day', '10', '--max-concurrent', '2',
      '--self-improve', 'off', '--self-improve-max', '1', '--reserve', '60'];
    expect(parseBudgetFlags(args)).toEqual({
      creditsTotalUsd: 300,
      creditsSpentAdjustmentUsd: 12.5,
      estimatedCostPerSessionUsd: 2.5,
      maxSessionsPerDay: 10,
      maxConcurrent: 2,
      selfImprove: { enabled: false, maxPerDay: 1, reserveUsd: 60 },
    });
    expect(args).toEqual([]);
    expect(parseBudgetFlags([])).toEqual({});
  });
});

describe('usage', () => {
  it('prints usage with exit 2 when no subcommand is given, 0 for help', async () => {
    const h = harness();
    expect(await runCloudCli([], h.deps)).toBe(2);
    expect(text(h.err)).toContain('ashlr cloud launch');
    const h2 = harness();
    expect(await runCloudCli(['help'], h2.deps)).toBe(0);
    expect(text(h2.out)).toContain('Spend is an estimate');
  });

  it('rejects an unknown subcommand', async () => {
    const h = harness();
    expect(await runCloudCli(['nuke'], h.deps)).toBe(2);
    expect(h.err[0]).toContain('Unknown cloud command "nuke"');
  });

  it.each([
    [['list', '--bogus']],
    [['list', 'extra']],
    [['budget', '--total', 'lots']],
    [['budget', '--total', '-5']],
    [['budget', '--max-per-day', '2.5']],
    [['budget', '--self-improve', 'maybe']],
    [['budget', '--total']],
    [['improve', '--count', '9']],
    [['improve', '--count', '0']],
    [['launch']],
    [['launch', 'do it', '--wat']],
  ])('%j is a usage error (exit 2) that touches nothing', async (argv) => {
    const h = harness();
    expect(await runCloudCli(argv, h.deps)).toBe(2);
    expect(h.deps.launch).not.toHaveBeenCalled();
    expect(h.deps.updateBudget).not.toHaveBeenCalled();
    expect(h.deps.improve).not.toHaveBeenCalled();
  });
});

describe('launch', () => {
  it('launches the joined task text on the folder\'s GitHub origin', async () => {
    const h = harness();
    expect(await runCloudCli(['launch', 'Fix', 'the flaky test'], h.deps)).toBe(0);
    expect(h.deps.originRepo).toHaveBeenCalledWith(path.join(home, 'work', 'ashlr-hub'));
    expect(h.deps.launch).toHaveBeenCalledWith({ repo: 'ashlrai/ashlr-hub', prompt: 'Fix the flaky test', origin: 'cli' });
    const out = text(h.out);
    expect(out).toContain('Launched cloud task: Fix the flaky test');
    expect(out).toContain('Open in Claude: https://claude.ai/code/session_01abc');
    expect(out).toContain('Estimated cost: $3.00');
    expect(out).not.toContain(home);
  });

  it('honours --repo, --base and --title', async () => {
    const h = harness();
    await runCloudCli(['launch', 'Do it', '--repo', 'ashlrai/other', '--base', 'v3110-cloud', '--title', 'Short'], h.deps);
    expect(h.deps.originRepo).not.toHaveBeenCalled();
    expect(h.deps.launch).toHaveBeenCalledWith({ repo: 'ashlrai/other', prompt: 'Do it', origin: 'cli', baseBranch: 'v3110-cloud', title: 'Short' });
  });

  it('asks for --repo when the folder has no GitHub origin', async () => {
    const h = harness({ originRepo: vi.fn(() => null) });
    expect(await runCloudCli(['launch', 'Do it'], h.deps)).toBe(2);
    expect(h.err[0]).toBe('This folder has no GitHub origin. Pass --repo owner/name.');
    expect(h.deps.launch).not.toHaveBeenCalled();
  });

  it('reports a refusal plainly with exit 1', async () => {
    const h = harness({ launch: vi.fn(async () => ({ ok: false, task: null, error: '20 of 20 cloud sessions used today.', failure: 'budget' as const })) });
    expect(await runCloudCli(['launch', 'Do it'], h.deps)).toBe(1);
    expect(h.err[0]).toBe('Not launched: 20 of 20 cloud sessions used today.');
  });

  it('--json prints the response and keeps the exit code', async () => {
    const refused = { ok: false, task: null, error: 'No.', failure: 'budget' as const };
    const h = harness({ launch: vi.fn(async () => refused) });
    expect(await runCloudCli(['launch', 'Do it', '--json'], h.deps)).toBe(1);
    expect(JSON.parse(text(h.out))).toEqual(refused);
  });

  it('a thrown error is exit 1 with no absolute home path', async () => {
    const h = harness({ launch: vi.fn(async () => { throw new Error(`EACCES ${home}/.ashlr/cloud/tasks`); }) });
    expect(await runCloudCli(['launch', 'Do it'], h.deps)).toBe(1);
    expect(h.err[0]).toBe('cloud launch failed: EACCES ~/.ashlr/cloud/tasks');
  });
});

describe('list', () => {
  it('prints each task with local times, links and reasons — no ISO, no paths', async () => {
    const h = harness();
    h.tasks = [
      task({ state: 'pr-open', title: 'Tidy the router', pr: { number: 7, url: 'https://github.com/ashlrai/ashlr-hub/pull/7', state: 'open', draft: true, title: 't' }, report: { status: 'done', summary: 'Done.', testsRun: [], risks: [] } }),
      task({ state: 'running' }),
      task({ state: 'failed', stateReason: 'Out of credits.', sessionUrl: null }),
    ];
    expect(await runCloudCli(['list'], h.deps)).toBe(0);
    const out = text(h.out);
    expect(out).toContain('PR open    Tidy the router');
    expect(out).toContain('PR #7: https://github.com/ashlrai/ashlr-hub/pull/7');
    expect(out).toContain('Report (done): Done.');
    expect(out).toContain('Session: https://claude.ai/code/session_01abc');
    expect(out).toContain('Out of credits.');
    expect(out).toContain('started today 11:00 AM');
    expect(out).not.toMatch(ISO_RE);
    expect(out).not.toContain(home);
  });

  it('explains an empty list', async () => {
    const h = harness();
    await runCloudCli(['list'], h.deps);
    expect(h.out[0]).toContain('No cloud tasks in flight');
    const h2 = harness();
    await runCloudCli(['list', '--all'], h2.deps);
    expect(h2.out[0]).toBe('No cloud tasks yet.');
    expect(h2.deps.listTasks).toHaveBeenCalledWith(500);
  });

  it('--json prints the filtered tasks', async () => {
    const h = harness();
    h.tasks = [task()];
    await runCloudCli(['list', '--json'], h.deps);
    expect(JSON.parse(text(h.out))).toEqual(h.tasks);
  });

  it('accepts ls as an alias', async () => {
    const h = harness();
    expect(await runCloudCli(['ls'], h.deps)).toBe(0);
  });
});

describe('refresh', () => {
  it('prints the counts', async () => {
    const h = harness();
    expect(await runCloudCli(['refresh'], h.deps)).toBe(0);
    expect(h.out).toEqual(['Checked 3 tasks on GitHub; 1 changed.']);
  });

  it('--json', async () => {
    const h = harness();
    await runCloudCli(['refresh', '--json'], h.deps);
    expect(JSON.parse(text(h.out))).toEqual({ checked: 3, updated: 1 });
  });
});

describe('improve', () => {
  it('runs the operator path with the count and lists what happened', async () => {
    const h = harness({
      improve: vi.fn(async () => ({
        launched: [task({ title: 'Fix the release pins' })],
        skipped: [{ itemId: 'first-paint-350', reason: '20 of 20 cloud sessions used today.' }],
      })),
    });
    expect(await runCloudCli(['improve', '--count', '2'], h.deps)).toBe(0);
    expect(h.deps.improve).toHaveBeenCalledWith({ count: 2, auto: false });
    expect(h.out).toEqual([
      'Launched: Fix the release pins — https://claude.ai/code/session_01abc',
      'Skipped first-paint-350: 20 of 20 cloud sessions used today.',
    ]);
  });

  it('exit 1 when everything was skipped', async () => {
    const h = harness({ improve: vi.fn(async () => ({ launched: [], skipped: [{ itemId: 'x', reason: 'No.' }] })) });
    expect(await runCloudCli(['improve'], h.deps)).toBe(1);
    expect(h.deps.improve).toHaveBeenCalledWith({ count: 1, auto: false });
  });

  it('says so when the backlog is empty', async () => {
    const h = harness();
    expect(await runCloudCli(['improve'], h.deps)).toBe(0);
    expect(h.out[0]).toBe('Nothing to launch: the backlog has no available items.');
  });
});

describe('budget', () => {
  it('shows the estimate, its note, the limits and the gates without writing', async () => {
    const h = harness();
    expect(await runCloudCli(['budget'], h.deps)).toBe(0);
    expect(h.deps.updateBudget).not.toHaveBeenCalled();
    const out = text(h.out);
    expect(out).toContain('Cloud credits (estimate): $238.00 of $250.00 left · $12.00 spent');
    expect(out).toContain('Claude doesn\'t expose the credit balance');
    expect(out).toContain('Real balance: https://claude.ai/settings/usage');
    expect(out).toContain('Sessions today: 4 of 20 · running now: 1 of 4 at once');
    expect(out).toContain('Self-improvement: on · 2 of 4 today · ashlrai/ashlr-hub · pauses below $40.00 left');
    expect(out).toContain('Launch now: allowed');
    expect(out).toContain('Self-improve now: blocked — 4 of 4 self-improvement launches used today.');
  });

  it('updates first when any flag is given', async () => {
    const h = harness();
    expect(await runCloudCli(['budget', '--total', '300', '--self-improve', 'off'], h.deps)).toBe(0);
    expect(h.deps.updateBudget).toHaveBeenCalledWith({ creditsTotalUsd: 300, selfImprove: { enabled: false } });
    expect(h.out[0]).toBe('Cloud budget updated.');
    expect(text(h.out)).toContain('Self-improvement: off');
  });

  it('mentions a seat that is not ready', async () => {
    const h = harness({ seat: vi.fn(() => ({ id: 'claude-a', ready: false, reason: 'The Claude seat isn\'t set up on this Mac.' })) });
    await runCloudCli(['budget'], h.deps);
    expect(text(h.out)).toContain('Seat claude-a: not ready — The Claude seat isn\'t set up on this Mac.');
  });

  it('--json prints the budget view', async () => {
    const h = harness();
    await runCloudCli(['budget', '--json'], h.deps);
    expect(JSON.parse(text(h.out)).estimatedRemainingUsd).toBe(238);
  });
});

describe('backlog', () => {
  it('lists items with priority, claim state and what is next', async () => {
    const h = harness({
      backlog: vi.fn(() => ({
        nextUp: 'first-paint-350',
        items: [
          { id: 'fix-release-policy-pins', title: 'Bring the pins up to date', prompt: 'p', area: 'tests', priority: 1 as const, claimedBy: 'ct_20260925T1200_aaaaaa', lastState: 'pr-open' as const },
          { id: 'first-paint-350', title: 'Get first paint to 350 KB', prompt: 'p', area: 'performance', priority: 1 as const, claimedBy: null, lastState: null },
        ],
      })),
    });
    expect(await runCloudCli(['backlog'], h.deps)).toBe(0);
    expect(h.out).toEqual([
      'Self-improvement backlog · next up: first-paint-350',
      '  P1  Bring the pins up to date (PR open · ct_20260925T1200_aaaaaa)',
      '       fix-release-policy-pins · tests',
      '→ P1  Get first paint to 350 KB',
      '       first-paint-350 · performance',
    ]);
  });

  it('empty backlog', async () => {
    const h = harness();
    await runCloudCli(['backlog'], h.deps);
    expect(h.out).toEqual(['The self-improvement backlog is empty.']);
  });
});

describe('registration', () => {
  it('is a top-level command with its verbs in completions and help', async () => {
    expect(TOP_LEVEL_COMMANDS).toContain('cloud');
    expect(HELP_ENTRIES.some((e) => e.cmd.startsWith('cloud launch'))).toBe(true);
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'index.ts'), 'utf8');
    expect(index).toContain("case 'cloud':");
  });

  it('the bash completion script offers the cloud verbs', async () => {
    const { cmdCompletions } = await import('../src/cli/completions.js');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
    try {
      expect(await cmdCompletions(['bash'])).toBe(0);
    } finally {
      spy.mockRestore();
      write.mockRestore();
    }
    expect(lines.join('\n')).toMatch(/cloud\)[^;]*launch list refresh improve budget backlog/);
  });
});
