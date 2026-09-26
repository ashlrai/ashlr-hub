/**
 * cloud-model — the cloud lane's words and decisions as a table: launch
 * validation, the credits meter (always an estimate), the budget patch
 * (only what changed), which tasks the card lists, link safety, and why
 * "Run in cloud" is disabled.
 */
import { describe, expect, it } from 'vitest';
import { CLOUD_PROMPT_MAX_CHARS } from '../../../../core/cloud/types.js';
import {
  CARD_TASK_LIMIT,
  budgetFormFrom,
  budgetPatch,
  canDismiss,
  cardTasks,
  creditsMeter,
  formatDollars,
  inFlightCount,
  isBranchName,
  launchBlock,
  nextLocalMidnight,
  runInCloudBlock,
  safeHref,
  selfImproveLine,
  sessionsLine,
  stateWord,
  taskDetail,
  taskMeta,
  validateLaunch,
} from './cloud-model.js';
import { HOUR, budget, budgetView, overview, task } from './cloud-fixtures.test-support.js';

const NOW = Date.parse('2026-09-25T15:00:00');

describe('validateLaunch', () => {
  it('accepts owner/name, an optional branch and a task, trimmed', () => {
    expect(validateLaunch({ repo: ' ashlrai/ashlr-hub ', baseBranch: ' v3110-cloud ', prompt: '  Fix it.  ' })).toEqual({
      ok: true,
      request: { repo: 'ashlrai/ashlr-hub', baseBranch: 'v3110-cloud', prompt: 'Fix it.' },
    });
    // An empty base branch is left out, so the server uses the default branch.
    expect(validateLaunch({ repo: 'a/b', baseBranch: '', prompt: 'x' })).toEqual({ ok: true, request: { repo: 'a/b', prompt: 'x' } });
  });

  it('names each bad field in plain words', () => {
    const empty = validateLaunch({ repo: '', baseBranch: '', prompt: '   ' });
    expect(empty).toEqual({ ok: false, errors: { repo: 'Enter the GitHub repository as owner/name.', prompt: 'Describe the task for the cloud session.' } });
    for (const repo of ['ashlr-hub', 'https://github.com/ashlrai/ashlr-hub', 'a/b/c', 'own er/x', 'a/b;rm']) {
      const r = validateLaunch({ repo, baseBranch: '', prompt: 'x' });
      expect(r.ok, repo).toBe(false);
      if (!r.ok) expect(r.errors.repo).toBe('Use the GitHub owner/name form, like ashlrai/ashlr-hub.');
    }
    const branch = validateLaunch({ repo: 'a/b', baseBranch: 'feature..x', prompt: 'x' });
    expect(branch).toEqual({ ok: false, errors: { baseBranch: "That isn't a branch name git accepts." } });
  });

  it('refuses a task over the contract limit and says by how much', () => {
    const r = validateLaunch({ repo: 'a/b', baseBranch: '', prompt: 'x'.repeat(CLOUD_PROMPT_MAX_CHARS + 1) });
    expect(r).toEqual({ ok: false, errors: { prompt: 'The task is 20,001 characters; the limit is 20,000.' } });
    expect(validateLaunch({ repo: 'a/b', baseBranch: '', prompt: 'x'.repeat(CLOUD_PROMPT_MAX_CHARS) }).ok).toBe(true);
  });

  it.each([
    ['master', true], ['v3110-cloud', true], ['ashlr-cloud/3110-c3', true], ['release/3.11', true],
    ['-rf', false], ['/abs', false], ['trail/', false], ['a b', false], ['a..b', false], ['x.lock', false], ['a//b', false], ['end.', false], ['a~1', false],
  ])('isBranchName(%s) → %s', (name, ok) => {
    expect(isBranchName(name)).toBe(ok);
  });
});

describe('the credits meter', () => {
  it('reads "$X of $250 · estimate" with the used share by the one percent rule', () => {
    const m = creditsMeter(budgetView({ estimatedSpentUsd: 38 }));
    expect(m).toMatchObject({ value: 212, max: 250, text: '$212 of $250 · estimate', usedText: '15% used', tone: 'accent', warning: null });
  });

  it('warns under the self-improvement reserve, and says spent at zero without a negative bar', () => {
    const low = creditsMeter(budgetView({ estimatedSpentUsd: 215 }));
    expect(low.tone).toBe('warning');
    expect(low.warning).toBe('Under the $40 reserve, so Verse stops launching self-improvement tasks.');
    const over = creditsMeter(budgetView({ estimatedSpentUsd: 262.5 }));
    expect(over).toMatchObject({ value: 0, text: '$0 of $250 · estimate', usedText: '100% used', tone: 'danger' });
    expect(over.warning).toMatch(/^The estimate says the credits are spent\. Check the real balance on claude\.ai/);
  });

  it('never divides by a zero total', () => {
    const m = creditsMeter(budgetView({ budget: budget({ creditsTotalUsd: 0 }), estimatedSpentUsd: 0 }));
    expect(m).toMatchObject({ max: null, usedText: 'no credit total set' });
  });

  it.each([[250, '$250'], [12.5, '$12.50'], [0.004, '$0'], [-3, '−$3'], [Number.NaN, '—']])('formatDollars(%s) → %s', (v, text) => {
    expect(formatDollars(v)).toBe(text);
  });
});

