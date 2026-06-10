/**
 * M29 digest deliver tests — hermetic, no real ~/.ashlr, no real webhook POST.
 *
 * SAFETY GUARDRAILS proven here:
 *  - NO OUTWARD ACTION BY DEFAULT: notify() is NEVER called unless opts.notify
 *    === true. The default path (and --json) make ZERO outward calls.
 *  - OPT-IN: with notify:true, notify() is called EXACTLY once.
 *  - READ-ONLY: a static guard asserts deliver.ts contains no applyProposal/
 *    setStatus/push/createPr/deploy and no unconditional notify() call.
 *
 * The digest store (saveDigest) and notify() are both mocked so the test never
 * touches disk outside the assertion and never opens a socket.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AshlrConfig, DigestReport } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — store write is captured (no disk), notify is spied (no network).
// ---------------------------------------------------------------------------

const saveDigest = vi.fn((_report: DigestReport, _markdown: string) => ({
  jsonPath: '/tmp/fake/123.json',
  markdownPath: '/tmp/fake/123.md',
}));

const notify = vi.fn(async (_text: string, _cfg: AshlrConfig) => false);

vi.mock('../src/core/digest/store.js', () => ({
  saveDigest: (...args: [DigestReport, string]) => saveDigest(...args),
}));

vi.mock('../src/core/integrations/notify.js', () => ({
  notify: (...args: [string, AshlrConfig]) => notify(...args),
}));

let deliver: typeof import('../src/core/digest/deliver.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReport(): DigestReport {
  return {
    generatedAt: '2026-06-10T12:00:00.000Z',
    date: '2026-06-10',
    window: '7d',
    portfolio: {
      health: {
        reposScored: 2,
        averageScore: 82,
        averageGrade: 'B',
        worstRepos: [{ repo: '/repo/b', score: 64, grade: 'D' }],
      },
      goalsInFlight: [
        {
          goalId: 'g1',
          objective: 'Ship v2',
          status: 'active',
          fractionDone: 0.5,
          proposed: 1,
          totalMilestones: 4,
          nextActionable: 'Wire dispatcher',
        },
      ],
      backlogTop: [{ title: 'Fix flaky test', repo: '/repo/a', score: 90 }],
      cost: { window: '7d', spentUsd: 1.23, localSavingsUsd: 4.56, projectedMonthlyUsd: 5.27 },
      effectiveness: { successRate: 0.8, effectivenessDeltaPct: 2.5, headline: 'Trending up' },
      today: {
        previousAt: '2026-06-09T12:00:00.000Z',
        pendingProposalsDelta: 1,
        dirtyReposDelta: -2,
        spendUsdDelta: 0.5,
        healthScoreDelta: 1.5,
        goalsInFlightDelta: 0,
      },
    },
    repos: { total: 5, dirty: 1, stale: 2 },
    pendingProposals: 3,
    daemon: { running: true, todaySpentUsd: 0.42 },
    headline: 'All systems steady.',
  };
}

const CFG = {} as unknown as AshlrConfig;

beforeEach(async () => {
  saveDigest.mockClear();
  notify.mockClear();
  if (!deliver) {
    deliver = await import('../src/core/digest/deliver.js');
  }
});

// ---------------------------------------------------------------------------
// renderDigestText — deterministic, secret-free, covers all sections
// ---------------------------------------------------------------------------

describe('renderDigestText', () => {
  it('renders a deterministic markdown body covering every section', () => {
    const md = deliver.renderDigestText(makeReport());
    expect(md).toContain('# Ashlr Digest — 2026-06-10');
    expect(md).toContain('All systems steady.');
    expect(md).toContain('## Health');
    expect(md).toContain('avg 82 (B)');
    expect(md).toContain('## Goals in flight');
    expect(md).toContain('Ship v2');
    expect(md).toContain('## Backlog (top)');
    expect(md).toContain('Fix flaky test');
    expect(md).toContain('## Cost');
    expect(md).toContain('$1.23');
    expect(md).toContain('## Effectiveness');
    expect(md).toContain('## Today');
    // Deterministic: same input => identical output.
    expect(deliver.renderDigestText(makeReport())).toBe(md);
  });

  it('degrades to empty-state lines when the portfolio is empty', () => {
    const r = makeReport();
    r.portfolio.health = { reposScored: 0, averageScore: 0, averageGrade: 'F', worstRepos: [] };
    r.portfolio.goalsInFlight = [];
    r.portfolio.backlogTop = [];
    r.portfolio.effectiveness = null;
    r.portfolio.today.previousAt = null;
    const md = deliver.renderDigestText(r);
    expect(md).toContain('No enrolled repos scored.');
    expect(md).toContain('No active goals.');
    expect(md).toContain('Backlog empty.');
    expect(md).toContain('No prior digest to compare against yet.');
    expect(md).not.toContain('## Effectiveness');
  });
});

// ---------------------------------------------------------------------------
// deliverDigest — local write always; notify ONLY opt-in
// ---------------------------------------------------------------------------

describe('deliverDigest', () => {
  it('default path: writes the local artifact and does NOT call notify', async () => {
    const res = await deliver.deliverDigest(makeReport(), CFG);
    expect(saveDigest).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(res.notified).toBe(false);
    expect(res.jsonPath).toBe('/tmp/fake/123.json');
    expect(res.markdownPath).toBe('/tmp/fake/123.md');
  });

  it('notify:false is treated as the default (no outward call)', async () => {
    await deliver.deliverDigest(makeReport(), CFG, { notify: false });
    expect(saveDigest).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notify:true: still writes locally AND calls notify exactly once', async () => {
    notify.mockResolvedValueOnce(true);
    const res = await deliver.deliverDigest(makeReport(), CFG, { notify: true });
    expect(saveDigest).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    // notify receives the rendered markdown body (not secrets).
    const [text] = notify.mock.calls[0]!;
    expect(text).toContain('# Ashlr Digest');
    expect(res.notified).toBe(true);
  });

  it('notify:true with unconfigured webhook returns notified:false (no-op)', async () => {
    notify.mockResolvedValueOnce(false);
    const res = await deliver.deliverDigest(makeReport(), CFG, { notify: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(res.notified).toBe(false);
  });

  it('never throws even if notify rejects, and reports notified:false', async () => {
    notify.mockRejectedValueOnce(new Error('boom'));
    const res = await deliver.deliverDigest(makeReport(), CFG, { notify: true });
    expect(res.notified).toBe(false);
    expect(res.jsonPath).toBe('/tmp/fake/123.json');
  });
});

// ---------------------------------------------------------------------------
// Static guard — source must contain no outward-action authority and no
// unconditional notify() call. Reading the file is the proof.
// ---------------------------------------------------------------------------

describe('deliver.ts source guard (READ-ONLY + opt-in)', () => {
  const rawSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'digest', 'deliver.ts'),
    'utf8',
  );
  // Strip block + line comments so the guard scans real CODE only (the file's
  // jsdoc legitimately describes what it must NOT do, e.g. "never deploys").
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('contains no proposal-mutation / push / PR / deploy authority', () => {
    for (const forbidden of [
      'applyProposal',
      'setStatus',
      'createProposal',
      'createPr',
      'createPR',
      'saveConfig',
      'deploy',
      'gitPush',
      'execSync', // no shelling out (would be the route to a git push)
      'createPullRequest',
    ]) {
      expect(src.includes(forbidden), `deliver.ts code must not reference ${forbidden}`).toBe(false);
    }
  });

  it('guards the notify() call behind an explicit opts.notify === true check', () => {
    // The notify call must be lexically preceded by the opt-in guard.
    expect(src).toContain('opts?.notify === true');
    const guardIdx = src.indexOf('opts?.notify === true');
    const callIdx = src.indexOf('await notify(');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(guardIdx);
    // There must be EXACTLY ONE actual notify() invocation in the module — the
    // opt-in `await notify(...)` call. (Bare `notify(` also appears in jsdoc and
    // the import, so we match the real invocation form precisely.)
    const calls = src.match(/await notify\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});
