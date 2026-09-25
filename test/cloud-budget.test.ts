/**
 * 3.11 cloud lane — budget view and gates (src/core/cloud/budget.ts). Pure:
 * tasks, budget and clock are passed in. "Today" is the local calendar day,
 * so the day-boundary cases pin TZ for the process and restore it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { cloudBudgetView, formatUsd, localDayKey } from '../src/core/cloud/budget.js';
import { DEFAULT_CLOUD_BUDGET, type CloudBudgetV1, type CloudTaskV1 } from '../src/core/cloud/types.js';

const NOW = new Date('2026-09-24T18:00:00.000Z');
let seq = 0;

function budget(patch: Partial<CloudBudgetV1> = {}, self: Partial<CloudBudgetV1['selfImprove']> = {}): CloudBudgetV1 {
  return { ...DEFAULT_CLOUD_BUDGET, ...patch, selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove, ...self }, updatedAt: NOW.toISOString() };
}

function task(state: CloudTaskV1['state'], patch: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  seq += 1;
  const id = `ct_20260924T1700_${String(seq).padStart(6, '0')}`;
  const ran = !['queued', 'launching', 'failed'].includes(state);
  return {
    v: 1, id, repo: 'ashlrai/ashlr-hub', baseBranch: 'master', branch: `ashlr-cloud/${id}`, title: 't', prompt: 'p',
    origin: 'operator', requestedBy: 'mason', seat: 'claude-a', sessionId: ran ? `session_${seq}` : null, sessionUrl: null,
    state, stateReason: null, failure: state === 'failed' ? 'auth' : null, createdAt: '2026-09-24T17:00:00.000Z',
    launchedAt: ran ? '2026-09-24T17:00:05.000Z' : null, updatedAt: '2026-09-24T17:00:05.000Z', pr: null, report: null,
    estimatedCostUsd: 3, backlogItemId: null, needsYouId: null, ...patch,
  };
}

const savedTz = process.env['TZ'];
afterEach(() => {
  if (savedTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = savedTz;
});

describe('spend', () => {
  it('counts the adjustment plus every task that reached running or later; failures and in-flight cost nothing', () => {
    const tasks = [
      task('running'), task('pr-open'), task('merged'), task('closed'), task('expired'),
      task('failed'), task('queued'), task('launching'),
      // A dismissed failure is `closed` with no session: still free.
      task('closed', { sessionId: null, launchedAt: null }),
    ];
    const view = cloudBudgetView(tasks, budget({ creditsSpentAdjustmentUsd: 12.5 }), NOW);
    expect(view.estimatedSpentUsd).toBe(12.5 + 5 * 3);
    expect(view.estimatedRemainingUsd).toBe(250 - 27.5);
    expect(view.running).toBe(2); // launching + running
    expect(view.creditsTotalUsd).toBe(250);
    expect(view.balanceUrl).toBe('https://claude.ai/settings/usage');
  });

  it('uses each task\'s own fixed estimate, and never goes below zero remaining', () => {
    const view = cloudBudgetView([task('merged', { estimatedCostUsd: 7.25 }), task('merged', { estimatedCostUsd: 0.5 })], budget({ creditsTotalUsd: 5 }), NOW);
    expect(view.estimatedSpentUsd).toBe(7.75);
    expect(view.estimatedRemainingUsd).toBe(0);
  });

  it('writes the estimate note exactly', () => {
    expect(cloudBudgetView([], budget(), NOW).estimateNote)
      .toBe("Estimated at $3 per session — Claude doesn't expose the credit balance. Check it on claude.ai and adjust here.");
    expect(cloudBudgetView([], budget({ estimatedCostPerSessionUsd: 2.5 }), NOW).estimateNote).toMatch(/^Estimated at \$2\.50 per session/);
  });
});

describe('today', () => {
  it('counts sessions and self-improvement launches on the local day, in flight included, failures excluded', () => {
    const tasks = [
      task('running'), task('merged', { origin: 'self-improve', requestedBy: 'self-improve' }), task('queued', { origin: 'self-improve' }),
      task('failed', { origin: 'self-improve' }),
      task('merged', { createdAt: '2026-09-20T12:00:00.000Z', launchedAt: '2026-09-20T12:00:00.000Z' }),
    ];
    const view = cloudBudgetView(tasks, budget(), NOW);
    expect(view.sessionsToday).toBe(3);
    expect(view.selfImproveToday).toBe(2);
  });

  it('uses the operator\'s local calendar day, not UTC', () => {
    process.env['TZ'] = 'America/Los_Angeles';
    // 02:00 UTC on the 25th is still the 24th in Los Angeles.
    const late = task('merged', { launchedAt: '2026-09-25T02:00:00.000Z', createdAt: '2026-09-25T02:00:00.000Z' });
    const early = task('merged', { launchedAt: '2026-09-24T06:00:00.000Z', createdAt: '2026-09-24T06:00:00.000Z' }); // 23:00 on the 23rd local
    expect(cloudBudgetView([late, early], budget(), new Date('2026-09-25T03:00:00.000Z')).sessionsToday).toBe(1);
    expect(localDayKey(new Date('2026-09-25T02:00:00.000Z'))).toBe('2026-09-24');
    process.env['TZ'] = 'Pacific/Kiritimati';
    expect(localDayKey(new Date('2026-09-24T11:00:00.000Z'))).toBe('2026-09-25');
  });
});

describe('gates', () => {
  it('both open with room everywhere', () => {
    const view = cloudBudgetView([], budget(), NOW);
    expect(view.canLaunch).toEqual({ ok: true, reason: null });
    expect(view.canSelfImprove).toEqual({ ok: true, reason: null });
  });

  it('refuses a launch when estimated credits cannot cover a session', () => {
    const view = cloudBudgetView([], budget({ creditsTotalUsd: 10, creditsSpentAdjustmentUsd: 8 }), NOW);
    expect(view.canLaunch).toEqual({ ok: false, reason: 'About $2 of estimated credits is left — not enough for another session at $3 each.' });
    expect(view.canSelfImprove).toEqual(view.canLaunch);
  });

  it('refuses at the daily session cap (pluralised)', () => {
    expect(cloudBudgetView([task('running'), task('merged')], budget({ maxSessionsPerDay: 2 }), NOW).canLaunch)
      .toEqual({ ok: false, reason: '2 of 2 cloud sessions used today.' });
    expect(cloudBudgetView([task('merged')], budget({ maxSessionsPerDay: 1 }), NOW).canLaunch.reason).toBe('1 of 1 cloud session used today.');
    expect(cloudBudgetView([], budget({ maxSessionsPerDay: 0 }), NOW).canLaunch.reason).toBe('0 of 0 cloud sessions used today.');
  });

  it('refuses at the concurrency cap', () => {
    const old = { createdAt: '2026-09-20T00:00:00.000Z', launchedAt: '2026-09-20T00:00:00.000Z' };
    expect(cloudBudgetView([task('running', old), task('launching', old)], budget({ maxConcurrent: 2 }), NOW).canLaunch)
      .toEqual({ ok: false, reason: '2 of 2 cloud sessions are already running.' });
    expect(cloudBudgetView([task('running', old)], budget({ maxConcurrent: 1 }), NOW).canLaunch.reason).toBe('1 of 1 cloud session is already running.');
  });

  it('self-improvement: off switch, daily cap, reserve', () => {
    expect(cloudBudgetView([], budget({}, { enabled: false }), NOW).canSelfImprove).toEqual({ ok: false, reason: 'Self-improvement is turned off.' });
    const si = { origin: 'self-improve' as const, requestedBy: 'self-improve' as const };
    expect(cloudBudgetView([task('merged', si), task('merged', si)], budget({}, { maxPerDay: 2 }), NOW).canSelfImprove)
      .toEqual({ ok: false, reason: '2 of 2 self-improvement launches used today.' });
    // $43 left, $3 a session, $40 reserve: exactly allowed; $42 left is not.
    expect(cloudBudgetView([], budget({ creditsSpentAdjustmentUsd: 207 }), NOW).canSelfImprove.ok).toBe(true);
    const low = cloudBudgetView([], budget({ creditsSpentAdjustmentUsd: 208 }), NOW);
    expect(low.canLaunch.ok).toBe(true);
    expect(low.canSelfImprove).toEqual({ ok: false, reason: 'Another self-improvement session would take estimated credits below the $40 reserve.' });
  });
});

describe('formatUsd', () => {
  it('drops cents on whole dollars and groups thousands', () => {
    expect(formatUsd(3)).toBe('$3');
    expect(formatUsd(2.5)).toBe('$2.50');
    expect(formatUsd(1234)).toBe('$1,234');
    expect(formatUsd(0.004)).toBe('$0');
  });
});