describe('the counting lines', () => {
  it('counts sessions against the daily cap and says when the day resets, in local time', () => {
    const line = sessionsLine(budgetView({ sessionsToday: 3, running: 1 }), NOW);
    expect(line).toMatch(/^3 of 20 sessions today · 1 running · resets (Sat|Fri|today) /);
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(new Date(nextLocalMidnight(NOW)).getHours()).toBe(0);
    expect(nextLocalMidnight(NOW)).toBeGreaterThan(NOW);
  });

  it('describes self-improvement on and off', () => {
    expect(selfImproveLine(budgetView())).toBe('1 of 4 self-improvement launches today, on ashlrai/ashlr-hub. Stops under a $40 estimated balance.');
    expect(selfImproveLine(budgetView({ budget: budget({}, { enabled: false }) }))).toBe('Self-improvement is off. Verse launches cloud tasks only when you ask.');
  });

  it('puts the seat ahead of the budget gate', () => {
    const refused = budgetView({ canLaunch: { ok: false, reason: '20 of 20 sessions used today.' } });
    expect(launchBlock({ id: 'claude-a', ready: true, reason: null }, refused)).toBe('20 of 20 sessions used today.');
    expect(launchBlock({ id: 'claude-a', ready: false, reason: null }, refused)).toBe("The Claude seat isn't set up on this Mac.");
    expect(launchBlock({ id: 'claude-a', ready: true, reason: null }, budgetView())).toBeNull();
  });
});

describe('tasks', () => {
  it('lists in-flight and PR tasks plus anything that ended in the last day, newest first', () => {
    const old = task('failed', { title: 'old failure' }, NOW, 30 * HOUR);
    const oldMerged = task('merged', { title: 'old merge' }, NOW, 30 * HOUR);
    const oldRunning = task('running', { title: 'old but running' }, NOW, 30 * HOUR);
    const fresh = task('failed', { title: 'fresh failure' }, NOW, HOUR);
    const pr = task('pr-open', { title: 'pr' }, NOW, 2 * HOUR);
    const { shown, hidden } = cardTasks([old, oldMerged, oldRunning, fresh, pr], NOW);
    expect(shown.map((t) => t.title)).toEqual(['fresh failure', 'pr', 'old but running']);
    expect(hidden).toBe(0);
  });

  it(`caps the card at ${CARD_TASK_LIMIT} and counts the rest`, () => {
    const many = Array.from({ length: CARD_TASK_LIMIT + 3 }, (_, i) => task('running', {}, NOW, i * 60_000));
    const { shown, hidden } = cardTasks(many, NOW);
    expect(shown).toHaveLength(CARD_TASK_LIMIT);
    expect(hidden).toBe(3);
    expect(inFlightCount([...many, task('pr-open'), task('queued'), task('launching')])).toBe(CARD_TASK_LIMIT + 5);
  });

  it('words states, drafts and meta without ISO', () => {
    expect(stateWord(task('pr-open'))).toBe('PR unverified');
    expect(stateWord(task('pr-open', { pr: { number: 7, url: 'https://github.com/a/b/pull/7', state: 'open', draft: true, title: 't' } }))).toBe('Draft PR');
    expect(stateWord(task('pr-open', { pr: { number: 7, url: 'https://github.com/a/b/pull/7', state: 'open', draft: false, title: 't' } }))).toBe('PR open');
    expect(stateWord(task('expired'))).toBe('Expired');
    expect(taskMeta(task('running', {}, NOW, 5 * 60_000), NOW)).toBe('ashlrai/ashlr-hub from master · started 5m ago');
    expect(taskMeta(task('failed', {}, NOW, 2 * HOUR), NOW)).toBe('ashlrai/ashlr-hub from master · tried 2h ago');
    expect(taskMeta(task('queued', {}, NOW, 0), NOW)).toBe('ashlrai/ashlr-hub from master · queued just now');
  });

  it('shows the report summary on a PR, else the state reason — with instants read as local time', () => {
    const pr = task('pr-open', { report: { status: 'done', summary: 'Fixed the race.', testsRun: [], risks: [] }, stateReason: 'PR opened.' });
    expect(taskDetail(pr, NOW)).toBe('Cloud session reports (unverified): Fixed the race.');
    const at = '2026-09-25T14:30:00.000Z';
    const failed = task('failed', { stateReason: `Rate limited until ${at}..` });
    const detail = taskDetail(failed, NOW)!;
    expect(detail).not.toContain(at);
    expect(detail).not.toMatch(/\.\.$/);
    expect(taskDetail(task('running'), NOW)).toBeNull();
  });

  it('scrubs credential-shaped report and state text before formatting the card detail', () => {
    const secret = 'supersecretvalue123456';
    const pr = task('pr-open', { report: { status: 'done', summary: `Fixed the race. api_key=${secret}`, testsRun: [], risks: [] } });
    expect(taskDetail(pr, NOW)).toBe('Cloud session reports (unverified): Fixed the race. api_key=[REDACTED]');
    expect(taskDetail(task('failed', { stateReason: `Launch failed: api_key=${secret}` }), NOW)).toBe('Launch failed: api_key=[REDACTED]');
  });

  it('offers Dismiss for everything but merged and closed', () => {
    expect(['queued', 'launching', 'running', 'pr-open', 'failed', 'expired'].every((s) => canDismiss({ state: s as never }))).toBe(true);
    expect(canDismiss({ state: 'merged' })).toBe(false);
    expect(canDismiss({ state: 'closed' })).toBe(false);
  });
});

