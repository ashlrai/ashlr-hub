/**
 * M169 — expanded MCP native tool surface (elite fleet state).
 *
 * Tests:
 *  1. Each new tool (ashlr_north_star, ashlr_self_heal, ashlr_racing,
 *     ashlr_comms) is registered with safety:'read'.
 *  2. Contract count: total native tools is now 21.
 *  3. Each tool returns structured data when its module resolves (mock).
 *  4. Each tool returns a graceful "unavailable" stub when its module throws.
 *  5. ashlr_comms never leaks bot token / handle in output (secret-scrub).
 *  6. All tools are read-only (safety:'read').
 *  7. Existing M129/M131 tools are unchanged.
 *
 * Hermetic: every test runs under an isolated tmp HOME (h1-fixture); no real
 * ~/.ashlr is ever touched, no network, no downstream MCP servers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before subject imports
// ---------------------------------------------------------------------------

// Inbox store (pulled in by mcp-native for ashlr_inbox_list / ashlr_routing)
const mockListProposals = vi.fn(() => []);
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
  loadProposal: vi.fn(() => null),
  setStatus: vi.fn(),
  pendingCount: vi.fn(() => 0),
}));

// Decisions ledger (pulled in by ashlr_routing)
const mockReadDecisions = vi.fn(() => []);
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
}));

// Daemon state (fleet_status)
vi.mock('../src/core/daemon/state.js', () => ({
  loadDaemonState: vi.fn(() => ({
    running: false, pid: null, startedAt: null, lastTickAt: null,
    todaySpentUsd: 0, itemsProcessed: 0, ticks: [],
  })),
}));

// Fleet digest
vi.mock('../src/core/fleet/digest.js', () => ({
  buildFleetDigest: vi.fn(async () => ({
    totalPending: 0, totalProposed: 0, totalAutoMerged: 0, totalDeclined: 0, repos: [],
  })),
}));

// Quality metrics (scorecard + north-star depends on this)
vi.mock('../src/core/fleet/quality-metrics.js', () => ({
  computeQualityMetrics: vi.fn(() => ({
    window: '7d', proposalsCreated: 3, merged: 2, acceptRate: 0.67,
    trivialRatio: 0.1, emptyRate: 0.05, avgDiffLines: 42,
    byEngine: {}, byRepo: {},
  })),
}));

// Oversight export
vi.mock('../src/core/fleet/oversight-export.js', () => ({
  buildOversightSnapshot: vi.fn(() => ({
    generatedAt: new Date().toISOString(),
    scorecard: {}, goals: { active: 0, done: 0, progressPct: 0 },
    manager: null, vision: null,
  })),
}));

// Config
vi.mock('../src/core/config.js', () => ({
  loadConfig: vi.fn(() => ({
    user: { id: 'test' }, pulse: {}, enrolledRepos: [],
    comms: { enabled: true, channel: 'imessage' },
  })),
}));

// Sandbox policy
const mockListEnrolled = vi.fn(() => ['/repo/a', '/repo/b']);
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => false,
  isEnrolled: () => false,
  listEnrolled: (...args: unknown[]) => mockListEnrolled(...args),
  assertMayMutate: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  enrollmentPath: () => '/tmp/e.json',
  killSwitchPath: () => '/tmp/KILL',
}));

// M169 backing modules — default to "happy path" mocks; tests override for error paths
const mockComputeNorthStar = vi.fn();
const mockNorthStarSummary = vi.fn();
vi.mock('../src/core/vision/north-star.js', () => ({
  computeNorthStar: (...args: unknown[]) => mockComputeNorthStar(...args),
  northStarSummary: (...args: unknown[]) => mockNorthStarSummary(...args),
  LEVERAGE_SCORE_GOOD: 70,
  LEVERAGE_SCORE_POOR: 30,
}));

const mockRacingStats = vi.fn();
vi.mock('../src/core/fleet/model-racing.js', () => ({
  racingStats: (...args: unknown[]) => mockRacingStats(...args),
  raceTask: vi.fn(async () => ({ localScore: 0, frontierScore: 0, winner: 'tie', scoreDelta: 0 })),
}));

const mockListRequests = vi.fn(() => []);
const mockOutstanding = vi.fn(() => undefined);
vi.mock('../src/core/comms/requests.js', () => ({
  listRequests: (...args: unknown[]) => mockListRequests(...args),
  outstanding: (...args: unknown[]) => mockOutstanding(...args),
  postRequest: vi.fn(() => 'req-id'),
  markSent: vi.fn(),
  resolveRequest: vi.fn(),
}));

// Import AFTER mocks are registered.
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { nativeToolDefs, callNativeTool } from '../src/core/mcp-native.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  mockListProposals.mockReset().mockReturnValue([]);
  mockReadDecisions.mockReset().mockReturnValue([]);
  mockComputeNorthStar.mockReset().mockReturnValue({
    substantiveMerges7d: 5,
    engHoursSaved7d: 7.5,
    leverageScore: 72,
    trend: 'up',
    computedAt: '2026-06-28T00:00:00.000Z',
    raw: { merged: 6, trivialRatio: 0.17, acceptRate: 0.67, emptyRate: 0.05, avgDiffLines: 42, proposalsCreated: 9 },
  });
  mockNorthStarSummary.mockReset().mockReturnValue('=== NORTH-STAR: HUMAN LEVERAGE (7d) ===\nLeverage score: 72/100');
  mockRacingStats.mockReset().mockReturnValue({ races: 10, frontierWinRate: 0.6, avgScoreDelta: 1.5, localWins: 3 });
  mockListRequests.mockReset().mockReturnValue([{ id: 'r1', status: 'pending' }]);
  mockOutstanding.mockReset().mockReturnValue(undefined);
  mockListEnrolled.mockReset().mockReturnValue(['/repo/a', '/repo/b']);
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resultText(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

function resultJson(r: { content: { type: 'text'; text: string }[] }): unknown {
  return JSON.parse(resultText(r));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe('M169 native tool registration', () => {
  it('total native tool count is now 21', () => {
    expect(nativeToolDefs()).toHaveLength(21);
  });

  const newTools = ['ashlr_north_star', 'ashlr_self_heal', 'ashlr_racing', 'ashlr_comms'];

  for (const name of newTools) {
    it(`${name} is registered as safety:'read'`, () => {
      const def = nativeToolDefs().find((t) => t.name === name);
      expect(def).toBeTruthy();
      expect(def!.safety).toBe('read');
    });
  }
});

// ---------------------------------------------------------------------------
// ashlr_north_star
// ---------------------------------------------------------------------------

describe('ashlr_north_star', () => {
  it('returns structured data when module resolves', async () => {
    const r = await callNativeTool('ashlr_north_star', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['substantiveMerges7d']).toBe('number');
    expect(payload['substantiveMerges7d']).toBe(5);
    expect(typeof payload['engHoursSaved7d']).toBe('number');
    expect(payload['engHoursSaved7d']).toBe(7.5);
    expect(typeof payload['leverageScore']).toBe('number');
    expect(payload['leverageScore']).toBe(72);
    expect(payload['trend']).toBe('up');
    expect(typeof payload['computedAt']).toBe('string');
    expect(typeof payload['summary']).toBe('string');
    expect(payload['summary']).toContain('NORTH-STAR');
    expect(typeof payload['raw']).toBe('object');
  });

  it('returns graceful unavailable stub when module throws', async () => {
    mockComputeNorthStar.mockImplementation(() => { throw new Error('north-star unavailable'); });

    const r = await callNativeTool('ashlr_north_star', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(payload['leverageScore']).toBe(0);
    expect(payload['trend']).toBe('flat');
    expect(payload['_unavailable']).toBe(true);
    expect((payload['summary'] as string)).toContain('unavailable');
  });

  it('never throws', async () => {
    mockComputeNorthStar.mockImplementation(() => { throw new Error('fatal'); });
    const r = await callNativeTool('ashlr_north_star', {});
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ashlr_self_heal
// ---------------------------------------------------------------------------

describe('ashlr_self_heal', () => {
  it('returns structured data on empty queue', async () => {
    const r = await callNativeTool('ashlr_self_heal', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['enabled']).toBe('boolean');
    expect(typeof payload['enrolledRepos']).toBe('number');
    expect(typeof payload['queuedHealItems']).toBe('number');
    expect(Array.isArray(payload['healQueue'])).toBe(true);
  });

  it('reports enrolled repo count from policy', async () => {
    const r = await callNativeTool('ashlr_self_heal', {});
    const payload = resultJson(r) as Record<string, unknown>;
    // listEnrolled mock returns ['/repo/a', '/repo/b'] = 2
    expect(payload['enrolledRepos']).toBe(2);
  });

  it('returns graceful stub when underlying I/O throws', async () => {
    // Force listEnrolled to throw — the handler's inner guard catches it and
    // returns [], so the outer try/catch never fires and the tool still returns ok.
    mockListEnrolled.mockImplementationOnce(() => { throw new Error('policy error'); });

    const r = await callNativeTool('ashlr_self_heal', {});
    // Even if listEnrolled throws, the handler degrades gracefully
    expect(r.isError).toBeUndefined();
  });

  it('never throws', async () => {
    const r = await callNativeTool('ashlr_self_heal', {});
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ashlr_racing
// ---------------------------------------------------------------------------

describe('ashlr_racing', () => {
  it('returns structured data when module resolves', async () => {
    const r = await callNativeTool('ashlr_racing', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['races']).toBe('number');
    expect(payload['races']).toBe(10);
    expect(typeof payload['frontierWinRate']).toBe('number');
    expect(payload['frontierWinRate']).toBe(0.6);
    expect(typeof payload['avgScoreDelta']).toBe('number');
    expect(payload['avgScoreDelta']).toBe(1.5);
    expect(typeof payload['localWins']).toBe('number');
    expect(payload['localWins']).toBe(3);
  });

  it('returns graceful unavailable stub when racingStats throws', async () => {
    mockRacingStats.mockImplementation(() => { throw new Error('racing dir missing'); });

    const r = await callNativeTool('ashlr_racing', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(payload['races']).toBe(0);
    expect(payload['frontierWinRate']).toBe(0);
    expect(payload['avgScoreDelta']).toBe(0);
    expect(payload['_unavailable']).toBe(true);
  });

  it('returns zeroed stats on empty racing dir (no races yet)', async () => {
    mockRacingStats.mockReturnValue({ races: 0, frontierWinRate: 0, avgScoreDelta: 0, localWins: 0 });

    const r = await callNativeTool('ashlr_racing', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(payload['races']).toBe(0);
    expect(payload['_unavailable']).toBeUndefined();
  });

  it('never throws', async () => {
    mockRacingStats.mockImplementation(() => { throw new Error('fatal'); });
    const r = await callNativeTool('ashlr_racing', {});
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ashlr_comms
// ---------------------------------------------------------------------------

describe('ashlr_comms', () => {
  it('returns structured data when module resolves', async () => {
    mockListRequests.mockReturnValue([{ id: 'r1', status: 'pending' }, { id: 'r2', status: 'pending' }]);

    const r = await callNativeTool('ashlr_comms', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['enabled']).toBe('boolean');
    expect(typeof payload['channel']).toBe('string');
    expect(typeof payload['pendingRequests']).toBe('number');
    expect(typeof payload['hasOutstanding']).toBe('boolean');
  });

  it('reports pending count correctly', async () => {
    mockListRequests.mockReturnValue([
      { id: 'r1', status: 'pending' },
      { id: 'r2', status: 'pending' },
      { id: 'r3', status: 'pending' },
    ]);

    const r = await callNativeTool('ashlr_comms', {});
    const payload = resultJson(r) as Record<string, unknown>;
    expect(payload['pendingRequests']).toBe(3);
  });

  it('reports hasOutstanding: true when outstanding() returns a request', async () => {
    mockOutstanding.mockReturnValue({
      id: 'req-out',
      kind: 'merge-gate',
      type: 'approval',
      status: 'sent',
      text: 'Merge this?',
      options: ['yes', 'no'],
      createdAt: new Date().toISOString(),
    });

    const r = await callNativeTool('ashlr_comms', {});
    const payload = resultJson(r) as Record<string, unknown>;
    expect(payload['hasOutstanding']).toBe(true);
    expect(payload['outstandingKind']).toBe('merge-gate');
    expect(payload['outstandingType']).toBe('approval');
  });

  it('hasOutstanding: false when no outstanding request', async () => {
    mockOutstanding.mockReturnValue(undefined);

    const r = await callNativeTool('ashlr_comms', {});
    const payload = resultJson(r) as Record<string, unknown>;
    expect(payload['hasOutstanding']).toBe(false);
    expect(payload['outstandingKind']).toBeNull();
  });

  it('NEVER exposes bot token or imessageHandle in output', async () => {
    // Inject a fake token into cfg via the loadConfig mock
    const { loadConfig } = await import('../src/core/config.js');
    vi.mocked(loadConfig).mockReturnValueOnce({
      user: { id: 'test' },
      pulse: {},
      enrolledRepos: [],
      comms: {
        enabled: true,
        channel: 'telegram',
        // @ts-expect-error — injecting secret for scrub test
        botToken: 'super-secret-bot-token-abc123',
        imessageHandle: '+1-555-SECRET',
      },
    });

    const r = await callNativeTool('ashlr_comms', {});
    const text = resultText(r);
    expect(text).not.toContain('super-secret-bot-token-abc123');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('botToken');
  });

  it('returns graceful stub when listRequests throws', async () => {
    mockListRequests.mockImplementation(() => { throw new Error('comms store error'); });

    const r = await callNativeTool('ashlr_comms', {});
    // The handler catches the per-field try/catch; tool still returns ok
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['enabled']).toBe('boolean');
    expect(payload['pendingRequests']).toBe(0);
  });

  it('returns full unavailable stub when the import itself throws', async () => {
    // Simulate the entire comms/requests module being unimportable
    // by mocking outstanding to throw (the handler catches the outer try/catch)
    mockOutstanding.mockImplementation(() => { throw new Error('transport down'); });
    mockListRequests.mockImplementation(() => { throw new Error('transport down'); });

    const r = await callNativeTool('ashlr_comms', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    // The outer try/catch catches this and returns the stub
    expect(payload['pendingRequests']).toBe(0);
  });

  it('never throws', async () => {
    mockListRequests.mockImplementation(() => { throw new Error('fatal'); });
    mockOutstanding.mockImplementation(() => { throw new Error('fatal'); });
    const r = await callNativeTool('ashlr_comms', {});
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Existing M129/M131 tools unchanged
// ---------------------------------------------------------------------------

describe('existing M129/M131 tools still present and read-only', () => {
  const m129Tools = ['ashlr_fleet_status', 'ashlr_scorecard', 'ashlr_oversight', 'ashlr_routing'];

  for (const name of m129Tools) {
    it(`${name} still registered as safety:'read'`, () => {
      const def = nativeToolDefs().find((t) => t.name === name);
      expect(def).toBeTruthy();
      expect(def!.safety).toBe('read');
    });
  }

  it('ashlr_fleet_status still returns expected shape', async () => {
    const r = await callNativeTool('ashlr_fleet_status', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['running']).toBe('boolean');
    expect(typeof payload['pendingProposals']).toBe('number');
  });

  it('ashlr_scorecard still returns QualityMetrics shape', async () => {
    const r = await callNativeTool('ashlr_scorecard', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['window']).toBe('string');
    expect(typeof payload['proposalsCreated']).toBe('number');
  });

  it('ashlr_routing still returns { recent, modelSplit }', async () => {
    const r = await callNativeTool('ashlr_routing', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(Array.isArray(payload['recent'])).toBe(true);
    expect(typeof payload['modelSplit']).toBe('object');
  });

  it('ashlr_oversight still returns OversightSnapshot shape', async () => {
    const r = await callNativeTool('ashlr_oversight', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['generatedAt']).toBe('string');
    expect('goals' in payload).toBe(true);
  });
});
