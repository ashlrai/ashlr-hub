/**
 * 3.15 automations — triggers, each against a scripted `gh api -i` and a
 * fixed clock: labelled issues (bounded page, `since` cursor, ETag / 304,
 * PR filtering, untrusted text), search-query mode, a red default branch
 * (default-branch lookup, once per failing sha), RRULE schedules (never fire
 * a missed past occurrence on first sight; once per occurrence), and poll
 * intervals. Nothing reaches GitHub; every call is read-only `GET`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAutomation,
  readAutomationState,
  runAutomationsTick,
  type AutomationInput,
} from '../src/core/automations/index.js';
import { buildIssueSearchQuery, parseGhInclude, pollIssues, pollRedBranch } from '../src/core/automations/github.js';
import { fakeClock, fakeGh, fakeLanes, ghParams, isolateAshlrHome } from './helpers/automations-fakes.js';

const issue = (n: number, updated: string, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Bug ${n}`,
  body: `Steps for ${n}`,
  html_url: `https://github.com/acme/app/issues/${n}`,
  updated_at: updated,
  state: 'open',
  ...extra,
});

describe('gh api -i parsing', () => {
  it('splits status, etag and body', () => {
    expect(parseGhInclude('HTTP/2.0 200 OK\r\nEtag: W/"x"\r\n\r\n[1]')).toEqual({ status: 200, etag: 'W/"x"', body: [1] });
    expect(parseGhInclude('HTTP/1.1 304 Not Modified\nEtag: "y"\n\n')).toEqual({ status: 304, etag: '"y"', body: null });
    expect(parseGhInclude('not http')).toBeNull();
  });
});

describe('issues with labels', () => {
  const trigger = { kind: 'github-issues' as const, labels: ['ashlr'], query: null, includePrs: false, pollMinutes: 15 };

  it('reads one bounded page, filters PRs, scrubs text and advances the since cursor', async () => {
    const { gh, calls } = fakeGh(() => ({
      status: 200,
      etag: 'W/"e1"',
      body: [
        issue(1, '2026-09-27T10:00:00Z', { body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked\u0007' }),
        issue(2, '2026-09-27T11:00:00Z', { pull_request: { url: 'x' } }),
        issue(3, '2026-09-27T09:00:00Z', { html_url: 'javascript:alert(1)' }),
      ],
    }));
    const res = await pollIssues(gh, trigger, 'acme/app', { since: null, etag: null });
    expect(res.error).toBeNull();
    expect(res.events.map((e) => e.vars.number)).toEqual(['1', '3']);
    expect(res.events[0]!.text).not.toMatch(/ghp_/);
    expect(res.events[0]!.text.includes(String.fromCharCode(7))).toBe(false);
    expect(res.events[1]!.url).toBeNull();
    expect(res.since).toBe('2026-09-27T11:00:00Z');
    expect(res.etag).toBe('W/"e1"');
    const args = calls[0]!.args;
    expect(args.slice(0, 5)).toEqual(['api', '-i', '-X', 'GET', 'repos/acme/app/issues']);
    expect(ghParams(args)).toMatchObject({ state: 'open', labels: 'ashlr', per_page: '50', direction: 'asc' });
    expect(ghParams(args)).not.toHaveProperty('since');
  });

  it('sends since + If-None-Match and treats 304 as nothing new', async () => {
    const { gh, calls } = fakeGh(() => ({ status: 304 }));
    const res = await pollIssues(gh, trigger, 'acme/app', { since: '2026-09-27T11:00:00Z', etag: 'W/"e1"' });
    expect(res).toMatchObject({ events: [], since: '2026-09-27T11:00:00Z', etag: 'W/"e1"', error: null });
    expect(ghParams(calls[0]!.args).since).toBe('2026-09-27T11:00:00Z');
    expect(calls[0]!.args).toContain('If-None-Match: W/"e1"');
  });

  it('reports a failed poll without events or a moved cursor', async () => {
    const { gh } = fakeGh(() => ({ fail: 'HTTP 404: Not Found' }));
    const res = await pollIssues(gh, trigger, 'acme/gone', { since: 'S', etag: null });
    expect(res.events).toEqual([]);
    expect(res.since).toBe('S');
    expect(res.error).toMatch(/404/);
  });

  it('search mode pins the repo and adds labels + since', async () => {
    const q = buildIssueSearchQuery({ ...trigger, labels: ['ashlr:devin', 'good first'], query: 'is:issue no:assignee' }, 'acme/app', '2026-09-27T11:00:00.123Z');
    expect(q).toBe('repo:acme/app is:open is:issue label:"ashlr:devin" label:"good first" is:issue no:assignee updated:>=2026-09-27T11:00:00Z');
    const { gh, calls } = fakeGh(() => ({ status: 200, body: { items: [issue(7, '2026-09-27T12:00:00Z')] } }));
    const res = await pollIssues(gh, { ...trigger, query: 'no:assignee' }, 'acme/app', { since: null, etag: null });
    expect(calls[0]!.args[4]).toBe('search/issues');
    expect(res.events.map((e) => e.ref)).toEqual(['#7']);
  });

  it('a query with no label only takes issues from the repo\'s own people', async () => {
    const { gh } = fakeGh(() => ({
      status: 200,
      body: { items: [
        issue(1, '2026-09-27T12:00:00Z', { author_association: 'NONE' }),
        issue(2, '2026-09-27T12:01:00Z', { author_association: 'CONTRIBUTOR' }),
        issue(3, '2026-09-27T12:02:00Z', { author_association: 'MEMBER' }),
        issue(4, '2026-09-27T12:03:00Z'),
      ] },
    }));
    const res = await pollIssues(gh, { ...trigger, labels: [], query: 'no:assignee' }, 'acme/app', { since: null, etag: null });
    expect(res.events.map((e) => e.ref)).toEqual(['#3']);
    expect(res.since).toBe('2026-09-27T12:03:00Z');
  });
});

describe('red default branch', () => {
  const trigger = { kind: 'ci-red' as const, branch: null, pollMinutes: 10 };
  const sha = 'a'.repeat(40);

  it('resolves the default branch once and fires on failing completed checks', async () => {
    const { gh, calls } = fakeGh((args) => {
      if (args[4] === 'repos/acme/app') return { status: 200, body: { default_branch: 'main' } };
      return {
        status: 200,
        etag: '"c1"',
        body: {
          check_runs: [
            { name: 'test', status: 'completed', conclusion: 'failure', head_sha: sha, html_url: 'https://github.com/acme/app/runs/1' },
            { name: 'lint', status: 'completed', conclusion: 'success', head_sha: sha },
            { name: 'e2e', status: 'in_progress', conclusion: null, head_sha: sha },
          ],
        },
      };
    });
    const res = await pollRedBranch(gh, trigger, 'acme/app', { branch: null, etag: null });
    expect(res.branch).toBe('main');
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.vars.sha).toBe(sha);
    expect(res.events[0]!.title).toMatch(/^Fix red main: test failing at aaaaaaa/);
    expect(res.events[0]!.url).toBe('https://github.com/acme/app/runs/1');
    expect(calls[1]!.args[4]).toBe('repos/acme/app/commits/main/check-runs');
    // Known branch: no second lookup.
    const again = await pollRedBranch(gh, trigger, 'acme/app', { branch: 'main', etag: '"c1"' });
    expect(calls.slice(2).every((c) => c.args[4] !== 'repos/acme/app')).toBe(true);
    expect(again.events).toHaveLength(1);
  });

  it('green checks fire nothing', async () => {
    const { gh } = fakeGh(() => ({ status: 200, body: { check_runs: [{ name: 't', status: 'completed', conclusion: 'success', head_sha: sha }] } }));
    expect((await pollRedBranch(gh, { ...trigger, branch: 'release/1.x' }, 'acme/app', { branch: null, etag: null })).events).toEqual([]);
  });
});

describe('ticks: polling cadence, schedules and dedupe', () => {
  let restore: () => void;
  beforeEach(() => { restore = isolateAshlrHome(); });
  afterEach(() => restore());

  const labelled = (over: Partial<AutomationInput> = {}): AutomationInput => ({
    name: 'Labelled',
    enabled: true,
    trigger: { kind: 'github-issues', labels: ['ashlr'], query: null, includePrs: false, pollMinutes: 15 },
    lane: 'fleet',
    playbookId: null,
    repos: ['acme/app'],
    instructions: 'Fix it.',
    maxConcurrent: 5,
    maxPerDay: 20,
    queueDepth: 10,
    spendCapUsd: 0,
    dedupeKey: null,
    triage: null,
    ...over,
  });

  it('polls on its interval and makes one task per issue, ever', async () => {
    const clock = fakeClock(new Date('2026-09-27T12:00:00Z'));
    const lanes = fakeLanes();
    let page = [issue(1, '2026-09-27T10:00:00Z'), issue(2, '2026-09-27T10:05:00Z')];
    const { gh, calls } = fakeGh(() => ({ status: 200, body: page }));
    await createAutomation(labelled());
    const deps = { ...lanes.deps, gh, now: clock.now, decider: null };

    const first = await runAutomationsTick(deps);
    expect(first.polled).toBe(1);
    expect(lanes.fleetCalls.map((c) => c.title)).toEqual(['Issue #1: Bug 1', 'Issue #2: Bug 2']);

    // Within the interval: no poll at all.
    clock.advance(5 * 60_000);
    expect((await runAutomationsTick(deps)).polled).toBe(0);
    expect(calls).toHaveLength(1);

    // Next interval: issue 2 updated again + a new issue 3 → only #3 is new work.
    clock.advance(11 * 60_000);
    page = [issue(2, '2026-09-27T12:10:00Z'), issue(3, '2026-09-27T12:11:00Z')];
    await runAutomationsTick(deps);
    expect(lanes.fleetCalls.map((c) => c.title)).toEqual(['Issue #1: Bug 1', 'Issue #2: Bug 2', 'Issue #3: Bug 3']);
    expect(ghParams(calls[1]!.args).since).toBe('2026-09-27T10:05:00Z');
    const state = await readAutomationState();
    expect(state.firings.map((f) => f.dedupeKey).sort()).toEqual(['acme/app#1', 'acme/app#2', 'acme/app#3']);
  });

  it('a schedule never fires a past occurrence on first sight, then fires once per occurrence per repo', async () => {
    const clock = fakeClock(new Date(2026, 8, 27, 1, 30));
    const lanes = fakeLanes();
    await createAutomation(labelled({
      name: 'Nightly',
      trigger: { kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0' },
      repos: ['acme/app', 'acme/web'],
    }));
    const deps = { ...lanes.deps, gh: fakeGh(() => ({ fail: 'no gh in a schedule' })).gh, now: clock.now, decider: null };

    await runAutomationsTick(deps);
    expect(lanes.fleetCalls).toHaveLength(0);
    const scheduled = (await readAutomationState()).cursors['au_nightly']!.nextRunAt;
    expect(scheduled).toBe(new Date(2026, 8, 27, 2, 0).toISOString());

    clock.set(new Date(2026, 8, 27, 2, 0, 30));
    await runAutomationsTick(deps);
    expect(lanes.fleetCalls.map((c) => c.repo)).toEqual(['acme/app', 'acme/web']);
    clock.advance(60_000);
    await runAutomationsTick(deps);
    expect(lanes.fleetCalls).toHaveLength(2);
    expect((await readAutomationState()).cursors['au_nightly']!.nextRunAt).toBe(new Date(2026, 8, 28, 2, 0).toISOString());
  });

  it('a red branch fires once per failing sha', async () => {
    const clock = fakeClock(new Date('2026-09-27T12:00:00Z'));
    const lanes = fakeLanes();
    let sha = 'b'.repeat(40);
    const { gh } = fakeGh((args) => (args[4] === 'repos/acme/app'
      ? { status: 200, body: { default_branch: 'main' } }
      : { status: 200, body: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', head_sha: sha }] } }));
    await createAutomation(labelled({ name: 'Red', trigger: { kind: 'ci-red', branch: null, pollMinutes: 10 }, lane: 'cloud', spendCapUsd: 100 }));
    const deps = { ...lanes.deps, gh, now: clock.now, decider: null };
    await runAutomationsTick(deps);
    clock.advance(11 * 60_000);
    await runAutomationsTick(deps);
    expect(lanes.cloudCalls).toHaveLength(1);
    sha = 'c'.repeat(40);
    clock.advance(11 * 60_000);
    await runAutomationsTick(deps);
    expect(lanes.cloudCalls).toHaveLength(2);
    expect(lanes.cloudCalls[1]!.title).toMatch(/cccccc/);
  });
});
