/**
 * V3.10 route mount (unit A10) — src/core/verse/verse-api.ts mounting the
 * api-modules.ts route families: health, reasoning, fleet history, budget.
 *
 * Runs the REAL server (read-session boundary, handleApi dispatch, the
 * mutation gate) under a relocated HOME. The four modules are replaced with
 * recording fakes through setMountedApiModulesForTest(), so the mount itself is
 * what is under test — not the modules, which their owning units test.
 *
 * What the mount promises:
 *   - fixed order, first responder wins, a declining module passes the request on;
 *   - /api/reasoning/* is reachable (it is outside /api/verse), /api/reasoningX is not;
 *   - V1 routes never load a module, and bootstrap's key set is unchanged;
 *   - every non-GET (HEAD included) meets the V1 dispatch + mutation gate before
 *     any module sees it;
 *   - a module that throws gets the V1 error mapping, with no message leak;
 *   - a module that fails to load is a 503 naming it, not a silent 404, and
 *     is retried on the next request.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import { sendJson } from '../src/core/web/api.js';
import {
  handleVerseApi,
  invalidateVerseSeatCache,
  isVerseApiPath,
  mountedApiModules,
  resetVerseEngine,
  setMountedApiModulesForTest,
  type MountedApiModule,
  type MountedApiModuleId,
  type VerseApiContext,
} from '../src/core/verse/verse-api.js';
import { VERSE_HEALTH_PATH } from '../src/core/verse/health-types.js';
import { VERSE_BUDGET_PATH } from '../src/core/routing/types.js';
import { REASONING_DIGEST_PATH, REASONING_STEPS_PATH } from '../src/core/reasoning/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FLEET_HISTORY_PATH = '/api/verse/fleet/history';

interface Call { id: MountedApiModuleId; path: string; method: string }

let calls: Call[] = [];
let loads: MountedApiModuleId[] = [];

/** A fake module that owns `paths` and answers `{ module: id, path }`. */
function fakeModule(id: MountedApiModuleId, paths: string[], behaviour: 'answer' | 'throw' | 'throw-coded' = 'answer'): MountedApiModule {
  const handler: ApiModule = async (_ctx, _req, res: ServerResponse, p: string, method: string) => {
    calls.push({ id, path: p, method });
    if (!paths.includes(p)) return false;
    if (behaviour === 'throw') throw new Error(`boom at ${os.homedir()}/secret-path`);
    if (behaviour === 'throw-coded') throw Object.assign(new Error('bad query'), { code: 'VERSE_INVALID' });
    sendJson(res, 200, { module: id, path: p, method });
    return true;
  };
  return {
    id,
    load: async () => {
      loads.push(id);
      return handler;
    },
  };
}

function defaultFakes(): MountedApiModule[] {
  return [
    fakeModule('health', [VERSE_HEALTH_PATH]),
    fakeModule('reasoning', [REASONING_DIGEST_PATH, REASONING_STEPS_PATH]),
    fakeModule('fleet-history', [FLEET_HISTORY_PATH]),
    fakeModule('budget', [VERSE_BUDGET_PATH]),
  ];
}

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    // Port 1 refuses immediately: no local seats, no 2s timeout wait.
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

/** Just enough engine for bootstrap / sessions: no sessions, never spawns. */
function emptyEngine(): VerseEngineHandle {
  return {
    listSessions: () => [],
    getSession: () => null,
    getEvents: () => [],
    subscribe: () => () => {},
    close: () => {},
  } as unknown as VerseEngineHandle;
}

interface HttpResult { status: number; body: string; json: unknown }

