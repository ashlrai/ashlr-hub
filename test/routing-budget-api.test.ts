/**
 * V3.10 unit A9 — `/api/verse/budget*` (src/core/routing/budget-api.ts).
 *
 * Drives the real handler through a real http server (so the mutation gate,
 * body cap and sendJson sanitizer are the production ones) under a relocated
 * HOME, with the capacity source injected — no Ollama, no account collector,
 * no seat is ever prompted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  handleBudgetApi,
  routeSeatShadow,
  setBudgetCapacitySourceForTest,
  setBudgetResetAuthoritySourceForTest,
  setCapacityPublishGateForTest,
  setReadinessSourceForTest,
  startBudgetCapacityPublisher,
  type CapacityReading,
} from '../src/core/routing/budget-api.js';
import { readRecordedForecasts, writeRecordedScheduling } from '../src/core/routing/scheduling-cache.js';
import { forecastWork } from '../src/core/routing/work-estimates.js';
import { buildSchedulingView } from '../src/core/routing/scheduling.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { capacitySnapshotPath, readCapacitySnapshot, readShadowDecisions } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetView } from '../src/core/routing/policy.js';
import type { SeatDecision } from '../src/core/routing/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { sanitizePublicJson } from '../src/core/util/public-json.js';

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
  // A live collector owns the snapshot (see the publish-gate block below for
  // what happens when it does not).
  setCapacityPublishGateForTest(() => true);
  setBudgetResetAuthoritySourceForTest(() => ({ standing: null, authorityState: 'unknown' }));
});

afterEach(() => {
  setBudgetCapacitySourceForTest();
  setBudgetResetAuthoritySourceForTest(null);
  setCapacityPublishGateForTest();
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

describe('allowance before resets settings', () => {
  it('keeps legacy priority distinct from enrollment, then confirms explicit ON and OFF from GET', async () => {
    expect((await get<BudgetView>('/api/verse/budget')).body.resetSpendingStatus?.mode).toBe('legacy-priority');
    for (const enabled of [true, false]) {
      const written = await post<BudgetView>({ resetSpending: { enabled } });
      expect(written.status).toBe(200);
      const read = (await get<BudgetView>('/api/verse/budget')).body;
      expect(read.resetSpending).toEqual({ enabled });
      expect(read.resetSpendingStatus?.mode).toBe(enabled ? 'enabled' : 'disabled');
      expect(read.effective.claude?.reservePercent).toBe(40);
      expect(read.resetSpendingStatus?.accounts.claude?.effectiveReservePercent).toBeNull();
    }
  });

  it('saves a per-account exclusion and restores inheritance without enabling global OFF', async () => {
    await post({ resetSpending: { enabled: false } });
    await post({ seatId: 'claude', policy: { resetSpending: true } });
    let read = (await get<BudgetView>('/api/verse/budget')).body;
    expect(read.resetSpendingStatus?.accounts.claude).toMatchObject({ mode: 'enabled', enabled: false, state: 'disabled' });
    await post({ seatId: 'claude', policy: { resetSpending: false } });
    expect((await get<BudgetView>('/api/verse/budget')).body.seats.claude?.resetSpending).toBe(false);
    await post({ seatId: 'claude', policy: { resetSpending: null } });
    read = (await get<BudgetView>('/api/verse/budget')).body;
    expect(read.seats.claude?.resetSpending).toBeUndefined();
    expect(read.resetSpendingStatus?.accounts.claude).toMatchObject({ mode: 'inherit', enabled: false });
  });

  it('shows verified historical floors while paused without claiming task-derived reserve or authority', async () => {
    setBudgetResetAuthoritySourceForTest(() => ({ authorityState: 'paused', standing: { spend: {
      maxMode: 'balanced', meteredUsdPerDay: 0, seats: { claude: { seatId: 'claude', enabled: true,
        reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] } },
    } } }));
    const read = (await post<BudgetView>({ resetSpending: { enabled: true } })).body;
    expect(read.resetSpendingStatus).toMatchObject({ mode: 'enabled', authorityState: 'paused', accounts: {
      claude: { savedReservePercent: 40, signedFloorPercent: 40, effectiveReservePercent: null, state: 'authority-paused', subscriptionOnly: 'unknown' },
    } });
    expect(read.resetSpendingStatus?.accounts.claude?.constraints).toContain('This account has no signed coding-producer role.');
    expect(read.resetSpendingStatus?.accounts.claude?.constraints).toContain('Short-window usage ceiling is 70%.');
  });

  it('does not turn a historical scheduling forecast into a current task admission', async () => {
    const forecast = forecastWork('historical', { engine: 'claude', model: 'fable', taskKind: 'todo', seatId: 'claude' }, []);
    await writeRecordedScheduling(buildSchedulingView(reading.seats,defaultBudgetPolicy(),Date.now(),{claude:forecast}));
    const read = (await post<BudgetView>({ resetSpending: { enabled: true } })).body;
    expect(read.resetSpendingStatus?.accounts.claude?.forecastBasis).toBeNull();
    expect(read.resetSpendingStatus?.accounts.claude?.effectiveReservePercent).toBeNull();
  });

  it('qualifies authority reader failure as unknown, retaining actual saved state', async () => {
    setBudgetResetAuthoritySourceForTest(() => { throw new Error('private path'); });
    const read = (await post<BudgetView>({ resetSpending: { enabled: true } })).body;
    expect(read.resetSpendingStatus?.authorityState).toBe('unknown');
    expect(JSON.stringify(read)).not.toContain('private path');
  });

  it.each([{ resetSpending: { enabled: 'true' } }, { resetSpending: { enabled: true, reservePercent: 0 } },
    { mode: 'all-in', resetSpending: { enabled: true } }, { resetSpending: null }])('refuses invalid global shape %j before collecting or writing', async body => {
    expect((await post(body)).status).toBe(400);
    expect(sourceCalls).toBe(0);
    expect(fs.existsSync(path.join(home, '.ashlr', 'budget.json'))).toBe(false);
  });

  it('requires the existing guarded mutation token for reset settings', async () => {
    expect((await post({ resetSpending: { enabled: true } }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect(sourceCalls).toBe(0);
  });
});

describe('GET /api/verse/budget', () => {
  it('serves the default balanced policy, effective per-seat policies and live headroom', async () => {
    const { status, body } = await get<BudgetView>('/api/verse/budget');
    expect(status).toBe(200);
    expect(body.mode).toBe('balanced');
    expect(body.seats).toEqual({});
    expect(body.seatInfo.map((s) => s.seatId)).toEqual(['claude', 'codex-personal', 'grok', 'local:qwen3.8:27b-ctx64k']);
    expect(body.effective['claude']).toEqual({ seatId: 'claude', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 });
    expect(body.effective['codex-personal']!.enabled).toBe(true);
    const byId = Object.fromEntries(body.headroom.map((h) => [h.seatId, h]));
    expect(byId['claude']).toMatchObject({ eligibleForAutonomy: true, autonomyHeadroomPercent: 40, bindingWindow: 'weekly' });
    expect(byId['codex-personal']).toMatchObject({ eligibleForAutonomy: false });
    expect(byId['codex-personal']!.reasons[0]).toContain('weekly window is spent');
    expect(byId['grok']).toMatchObject({ eligibleForAutonomy: true, autonomyHeadroomPercent: 88 });
    expect(byId['local:qwen3.8:27b-ctx64k']).toMatchObject({ eligibleForAutonomy: true, autonomyHeadroomPercent: 100 });
    expect(body.readingMaxAgeMs).toBe(15 * 60_000);
  });

  it('preserves qualified weekly deadline and plan in private capacity and cheap GET projection', async () => {
    const deadline=new Date(Date.now()+3600000).toISOString();
    const weekly={kind:'weekly-deadline' as const,at:deadline,description:null,source:'claude-native-usage-report',plan:'max' as const};
    reading.seats[0]!.windows[1]={id:'seven_day',usedPercent:20,resetsAt:deadline,resetDescription:null,limitReached:false,resetProvenance:weekly};
    const {body}=await get<{scheduling:{accounts:Array<{seatId:string;reset:unknown}>}}>('/api/verse/budget');
    expect(readCapacitySnapshot()!.seats[0]!.windows[1]!.resetProvenance).toEqual(weekly);
    expect(body.scheduling.accounts.find(a=>a.seatId==='claude')!.reset).toEqual(weekly);
    expect(sourceCalls).toBe(1);
    expect(weekly).not.toHaveProperty('startsAt');
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
    expect(body.seatId).toBe('local:qwen3.8:27b-ctx64k');
    expect(body.why).toContain('admitted headroom and funding category');
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
    expect(decision!.seatId).toBe('local:qwen3.8:27b-ctx64k');
    const { status, body } = await get<{ decisions: Array<{ source: string; decision: SeatDecision; actual: unknown }> }>(
      '/api/verse/budget/decisions?limit=5');
    expect(status).toBe(200);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]).toMatchObject({ source: 'daemon', actual: { engine: 'claude', seatId: null } });
    const stored = readShadowDecisions(5)[0]!.decision;
    // The private writer scrubs prose too; structured routing identity survives
    // both that boundary and the HTTP response sanitizer.
    expect(stored).toEqual(sanitizePublicJson(decision));
    expect(stored).toMatchObject({ seatId: decision!.seatId, candidates: decision!.candidates, mode: decision!.mode });
    expect(body.decisions[0]!.decision).toEqual(sanitizePublicJson(stored));
    expect(body.decisions[0]!.decision.seatId).toBe('local:qwen3.8:27b-ctx64k');
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
    try {
      // Wait for the async private-file publication, not an assumed 20ms disk
      // schedule. The publisher's >=30s cadence and stopped-call count remain exact.
      await vi.waitFor(()=>expect(readCapacitySnapshot()?.seats).toHaveLength(4));
    }finally{stop();}
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

describe('capacity publish gate (3.14 — a server with no live collector stays quiet)', () => {
  it('does not write the fleet snapshot while this server has no live collector', async () => {
    setCapacityPublishGateForTest(() => false);
    const { status } = await get('/api/verse/budget');
    expect(status).toBe(200);
    expect(readCapacitySnapshot()).toBeNull();
    const stop = startBudgetCapacityPublisher({} as AshlrConfig, { intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    // Still nothing: an empty-but-fresh snapshot would keep the daemon's own
    // publisher dormant and read every paid seat as "unknown usage".
    expect(readCapacitySnapshot()).toBeNull();
  });

  it('a throwing gate fails closed (no write) and the read still answers', async () => {
    setCapacityPublishGateForTest(() => { throw new Error('status unreadable'); });
    expect((await get('/api/verse/budget')).status).toBe(200);
    expect(readCapacitySnapshot()).toBeNull();
  });

  it('with no collector registered at all, the default gate refuses', async () => {
    setCapacityPublishGateForTest();
    await get('/api/verse/budget');
    expect(readCapacitySnapshot()).toBeNull();
  });
});

describe('GET /api/verse/budget/readiness (3.14)', () => {
  afterEach(() => setReadinessSourceForTest());

  it('serves the readiness response through the same sanitising sendJson, GET only', async () => {
    setReadinessSourceForTest(async () => ({
      v: 1,
      checkedAt: '2026-09-27T00:05:00.000Z',
      autonomy: { active: true, stage: 'shadow', detail: 'Stage 1 of 8 · shadow' },
      capacitySnapshotAt: null,
      resources: [],
    }));
    const { status, body } = await get<{ v: number; autonomy: { stage: string } }>('/api/verse/budget/readiness');
    expect(status).toBe(200);
    expect(body).toMatchObject({ v: 1, autonomy: { stage: 'shadow' } });
    // It refreshes the fleet's snapshot first (the gate allows it here).
    expect(sourceCalls).toBe(1);

    const res = await fetch(`${base}/api/verse/budget/readiness`, { method: 'POST', headers: { 'x-ashlr-token': TOKEN } });
    expect(res.status).toBe(404);
    expect((await get('/api/verse/budget/readiness?x=1')).status).toBe(400);
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


describe('recorded scheduling advisory cache — real private files and cheap HTTP projection',()=>{
  it('reuses a recorded compatible task without history/probe reads and reapplies current reserves',async()=>{
    const forecast=forecastWork('real-selected-task',{engine:'grok-cli',model:'reported-model',seatId:null,taskKind:'todo'},[
      {id:'reported-run',engine:'grok-cli',model:'reported-model',seatId:null,taskKind:'todo',completed:true,durationMs:30000,tokens:900}]);
    await writeRecordedScheduling({...buildSchedulingView(reading.seats,defaultBudgetPolicy(),Date.now(),{grok:forecast}),
      advisory:{observedAt:new Date().toISOString(),state:'skipped',reason:'signed-metered-unavailable'}});
    const response=await get<BudgetView>('/api/verse/budget');
    expect(sourceCalls).toBe(1);expect(response.status).toBe(200);
    expect(response.body.scheduling?.advisory).toMatchObject({state:'skipped',reason:'signed-metered-unavailable'});
    expect(response.body.scheduling?.accounts.find(v=>v.seatId==='grok')?.forecast).toMatchObject({taskId:'real-selected-task',durationMs:{samples:1,p75:30000},cohort:{seatId:null}});
    await post({seatId:'grok',policy:{enabled:false,reservePercent:0}});
    const held=await get<BudgetView>('/api/verse/budget');
    expect(held.body.scheduling?.accounts.find(v=>v.seatId==='grok')?.admission).toBe('held');
  });
  it('malformed, oversized, symlink and unsafe-permission cache never becomes an estimate or breaks budget GET',async()=>{
    const dir=path.join(home,'.ashlr','routing');fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const cache=path.join(dir,'scheduling.json');
    for(const content of ['invalid json',JSON.stringify({accounts:[{seatId:'grok',forecast:{durationMs:{p75:0}}}]}),'x'.repeat(1024*1024+1)]){
      fs.writeFileSync(cache,content,{mode:0o600});expect(await readRecordedForecasts()).toEqual({});
      const response=await get<BudgetView>('/api/verse/budget');expect(response.status).toBe(200);
      expect(response.body.scheduling?.accounts.every(v=>v.forecast===null)).toBe(true);
    }
    fs.unlinkSync(cache);const elsewhere=path.join(home,'elsewhere.json');fs.writeFileSync(elsewhere,'{}');fs.symlinkSync(elsewhere,cache);
    expect(await readRecordedForecasts()).toEqual({});fs.unlinkSync(cache);
    if(process.platform!=='win32'){fs.writeFileSync(cache,'{}',{mode:0o644});expect(await readRecordedForecasts()).toEqual({});}
  });
});
