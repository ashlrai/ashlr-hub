/**
 * GET /api/verse/jev (decide/jev-api.ts), the read model behind the Resources drawer's
 * Jev card and the Usage Jev panel. 3.15 integration: the route had no test, and its 500
 * echoed the thrown error's message (which can carry a ~/.ashlr path) where every other
 * Verse module answers with a fixed message.
 */
import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('../src/core/decide/status.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/decide/status.js')>();
  return {
    ...real,
    jevStatus: (...args: Parameters<typeof real.jevStatus>) => {
      if (failure.next) throw failure.next;
      return real.jevStatus(...args);
    },
  };
});

import { handleJevApi, resetJevApiCacheForTests } from '../src/core/decide/jev-api.js';
import type { AshlrConfig } from '../src/core/types.js';

function fakeRes() {
  const out: { status: number | null; body: unknown } = { status: null, body: null };
  const res = {
    headersSent: false,
    writeHead(status: number) { out.status = status; return res; },
    end(payload: string) { out.body = JSON.parse(payload); },
  };
  return { res: res as unknown as ServerResponse, out };
}

async function call(cfg: AshlrConfig, path = '/api/verse/jev', method = 'GET') {
  const { res, out } = fakeRes();
  const handled = await handleJevApi({ cfg } as never, {} as never, res, path, method);
  return { handled, ...out };
}

afterEach(() => {
  failure.next = null;
  resetJevApiCacheForTests();
});

describe('GET /api/verse/jev', () => {
  it('answers the status and every decision kind, and declines paths it does not own', async () => {
    const ok = await call({} as AshlrConfig);
    expect(ok.handled).toBe(true);
    expect(ok.status).toBe(200);
    const body = ok.body as { status: unknown; kinds: Array<{ kind: string; threshold: number }> };
    expect(body.status).toBeTruthy();
    expect(body.kinds.length).toBeGreaterThan(5);
    expect((await call({} as AshlrConfig, '/api/verse/jevx')).handled).toBe(false);
    expect((await call({} as AshlrConfig, '/api/verse/jev', 'POST')).status).toBe(404);
  });

  it('a failure answers a fixed message, never the error text', async () => {
    failure.next = new Error('ENOENT: /Users/someone/.ashlr/decide/ledger.jsonl');
    const failed = await call({} as AshlrConfig);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'jev status unavailable' });
  });
});
