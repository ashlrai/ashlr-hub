/**
 * M29 digest tests — buildDigest + the digest store, hermetic.
 *
 * SAFETY GUARDRAILS asserted here:
 *  - READ-ONLY AGGREGATION + WRITE-CONTAINMENT: the store writes ONLY under
 *    ~/.ashlr/digests/ (HOME is relocated to a tmp dir; nothing else in HOME is
 *    created). buildDigest itself writes NOTHING.
 *  - LOCAL-FIRST: with allowCloud=false, getActiveClient is forwarded
 *    { allowCloud: false } — NO cloud client is ever constructed; when no
 *    provider is reachable, the digest has NO narrative (deterministic only) and
 *    ZERO non-localhost calls occur.
 *  - BOUNDED + NEVER-THROWS: a throwing buildSnapshot degrades to a zeroed
 *    digest without throwing.
 *  - DAY-OVER-DAY: deltas are computed against a seeded prior digest, never
 *    against the digest itself.
 *
 * buildSnapshot + the provider client are mocked — the real ~/.ashlr is NEVER
 * touched and NO network call is ever attempted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AshlrConfig,
  DashboardSnapshot,
  DigestReport,
  PortfolioSummary,
} from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — must be set before any module resolves homedir(). The store
// path helpers re-resolve homedir() at call time, so relocating HOME per-test
// keeps every test hermetic and the real ~/.ashlr untouched.
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m29-digest-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Mocks — buildSnapshot (the ONLY read source buildDigest uses) + the provider
// client. NB: the store is NOT mocked — it exercises the real tmp-HOME FS.
// ---------------------------------------------------------------------------

const mockBuildSnapshot = vi.fn<[], Promise<DashboardSnapshot>>();

/** Tracks every getActiveClient call so we can prove the default path skips it. */
const getActiveClientCalls: Array<{ allowCloud: boolean }> = [];
/** When false (default for these tests), getActiveClient throws — local-first refusal. */
let providerReachable = false;

const mockGetActiveClient = vi.fn(
  async (_cfg: AshlrConfig, opts: { allowCloud: boolean }) => {
    getActiveClientCalls.push({ allowCloud: opts.allowCloud });
    if (!providerReachable) {
      // Mirror getActiveClient's local-first refusal when no provider is up.
      throw new Error('local-first: no provider is reachable.');
    }
    return {
      id: 'ollama',
      supportsTools: false,
      chat: async () => ({
        content: 'LOCAL NARRATIVE',
        usage: { tokensIn: 5, tokensOut: 5 },
      }),
    };
  },
);

vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: () => mockBuildSnapshot(),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (cfg: AshlrConfig, opts: { allowCloud: boolean }) =>
    mockGetActiveClient(cfg, opts),
}));

// ---------------------------------------------------------------------------
// Lazy imports of the modules-under-test (after mocks are registered).
// ---------------------------------------------------------------------------

import { buildDigest } from '../src/core/digest/build.js';
import {
  digestsDirPath,
  saveDigest,
  listDigests,
  loadPreviousDigest,
} from '../src/core/digest/store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  } as unknown as AshlrConfig;
}

