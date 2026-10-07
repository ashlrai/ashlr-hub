/**
 * 3.15 — the Devin fleet launcher (devin/fleet-launcher.ts).
 *
 * The fleet may choose Devin for well-scoped backlog work only when EVERY
 * gate holds, re-checked each tick: KILL off, a standing grant in force, the
 * lane on + Mason's fleet opt-in, the grant's stage naming the `devin` engine
 * with a producer-only Devin seat, a key connection, the budget mode, and the
 * Devin ACU budget's fleet gate (reserve, daily caps, concurrency — the
 * fleet's own caps count ONLY fleet sessions, never Mason's). Every decision
 * is ledgered (a hold when it changes; a launch before AND after the call,
 * with no launch when the first row is refused). Backlog claims span the
 * cloud and Devin lanes.
 *
 * External systems are fakes: the Devin API (test/helpers/fake-devin.ts), the
 * Keychain (test/helpers/fake-keychain.ts) and `gh`. The backlog and the
 * Devin store live in the worker's isolated ASHLR_HOME.
 */
import { rmSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EffectivePolicy, LedgerAppendInput } from '../src/core/authority/types.js';
import { appendUserBacklogItems, cloudBacklogPath, nextBacklogItem, nextBacklogItemWhere, readCloudBacklog } from '../src/core/cloud/backlog.js';
import type { CloudBacklogItem } from '../src/core/cloud/types.js';
import { devinBudgetView } from '../src/core/devin/budget.js';
import {
  DEVIN_FLEET_MAX_PROMPT_CHARS,
  isDevinFleetWork,
  planDevinFleetLaunch,
  resetDevinFleetLauncherForTest,
  runDevinFleetTick,
  type DevinFleetPlanInput,
  type DevinFleetTickDeps,
} from '../src/core/devin/fleet-launcher.js';
import { storeDevinKey } from '../src/core/devin/secret.js';
import { launchDevinTask, resetDevinStatusCacheForTest, type DevinServiceDeps } from '../src/core/devin/service.js';
import { devinHome, listDevinTasks, readDevinBudget, updateDevinBudget, writeDevinConnection, writeDevinTask } from '../src/core/devin/store.js';
import { DEFAULT_DEVIN_BUDGET, type DevinTaskV1 } from '../src/core/devin/types.js';
import { defaultBudgetPolicy, effectiveSeatPolicy } from '../src/core/routing/policy.js';
import { standingAuthorizesDevin } from '../src/core/authority/effective-config.js';
import { FAKE_KEY, FAKE_ORG, fakeDevin, type FakeDevin } from './helpers/fake-devin.js';
import { fakeKeychain, type FakeKeychain } from './helpers/fake-keychain.js';
import { repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';

const REPO = 'ashlrai/devin-canary';
const OTHER = 'ashlrai/not-granted';
const noSleep = async (): Promise<void> => undefined;

function devinPolicy(repos = [repoPolicy(REPO)]): EffectivePolicy {
  const base = standingPolicy(repos);
  return {
    ...base,
    engines: [...base.engines, 'devin'],
    spend: { ...base.spend, seats: { ...base.spend.seats, devin: { seatId: 'devin', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer'] } } },
  };
}

const item = (patch: Partial<CloudBacklogItem> = {}): CloudBacklogItem => ({
  id: 'fix-parser', title: 'Fix the parser crash on empty input', prompt: 'The parser throws on "". Make it return [] and add a test.',
  area: 'bug', priority: 1, repo: REPO, ...patch,
});

let n = 0;
function task(patch: Partial<DevinTaskV1> = {}): DevinTaskV1 {
  n += 1;
  const id = `dv_20260927T0400_${n.toString(36).padStart(6, '0')}`;
  const now = new Date().toISOString();
  return {
    v: 1, id, repo: REPO, baseBranch: 'main', branch: `ashlr-devin/${id}`, title: 't', prompt: 'p', origin: 'fleet', requestedBy: 'fleet',
    sessionId: 'devin-s1', sessionUrl: 'https://app.devin.ai/sessions/devin-s1', state: 'running', stateReason: null, failure: null,
    createdAt: now, launchedAt: now, updatedAt: now, session: { status: 'running', statusDetail: 'working', acusConsumed: 1, prUrls: [], readAt: now },
    maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null, backlogItemId: null, ...patch,
  };
}

const budgetOf = (patch: Partial<typeof DEFAULT_DEVIN_BUDGET> = {}) => ({ ...DEFAULT_DEVIN_BUDGET, acuBudgetTotal: 100, maxAcuPerDay: 60, updatedAt: new Date(0).toISOString(), ...patch });

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

describe('planDevinFleetLaunch — every gate, in order; the first failure is the decision', () => {
  const ok = { ok: true, reason: '' };
  const base = (): DevinFleetPlanInput => ({
    section: { enabled: true, fleet: true },
    killActive: false,
    policy: devinPolicy(),
    grant: ok,
    connected: true,
    budgetMode: ok,
    view: { canFleetLaunch: { ok: true, reason: null } },
    pick: () => ({ item: item(), repo: REPO }),
  });

  it('launches when everything holds', () => {
    expect(planDevinFleetLaunch(base())).toMatchObject({ kind: 'launch', repo: REPO, item: { id: 'fix-parser' } });
  });

  it.each([
    ['kill', { killActive: true }],
    ['no-grant', { policy: null }],
    ['not-enabled', { section: { fleet: true } }],
    ['not-opted-in', { section: { enabled: true } }],
    ['grant', { grant: { ok: false, reason: "The grant's current rollout stage does not include Devin." } }],
    ['not-connected', { connected: false }],
    ['budget-mode', { budgetMode: { ok: false, reason: 'reserve mode' } }],
    ['budget', { view: { canFleetLaunch: { ok: false, reason: 'Another fleet session would dip into the 10 ACUs kept for you.' } } }],
    ['no-work', { pick: () => null }],
  ] as const)('holds with %s', (code, patch) => {
    let picked = false;
    const input = { ...base(), ...patch } as DevinFleetPlanInput;
    const pick = input.pick;
    input.pick = () => { picked = true; return pick(); };
    expect(planDevinFleetLaunch(input)).toMatchObject({ kind: 'hold', code });
    // The backlog is never even read while a gate before it fails.
    if (code !== 'no-work') expect(picked).toBe(false);
  });
});

describe('isDevinFleetWork — well-scoped bug / issue work only, for a repo the stage covers', () => {
  const policy = devinPolicy();
  it('takes Leader work.dispatch items and bounded fix areas', () => {
    for (const area of ['leader', 'bug', 'issue', 'tests', 'reliability', 'Accessibility', 'ux']) expect(isDevinFleetWork(item({ area }), REPO, policy)).toBe(true);
  });
  it('refuses open-ended areas, long briefs and repos outside the stage', () => {
    for (const area of ['performance', 'autonomy', 'security', 'refactor']) expect(isDevinFleetWork(item({ area }), REPO, policy)).toBe(false);
    expect(isDevinFleetWork(item({ prompt: 'x'.repeat(DEVIN_FLEET_MAX_PROMPT_CHARS + 1) }), REPO, policy)).toBe(false);
    expect(isDevinFleetWork(item(), OTHER, policy)).toBe(false);
  });
});

describe('the fleet caps count ONLY fleet sessions (Mason\'s own Devin chats count against the ACU budget only)', () => {
  const now = new Date();
  it('fleet concurrency 1: a running fleet session holds the next; a running operator session does not', () => {
    const fleetBusy = devinBudgetView([task({ origin: 'fleet' })], budgetOf(), now);
    expect(fleetBusy).toMatchObject({ fleetRunning: 1, canLaunch: { ok: true } });
    expect(fleetBusy.canFleetLaunch).toMatchObject({ ok: false, reason: expect.stringMatching(/1 of 1 fleet Devin session is already running/) });
    const masonBusy = devinBudgetView([task({ origin: 'chat', requestedBy: 'mason' })], budgetOf(), now);
    expect(masonBusy).toMatchObject({ fleetRunning: 0, running: 1, canFleetLaunch: { ok: true } });
  });

  it('the fleet daily cap, and 0 = the fleet launches none', () => {
    const done = (i: number) => task({ state: 'merged', session: { status: 'exit', statusDetail: null, acusConsumed: 1, prUrls: [], readAt: now.toISOString() }, title: `t${i}` });
    const view = devinBudgetView([done(1), done(2), done(3)], budgetOf(), now);
    expect(view).toMatchObject({ fleetSessionsToday: 3, canFleetLaunch: { ok: false, reason: expect.stringMatching(/3 of 3 fleet Devin sessions used today/) } });
    expect(devinBudgetView([], budgetOf({ fleetMaxConcurrent: 0 }), now).canFleetLaunch).toMatchObject({ ok: false, reason: expect.stringMatching(/concurrency is 0/) });
    expect(devinBudgetView([], budgetOf({ fleetMaxSessionsPerDay: 0 }), now).canFleetLaunch).toMatchObject({ ok: false, reason: expect.stringMatching(/daily cap is 0/) });
  });

  it('the budget file preserves operator counts, zero opt-outs and defaults', () => {
    rmSync(devinHome(), { recursive: true, force: true });
    expect(readDevinBudget()).toMatchObject({ maxConcurrent: 2, maxSessionsPerDay: 10, fleetMaxConcurrent: 1, fleetMaxSessionsPerDay: 3 });
    expect(updateDevinBudget({ fleetMaxConcurrent: 0, fleetMaxSessionsPerDay: 999 })).toMatchObject({ fleetMaxConcurrent: 0, fleetMaxSessionsPerDay: 999 });
    expect(updateDevinBudget({ maxConcurrent: 0, maxSessionsPerDay: 0, fleetMaxSessionsPerDay: 0 })).toMatchObject({ maxConcurrent: 1, maxSessionsPerDay: 0, fleetMaxSessionsPerDay: 0 });
  });

  it.each([64, 999, 1_000_001, Number.MAX_SAFE_INTEGER])('round-trips %s count preferences without allocating session slots', (count) => {
    const counts = { maxConcurrent: count, maxSessionsPerDay: count, fleetMaxConcurrent: count, fleetMaxSessionsPerDay: count };
    expect(updateDevinBudget(counts)).toMatchObject(counts);
    expect(readDevinBudget()).toMatchObject(counts);
  });

  it.each(['maxConcurrent', 'maxSessionsPerDay', 'fleetMaxConcurrent', 'fleetMaxSessionsPerDay'] as const)('retains the configured %s when its new count is fractional or unsafe', (field) => {
    updateDevinBudget({ [field]: 64 });
    for (const invalid of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(updateDevinBudget({ [field]: invalid })[field]).toBe(64);
      expect(readDevinBudget()[field]).toBe(64);
    }
  });

  it('raising counts preserves all financial ceilings', () => {
    expect(updateDevinBudget({ maxConcurrent: 64, maxSessionsPerDay: 999, acuBudgetTotal: 200_000, maxAcuPerSession: 2_000, usdPerAcu: 200 }))
      .toMatchObject({ maxConcurrent: 64, maxSessionsPerDay: 999, acuBudgetTotal: 100_000, maxAcuPerSession: 1_000, usdPerAcu: 100 });
  });
});

describe('backlog claims span both lanes', () => {
  beforeEach(() => rmSync(cloudBacklogPath(), { force: true }));

  it('an item a Devin task holds is not handed to the cloud lane, and the reverse', () => {
    appendUserBacklogItems([item({ id: 'devin-held', title: 'First bounded fix' }), item({ id: 'next-one', title: 'Second bounded fix' })]);
    const devinClaim = task({ backlogItemId: 'devin-held' });
    const now = new Date();
    const ours = (i: CloudBacklogItem) => i.id === 'devin-held' || i.id === 'next-one';
    // The cloud lane's view (readCloudBacklog / nextBacklogItem) sees the Devin claim.
    expect(readCloudBacklog([devinClaim], now).items.find((i) => i.id === 'devin-held')).toMatchObject({ claimedBy: devinClaim.id, lastState: 'running' });
    expect(nextBacklogItem([devinClaim], REPO, now)?.id).not.toBe('devin-held');
    const cloudClaim = { id: 'ct_20260927T0400_aaaaaa', backlogItemId: 'devin-held', createdAt: now.toISOString(), updatedAt: now.toISOString(), state: 'running' as const };
    expect(nextBacklogItemWhere([cloudClaim], now, null, ours)?.item.id).toBe('next-one');
    // A Devin session blocked on Mason still holds its item.
    expect(nextBacklogItemWhere([task({ backlogItemId: 'devin-held', state: 'blocked' })], now, null, ours)?.item.id).toBe('next-one');
    expect(nextBacklogItemWhere([], now, null, ours)?.item.id).toBe('devin-held');
  });
});

// ---------------------------------------------------------------------------
// The tick, end to end: real service + budget + backlog, fake Devin API / Keychain
// ---------------------------------------------------------------------------

describe('runDevinFleetTick', () => {
  let api: FakeDevin;
  let keychain: FakeKeychain;
  let rows: LedgerAppendInput<'note'>[];
  let ledgerOk: boolean;
  let kill: boolean;
  let live: EffectivePolicy | null;
  let section: { enabled?: boolean; fleet?: boolean };

  beforeEach(async () => {
    rmSync(devinHome(), { recursive: true, force: true });
    rmSync(cloudBacklogPath(), { force: true });
    resetDevinFleetLauncherForTest();
    resetDevinStatusCacheForTest();
    api = fakeDevin();
    keychain = fakeKeychain();
    rows = [];
    ledgerOk = true;
    kill = false;
    live = devinPolicy();
    section = { enabled: true, fleet: true };
    await storeDevinKey(FAKE_KEY, { run: keychain.run, platform: 'darwin' });
    writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain', connectedAt: new Date().toISOString() });
    updateDevinBudget({ acuBudgetTotal: 100, maxAcuPerDay: 60, reserveAcu: 10, maxAcuPerSession: 10 });
    appendUserBacklogItems([
      item({ id: 'perf-item', title: 'Make the dashboard faster', area: 'performance' }),
      item({ id: 'leader-memo-1-0', title: 'Fix the flaky retry test', area: 'leader', priority: 2 }),
      item({ id: 'elsewhere', title: 'Fix a bug in another repo', repo: OTHER }),
    ]);
  });

  const serviceDeps = (): DevinServiceDeps => ({
    keyStore: { run: keychain.run, platform: 'darwin' },
    fetch: api.fetch,
    sleep: noSleep,
    gh: async (args) => (args[0] === 'repo' && args[1] === 'view' ? { ok: true, stdout: 'main\n', stderr: '' } : { ok: false, stdout: '', stderr: 'unexpected' }),
    config: () => section,
    policy: () => (kill ? null : live),
  });

  function deps(patch: Partial<DevinFleetTickDeps> = {}): DevinFleetTickDeps {
    return {
      config: () => section,
      killActive: () => kill,
      policy: () => (kill ? null : live),
      authorizes: (policy) => standingAuthorizesDevin(policy),
      connected: () => true,
      budgetPolicy: () => ({ ...defaultBudgetPolicy(), mode: 'balanced' }),
      seatEnabled: (budget) => effectiveSeatPolicy(budget, 'devin').enabled,
      devinTasks: () => listDevinTasks(Number.MAX_SAFE_INTEGER),
      cloudTasks: () => [],
      budget: () => readDevinBudget(),
      budgetView: (tasks, budget, now) => devinBudgetView(tasks, budget, now),
      defaultRepo: () => null,
      nextItem: (tasks, now, defaultRepo, accept) => nextBacklogItemWhere(tasks, now, defaultRepo, accept),
      launch: (req) => launchDevinTask(req, serviceDeps()),
      appendLedger: (input) => {
        if (!ledgerOk) return { ok: false, reason: 'ledger is read-only' };
        rows.push(input);
        return { ok: true, entry: {} as never };
      },
      now: () => new Date(),
      ...patch,
    };
  }

  const creates = () => api.requests.filter((r) => r.method === 'POST' && /\/sessions$/.test(r.path));

  it('launches ONE fleet session on the Leader item (skipping open-ended and ungranted work), ledgered before and after', async () => {
    const result = await runDevinFleetTick(deps());
    expect(result).toMatchObject({ outcome: 'launched', repo: REPO, itemId: 'leader-memo-1-0' });
    expect(creates()).toHaveLength(1);
    const body = creates()[0]!.body as Record<string, unknown>;
    expect(body['max_acu_limit']).toBe(10);
    expect(String(body['prompt'])).toContain('chosen by the Ashlr fleet from its backlog (item leader-memo-1-0');
    const [launched] = listDevinTasks();
    expect(launched).toMatchObject({ origin: 'fleet', requestedBy: 'fleet', backlogItemId: 'leader-memo-1-0', state: 'running' });
    expect(rows.map((r) => r.data.topic)).toEqual(['devin:fleet-launch', 'devin:fleet-launched']);
    expect(rows[0]).toMatchObject({ kind: 'note', actor: 'daemon', grantId: live!.grantId, repo: REPO });

    // Next tick: the fleet's concurrency cap (1) holds — the running session counts.
    const second = await runDevinFleetTick(deps());
    expect(second).toMatchObject({ outcome: 'held', code: 'budget', reason: expect.stringMatching(/fleet Devin session is already running/) });
    expect(creates()).toHaveLength(1);
  });

  it('nothing launches without a grant that names Devin — even with the repo granted', async () => {
    live = standingPolicy([repoPolicy(REPO)]);
    expect(await runDevinFleetTick(deps())).toMatchObject({ outcome: 'held', code: 'grant' });
    expect(creates()).toEqual([]);
  });

  it('KILL / Stop are honoured every tick, including a KILL that lands just before the call', async () => {
    kill = true;
    expect(await runDevinFleetTick(deps())).toMatchObject({ outcome: 'held', code: 'kill' });
    kill = false;
    let reads = 0;
    const late = await runDevinFleetTick(deps({ killActive: () => (++reads > 1) }));
    expect(late).toMatchObject({ outcome: 'held', code: 'kill' });
    live = null; // Stop / pause / expiry: no policy
    expect(await runDevinFleetTick(deps())).toMatchObject({ outcome: 'held', code: 'no-grant' });
    expect(creates()).toEqual([]);
  });

  it('a refused ledger row means no launch (fail closed)', async () => {
    ledgerOk = false;
    expect(await runDevinFleetTick(deps())).toMatchObject({ outcome: 'held', code: 'ledger' });
    expect(creates()).toEqual([]);
    expect(listDevinTasks()).toEqual([]);
  });

  it('reserve mode keeps Devin off; the budget reserve and opt-in are honoured', async () => {
    expect(await runDevinFleetTick(deps({ budgetPolicy: () => ({ ...defaultBudgetPolicy(), mode: 'reserve' }) }))).toMatchObject({ code: 'budget-mode' });
    updateDevinBudget({ acuBudgetTotal: 15, reserveAcu: 10 });
    expect(await runDevinFleetTick(deps())).toMatchObject({ code: 'budget', reason: expect.stringMatching(/kept for you/) });
    section = { enabled: true, fleet: false };
    expect(await runDevinFleetTick(deps())).toMatchObject({ code: 'not-opted-in' });
    expect(creates()).toEqual([]);
  });

  it('holds are ledgered when they change, not every tick', async () => {
    live = standingPolicy([repoPolicy(REPO)]);
    await runDevinFleetTick(deps());
    await runDevinFleetTick(deps());
    await runDevinFleetTick(deps());
    expect(rows.map((r) => r.data.topic)).toEqual(['devin:fleet-hold']);
    kill = true;
    await runDevinFleetTick(deps());
    expect(rows.map((r) => r.data.topic)).toEqual(['devin:fleet-hold', 'devin:fleet-hold']);
    expect(rows[1]!.data.detail).toMatch(/KILL/);
  });

  it('a Devin API refusal is ledgered as a failed launch', async () => {
    api.forced.push({ status: 403, body: { title: 'Forbidden', status: 403, detail: 'no' } });
    const result = await runDevinFleetTick(deps());
    expect(result).toMatchObject({ outcome: 'failed', code: 'launch-failed' });
    expect(rows.map((r) => r.data.topic)).toEqual(['devin:fleet-launch', 'devin:fleet-launch-failed']);
  });

  it('lane advice can only narrow: a confident "cloud" skips the item; low confidence / "devin" / a throwing advisor leave the heuristic in charge', async () => {
    appendUserBacklogItems([item({ id: 'second-fix', title: 'Fix the date parser off-by-one', area: 'bug', priority: 3 })]);
    const asked: string[] = [];
    const away = await runDevinFleetTick(deps({
      laneAdvisor: (q) => {
        asked.push(q.itemId);
        return q.itemId === 'leader-memo-1-0' ? { lane: 'cloud', confidence: 0.9 } : { lane: 'devin', confidence: 0.8 };
      },
    }));
    expect(away).toMatchObject({ outcome: 'launched', itemId: 'second-fix' });
    // Never asked about work the heuristic refused (performance / another repo).
    expect(asked).toEqual(['leader-memo-1-0', 'second-fix']);
  });

  it('an advisor that turns every candidate away holds the tick; a broken one is ignored', async () => {
    expect(await runDevinFleetTick(deps({ laneAdvisor: () => ({ lane: 'fleet', confidence: 0.99 }) })))
      .toMatchObject({ outcome: 'held', code: 'no-work', reason: expect.stringMatching(/lane advisor/) });
    expect(creates()).toEqual([]);
    expect(await runDevinFleetTick(deps({ laneAdvisor: () => ({ lane: 'cloud', confidence: 0.3 }) }))).toMatchObject({ outcome: 'launched', itemId: 'leader-memo-1-0' });
  });

  it('a throwing or nonsensical advisor never blocks or widens anything', async () => {
    expect(await runDevinFleetTick(deps({ laneAdvisor: () => { throw new Error('model down'); } }))).toMatchObject({ outcome: 'launched' });
    resetDevinFleetLauncherForTest();
    rmSync(devinHome(), { recursive: true, force: true });
    await storeDevinKey(FAKE_KEY, { run: keychain.run, platform: 'darwin' });
    writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain', connectedAt: new Date().toISOString() });
    updateDevinBudget({ acuBudgetTotal: 100, maxAcuPerDay: 60, reserveAcu: 10, maxAcuPerSession: 10 });
    expect(await runDevinFleetTick(deps({ laneAdvisor: () => ({ lane: 'cloud', confidence: 7 } as never) }))).toMatchObject({ outcome: 'launched' });
  });

  it('a recognized partial inventory holds before selecting or contacting work', async () => {
    const nextItem = vi.fn();
    expect(await runDevinFleetTick(deps({ taskInventory: () => ({ tasks: [], sourceState: 'unavailable' }),
      budgetView: (tasks, budget, now, sourceState) => devinBudgetView(tasks, budget, now, sourceState), nextItem })))
      .toMatchObject({ outcome: 'held', code: 'budget', reason: expect.stringContaining('unknown') });
    expect(nextItem).not.toHaveBeenCalled();
    expect(creates()).toEqual([]);
  });

  it('an unreadable task store holds (unknown spend is never zero)', async () => {
    expect(await runDevinFleetTick(deps({ devinTasks: () => { throw new Error('EACCES'); } }))).toMatchObject({ outcome: 'held', code: 'budget' });
    expect(creates()).toEqual([]);
  });

  it('writes nothing but its own records (no stray files)', async () => {
    await runDevinFleetTick(deps());
    writeDevinTask({ ...listDevinTasks()[0]!, state: 'merged' });
    expect(listDevinTasks()).toHaveLength(1);
  });
});
