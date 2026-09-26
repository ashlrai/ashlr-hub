/**
 * resources-model — the handle's one-dot summary, the cloud overview's
 * narrowing, and the local wording (unit 3.11 C6).
 */
import { describe, expect, it } from 'vitest';
import { CLOUD_BALANCE_URL } from '../../../../core/cloud/types.js';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import type { ServingRuntimeSnapshot } from '../../../data/api-types.js';
import { capacity, GROK_SEAT, LOCAL_SEAT_V2, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { buildCapacityRows } from '../usage/capacity-strip-model.js';
import { formatUsd, modelContextText, projectCloudCredits, runtimeView, summarizeResources } from './resources-model.js';

const NOW = new Date(2026, 8, 25, 16, 34).getTime();
const RESET = new Date(2026, 8, 26, 23, 46).toISOString();

const ok = (id: string, used: number) => {
  const w = seatWindow({ id: `${id}_primary`, usedPercent: used, resetsAt: RESET });
  return nativeSeat(capacity({ windows: [w], binding: w, usability: used >= 90 ? 'tight' : 'ready', observedAt: new Date(NOW).toISOString() }), { id, engine: 'codex', label: id, accountId: id });
};
const spent = (id: string) => {
  const w = seatWindow({ id: `${id}_primary`, usedPercent: 100, resetsAt: RESET, limitReached: true, measured: false });
  return nativeSeat(capacity({ windows: [w], binding: w, usability: 'exhausted', observedAt: new Date(NOW).toISOString() }), { id, engine: 'codex', label: id, accountId: id });
};
const report = (seatId: string, over: Partial<SeatHealthReport> = {}): SeatHealthReport => ({
  seatId, engine: 'codex', connection: 'connected', checkedAt: new Date(NOW).toISOString(), cliVersion: null, newestCliVersion: null,
  credentialExpiresAt: null, lastRefreshAt: null, resetAt: null, reasons: [], fix: { kind: 'none' }, ...over,
});

function summary(seats: Parameters<typeof buildCapacityRows>[0], health: SeatHealthReport[] | null) {
  return summarizeResources(buildCapacityRows(seats, { health, now: NOW, local: 'hide' }), { healthRead: health !== null, now: NOW });
}

describe('summarizeResources — the edge handle dot', () => {
  it('is ok when every paid account is usable', () => {
    const s = summary([ok('a', 20), ok('b', 40)], [report('a'), report('b')]);
    expect(s).toEqual({ tone: 'ok', spoken: '2 usable' });
  });

  it('is tight when one is running low', () => {
    const s = summary([ok('a', 20), ok('b', 95)], [report('a'), report('b')]);
    expect(s.tone).toBe('tight');
    expect(s.spoken).toBe('1 usable · 1 running low');
  });

  it('is alert when something is spent or signed out — and says which', () => {
    const s = summary([ok('a', 20), spent('b'), GROK_SEAT], [report('a'), report('b', { connection: 'exhausted', resetAt: RESET }), report('grok', { engine: 'grok', connection: 'signed-out', fix: { kind: 'reauth' } })]);
    expect(s.tone).toBe('alert');
    expect(s.spoken).toBe('1 usable · 1 spent · 1 signed out');
  });

  it('draws nothing (unknown) until something was read, and ignores local seats', () => {
    expect(summary([], null)).toEqual({ tone: 'unknown', spoken: 'no accounts connected' });
    expect(summary([LOCAL_SEAT_V2], null).tone).toBe('unknown');
  });
});

describe('projectCloudCredits — GET /api/verse/cloud, narrowed', () => {
  const overview = {
    generatedAt: 'x',
    seat: { id: 'claude-a', ready: true, reason: null },
    budget: {
      creditsTotalUsd: 250, estimatedSpentUsd: 38, estimatedRemainingUsd: 212, sessionsToday: 5, selfImproveToday: 1, running: 2,
      canLaunch: { ok: true, reason: null }, canSelfImprove: { ok: true, reason: null },
      estimateNote: 'Estimated at $3 a session.', balanceUrl: CLOUD_BALANCE_URL,
      budget: { maxSessionsPerDay: 20 },
    },
    tasks: [],
    backlog: { items: [], nextUp: null },
  };

  it('reads remaining of total, running and today, with the server’s own estimate note', () => {
    const c = projectCloudCredits(overview)!;
    expect(c).toMatchObject({ totalUsd: 250, remainingUsd: 212, running: 2, sessionsToday: 5, maxSessionsPerDay: 20, estimateNote: 'Estimated at $3 a session.', balanceUrl: CLOUD_BALANCE_URL, seatReady: true });
    expect(Math.round(c.remainingPercent)).toBe(85);
  });

  it('never links anywhere but claude.ai', () => {
    const c = projectCloudCredits({ ...overview, budget: { ...overview.budget, balanceUrl: 'https://evil.example/usage' } })!;
    expect(c.balanceUrl).toBe(CLOUD_BALANCE_URL);
  });

  it('is null for a body that is not an overview (never a $0 guess)', () => {
    expect(projectCloudCredits(null)).toBeNull();
    expect(projectCloudCredits({})).toBeNull();
    expect(projectCloudCredits({ budget: { creditsTotalUsd: 'lots' } })).toBeNull();
  });

  it('carries the seat’s reason when the launcher is not ready', () => {
    const c = projectCloudCredits({ ...overview, seat: { id: 'claude-a', ready: false, reason: 'Sign in to claude.ai on claude-a.' } })!;
    expect(c.seatReady).toBe(false);
    expect(c.seatReason).toBe('Sign in to claude.ai on claude-a.');
  });

  it('formats dollars', () => {
    expect(formatUsd(212)).toBe('$212');
    expect(formatUsd(3.5)).toBe('$3.50');
    expect(formatUsd(-4)).toBe('$0');
  });
});

describe('local wording', () => {
  const runtime = (over: Partial<ServingRuntimeSnapshot> = {}): ServingRuntimeSnapshot => ({
    kind: 'llama-server', state: 'running', endpoint: '127.0.0.1:8080', model: 'Qwen3-32B', slotsTotal: 4, slotsBusy: 1, contextTokens: 16_384,
    startedAt: null, parallel: { capable: true, refusal: null, slots: 4 }, reason: null, supervised: true, sampledAt: null, ...over,
  });

  it('describes the serving runtime with per-agent context and offers Stop only when supervised', () => {
    expect(runtimeView(runtime())).toMatchObject({ name: 'llama-server', word: 'Running', detail: 'Qwen3 32B · 16k context per agent · 1 of 4 slots busy', canStop: true, canStart: false });
    expect(runtimeView(runtime({ state: 'stopped' }))).toMatchObject({ word: 'Stopped', canStart: true, canStop: false });
    expect(runtimeView(runtime({ supervised: false }))).toMatchObject({ canStart: false, canStop: false, managedElsewhere: true });
    expect(runtimeView(null)).toBeNull();
  });

  it('says both windows when a model runs below its native context', () => {
    expect(modelContextText({ nativeContext: 262_144, configuredContext: 65_536, contextTruncated: true })).toBe('64k of 256k context');
    expect(modelContextText({ nativeContext: 131_072, configuredContext: null, contextTruncated: false })).toBe('128k context');
    expect(modelContextText({ nativeContext: null, configuredContext: null, contextTruncated: false })).toBeNull();
  });
});
