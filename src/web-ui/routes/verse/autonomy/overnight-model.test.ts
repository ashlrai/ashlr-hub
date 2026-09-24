/**
 * overnight-model.test.ts — the pure half of the Overnight panel, asserted on
 * the three things it is allowed to be wrong about only once.
 *
 *   1. A stop time picked at 23:50 for 07:00 means TOMORROW. Resolving it as
 *      today would arm a run that is already over before it starts.
 *   2. An open-ended run has no denominator, so it gets no progress bar. A bar
 *      with an invented maximum is a picture of a finish line that is not
 *      there.
 *   3. A body from a route that does not exist yet must NARROW to null, never
 *      reach a render as `undefined` or as a plausible-looking zero.
 */
import { describe, expect, it } from 'vitest';
import {
  describeStopRule,
  formatRunElapsed,
  gateChecks,
  gateUnstated,
  joinPhrase,
  projectOvernight,
  projectStopRule,
  resolveStopAt,
  stopProgress,
} from './overnight-model.js';
import type { OvernightRun } from './overnight-contract.js';

function run(over: Partial<OvernightRun> = {}): OvernightRun {
  return {
    runId: 'run-1',
    startedAt: new Date('2026-09-23T23:00:00Z').toISOString(),
    stopRule: { kind: 'until-paused' },
    iterationsDone: 0,
    repo: 'ashlr-hub',
    activity: 'running the test gate',
    merged: [],
    discarded: [],
    ...over,
  };
}

describe('resolveStopAt', () => {
  it('resolves a time later today to today', () => {
    const now = new Date(2026, 8, 23, 22, 0, 0);
    const at = resolveStopAt('23:30', now);
    expect(at).not.toBeNull();
    const resolved = new Date(at!);
    expect(resolved.getHours()).toBe(23);
    expect(resolved.getMinutes()).toBe(30);
    expect(resolved.getDate()).toBe(23);
  });

  /** The case this function exists for: armed at 23:50, stops at 07:00. */
  it('resolves a time earlier than now to the NEXT day', () => {
    const now = new Date(2026, 8, 23, 23, 50, 0);
    const resolved = new Date(resolveStopAt('07:00', now)!);
    expect(resolved.getHours()).toBe(7);
    expect(resolved.getDate()).toBe(24);
    expect(resolved.getTime()).toBeGreaterThan(now.getTime());
  });

  it('treats the current minute as the next day rather than as "now"', () => {
    const now = new Date(2026, 8, 23, 7, 0, 30);
    const resolved = new Date(resolveStopAt('07:00', now)!);
    expect(resolved.getDate()).toBe(24);
  });

  it('refuses anything that is not HH:MM', () => {
    for (const bad of ['', '7', '7pm', '24:00', '07:60', 'xx:yy', '07:00:00']) {
      expect(resolveStopAt(bad, new Date())).toBeNull();
    }
  });
});

describe('stopProgress', () => {
  it('draws no bar for an open-ended run', () => {
    const progress = stopProgress({ kind: 'until-paused' }, run());
    expect(progress.percent).toBeNull();
    expect(progress.headline).toBe('Runs until you pause it');
    expect(progress.reached).toBe(false);
  });

  it('counts down to a wall-clock stop and draws elapsed against the window', () => {
    const started = Date.parse('2026-09-23T23:00:00Z');
    const at = new Date(started + 8 * 3_600_000).toISOString();
    const now = started + 2 * 3_600_000;
    const progress = stopProgress({ kind: 'at-time', at }, run({ startedAt: new Date(started).toISOString() }), now);
    expect(progress.remaining).toBe('6h 00m left');
    expect(progress.percent).toBe(25);
    expect(progress.reached).toBe(false);
  });

  it('says the stop time is reached rather than counting up past it', () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const progress = stopProgress({ kind: 'at-time', at }, run(), Date.now());
    expect(progress.remaining).toBe('stop time reached');
    expect(progress.reached).toBe(true);
  });

  it('withholds the bar for a timed run that never reported a start', () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const progress = stopProgress({ kind: 'at-time', at }, run({ startedAt: null }), Date.now());
    expect(progress.percent).toBeNull();
    expect(progress.remaining).toMatch(/left$/);
  });

  it('counts iterations against the cap', () => {
    const progress = stopProgress({ kind: 'after-iterations', iterations: 20 }, run({ iterationsDone: 5 }));
    expect(progress.remaining).toBe('5 of 20 done');
    expect(progress.percent).toBe(25);
    expect(progress.reached).toBe(false);
  });

  /** Absent is not zero: an unreported count must not render as "0 of 20". */
  it('renders an unreported iteration count as unknown, not as zero', () => {
    const progress = stopProgress({ kind: 'after-iterations', iterations: 20 }, run({ iterationsDone: null }));
    expect(progress.remaining).toBe('— of 20 done');
    expect(progress.percent).toBeNull();
  });

  it('states that the rule is unknown rather than inventing one', () => {
    const progress = stopProgress(null, run());
    expect(progress.headline).toBe('Stop rule not stated');
    expect(progress.percent).toBeNull();
  });
});

