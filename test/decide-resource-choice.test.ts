import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adviseResourceChoice, resetResourceChoiceCacheForTests } from '../src/core/decide/resource-choice.js';
import { clearDecisionCache } from '../src/core/decide/cache.js';
import { jevConfigPath, jevLedgerDir, localDay, readLedger, resetLedgerCountersForTests } from '../src/core/decide/ledger.js';
import type { ResourceChoiceCandidate } from '../src/core/routing/scheduling-types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { choice, installFakeTypeSafe, FAKE_TYPESAFE_KEY, FAKE_TYPESAFE_ENDPOINT, type FakeTypeSafe } from './helpers/fake-typesafe.js';
const cfg = { phantom: { enabled: false } } as unknown as AshlrConfig;
const digest = createHash('sha256').update('eligible-plan').digest('hex');
let home: string;
let fake: FakeTypeSafe;
const candidate = (i: number): ResourceChoiceCandidate => ({
  id: `private-candidate-${i}`, taskId: `private-task-${i}`, seatId: `private-account-${i}`,
  engine: 'private-engine-sentinel', model: 'private-model-sentinel', taskKind: 'feature',
  headroomPercent: i ? 80 : 50, resetAt: null, durationP75Ms: 1000, reason: 'private-prompt-sentinel',
});
const advise = (cs = [candidate(0), candidate(1)], extra = {}) => adviseResourceChoice(cs, { digest, cfg, endpoint: FAKE_TYPESAFE_ENDPOINT, ...extra });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jev-choice-'));
  vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('TYPESAFE_API_KEY', FAKE_TYPESAFE_KEY);
  vi.stubEnv('ASHLR_TYPESAFE_ENDPOINT', FAKE_TYPESAFE_ENDPOINT); vi.stubEnv('ASHLR_JEV_DISABLE', ''); vi.stubEnv('ASHLR_CLASSIFY_DISABLE', '');
  resetResourceChoiceCacheForTests(); clearDecisionCache(); resetLedgerCountersForTests();
  fake = installFakeTypeSafe(); fake.respond(() => ({ resource_choice: choice('c1', 0.99) }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('eligible resource advice', () => {
  it('selects another admitted pair and never sends or records private identities/text', async () => {
    expect(await advise()).toBe('private-candidate-1');
    expect(fake.calls).toHaveLength(1);
    const wire = JSON.stringify(fake.calls[0]);
    for (const sentinel of ['private-candidate', 'private-task', 'private-account', 'private-engine', 'private-model', 'private-prompt']) expect(wire).not.toContain(sentinel);
    expect(fake.calls[0].questions.resource_choice.criteria).toHaveProperty('c1');
    const records = readLedger();
    expect(records[0]).toMatchObject({ kind: 'resource-choice', path: 'jev', label: 'c1', called: true });
    const content = readFileSync(join(jevLedgerDir(), `${localDay(new Date(records[0].ts))}.jsonl`), 'utf8');
    expect(content).not.toContain('private-');
  });
  it('preserves only closed task kinds and observed fractional duration metadata', async () => {
    expect(await advise([candidate(0), { ...candidate(1), taskKind: 'goal', durationP75Ms: 10.5 }])).toBe('private-candidate-1');
    expect(JSON.parse(fake.calls[0].state)[1]).toMatchObject({ taskKind: 'goal', durationP75Ms: 10.5 });
  });
  it('singleflight/cache makes one selected batch one request, and changed digest invalidates', async () => {
    expect(await Promise.all([advise(), advise(), advise()])).toEqual(Array(3).fill('private-candidate-1'));
    expect(await advise()).toBe('private-candidate-1');
    expect(fake.calls).toHaveLength(1);
    await advise(undefined, { digest: createHash('sha256').update('changed').digest('hex') });
    expect(fake.calls).toHaveLength(2);
  });
  it('kill and current key beat memo reuse', async () => {
    await advise(); vi.stubEnv('ASHLR_JEV_DISABLE', '1'); expect(await advise()).toBeNull();
    vi.stubEnv('ASHLR_JEV_DISABLE', ''); vi.stubEnv('ASHLR_CLASSIFY_DISABLE', '1'); expect(await advise()).toBeNull();
    vi.stubEnv('ASHLR_CLASSIFY_DISABLE', ''); vi.stubEnv('TYPESAFE_API_KEY', ''); expect(await advise()).toBeNull();
    expect(fake.calls).toHaveLength(1);
  });
  it('a kill change while the request is in flight refuses returned advice', async () => {
    let finish: ((r: Response) => void) | undefined;
    fake.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = advise();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    vi.stubEnv('ASHLR_JEV_DISABLE', '1');
    finish!(new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { resource_choice: choice('c1', 0.99) } }), { status: 200 }));
    expect(await pending).toBeNull();
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['low-confidence', 'out-of-set', 'timeout', 'rate-limited'])('%s falls back and is not retried each poll', async (mode) => {
    if (mode === 'timeout') fake.fetch.mockRejectedValueOnce(Object.assign(new Error('abort'), { name: 'AbortError' }));
    else if (mode === 'rate-limited') fake.fetch.mockResolvedValueOnce(new Response('', { status: 429 }));
    else fake.respond(() => ({ resource_choice: choice(mode === 'out-of-set' ? 'c90' : 'c1', mode === 'low-confidence' ? 0.2 : 0.99) }));
    expect(await advise()).toBeNull(); expect(await advise()).toBeNull();
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  });
  it('single/empty/invalid and actual API/request bounds fall back whole inventory without any request', async () => {
    for (const cs of [[], [candidate(0)], [candidate(0), candidate(0)], Array.from({ length: 256 }, (_, i) => candidate(i)), Array.from({ length: 100 }, (_, i) => candidate(i)), [candidate(0), { ...candidate(1), headroomPercent: NaN }], [candidate(0), { ...candidate(1), durationP75Ms: 0 }]]) expect(await advise(cs)).toBeNull();
    expect(await advise(undefined, { digest: 'invalid' })).toBeNull();
    const controller = new AbortController(); controller.abort(); expect(await advise(undefined, { signal: controller.signal })).toBeNull();
    expect(fake.fetch).not.toHaveBeenCalled();
  });
  it('reset expiry, threshold edits and changed eligible identity invalidate reuse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    const cs = [candidate(0), { ...candidate(1), resetAt: '2026-10-01T10:00:01Z' }];
    await advise(cs); vi.setSystemTime(new Date('2026-10-01T10:00:02Z')); await advise(cs);
    expect(fake.calls).toHaveLength(2);
    mkdirSync(join(jevConfigPath(), '..'), { recursive: true }); writeFileSync(jevConfigPath(), JSON.stringify({ thresholds: { 'resource-choice': 1 } }));
    expect(await advise(cs)).toBeNull(); expect(fake.calls).toHaveLength(2); // shared answer cache, newly stricter gate
    expect(await advise([candidate(0), { ...candidate(1), id: 'new-eligible-id' }])).toBeNull();
    expect(fake.calls).toHaveLength(3);
  });
});
