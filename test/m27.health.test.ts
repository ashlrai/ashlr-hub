/**
 * M27 health tests — computeHealth / computeReport / gradeFor.
 *
 * SAFETY GUARDRAILS:
 *  - The six M22 SCANNERS are mocked so NO real subprocess (gh/npm/rg) runs and
 *    NO disk is scanned — every scanner is a controllable fake.
 *  - probeConventions is mocked so the convention dimension is deterministic
 *    without touching any real filesystem.
 *  - listEnrolled / isEnrolled are mocked so we never read the real
 *    ~/.ashlr/enrollment.json and the enrollment-scoping invariant is verified
 *    in isolation.
 *  - No HOME is touched and no network is made: computeHealth/computeReport
 *    write nothing and reach nothing beyond the (mocked) scanners.
 *
 * Invariants asserted:
 *   - gradeFor: exact A/B/C/D/F boundaries (90/80/70/60).
 *   - dimension weighting: a low-weight miss dents the overall less than a
 *     high-weight miss of equal magnitude.
 *   - score math: a clean repo scores 100/A; an unhealthy repo scores far lower
 *     with the right grade; per-dimension penalties are deterministic.
 *   - worst offenders are the highest-WorkItem.score items, bounded to 5.
 *   - empty enrollment => empty report and NO scanner is invoked (no scan).
 *   - explicit non-enrolled --repo is REJECTED (computeReport throws).
 *   - explicit enrolled --repo succeeds.
 *   - bounded: maxRepos caps how many repos are scored.
 *   - never throws: a rejecting scanner degrades its dimension (no crash).
 *   - READ-ONLY / local-first: no narrative on the default path.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import * as path from 'node:path';
import type { WorkItem, WorkSource } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — hoisted before the module-under-test is imported.
// ---------------------------------------------------------------------------

// Each scanner is an independently controllable mock. computeHealth runs them
// via the SCANNERS array, so we export an array of these mocks in scanner order.
// vi.hoisted lets these mocks be referenced inside the (hoisted) vi.mock factories.
const mocks = vi.hoisted(() => ({
  scanIssues: vi.fn(),
  scanTodos: vi.fn(),
  scanTests: vi.fn(),
  scanDeps: vi.fn(),
  scanDocs: vi.fn(),
  scanSecurity: vi.fn(),
  probeConventions: vi.fn(),
  listEnrolled: vi.fn(),
  isEnrolled: vi.fn(),
}));

const {
  scanIssues,
  scanTodos,
  scanTests,
  scanDeps,
  scanDocs,
  scanSecurity,
  probeConventions,
  listEnrolled,
  isEnrolled,
} = mocks;

vi.mock('../src/core/portfolio/scanners.js', () => ({
  scanIssues: mocks.scanIssues,
  scanTodos: mocks.scanTodos,
  scanTests: mocks.scanTests,
  scanDeps: mocks.scanDeps,
  scanDocs: mocks.scanDocs,
  scanSecurity: mocks.scanSecurity,
  // Order MUST match the real module: [issues, todos, tests, deps, docs, security].
  SCANNERS: [
    mocks.scanIssues,
    mocks.scanTodos,
    mocks.scanTests,
    mocks.scanDeps,
    mocks.scanDocs,
    mocks.scanSecurity,
  ],
}));

vi.mock('../src/core/quality/conventions.js', () => ({
  probeConventions: mocks.probeConventions,
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  listEnrolled: mocks.listEnrolled,
  isEnrolled: mocks.isEnrolled,
}));

// ---------------------------------------------------------------------------
// Module under test (imported AFTER vi.mock is hoisted)
// ---------------------------------------------------------------------------

import {
  gradeFor,
  computeHealth,
  computeReport,
} from '../src/core/quality/health.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idSeq = 0;

/** Build a minimal WorkItem with a given source + severity (value). */
function item(repo: string, source: WorkSource, value: number, score = value): WorkItem {
  _idSeq += 1;
  return {
    id: `${source}:${_idSeq}`,
    repo,
    source,
    title: `${source} finding ${_idSeq}`,
    detail: 'detail',
    value,
    effort: 2,
    score,
    tags: [source],
    ts: new Date().toISOString(),
  };
}

/** Reset every scanner to "no findings" and the probe to "all conventions ok". */
function resetToHealthy(): void {
  for (const m of [scanIssues, scanTodos, scanTests, scanDeps, scanDocs, scanSecurity]) {
    (m as Mock).mockReset();
    (m as Mock).mockResolvedValue([]);
  }
  probeConventions.mockReset();
  probeConventions.mockReturnValue([]);
  listEnrolled.mockReset();
  listEnrolled.mockReturnValue([]);
  isEnrolled.mockReset();
  // Default to enrolled so the direct computeHealth() tests below pass through
  // the CORE-layer enrollment guard. computeReport's non-enrolled tests override
  // this explicitly (mockReturnValue(false) / mockImplementation) per case.
  isEnrolled.mockReturnValue(true);
}

