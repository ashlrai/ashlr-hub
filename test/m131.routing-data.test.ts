/**
 * M131 — real routing data derived from proposal records.
 *
 * Tests:
 *  1. deriveRoutingData() produces correct {ts,repo,task,engine,model} rows
 *     from proposals with varied engineModel strings.
 *  2. modelSplit counts correctly per engine:model key.
 *  3. Decisions-ledger entries with a reason are merged (de-duped by ts).
 *  4. Bounded to `limit`; never throws on empty / malformed engineModel.
 *  5. ashlr_routing tool returns { recent, modelSplit } shape.
 *  6. GET /api/fleet-state routing section has { recent, modelSplit }.
 *
 * Hermetic: isolated tmp HOME via h1-fixture; inbox/store + decisions-ledger
 * are vi.mock'd so no real files are touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any subject imports
// ---------------------------------------------------------------------------

const mockListProposals = vi.fn(() => []);
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
  loadProposal: vi.fn(() => null),
  setStatus: vi.fn(),
  pendingCount: vi.fn(() => 0),
}));

const mockReadDecisions = vi.fn(() => []);
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
}));

// Lightweight stubs for modules pulled in transitively by mcp-native / api.
vi.mock('../src/core/daemon/state.js', () => ({
  loadDaemonState: vi.fn(() => ({
    running: false, pid: null, startedAt: null, lastTickAt: null,
    todaySpentUsd: 0, itemsProcessed: 0, ticks: [],
  })),
}));
vi.mock('../src/core/fleet/digest.js', () => ({
  buildFleetDigest: vi.fn(async () => ({
    totalPending: 0, totalProposed: 0, totalAutoMerged: 0, totalDeclined: 0, repos: [],
  })),
}));
vi.mock('../src/core/fleet/quality-metrics.js', () => ({
  computeQualityMetrics: vi.fn(() => ({
    window: '7d', proposalsCreated: 0, merged: 0, acceptRate: 0, byEngine: {}, byRepo: {},
  })),
}));
vi.mock('../src/core/fleet/oversight-export.js', () => ({
  buildOversightSnapshot: vi.fn(() => ({
    generatedAt: new Date().toISOString(),
    scorecard: {}, goals: { active: 0, done: 0, progressPct: 0 },
    manager: null, vision: null,
  })),
}));
vi.mock('../src/core/config.js', () => ({
  loadConfig: vi.fn(() => ({
    user: { id: 'test' }, pulse: {}, enrolledRepos: [],
  })),
}));
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => false,
  isEnrolled: () => false,
  listEnrolled: () => [],
  assertMayMutate: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  enrollmentPath: () => '/tmp/e.json',
  killSwitchPath: () => '/tmp/KILL',
}));

// Import AFTER mocks are registered.
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { deriveRoutingData } from '../src/core/mcp-native.js';
import { callNativeTool } from '../src/core/mcp-native.js';
import { handleApi } from '../src/core/web/api.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  mockListProposals.mockReset();
  mockReadDecisions.mockReset();
  mockListProposals.mockReturnValue([]);
  mockReadDecisions.mockReturnValue([]);
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

/** Minimal Proposal stub with only the fields deriveRoutingData reads. */
function makeProposal(opts: {
  id: string;
  repo?: string | null;
  title?: string;
  engineModel?: string;
  createdAt?: string;
}) {
  return {
    id: opts.id,
    repo: opts.repo ?? '/repo/a',
    title: opts.title ?? `Task ${opts.id}`,
    engineModel: opts.engineModel,
    createdAt: opts.createdAt ?? `2026-06-26T0${opts.id}:00:00.000Z`,
    status: 'pending',
    origin: 'swarm',
    kind: 'patch',
    summary: '',
    owner: 'test',
    engineTier: 'frontier',
  };
}

// ---------------------------------------------------------------------------
// deriveRoutingData — row derivation
// ---------------------------------------------------------------------------

