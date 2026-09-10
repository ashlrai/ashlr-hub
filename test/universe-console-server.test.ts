import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUniverseConsoleServer } from '../src/core/web/universe-console-server.js';
import { MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES, validateUniverseConsoleResponse } from '../src/core/web/universe-console-public.js';

const fixture = vi.hoisted(() => ({ overview: vi.fn(), graph: vi.fn(), readiness: vi.fn(), controller: vi.fn(), close: vi.fn(), create: vi.fn(),
  config: vi.fn(), generalServer: vi.fn(), broadWorker: vi.fn(), streaming: vi.fn() }));
vi.mock('../src/core/web/universe-console-reads.js', async (original) => ({
  ...await original<typeof import('../src/core/web/universe-console-reads.js')>(),
  createUniverseConsoleReader: fixture.create,
}));
// Importing the old dashboard's runtime graph is itself outside this server's scope.
vi.mock('../src/core/config.js', () => { fixture.config(); throw new Error('General config imported'); });
vi.mock('../src/core/web/server.js', () => { fixture.generalServer(); throw new Error('General server imported'); });
vi.mock('../src/core/web/read-projections.js', () => { fixture.broadWorker(); throw new Error('Broad worker imported'); });
vi.mock('../src/core/run/streaming.js', () => { fixture.streaming(); throw new Error('Default run streams imported'); });

type Handle = Awaited<ReturnType<typeof startUniverseConsoleServer>>;
const handles: Handle[] = [];
async function start() {
  const handle = await startUniverseConsoleServer({ root: '/private/tmp/scoped-server-unit', port: 0 });
  handles.push(handle); return handle;
}
function get(handle: Handle, path: string, options: { method?: string; token?: string } = {}): Promise<{ status: number; body: string; length: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, agent: false, method: options.method ?? 'GET',
      headers: { 'x-ashlr-token': options.token ?? handle.readToken } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'), length: res.headers['content-length'] }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error('Owned console request timed out'))); req.on('error', reject); req.end();
  });
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.close.mockResolvedValue(undefined);
  fixture.create.mockReturnValue({ overview: fixture.overview, graph: fixture.graph, campaignReadiness: fixture.readiness,
    controllerStatus: fixture.controller, close: fixture.close });
});
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const call of [fixture.config, fixture.generalServer, fixture.broadWorker, fixture.streaming]) expect(call).not.toHaveBeenCalled();
});

