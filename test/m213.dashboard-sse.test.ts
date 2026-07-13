/**
 * M213 Dashboard SSE tests — hermetic, all data-source modules mocked.
 *
 * Verifies:
 *   1. GET /api/events is handled (handleApi returns true)
 *   2. SSE response Content-Type: text/event-stream
 *   3. Connection handshake comment ': connected\n\n' is written
 *   4. 'snapshot' named SSE event emitted on initial tick
 *   5. snapshot payload includes dispatchEnabled: false
 *   6. snapshot payload includes dispatchEnabled: true when allowDispatch=true
 *   7. Existing events still emitted: runs, swarms, inbox, daemon, fleet-activity-ping
 *   8. drainSseConnections() ends the SSE response
 *   9. POST /api/events returns 404 (not a valid mutation route)
 *  10. server.ts HOST_RE allowlist — loopback-only binding verified
 *  11. app.js snapshot SSE handler suppresses polling interval while SSE live
 *  12. app.js SSE error handler restores polling fallback
 *  13. app.js Fleet Dashboard wires the M262 visibility panel
 *  14. app.js Fleet Dashboard status panel renders readiness rail
 *  15. app.js inbox detail reads current proposal review fields
 *  16. SSE response has Cache-Control: no-cache + Connection: keep-alive
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

function makeConfig() {
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
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_INDEX = { version: 1, generatedAt: new Date().toISOString(), root: '/home', items: [] };
const FIXTURE_TOOLS_REGISTRY = { tools: [], installedCount: 0 };
const FIXTURE_ROLLUP = {
  window: '7d' as const,
  since: new Date(Date.now() - 7 * 86400000).toISOString(),
  totals: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: 0, commits: 0 },
  byProject: [], byDay: [], byModel: [],
  budget: {
    level: 'ok' as const, window: '7d', spentUsd: 0, capUsd: null,
    spentTokens: 0, capTokens: null, message: 'ok',
  },
};
const FIXTURE_DAEMON_STATE = {
  running: false, pid: null, startedAt: null, lastTickAt: null,
  todaySpentUsd: 0, itemsProcessed: 0, ticks: [],
  todayDate: new Date().toISOString().slice(0, 10),
};
const FIXTURE_FRONTIER_USAGE = { generatedAt: new Date().toISOString(), engines: [] };

// ---------------------------------------------------------------------------
// Module mocks (hoisted before dynamic imports)
// ---------------------------------------------------------------------------

vi.mock('../src/core/index-engine.js', () => ({ loadIndex: vi.fn(() => FIXTURE_INDEX) }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: vi.fn(() => FIXTURE_TOOLS_REGISTRY) }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: vi.fn(() => FIXTURE_ROLLUP) }));
vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => []),
  loadRun: vi.fn(() => null),
  runGoal: vi.fn(),
}));
vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: vi.fn(() => []),
  loadSwarm: vi.fn(() => null),
}));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: vi.fn(() => ({ servers: [] })) }));
vi.mock('../src/core/genome/store.js', () => ({ loadGenome: vi.fn(() => []) }));
vi.mock('../src/core/genome/recall.js', () => ({ recall: vi.fn(async () => []) }));
vi.mock('../src/core/inbox/store.js', () => ({
  pendingCount: vi.fn(() => 0),
  listProposals: vi.fn(() => []),
  loadProposal: vi.fn(() => null),
  setStatus: vi.fn(),
}));
vi.mock('../src/core/daemon/state.js', () => ({ loadDaemonState: vi.fn(() => FIXTURE_DAEMON_STATE) }));
vi.mock('../src/core/usage/frontier-usage.js', () => ({
  getFrontierUsageSync: vi.fn(() => FIXTURE_FRONTIER_USAGE),
}));
vi.mock('../src/core/fleet/status.js', () => ({ buildFleetStatus: vi.fn(async () => ({})) }));
vi.mock('../src/core/sandbox/policy.js', () => ({ listEnrolled: vi.fn(() => []) }));
vi.mock('../src/core/goals/store.js', () => ({ listGoals: vi.fn(() => []) }));
vi.mock('../src/core/goals/advance.js', () => ({
  progressOf: vi.fn(() => ({ fractionDone: 0, counts: {}, nextActionableId: null })),
}));
vi.mock('../src/cli/open.js', () => ({
  openInEditor: vi.fn(async () => ({ ok: true })),
  openInFinder: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: vi.fn(async () => ({
    generatedAt: new Date().toISOString(),
    repos: [],
    runs: [],
    swarms: [],
    pulse: null,
    genome: [],
    inbox: { pending: 0 },
    daemon: null,
    fleet: null,
    frontierUsage: null,
  })),
}));
vi.mock('../src/core/web/control.js', () => ({
  buildControlSnapshot: vi.fn(async () => ({})),
  buildFleetActivity: vi.fn(async () => ({})),
}));

// ---------------------------------------------------------------------------
// Fake IncomingMessage / ServerResponse helpers
// ---------------------------------------------------------------------------

function makeReq(urlPath = '/api/events', method = 'GET'): IncomingMessage {
  return {
    url: urlPath,
    method,
    headers: { host: '127.0.0.1' },
    on(_event: string, _cb: () => void) { return this; },
  } as unknown as IncomingMessage;
}

function makeSseRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  const chunks: string[] = [];
  let ended = false;

  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number, hdrs?: Record<string, string>) {
      statusCode = status;
      if (hdrs) Object.assign(headers, hdrs);
      (this as { headersSent: boolean }).headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      ended = true;
      (this as { writableEnded: boolean }).writableEnded = true;
    },
    _headers: () => headers,
    _status: () => statusCode,
    _chunks: () => chunks,
    _ended: () => ended,
  };
  return res as unknown as ServerResponse & {
    _headers: () => Record<string, string>;
    _status: () => number;
    _chunks: () => string[];
    _ended: () => boolean;
  };
}

function makeJsonRes() {
  let statusCode = 0;
  let body: unknown = null;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) { statusCode = status; },
    end(payload?: string) {
      try { body = JSON.parse(payload ?? ''); } catch { body = payload; }
    },
    _status: () => statusCode,
    _body: () => body,
  };
  return res as unknown as ServerResponse & { _status: () => number; _body: () => unknown };
}

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { handleApi, drainSseConnections } from '../src/core/web/api.js';
import { buildSnapshot } from '../src/core/dashboard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CTX = { token: 'test-token', allowDispatch: false } as const;

/**
 * Open an SSE connection and drain the initial emitUpdate() async work.
 *
 * Strategy: advance fake timers by 0ms. This flushes all pending microtasks
 * (including the async buildSnapshot Promise chain inside emitUpdate) without
 * firing the 1500ms poll interval — so we see exactly the initial-tick events.
 */