function request(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* not json (or HEAD) */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let tmpHome: string;
let prevHome: string | undefined;
let cfg: AshlrConfig;
let handles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-mount-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const accountsRoot = path.join(tmpHome, '.ashlr', 'account-connections');
  fs.mkdirSync(accountsRoot, { recursive: true });
  fs.writeFileSync(path.join(accountsRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
  cfg = makeConfig(accountsRoot);
  resetVerseEngine(emptyEngine());
  invalidateVerseSeatCache();
  calls = [];
  loads = [];
  setMountedApiModulesForTest(defaultFakes());
  handles = [];
});

afterEach(async () => {
  for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
  handles = [];
  setMountedApiModulesForTest(null);
  resetVerseEngine(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function boot(opts: Partial<WebServerOptions> = {}) {
  const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true, ...opts });
  handles.push(handle);
  const read = readAuthHeaders(handle.port);
  const mutate = { 'x-ashlr-token': handle.token, 'content-type': 'application/json' };
  return { port: handle.port, read, mutate };
}

// ---------------------------------------------------------------------------
// The real mount table
// ---------------------------------------------------------------------------

describe('the real mount table', () => {
  it('mounts health, reasoning, fleet history, budget and cloud — in that order', () => {
    setMountedApiModulesForTest(null);
    expect(mountedApiModules().map((m) => m.id)).toEqual(['health', 'reasoning', 'fleet-history', 'budget', 'cloud']);
  });

  it('every entry resolves to a handler function (the owning units exported what the contract names)', async () => {
    setMountedApiModulesForTest(null);
    for (const entry of mountedApiModules()) {
      const handler = await entry.load();
      expect(typeof handler, entry.id).toBe('function');
    }
  });

  it('no two real modules claim the same path (order can never shadow a family)', async () => {
    setMountedApiModulesForTest(null);
    const handlers = await Promise.all(mountedApiModules().map(async (m) => ({ id: m.id, handler: await m.load() })));
    // A GET the dispatch gate would pass, against a response that records
    // whether a module wrote to it. Modules must decline foreign paths
    // WITHOUT writing, so only the owner may answer each representative path.
    const probe = async (handler: ApiModule, p: string): Promise<boolean> => {
      const res = new FakeResponse();
      const req = fakeRequest('GET', p);
      const ctx: VerseApiContext = { cfg, token: 'x'.repeat(64), allowDispatch: false };
      try {
        return (await handler(ctx, req, res as unknown as ServerResponse, p, 'GET')) || res.wrote;
      } catch {
        // Throwing is still "claiming" the path.
        return true;
      }
    };
    const representative: Record<MountedApiModuleId, string> = {
      health: VERSE_HEALTH_PATH,
      reasoning: REASONING_DIGEST_PATH,
      'fleet-history': FLEET_HISTORY_PATH,
      budget: VERSE_BUDGET_PATH,
    };
    for (const [owner, p] of Object.entries(representative) as Array<[MountedApiModuleId, string]>) {
      for (const { id, handler } of handlers) {
        if (id === owner) continue;
        // fleet-history's exact path is the owning unit's choice; only the
        // three contract-pinned paths are asserted against the others.
        if (owner === 'fleet-history') continue;
        expect(await probe(handler, p), `${id} must decline ${p}`).toBe(false);
      }
    }
  });
});

class FakeResponse {
  wrote = false;
  headersSent = false;
  writableEnded = false;
  statusCode = 200;
  setHeader(): this { this.wrote = true; return this; }
  getHeader(): undefined { return undefined; }
  writeHead(): this { this.wrote = true; this.headersSent = true; return this; }
  write(): boolean { this.wrote = true; return true; }
  end(): this { this.wrote = true; this.writableEnded = true; return this; }
  on(): this { return this; }
  once(): this { return this; }
}

function fakeRequest(method: string, url: string): IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:7777' };
  return req;
}

// ---------------------------------------------------------------------------
// Path predicate
// ---------------------------------------------------------------------------

describe('isVerseApiPath', () => {
  it('covers /api/verse/* and /api/reasoning/* on a segment boundary only', () => {
    expect(isVerseApiPath('/api/verse')).toBe(true);
    expect(isVerseApiPath('/api/verse/health')).toBe(true);
    expect(isVerseApiPath('/api/reasoning')).toBe(true);
    expect(isVerseApiPath('/api/reasoning/digest')).toBe(true);
    expect(isVerseApiPath('/api/reasoningX')).toBe(false);
    expect(isVerseApiPath('/api/versebudget')).toBe(false);
    expect(isVerseApiPath('/api/runs')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reaching the modules through the real server
// ---------------------------------------------------------------------------

describe('GET through the real server', () => {
  it.each([
    ['health', VERSE_HEALTH_PATH],
    ['reasoning', REASONING_DIGEST_PATH],
    ['reasoning', REASONING_STEPS_PATH],
    ['fleet-history', FLEET_HISTORY_PATH],
    ['budget', VERSE_BUDGET_PATH],
  ] as const)('%s answers %s', async (id, p) => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', `${p}?limit=5`, read);
    expect(res.status).toBe(200);
    // The module sees the path WITHOUT the query string, like every V1 route.
    expect(res.json).toEqual({ module: id, path: p, method: 'GET' });
  });

  it('asks modules in the fixed order and stops at the first responder', async () => {
    const { port, read } = await boot();
    await request(port, 'GET', VERSE_BUDGET_PATH, read);
    expect(calls.map((c) => c.id)).toEqual(['health', 'reasoning', 'fleet-history', 'budget']);

    calls = [];
    await request(port, 'GET', VERSE_HEALTH_PATH, read);
    expect(calls.map((c) => c.id)).toEqual(['health']);
  });

  it('the first module to claim a path wins even if a later one would too', async () => {
    setMountedApiModulesForTest([
      fakeModule('health', ['/api/verse/shared']),
      fakeModule('budget', ['/api/verse/shared']),
    ]);
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/shared', read);
    expect((res.json as { module: string }).module).toBe('health');
    expect(calls.map((c) => c.id)).toEqual(['health']);
  });

  it('is behind the read-session boundary: 401 without read authority, module never called', async () => {
    const { port } = await boot();
    for (const p of [VERSE_HEALTH_PATH, REASONING_DIGEST_PATH, FLEET_HISTORY_PATH, VERSE_BUDGET_PATH]) {
      const res = await request(port, 'GET', p);
      expect(res.status, p).toBe(401);
    }
    expect(calls).toEqual([]);
    expect(loads).toEqual([]);
  });

  it('an unclaimed path is still a 404 once every module declined', async () => {
    const { port, read } = await boot();
    const verse = await request(port, 'GET', '/api/verse/no-such-route', read);
    expect(verse.status).toBe(404);
    const reasoning = await request(port, 'GET', '/api/reasoning/no-such-route', read);
    expect(reasoning.status).toBe(404);
    expect(calls.filter((c) => c.path === '/api/reasoning/no-such-route').map((c) => c.id))
      .toEqual(['health', 'reasoning', 'fleet-history', 'budget']);
  });

  it('/api/reasoningX never reaches a module', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/reasoningX', read);
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('V1 routes are untouched', () => {
  it('bootstrap, seats and sessions never load a module', async () => {
    const { port, read } = await boot();
    for (const p of ['/api/verse/bootstrap', '/api/verse/seats', '/api/verse/sessions']) {
      const res = await request(port, 'GET', p, read);
      expect(res.status, p).toBe(200);
    }
    expect(loads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('bootstrap keeps its frozen key set', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/bootstrap', read);
    expect(Object.keys(res.json as object).sort()).toEqual(['dispatchEnabled', 'localRuntime', 'projects', 'seats', 'sessions']);
  });

  it('a module claiming a V1 path cannot shadow it', async () => {
    setMountedApiModulesForTest([fakeModule('health', ['/api/verse/bootstrap', '/api/verse/sessions'])]);
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/bootstrap', read);
    expect((res.json as { module?: string }).module).toBeUndefined();
    expect(Array.isArray((res.json as { seats?: unknown }).seats)).toBe(true);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mutations: the V1 gate runs before any module
// ---------------------------------------------------------------------------

describe('non-GET requests', () => {
  it('404 when the server does not allow dispatch — module never loaded', async () => {
    const { port, mutate } = await boot({ allowDispatch: false });
    const res = await request(port, 'POST', VERSE_BUDGET_PATH, mutate, JSON.stringify({ mode: 'reserve' }));
    expect(res.status).toBe(404);
    expect(loads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('401 without the mutation token (the read token is not enough)', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'POST', VERSE_BUDGET_PATH, { ...read, 'content-type': 'application/json' }, '{}');
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('415 with the token but a non-JSON body type', async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', VERSE_BUDGET_PATH, { ...mutate, 'content-type': 'text/plain' }, 'x');
    expect(res.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('reaches the module once the gate passes, with the method intact', async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', VERSE_BUDGET_PATH, mutate, JSON.stringify({ mode: 'reserve' }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ module: 'budget', path: VERSE_BUDGET_PATH, method: 'POST' });
  });

  it('HEAD is a non-GET: no read served without the mutation gate', async () => {
    const off = await boot({ allowDispatch: false });
    const headOff = await request(off.port, 'HEAD', VERSE_HEALTH_PATH, off.read);
    expect(headOff.status).toBe(404);

    const on = await boot();
    const headOn = await request(on.port, 'HEAD', VERSE_HEALTH_PATH);
    expect(headOn.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('module failures', () => {
  it('a module that throws is a message-free 500 — no path or error text leaks', async () => {
    setMountedApiModulesForTest([fakeModule('health', [VERSE_HEALTH_PATH], 'throw')]);
    const { port, read } = await boot();
    const res = await request(port, 'GET', VERSE_HEALTH_PATH, read);
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ code: 'INTERNAL_ERROR', error: 'internal server error' });
    expect(res.body).not.toContain('boom');
    expect(res.body).not.toContain('secret-path');
  });

  it('a module that throws a VerseError code gets the V1 status mapping', async () => {
    setMountedApiModulesForTest([fakeModule('reasoning', [REASONING_STEPS_PATH], 'throw-coded')]);
    const { port, read } = await boot();
    const res = await request(port, 'GET', REASONING_STEPS_PATH, read);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ code: 'VERSE_INVALID', error: 'bad query' });
  });

  it('a module that fails to load: others still serve, its path is a 503 naming it, and it is retried', async () => {
    let attempts = 0;
    let healthy = false;
    const flaky: MountedApiModule = {
      id: 'health',
      load: async () => {
        attempts += 1;
        if (!healthy) throw new Error(`Cannot find module ${os.homedir()}/x.js`);
        return (await fakeModule('health', [VERSE_HEALTH_PATH]).load());
      },
    };
    setMountedApiModulesForTest([flaky, fakeModule('budget', [VERSE_BUDGET_PATH])]);
    const { port, read } = await boot();

    const budget = await request(port, 'GET', VERSE_BUDGET_PATH, read);
    expect(budget.status).toBe(200);
    expect((budget.json as { module: string }).module).toBe('budget');

    const health = await request(port, 'GET', VERSE_HEALTH_PATH, read);
    expect(health.status).toBe(503);
    expect(health.json).toEqual({
      code: 'API_MODULE_UNAVAILABLE',
      error: 'a route module failed to load',
      unavailable: ['health'],
    });
    expect(health.body).not.toContain('Cannot find module');

    healthy = true;
    const recovered = await request(port, 'GET', VERSE_HEALTH_PATH, read);
    expect(recovered.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it('a successful load is memoized: one load per module across many requests', async () => {
    const { port, read } = await boot();
    for (let i = 0; i < 5; i += 1) await request(port, 'GET', VERSE_BUDGET_PATH, read);
    expect(loads).toEqual(['health', 'reasoning', 'fleet-history', 'budget']);
  });

  it('a loader that resolves to a non-function is a load failure, not a crash', async () => {
    setMountedApiModulesForTest([
      { id: 'health', load: async () => undefined as unknown as ApiModule },
      fakeModule('budget', [VERSE_BUDGET_PATH]),
    ]);
    const { port, read } = await boot();
    expect((await request(port, 'GET', VERSE_BUDGET_PATH, read)).status).toBe(200);
    const res = await request(port, 'GET', VERSE_HEALTH_PATH, read);
    expect(res.status).toBe(503);
    expect((res.json as { unavailable: string[] }).unavailable).toEqual(['health']);
  });
});

// ---------------------------------------------------------------------------
// Direct handler contract
// ---------------------------------------------------------------------------

describe('handleVerseApi contract', () => {
  it('returns false for paths outside every mounted prefix, without loading anything', async () => {
    const res = new FakeResponse();
    const handled = await handleVerseApi(
      { cfg, token: 'x'.repeat(64), allowDispatch: true },
      fakeRequest('GET', '/api/runs'),
      res as unknown as ServerResponse,
      '/api/runs',
      'GET',
    );
    expect(handled).toBe(false);
    expect(res.wrote).toBe(false);
    expect(loads).toEqual([]);
  });
});
