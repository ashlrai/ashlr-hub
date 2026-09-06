import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, WebServerHandle } from '../src/core/types.js';
import type { UniverseOverview } from '../src/core/universe/types.js';

const reader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/universe/index.js', () => ({ readUniverseOverview: reader.read }));

import { handleApi } from '../src/core/web/api.js';
import { startServer } from '../src/core/web/server.js';

const cfg = {
  version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
} as AshlrConfig;

function overview(overrides: Partial<UniverseOverview> = {}): UniverseOverview {
  return { schemaVersion: 1, sampledAt: '2026-09-06T12:00:00.000Z', sourceState: 'missing', reasons: [], universes: [], measurementScope: 'local-experiment', ...overrides };
}

function localRequest(method = 'GET', url = '/api/universe') {
  const captured = { status: 0, body: '' };
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {};
  const res = {
    headersSent: false,
    writeHead(status: number) { captured.status = status; this.headersSent = true; },
    end(body?: string) { if (body) captured.body += body; },
    write() { return true; },
  } as unknown as ServerResponse;
  return { req, res, captured };
}

function serverRequest(handle: WebServerHandle, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: handle.port, path: '/api/universe', method: 'GET',
      headers: { Host: `127.0.0.1:${handle.port}`, ...(token ? { 'x-ashlr-token': token } : {}) },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/universe', () => {
  beforeEach(() => { reader.read.mockReset(); });

  it('requires read authority before inspecting persisted experiment data', async () => {
    const body = overview();
    reader.read.mockReturnValue(body);
    const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: false });
    try {
      expect((await serverRequest(handle)).status).toBe(401);
      expect((await serverRequest(handle, 'wrong')).status).toBe(401);
      expect((await serverRequest(handle, handle.token)).status).toBe(401);
      expect(reader.read).not.toHaveBeenCalled();
      const authorized = await serverRequest(handle, handle.readToken);
      expect(authorized.status).toBe(200);
      expect(JSON.parse(authorized.body)).toEqual(body);
      expect(reader.read).toHaveBeenCalledOnce();
    } finally { await handle.close(); }
  });

  it.each(['missing', 'healthy', 'degraded'] as const)('preserves %s source state and never takes a store root from query input', async (sourceState) => {
    const body = overview({ sourceState, reasons: sourceState === 'degraded' ? ['Invalid record'] : [] });
    reader.read.mockReturnValue(body);
    const { req, res, captured } = localRequest('GET', '/api/universe?root=/arbitrary/private/root');
    await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false });
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toEqual(body);
    expect(reader.read).toHaveBeenCalledWith();
  });

  it('scrubs secret-shaped text from nested persisted records', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    reader.read.mockReturnValue(overview({ sourceState: 'degraded', reasons: [`Unexpected ${secret}`] }));
    const { req, res, captured } = localRequest();
    await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false });
    expect(captured.status).toBe(200);
    expect(captured.body).not.toContain(secret);
    expect(captured.body).toContain('[REDACTED]');
  });

  it('omits diagnostic messages and locations in saved and active runs while preserving codes and campaign evidence', async () => {
    const diagnostic = { code: 'DATE_ROLLOVER', message: 'Private evaluator diagnostic marker', path: 'private-notes/customer.md', line: 88431 };
    const trial = {
      id: 'trial-first', variantId: 'local-coder', niche: 'dates', parentTrialId: null,
      status: 'failed' as const, score: 0, metrics: { casesPassed: 3 }, durationMs: 100,
      artifact: { path: '/experiments/artifacts/run-first/trial-first', digest: 'a'.repeat(64), revision: 'b'.repeat(40) },
      delta: null, selected: false, diagnostics: [diagnostic],
    };
    const savedRun = {
      id: 'run-first', universeId: 'dates', generation: 1, manifestDigest: 'c'.repeat(64), comparatorDigest: 'd'.repeat(64),
      startedAt: '2026-09-06T12:00:00.000Z', finishedAt: '2026-09-06T12:00:01.000Z', status: 'completed' as const,
      trials: [trial], durationMs: 1000, tokensUsed: null, costUsd: null,
    };
    const body: UniverseOverview = overview({ sourceState: 'healthy', universes: [{
      manifest: { schemaVersion: 1, id: 'dates', name: 'Date formatter', objective: 'Reject calendar rollover',
        seed: { repo: '/experiments/source', revision: 'b'.repeat(40) },
        metric: { name: 'casesPassed', direction: 'maximize', minImprovement: 0 },
        budget: { maxTrials: 1, maxDurationMs: 10000, trialTimeoutMs: 5000, maxParallel: 1 },
        evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 2000 },
        variants: [{ id: 'local-coder', niche: 'dates', hypothesis: 'Check the parsed date', command: ['node', 'worker.mjs'] }] },
      manifestDigest: 'c'.repeat(64), comparatorDigest: 'd'.repeat(64), runs: [savedRun], elites: [],
      activeRun: { ...savedRun, id: 'run-active', generation: 2, status: 'running', finishedAt: null,
        trials: [{ ...trial, id: 'trial-active', diagnostics: [{ ...diagnostic, code: 'ACTIVE_DATE_CASE', message: 'Private active diagnostic marker' }] }] },
      sourceState: 'healthy', reasons: [],
    }], campaigns: [{
      definition: { schemaVersion: 1, id: 'date-search', universeId: 'dates', feedback: true,
        budget: { maxGenerations: 3, maxDurationMs: 60000, maxModelRequests: 3, maxStagnantGenerations: 2, maxReportedTokens: null } },
      definitionDigest: 'e'.repeat(64), manifestDigest: 'c'.repeat(64), comparatorDigest: 'd'.repeat(64),
      createdAt: '2026-09-06T12:00:00.000Z', startedAt: '2026-09-06T12:00:00.000Z',
      deadlineAt: '2026-09-06T12:01:00.000Z', finishedAt: null, state: 'running', reason: null,
      owner: { pid: 123, startRef: 'f'.repeat(64) }, sourceState: 'healthy', reasons: [],
      steps: [{ ordinal: 1, runId: 'run-first', generation: 1, variantIds: ['local-coder'], reservedModelRequests: 0,
        createdAt: '2026-09-06T12:00:00.000Z', state: 'completed', trialCount: 1, passedTrials: 0,
        admissions: 0, improvements: 0, tokensUsed: null }],
      progress: { attempts: 1, completedRuns: 1, interruptedRuns: 0, reservedModelRequests: 0,
        reportedTokens: 0, recordedTokens: 0, usageComplete: true, admissions: 0, improvements: 0, stagnantGenerations: 1 },
    }] });
    const original = JSON.stringify(body);
    reader.read.mockReturnValue(body);
    const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: false });
    try {
      const authorized = await serverRequest(handle, handle.readToken);
      expect(authorized.status).toBe(200);
      const rendered = JSON.parse(authorized.body) as UniverseOverview;
      expect(rendered.universes[0]!.runs[0]!.trials[0]!.diagnostics).toEqual([{ code: 'DATE_ROLLOVER', message: '[omitted from web view]' }]);
      expect(rendered.universes[0]!.activeRun!.trials[0]!.diagnostics).toEqual([{ code: 'ACTIVE_DATE_CASE', message: '[omitted from web view]' }]);
      expect(authorized.body).not.toContain('Private evaluator diagnostic marker');
      expect(authorized.body).not.toContain('Private active diagnostic marker');
      expect(authorized.body).not.toContain('private-notes/customer.md');
      expect(rendered.campaigns).toHaveLength(1);
      expect(rendered.campaigns![0]).toMatchObject({ definition: body.campaigns![0]!.definition,
        state: 'running', progress: body.campaigns![0]!.progress, steps: body.campaigns![0]!.steps });
      expect(rendered.universes[0]!.runs[0]!.trials[0]!.metrics).toEqual({ casesPassed: 3 });
      expect(JSON.stringify(body)).toBe(original);
    } finally { await handle.close(); }
  });

  it('returns a transport error if the reader throws, rather than an empty-success archive', async () => {
    reader.read.mockImplementation(() => { throw new Error('private-path-and-error'); });
    const { req, res, captured } = localRequest();
    await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false });
    expect(captured.status).toBe(500);
    expect(captured.body).not.toContain('private-path-and-error');
  });

  it('does not expose init/run/archive mutations through this read route', async () => {
    const { req, res, captured } = localRequest('POST');
    await handleApi(req, res, cfg, { token: 'unused', allowDispatch: true });
    expect(captured.status).toBe(404);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