async function openSseAndDrainInitial(
  cfg = makeConfig(),
  ctx: { token: string; allowDispatch: boolean } = BASE_CTX,
) {
  vi.useFakeTimers();
  const req = makeReq('/api/events');
  const res = makeSseRes();
  await handleApi(req, res as unknown as ServerResponse, cfg as any, ctx);
  // Flush the async microtask chain from the initial emitUpdate() call.
  // buildSnapshot is async, so its continuation lands in the microtask queue.
  // Pump the queue several times to let the full async chain resolve before
  // checking chunks. We do NOT advance the timer to avoid triggering the
  // 1500ms poll interval.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { req, res };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M213 Dashboard SSE — /api/events', () => {
  afterEach(() => {
    drainSseConnections();
    vi.useRealTimers();
  });

  // ── 1. handleApi routes /api/events ──────────────────────────────────────

  it('handleApi returns true for GET /api/events', async () => {
    vi.useFakeTimers();
    const req = makeReq('/api/events');
    const res = makeSseRes();
    const handled = await handleApi(req, res as unknown as ServerResponse, makeConfig() as any, BASE_CTX);
    expect(handled).toBe(true);
  });

  // ── 2. SSE response Content-Type ─────────────────────────────────────────

  it('sets Content-Type: text/event-stream', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._headers()['Content-Type']).toBe('text/event-stream');
  });

  // ── 3. Connection handshake comment ──────────────────────────────────────

  it('writes the ": connected\\n\\n" handshake comment', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain(': connected\n\n');
  });

  // ── 4. snapshot named event emitted on initial tick ──────────────────────

  it('emits a "snapshot" named SSE event on the initial tick', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: snapshot\n');
  });

  // ── 5. snapshot payload: dispatchEnabled false ────────────────────────────

  it('snapshot payload carries dispatchEnabled: false when allowDispatch=false', async () => {
    const { res } = await openSseAndDrainInitial(makeConfig(), { token: 'tok', allowDispatch: false });
    const allChunks = res._chunks().join('');
    const match = allChunks.match(/event: snapshot\ndata: (\{.*?\})\n/s);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]);
    expect(payload.dispatchEnabled).toBe(false);
  });

  // ── 6. snapshot payload: dispatchEnabled true ─────────────────────────────

  it('snapshot payload carries dispatchEnabled: true when allowDispatch=true', async () => {
    const { res } = await openSseAndDrainInitial(makeConfig(), { token: 'tok', allowDispatch: true });
    const allChunks = res._chunks().join('');
    const match = allChunks.match(/event: snapshot\ndata: (\{.*?\})\n/s);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]);
    expect(payload.dispatchEnabled).toBe(true);
  });

  it('does not overlap full snapshot builds when an SSE update is still in flight', async () => {
    vi.useFakeTimers();
    const mockedBuildSnapshot = vi.mocked(buildSnapshot);
    mockedBuildSnapshot.mockClear();
    let resolveSnapshot!: (value: any) => void;
    mockedBuildSnapshot.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));

    const req = makeReq('/api/events');
    const res = makeSseRes();
    await handleApi(req, res as unknown as ServerResponse, makeConfig() as any, BASE_CTX);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockedBuildSnapshot).toHaveBeenCalledTimes(1);

    resolveSnapshot({ generatedAt: new Date().toISOString() });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    mockedBuildSnapshot.mockResolvedValue({ generatedAt: new Date().toISOString() } as any);
  });

  // ── 7a–e. Existing named events still emitted ────────────────────────────

  it('still emits "runs" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: runs\n');
  });

  it('still emits "swarms" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: swarms\n');
  });

  it('still emits "inbox" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: inbox\n');
  });

  it('still emits "daemon" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: daemon\n');
  });

  it('still emits "fleet-activity-ping" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: fleet-activity-ping\n');
  });

  // ── 8. drainSseConnections closes all connections ─────────────────────────

  it('drainSseConnections() ends the SSE response', async () => {
    vi.useFakeTimers();
    const req = makeReq('/api/events');
    const res = makeSseRes();
    await handleApi(req, res as unknown as ServerResponse, makeConfig() as any, BASE_CTX);
    expect(res._ended()).toBe(false);
    drainSseConnections();
    expect(res._ended()).toBe(true);
  });

  // ── 9. POST /api/events → 404 (not a mutation route) ─────────────────────

  it('POST /api/events returns 404 (handled=true, not a mutation route)', async () => {
    vi.useFakeTimers();
    const req = makeReq('/api/events', 'POST');
    const res = makeJsonRes();
    const handled = await handleApi(req, res as unknown as ServerResponse, makeConfig() as any, BASE_CTX);
    expect(handled).toBe(true);
    expect(res._status()).toBe(404);
  });

  // ── 10. server.ts binds to 127.0.0.1 only ────────────────────────────────

  it('server.ts binds exclusively to 127.0.0.1 (loopback only)', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/server.ts'),
      'utf8',
    );
    expect(src).toContain('HOST_RE');
    expect(src).toContain('127.0.0.1');
    expect(src).toContain('localhost');
    // The listen call must specify 127.0.0.1 as the bind address
    expect(src).toContain("server.listen(opts.port, '127.0.0.1'");
  });

  // ── 11. app.js: snapshot SSE handler suppresses polling interval ──────────

  it('app.js snapshot SSE handler clears fleetDashboardInterval when SSE is live', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain("es.addEventListener('snapshot'");
    expect(src).toContain('state.fleetDashboard = data');
    // The snapshot handler must clear the polling interval
    const snapshotHandlerMatch = src.match(/es\.addEventListener\('snapshot'[\s\S]*?\}\);/);
    expect(snapshotHandlerMatch).not.toBeNull();
    expect(snapshotHandlerMatch![0]).toContain('clearInterval');
    expect(snapshotHandlerMatch![0]).toContain('fleetDashboardInterval');
  });

  // ── 12. app.js: SSE error handler restores polling fallback ──────────────

  it('app.js SSE error handler restarts the polling fallback interval', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('SSE dropped — restart polling fallback');
    const errorHandlerMatch = src.match(/es\.addEventListener\('error'[\s\S]*?\}\);/);
    expect(errorHandlerMatch).not.toBeNull();
    expect(errorHandlerMatch![0]).toContain('fleetDashboardInterval');
    expect(errorHandlerMatch![0]).toContain('setInterval');
  });

  // ── 13. app.js: Fleet Dashboard includes visibility panel ────────────────

  it('app.js wires the M262 visibility panel into Fleet Dashboard settings and panelDefs', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('function fdRenderVisibilityPanel');
    expect(src).toContain("visibility: 'Visibility'");
    expect(src).toContain("key: 'visibility'");
    expect(src).toContain('snap.visibility');
  });

  it('app.js surfaces proposal production in Fleet, Mission Control, and Fleet Dashboard', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('function renderProposalProductionCard');
    expect(src).toContain('function renderDispatchProductionCard');
    expect(src).toContain('function renderAttemptCoverageCard');
    expect(src).toContain('function renderPhantomAgentReportCard');
    expect(src).toContain('function formatCountMap');
    expect(src).toContain('function dispatchProductionDiagnosticAttempts');
    expect(src).toContain('function generatedWorkMetric');
    expect(src).toContain('function diagnosticResliceDrainMetric');
    expect(src).toContain('function generatedRepairRecoveryMetric');
    expect(src).toContain('function fleetRepairRecoveryMetric');
    expect(src).toContain('generated-repair-recovery-active');
    expect(src).toContain('repair recovery -> learning');
    expect(src).toContain("'Repair Loop'");
    expect(src).toContain('fdMetricPill(\'Repair Loop\'');
    expect(src).toContain('Repair recovery');
    expect(src).toContain('captureRepairs');
    expect(src).toContain('diagnosticReslices');
    expect(src).toContain('function renderMissionBriefCard');
    expect(src).toContain('function renderNextActionCommand');
    expect(src).toContain('fleet-command-rail');
    expect(src).toContain('Next: ${compactFleetReason(actionDetail)}');
    expect(src).toContain('function formatAttemptShape');
    expect(src).toContain('gate/capture');
    expect(src).toContain('Dispatch yield data unavailable.');
    expect(src).toContain("renderMissionBriefCard(f.missionBrief, 'fleet-card card')");
    expect(src).toContain('renderMissionBriefCard(missionBrief)');
    expect(src).toContain('missionBrief');
    expect(src).toContain("renderProposalProductionCard(f.proposalProduction, 'fleet-card card')");
    expect(src).toContain('renderDispatchProductionCard(\n    f.dispatchProduction,\n    f.dispatchProductionSource,');
    expect(src).toContain('function dispatchProductionSourceText');
    expect(src).toContain("return !source || (source.sourceState === 'healthy' && source.complete === true)");
    expect(src).toContain("['Source', dispatchProductionSourceText(sourceQuality)]");
    expect(src).toContain("renderAttemptCoverageCard(f.attemptCoverage, 'fleet-card card')");
    expect(src).toContain("['Generated work', generatedWorkMetric(f.queue?.generatedWork) ?? '—']");
    expect(src).toContain("['Diagnostic drain', diagnosticResliceDrainMetric(f.queue?.diagnosticResliceDrain) ?? '—']");
    expect(src).toContain('renderProposalProductionCard(production)');
    expect(src).toContain('renderAttemptCoverageCard(attemptCoverage)');
    expect(src).toContain('renderPhantomAgentReportCard(f.phantom');
    expect(src).toContain('renderPhantomAgentReportCard(d.fleet?.phantom');
    expect(src).toContain('delegationSafety');
    expect(src).toContain("'Delegation unsafe'");
    expect(src).toContain("'Phantom delegation'");
    expect(src).toContain('attemptCoverage.causalCoverage');
    expect(src).toContain("'Attempt coverage'");
    expect(src).toContain("'Current labels'");
    expect(src).toContain("controlMetric('No-prop 24h'");
    expect(src).toContain('queue.generatedWork.total ?? 0');
    expect(src).toContain("controlMetric('Diag Drain'");
    expect(src).toContain("fdMetricPill('Generated'");
    expect(src).toContain("fdMetricPill('Diag Drain'");
    expect(src).toContain('production.diagnosticNoProposalDispatches ?? production.noProposalDispatches');
    expect(src).toContain("controlMetric(\n      'Yield 24h'");
    expect(src).toContain("snap.fleet?.proposalProduction ?? snap.control?.fleet?.proposalProduction");
    expect(src).toContain("snap.fleet?.dispatchProduction ?? snap.control?.fleet?.dispatchProduction");
    expect(src).toContain("snap.fleet?.dispatchProductionSource ?? snap.control?.fleet?.dispatchProductionSource");
    expect(src).toContain("snap.fleet?.attemptCoverage ?? snap.control?.fleet?.attemptCoverage");
    expect(src).toContain("'Proposal production'");
    expect(src).toContain("'Dispatch yield'");
    expect(src).toContain("['Suppressed', suppressed]");
    expect(src).toContain('backends.find((candidate) => dispatchProductionDiagnosticAttempts(candidate) > 0)');
  });

  it('app.js renders activity evidence without a misleading healthy zero', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('function daemonActivityDisplay');
    expect(src).toContain("return 'activity unavailable'");
    expect(src).toContain('activity.ownerState');
    expect(src).toContain('children active');
    expect(src).toContain('d.fleet?.daemon ?? fleet.daemon ?? daemon');
    expect(src).not.toContain("['Child work',");
    expect(src).not.toContain("'none observed'");
  });

  it('app.js surfaces aggregate-only trajectory learning in Mission Control and Fleet Dashboard', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );

    expect(src).toContain('function renderTrajectoryLearningCard');
    expect(src).toContain("const trajectoryLearning = d.fleet?.trajectoryLearning ?? fleet.trajectoryLearning ?? null");
    expect(src).toContain("const skillCorpusReadiness = d.fleet?.skillCorpusReadiness ?? fleet.skillCorpusReadiness ?? null");
    expect(src).toContain('renderTrajectoryLearningCard(trajectoryLearning, skillCorpusReadiness)');
    expect(src).toContain("trajectoryLearning ? 'Trajectory Learning' : 'Skill Learning'");
    expect(src).toContain("trajectoryLearning || skillCorpusReadiness");
    expect(src).toContain('snap.fleet?.trajectoryLearning ?? snap.control?.fleet?.trajectoryLearning');
    expect(src).toContain('snap.fleet?.skillCorpusReadiness ?? snap.control?.fleet?.skillCorpusReadiness');
    expect(src).toContain("['Trajectories', trajectoryLearning?.trajectories ?? 0]");
    expect(src).toContain("['Dispatch -> decision', formatCoverageMetric(routeSpine.dispatchToDecision)]");
    expect(src).toContain("['Dispatch -> evidence', formatCoverageMetric(routeSpine.dispatchToEvidence)]");
    expect(src).toContain("['Dispatch -> merge', formatCoverageMetric(routeSpine.dispatchToMerge)]");
    expect(src).toContain("['Merged', terminal.merged ?? 0]");
    expect(src).toContain("['No-proposal', terminal['no-proposal'] ?? 0]");
    expect(src).toContain("['Failed', terminal.failed ?? 0]");
    expect(src).toContain("['Top gap', formatTrajectoryLearningGap(trajectoryLearning)]");

    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rowsStart = src.indexOf('\nfunction trajectoryLearningRows', formatStart);
    const rendererEnd = src.indexOf('\nfunction formatCountMap', rowsStart);
    expect(formatStart).toBeGreaterThanOrEqual(0);
    expect(rowsStart).toBeGreaterThan(formatStart);
    expect(rendererEnd).toBeGreaterThan(rowsStart);

    const formatterSource = src.slice(formatStart, rowsStart);
    const formatter = new Function(`${formatterSource}\nreturn formatTrajectoryLearningGap;`)() as (
      trajectoryLearning: Record<string, any>,
    ) => string;
    const renderedGap = formatter({
      gaps: [
        { kind: 'repo:/private/ashlr', count: 99, sampleRefs: ['item-secret'] },
        { kind: 'evidence', count: 3, sampleRefs: ['trajectory:abc123', 'proposal-secret'] },
      ],
    });
    expect(renderedGap).toBe('Evidence 3 missing');
    expect(renderedGap).not.toContain('ashlr');
    expect(renderedGap).not.toContain('secret');
    expect(renderedGap).not.toContain('trajectory:');

    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    for (const identityField of ['sampleRefs', '.recent', '.ref', 'repo', 'itemId', 'proposalId', 'runId', 'trajectoryId']) {
      expect(trajectoryUiSource).not.toContain(identityField);
    }

    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({
      trajectories: 2,
      skillObservation: { sampleState: 'insufficient-sample' },
    }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);
    expect(values['Skill-observed trajectories']).toBe('withheld (<3)');
    expect(values['Observed selections']).toBe('withheld');
    expect(values['Observation join gaps']).toBe('withheld');
  });

  it('app.js renders categorical skill corpus readiness without exposing sub-k details', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rowsFor = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )((metric?: { count?: number }) => `coverage:${metric?.count ?? 0}`) as (
      trajectoryLearning: Record<string, any>,
      readiness?: Record<string, any>,
    ) => Array<[string, string | number]>;

    const readiness = {
      corpus: {
        state: 'ready',
        sourceQuality: { badge: 'healthy-source', detail: 'private corpus detail' },
      },
      eligibleSignedCards: 'available',
      selectedObservations: 'present',
      learning: {
        state: 'k-gated',
        minimumObservedTrajectories: 5,
        sampleState: 'insufficient-sample',
        observedTrajectoryCoverage: { count: 2, rate: 1 },
      },
      cardIds: ['skill-secret'],
      queryText: 'private query text',
    };
    const values = Object.fromEntries(rowsFor({
      trajectories: 2,
      skillObservation: { sampleState: 'insufficient-sample', joined: 2, unjoined: 1 },
    }, readiness));

    expect(values['Skill corpus']).toBe('ready');
    expect(values['Corpus source']).toBe('healthy');
    expect(values['Eligible cards']).toBe('available');
    expect(values['Skill observations']).toBe('present');
    expect(values['Learning gate']).toBe('sample gated');
    expect(values['Observation threshold']).toBe('5 trajectories');
    expect(values['Skill-observed trajectories']).toBe('withheld (<5)');
    expect(values['Observed selections']).toBe('withheld');
    expect(values['Observation join gaps']).toBe('withheld');
    expect(values).not.toHaveProperty('Observed coverage');
    expect(JSON.stringify(values)).not.toContain('private');
    expect(JSON.stringify(values)).not.toContain('skill-secret');

    const observed = Object.fromEntries(rowsFor({
      trajectories: 5,
      skillObservation: { sampleState: 'observed', joined: 5, unjoined: 0, conflicting: 0 },
    }, {
      ...readiness,
      learning: {
        ...readiness.learning,
        state: 'observable',
        sampleState: 'observed',
        observedTrajectoryCoverage: { count: 5, rate: 1 },
      },
    }));
    expect(observed['Learning gate']).toBe('observable');
    expect(observed['Observed coverage']).toBe('coverage:5');
  });

  it('app.js keeps legacy trajectory snapshots renderable without corpus readiness', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({ trajectories: 0 }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);

    expect(values.Trajectories).toBe(0);
    expect(values['Skill-observed trajectories']).toBe('withheld (<3)');
    expect(values).not.toHaveProperty('Skill corpus');
    expect(values).not.toHaveProperty('Observed coverage');
  });

  it('app.js renders a zero-observation sample as none rather than withheld', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({
      trajectories: 4,
      skillObservation: { sampleState: 'none' },
    }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);

    expect(values['Skill-observed trajectories']).toBe('none');
    expect(values['Observed selections']).toBe('none');
    expect(values['Observation join gaps']).toBe('not applicable');
  });

  it('app.js reports orphaned observation presence without exposing its count', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({
      trajectories: 4,
      skillObservation: { eventState: 'present', sampleState: 'none' },
    }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);

    expect(values['Observation sample']).toBe('no joined sample');
    expect(values['Observed selections']).toBe('present; counts withheld');
    expect(values['Observation join gaps']).toBe('present; counts withheld');
    expect(JSON.stringify(values)).not.toMatch(/orphan|conflict|\b[1-2]\b/);
  });

  it('app.js renders Fleet Dashboard readiness rail from existing fleet snapshots', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    expect(src).toContain('function fdRenderReadinessRail');
    expect(src).toContain('autonomousShipReadiness');
    expect(src).toContain('missionBrief');
    expect(src).toContain("'Fleet OS'");
    expect(src).toContain("'Brief'");
    expect(src).toContain("'Confidence'");
    expect(src).toContain("'Action'");
    expect(src).toContain("'Data'");
    expect(src).toContain("'Blocker'");
    expect(src).toContain("'Queue'");
    expect(src).toContain("'Leases'");
    expect(src).toContain("'Yield'");
    expect(src).toContain("['degraded-source', 'degraded']");
    expect(src).toContain("['unknown-source', 'unknown']");
    expect(src).toContain("['stale-source', 'stale']");
    expect(src).toContain("['missing-source', 'missing']");
    expect(src).toContain("['healthy-zero', 'empty']");
    expect(src).toContain('const sources = Array.isArray(readiness.sources) ? readiness.sources : []');
    expect(src).toContain('source?.sourceQuality?.badge === badge');
    expect(src).toContain('function fdReadinessDataTitle');
    expect(src).toContain("fdMetricPill('Data', fdReadinessDataText(readiness), fdReadinessDataTitle(readiness))");
    expect(src).toContain("qualityParts.length > 0 ? qualityParts.join(' / ') : 'healthy sources'");
    expect(src).toContain('const briefDetail = missionBrief?.whyNow ?? primaryAction?.detail ?? actionLabel');
    expect(src).toContain('const actionDetail = primaryAction?.detail ?? briefDetail');
    expect(css).toContain('.fd-readiness-rail');
    expect(css).toContain('.fd-readiness-strip');
    expect(css).toContain('.fleet-command-rail');
    expect(css).toContain('.fleet-command-safety--autonomous-dispatch');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
  });

  it('app.js keeps readiness data-quality counts distinct from healthy zero', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const start = src.indexOf('function fdReadinessDataText(readiness)');
    const end = src.indexOf('\nfunction fdReadinessDataTitle', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const formatterSource = src.slice(start, end);
    const formatter = new Function(`${formatterSource}\nreturn fdReadinessDataText;`)() as (
      readiness: Record<string, any>,
    ) => string;

    expect(formatter({
      freshness: { overall: 'stale' },
      sourceQualitySummary: {
        'degraded-source': 2,
        'unknown-source': 1,
        'stale-source': 3,
        'missing-source': 4,
        'healthy-zero': 5,
      },
      sources: [],
    })).toBe('stale · 2 degraded / 1 unknown / 3 stale / 4 missing / 5 empty');

    const degradedAndUnknown = formatter({
      freshness: { overall: 'fresh' },
      sourceQualitySummary: {
        'degraded-source': 1,
        'unknown-source': 2,
        'stale-source': 0,
        'missing-source': 0,
        'healthy-zero': 0,
      },
      sources: [],
    });
    expect(degradedAndUnknown).toBe('fresh · 1 degraded / 2 unknown');
    expect(degradedAndUnknown).not.toContain('empty');
    expect(degradedAndUnknown).not.toContain('healthy sources');
    expect(formatter({
      freshness: { overall: 'fresh' },
      sourceQualitySummary: {},
      sources: [],
      evidenceMatrix: { state: 'degraded', sources: [], summary: { withheld: 1 } },
    })).toBe('fresh · 0 healthy / 0 degraded / 0 blocked · evidence degraded');
  });

  it('app.js keeps unhealthy workspace zeroes distinct from healthy telemetry', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const start = src.indexOf('function workspaceSourceHealthy(workspace)');
    const end = src.indexOf('\nfunction fleetRepairRecoveryActive', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const formatterSource = src.slice(start, end);
    const helpers = new Function(
      `${formatterSource}\nreturn { workspaceSourceText, workspaceReadText, workspaceObservedValue };`,
    )() as Record<string, (...args: any[]) => string>;
    const degraded = {
      sourceQuality: {
        sourceState: 'degraded', complete: false, stopReasons: ['row-limit'],
        filesRead: 2, bytesRead: 2048, rowsScanned: 10, invalidRows: 1, unreadableFiles: 0,
      },
    };
    expect(helpers.workspaceSourceText!(degraded)).toBe('degraded (row-limit)');
    expect(helpers.workspaceReadText!(degraded)).toBe('2 files · 2048 bytes · 10 rows · 1 invalid · 0 unreadable');
    expect(helpers.workspaceObservedValue!(degraded, 0)).toBe('0 observed (partial)');
    expect(helpers.workspaceObservedValue!(degraded, '0%', true)).toBe('partial');

    const missing = { sourceQuality: { sourceState: 'missing', complete: true } };
    expect(helpers.workspaceSourceText!(missing)).toBe('missing');
    expect(helpers.workspaceObservedValue!(missing, 0)).toBe('unavailable');
  });

  it('renders cutoff checkpoints outside readiness and labels evidence source quality honestly', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const summaryStart = src.indexOf('function evidenceSourceSummary(source)');
    const summaryEnd = src.indexOf('\nfunction renderCutoffCheckpointCard', summaryStart);
    expect(summaryStart).toBeGreaterThanOrEqual(0);
    expect(summaryEnd).toBeGreaterThan(summaryStart);
    const evidenceSourceSummary = new Function(
      `${src.slice(summaryStart, summaryEnd)}\nreturn evidenceSourceSummary;`,
    )() as (source: Record<string, unknown>) => string;

    expect(evidenceSourceSummary({
      evidenceRole: 'forensics',
      evidenceQuality: { sourceState: 'missing', sourcePresent: false, complete: true, rowsScanned: 0 },
    })).toBe('forensics · missing');
    expect(evidenceSourceSummary({
      evidenceRole: 'forensics',
      evidenceQuality: { sourceState: 'degraded', sourcePresent: true, complete: false, rowsScanned: 0 },
    })).toBe('forensics · degraded');
    expect(evidenceSourceSummary({
      evidenceRole: 'learning',
      evidenceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true, rowsScanned: 0 },
    })).toBe('learning · 0 rows');

    expect(src).toContain("el('span', { cls: 'card-title' }, 'Cutoff Checkpoints')");
    expect(src).toContain("el('span', { cls: 'card-subtitle' }, 'Observation only')");
    expect(src).toContain("['Capture', status.captureScheduler?.state ?? 'unknown']");
    expect(src).toContain('d.fleet?.cutoffCheckpoints ?? fleet.cutoffCheckpoints ?? null');
    expect(src.indexOf('renderCutoffCheckpointCard('))
      .toBeGreaterThan(src.indexOf('renderAutonomousShipReadinessCard('));
  });

  it('app.js renders Fleet Dashboard lease board from shared queue machine health', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    expect(src).toContain('function fdRenderLeaseBoard');
    expect(src).toContain('function fdActiveWorkValue');
    expect(src).toContain("'Active work'");
    expect(src).toContain("'Lease Board'");
    expect(src).toContain('claimsByMachine');
    expect(src).toContain('claimSamples');
    expect(src).toContain('nextLeaseExpiryAt');
    expect(src).toContain('oldestExpiredMs');
    expect(src).toContain('fdRenderLeaseBoard(sharedQueue, activeWork)');
    expect(src).toContain('claimsByMachine.slice(0, 6)');
    expect(src).toContain('claimSamples.slice(0, 6)');
    expect(src).toContain("activeWork?.hostname");
    expect(src).toContain('Machine claims unavailable.');
    expect(css).toContain('.fd-lease-board');
    expect(css).toContain('.fd-lease-metrics');
    expect(css).toContain('.fd-lease-machine__id');
    expect(css).toContain('.fd-lease-samples');
    expect(css).toContain('.fd-lease-active-ids');
    expect(css).toContain('text-overflow: ellipsis');
  });

  it('app.js inbox detail reads current proposal review fields', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('p.riskClass ?? p.riskLevel');
    expect(src).toContain("['Verify',  verify]");
    expect(src).toContain("['Taste',   taste]");
  });

  // ── 15. SSE response headers ──────────────────────────────────────────────

  it('SSE response has Cache-Control: no-cache and Connection: keep-alive', async () => {
    const { res } = await openSseAndDrainInitial();
    const hdrs = res._headers();
    expect(hdrs['Cache-Control']).toContain('no-cache');
    expect(hdrs['Connection']).toBe('keep-alive');
  });
});
