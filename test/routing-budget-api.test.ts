/**
 * V3.10 unit A9 — `/api/verse/budget*` (src/core/routing/budget-api.ts).
 *
 * Drives the real handler through a real http server (so the mutation gate,
 * body cap and sendJson sanitizer are the production ones) under a relocated
 * HOME, with the capacity source injected — no Ollama, no account collector,
 * no seat is ever prompted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  handleBudgetApi,
  routeSeatShadow,
  setBudgetCapacitySourceForTest,
  startBudgetCapacityPublisher,
  type CapacityReading,
} from '../src/core/routing/budget-api.js';
import { capacitySnapshotPath, readCapacitySnapshot, readShadowDecisions } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetView } from '../src/core/routing/policy.js';
import type { SeatDecision } from '../src/core/routing/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 'test-mutation-token';
let home: string;
let savedHome: string | undefined;
let server: http.Server;
let base: string;
let ctx: VerseApiContext;
let reading: CapacityReading;
let sourceCalls = 0;

function seats(): SeatCapacity[] {
  const observedAt = new Date(Date.now() - 30_000).toISOString();
  return [
    {
      seatId: 'claude', engine: 'claude', label: 'Claude Code', free: false,
      windows: [
        { id: 'five_hour', usedPercent: 15, resetsAt: null, resetDescription: '7pm (America/New_York)', limitReached: false },
        { id: 'seven_day', usedPercent: 20, resetsAt: null, resetDescription: null, limitReached: false },
      ],
      signedOut: false, reachable: null, contextWindow: 200_000, observedAt, spentTodayUsd: null,
    },
    {
      seatId: 'codex-personal', engine: 'codex', label: 'Personal Codex', free: false,
      windows: [{ id: 'codex_codex_primary', usedPercent: 100, resetsAt: new Date(Date.now() + 30 * 3_600_000).toISOString(), resetDescription: null, limitReached: false }],
      signedOut: false, reachable: null, contextWindow: 272_000, observedAt, spentTodayUsd: null,
    },
    {
      seatId: 'grok', engine: 'grok', label: 'Grok', free: false,
      windows: [{ id: 'grok_unified_weekly', usedPercent: 12, resetsAt: new Date(Date.now() + 72 * 3_600_000).toISOString(), resetDescription: null, limitReached: false }],
      signedOut: false, reachable: null, contextWindow: 256_000, observedAt, spentTodayUsd: null,
    },
    {
      seatId: 'local:qwen3.8:27b-ctx64k', engine: 'local', label: 'Qwen 3.8 27B (local)', free: true,
      windows: [], signedOut: false, reachable: true, contextWindow: 65_536, observedAt: null, spentTodayUsd: null,
    },
  ];
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleBudgetApi(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fallthrough' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-budget-api-'));
  process.env['HOME'] = home;
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  reading = { seats: seats(), sampledAt: new Date().toISOString() };
  sourceCalls = 0;
  setBudgetCapacitySourceForTest(async () => {
    sourceCalls += 1;
    return reading;
  });
});

afterEach(() => {
  setBudgetCapacitySourceForTest();
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function get<T>(p: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function post<T>(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api/verse/budget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe('GET /api/verse/budget', () => {
  it('serves the default balanced policy, effective per-seat policies and live headroom', async () => {
    const { status, body } = await get<BudgetView>('/api/verse/budget');
    expect(status).toBe(200);
    expect(body.mode).toBe('balanced');
    expect(body.seats).toEqual({});
    expect(body.seatInfo.map((s) => s.seatId)).toEqual(['claude', 'codex-personal', 'grok', 'local:qwen3.8:27b-ctx64k']);
    expect(body.effective['claude']).toEqual({ seatId: 'claude', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 });
    expect(body.effective['codex-personal']!.enabled).toBe(false);
    const byId = Object.fromEntries(body.headroom.map((h) => [h.seatId, h]));
    expect(byId['claude']).toMatchObject({ eligibleForAutonomy: true, autonomyHeadroomPercent: 40, bindingWindow: 'weekly' });
    expect(byId['codex-personal']).toMatchObject({ eligibleForAutonomy: false });
    expect(byId['codex-personal']!.reasons[0]).toBe('Autonomy is switched off for this seat.');
    expect(byId['grok']).toMatchObject({ eligibleForAutonomy: true, autonomyHeadroomPercent: 88 });
    expect(byId['local:qwen3.8:27b-ctx64k']).toMatchObject({ eligibleForAutonomy: true, autonomyHeadroomPercent: 100 });
    expect(body.readingMaxAgeMs).toBe(15 * 60_000);
  });

  it('refreshes the capacity snapshot for collector-less readers (0600)', async () => {
    await get('/api/verse/budget');
    const snap = readCapacitySnapshot();
    expect(snap!.seats.map((s) => s.seatId)).toContain('claude');
    expect(fs.statSync(capacitySnapshotPath()).mode & 0o777).toBe(0o600);
  });

  it('refuses unknown query parameters', async () => {
    const { status, body } = await get<{ code: string }>('/api/verse/budget?mode=x');
    expect(status).toBe(400);
    expect(body.code).toBe('VERSE_INVALID');
  });

  it('declines paths outside its family so the next module runs', async () => {
    const { status, body } = await get<{ error: string }>('/api/verse/budgetx');
    expect(status).toBe(404);
    expect(body.error).toBe('fallthrough');
  });

  it('never leaks the home directory', async () => {
    reading = { ...reading, seats: reading.seats.map((s) => (s.seatId === 'grok' ? { ...s, label: `${home}/grok` } : s)) };
    const res = await fetch(`${base}/api/verse/budget`);
    const text = await res.text();
    expect(text).not.toContain(home);
  });
});

describe('POST /api/verse/budget', () => {
  it('switches mode and persists it (0600)', async () => {
    const { status, body } = await post<BudgetView>({ mode: 'reserve' });
    expect(status).toBe(200);
    expect(body.mode).toBe('reserve');
    expect(body.effective['claude']!.reservePercent).toBe(85);
    const file = path.join(home, '.ashlr', 'budget.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await get<BudgetView>('/api/verse/budget')).body.mode).toBe('reserve');
  });

  it('patches one seat and the headroom follows', async () => {
    const { body } = await post<BudgetView>({ seatId: 'claude', policy: { reservePercent: 90 } });
    expect(body.seats['claude']!.reservePercent).toBe(90);
    const claude = body.headroom.find((h) => h.seatId === 'claude')!;
    expect(claude.eligibleForAutonomy).toBe(false);
    expect(claude.reasons[0]).toContain('autonomy stops at 10%');
  });

  it('turns Codex on (and it is still blocked — the window is spent)', async () => {
    const { body } = await post<BudgetView>({ seatId: 'codex-personal', policy: { enabled: true } });
    const codex = body.headroom.find((h) => h.seatId === 'codex-personal')!;
    expect(body.effective['codex-personal']!.enabled).toBe(true);
    expect(codex.eligibleForAutonomy).toBe(false);
    expect(codex.reasons[0]).toContain('is spent');
  });

  it.each([
    [{ mode: 'nope' }, 400],
    [{ mode: 'balanced', extra: 1 }, 400],
    [{ seatId: 'claude', policy: { reservePercent: 500 } }, 400],
    ['{not json', 400],
    [[1, 2], 400],
  ])('refuses %j with %i and writes nothing', async (body, code) => {
    const res = await post<{ code?: string }>(body);
    expect(res.status).toBe(code);
    expect(fs.existsSync(path.join(home, '.ashlr', 'budget.json'))).toBe(false);
  });

  it('is behind the mutation token and JSON content type', async () => {
    expect((await post({ mode: 'reserve' }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await post({ mode: 'reserve' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect(fs.existsSync(path.join(home, '.ashlr', 'budget.json'))).toBe(false);
  });

  it('is a bare 404 when the server does not allow dispatch', async () => {
    ctx = { ...ctx, allowDispatch: false };
    const res = await post<{ error: string; code?: string }>({ mode: 'reserve' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBeUndefined();
  });

  it('caps the body size', async () => {
    const res = await post<{ code: string }>(JSON.stringify({ mode: 'reserve', pad: 'x'.repeat(70 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('other methods are 404', async () => {
    const res = await fetch(`${base}/api/verse/budget`, { method: 'PUT' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/verse/budget/preview', () => {
  it('routes a hypothetical task without logging it', async () => {
    const { status, body } = await get<SeatDecision>('/api/verse/budget/preview?task=code&difficulty=medium&autonomous=true');
    expect(status).toBe(200);
    expect(body.seatId).toBe('grok');
    expect(body.why).toContain('balanced mode prefers Grok');
    expect(readShadowDecisions(10)).toEqual([]);
  });

  it('defaults to medium autonomous code work and honours contextTokens', async () => {
    const { body } = await get<SeatDecision>('/api/verse/budget/preview?task=bulk&contextTokens=60000');
    expect(body.seatId).toBe('grok');
    expect(body.exclusions.find((e) => e.seatId.startsWith('local:'))!.reasons.join(' ')).toContain('60k tokens');
  });

  it.each([
    'task=nope', 'difficulty=extreme', 'autonomous=yes', 'contextTokens=-5', 'contextTokens=1e9', 'task=code&task=plan', 'foo=1',
  ])('refuses %s', async (query) => {
    const { status } = await get(`/api/verse/budget/preview?${query}`);
    expect(status).toBe(400);
  });
});

describe('shadow decisions', () => {
  it('routeSeatShadow logs a decision the decisions route then serves', async () => {
    const decision = await routeSeatShadow({} as AshlrConfig, { task: 'code', difficulty: 'high', autonomous: true }, 'daemon',
      { engine: 'claude', seatId: null });
    expect(decision!.seatId).toBe('claude');
    const { status, body } = await get<{ decisions: Array<{ source: string; decision: SeatDecision; actual: unknown }> }>(
      '/api/verse/budget/decisions?limit=5');
    expect(status).toBe(200);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]).toMatchObject({ source: 'daemon', actual: { engine: 'claude', seatId: null } });
  });

  it('routeSeatShadow never throws when capacity cannot be read', async () => {
    setBudgetCapacitySourceForTest(async () => { throw new Error('collector down'); });
    await expect(routeSeatShadow({} as AshlrConfig, { task: 'code', difficulty: 'low', autonomous: true }, 'gateway')).resolves.toBeNull();
  });

  it('validates limit', async () => {
    expect((await get('/api/verse/budget/decisions?limit=abc')).status).toBe(400);
    expect((await get('/api/verse/budget/decisions?limit=0')).status).toBe(200);
  });
});

describe('capacity publisher', () => {
  it('publishes immediately and stops cleanly', async () => {
    const stop = startBudgetCapacityPublisher({} as AshlrConfig, { intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(sourceCalls).toBe(1); // the interval is clamped to ≥ 30 s; only the immediate tick ran
    expect(readCapacitySnapshot()!.seats).toHaveLength(4);
  });

  it('a failing capacity source is a named 503 on every read, with no detail leaked', async () => {
    setBudgetCapacitySourceForTest(async () => { throw new Error(`secret at ${home}`); });
    for (const p of ['/api/verse/budget', '/api/verse/budget/preview']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain(home);
      expect(text).not.toContain('secret');
      expect(JSON.parse(text)).toEqual({
        code: 'VERSE_BUDGET_CAPACITY_UNREADABLE',
        error: 'Seat capacity could not be read.',
      });
    }
  });
});

describe('read failures are forwarded, not swallowed', () => {
  const policyFile = () => path.join(home, '.ashlr', 'budget.json');
  const decisionsFile = () => path.join(home, '.ashlr', 'routing', 'decisions.jsonl');

  it('GET: an unreadable policy file is a 503 with the plain reason, not the defaults', async () => {
    fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
    fs.writeFileSync(policyFile(), '{ not json', { mode: 0o600 });
    const { status, body } = await get<{ code: string; error: string }>('/api/verse/budget');
    expect(status).toBe(503);
    expect(body.code).toBe('VERSE_STORE_UNREADABLE');
    expect(body.error).toBe('The budget policy file is not valid JSON. Fix or remove it to use the defaults.');
    expect(JSON.stringify(body)).not.toContain(home);
    // The preview routes on the same policy, so it refuses the same way.
    expect((await get<{ code: string }>('/api/verse/budget/preview')).body.code).toBe('VERSE_STORE_UNREADABLE');
  });

  it('GET: a missing policy file is still the defaults (a fresh install is not an error)', async () => {
    const { status, body } = await get<BudgetView>('/api/verse/budget');
    expect(status).toBe(200);
    expect(body.mode).toBe('balanced');
  });

  it('POST: the write refusal for an unreadable policy is a 503 naming the reason, never a bare 500 or the path', async () => {
    fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
    fs.writeFileSync(policyFile(), JSON.stringify({ mode: 'from-the-future' }), { mode: 0o600 });
    const { status, body } = await post<{ code: string; error: string }>({ mode: 'reserve' });
    expect(status).toBe(503);
    expect(body.code).toBe('VERSE_STORE_UNREADABLE');
    expect(body.error).toMatch(/^The budget policy file has a mode this build does not know\. Nothing was saved\. Fix or remove it to use the defaults\.$/);
    expect(JSON.stringify(body)).not.toContain(home);
    expect(JSON.stringify(body)).not.toContain('budget.json');
  });

  it('decisions: an unreadable log is a 503, a missing one is an empty list', async () => {
    expect(await get('/api/verse/budget/decisions')).toEqual({ status: 200, body: { decisions: [] } });
    // A directory where the log should be: open succeeds, it is not a file.
    fs.mkdirSync(decisionsFile(), { recursive: true });
    const { status, body } = await get<{ code: string; error: string }>('/api/verse/budget/decisions');
    expect(status).toBe(503);
    expect(body).toEqual({
      code: 'VERSE_BUDGET_DECISIONS_UNREADABLE',
      error: 'The routing decision log is not a regular file.',
    });
    // The attributor's reader stays total.
    expect(readShadowDecisions(5)).toEqual([]);
  });

  it('decisions: a symlinked log is refused by name', async () => {
    fs.mkdirSync(path.dirname(decisionsFile()), { recursive: true });
    fs.writeFileSync(path.join(home, 'elsewhere.jsonl'), '');
    fs.symlinkSync(path.join(home, 'elsewhere.jsonl'), decisionsFile());
    const { status, body } = await get<{ code: string; error: string }>('/api/verse/budget/decisions');
    expect(status).toBe(503);
    expect(body.error).toBe('The routing decision log is a symlink.');
  });
});