describe('safeHref', () => {
  it('links only https URLs on the expected host', () => {
    expect(safeHref('https://claude.ai/code/session_01?from=cli', 'claude.ai')).toBe('https://claude.ai/code/session_01?from=cli');
    expect(safeHref('https://github.com/a/b/pull/1', 'github.com')).toBe('https://github.com/a/b/pull/1');
    for (const bad of ['http://claude.ai/x', 'javascript:alert(1)', 'https://claude.ai.evil.com/x', 'https://evil.com/?claude.ai', '/code/x', '', null, undefined]) {
      expect(safeHref(bad, 'claude.ai'), String(bad)).toBeNull();
    }
    expect(safeHref('https://claude.ai/x', 'github.com')).toBeNull();
  });
});

describe('budgetPatch', () => {
  const current = budget();

  it('round-trips the budget with no change', () => {
    expect(budgetPatch(budgetFormFrom(current), current)).toEqual({ ok: true, update: {}, changed: false });
  });

  it('sends only what changed, nesting self-improvement', () => {
    const form = { ...budgetFormFrom(current), total: '$300', maxPerDay: '10', selfImprove: false, reserve: '25.5' };
    expect(budgetPatch(form, current)).toEqual({
      ok: true,
      changed: true,
      update: { creditsTotalUsd: 300, maxSessionsPerDay: 10, selfImprove: { enabled: false, reserveUsd: 25.5 } },
    });
  });

  it('accepts a negative correction but not a fractional count or an empty field', () => {
    const neg = budgetPatch({ ...budgetFormFrom(current), spent: '-12' }, current);
    expect(neg).toEqual({ ok: true, changed: true, update: { creditsSpentAdjustmentUsd: -12 } });
    const bad = budgetPatch({ ...budgetFormFrom(current), maxPerDay: '2.5', perSession: '', maxConcurrent: '0', total: 'lots' }, current);
    expect(bad).toEqual({
      ok: false,
      errors: { maxPerDay: 'Enter a whole number.', perSession: 'Enter a number.', maxConcurrent: 'Between 1 and 50.', total: 'Enter a number.' },
    });
    expect(budgetPatch({ ...budgetFormFrom(current), perSession: '0' }, current)).toEqual({ ok: false, errors: { perSession: 'Between $0.01 and $1000.' } });
  });
});

describe('runInCloudBlock', () => {
  const ready = overview();
  const base = { overview: ready, overviewReason: null, repo: 'ashlrai/ashlr-hub', rootsLoading: false, prompt: 'Do the thing.' };

  it('is null when everything lines up', () => {
    expect(runInCloudBlock(base)).toBeNull();
  });

  it('says why, most fundamental first', () => {
    expect(runInCloudBlock({ ...base, overview: null, overviewReason: 'The cloud lane is not in this build yet.' })).toBe('The cloud lane is not in this build yet.');
    expect(runInCloudBlock({ ...base, overview: overview({ seat: { id: 'claude-a', ready: false, reason: null } }) })).toBe("The Claude seat isn't set up on this Mac.");
    expect(runInCloudBlock({ ...base, repo: null })).toBe("This chat's project has no GitHub origin, so a cloud session has nothing to clone.");
    expect(runInCloudBlock({ ...base, repo: null, rootsLoading: true })).toBe("Reading this chat's project…");
    expect(runInCloudBlock({ ...base, overview: overview({ budget: budgetView({ canLaunch: { ok: false, reason: '4 of 4 running.' } }) }) })).toBe('4 of 4 running.');
    expect(runInCloudBlock({ ...base, prompt: '  ' })).toBe('Type the task in the message box first.');
    expect(runInCloudBlock({ ...base, prompt: 'x'.repeat(CLOUD_PROMPT_MAX_CHARS + 1) })).toBe('The message is over 20,000 characters — trim it to run it in the cloud.');
  });
});