describe('projectOvernight', () => {
  it('narrows a well-formed body', () => {
    const status = projectOvernight({
      armed: true,
      repos: 9,
      gate: { tests: true, lint: true, typecheck: true, autoMerge: true, branch: 'master' },
      run: {
        runId: 'r1',
        startedAt: '2026-09-23T23:00:00Z',
        stopRule: { kind: 'after-iterations', iterations: 12 },
        iterationsDone: 3,
        repo: 'ashlr-hub',
        activity: 'writing a patch',
        merged: [{ id: 'm1', repo: 'ashlr-hub', title: 'fix flake', at: '2026-09-24T01:00:00Z', commit: 'abc1234' }],
        discarded: [{ id: 'd1', repo: 'ashlrcode', title: 'refactor', at: null, reason: 'tests failed' }],
      },
    });
    expect(status?.armed).toBe(true);
    expect(status?.repos).toBe(9);
    expect(status?.run?.stopRule).toEqual({ kind: 'after-iterations', iterations: 12 });
    expect(status?.run?.merged).toHaveLength(1);
    expect(status?.run?.discarded[0]?.reason).toBe('tests failed');
  });

  // P4: mirrors are counted apart from repos (F5's server field).
  it('carries the fleet mirror count apart from repos, and keeps "absent" distinct from "not recorded"', () => {
    const base = { armed: true, repos: 9, gate: null, run: null };
    expect(projectOvernight({ ...base, mirrors: 9 })?.mirrors).toBe(9);
    expect(projectOvernight({ ...base, mirrors: null })?.mirrors).toBeNull();
    expect(projectOvernight({ ...base, mirrors: 'nine' })?.mirrors).toBeNull();
    const older = projectOvernight(base)!;
    expect('mirrors' in older).toBe(false);
    expect(older.repos).toBe(9);
  });

  it('refuses a body that does not say whether anything is armed', () => {
    expect(projectOvernight({ run: null })).toBeNull();
    expect(projectOvernight(null)).toBeNull();
    expect(projectOvernight([])).toBeNull();
    expect(projectOvernight('armed')).toBeNull();
  });

  it('degrades drifted fields to null instead of throwing at render time', () => {
    const status = projectOvernight({
      armed: true,
      repos: 'nine',
      gate: { tests: 'yes' },
      run: { runId: 'r1', iterationsDone: -3, merged: 'lots', discarded: null },
    });
    expect(status?.repos).toBeNull();
    expect(status?.gate?.tests).toBeNull();
    expect(status?.run?.iterationsDone).toBeNull();
    expect(status?.run?.merged).toEqual([]);
    expect(status?.run?.discarded).toEqual([]);
  });

  it('drops a stop rule it cannot read rather than half-reading it', () => {
    expect(projectStopRule({ kind: 'at-time', at: 'tomorrow-ish' })).toBeNull();
    expect(projectStopRule({ kind: 'after-iterations', iterations: 0 })).toBeNull();
    expect(projectStopRule({ kind: 'forever' })).toBeNull();
  });

  it('gives a discard with no stated reason one of its own', () => {
    const status = projectOvernight({
      armed: true,
      run: { runId: 'r1', discarded: [{ repo: 'hub', title: 'x' }] },
    });
    expect(status?.run?.discarded[0]?.reason).toBe('no reason recorded');
  });
});

describe('the gate, in words', () => {
  it('names only the checks the server committed to', () => {
    expect(gateChecks({ tests: true, lint: true, typecheck: null, autoMerge: true, branch: 'master' })).toEqual([
      'tests',
      'lint',
    ]);
    expect(gateUnstated({ tests: true, lint: true, typecheck: null, autoMerge: true, branch: 'master' })).toEqual([
      'typecheck',
    ]);
  });

  it('treats an absent gate as three unstated checks, not three passing ones', () => {
    expect(gateChecks(null)).toEqual([]);
    expect(gateUnstated(null)).toEqual(['tests', 'lint', 'typecheck']);
  });

  it('joins a list the way a person says it', () => {
    expect(joinPhrase([])).toBe('');
    expect(joinPhrase(['tests'])).toBe('tests');
    expect(joinPhrase(['tests', 'lint'])).toBe('tests and lint');
    expect(joinPhrase(['tests', 'lint', 'typecheck'])).toBe('tests, lint and typecheck');
  });
});

describe('copy helpers', () => {
  it('restates each rule in the operator’s own units', () => {
    const now = new Date(2026, 8, 23, 23, 50, 0);
    expect(describeStopRule({ kind: 'until-paused' }, now)).toMatch(/no stop time/);
    expect(describeStopRule({ kind: 'after-iterations', iterations: 1 }, now)).toBe('Stops after 1 iteration.');
    expect(describeStopRule({ kind: 'after-iterations', iterations: 12 }, now)).toBe('Stops after 12 iterations.');
    const at = resolveStopAt('07:00', now)!;
    expect(describeStopRule({ kind: 'at-time', at }, now)).toMatch(/ tomorrow\.$/);
  });

  it('reports elapsed only when a start was reported', () => {
    const now = Date.now();
    expect(formatRunElapsed(new Date(now - 3_720_000).toISOString(), now)).toBe('1h 02m');
    expect(formatRunElapsed(null, now)).toBe('—');
    expect(formatRunElapsed('not-a-date', now)).toBe('—');
  });
});
