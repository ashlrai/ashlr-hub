/**
 * decide-core-315 — the shared Jev decision layer (src/core/decide).
 *
 * Every test talks to an in-process FAKE TypeSafe endpoint (a fetch stub —
 * test/helpers/fake-typesafe.ts); none can reach the paid API. What is pinned:
 *   - never a hard dependency: unkeyed / killed / budget-spent → the
 *     deterministic fallback with zero requests;
 *   - confidence gating per kind (registry, config override, call override);
 *   - escalate-only refusal, out-of-vocabulary refusal;
 *   - the input-hash cache (and that kill switches beat it);
 *   - batching: N items → ONE request, per-item gating, cost counted once;
 *   - usage accounting in the ledger (tokens, est. cost, latency, path) with
 *     no classified text in it; the status rollup;
 *   - the key-file fallback honours 0600 only; the production endpoint is
 *     refused under test.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { askTypeSafe, typeSafeAvailable, typeSafeKeyFilePath, TYPESAFE_API_KEY_ENV, TYPESAFE_DISABLE_ENV } from '../src/core/classify/typesafe-client.js';
import { clearDecisionCache } from '../src/core/decide/cache.js';
import { decide, decideEach } from '../src/core/decide/decide.js';
import { JEV_DISABLE_ENV, jevConfigPath, jevLedgerDir, readLedger, resetLedgerCountersForTests } from '../src/core/decide/ledger.js';
import { jevStatus } from '../src/core/decide/status.js';
import { DECISION_KINDS } from '../src/core/decide/registry.js';
import { choice, FAKE_TYPESAFE_ENDPOINT, FAKE_TYPESAFE_KEY, installFakeTypeSafe, noul, type FakeTypeSafe } from './helpers/fake-typesafe.js';

const cfg = { phantom: { enabled: false } } as unknown as AshlrConfig;
const SAVED = { ...process.env };
let fake: FakeTypeSafe;

const Q = {
  intent: {
    type: 'choice' as const,
    instructions: 'classify',
    criteria: { 'status-request': 'asks', directive: 'sets', answer: 'answers', approval: 'yes', veto: 'no', 'task-request': 'work', 'chit-chat': 'social' },
  },
};

let home: string;

beforeEach(() => {
  // A fresh ASHLR_HOME per test: the ledger, jev/config.json and the secrets
  // file all live under it.
  home = mkdtempSync(join(tmpdir(), 'jev-core-'));
  process.env['ASHLR_HOME'] = home;
  clearDecisionCache();
  resetLedgerCountersForTests();
  process.env[TYPESAFE_API_KEY_ENV] = FAKE_TYPESAFE_KEY;
  process.env['ASHLR_TYPESAFE_ENDPOINT'] = FAKE_TYPESAFE_ENDPOINT;
  delete process.env[TYPESAFE_DISABLE_ENV];
  delete process.env[JEV_DISABLE_ENV];
  fake = installFakeTypeSafe();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  for (const k of ['ASHLR_HOME', TYPESAFE_API_KEY_ENV, 'ASHLR_TYPESAFE_ENDPOINT', TYPESAFE_DISABLE_ENV, JEV_DISABLE_ENV]) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

function writeJevConfig(value: unknown): void {
  mkdirSync(join(jevConfigPath(), '..'), { recursive: true });
  writeFileSync(jevConfigPath(), JSON.stringify(value));
}

const intent = (state: string, extra: Record<string, unknown> = {}) =>
  decide<string>('operator-intent', state, Q, { cfg, fallback: 'chit-chat', ...extra });

describe('decide — never a hard dependency', () => {
  it('unkeyed: deterministic fallback, zero requests, no ledger line', async () => {
    delete process.env[TYPESAFE_API_KEY_ENV];
    const d = await intent('how is the fleet doing?');
    expect(d).toMatchObject({ value: 'chit-chat', path: 'fallback', reason: 'no-key', confidence: 1 });
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(readLedger()).toHaveLength(0);
  });

  it('blank input never costs a call', async () => {
    const d = await intent('   ');
    expect(d).toMatchObject({ path: 'fallback', reason: 'no-input' });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('ASHLR_JEV_DISABLE is a kill switch', async () => {
    process.env[JEV_DISABLE_ENV] = '1';
    const d = await intent('status?');
    expect(d).toMatchObject({ path: 'fallback', reason: 'killed' });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('jev/config.json enabled:false and disabledKinds switch off, and a malformed config is the defaults', async () => {
    writeJevConfig({ enabled: false });
    expect((await intent('status?')).reason).toBe('killed');
    writeJevConfig({ disabledKinds: ['operator-intent'] });
    expect((await intent('status?')).reason).toBe('kind-disabled');
    mkdirSync(join(jevConfigPath(), '..'), { recursive: true });
    writeFileSync(jevConfigPath(), '{not json');
    fake.respond(() => ({ intent: choice('status-request', 0.97) }));
    expect((await intent('status?')).path).toBe('jev');
  });

  it('every transport failure falls back with its reason and never throws', async () => {
    const cases: Array<[string, () => void]> = [
      ['network', () => fake.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))],
      ['rate-limited', () => fake.fetch.mockResolvedValueOnce(new Response('', { status: 429 }))],
      ['http-error', () => fake.fetch.mockResolvedValueOnce(new Response('boom', { status: 500 }))],
      ['malformed-response', () => fake.fetch.mockResolvedValueOnce(new Response('<html>', { status: 200 }))],
    ];
    for (const [reason, arm] of cases) {
      clearDecisionCache();
      arm();
      const d = await intent(`message for ${reason}`);
      expect(d, reason).toMatchObject({ value: 'chit-chat', path: 'fallback', reason });
    }
  });

  it('refuses the production TypeSafe endpoint under test, before any request', async () => {
    const res = await askTypeSafe({ state: 'x', questions: Q }, cfg, { endpoint: 'https://api.typesafe.ai/v1/systemone' });
    expect(res).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

describe('decide — confidence gates', () => {
  it('uses the registry threshold per kind and records the near-miss', async () => {
    expect(DECISION_KINDS['operator-intent'].threshold).toBe(0.8);
    fake.respond(() => ({ intent: choice('directive', 0.79) }));
    const d = await intent('focus on the charts');
    expect(d).toMatchObject({ value: 'chit-chat', path: 'fallback', reason: 'below-threshold', jevLabel: 'directive', jevConfidence: 0.79, threshold: 0.8 });
    fake.respond(() => ({ intent: choice('directive', 0.8) }));
    const d2 = await intent('focus on the charts please');
    expect(d2).toMatchObject({ value: 'directive', path: 'jev', confidence: 0.8 });
  });

  it('a config threshold overrides the registry; a call threshold overrides both; 0 is refused', async () => {
    writeJevConfig({ thresholds: { 'operator-intent': 0.95, 'task-class': 0 } });
    fake.respond(() => ({ intent: choice('directive', 0.9) }));
    expect((await intent('stop the lint work')).reason).toBe('below-threshold');
    expect((await intent('stop the lint work now', { threshold: 0.85 })).path).toBe('jev');
    // A 0 threshold would accept coin-flips; it is ignored, not obeyed.
    const { effectiveThreshold } = await import('../src/core/decide/decide.js');
    expect(effectiveThreshold('task-class')).toBe(DECISION_KINDS['task-class'].threshold);
  });

  it('an invented label is no answer', async () => {
    fake.respond(() => ({ intent: choice('world-domination', 0.99) }));
    expect(await intent('hello')).toMatchObject({ path: 'fallback', reason: 'no-answer' });
  });

  it('escalate-only: a less cautious answer is refused, a more cautious one accepted', async () => {
    const rank = (v: string) => (v === 'A' ? 0 : v === 'B' ? 1 : 2);
    const q = { action_class: { type: 'choice' as const, instructions: 'c', criteria: { A: 'a', B: 'b', C: 'c' } } };
    fake.respond(() => ({ action_class: choice('A', 0.99) }));
    const down = await decide<string>('action-class', 'close PR 12', q, { cfg, fallback: 'B', escalateOnly: rank });
    expect(down).toMatchObject({ value: 'B', path: 'fallback', reason: 'escalate-only', jevLabel: 'A' });
    fake.respond(() => ({ action_class: choice('C', 0.99) }));
    const up = await decide<string>('action-class', 'raise budget to max', q, { cfg, fallback: 'B', escalateOnly: rank });
    expect(up).toMatchObject({ value: 'C', path: 'jev' });
  });
});

describe('decide — cache and budget', () => {
  it('the same input is answered once, then from the cache', async () => {
    fake.respond(() => ({ intent: choice('status-request', 0.97) }));
    const a = await intent('what shipped today?');
    const b = await intent('what shipped today?');
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(a.cached).toBe(false);
    expect(b).toMatchObject({ cached: true, path: 'jev', value: 'status-request' });
    const lines = readLedger();
    expect(lines.map((l) => [l.cached, l.called])).toEqual([[false, true], [true, false]]);
  });

  it('kill switches beat the cache', async () => {
    fake.respond(() => ({ intent: choice('status-request', 0.97) }));
    await intent('what shipped today?');
    process.env[TYPESAFE_DISABLE_ENV] = '1';
    expect((await intent('what shipped today?')).reason).toBe('disabled');
    delete process.env[TYPESAFE_DISABLE_ENV];
    process.env[JEV_DISABLE_ENV] = 'true';
    expect((await intent('what shipped today?')).reason).toBe('killed');
  });

  it('failures are not cached', async () => {
    fake.fetch.mockRejectedValueOnce(new Error('offline'));
    expect((await intent('hi there')).reason).toBe('network');
    fake.respond(() => ({ intent: choice('chit-chat', 0.99) }));
    expect((await intent('hi there')).path).toBe('jev');
    expect(fake.fetch).toHaveBeenCalledTimes(2);
  });

  it('stops paying at the daily call budget', async () => {
    writeJevConfig({ dailyCallBudget: 2 });
    fake.respond(() => ({ intent: choice('chit-chat', 0.99) }));
    await intent('one');
    await intent('two');
    const third = await intent('three');
    expect(third).toMatchObject({ path: 'fallback', reason: 'budget-exhausted' });
    expect(fake.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('decide — usage accounting', () => {
  it('records path, tokens, est. cost and latency — never the classified text', async () => {
    fake.respond(() => ({ intent: choice('task-request', 0.93) }));
    const secretish = 'fix the thing in /Users/mason/private/token-abc123';
    await intent(secretish);
    const [line] = readLedger();
    expect(line).toMatchObject({ kind: 'operator-intent', path: 'jev', called: true, label: 'task-request', jevConfidence: 0.93, model: 'jev-fake-1.0' });
    expect(line!.inputTokens).toBeGreaterThan(0);
    expect(line!.outputTokens).toBe(20);
    expect(line!.estCostUsd).toBeGreaterThan(0);
    const raw = readdirSync(jevLedgerDir()).map((f) => readFileSync(join(jevLedgerDir(), f), 'utf8')).join('');
    expect(raw).not.toContain('token-abc123');
    expect(raw).not.toContain(FAKE_TYPESAFE_KEY);
  });

  it('sends the key only in the Authorization header', async () => {
    fake.respond(() => ({ intent: choice('chit-chat', 0.99) }));
    await intent('thanks!');
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${FAKE_TYPESAFE_KEY}`);
    expect(JSON.stringify({ ...fake.calls[0], authorization: null })).not.toContain(FAKE_TYPESAFE_KEY);
  });

  it('status rolls the ledger up by kind', async () => {
    fake.respond((req) => ('intent' in req.questions ? { intent: choice('status-request', 0.9) } : {}));
    await intent('status one');
    await intent('status two');
    fake.respond(() => ({ intent: choice('status-request', 0.5) }));
    await intent('status three');
    const s = jevStatus(cfg);
    expect(s).toMatchObject({ enabled: true, keyed: true, decisionsToday: 3, callsToday: 3 });
    expect(s.fallbackRateToday).toBeCloseTo(1 / 3);
    expect(s.avgConfidenceToday).toBeCloseTo((0.9 + 0.9 + 0.5) / 3);
    const k = s.byKind.find((x) => x.kind === 'operator-intent')!;
    expect(k).toMatchObject({ decisions: 3, jev: 2, fallback: 1, calls: 3 });
    expect(k.topFallbackReasons).toEqual([{ reason: 'below-threshold', count: 1 }]);
    expect(s.estCostUsdToday).toBeGreaterThan(0);
  });
});

describe('decideEach — many items, one call', () => {
  const Q1 = { type: 'choice' as const, instructions: 'kind?', criteria: { 'bug-fix': 'b', feature: 'f', other: 'o' } };

  it('asks N items in ONE request and gates each independently', async () => {
    fake.respond((req) => {
      expect(Object.keys(req.questions)).toEqual(['item_1', 'item_2', 'item_3']);
      expect(req.state).toContain('[item_2]');
      return { item_1: choice('bug-fix', 0.99), item_2: choice('feature', 0.4), item_3: choice('nonsense', 0.99) };
    });
    const out = await decideEach<string>('task-class', [
      { id: 'a', text: 'Stop the dashboard double-counting merges', fallback: 'other' },
      { id: 'b', text: 'Maybe tweak things', fallback: 'other' },
      { id: 'c', text: 'Add a thing', fallback: 'feature' },
    ], Q1, { cfg });
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(out.map((d) => [d.value, d.path, d.reason ?? null])).toEqual([
      ['bug-fix', 'jev', null],
      ['other', 'fallback', 'below-threshold'],
      ['feature', 'fallback', 'no-answer'],
    ]);
    const lines = readLedger();
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.called)).toHaveLength(1);
    expect(lines.filter((l) => (l.estCostUsd ?? 0) > 0)).toHaveLength(1);
  });

  it('chunks at 10 items per call and skips blank items', async () => {
    fake.answerAll({ confidence: 0.99 });
    const items = Array.from({ length: 13 }, (_, i) => ({ id: String(i), text: i === 5 ? ' ' : `task ${i}`, fallback: 'other' }));
    const out = await decideEach<string>('task-class', items, Q1, { cfg });
    expect(fake.fetch).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(13);
    expect(out[5]).toMatchObject({ path: 'fallback', reason: 'no-input' });
    expect(out[0]).toMatchObject({ path: 'jev', value: 'bug-fix' });
  });
});

describe('key file fallback', () => {
  it('reads TYPESAFE_API_KEY from a private 0600 secrets file, and refuses a group/world-readable one', () => {
    delete process.env[TYPESAFE_API_KEY_ENV];
    expect(typeSafeAvailable(cfg)).toBe(false);
    const path = typeSafeKeyFilePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `# typesafe\nexport ${TYPESAFE_API_KEY_ENV}="${FAKE_TYPESAFE_KEY}"\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(typeSafeAvailable(cfg)).toBe(true);
    chmodSync(path, 0o644);
    expect(typeSafeAvailable(cfg)).toBe(false);
  });

  it('the file key is what goes in the header', async () => {
    delete process.env[TYPESAFE_API_KEY_ENV];
    const path = typeSafeKeyFilePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${TYPESAFE_API_KEY_ENV}=${FAKE_TYPESAFE_KEY}-file\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    fake.respond(() => ({ retry: noul(0.9) }));
    await askTypeSafe({ state: 'x', questions: { retry: { type: 'noul', instructions: 'q' } } }, cfg, { endpoint: FAKE_TYPESAFE_ENDPOINT });
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${FAKE_TYPESAFE_KEY}-file`);
  });
});
