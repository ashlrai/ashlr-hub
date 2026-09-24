/**
 * V3.10 contract lock (unit A0). These shapes are what every 3.10 unit codes
 * against, so this file pins:
 *   - the transient/persisted split of the new VerseEvent members;
 *   - that every pre-3.10 record still typechecks unchanged (additive only);
 *   - the public constants of health / routing / reasoning contracts;
 *   - browser safety: the contract files the web bundle imports have no
 *     runtime imports at all (a stray `node:fs` would break the web build).
 *
 * Pure: no disk writes, no HOME access (test/setup/home.ts isolates HOME anyway).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  VERSE_ERROR_CODES,
  VERSE_TRANSIENT_EVENT_TYPES,
  isTransientVerseEvent,
  type VerseEvent,
  type VerseEventType,
  type VersePersistedEvent,
  type VersePreferences,
  type VerseTransientEvent,
} from '../src/core/verse/types.js';
import {
  SEAT_CONNECTIONS,
  SEAT_NOT_READY_CODE,
  VERSE_HEALTH_PATH,
  type SeatConnection,
  type SeatHealthReport,
  type SeatNotReadyResponse,
  type SeatReadiness,
  type VerseHealthResponse,
} from '../src/core/verse/health-types.js';
import {
  BUDGET_MODES,
  VERSE_BUDGET_PATH,
  type BudgetMode,
  type BudgetPolicy,
  type BudgetResponse,
  type BudgetUpdateRequest,
  type RoutingRequest,
  type SeatDecision,
} from '../src/core/routing/types.js';
import {
  REASONING_DIGEST_PATH,
  REASONING_FEATURE_RETENTION_DAYS,
  REASONING_STEPS_MAX_LIMIT,
  REASONING_STEPS_PATH,
  REASONING_TEXT_MAX_BYTES,
  REASONING_TEXT_RETENTION_DAYS,
  type ReasoningDigest,
  type ReasoningStepV1,
} from '../src/core/reasoning/types.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const AT = '2026-09-24T12:00:00.000Z';

describe('VerseEvent 3.10 additions', () => {
  it('marks exactly the four live-only types as transient', () => {
    expect([...VERSE_TRANSIENT_EVENT_TYPES].sort()).toEqual(
      ['progress', 'status', 'thinking-delta', 'thinking-progress'],
    );
    for (const persisted of ['thinking', 'error', 'recovered', 'history-truncated', 'text-delta', 'turn-done'] as const) {
      expect(VERSE_TRANSIENT_EVENT_TYPES.has(persisted)).toBe(false);
    }
  });

  it('isTransientVerseEvent narrows by type', () => {
    const live: VerseEvent = { seq: 4, at: AT, type: 'progress', turnId: 't1', phase: 'tool', tool: 'Bash', elapsedMs: 14_000 };
    const kept: VerseEvent = { seq: 5, at: AT, type: 'recovered', turnId: 't1', how: 'handoff', message: 'resumed from handoff note' };
    expect(isTransientVerseEvent(live)).toBe(true);
    expect(isTransientVerseEvent(kept)).toBe(false);
    if (isTransientVerseEvent(live)) expectTypeOf(live).toMatchTypeOf<VerseTransientEvent>();
  });

  it('builds every new member with its contract fields', () => {
    const events: VerseEvent[] = [
      { seq: 1, at: AT, type: 'thinking-delta', turnId: 't1', text: 'Considering the test' },
      { seq: 1, at: AT, type: 'thinking-progress', turnId: 't1', estimatedTokens: 1800 },
      { seq: 1, at: AT, type: 'progress', turnId: 't1', phase: 'writing', elapsedMs: 900, outTokens: 120, tokPerSec: 38 },
      { seq: 1, at: AT, type: 'progress', turnId: 't1', phase: 'waiting', elapsedMs: 0 },
      { seq: 1, at: AT, type: 'status', turnId: 't1', kind: 'retry', message: 'API retry 1/10' },
      { seq: 1, at: AT, type: 'status', turnId: null, kind: 'watchdog', message: 'no output for 3 minutes' },
      { seq: 2, at: AT, type: 'recovered', turnId: null, how: 'new-native-session', message: 'native thread was missing' },
      { seq: 3, at: AT, type: 'history-truncated', turnId: null, droppedBefore: 120 },
      { seq: 4, at: AT, type: 'thinking', turnId: 't1', text: '', redacted: true, durationMs: 12_000, kind: 'summary' },
      { seq: 5, at: AT, type: 'error', turnId: 't1', message: 'Session ID already in use', code: 'session-in-use' },
    ];
    expect(events.filter(isTransientVerseEvent)).toHaveLength(6);
    expect(VERSE_ERROR_CODES).toEqual(['native-thread-missing', 'session-in-use']);
  });

  it('keeps every pre-3.10 record shape valid (additive only)', () => {
    // Exactly the shapes 3.9 wrote to disk — no new fields.
    const legacy: VersePersistedEvent[] = [
      { seq: 1, at: AT, type: 'user-message', turnId: 't1', text: 'hi' },
      { seq: 2, at: AT, type: 'turn-started', turnId: 't1', pid: null },
      { seq: 3, at: AT, type: 'text-delta', turnId: 't1', text: 'he' },
      { seq: 4, at: AT, type: 'thinking', turnId: 't1', text: 'hmm' },
      { seq: 5, at: AT, type: 'assistant-message', turnId: 't1', text: 'hello' },
      { seq: 6, at: AT, type: 'tool-use', turnId: 't1', toolUseId: 'u1', name: 'Read', input: {} },
      { seq: 7, at: AT, type: 'tool-result', turnId: 't1', toolUseId: 'u1', output: 'ok', isError: false },
      { seq: 8, at: AT, type: 'error', turnId: null, message: 'boom' },
      { seq: 9, at: AT, type: 'cancelled', turnId: 't1' },
      { seq: 10, at: AT, type: 'compaction', turnId: null, trigger: 'auto', preTokens: null, postTokens: null, durationMs: null },
      { seq: 11, at: AT, type: 'context', turnId: 't1', contextTokens: 10, contextWindow: null, exact: true },
      { seq: 12, at: AT, type: 'turn-done', turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1 },
    ];
    expect(legacy.some(isTransientVerseEvent)).toBe(false);
    const prefs: VersePreferences = { version: 1, seats: {}, memory: { enabled: true, disabledProjects: [] } };
    expect(prefs.thinkingDisplay).toBeUndefined();
  });

  it('every VerseEventType is either transient or persisted, never both', () => {
    expectTypeOf<VerseTransientEvent | VersePersistedEvent>().toEqualTypeOf<VerseEvent>();
    expectTypeOf<Extract<VerseTransientEvent, VersePersistedEvent>>().toBeNever();
    expectTypeOf<VerseTransientEvent['type']>().toEqualTypeOf<'thinking-delta' | 'thinking-progress' | 'progress' | 'status'>();
    expectTypeOf<'recovered' | 'history-truncated'>().toMatchTypeOf<VerseEventType>();
  });
});

describe('health contract', () => {
  it('pins connection states, route and 409 code', () => {
    expect(SEAT_CONNECTIONS).toEqual(['connected', 'expiring', 'signed-out', 'exhausted', 'binary-skew', 'unknown']);
    expectTypeOf<(typeof SEAT_CONNECTIONS)[number]>().toEqualTypeOf<SeatConnection>();
    expect(VERSE_HEALTH_PATH).toBe('/api/verse/health');
    expect(SEAT_NOT_READY_CODE).toBe('seat-not-ready');
  });

  it('accepts an honest unknown report and a refusal body', () => {
    const report: SeatHealthReport = {
      seatId: 'claude',
      engine: 'claude',
      connection: 'unknown',
      checkedAt: AT,
      cliVersion: null,
      newestCliVersion: null,
      credentialExpiresAt: null,
      lastRefreshAt: null,
      resetAt: null,
      reasons: ['status command timed out'],
      fix: { kind: 'none' },
    };
    const body: VerseHealthResponse = { checkedAt: AT, seats: [report] };
    const readiness: SeatReadiness = { seatId: 'codex-personal', ready: false, reason: 'usage exhausted', alternatives: ['grok'] };
    const refusal: SeatNotReadyResponse = { error: 'Codex is out of usage', code: SEAT_NOT_READY_CODE, readiness };
    expect(body.seats[0]?.fix.command).toBeUndefined();
    expect(refusal.readiness.alternatives).toEqual(['grok']);
  });
});

describe('routing contract', () => {
  it('pins budget modes and route', () => {
    expect(BUDGET_MODES).toEqual(['all-in', 'balanced', 'reserve']);
    expectTypeOf<(typeof BUDGET_MODES)[number]>().toEqualTypeOf<BudgetMode>();
    expect(VERSE_BUDGET_PATH).toBe('/api/verse/budget');
  });

  it('accepts the balanced default shape, a decision and both update forms', () => {
    const policy: BudgetPolicy = {
      mode: 'balanced',
      seats: {
        claude: { seatId: 'claude', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 },
        grok: { seatId: 'grok', enabled: true, reservePercent: 0 },
        'codex-personal': { seatId: 'codex-personal', enabled: false, reservePercent: 0 },
      },
      updatedAt: AT,
    };
    const response: BudgetResponse = { ...policy, headroom: [] };
    const req: RoutingRequest = { task: 'code', difficulty: 'medium', autonomous: true };
    const decision: SeatDecision = {
      seatId: null,
      candidates: [],
      exclusions: [{ seatId: 'claude', reasons: ['usage unknown'], nextEligibleAt: null }],
      why: 'No seat has known headroom',
      mode: 'balanced',
    };
    const updates: BudgetUpdateRequest[] = [{ mode: 'reserve' }, { seatId: 'claude', policy: { reservePercent: 50 } }];
    expect(response.headroom).toEqual([]);
    expect(req.autonomous).toBe(true);
    expect(decision.seatId).toBeNull();
    expect(updates).toHaveLength(2);
  });
});

describe('reasoning contract', () => {
  it('pins limits, retention and routes', () => {
    expect(REASONING_TEXT_MAX_BYTES).toBe(8 * 1024);
    expect(REASONING_TEXT_RETENTION_DAYS).toBe(30);
    expect(REASONING_FEATURE_RETENTION_DAYS).toBe(180);
    expect(REASONING_STEPS_MAX_LIMIT).toBeGreaterThan(0);
    expect(REASONING_DIGEST_PATH).toBe('/api/reasoning/digest');
    expect(REASONING_STEPS_PATH).toBe('/api/reasoning/steps');
  });

  it('accepts a step and an empty digest', () => {
    const step: ReasoningStepV1 = {
      v: 1,
      id: 'rs_1',
      source: 'verse',
      sessionId: 's1',
      runId: null,
      repo: null,
      engine: 'claude',
      model: null,
      at: AT,
      turnId: 't1',
      kind: 'summary',
      text: 'Checking whether the test covers the edge case',
      tokens: null,
      toolAfter: 'Bash',
      outcome: null,
    };
    const digest: ReasoningDigest = {
      generatedAt: AT,
      window: { from: AT, to: AT },
      totals: { steps: 1, sessions: 1, byEngine: { claude: 1 } },
      insights: [],
      trends: [{ day: '2026-09-24', steps: 1, struggles: 0, wins: 0 }],
    };
    expect(step.v).toBe(1);
    expect(digest.totals.byEngine.claude).toBe(1);
  });
});

describe('api module contract', () => {
  it('has the handleVerseApi signature', () => {
    const noop: ApiModule = async (_ctx, _req, _res, path) => path === '/api/never';
    expectTypeOf(noop).parameters.toEqualTypeOf<[VerseApiContext, IncomingMessage, ServerResponse, string, string]>();
    expectTypeOf(noop).returns.toEqualTypeOf<Promise<boolean>>();
  });
});

describe('browser safety of web-imported contracts', () => {
  // The web bundle imports these; any runtime (non-type) import could drag
  // node built-ins into it. Type-only imports are erased and are fine.
  const files = [
    'src/core/verse/types.ts',
    'src/core/verse/health-types.ts',
    'src/core/routing/types.ts',
    'src/core/reasoning/types.ts',
  ];
  for (const rel of files) {
    it(`${rel} has no runtime imports`, () => {
      const src = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
      const imports = src.split('\n').filter((line) => /^\s*import\s/.test(line));
      for (const line of imports) expect(line).toMatch(/^\s*import\s+type\s/);
      expect(src).not.toMatch(/\brequire\(|\bimport\(/);
    });
  }
});
