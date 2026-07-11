/**
 * M29 surface tests — TUI + web surfacing of the read-only org-level portfolio.
 *
 * Covers CONTRACT-M29 §"TUI / web surfacing (READ-ONLY)":
 *   - TUI renderFrame() on the 'portfolio' tab renders the seeded
 *     PortfolioSummary (health / goals / backlog / cost / effectiveness / today)
 *     and stays pure + width-bounded.
 *   - renderFrame() on the 'portfolio' tab does NOT throw when snap.portfolio is
 *     undefined (older producer / empty enrollment), and degrades to a
 *     "no portfolio data" line.
 *   - The web API serves GET /api/portfolio with the portfolio section
 *     (read-only projection of buildSnapshot().portfolio), 200 application/json.
 *   - SAFETY: no write/mutation path was added by the surfacing layer —
 *       * GET /api/portfolio with no token + allowDispatch:false returns 200
 *         (it is a pure read; nothing to authorize),
 *       * POST/PUT/DELETE/PATCH to /api/portfolio are NOT accepted (404 — the
 *         route is GET-only; there is no mutation endpoint),
 *       * the api.ts source contains no mutation call inside the portfolio
 *         route (static grep), and the served dashboard exposes no mutation
 *         control bound to the portfolio view.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as http from 'node:http';

import type {
  DashboardSnapshot,
  PortfolioSummary,
  TuiTab,
  AshlrConfig,
  WebServerOptions,
} from '../src/core/types.js';
import { renderFrame } from '../src/tui/render.js';
import { stripAnsi } from '../src/cli/ui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePortfolio(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    health: {
      reposScored: 4,
      averageScore: 82,
      averageGrade: 'B',
      worstRepos: [
        { repo: '/Users/x/projects/alpha-svc', score: 41, grade: 'F' },
        { repo: '/Users/x/projects/beta-web', score: 63, grade: 'D' },
      ],
    },
    goalsInFlight: [
      {
        goalId: 'goal-001',
        objective: 'Ship the billing rework',
        status: 'active',
        fractionDone: 0.4,
        proposed: 2,
        totalMilestones: 5,
        nextActionable: 'Wire Stripe webhooks',
      },
    ],
    backlogTop: [
      { title: 'Fix flaky auth test', repo: '/Users/x/projects/alpha-svc', score: 91 },
      { title: 'Upgrade Node 22', repo: null, score: 70 },
    ],
    cost: {
      window: '7d',
      spentUsd: 1.23,
      localSavingsUsd: 4.56,
      projectedMonthlyUsd: 5.27,
    },
    effectiveness: {
      successRate: 0.86,
      effectivenessDeltaPct: 3.2,
      headline: 'Success rate 86% (+3.2pp week-over-week)',
    },
    today: {
      previousAt: '2026-06-09T00:00:00.000Z',
      pendingProposalsDelta: 1,
      dirtyReposDelta: -2,
      spendUsdDelta: 0.5,
      healthScoreDelta: 4,
      goalsInFlightDelta: 0,
    },
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    generatedAt: '2026-06-10T10:00:00.000Z',
    repos: { total: 12, dirty: 3, stale: 2 },
    tools: { installed: 5, total: 10 },
    activity: { sessions: 8, tokens: 42000, estCostUsd: 1.23, commits: 15 },
    runs: [],
    swarms: [],
    mcp: [],
    genome: { entries: 42, projects: 7 },
    inbox: { pending: 1 },
    portfolio: makePortfolio(),
    ...overrides,
  };
}

const PORTFOLIO_STATE = {
  tab: 'portfolio' as TuiTab,
  selected: 0,
  cols: 120,
  rows: 40,
};

function visibleFrame(snap: DashboardSnapshot, state = PORTFOLIO_STATE): string {
  return stripAnsi(renderFrame(snap, state));
}

// ===========================================================================
// TUI: portfolio tab renders the seeded summary
// ===========================================================================

describe('M29 TUI — portfolio tab renders the seeded summary', () => {
  it('renders health summary (scored count + grade)', () => {
    const frame = visibleFrame(makeSnapshot());
    expect(frame).toContain('Portfolio');
    expect(frame).toContain('Health');
    // reposScored:4, averageScore rounds to 82
    expect(frame).toContain('4');
    expect(frame).toContain('82');
  });

  it('renders the worst-repo handles (basename + grade)', () => {
    const frame = visibleFrame(makeSnapshot());
    // Repo labels are basename-only handles.
    expect(frame).toContain('alpha-svc');
    expect(frame).toContain('beta-web');
  });

  it('renders in-flight goals with objective, percent, and next action', () => {
    const frame = visibleFrame(makeSnapshot());
    expect(frame).toContain('Goals in flight');
    expect(frame).toContain('Ship the billing rework');
    expect(frame).toContain('40%');
    expect(frame).toContain('Wire Stripe webhooks');
  });

  it('renders the top backlog items', () => {
    const frame = visibleFrame(makeSnapshot());
    expect(frame).toContain('Top backlog');
    expect(frame).toContain('Fix flaky auth test');
    expect(frame).toContain('Upgrade Node 22');
  });

  it('renders cost + forecast figures', () => {
    const frame = visibleFrame(makeSnapshot());
    expect(frame).toContain('Cost');
    expect(frame).toContain('$1.23');   // spent
    expect(frame).toContain('$4.56');   // local savings
    expect(frame).toContain('$5.27');   // projected monthly
  });

  it('renders the effectiveness headline', () => {
    const frame = visibleFrame(makeSnapshot());
    expect(frame).toContain('Effectiveness');
    expect(frame).toContain('86%');
  });

  it('renders the "today" day-over-day deltas', () => {
    const frame = visibleFrame(makeSnapshot());
    expect(frame).toContain('Today');
    // Signed deltas appear: pending +1, dirty -2, spend +$0.50, health +4.
    expect(frame).toContain('+1');
    expect(frame).toContain('-2');
    expect(frame).toContain('+4');
  });

  it('shows "no prior digest" when today.previousAt is null', () => {
    const snap = makeSnapshot({
      portfolio: makePortfolio({
        today: {
          previousAt: null,
          pendingProposalsDelta: null,
          dirtyReposDelta: null,
          spendUsdDelta: null,
          healthScoreDelta: null,
          goalsInFlightDelta: null,
        },
      }),
    });
    const frame = visibleFrame(snap);
    expect(frame.toLowerCase()).toContain('no prior digest');
  });

  it('shows "no enrolled repos scored" when health is empty (enrollment-scoped)', () => {
    const snap = makeSnapshot({
      portfolio: makePortfolio({
        health: { reposScored: 0, averageScore: 0, averageGrade: 'F', worstRepos: [] },
      }),
    });
    const frame = visibleFrame(snap);
    expect(frame.toLowerCase()).toContain('no enrolled repos scored');
  });
});

// ===========================================================================
// TUI: pure / width-bounded / never-throws (degrades when portfolio absent)
// ===========================================================================

describe('M29 TUI — portfolio tab is pure, bounded, and never throws', () => {
  it('is deterministic (same inputs → identical frame)', () => {
    const snap = makeSnapshot();
    expect(renderFrame(snap, PORTFOLIO_STATE)).toBe(renderFrame(snap, PORTFOLIO_STATE));
  });

  it('does not mutate the snapshot', () => {
    const snap = makeSnapshot();
    const before = JSON.stringify(snap);
    renderFrame(snap, PORTFOLIO_STATE);
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('does NOT throw when snap.portfolio is undefined (older producer)', () => {
    const snap = makeSnapshot({ portfolio: undefined });
    expect(() => renderFrame(snap, PORTFOLIO_STATE)).not.toThrow();
  });

  it('degrades to a "no portfolio data" line when snap.portfolio is undefined', () => {
    const snap = makeSnapshot({ portfolio: undefined });
    const frame = visibleFrame(snap);
    expect(frame.toLowerCase()).toContain('no portfolio data');
  });

  it('does not throw at any width 1..200 on the portfolio tab', () => {
    const snap = makeSnapshot();
    for (let cols = 1; cols <= 200; cols++) {
      expect(() =>
        renderFrame(snap, { ...PORTFOLIO_STATE, cols, rows: 40 }),
      ).not.toThrow();
    }
  });

  it('no visible line exceeds the supplied cols width', () => {
    for (const cols of [40, 80, 120, 200]) {
      const frame = renderFrame(makeSnapshot(), { ...PORTFOLIO_STATE, cols, rows: 40 });
      for (const line of stripAnsi(frame).split('\n')) {
        expect(line.length).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('does not throw with undefined portfolio at a very narrow width', () => {
    const snap = makeSnapshot({ portfolio: undefined });
    expect(() => renderFrame(snap, { ...PORTFOLIO_STATE, cols: 20, rows: 10 })).not.toThrow();
  });
});

// ===========================================================================
// Web API: GET /api/portfolio
// ===========================================================================

const MOCK_PORTFOLIO = makePortfolio();

const MOCK_SNAPSHOT_WITH_PORTFOLIO = {
  generatedAt: '2026-06-10T00:00:00.000Z',
  repos: { total: 3, dirty: 1, stale: 0 },
  tools: { installed: 2, total: 4 },
  activity: { sessions: 5, tokens: 20000, estCostUsd: 0.42, commits: 11 },
  runs: [],
  swarms: [],
  mcp: [{ name: 'ashlr', ok: true, tools: 12 }],
  genome: { entries: 42, projects: 7 },
  inbox: { pending: 1 },
  portfolio: MOCK_PORTFOLIO,
};

vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: vi.fn(async () => MOCK_SNAPSHOT_WITH_PORTFOLIO),
}));
vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => []),
  loadRun: vi.fn(() => null),
  runGoal: vi.fn(async () => ({ id: 'x', status: 'done' })),
}));
vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: vi.fn(() => []),
  loadSwarm: vi.fn(() => null),
}));
vi.mock('../src/core/observability/rollup.js', () => ({
  buildRollup: vi.fn(() => ({ window: '7d', since: '', totals: {}, byProject: [], byDay: [], byModel: [], budget: {} })),
}));
vi.mock('../src/core/genome/store.js', () => ({
  loadGenome: vi.fn(() => []),
  genomeHealth: vi.fn(async () => ({})),
}));
vi.mock('../src/core/genome/recall.js', () => ({
  recall: vi.fn(async () => []),
}));
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: vi.fn(() => []),
}));
vi.mock('../src/core/daemon/state.js', () => ({
  loadDaemonState: vi.fn(() => ({ running: false })),
}));

import { startServer } from '../src/core/web/server.js';

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  } as unknown as AshlrConfig;
}

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: false, ...overrides } as WebServerOptions;
}

function request(
  method: string,
  url: string,
  port: number,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: data,
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let openHandles: Array<{ close(): Promise<void> }> = [];
beforeEach(() => { openHandles = []; });
afterEach(async () => {
  for (const h of openHandles) { try { await h.close(); } catch { /* ignore */ } }
  openHandles = [];
});