describe('scoped console HTTP worker boundary', () => {
  it('forwards only the authenticated controller selection and exact worker JSON', async () => {
    const handle = await start(); const body = '{"schemaVersion":1,"controllerId":"one","status":"draining"}';
    fixture.controller.mockResolvedValue(body);
    expect(await get(handle, '/api/universe/controller-status?controllerId=one')).toEqual({ status: 200, body,
      length: String(Buffer.byteLength(body)) });
    expect(fixture.controller).toHaveBeenCalledExactlyOnceWith('one');
    expect(fixture.overview).not.toHaveBeenCalled(); expect(fixture.readiness).not.toHaveBeenCalled();
  });

  it.each(['', '?controllerId=', '?controllerId=../one', '?controllerId=one&controllerId=one',
    '?controllerId=one&root=/other', '?controllerId=one&campaignId=two', '?controllerId=one&extra=',
    '?controllerId=UPPER', `?controllerId=${'a'.repeat(65)}`])('rejects expanded or ambiguous controller query %#', async (query) => {
    const handle = await start();
    expect((await get(handle, `/api/universe/controller-status${query}`)).status).toBe(400);
    expect(fixture.controller).not.toHaveBeenCalled();
  });

  it('requires authority before controller validation and never exposes control mutations', async () => {
    const handle = await start(); const path = '/api/universe/controller-status?controllerId=one';
    expect((await get(handle, path, { token: '' })).status).toBe(401);
    expect((await get(handle, `${path}&root=other`, { token: 'wrong' })).status).toBe(401);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      expect((await get(handle, path, { method })).status).toBe(405);
    }
    expect(fixture.controller).not.toHaveBeenCalled();
  });

  it('withholds stale controller success and private errors after a worker failure', async () => {
    const handle = await start(); const path = '/api/universe/controller-status?controllerId=one';
    fixture.controller.mockResolvedValueOnce('{"schemaVersion":1,"status":"drained"}')
      .mockRejectedValueOnce(new Error('/private/controller-secret'));
    expect((await get(handle, path)).status).toBe(200);
    const failure = await get(handle, path);
    expect(failure.status).toBe(503);
    expect(JSON.parse(failure.body)).toEqual({ error: 'Universe evidence is temporarily unavailable' });
    expect(fixture.controller).toHaveBeenCalledTimes(2);
  });
  it('forwards an authenticated selected-campaign read only through its pinned reader', async () => {
    const handle = await start(); const body = '{"schemaVersion":1,"campaignId":"one","sourceState":"healthy"}';
    fixture.readiness.mockResolvedValue(body);
    expect(await get(handle, '/api/universe/campaign-readiness?campaignId=one')).toEqual({
      status: 200, body, length: String(Buffer.byteLength(body)),
    });
    expect(fixture.readiness).toHaveBeenCalledExactlyOnceWith('one');
    expect(fixture.overview).not.toHaveBeenCalled(); expect(fixture.graph).not.toHaveBeenCalled();
  });

  it.each(['', '?campaignId=', '?campaignId=../one', '?campaignId=one&campaignId=one',
    '?campaignId=one&root=/other', '?campaignId=one&universeId=two', '?campaignId=one&extra=',
    `?campaignId=${'a'.repeat(65)}`])('rejects ambiguous or expanded readiness query %#', async (query) => {
    const handle = await start();
    expect((await get(handle, `/api/universe/campaign-readiness${query}`)).status).toBe(400);
    expect(fixture.readiness).not.toHaveBeenCalled();
  });

  it('requires read authority before validation or evidence and rejects mutation methods', async () => {
    const handle = await start(); const path = '/api/universe/campaign-readiness?campaignId=one';
    expect((await get(handle, path, { token: '' })).status).toBe(401);
    expect((await get(handle, `${path}&root=other`, { token: 'wrong' })).status).toBe(401);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect((await get(handle, path, { method })).status).toBe(405);
    }
    expect(fixture.readiness).not.toHaveBeenCalled();
  });

  it('returns fixed unavailability after a readiness worker failure, without a cached success', async () => {
    const handle = await start(); const path = '/api/universe/campaign-readiness?campaignId=one';
    fixture.readiness.mockResolvedValueOnce('{"schemaVersion":1,"disposition":"startable"}')
      .mockRejectedValueOnce(new Error('/private/readiness-secret'));
    expect((await get(handle, path)).status).toBe(200);
    const failure = await get(handle, path);
    expect(failure.status).toBe(503);
    expect(JSON.parse(failure.body)).toEqual({ error: 'Universe evidence is temporarily unavailable' });
    expect(fixture.readiness).toHaveBeenCalledTimes(2);
  });

  it('forwards exact pre-serialized public JSON, with UTF-8 length and no parent reprojection', async () => {
    const handle = await start(); const body = '{ "schemaVersion": 1, "label": "é", "universes": [] }\n';
    fixture.overview.mockResolvedValue(body);
    const response = await get(handle, '/api/universe');
    expect(response).toEqual({ status: 200, body, length: String(Buffer.byteLength(body)) });
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith('/private/tmp/scoped-server-unit');
  });

  it('returns unavailable without a partial success after response-budget rejection', async () => {
    const handle = await start();
    fixture.overview.mockImplementation(async () => validateUniverseConsoleResponse(JSON.stringify({
      schemaVersion: 1, text: 'é'.repeat(MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES / 2),
    })));
    const response = await get(handle, '/api/universe');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'Universe evidence is temporarily unavailable' });
    expect(response.body.length).toBeLessThan(200);
  });

  it('keeps worker errors private while cheap metadata remains available', async () => {
    const handle = await start(); fixture.graph.mockRejectedValue(new Error('private worker path'));
    const failure = await get(handle, '/api/universe/graph?universeId=one');
    expect(failure.status).toBe(503); expect(failure.body).not.toContain('private worker path');
    const metadata = await get(handle, '/api/universe/console');
    expect(metadata.status).toBe(200); expect(JSON.parse(metadata.body).root).toBe('/private/tmp/scoped-server-unit');
    expect(fixture.overview).not.toHaveBeenCalled(); await handle.close(); await handle.close();
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
