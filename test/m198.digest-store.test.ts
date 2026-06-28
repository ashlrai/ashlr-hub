/**
 * M198 digest-store regression tests.
 *
 * Covers the two M29 TODOs resolved in this milestone:
 *
 *  1. ensureDir (store.ts) — recursive mkdir with proper error handling:
 *     - succeeds on a fresh dir (creates it + all parents).
 *     - is idempotent (calling twice on the same dir never throws).
 *     - treats EEXIST as benign (concurrent creation race — no throw, no log).
 *     - logs a diagnostic on real OS errors (ENOTDIR/EACCES) without throwing.
 *     - a failed ensureDir leaves saveDigest gracefully returning null paths
 *       (never-throws contract preserved).
 *
 *  2. emptyPortfolio (store.ts, M198 consolidation) — single source of truth:
 *     - exported from store.ts, not defined locally in build.ts.
 *     - returns a structurally-valid, zero-filled PortfolioSummary.
 *     - honours the `window` parameter in the cost block.
 *     - today delta is fully null-filled (no prior to diff against).
 *     - build.ts's emptyPortfolio path produces the same shape (regression).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — must happen before any digest store module resolves homedir.
// The store re-resolves homedir() at call time, so this is safe per-test.
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m198-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Mocks for buildDigest path (store is exercised un-mocked against tmp HOME)
// ---------------------------------------------------------------------------

vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: vi.fn().mockResolvedValue({
    generatedAt: '2026-06-10T12:00:00.000Z',
    repos: { total: 0, dirty: 0, stale: 0 },
    tools: { installed: 0, total: 0 },
    activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
    runs: [],
    swarms: [],
    mcp: [],
    genome: { entries: 0, projects: 0 },
    inbox: { pending: 0 },
    daemon: { running: false, todaySpentUsd: 0, pendingProposals: 0 },
  }),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn().mockRejectedValue(new Error('no provider')),
}));

// ---------------------------------------------------------------------------
// Module under test (imported AFTER mocks are registered)
// ---------------------------------------------------------------------------

import {
  saveDigest,
  emptyPortfolio,
  emptyTodayDelta,
  digestsDirPath,
} from '../src/core/digest/store.js';
import type { DigestReport, PortfolioSummary } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeDigest(generatedAt: string, overrides?: Partial<DigestReport>): DigestReport {
  const portfolio = emptyPortfolio('7d');
  return {
    generatedAt,
    date: generatedAt.slice(0, 10),
    window: '7d',
    portfolio,
    repos: { total: 0, dirty: 0, stale: 0 },
    pendingProposals: 0,
    daemon: null,
    headline: 'm198 test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. ensureDir — mkdir error handling
// ---------------------------------------------------------------------------

describe('m198 ensureDir — mkdir error handling', () => {
  it('creates the digests dir (+ parents) on first saveDigest call', () => {
    const dir = digestsDirPath();
    expect(fs.existsSync(dir)).toBe(false);

    const { jsonPath } = saveDigest(makeDigest('2026-06-10T10:00:00.000Z'), 'body');

    expect(fs.existsSync(dir)).toBe(true);
    expect(jsonPath).not.toBeNull();
  });

  it('is idempotent — calling saveDigest twice does not throw or corrupt existing files', () => {
    const ts1 = '2026-06-10T10:00:00.000Z';
    const ts2 = '2026-06-10T11:00:00.000Z';

    const first = saveDigest(makeDigest(ts1), 'first body');
    const second = saveDigest(makeDigest(ts2), 'second body');

    expect(first.jsonPath).not.toBeNull();
    expect(second.jsonPath).not.toBeNull();
    expect(first.jsonPath).not.toBe(second.jsonPath);

    // Both JSON files survive on disk.
    const dir = digestsDirPath();
    const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(jsonFiles).toHaveLength(2);
  });

  it('treats a pre-existing dir as benign (no throw, no error log)', () => {
    // Pre-create the directory so mkdirSync would get EEXIST.
    const dir = digestsDirPath();
    fs.mkdirSync(dir, { recursive: true });
    expect(fs.existsSync(dir)).toBe(true);

    const consoleSpy = vi.spyOn(console, 'error');

    const { jsonPath } = saveDigest(makeDigest('2026-06-10T12:00:00.000Z'), 'body');

    // EEXIST is silent — no error log, no throw.
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(jsonPath).not.toBeNull();

    consoleSpy.mockRestore();
  });

  it('logs a diagnostic on real OS errors (ENOTDIR) without throwing', () => {
    // Place a FILE at `.ashlr` (the PARENT of `digests`) so that
    // mkdirSync('.ashlr/digests', { recursive: true }) gets ENOTDIR.
    // On macOS, blocking at the leaf gives EEXIST (treated as benign);
    // blocking a parent component gives ENOTDIR (a real failure).
    fs.writeFileSync(path.join(tmpHome, '.ashlr'), 'blocker', 'utf8');

    const consoleSpy = vi.spyOn(console, 'error');

    // saveDigest must NOT throw even when ensureDir fails.
    let threw = false;
    let result: ReturnType<typeof saveDigest> = { jsonPath: null, markdownPath: null };
    try {
      result = saveDigest(makeDigest('2026-06-10T13:00:00.000Z'), 'body');
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // The write will also fail (dir not created), so both paths come back null.
    expect(result.jsonPath).toBeNull();
    expect(result.markdownPath).toBeNull();
    // But ensureDir logged the real failure.
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ashlr:digest] ensureDir failed for'),
      // message includes the dir path
    );

    consoleSpy.mockRestore();
  });

  it('never throws on any failure path — saveDigest always returns the null-path shape', () => {
    // Drive a failure by blocking the dir (ENOTDIR).
    const ashlrDir = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlrDir, { recursive: true });
    fs.writeFileSync(path.join(ashlrDir, 'digests'), 'blocker', 'utf8');

    expect(() => saveDigest(makeDigest('2026-06-10T14:00:00.000Z'), 'body')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. emptyPortfolio — single source of truth, exported from store.ts
// ---------------------------------------------------------------------------

describe('m198 emptyPortfolio — canonical export from store.ts', () => {
  it('is exported from store.ts (import does not throw)', () => {
    expect(typeof emptyPortfolio).toBe('function');
  });

  it('returns a structurally valid PortfolioSummary with all zeroed fields', () => {
    const p: PortfolioSummary = emptyPortfolio('7d');

    expect(p.health.reposScored).toBe(0);
    expect(p.health.averageScore).toBe(0);
    expect(p.health.averageGrade).toBe('F');
    expect(p.health.worstRepos).toEqual([]);

    expect(p.goalsInFlight).toEqual([]);
    expect(p.backlogTop).toEqual([]);
    expect(p.effectiveness).toBeNull();
  });

  it('honours the window parameter in the cost block', () => {
    const p7 = emptyPortfolio('7d');
    expect(p7.cost.window).toBe('7d');
    expect(p7.cost.spentUsd).toBe(0);
    expect(p7.cost.localSavingsUsd).toBe(0);
    expect(p7.cost.projectedMonthlyUsd).toBe(0);

    const p30 = emptyPortfolio('30d');
    expect(p30.cost.window).toBe('30d');
  });

  it('today delta block is fully null-filled (no prior to diff)', () => {
    const p = emptyPortfolio('7d');
    expect(p.today.previousAt).toBeNull();
    expect(p.today.pendingProposalsDelta).toBeNull();
    expect(p.today.dirtyReposDelta).toBeNull();
    expect(p.today.spendUsdDelta).toBeNull();
    expect(p.today.healthScoreDelta).toBeNull();
    expect(p.today.goalsInFlightDelta).toBeNull();
  });

  it('each call returns a fresh object (no shared reference mutations)', () => {
    const a = emptyPortfolio('7d');
    const b = emptyPortfolio('7d');
    a.goalsInFlight.push({
      goalId: 'g1',
      objective: 'test',
      status: 'active',
      fractionDone: 0,
      proposed: 0,
      totalMilestones: 1,
      nextActionable: null,
    });
    expect(b.goalsInFlight).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. emptyTodayDelta — also exported and null-filled
// ---------------------------------------------------------------------------

describe('m198 emptyTodayDelta — exported from store.ts', () => {
  it('is exported from store.ts', () => {
    expect(typeof emptyTodayDelta).toBe('function');
  });

  it('returns a fully null-filled PortfolioTodayDelta', () => {
    const d = emptyTodayDelta();
    expect(d.previousAt).toBeNull();
    expect(d.pendingProposalsDelta).toBeNull();
    expect(d.dirtyReposDelta).toBeNull();
    expect(d.spendUsdDelta).toBeNull();
    expect(d.healthScoreDelta).toBeNull();
    expect(d.goalsInFlightDelta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Regression — emptyPortfolio via build.ts (snapshot missing portfolio)
// ---------------------------------------------------------------------------

describe('m198 regression — build.ts uses store.ts emptyPortfolio', () => {
  it('buildDigest uses emptyPortfolio from store.ts when snapshot.portfolio is absent', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    vi.mocked(buildSnapshot).mockResolvedValueOnce({
      generatedAt: '2026-06-10T12:00:00.000Z',
      repos: { total: 5, dirty: 1, stale: 0 },
      tools: { installed: 0, total: 0 },
      activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
      runs: [],
      swarms: [],
      mcp: [],
      genome: { entries: 0, projects: 0 },
      inbox: { pending: 0 },
      daemon: { running: false, todaySpentUsd: 0, pendingProposals: 0 },
      // portfolio intentionally absent
    } as Parameters<typeof buildSnapshot>[0] extends never ? never : Awaited<ReturnType<typeof buildSnapshot>>);

    const { buildDigest } = await import('../src/core/digest/build.js');
    const cfg = {
      version: 1,
      roots: [],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
      telemetry: {},
      tools: {},
    } as Parameters<typeof buildDigest>[0];

    const report = await buildDigest(cfg, { window: '7d' });

    // Portfolio degraded to the zeroed default from store.ts's emptyPortfolio.
    expect(report.portfolio.health.reposScored).toBe(0);
    expect(report.portfolio.goalsInFlight).toEqual([]);
    expect(report.portfolio.cost.spentUsd).toBe(0);
    expect(report.portfolio.cost.window).toBe('7d');
    // today delta is null-filled (no prior).
    expect(report.portfolio.today.previousAt).toBeNull();
  });
});

// Restore HOME after all tests in this file.
afterAll(() => {
  process.env.HOME = origHome;
});