describe('M29 web API — GET /api/portfolio', () => {
  it('returns 200 application/json', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/portfolio`, h.port);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
  });

  it('payload includes the portfolio section with all sub-fields', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/portfolio`, h.port);
    const body = JSON.parse(res.body);
    expect(body).not.toBeNull();
    expect(typeof body.health).toBe('object');
    expect(body.health.reposScored).toBe(4);
    expect(Array.isArray(body.goalsInFlight)).toBe(true);
    expect(body.goalsInFlight[0].objective).toBe('Ship the billing rework');
    expect(Array.isArray(body.backlogTop)).toBe(true);
    expect(typeof body.cost).toBe('object');
    expect(body.cost.window).toBe('7d');
    expect(typeof body.today).toBe('object');
  });

  it('the /api/snapshot payload also carries the portfolio section', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/snapshot`, h.port);
    const body = JSON.parse(res.body);
    expect(typeof body.portfolio).toBe('object');
    expect(body.portfolio.health.averageGrade).toBe('B');
  });

  it('returns the metadata-only payload without the session token', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/portfolio`, h.port);
    expect(res.body).not.toContain(h.token);
  });
});

// ===========================================================================
// SAFETY: the surfacing layer added NO write/mutation path
// ===========================================================================

describe('M29 safety — portfolio surface is read-only (no mutation path)', () => {
  it('GET /api/portfolio needs no token and works with allowDispatch:false', async () => {
    const h = await startServer(makeConfig(), makeOpts({ allowDispatch: false }));
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/portfolio`, h.port);
    // A pure read — nothing to authorize, succeeds with no token.
    expect(res.statusCode).toBe(200);
  });

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
    it(`${method} /api/portfolio is NOT accepted (no mutation endpoint)`, async () => {
      // Even with dispatch enabled, /api/portfolio has no write verb — it is a
      // GET-only read projection. A mutating verb must not be handled.
      const h = await startServer(makeConfig(), makeOpts({ allowDispatch: true }));
      openHandles.push(h);
      const res = await request(method, `${h.url}/api/portfolio`, h.port);
      expect(res.statusCode).toBe(404);
    });
  }

  it('api.ts portfolio route contains no mutation call (static check)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/core/web/api.ts'), 'utf8');
    // Isolate the portfolio route block.
    const idx = src.indexOf("path === '/api/portfolio'");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 500);
    // The route only reads the shared snapshot projection and serialises .portfolio.
    expect(block).toContain('buildCachedSnapshot');
    expect(block).toContain('.portfolio');
    // No proposal/config/PR/deploy mutation primitives in the route.
    for (const banned of [
      'saveConfig', 'applyProposal', 'setStatus', 'createProposal',
      'createPr', 'runGoal', 'writeFileSync',
    ]) {
      expect(block).not.toContain(banned);
    }
  });

  it('the served dashboard exposes no mutation control for the portfolio view', () => {
    const appJs = readFileSync(join(REPO_ROOT, 'src/core/web/public/app.js'), 'utf8');
    const idx = appJs.indexOf('function renderPortfolio(');
    expect(idx).toBeGreaterThan(-1);
    // Bound the scan to renderPortfolio ITSELF (up to the next top-level
    // function declaration) — M32 added unrelated views between it and
    // fmtDelta; the invariant is about the portfolio renderer's own body.
    const end = appJs.indexOf('\nfunction ', idx + 1);
    const block = appJs.slice(idx, end > idx ? end : idx + 4000);
    // The portfolio renderer only reads state.portfolio + builds read-only DOM.
    // It must not POST, fetch a mutation, or bind approve/apply/dispatch actions.
    for (const banned of ["method: 'POST'", "'/api/run'", 'approve', 'dispatch', 'apply']) {
      expect(block).not.toContain(banned);
    }
  });

  it('app.js never POSTs to /api/portfolio anywhere', () => {
    const appJs = readFileSync(join(REPO_ROOT, 'src/core/web/public/app.js'), 'utf8');
    expect(appJs).not.toContain("'POST', '/api/portfolio'");
    expect(appJs).not.toMatch(/\/api\/portfolio['"][^)]*POST/);
  });
});