describe('deriveRoutingData — row derivation from proposals', () => {
  it('derives correct {ts,repo,task,engine,model} for codex:gpt-5.5', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', repo: '/repo/a', title: 'Fix auth bug', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T01:00:00.000Z' }),
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent).toHaveLength(1);
    const row = recent[0];
    expect(row.engine).toBe('codex');
    expect(row.model).toBe('gpt-5.5');
    expect(row.repo).toBe('/repo/a');
    expect(row.task).toBe('Fix auth bug');
    expect(row.ts).toBe('2026-06-26T01:00:00.000Z');
  });

  it('derives correct engine/model for local-coder:qwen2.5:72b-instruct-q4_K_M (colon in model name)', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '2', engineModel: 'local-coder:qwen2.5:72b-instruct-q4_K_M', createdAt: '2026-06-26T02:00:00.000Z' }),
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent[0].engine).toBe('local-coder');
    expect(recent[0].model).toBe('qwen2.5:72b-instruct-q4_K_M');
  });

  it('derives correct engine/model for claude:opus', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '3', engineModel: 'claude:opus', createdAt: '2026-06-26T03:00:00.000Z' }),
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent[0].engine).toBe('claude');
    expect(recent[0].model).toBe('opus');
  });

  it('sorts newest-first', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T01:00:00.000Z' }),
      makeProposal({ id: '3', engineModel: 'claude:opus', createdAt: '2026-06-26T03:00:00.000Z' }),
      makeProposal({ id: '2', engineModel: 'local-coder:qwen2.5', createdAt: '2026-06-26T02:00:00.000Z' }),
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent[0].ts).toBe('2026-06-26T03:00:00.000Z');
    expect(recent[1].ts).toBe('2026-06-26T02:00:00.000Z');
    expect(recent[2].ts).toBe('2026-06-26T01:00:00.000Z');
  });

  it('truncates task to 120 chars', () => {
    const longTitle = 'A'.repeat(200);
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', title: longTitle, engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T01:00:00.000Z' }),
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent[0].task.length).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// deriveRoutingData — modelSplit
// ---------------------------------------------------------------------------

