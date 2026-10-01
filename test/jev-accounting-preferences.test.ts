import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costEstimate, jevConfigPath, readJevConfig, updateJevCallBudget, resetLedgerCountersForTests, readLedger } from '../src/core/decide/ledger.js';
import { jevStatusFromRecords } from '../src/core/decide/status.js';
import { decide } from '../src/core/decide/decide.js';
import { clearDecisionCache } from '../src/core/decide/cache.js';
import { handleJevApi, resetJevApiCacheForTests } from '../src/core/decide/jev-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { DecisionRecord } from '../src/core/decide/types.js';
import { choice, installFakeTypeSafe, FAKE_TYPESAFE_KEY, FAKE_TYPESAFE_ENDPOINT, type FakeTypeSafe } from './helpers/fake-typesafe.js';
let home: string;
let fake: FakeTypeSafe;
const cfg = { phantom: { enabled: false } } as unknown as AshlrConfig;
const meta = { enabled: true, keyed: true, day: '2026-10-01', dailyCallBudget: null, disabledKinds: [] };
const record = (extra: Partial<DecisionRecord> = {}): DecisionRecord => ({ ts: '2026-10-01T10:00:00Z', kind: 'resource-choice', path: 'jev', cached: false, called: true, confidence: 0.99, jevConfidence: 0.99, durationMs: 10, ...extra });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jev-accounting-'));
  vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('TYPESAFE_API_KEY', FAKE_TYPESAFE_KEY); vi.stubEnv('ASHLR_TYPESAFE_ENDPOINT', FAKE_TYPESAFE_ENDPOINT); vi.stubEnv('ASHLR_JEV_DISABLE', ''); vi.stubEnv('ASHLR_CLASSIFY_DISABLE', '');
  fake = installFakeTypeSafe(); resetLedgerCountersForTests(); clearDecisionCache(); resetJevApiCacheForTests();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
function config(raw: unknown) { mkdirSync(join(jevConfigPath(), '..'), { recursive: true }); writeFileSync(jevConfigPath(), JSON.stringify(raw)); }
function ask(state: string) { return decide('resource-choice', state, { resource_choice: { type: 'choice', instructions: 'choose', criteria: { c0: 'eligible' } } }, { cfg, fallback: null, cache: false }); }

