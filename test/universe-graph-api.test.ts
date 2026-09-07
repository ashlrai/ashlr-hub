import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, WebServerHandle } from '../src/core/types.js';

const reader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/universe/graph-reader.js', () => ({ readUniverseGraph: reader.read }));
vi.mock('../src/core/universe/index.js', () => ({ readUniverseOverview: vi.fn() }));
import { handleApi } from '../src/core/web/api.js';
import { startServer } from '../src/core/web/server.js';

const cfg = { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {} } as AshlrConfig;
function request(url: string, method = 'GET') {
  const captured = { status: 0, body: '' };
  const req = new EventEmitter() as IncomingMessage;
  req.method = method; req.url = url; req.headers = {};
  const res = { headersSent: false,
    writeHead(status: number) { captured.status = status; this.headersSent = true; },
    end(body?: string) { if (body) captured.body += body; }, write() { return true; },
  } as unknown as ServerResponse;
  return { req, res, captured };
}
function serverRequest(handle: WebServerHandle, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: handle.port, path: '/api/universe/graph?universeId=target',
      headers: { Host: `127.0.0.1:${handle.port}`, ...(token ? { 'x-ashlr-token': token } : {}) } }, (res) => {
      let body = ''; res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject); req.end();
  });
}
describe('read-only Universe graph API', () => {
  beforeEach(() => { reader.read.mockReset(); });
  it('requires the dedicated read token before reading graph evidence', async () => {
    reader.read.mockReturnValue({ sourceState: 'missing', nodes: [] });
    const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: false });
    try {
      expect((await serverRequest(handle)).status).toBe(401);
      expect((await serverRequest(handle, handle.token)).status).toBe(401);
      expect(reader.read).not.toHaveBeenCalled();
      expect((await serverRequest(handle, handle.readToken)).status).toBe(200);
      expect(reader.read).toHaveBeenCalledExactlyOnceWith('target');
    } finally { await handle.close(); }
  });

  it.each(['', '?universeId=', '?universeId=../target', '?universeId=a&universeId=b',
    '?universeId=target&root=/private/arbitrary', '?universeId=target&node=x', '?UniverseId=target'])('rejects invalid query %s before reading', async (query) => {
    const { req, res, captured } = request(`/api/universe/graph${query}`);
    await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false });
    expect(captured.status).toBe(400); expect(reader.read).not.toHaveBeenCalled();
  });

  it.each(['missing', 'healthy', 'degraded'])('preserves %s and scrubs metadata without dropping graph structure', async (sourceState) => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    reader.read.mockReturnValue({ sourceState, complete: sourceState === 'healthy', nodes: [
      { id: 'node-one', artifactDigest: 'a'.repeat(64), label: secret },
      { id: 'node-two', artifactDigest: 'b'.repeat(64), label: 'Second occurrence' },
    ], edges: [{ id: 'edge-one', from: 'node-one', to: 'node-two', kind: 'parent' }] });
    const { req, res, captured } = request('/api/universe/graph?universeId=target');
    await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false });
    const body = JSON.parse(captured.body);
    expect(captured.status).toBe(200); expect(body.sourceState).toBe(sourceState);
    expect(body.nodes.map((node: { id: string }) => node.id)).toEqual(['node-one', 'node-two']);
    expect(body.edges[0]).toMatchObject({ from: 'node-one', to: 'node-two' });
    expect(captured.body).not.toContain(secret); expect(captured.body).not.toContain('a'.repeat(64));
  });

  it('does not accept mutation verbs', async () => {
    const { req, res, captured } = request('/api/universe/graph?universeId=target', 'POST');
    expect(await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false })).toBe(true);
    expect(captured.status).toBe(404);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('returns an error rather than empty success if graph construction fails', async () => {
    reader.read.mockImplementation(() => { throw new Error('private detail'); });
    const { req, res, captured } = request('/api/universe/graph?universeId=target');
    await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false });
    expect(captured.status).toBe(500);
    expect(captured.body).not.toContain('private detail');
  });
});