beforeEach(() => {
  resetToHealthy();
});

// ===========================================================================
// gradeFor — exact boundaries
// ===========================================================================

describe('M27 gradeFor — letter-grade boundaries', () => {
  it('maps boundary scores to the right grade', () => {
    expect(gradeFor(100)).toBe('A');
    expect(gradeFor(90)).toBe('A');
    expect(gradeFor(89)).toBe('B');
    expect(gradeFor(80)).toBe('B');
    expect(gradeFor(79)).toBe('C');
    expect(gradeFor(70)).toBe('C');
    expect(gradeFor(69)).toBe('D');
    expect(gradeFor(60)).toBe('D');
    expect(gradeFor(59)).toBe('F');
    expect(gradeFor(0)).toBe('F');
  });

  it('is deterministic and monotonic-ish across the range', () => {
    const order = ['F', 'D', 'C', 'B', 'A'];
    let last = 0;
    for (const s of [0, 60, 70, 80, 90, 100]) {
      const g = gradeFor(s);
      expect(order).toContain(g);
      expect(order.indexOf(g)).toBeGreaterThanOrEqual(last);
      last = order.indexOf(g);
    }
  });
});

// ===========================================================================
// computeHealth — clean repo scores 100/A
// ===========================================================================

describe('M27 computeHealth — a healthy repo', () => {
  it('scores 100 / A when there are zero findings and all conventions pass', async () => {
    const score = await computeHealth('/tmp/healthy-repo');
    expect(score.score).toBe(100);
    expect(score.grade).toBe('A');
    expect(score.worstOffenders).toEqual([]);
    // Every dimension present, each perfect.
    expect(score.dimensions).toHaveLength(7);
    for (const d of score.dimensions) {
      expect(d.score).toBe(100);
      expect(d.findingCount).toBe(0);
    }
  });

  it('resolves repo to an absolute path and stamps an ISO ts', async () => {
    const score = await computeHealth('/tmp/healthy-repo');
    expect(path.isAbsolute(score.repo)).toBe(true);
    expect(() => new Date(score.ts)).not.toThrow();
    expect(typeof score.ts).toBe('string');
  });

  it('runs all six scanners exactly once', async () => {
    await computeHealth('/tmp/healthy-repo');
    for (const m of [scanIssues, scanTodos, scanTests, scanDeps, scanDocs, scanSecurity]) {
      expect(m).toHaveBeenCalledTimes(1);
      expect(m).toHaveBeenCalledWith(path.resolve('/tmp/healthy-repo'));
    }
    expect(probeConventions).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// computeHealth — an unhealthy repo
// ===========================================================================

describe('M27 computeHealth — an unhealthy repo', () => {
  it('scores far below an A and reflects findings per dimension', async () => {
    const repo = path.resolve('/tmp/unhealthy-repo');
    // A critical security finding + critical deps + failing tests/CI.
    scanSecurity.mockResolvedValue([item(repo, 'security', 5)]);
    scanDeps.mockResolvedValue([item(repo, 'dep', 5), item(repo, 'dep', 4)]);
    scanTests.mockResolvedValue([item(repo, 'test', 4)]);
    scanTodos.mockResolvedValue([item(repo, 'todo', 2), item(repo, 'todo', 2)]);
    probeConventions.mockReturnValue([
      { key: 'license', label: 'LICENSE file', ok: false, weight: 3, detail: 'no LICENSE' },
      { key: 'gitignore', label: '.gitignore', ok: false, weight: 2, detail: 'no .gitignore' },
    ]);

    const score = await computeHealth('/tmp/unhealthy-repo');

    expect(score.score).toBeLessThan(90);
    expect(['B', 'C', 'D', 'F']).toContain(score.grade);

    const byDim = Object.fromEntries(score.dimensions.map((d) => [d.dimension, d]));
    // security: one value-5 finding => 100 - 30 = 70.
    expect(byDim['security']!.score).toBe(70);
    expect(byDim['security']!.findingCount).toBe(1);
    // deps: value-5 (30) + value-4 (24) => 100 - 54 = 46.
    expect(byDim['deps']!.score).toBe(46);
    expect(byDim['deps']!.findingCount).toBe(2);
    // conventions: weight-3 (18) + weight-2 (12) => 100 - 30 = 70.
    expect(byDim['conventions']!.score).toBe(70);
    // findingCount must reflect the TWO failed convention probes (not 0). The
    // conventions dimension is fed by probeConventions, not WorkItems, so this
    // guards the regression where the count was always items.length === 0.
    expect(byDim['conventions']!.findingCount).toBe(2);
    expect(byDim['conventions']!.summary).toContain('2 convention gap');
    // docs untouched => perfect.
    expect(byDim['docs']!.score).toBe(100);
  });

  it('buckets each WorkSource onto its mapped dimension', async () => {
    const repo = path.resolve('/tmp/bucket-repo');
    scanIssues.mockResolvedValue([item(repo, 'issue', 3)]); // -> issuesCi
    scanTodos.mockResolvedValue([item(repo, 'todo', 3)]);   // -> codeDebt
    scanDocs.mockResolvedValue([item(repo, 'doc', 3)]);     // -> docs

    const score = await computeHealth(repo);
    const byDim = Object.fromEntries(score.dimensions.map((d) => [d.dimension, d]));
    expect(byDim['issuesCi']!.findingCount).toBe(1);
    expect(byDim['codeDebt']!.findingCount).toBe(1);
    expect(byDim['docs']!.findingCount).toBe(1);
    // untouched dimensions stay clean
    expect(byDim['security']!.findingCount).toBe(0);
    expect(byDim['deps']!.findingCount).toBe(0);
  });
});

// ===========================================================================
// Dimension weighting — equal-magnitude miss dents heavier-weighted dim more
// ===========================================================================

describe('M27 computeHealth — dimension weighting', () => {
  it('a heavier-weighted dimension miss lowers the overall more than a lighter one', async () => {
    const repo = path.resolve('/tmp/weight-repo');

    // Case A: a single value-5 finding in `security` (weight 25).
    scanSecurity.mockResolvedValue([item(repo, 'security', 5)]);
    const heavy = await computeHealth(repo);

    // Reset, then put an identical-magnitude finding in `codeDebt` (weight 10).
    resetToHealthy();
    scanTodos.mockResolvedValue([item(repo, 'todo', 5)]);
    const light = await computeHealth(repo);

    // Same per-dimension penalty (both 100 -> 70), but security carries more
    // weight, so the overall is dragged down further.
    expect(heavy.score).toBeLessThan(light.score);
  });
});

// ===========================================================================
// worst offenders — top by WorkItem.score, bounded to 5
// ===========================================================================

describe('M27 computeHealth — worst offenders', () => {
  it('keeps the top 5 WorkItems by score, descending', async () => {
    const repo = path.resolve('/tmp/offenders-repo');
    // 8 todo items with ascending scores 1..8.
    const items = Array.from({ length: 8 }, (_v, i) => item(repo, 'todo', 2, i + 1));
    scanTodos.mockResolvedValue(items);

    const score = await computeHealth(repo);
    expect(score.worstOffenders).toHaveLength(5);
    const scores = score.worstOffenders.map((w) => w.score);
    expect(scores).toEqual([8, 7, 6, 5, 4]);
  });
});

// ===========================================================================
// never throws — a rejecting scanner degrades its dimension
// ===========================================================================

describe('M27 computeHealth — never throws on a scanner failure', () => {
  it('degrades a rejecting scanner to a conservatively-penalized dimension', async () => {
    const repo = path.resolve('/tmp/degrade-repo');
    scanSecurity.mockRejectedValue(new Error('binshield blew up'));

    let score: Awaited<ReturnType<typeof computeHealth>> | undefined;
    await expect(
      computeHealth(repo).then((s) => { score = s; }),
    ).resolves.not.toThrow();

    const sec = score!.dimensions.find((d) => d.dimension === 'security');
    // Failed scanner => not perfect, with a conservative note.
    expect(sec!.score).toBeLessThan(100);
    expect(sec!.summary).toMatch(/scanner unavailable/i);
  });
});

// ===========================================================================
// computeHealth — ENROLLMENT-SCOPED at the CORE layer (defense-in-depth)
// ===========================================================================

describe('M27 computeHealth — CORE-layer enrollment guard', () => {
  it('HARD-ERRORS on a non-enrolled repo and runs NO scanner', async () => {
    isEnrolled.mockReturnValue(false);

    await expect(computeHealth('/tmp/not-enrolled-core')).rejects.toThrow(
      /not enrolled for health review/,
    );

    // The guard fires BEFORE any disk scan — no scanner/probe ran.
    for (const m of [scanIssues, scanTodos, scanTests, scanDeps, scanDocs, scanSecurity]) {
      expect(m).not.toHaveBeenCalled();
    }
    expect(probeConventions).not.toHaveBeenCalled();
  });

  it('checks isEnrolled with the RESOLVED absolute path', async () => {
    isEnrolled.mockReturnValue(false);
    await expect(computeHealth('./rel-core')).rejects.toThrow();
    expect(isEnrolled).toHaveBeenCalledWith(path.resolve('./rel-core'));
  });

  it('scores an enrolled repo (guard passes through)', async () => {
    isEnrolled.mockReturnValue(true);
    const score = await computeHealth('/tmp/enrolled-core');
    expect(score.score).toBe(100);
  });
});

// ===========================================================================
// computeReport — empty enrollment => empty report, NO scan
// ===========================================================================

describe('M27 computeReport — ENROLLMENT-SCOPED: empty enrollment', () => {
  it('returns an empty report and invokes NO scanner when nothing is enrolled', async () => {
    listEnrolled.mockReturnValue([]);

    const report = await computeReport();

    expect(report.repos).toEqual([]);
    expect(report.scores).toEqual([]);
    expect(report.averageScore).toBe(0);
    expect(report.averageGrade).toBe('F');
    expect(report.delta).toEqual({});
    // No narrative on the default deterministic path (local-first).
    expect(report.narrative).toBeUndefined();

    // CRITICAL: no scanner ran (no disk scan with empty enrollment).
    for (const m of [scanIssues, scanTodos, scanTests, scanDeps, scanDocs, scanSecurity]) {
      expect(m).not.toHaveBeenCalled();
    }
    expect(probeConventions).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// computeReport — explicit repos filtered through isEnrolled()
// ===========================================================================

describe('M27 computeReport — ENROLLMENT-SCOPED: explicit repos', () => {
  it('HARD-ERRORS on an explicit non-enrolled --repo (and runs no scan)', async () => {
    isEnrolled.mockReturnValue(false);

    await expect(computeReport({ repos: ['/tmp/not-enrolled'] })).rejects.toThrow(
      /not enrolled for health review/,
    );

    for (const m of [scanIssues, scanTodos, scanTests, scanDeps, scanDocs, scanSecurity]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it('checks isEnrolled with the RESOLVED absolute path', async () => {
    isEnrolled.mockReturnValue(false);
    await expect(computeReport({ repos: ['./relative-path'] })).rejects.toThrow();
    expect(isEnrolled).toHaveBeenCalledWith(path.resolve('./relative-path'));
  });

  it('scores an explicit ENROLLED repo successfully', async () => {
    const repo = path.resolve('/tmp/enrolled-repo');
    isEnrolled.mockImplementation((r: string) => r === repo);

    const report = await computeReport({ repos: [repo] });
    expect(report.repos).toEqual([repo]);
    expect(report.scores).toHaveLength(1);
    expect(report.scores[0]!.repo).toBe(repo);
    expect(report.scores[0]!.score).toBe(100); // healthy by default
  });
});

// ===========================================================================
// computeReport — ranking + average
// ===========================================================================

describe('M27 computeReport — ranking + average', () => {
  it('ranks worst-first and computes the average score/grade', async () => {
    const good = path.resolve('/tmp/good');
    const bad = path.resolve('/tmp/bad');
    isEnrolled.mockReturnValue(true);

    // `bad` gets a brutal security + deps hit so it ranks first (worst).
    scanSecurity.mockImplementation(async (r: string) =>
      r === bad ? [item(bad, 'security', 5)] : [],
    );
    scanDeps.mockImplementation(async (r: string) =>
      r === bad ? [item(bad, 'dep', 5), item(bad, 'dep', 5)] : [],
    );

    const report = await computeReport({ repos: [good, bad] });
    expect(report.scores).toHaveLength(2);
    // worst-first: bad before good.
    expect(report.scores[0]!.repo).toBe(bad);
    expect(report.scores[1]!.repo).toBe(good);
    expect(report.scores[0]!.score).toBeLessThan(report.scores[1]!.score);

    const expectedAvg = Math.round(
      (report.scores[0]!.score + report.scores[1]!.score) / 2,
    );
    expect(report.averageScore).toBe(expectedAvg);
    expect(report.averageGrade).toBe(gradeFor(expectedAvg));
  });
});

// ===========================================================================
// computeReport — BOUNDED: maxRepos caps the work
// ===========================================================================

describe('M27 computeReport — BOUNDED', () => {
  it('scores at most maxRepos repos', async () => {
    isEnrolled.mockReturnValue(true);
    const repos = Array.from({ length: 121 }, (_v, i) => path.resolve(`/tmp/repo-${i}`));

    const report = await computeReport({ repos, maxRepos: 100 });
    expect(report.repos).toHaveLength(100);
    expect(report.scores).toHaveLength(100);
  });

  it('defaults to a bounded run (does not score more than 100 without maxRepos)', async () => {
    isEnrolled.mockReturnValue(true);
    const repos = Array.from({ length: 150 }, (_v, i) => path.resolve(`/tmp/r-${i}`));

    const report = await computeReport({ repos });
    expect(report.scores.length).toBeLessThanOrEqual(100);
  });
});
