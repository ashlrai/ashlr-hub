import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUniverseConsoleServer } from '../src/core/web/universe-console-server.js';
import { MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES, validateUniverseConsoleResponse } from '../src/core/web/universe-console-public.js';

const fixture = vi.hoisted(() => ({ overview: vi.fn(), graph: vi.fn(), close: vi.fn(), create: vi.fn(),
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
function get(handle: Handle, path: string): Promise<{ status: number; body: string; length: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, agent: false,
      headers: { 'x-ashlr-token': handle.readToken } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'), length: res.headers['content-length'] }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error('Owned console request timed out'))); req.on('error', reject); req.end();
  });
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.close.mockResolvedValue(undefined);
  fixture.create.mockReturnValue({ overview: fixture.overview, graph: fixture.graph, close: fixture.close });
});
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const call of [fixture.config, fixture.generalServer, fixture.broadWorker, fixture.streaming]) expect(call).not.toHaveBeenCalled();
});

describe('scoped console HTTP worker boundary', () => {
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