describe('deriveRoutingData — modelSplit aggregate', () => {
  it('counts proposals per engine:model correctly', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T01:00:00.000Z' }),
      makeProposal({ id: '2', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T02:00:00.000Z' }),
      makeProposal({ id: '3', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T03:00:00.000Z' }),
      makeProposal({ id: '4', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T04:00:00.000Z' }),
      makeProposal({ id: '5', engineModel: 'local-coder:qwen2.5:72b-instruct-q4_K_M', createdAt: '2026-06-26T05:00:00.000Z' }),
      makeProposal({ id: '6', engineModel: 'local-coder:qwen2.5:72b-instruct-q4_K_M', createdAt: '2026-06-26T06:00:00.000Z' }),
      makeProposal({ id: '7', engineModel: 'claude:opus', createdAt: '2026-06-26T07:00:00.000Z' }),
    ]);

    const { modelSplit } = deriveRoutingData(50);
    expect(modelSplit['codex:gpt-5.5']).toBe(4);
    expect(modelSplit['local-coder:qwen2.5:72b-instruct-q4_K_M']).toBe(2);
    expect(modelSplit['claude:opus']).toBe(1);
  });

  it('modelSplit is empty object when no proposals', () => {
    mockListProposals.mockReturnValue([]);
    const { modelSplit } = deriveRoutingData(50);
    expect(Object.keys(modelSplit)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deriveRoutingData — merge decisions-ledger reasons
// ---------------------------------------------------------------------------

describe('deriveRoutingData — merges logged reasons from decisions-ledger', () => {
  it('adds decisions-ledger entries not covered by proposals', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T01:00:00.000Z' }),
    ]);
    mockReadDecisions.mockReturnValue([
      {
        ts: '2026-06-25T12:00:00.000Z', // different ts — not in proposals
        engine: 'nim:llama-3.1-405b',
        model: 'llama-3.1-405b',
        reason: 'cost-optimized route',
        proposalId: 'p-abc',
        action: 'route',
        verdict: 'ok',
      },
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent).toHaveLength(2);
    const ledgerRow = recent.find((r) => r.engine === 'nim');
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow!.reason).toBe('cost-optimized route');
  });

  it('de-dupes: decisions-ledger entry with same ts as a proposal is skipped', () => {
    const sharedTs = '2026-06-26T01:00:00.000Z';
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: 'codex:gpt-5.5', createdAt: sharedTs }),
    ]);
    mockReadDecisions.mockReturnValue([
      { ts: sharedTs, engine: 'codex', model: 'gpt-5.5', reason: 'duplicate', proposalId: 'p-1', action: 'route', verdict: 'ok' },
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent).toHaveLength(1); // de-duped
  });

  it('decisions-ledger entries without engine/model are ignored', () => {
    mockListProposals.mockReturnValue([]);
    mockReadDecisions.mockReturnValue([
      { ts: '2026-06-26T01:00:00.000Z', action: 'approve', verdict: 'ok' }, // no engine/model
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deriveRoutingData — edge cases
// ---------------------------------------------------------------------------

describe('deriveRoutingData — edge cases', () => {
  it('returns empty recent + empty modelSplit on no proposals', () => {
    mockListProposals.mockReturnValue([]);
    const result = deriveRoutingData(50);
    expect(result.recent).toHaveLength(0);
    expect(Object.keys(result.modelSplit)).toHaveLength(0);
  });

  it('never throws when listProposals throws', () => {
    mockListProposals.mockImplementation(() => { throw new Error('store unavailable'); });
    expect(() => deriveRoutingData(50)).not.toThrow();
    const result = deriveRoutingData(50);
    expect(Array.isArray(result.recent)).toBe(true);
  });

  it('skips proposals with missing engineModel', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: undefined, createdAt: '2026-06-26T01:00:00.000Z' }),
      makeProposal({ id: '2', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T02:00:00.000Z' }),
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent).toHaveLength(1);
    expect(recent[0].engine).toBe('codex');
  });

  it('skips proposals with empty string engineModel', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: '', createdAt: '2026-06-26T01:00:00.000Z' }),
    ]);

    const { recent } = deriveRoutingData(50);
    expect(recent).toHaveLength(0);
  });

  it('handles engineModel with no colon (engine only)', () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: 'builtin', createdAt: '2026-06-26T01:00:00.000Z' }),
    ]);

    const { recent, modelSplit } = deriveRoutingData(50);
    expect(recent[0].engine).toBe('builtin');
    expect(recent[0].model).toBe('');
    expect(modelSplit['builtin']).toBe(1);
  });

  it('bounds recent to limit', () => {
    const proposals = Array.from({ length: 80 }, (_, i) =>
      makeProposal({
        id: String(i).padStart(3, '0'),
        engineModel: 'codex:gpt-5.5',
        createdAt: `2026-06-26T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      }),
    );
    mockListProposals.mockReturnValue(proposals);

    const { recent } = deriveRoutingData(50);
    expect(recent.length).toBeLessThanOrEqual(50);
  });

  it('modelSplit counts UNBOUNDED (all proposals, not just limit)', () => {
    const proposals = Array.from({ length: 80 }, (_, i) =>
      makeProposal({
        id: String(i).padStart(3, '0'),
        engineModel: i < 60 ? 'local-coder:qwen2.5' : 'codex:gpt-5.5',
        createdAt: `2026-06-26T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      }),
    );
    mockListProposals.mockReturnValue(proposals);

    const { modelSplit } = deriveRoutingData(50); // limit 50, but 80 proposals
    expect(modelSplit['local-coder:qwen2.5']).toBe(60);
    expect(modelSplit['codex:gpt-5.5']).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// ashlr_routing tool
// ---------------------------------------------------------------------------

describe('ashlr_routing tool', () => {
  it('returns { recent, modelSplit } shape', async () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T01:00:00.000Z' }),
    ]);

    const r = await callNativeTool('ashlr_routing', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as { recent: unknown[]; modelSplit: Record<string, number> };
    expect(Array.isArray(payload.recent)).toBe(true);
    expect(typeof payload.modelSplit).toBe('object');
  });

  it('recent rows have correct shape', async () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', repo: '/repo/x', title: 'Fix login', engineModel: 'claude:opus', createdAt: '2026-06-26T01:00:00.000Z' }),
    ]);

    const r = await callNativeTool('ashlr_routing', {});
    const payload = resultJson(r) as { recent: Array<Record<string, unknown>>; modelSplit: Record<string, number> };
    const row = payload.recent[0];
    expect(row['engine']).toBe('claude');
    expect(row['model']).toBe('opus');
    expect(row['repo']).toBe('/repo/x');
    expect(row['task']).toBe('Fix login');
    expect(typeof row['ts']).toBe('string');
  });

  it('respects limit — recent.length <= limit', async () => {
    const proposals = Array.from({ length: 30 }, (_, i) =>
      makeProposal({ id: String(i), engineModel: 'codex:gpt-5.5', createdAt: `2026-06-26T${String(i % 24).padStart(2, '0')}:00:00.000Z` }),
    );
    mockListProposals.mockReturnValue(proposals);

    const r = await callNativeTool('ashlr_routing', { limit: 10 });
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as { recent: unknown[] };
    expect(payload.recent.length).toBeLessThanOrEqual(10);
  });

  it('never throws on empty stores', async () => {
    mockListProposals.mockReturnValue([]);
    const r = await callNativeTool('ashlr_routing', {});
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET /api/fleet-state routing section
// ---------------------------------------------------------------------------

describe('GET /api/fleet-state — routing section', () => {
  function makeReq(): IncomingMessage {
    return {
      url: '/api/fleet-state',
      method: 'GET',
      headers: {},
      on: () => undefined,
    } as unknown as IncomingMessage;
  }

  function makeRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
    let capturedStatus = 0;
    let capturedBody: unknown = null;
    const res = {
      headersSent: false,
      writeHead(status: number) { capturedStatus = status; },
      end(payload: string) {
        try { capturedBody = JSON.parse(payload); } catch { capturedBody = payload; }
      },
    } as unknown as ServerResponse;
    return { res, status: () => capturedStatus, body: () => capturedBody };
  }

  it('routing section has recent array and modelSplit object', async () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', engineModel: 'codex:gpt-5.5', createdAt: '2026-06-26T01:00:00.000Z' }),
    ]);

    const cfg = makeCfg();
    const { res, status, body } = makeRes();
    const handled = await handleApi(makeReq(), res, cfg, { token: 'test', allowDispatch: false });

    expect(handled).toBe(true);
    expect(status()).toBe(200);

    const payload = body() as Record<string, unknown>;
    expect('routing' in payload).toBe(true);
    const routing = payload['routing'] as { recent: unknown[]; modelSplit: Record<string, number> };
    expect(Array.isArray(routing.recent)).toBe(true);
    expect(typeof routing.modelSplit).toBe('object');
  });

  it('routing.recent contains row derived from proposal', async () => {
    mockListProposals.mockReturnValue([
      makeProposal({ id: '1', repo: '/repo/z', title: 'Refactor pipeline', engineModel: 'local-coder:qwen2.5:72b-instruct-q4_K_M', createdAt: '2026-06-26T05:00:00.000Z' }),
    ]);

    const cfg = makeCfg();
    const { res, body } = makeRes();
    await handleApi(makeReq(), res, cfg, { token: 'test', allowDispatch: false });

    const payload = body() as Record<string, unknown>;
    const routing = payload['routing'] as { recent: Array<Record<string, unknown>>; modelSplit: Record<string, number> };
    expect(routing.recent).toHaveLength(1);
    expect(routing.recent[0]['engine']).toBe('local-coder');
    expect(routing.recent[0]['model']).toBe('qwen2.5:72b-instruct-q4_K_M');
    expect(routing.modelSplit['local-coder:qwen2.5:72b-instruct-q4_K_M']).toBe(1);
  });

  it('routing degrades gracefully when both sources throw', async () => {
    mockListProposals.mockImplementation(() => { throw new Error('io error'); });
    mockReadDecisions.mockImplementation(() => { throw new Error('io error'); });

    const cfg = makeCfg();
    const { res, status, body } = makeRes();
    const handled = await handleApi(makeReq(), res, cfg, { token: 'test', allowDispatch: false });

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    const payload = body() as Record<string, unknown>;
    // routing section is present even on failure — degrade path
    expect('routing' in payload).toBe(true);
  });
});
