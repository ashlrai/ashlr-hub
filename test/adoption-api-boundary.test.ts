import { describe, it, expect, vi } from 'vitest';
// Importing a metadata read port must not evaluate unrelated provider schedulers.
vi.mock('../src/core/cloud/cloud-api.js', () => { throw new Error('cloud scheduler module must remain unloaded'); });
vi.mock('../src/core/devin/devin-api.js', () => { throw new Error('Devin scheduler module must remain unloaded'); });
import { createAdoptionApi } from '../src/core/verse/adoption-api.js';
import { createAdoptionCache } from '../src/core/verse/adoption-cache.js';
import { VERSE_ADOPTION_PATH, VERSE_ADOPTION_REFRESH_PATH } from '../src/core/verse/adoption-types.js';
import { handleVerseApi, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
function call(method: string, body: string, allowDispatch = true, headers: Record<string, string> = {}) {
  const req = Readable.from([body]) as unknown as IncomingMessage;
  req.url = method === 'GET' ? VERSE_ADOPTION_PATH : VERSE_ADOPTION_REFRESH_PATH; req.method = method; req.headers = headers;
  let output = '';
  const res = { statusCode: 0, setHeader: vi.fn(), writeHead(n: number) { this.statusCode = n; }, end(v: string) { output = v; } } as unknown as ServerResponse;
  return { req, res, ctx: { token: 'x'.repeat(64), allowDispatch } as VerseApiContext, output: () => JSON.parse(output) };
}
describe('adoption read and guarded refresh boundaries', () => {
  it('imports and peeks without evaluating cloud or Devin schedulers or contacting transports', async () => {
    const read = vi.fn(), cache = createAdoptionCache({ read }), c = call('GET', '');
    await createAdoptionApi(cache)(c.ctx, c.req, c.res, VERSE_ADOPTION_PATH, 'GET');
    expect(c.res.statusCode).toBe(200); expect(read).not.toHaveBeenCalled(); expect(c.output().sources.npm.value).toBeNull();
  });
  it('actual Verse route and unknown namespace children bypass all scheduler-owning mounted modules', async () => {
    for (const path of [VERSE_ADOPTION_PATH, `${VERSE_ADOPTION_PATH}/unknown`]) {
      const c = call('GET', ''); c.req.url = path;
      expect(await handleVerseApi(c.ctx, c.req, c.res, path, 'GET')).toBe(true);
      expect(c.res.statusCode).toBe(path === VERSE_ADOPTION_PATH ? 200 : 404);
    }
  });
  it('HEAD through actual Verse remains mutation-gated', async () => {
    const c = call('HEAD', '');
    await handleVerseApi(c.ctx, c.req, c.res, VERSE_ADOPTION_PATH, 'HEAD');
    expect(c.res.statusCode).toBe(401);
  });
  it('dispatch-disabled and tokenless refreshes do not collect', async () => {
    const read = vi.fn(), api = createAdoptionApi(createAdoptionCache({ read }));
    for (const allowed of [false, true]) {
      const c = call('POST', '{}', allowed); await api(c.ctx, c.req, c.res, VERSE_ADOPTION_REFRESH_PATH, 'POST');
      expect(c.res.statusCode).toBe(allowed ? 401 : 404);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['{"repo":"private/other"}', 'null', '[]', '{oops'])('rejects non-empty or malformed body %s', async (body) => {
    const read = vi.fn(), c = call('POST', body, true, { 'x-ashlr-token': 'x'.repeat(64), 'content-type': 'application/json' });
    await createAdoptionApi(createAdoptionCache({ read }))(c.ctx, c.req, c.res, VERSE_ADOPTION_REFRESH_PATH, 'POST');
    expect(c.res.statusCode).toBe(400); expect(read).not.toHaveBeenCalled();
  });
});
