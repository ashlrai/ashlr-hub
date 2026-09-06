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