function makePortfolio(overrides?: Partial<PortfolioSummary>): PortfolioSummary {
  return {
    health: {
      reposScored: 3,
      averageScore: 82,
      averageGrade: 'B',
      worstRepos: [{ repo: 'beta', score: 61, grade: 'D' }],
    },
    goalsInFlight: [
      {
        goalId: 'g1',
        objective: 'Ship v2',
        status: 'active',
        fractionDone: 0.5,
        proposed: 2,
        totalMilestones: 4,
        nextActionable: 'Wire dispatcher',
      },
    ],
    backlogTop: [{ title: 'Fix flaky test', repo: 'alpha', score: 12 }],
    cost: { window: '7d', spentUsd: 1.25, localSavingsUsd: 3.4, projectedMonthlyUsd: 5.1 },
    effectiveness: { successRate: 0.8, effectivenessDeltaPct: 4, headline: 'up 4%' },
    today: {
      previousAt: null,
      pendingProposalsDelta: null,
      dirtyReposDelta: null,
      spendUsdDelta: null,
      healthScoreDelta: null,
      goalsInFlightDelta: null,
    },
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<DashboardSnapshot>): DashboardSnapshot {
  return {
    generatedAt: '2026-06-10T12:00:00.000Z',
    repos: { total: 10, dirty: 3, stale: 1 },
    tools: { installed: 5, total: 8 },
    activity: { sessions: 4, tokens: 1000, estCostUsd: 0.2, commits: 7 },
    runs: [],
    swarms: [],
    mcp: [],
    genome: { entries: 12, projects: 3 },
    inbox: { pending: 2 },
    daemon: { running: true, todaySpentUsd: 0.5, pendingProposals: 2 },
    portfolio: makePortfolio(),
    ...overrides,
  } as DashboardSnapshot;
}

/** A structurally-valid prior digest for day-over-day delta tests. */
function makeDigest(
  generatedAt: string,
  overrides?: Partial<DigestReport>,
): DigestReport {
  return {
    generatedAt,
    date: generatedAt.slice(0, 10),
    window: '7d',
    portfolio: makePortfolio(),
    repos: { total: 10, dirty: 1, stale: 1 },
    pendingProposals: 1,
    daemon: null,
    headline: 'seeded prior',
    ...overrides,
  };
}

beforeEach(() => {
  mockBuildSnapshot.mockReset();
  mockBuildSnapshot.mockResolvedValue(makeSnapshot());
  mockGetActiveClient.mockClear();
  getActiveClientCalls.length = 0;
  providerReachable = false;
});

// ---------------------------------------------------------------------------
// buildDigest — from a seeded snapshot
// ---------------------------------------------------------------------------

describe('m29 buildDigest — from a seeded snapshot', () => {
  it('builds a deterministic digest carrying the snapshot portfolio', async () => {
    const report = await buildDigest(makeConfig());

    expect(report.window).toBe('7d');
    expect(report.repos).toEqual({ total: 10, dirty: 3, stale: 1 });
    expect(report.pendingProposals).toBe(2);
    expect(report.daemon).toEqual({ running: true, todaySpentUsd: 0.5 });
    expect(report.portfolio.health.averageGrade).toBe('B');
    expect(report.portfolio.goalsInFlight).toHaveLength(1);
    // Deterministic, always-present headline (no LLM).
    expect(report.headline).toContain('10 repos');
    expect(report.headline).toContain('health B');
    expect(report.headline).toContain('$1.25 spent (7d)');
  });

  it('honors the window option for cost figures', async () => {
    mockBuildSnapshot.mockResolvedValue(
      makeSnapshot({
        portfolio: makePortfolio({
          cost: { window: '30d', spentUsd: 9, localSavingsUsd: 1, projectedMonthlyUsd: 9 },
        }),
      }),
    );
    const report = await buildDigest(makeConfig(), { window: '30d' });
    expect(report.window).toBe('30d');
    expect(report.headline).toContain('(30d)');
  });

  it('degrades to a zeroed digest (never throws) when buildSnapshot throws', async () => {
    mockBuildSnapshot.mockRejectedValue(new Error('snapshot exploded'));
    const report = await buildDigest(makeConfig());
    expect(report.repos).toEqual({ total: 0, dirty: 0, stale: 0 });
    expect(report.pendingProposals).toBe(0);
    expect(report.daemon).toBeNull();
    expect(report.portfolio.health.reposScored).toBe(0);
    expect(report.portfolio.goalsInFlight).toEqual([]);
    expect(report.headline).toContain('0 repos');
  });

  it('uses emptyPortfolio when the snapshot has no portfolio section', async () => {
    mockBuildSnapshot.mockResolvedValue(makeSnapshot({ portfolio: undefined }));
    const report = await buildDigest(makeConfig());
    expect(report.portfolio.health.reposScored).toBe(0);
    expect(report.portfolio.goalsInFlight).toEqual([]);
    expect(report.portfolio.cost.spentUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildDigest — day-over-day delta vs a seeded prior digest
// ---------------------------------------------------------------------------

describe('m29 buildDigest — day-over-day deltas', () => {
  it('today deltas are null when there is no prior digest', async () => {
    const report = await buildDigest(makeConfig());
    expect(report.portfolio.today.previousAt).toBeNull();
    expect(report.portfolio.today.pendingProposalsDelta).toBeNull();
    expect(report.portfolio.today.dirtyReposDelta).toBeNull();
    expect(report.portfolio.today.spendUsdDelta).toBeNull();
    expect(report.portfolio.today.healthScoreDelta).toBeNull();
    expect(report.portfolio.today.goalsInFlightDelta).toBeNull();
  });

  it('computes deltas against a seeded prior digest (never against itself)', async () => {
    // Seed a prior digest: pending 1, dirty 1, spend 0.25, health 80, 0 goals.
    const prior = makeDigest('2026-06-09T12:00:00.000Z', {
      repos: { total: 10, dirty: 1, stale: 1 },
      pendingProposals: 1,
      portfolio: makePortfolio({
        health: { reposScored: 3, averageScore: 80, averageGrade: 'B', worstRepos: [] },
        goalsInFlight: [],
        cost: { window: '7d', spentUsd: 0.25, localSavingsUsd: 0, projectedMonthlyUsd: 1 },
      }),
    });
    saveDigest(prior, 'prior markdown');

    // Current snapshot: pending 2, dirty 3, spend 1.25, health 82, 1 goal.
    const report = await buildDigest(makeConfig());

    expect(report.portfolio.today.previousAt).toBe('2026-06-09T12:00:00.000Z');
    expect(report.portfolio.today.pendingProposalsDelta).toBe(1); // 2 - 1
    expect(report.portfolio.today.dirtyReposDelta).toBe(2); // 3 - 1
    expect(report.portfolio.today.spendUsdDelta).toBeCloseTo(1.0, 5); // 1.25 - 0.25
    expect(report.portfolio.today.healthScoreDelta).toBeCloseTo(2, 5); // 82 - 80
    expect(report.portfolio.today.goalsInFlightDelta).toBe(1); // 1 - 0
  });
});

// ---------------------------------------------------------------------------
// LOCAL-FIRST — narrative is off by default; no cloud client is constructed
// ---------------------------------------------------------------------------

describe('m29 buildDigest — local-first narrative', () => {
  it('default path (no narrative flag) has NO narrative', async () => {
    const report = await buildDigest(makeConfig());
    expect(report.narrative).toBeUndefined();
    expect(report.narrativeLocal).toBeUndefined();
  });

  // MEDIUM-SEV REGRESSION GUARD: the DEFAULT `ashlr digest` path must construct
  // NO model at all — not even a reachable LOCAL provider. getActiveClient must
  // never be consulted unless narrative was explicitly requested.
  it('default path constructs NO model — getActiveClient is never called', async () => {
    providerReachable = true; // even with a reachable local provider...
    const report = await buildDigest(makeConfig()); // ...no narrative flag
    expect(report.narrative).toBeUndefined();
    expect(report.narrativeLocal).toBeUndefined();
    expect(getActiveClientCalls.length).toBe(0);
  });

  it('narrative:true but no provider => no narrative (deterministic report kept)', async () => {
    const report = await buildDigest(makeConfig(), { narrative: true });
    expect(report.narrative).toBeUndefined();
    expect(report.narrativeLocal).toBeUndefined();
  });

  it('forwards allowCloud=false to getActiveClient and never opens a cloud client', async () => {
    await buildDigest(makeConfig(), { narrative: true });
    // getActiveClient is consulted but ONLY with allowCloud:false (local-only).
    expect(getActiveClientCalls.length).toBeGreaterThan(0);
    for (const call of getActiveClientCalls) {
      expect(call.allowCloud).toBe(false);
    }
  });

  it('attaches a LOCAL narrative when narrative is requested + a local provider is reachable', async () => {
    providerReachable = true;
    const report = await buildDigest(makeConfig(), { narrative: true, allowCloud: false });
    expect(report.narrative).toBe('LOCAL NARRATIVE');
    expect(report.narrativeLocal).toBe(true);
    // Still local-only.
    for (const call of getActiveClientCalls) {
      expect(call.allowCloud).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Store — round-trip, ordering, loadPreviousDigest
// ---------------------------------------------------------------------------

describe('m29 digest store — paths', () => {
  it('digestsDirPath resolves under HOME/.ashlr/digests', () => {
    expect(digestsDirPath()).toBe(path.join(tmpHome, '.ashlr', 'digests'));
  });

  it('does not create the directory just by resolving the path', () => {
    digestsDirPath();
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'digests'))).toBe(false);
  });
});

describe('m29 digest store — round-trip', () => {
  it('persists JSON + markdown siblings sharing an epoch-ms stem', () => {
    const report = makeDigest('2026-06-10T12:00:00.000Z');
    const { jsonPath, markdownPath } = saveDigest(report, '# digest body\n');

    expect(jsonPath).not.toBeNull();
    expect(markdownPath).not.toBeNull();
    const stem = String(Date.parse(report.generatedAt));
    expect(path.basename(jsonPath as string)).toBe(`${stem}.json`);
    expect(path.basename(markdownPath as string)).toBe(`${stem}.md`);

    // JSON parses back equal; markdown is the verbatim body.
    const parsed = JSON.parse(fs.readFileSync(jsonPath as string, 'utf8')) as DigestReport;
    expect(parsed).toEqual(report);
    expect(fs.readFileSync(markdownPath as string, 'utf8')).toBe('# digest body\n');

    // And the report surfaces through listDigests().
    const all = listDigests();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(report);
  });

  // LOW-SEV REGRESSION GUARD: two digests built in the SAME millisecond must
  // NOT clobber each other — the second gets a `-N` suffix and both survive.
  it('same-ms collision keeps BOTH digests (suffix, no overwrite)', () => {
    const ts = '2026-06-10T12:00:00.000Z';
    const stem = String(Date.parse(ts));
    const first = makeDigest(ts, { headline: 'first' });
    const second = makeDigest(ts, { headline: 'second' });

    const a = saveDigest(first, '# first\n');
    const b = saveDigest(second, '# second\n');

    expect(a.jsonPath).not.toBeNull();
    expect(b.jsonPath).not.toBeNull();
    // Distinct files: plain stem + suffixed stem.
    expect(path.basename(a.jsonPath as string)).toBe(`${stem}.json`);
    expect(path.basename(b.jsonPath as string)).toBe(`${stem}-1.json`);
    expect(a.jsonPath).not.toBe(b.jsonPath);

    // The first artifact was NOT overwritten — both bodies persist on disk.
    const firstOnDisk = JSON.parse(fs.readFileSync(a.jsonPath as string, 'utf8')) as DigestReport;
    const secondOnDisk = JSON.parse(fs.readFileSync(b.jsonPath as string, 'utf8')) as DigestReport;
    expect(firstOnDisk.headline).toBe('first');
    expect(secondOnDisk.headline).toBe('second');

    // Both json + their md siblings exist (4 files, no loss).
    const files = fs.readdirSync(digestsDirPath());
    expect(files.sort()).toEqual(
      [`${stem}.json`, `${stem}.md`, `${stem}-1.json`, `${stem}-1.md`].sort(),
    );
  });

  it('leaves no .tmp artifact behind after atomic writes', () => {
    saveDigest(makeDigest('2026-06-10T12:00:00.000Z'), 'body');
    const files = fs.readdirSync(digestsDirPath());
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files.sort()).toEqual(
      [
        `${Date.parse('2026-06-10T12:00:00.000Z')}.json`,
        `${Date.parse('2026-06-10T12:00:00.000Z')}.md`,
      ].sort(),
    );
  });
});

describe('m29 digest store — listDigests ordering + filtering', () => {
  it('returns most-recent first by generatedAt', () => {
    const older = makeDigest('2026-06-01T00:00:00.000Z');
    const middle = makeDigest('2026-06-05T00:00:00.000Z');
    const newer = makeDigest('2026-06-09T00:00:00.000Z');
    // Save out of order to prove the sort is by content, not write order.
    saveDigest(middle, 'm');
    saveDigest(newer, 'n');
    saveDigest(older, 'o');

    const all = listDigests();
    expect(all.map((d) => d.generatedAt)).toEqual([
      newer.generatedAt,
      middle.generatedAt,
      older.generatedAt,
    ]);
  });

  it('ignores markdown siblings, malformed JSON, and *.tmp files', () => {
    saveDigest(makeDigest('2026-06-10T12:00:00.000Z'), 'body');
    const dir = digestsDirPath();
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{not valid json', 'utf8');
    fs.writeFileSync(path.join(dir, 'half.json.tmp'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'wrongshape.json'),
      JSON.stringify({ hello: 'world' }),
      'utf8',
    );

    const all = listDigests();
    expect(all).toHaveLength(1);
    expect(all[0]?.generatedAt).toBe('2026-06-10T12:00:00.000Z');
  });
});

describe('m29 digest store — loadPreviousDigest', () => {
  it('returns the newest digest when no cutoff is given', () => {
    saveDigest(makeDigest('2026-06-01T00:00:00.000Z'), 'a');
    saveDigest(makeDigest('2026-06-09T00:00:00.000Z'), 'b');
    expect(loadPreviousDigest()?.generatedAt).toBe('2026-06-09T00:00:00.000Z');
  });

  it('honors the `before` cutoff (strictly-before) so a digest is not its own prior', () => {
    const prior = makeDigest('2026-06-01T00:00:00.000Z');
    const current = makeDigest('2026-06-09T00:00:00.000Z');
    saveDigest(prior, 'a');
    saveDigest(current, 'b');
    expect(loadPreviousDigest(current.generatedAt)?.generatedAt).toBe(prior.generatedAt);
  });

  it('returns null when the cutoff excludes every digest', () => {
    saveDigest(makeDigest('2026-06-09T00:00:00.000Z'), 'a');
    expect(loadPreviousDigest('2026-06-09T00:00:00.000Z')).toBeNull();
  });

  it('empty state — listDigests() === [] and loadPreviousDigest() === null', () => {
    expect(listDigests()).toEqual([]);
    expect(loadPreviousDigest()).toBeNull();
    expect(loadPreviousDigest('2026-06-09T00:00:00.000Z')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WRITE-CONTAINMENT — only ~/.ashlr/digests is ever touched
// ---------------------------------------------------------------------------

describe('m29 — write containment (safety invariant 1)', () => {
  it('saveDigest only writes under ~/.ashlr/digests, nothing else in HOME', () => {
    saveDigest(makeDigest('2026-06-10T12:00:00.000Z'), 'body');
    expect(fs.readdirSync(tmpHome)).toEqual(['.ashlr']);
    expect(fs.readdirSync(path.join(tmpHome, '.ashlr'))).toEqual(['digests']);
  });

  it('buildDigest writes NOTHING (no HOME mutation) on the default path', async () => {
    await buildDigest(makeConfig());
    // buildDigest is read-only; persistence is deliver.ts's job. HOME stays clean.
    expect(fs.existsSync(path.join(tmpHome, '.ashlr'))).toBe(false);
  });
});
