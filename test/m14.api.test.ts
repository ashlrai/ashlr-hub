/**
 * M14 API tests — hermetic, all data-source modules mocked.
 *
 * Tests handleApi() from src/core/web/api.ts:
 *   - GET /api/snapshot returns 200 JSON with correct DashboardSnapshot shape.
 *   - GET /api/runs returns 200 JSON array.
 *   - GET /api/swarms returns 200 JSON array.
 *   - GET /api/pulse?window=7d returns 200 JSON ActivityRollup shape.
 *   - GET /api/run/:id returns 200 when found, 404 when not found.
 *   - GET /api/swarm/:id returns 200 when found, 404 when not found.
 *   - GET /api/genome returns 200 JSON array (loadGenome path).
 *   - GET /api/genome?q=foo returns 200 JSON array (recall path).
 *   - GET /api/events returns SSE stream headers (text/event-stream).
 *   - Non-/api/* routes return false (not handled).
 *   - POST /api/run:
 *       - 404 when allowDispatch is false.
 *       - 401/403 with wrong token when allowDispatch is true.
 *       - 401/403 with missing token when allowDispatch is true.
 *       - Accepted (2xx) with correct token + allowDispatch.
 *   - Never returns secret values in any response.
 *   - All JSON responses have Content-Type: application/json.
 *
 * Uses a real ephemeral server via startServer so handleApi is exercised
 * through the full pipeline (Host-header guard passes on 127.0.0.1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const MOCK_SNAPSHOT = {
  generatedAt: '2026-06-09T00:00:00.000Z',
  repos: { total: 3, dirty: 1, stale: 0 },
  tools: { installed: 2, total: 4 },
  activity: { sessions: 5, tokens: 20000, estCostUsd: 0.42, commits: 11 },
  runs: [
    { id: 'run-001', goal: 'Build X', status: 'done', tokens: 4500 },
  ],
  swarms: [
    { id: 'swarm-001', goal: 'Implement M14', status: 'running', tasksDone: 1, tasksTotal: 3, phase: 'build' },
  ],
  mcp: [{ name: 'ashlr', ok: true, tools: 12 }],
  genome: { entries: 42, projects: 7 },
};

const MOCK_RUNS = [
  {
    id: 'run-001',
    goal: 'Build X',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:05:00.000Z',
    budget: { maxTokens: 50000, maxSteps: 100, allowCloud: false },
    usage: { tokensIn: 3000, tokensOut: 1500, steps: 5, estCostUsd: 0.1 },
    tasks: [],
    steps: [],
    status: 'done' as const,
    result: 'Feature complete.',
  },
];

const MOCK_SWARMS = [
  {
    id: 'swarm-001',
    goal: 'Implement M14',
    specId: null,
    project: '/tmp/ashlr-hub',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T01:00:00.000Z',
    budget: { maxTokens: 200000, maxSteps: 500, allowCloud: false },
    usage: { tokensIn: 5000, tokensOut: 2500, steps: 10, estCostUsd: 0.2 },
    parallel: 3,
    status: 'running' as const,
    plan: { specId: null, goal: 'Implement M14', tasks: [] },
    tasks: [],
  },
];

const MOCK_ROLLUP = {
  window: '7d' as const,
  since: '2026-06-02T00:00:00.000Z',
  totals: { tokensIn: 12000, tokensOut: 8000, estCostUsd: 0.42, sessions: 5, commits: 11 },
  byProject: [],
  byDay: [],
  byModel: [],
  budget: {
    level: 'ok' as const,
    window: '7d',
    spentUsd: 0.42,
    capUsd: null,
    spentTokens: 20000,
    capTokens: null,
    message: 'ok',
  },
};

const MOCK_GENOME_ENTRIES = [
  { id: 'g-0', project: 'proj-a', source: 'project' as const, title: 'Entry 0', text: 'body 0', tags: [], ts: '2026-06-09T00:00:00.000Z' },
  { id: 'g-1', project: 'proj-b', source: 'hub' as const, title: 'Entry 1', text: 'body 1', tags: [], ts: '2026-06-09T00:00:00.000Z' },
];

const MOCK_RECALL_HITS = [
  {
    entry: MOCK_GENOME_ENTRIES[0]!,
    score: 0.9,
    method: 'keyword' as const,
  },
];

vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: vi.fn(async () => MOCK_SNAPSHOT),
}));

vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => MOCK_RUNS),
  loadRun: vi.fn((id: string) => MOCK_RUNS.find(r => r.id === id) ?? null),
  runGoal: vi.fn(async (_goal: string, _cfg: unknown, _opts: unknown) => ({
    id: 'run-dispatched',
    status: 'done',
  })),
}));

vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: vi.fn(() => MOCK_SWARMS),
  loadSwarm: vi.fn((id: string) => MOCK_SWARMS.find(s => s.id === id) ?? null),
}));

vi.mock('../src/core/observability/rollup.js', () => ({
  buildRollup: vi.fn(() => MOCK_ROLLUP),
}));

vi.mock('../src/core/genome/store.js', () => ({
  loadGenome: vi.fn(() => MOCK_GENOME_ENTRIES),
  genomeHealth: vi.fn(async () => ({
    totalEntries: 2, projects: 2, hubEntries: 1, sizeBytes: 512,
    lastLearnedAt: null, embeddingsAvailable: false,
  })),
}));

vi.mock('../src/core/genome/recall.js', () => ({
  recall: vi.fn(async () => MOCK_RECALL_HITS),
}));

vi.mock('../src/cli/run.js', () => ({
  cmdRun: vi.fn(async () => 0),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { startServer } from '../src/core/web/server.js';

// ---------------------------------------------------------------------------
// Config / opts helpers
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
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

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: false, ...overrides };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: data,
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function get(url: string, port: number, extraHeaders: Record<string, string> = {}) {
  return httpRequest('GET', url, { Host: `127.0.0.1:${port}`, ...extraHeaders });
}

function post(url: string, port: number, headers: Record<string, string> = {}, body = '') {
  return httpRequest('POST', url, {
    Host: `127.0.0.1:${port}`,
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    ...headers,
  }, body);
}

// ---------------------------------------------------------------------------
// Track open handles
// ---------------------------------------------------------------------------

let openHandles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  openHandles = [];
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
});

// ---------------------------------------------------------------------------
// GET /api/snapshot
// ---------------------------------------------------------------------------

describe('GET /api/snapshot', () => {
  it('returns 200 with application/json content-type', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/snapshot`, h.port);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
  });

  it('returns a DashboardSnapshot-shaped object', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/snapshot`, h.port);
    const body = JSON.parse(res.body);
    expect(typeof body.generatedAt).toBe('string');
    expect(typeof body.repos).toBe('object');
    expect(typeof body.repos.total).toBe('number');
    expect(Array.isArray(body.runs)).toBe(true);
    expect(Array.isArray(body.swarms)).toBe(true);
    expect(Array.isArray(body.mcp)).toBe(true);
    expect(typeof body.genome).toBe('object');
  });

  it('snapshot body matches mock data', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/snapshot`, h.port);
    const body = JSON.parse(res.body);
    expect(body.repos.total).toBe(3);
    expect(body.activity.sessions).toBe(5);
    expect(body.genome.entries).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// GET /api/runs
// ---------------------------------------------------------------------------

describe('GET /api/runs', () => {
  it('returns 200 with application/json', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/runs`, h.port);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
  });

  it('returns an array', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/runs`, h.port);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it('each run has id, goal, status fields', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/runs`, h.port);
    const body = JSON.parse(res.body);
    expect(body.length).toBeGreaterThan(0);
    for (const run of body) {
      expect(typeof run.id).toBe('string');
      expect(typeof run.goal).toBe('string');
      expect(typeof run.status).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/run/:id
// ---------------------------------------------------------------------------

describe('GET /api/run/:id', () => {
  it('returns 200 for a known run id', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/run/run-001`, h.port);
    expect(res.statusCode).toBe(200);
  });

  it('returns the run object for a known id', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/run/run-001`, h.port);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('run-001');
    expect(body.goal).toBe('Build X');
  });

  it('returns 404 for an unknown run id', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/run/nonexistent-xyz`, h.port);
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/swarms
// ---------------------------------------------------------------------------

describe('GET /api/swarms', () => {
  it('returns 200 with application/json', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/swarms`, h.port);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
  });

  it('returns an array', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/swarms`, h.port);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/swarm/:id
// ---------------------------------------------------------------------------

describe('GET /api/swarm/:id', () => {
  it('returns 200 for a known swarm id', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/swarm/swarm-001`, h.port);
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for an unknown swarm id', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/swarm/nonexistent-swarm`, h.port);
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/pulse
// ---------------------------------------------------------------------------

describe('GET /api/pulse', () => {
  it('returns 200 with application/json', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/pulse?window=7d`, h.port);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
  });

  it('returns an ActivityRollup-shaped object', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/pulse?window=7d`, h.port);
    const body = JSON.parse(res.body);
    expect(typeof body.window).toBe('string');
    expect(typeof body.since).toBe('string');
    expect(typeof body.totals).toBe('object');
    expect(Array.isArray(body.byProject)).toBe(true);
    expect(Array.isArray(body.byDay)).toBe(true);
    expect(Array.isArray(body.byModel)).toBe(true);
    expect(typeof body.budget).toBe('object');
  });

  it('window defaults to 7d when not provided', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/pulse`, h.port);
    expect(res.statusCode).toBe(200);
  });

  it('accepts window=1d', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/pulse?window=1d`, h.port);
    expect(res.statusCode).toBe(200);
  });

  it('accepts window=30d', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/pulse?window=30d`, h.port);
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/genome
// ---------------------------------------------------------------------------

describe('GET /api/genome', () => {
  it('returns 200 for /api/genome (no query — loadGenome path)', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/genome`, h.port);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
  });

  it('returns an array for /api/genome with no query', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/genome`, h.port);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it('returns 200 for /api/genome?q=foo (recall path)', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/genome?q=foo`, h.port);
    expect(res.statusCode).toBe(200);
  });

  it('returns an array for /api/genome?q=foo', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/genome?q=foo`, h.port);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/events — SSE stream
// ---------------------------------------------------------------------------

describe('GET /api/events', () => {
  it('returns text/event-stream content-type', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    // Open an SSE connection and check headers before closing
    const result = await new Promise<{ statusCode: number; contentType: string }>((resolve, reject) => {
      const parsed = new URL(`${h.url}/api/events`);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: Number(parsed.port),
          path: parsed.pathname,
          method: 'GET',
          headers: { Host: `127.0.0.1:${h.port}` },
        },
        (res) => {
          resolve({
            statusCode: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
          });
          // Destroy the connection after we have the headers
          res.destroy();
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        // ECONNRESET is expected when we destroy the stream — treat as success
        // if we already resolved; otherwise reject
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
        reject(err);
      });
      req.end();
    });

    expect(result.statusCode).toBe(200);
    expect(result.contentType).toContain('text/event-stream');
  });
});

// ---------------------------------------------------------------------------
// POST /api/run — dispatch security
// ---------------------------------------------------------------------------

describe('POST /api/run — security invariants', () => {
  it('returns 404 when allowDispatch is false (route does not exist)', async () => {
    const h = await startServer(makeConfig(), makeOpts({ allowDispatch: false }));
    openHandles.push(h);

    const body = JSON.stringify({ goal: 'do something' });
    const res = await post(`${h.url}/api/run`, h.port, {}, body);
    // 404: route does not exist when dispatch disabled
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 or 403 with missing token when allowDispatch is true', async () => {
    const h = await startServer(makeConfig(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const body = JSON.stringify({ goal: 'do something' });
    const res = await post(`${h.url}/api/run`, h.port, {}, body);
    // No token header -> 401 or 403
    expect([401, 403]).toContain(res.statusCode);
  });

  it('returns 401 or 403 with wrong token when allowDispatch is true', async () => {
    const h = await startServer(makeConfig(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const body = JSON.stringify({ goal: 'do something' });
    const res = await post(`${h.url}/api/run`, h.port, {
      'x-ashlr-token': 'wrong-token-value-that-does-not-match',
    }, body);
    expect([401, 403]).toContain(res.statusCode);
  });

  it('returns 401 or 403 with an empty token when allowDispatch is true', async () => {
    const h = await startServer(makeConfig(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const body = JSON.stringify({ goal: 'do something' });
    const res = await post(`${h.url}/api/run`, h.port, {
      'x-ashlr-token': '',
    }, body);
    expect([401, 403]).toContain(res.statusCode);
  });

  it('returns 2xx with the correct token when allowDispatch is true', async () => {
    const h = await startServer(makeConfig(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const body = JSON.stringify({ goal: 'do something safe' });
    const res = await post(`${h.url}/api/run`, h.port, {
      'x-ashlr-token': h.token,
    }, body);
    // Should succeed (200 or 202) — runGoal is mocked
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
  });

  it('POST /api/run 404 response when disabled does not leak the token', async () => {
    const h = await startServer(makeConfig(), makeOpts({ allowDispatch: false }));
    openHandles.push(h);

    const body = JSON.stringify({ goal: 'probe' });
    const res = await post(`${h.url}/api/run`, h.port, {}, body);
    expect(res.body).not.toContain(h.token);
  });

  it('401/403 response body does not contain the session token', async () => {
    const h = await startServer(makeConfig(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const body = JSON.stringify({ goal: 'probe' });
    const res = await post(`${h.url}/api/run`, h.port, {
      'x-ashlr-token': 'wrong-token',
    }, body);
    expect([401, 403]).toContain(res.statusCode);
    expect(res.body).not.toContain(h.token);
  });
});

// ---------------------------------------------------------------------------
// Non-/api/* routes return false (pass-through to static)
// ---------------------------------------------------------------------------

describe('handleApi — non-/api routes not handled', () => {
  it('returns a non-API response for / (served as static)', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/`, h.port);
    // /api/snapshot is 200 json; / is static (200 or 404 depending on assets)
    // The key invariant is that it does NOT return JSON from the API handler
    expect(res.headers['content-type'] ?? '').not.toContain('application/json');
  });

  it('/api/* routes always return application/json (not HTML)', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const endpoints = ['/api/snapshot', '/api/runs', '/api/swarms', '/api/pulse'];
    for (const ep of endpoints) {
      const res = await get(`${h.url}${ep}`, h.port);
      expect(String(res.headers['content-type'] ?? '')).toContain('application/json');
    }
  });
});

// ---------------------------------------------------------------------------
// Security: no secrets in any response
// ---------------------------------------------------------------------------

describe('handleApi — no secrets in any response', () => {
  it('snapshot response does not include internal config values', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/snapshot`, h.port);
    // The response should be metadata-only
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // No session token in body
    expect(body).not.toContain(h.token);
  });

  it('runs response does not include the session token', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/runs`, h.port);
    expect(res.body).not.toContain(h.token);
  });

  it('swarms response does not include the session token', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await get(`${h.url}/api/swarms`, h.port);
    expect(res.body).not.toContain(h.token);
  });
});