it('published concrete price is model-qualified, API input paid/output free, operator rates explicit', () => {
  expect(costEstimate(1_000_000, 99, readJevConfig(), 'jev-1.13.0')).toEqual({ usd: 0.042, source: 'published-model' });
  expect(costEstimate(0, 999, readJevConfig(), 'jev-1.13.0')).toEqual({ usd: 0, source: 'published-model' });
  for (const model of ['jev-latest', 'jev-preview', 'jev-future', undefined]) expect(costEstimate(10, 20, readJevConfig(), model)).toBeNull();
  config({ inputUsdPerMTok: 1, outputUsdPerMTok: 2 });
  expect(costEstimate(1_000_000, 1_000_000, readJevConfig(), 'unknown-model')).toEqual({ usd: 3, source: 'operator-rates' });
  expect(costEstimate(-1, 2, readJevConfig(), 'jev-1.13.0')).toBeNull();
  expect(costEstimate(1.5, 2, readJevConfig(), 'jev-1.13.0')).toBeNull();
});
it('actual concrete response and valid usage record price; unknown model/usage never invents zero', async () => {
  fake.respond(() => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { resource_choice: choice('c0', 0.99) }, usage: { input_tokens: 1_000_000, output_tokens: 0 } }), { status: 200 }));
  await ask('published');
  expect(readLedger()[0]).toMatchObject({ inputTokens: 1_000_000, outputTokens: 0, estCostUsd: 0.042, costSource: 'published-model' });
  fake.respond(() => ({ resource_choice: choice('c0', 0.99) })); await ask('unknown model');
  expect(readLedger()[1]).not.toHaveProperty('estCostUsd');
  fake.respond(() => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { resource_choice: choice('c0', 0.99) }, usage: { input_tokens: -1, output_tokens: 0.5 } }), { status: 200 }));
  await ask('invalid usage');
  expect(readLedger()[2]).not.toHaveProperty('inputTokens'); expect(readLedger()[2]).not.toHaveProperty('estCostUsd');
});
it('rollup preserves historical recorded estimates, excludes cached charges and reports missing usage/cost as unknown', () => {
  const old = record({ inputTokens: 10, outputTokens: 2, estCostUsd: 4 });
  const cached = record({ called: false, cached: true, estCostUsd: 999, inputTokens: 999 });
  expect(jevStatusFromRecords([old, cached], meta)).toMatchObject({ inputTokensToday: 10, outputTokensToday: 2, estCostUsdToday: 4, costCoverage: { pricedCalls: 1, unknownCalls: 0 } });
  const incomplete = jevStatusFromRecords([old, record({ ts: '2026-10-01T11:00:00Z', jevConfidence: undefined, path: 'fallback' })], meta);
  expect(incomplete).toMatchObject({ inputTokensToday: null, outputTokensToday: null, estCostUsdToday: null, usageCoverage: { reportedCalls: 1, unknownCalls: 1 }, costCoverage: { pricedCalls: 1, unknownCalls: 1 }, lastSuccessfulCallAt: old.ts });
  expect(incomplete.byKind[0].estCostUsd).toBeNull();
  expect(jevStatusFromRecords([record({ inputTokens: 0, outputTokens: 0, estCostUsd: 0 })], meta).estCostUsdToday).toBe(0);
  expect(jevStatusFromRecords([], meta)).toMatchObject({ estCostUsdToday: 0, inputTokensToday: 0, lastSuccessfulCallAt: null });
});
it('null skips call-count preference, zero remains stopcalls and absent retains 1500; writes preserve other settings', async () => {
  expect(readJevConfig().dailyCallBudget).toBe(1500);
  config({ enabled: true, disabledKinds: ['lane-choice'], future: { preserved: true }, inputUsdPerMTok: 2 });
  updateJevCallBudget(null);
  expect(JSON.parse(readFileSync(jevConfigPath(), 'utf8'))).toEqual({ enabled: true, disabledKinds: ['lane-choice'], future: { preserved: true }, inputUsdPerMTok: 2, dailyCallBudget: null });
  fake.respond(() => ({ resource_choice: choice('c0', 0.99) }));
  expect((await ask('one')).path).toBe('jev'); expect((await ask('two')).path).toBe('jev');
  updateJevCallBudget(0); expect((await ask('three')).reason).toBe('budget-exhausted'); expect(fake.calls).toHaveLength(2);
  if (process.platform !== 'win32') expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
});
it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, '100', {}, undefined])('invalid preference %j refuses without touching file', (value) => {
  config({ enabled: false }); const before = readFileSync(jevConfigPath());
  expect(() => updateJevCallBudget(value)).toThrow(); expect(readFileSync(jevConfigPath())).toEqual(before);
});
it('unreadable, malformed and final symlink config are preserved', () => {
  config({}); writeFileSync(jevConfigPath(), '{malformed'); expect(() => updateJevCallBudget(null)).toThrow(); expect(readFileSync(jevConfigPath(), 'utf8')).toBe('{malformed');
  rmSync(jevConfigPath()); const target = join(home, 'target'); writeFileSync(target, '{}'); symlinkSync(target, jevConfigPath());
  expect(() => updateJevCallBudget(null)).toThrow(); expect(readFileSync(target, 'utf8')).toBe('{}');
  rmSync(target); expect(() => updateJevCallBudget(null)).toThrow();
});

async function post(body: unknown, options: { allow?: boolean; token?: string; contentType?: string } = {}) {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.headers = { 'x-ashlr-token': options.token ?? 'test-token', 'content-type': options.contentType ?? 'application/json' };
  let status = 0; let response: unknown;
  const res = { writeHead(code: number) { status = code; }, end(raw: string) { response = JSON.parse(raw); } } as unknown as ServerResponse;
  await handleJevApi({ cfg, token: 'test-token', allowDispatch: options.allow ?? true } as never, req, res, '/api/verse/jev/config', 'POST');
  return { status, response };
}
describe('operator preference API', () => {
  it('is capability-gated and protected by dispatch, token and JSON before any write', async () => {
    expect((await post({ dailyCallBudget: null }, { allow: false })).status).toBe(404);
    expect((await post({ dailyCallBudget: null }, { token: 'wrong' })).status).toBe(401);
    expect((await post({ dailyCallBudget: null }, { contentType: 'text/plain' })).status).toBe(415);
    expect(readJevConfig().dailyCallBudget).toBe(1500); expect(fake.fetch).not.toHaveBeenCalled();
  });
  it('saves only exact supported fields, reads back null/zero and refuses malformed/unknown without mutation', async () => {
    const saved = await post({ dailyCallBudget: null });
    expect(saved.status).toBe(200); expect(saved.response).toMatchObject({ config: { dailyCallBudget: null }, status: { dailyCallBudget: null } });
    for (const bad of [{ dailyCallBudget: -1 }, { dailyCallBudget: 1.5 }, { enabled: false }, { dailyCallBudget: 3, extra: true }, null]) expect((await post(bad)).status).toBe(400);
    expect(readJevConfig().dailyCallBudget).toBeNull(); expect((await post({ dailyCallBudget: 0 })).status).toBe(200); expect(readJevConfig().dailyCallBudget).toBe(0);
    writeFileSync(jevConfigPath(), '{bad'); const unavailable = await post({ dailyCallBudget: 3 });
    expect(unavailable.status).toBe(503); expect(JSON.stringify(unavailable.response)).not.toContain(home); expect(readFileSync(jevConfigPath(), 'utf8')).toBe('{bad');
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});
