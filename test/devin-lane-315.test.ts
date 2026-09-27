/**
 * 3.15 — the Devin lane: key custody (Keychain via a fake `security`),
 * connect, launch, ACU budget gates, the tracker's state transitions, the
 * HTTP module (strict bodies, no key route) and its Needs-you items.
 *
 * Everything external is faked: the Devin API (test/helpers/fake-devin.ts),
 * the Keychain (test/helpers/fake-keychain.ts) and `gh`. Files live in the
 * worker's isolated ASHLR_HOME (test/setup/home.ts).
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { devinBudgetView, devinTaskAcuUsed } from '../src/core/devin/budget.js';
import { buildDevinPrompt, DEVIN_REPORT_SCHEMA, parseDevinReport } from '../src/core/devin/delivery-contract.js';
import { devinNeedsYouItems, dismissDevinTask, parseDevinBudgetBody, parseDevinLaunchBody, parseDevinMessageBody } from '../src/core/devin/devin-api.js';
import { hasDevinKey, readDevinKey, removeDevinKey, storeDevinKey } from '../src/core/devin/secret.js';
import {
  connectDevin,
  devinFleetVerdict,
  devinStatus,
  launchDevinTask,
  messageDevinTask,
  resetDevinStatusCacheForTest,
  type DevinServiceDeps,
} from '../src/core/devin/service.js';
import {
  devinHome,
  listDevinTasks,
  readDevinConnection,
  readDevinTask,
  updateDevinBudget,
  writeDevinConnection,
  writeDevinTask,
} from '../src/core/devin/store.js';
import { refreshDevinTasks, resetDevinTrackerCursorForTest, stateFromSession } from '../src/core/devin/tracker.js';
import { DEFAULT_DEVIN_BUDGET, type DevinBudgetV1, type DevinTaskV1 } from '../src/core/devin/types.js';
import { scrubSecrets } from '../src/core/util/scrub.js';
import type { CloudPrPreview } from '../src/core/cloud/pr-preview.js';
import { CloudInputError } from '../src/core/cloud/cloud-api.js';
import { repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';
import { FAKE_KEY, FAKE_ORG, fakeDevin, type FakeDevin } from './helpers/fake-devin.js';
import { fakeKeychain, type FakeKeychain } from './helpers/fake-keychain.js';

const REPO = 'ashlrai/devin-canary';
const noSleep = async (): Promise<void> => undefined;

let api: FakeDevin;
let keychain: FakeKeychain;
let ghCalls: string[][];
let ghPrs: unknown[];

function deps(extra: Partial<DevinServiceDeps> = {}): DevinServiceDeps {
  return {
    keyStore: { run: keychain.run, platform: 'darwin' },
    fetch: api.fetch,
    sleep: noSleep,
    gh: async (args) => {
      ghCalls.push(args);
      if (args[0] === 'repo' && args[1] === 'view') return { ok: true, stdout: 'main\n', stderr: '' };
      if (args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: JSON.stringify(ghPrs), stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected' };
    },
    config: () => ({ enabled: true }),
    policy: () => null,
    ...extra,
  };
}

/** A standing policy whose stage names the `devin` engine with a Devin seat (producer by default). */
function devinPolicy(repos: Parameters<typeof standingPolicy>[0], roles: Array<'producer' | 'judge' | 'leader'> = ['producer']) {
  const base = standingPolicy(repos);
  return {
    ...base,
    engines: [...base.engines, 'devin' as const],
    spend: { ...base.spend, seats: { ...base.spend.seats, devin: { seatId: 'devin', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles } } },
  };
}

async function connect(): Promise<void> {
  await storeDevinKey(FAKE_KEY, { run: keychain.run, platform: 'darwin' });
  writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain', connectedAt: new Date().toISOString() });
}

/** Every file under the Devin home, recursively, as text. */
function everyFileText(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(devinHome());
  return out.join('\n');
}

beforeEach(() => {
  rmSync(devinHome(), { recursive: true, force: true });
  api = fakeDevin({ self: { principal_type: 'service_user', service_user_id: 's', service_user_name: 'Ashlr Verse', org_id: null } });
  keychain = fakeKeychain();
  ghCalls = [];
  ghPrs = [];
  resetDevinStatusCacheForTest();
  resetDevinTrackerCursorForTest();
});

function budget(patch: Partial<DevinBudgetV1> = {}): DevinBudgetV1 {
  return { ...DEFAULT_DEVIN_BUDGET, updatedAt: new Date(0).toISOString(), ...patch };
}

let n = 0;
function task(patch: Partial<DevinTaskV1> = {}): DevinTaskV1 {
  n += 1;
  const id = `dv_20260927T0400_${n.toString(36).padStart(6, '0')}`;
  const now = new Date().toISOString();
  return {
    v: 1, id, repo: REPO, baseBranch: 'main', branch: `ashlr-devin/${id}`, title: 'Add a helper', prompt: 'p', origin: 'operator',
    requestedBy: 'mason', sessionId: 'devin-s1', sessionUrl: 'https://app.devin.ai/sessions/devin-s1', state: 'running',
    stateReason: null, failure: null, createdAt: now, launchedAt: now, updatedAt: now,
    session: { status: 'running', statusDetail: 'working', acusConsumed: 2, prUrls: [], readAt: now },
    maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null, backlogItemId: null,
    ...patch,
  };
}

// ---------------------------------------------------------------------------

describe('key custody: the macOS Keychain, stdin only', () => {
  it('stores the key via `security -i` on stdin — never in argv — and reads it back', async () => {
    await storeDevinKey(FAKE_KEY, { run: keychain.run, platform: 'darwin' });
    expect(await readDevinKey({ run: keychain.run, platform: 'darwin' })).toBe(FAKE_KEY);
    expect(await hasDevinKey({ run: keychain.run, platform: 'darwin' })).toBe(true);
    for (const call of keychain.calls) expect(call.args.join(' ')).not.toContain(FAKE_KEY);
    const add = keychain.calls.find((c) => c.args[0] === '-i')!;
    expect(add.stdin).toContain('-s ai.ashlr.devin -a api-key');
    expect(add.stdin).toContain('-T /usr/bin/security');
    expect(add.stdin).not.toContain(' -A');
    // The attribute check never asks for the secret.
    expect(keychain.calls.some((c) => c.args[0] === 'find-generic-password' && !c.args.includes('-w'))).toBe(true);
    expect(await removeDevinKey({ run: keychain.run, platform: 'darwin' })).toBe(true);
    expect(await readDevinKey({ run: keychain.run, platform: 'darwin' })).toBeNull();
  });

  it('refuses a malformed or legacy key before anything runs, and off macOS', async () => {
    await expect(storeDevinKey('apk_user_legacy123456789012345678', { run: keychain.run, platform: 'darwin' })).rejects.toThrow(/cog_/);
    await expect(storeDevinKey('cog_x y', { run: keychain.run, platform: 'darwin' })).rejects.toThrow();
    await expect(storeDevinKey(FAKE_KEY, { run: keychain.run, platform: 'linux' })).rejects.toThrow(/macOS/);
    expect(keychain.calls).toEqual([]);
  });
});

describe('connect', () => {
  it('verifies the key with Devin before storing it, and writes only non-secret facts to disk (0600)', async () => {
    const result = await connectDevin({ key: FAKE_KEY, orgId: FAKE_ORG }, deps());
    expect(result).toEqual({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Ashlr Verse' });
    expect(api.requests.map((r) => r.path)).toEqual(['/v3/self', `/v3/organizations/${FAKE_ORG}/sessions?first=1`]);
    expect(readDevinConnection()).toMatchObject({ orgId: FAKE_ORG, keyStore: 'keychain' });
    expect(keychain.items.get('ai.ashlr.devin/api-key')).toBe(FAKE_KEY);
    expect(everyFileText()).not.toContain(FAKE_KEY);
    expect(statSync(join(devinHome(), 'connection.json')).mode & 0o777).toBe(0o600);
  });

  it('a refused key is never stored; an org-scoped service user needs --org', async () => {
    await expect(connectDevin({ key: 'cog_wrongKey_abcdefghijklmnopqrst' }, deps())).rejects.toMatchObject({ code: 'auth' });
    expect(keychain.items.size).toBe(0);
    await expect(connectDevin({ key: FAKE_KEY }, deps())).rejects.toThrow(/--org/);
    expect(keychain.items.size).toBe(0);
    expect(readDevinConnection()).toBeNull();
  });

  it('a PAT carries its org; a different --org is refused', async () => {
    api = fakeDevin({ self: { principal_type: 'pat_user', user_id: 'u', user_name: 'Mason', api_key_id: 'k', api_key_name: 'n', org_id: FAKE_ORG } });
    await expect(connectDevin({ key: FAKE_KEY, orgId: 'org-other' }, deps())).rejects.toThrow(/belongs to/);
    expect(await connectDevin({ key: FAKE_KEY }, deps())).toMatchObject({ orgId: FAKE_ORG, principal: 'pat_user' });
  });
});

describe('status and readiness lines', () => {
  it('disabled / not connected / ready, with Chat n/a and the fleet verdict', async () => {
    const off = await devinStatus(deps({ config: () => undefined }));
    expect(off).toMatchObject({ state: 'disabled', connected: false, chatLine: expect.stringMatching(/^Chat: off/) });
    expect(off.fleet).toMatchObject({ ready: false, fix: { kind: 'command', command: 'ashlr devin connect' } });
    await connect();
    resetDevinStatusCacheForTest();
    const ready = await devinStatus(deps());
    expect(ready).toMatchObject({ state: 'ready', connected: true, enabled: true, orgId: FAKE_ORG });
    // 3.15: Devin is a chat seat once ready.
    expect(ready.chat).toMatchObject({ ready: true, word: 'Ready' });
    expect(ready.fleet).toMatchObject({ ready: false, word: 'Off', fix: { command: 'ashlr devin fleet on' } });
  });

  it('fleet verdict: opt-in, then a grant that names Devin, then the reserve; ready names the two-judge rule', () => {
    const gate = { ok: true, reason: null };
    const withoutDevin = standingPolicy([repoPolicy(REPO)]);
    const policy = devinPolicy([repoPolicy(REPO)]);
    expect(devinFleetVerdict({ enabled: true, connected: true, optIn: true, policy: null, fleetGate: gate })).toMatchObject({ ready: false, word: 'Waiting' });
    // 3.15: a grant that does not name the `devin` engine never lets the fleet launch Devin.
    expect(devinFleetVerdict({ enabled: true, connected: true, optIn: true, policy: withoutDevin, fleetGate: gate }))
      .toMatchObject({ ready: false, word: 'Not in the grant', fix: { command: 'ashlr authority draft' } });
    expect(devinFleetVerdict({ enabled: true, connected: true, optIn: true, policy, fleetGate: { ok: false, reason: 'reserve' } })).toMatchObject({ ready: false, word: 'Paused', detail: 'reserve' });
    const ready = devinFleetVerdict({ enabled: true, connected: true, optIn: true, policy, fleetGate: gate });
    expect(ready).toMatchObject({ ready: true, word: 'Ready', roles: ['producer'] });
    expect(ready.detail).toMatch(/two judges from different families/);
  });
});

describe('launch', () => {
  it('refuses when the lane is off or not connected, before any API call', async () => {
    expect(await launchDevinTask({ repo: REPO, prompt: 'x', origin: 'operator' }, deps({ config: () => ({ enabled: false }) }))).toMatchObject({ ok: false, failure: 'not-enabled' });
    expect(await launchDevinTask({ repo: REPO, prompt: 'x', origin: 'operator' }, deps())).toMatchObject({ ok: false, failure: 'not-connected' });
    expect(api.requests).toEqual([]);
    expect(listDevinTasks()).toEqual([]);
  });

  it('creates a session with the delivery contract, a hard ACU cap, tags and the pinned mode; records it running', async () => {
    await connect();
    updateDevinBudget({ maxAcuPerSession: 7 });
    const res = await launchDevinTask({ repo: REPO, prompt: 'Add a sub helper', origin: 'chat' }, deps({ config: () => ({ enabled: true, mode: 'lite' }) }));
    expect(res.ok).toBe(true);
    const t = res.task!;
    expect(t).toMatchObject({ state: 'running', baseBranch: 'main', branch: `ashlr-devin/${t.id}`, maxAcu: 7, devinMode: 'lite', sessionUrl: expect.stringMatching(/^https:\/\/app\.devin\.ai\//) });
    const body = api.requests.find((r) => r.method === 'POST')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ repos: [REPO], max_acu_limit: 7, devin_mode: 'lite', structured_output_required: false, structured_output_schema: DEVIN_REPORT_SCHEMA });
    expect(body['tags']).toEqual(['ashlr-verse', `ashlr-task-${t.id}`]);
    expect(String(body['prompt'])).toContain(`Create branch \`ashlr-devin/${t.id}\` from \`main\``);
    expect(String(body['prompt'])).toContain('Never merge anything');
    expect(readDevinTask(t.id)).toMatchObject({ state: 'running', sessionId: t.sessionId });
    // 3.15: no playbook ⇒ no ref, no block.
    expect(t).not.toHaveProperty('playbookRef');
    expect(String(body['prompt'])).not.toContain('## Playbook:');
  });

  it('3.15: a named playbook is pinned on the task and inlined before the contract; an unknown one refuses first', async () => {
    await connect();
    const res = await launchDevinTask({ repo: REPO, prompt: 'Bump vitest to 4.2', origin: 'cli', playbook: '!bump-deps' }, deps());
    expect(res.ok).toBe(true);
    expect(res.task!.playbookRef).toMatchObject({ id: 'dependency-bump', version: 1 });
    const prompt = String((api.requests.find((r) => r.method === 'POST')!.body as Record<string, unknown>)['prompt']);
    expect(prompt.indexOf('## Playbook: Bump a dependency')).toBeGreaterThan(0);
    expect(prompt.indexOf('## Playbook:')).toBeLessThan(prompt.indexOf('DELIVERY CONTRACT'));
    const posts = () => api.requests.filter((r) => r.method === 'POST').length;
    const before = posts();
    expect(await launchDevinTask({ repo: REPO, prompt: 'x', origin: 'cli', playbook: 'no-such-one' }, deps())).toMatchObject({ ok: false });
    expect(posts()).toBe(before);
  });

  it('adopts the session by its task tag when the create answer was lost, instead of launching twice', async () => {
    await connect();
    api.onCreate = () => { /* the server creates it … */ };
    const realFetch = api.fetch;
    let dropped = false;
    api.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      if (init.method === 'POST' && !dropped) {
        dropped = true;
        throw new Error('socket hang up'); // … and the answer never arrives
      }
      return res;
    };
    const res = await launchDevinTask({ repo: REPO, prompt: 'x', origin: 'operator' }, deps());
    expect(res).toMatchObject({ ok: true, task: { state: 'running' } });
    expect(api.sessions.size).toBe(1);
    expect(api.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('an unknown create outcome with no session found fails closed: the full cap counts against the budget', async () => {
    await connect();
    const realFetch = api.fetch;
    api.fetch = async (url, init) => {
      if (init.method === 'POST') throw new Error('ECONNRESET');
      return realFetch(url, init);
    };
    const res = await launchDevinTask({ repo: REPO, prompt: 'x', origin: 'operator' }, deps());
    expect(res).toMatchObject({ ok: false, failure: 'network' });
    expect(devinTaskAcuUsed(res.task!)).toBe(res.task!.maxAcu);
  });

  it('the budget gate refuses before persisting; fleet launches need opt-in, a grant with the repo, and the reserve', async () => {
    await connect();
    updateDevinBudget({ acuBudgetTotal: 0 });
    expect(await launchDevinTask({ repo: REPO, prompt: 'x', origin: 'operator' }, deps())).toMatchObject({ ok: false, failure: 'budget' });
    updateDevinBudget({ acuBudgetTotal: 50 });
    const fleet = { repo: REPO, prompt: 'x', origin: 'fleet' as const };
    expect(await launchDevinTask(fleet, deps())).toMatchObject({ ok: false, error: expect.stringMatching(/fleet on/) });
    expect(await launchDevinTask(fleet, deps({ config: () => ({ enabled: true, fleet: true }) }))).toMatchObject({ ok: false, error: expect.stringMatching(/standing grant/) });
    const policy = standingPolicy([repoPolicy('ashlrai/other')]);
    expect(await launchDevinTask(fleet, deps({ config: () => ({ enabled: true, fleet: true }), policy: () => policy }))).toMatchObject({ ok: false, error: expect.stringMatching(/not in the standing grant/) });
    updateDevinBudget({ acuBudgetTotal: 15, reserveAcu: 10, maxAcuPerSession: 10 });
    // 3.15: the repo being in the grant is not enough — the stage must name `devin` with a producer seat.
    const repoOnly = standingPolicy([repoPolicy(REPO)]);
    expect(await launchDevinTask(fleet, deps({ config: () => ({ enabled: true, fleet: true }), policy: () => repoOnly })))
      .toMatchObject({ ok: false, failure: 'not-enabled', error: expect.stringMatching(/does not include Devin/) });
    const judgeOnly = devinPolicy([repoPolicy(REPO)], ['judge']);
    expect(await launchDevinTask(fleet, deps({ config: () => ({ enabled: true, fleet: true }), policy: () => judgeOnly })))
      .toMatchObject({ ok: false, failure: 'not-enabled', error: expect.stringMatching(/no producer role/) });
    const inGrant = devinPolicy([repoPolicy(REPO)]);
    expect(await launchDevinTask(fleet, deps({ config: () => ({ enabled: true, fleet: true }), policy: () => inGrant }))).toMatchObject({ ok: false, failure: 'budget', error: expect.stringMatching(/kept for you/) });
    expect(api.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });
});

describe('ACU budget', () => {
  const now = new Date();
  it('counts real ACUs, holds in-flight headroom, and pauses at the threshold', () => {
    const running = task({ session: { status: 'running', statusDetail: 'working', acusConsumed: 3, prUrls: [], readAt: now.toISOString() }, maxAcu: 10 });
    const done = task({ state: 'merged', session: { status: 'exit', statusDetail: null, acusConsumed: 6, prUrls: [], readAt: now.toISOString() } });
    const unread = task({ state: 'expired', session: null, maxAcu: 8 });
    const view = devinBudgetView([running, done, unread], budget({ acuBudgetTotal: 100, acuSpentAdjustment: 1, maxAcuPerDay: 100 }), now);
    expect(view).toMatchObject({ acuUsed: 1 + 3 + 6 + 8, acuInFlight: 7, running: 1, paused: false });
    expect(view.canLaunch.ok).toBe(true);
    const paused = devinBudgetView([done], budget({ acuBudgetTotal: 6, pauseAtFraction: 0.9 }), now);
    expect(paused).toMatchObject({ paused: true, canLaunch: { ok: false } });
    expect(paused.canLaunch.reason).toMatch(/^Paused/);
  });

  it('refuses when a new session could pass the daily cap, the concurrency cap or the free ACUs', () => {
    const r = (): DevinTaskV1 => task({ session: { status: 'running', statusDetail: 'working', acusConsumed: 1, prUrls: [], readAt: now.toISOString() }, maxAcu: 10 });
    expect(devinBudgetView([r()], budget({ maxAcuPerDay: 15 }), now).canLaunch.reason).toMatch(/daily cap/);
    expect(devinBudgetView([r(), r()], budget({ maxAcuPerDay: 1000, maxConcurrent: 2 }), now).canLaunch.reason).toMatch(/already running/);
    expect(devinBudgetView([r()], budget({ acuBudgetTotal: 15, maxAcuPerDay: 1000, pauseAtFraction: 1 }), now).canLaunch.reason).toMatch(/free after running sessions/);
  });
});

describe('tracker', () => {
  async function seedRunning(patch: Partial<DevinTaskV1> = {}): Promise<DevinTaskV1> {
    await connect();
    const created = await launchDevinTask({ repo: REPO, prompt: 'x', origin: 'operator' }, deps());
    const t = { ...created.task!, ...patch };
    writeDevinTask(t);
    return readDevinTask(t.id)!;
  }

  it('maps session status: waiting → blocked, out of credits → blocked (why), exit with no PR → expired, error → failed', () => {
    const t = task();
    const s = (status: string, detail: string | null) => ({ sessionId: 'devin-s1', url: 'https://app.devin.ai/s', status, statusDetail: detail, acusConsumed: 1, pullRequests: [], tags: [], title: null, structuredOutput: null }) as Parameters<typeof stateFromSession>[1];
    expect(stateFromSession(t, s('running', 'waiting_for_user'))).toMatchObject({ state: 'blocked', reason: 'Devin is waiting for your reply.' });
    expect(stateFromSession(t, s('running', 'waiting_for_approval'))?.state).toBe('blocked');
    expect(stateFromSession(t, s('suspended', 'out_of_credits'))).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/out of credits/) });
    expect(stateFromSession(t, s('running', 'finished'))?.state).toBe('expired');
    expect(stateFromSession(t, s('exit', null))?.state).toBe('expired');
    expect(stateFromSession(t, s('error', null))).toMatchObject({ state: 'failed', failure: 'session-error' });
    expect(stateFromSession(t, s('running', 'working'))?.state).toBe('running');
  });

  it('reads status + ACUs from Devin, and pins the PR GitHub verifies on ashlr-devin/<id> (with head SHA and report)', async () => {
    const t = await seedRunning();
    const session = api.sessions.get(t.sessionId!)!;
    Object.assign(session, { status: 'running', status_detail: 'waiting_for_user', acus_consumed: 4.5 });
    await refreshDevinTasks(deps());
    expect(readDevinTask(t.id)).toMatchObject({ state: 'blocked', session: { acusConsumed: 4.5, statusDetail: 'waiting_for_user' } });

    Object.assign(session, { status: 'running', status_detail: 'finished', pull_requests: [{ pr_url: `https://github.com/${REPO}/pull/9`, pr_state: 'open' }] });
    const report = '```ashlr-devin-report\n{"status":"done","summary":"Added it.","testsRun":["npm test"],"risks":[]}\n```';
    ghPrs = [{
      number: 9, url: `https://github.com/${REPO}/pull/9`, state: 'OPEN', isDraft: false, title: '[ashlr-devin] Add a helper', body: `Body\n\n${report}`,
      headRefName: t.branch, baseRefName: 'main', headRepository: { name: 'devin-canary' }, headRepositoryOwner: { login: 'ashlrai' }, isCrossRepository: false,
      headRefOid: 'f'.repeat(40),
    }];
    await refreshDevinTasks(deps());
    expect(readDevinTask(t.id)).toMatchObject({
      state: 'pr-open', pr: { number: 9, state: 'open' }, deliveryPin: { number: 9, url: `https://github.com/${REPO}/pull/9` }, headSha: 'f'.repeat(40),
      report: { status: 'done', summary: 'Added it.' },
    });
    expect(ghCalls.find((c) => c[1] === 'list')).toEqual(expect.arrayContaining(['--head', t.branch, '--repo', REPO]));
  });

  it('a PR Devin reports on another branch is never pinned — the reason says to review it on GitHub', async () => {
    const t = await seedRunning();
    Object.assign(api.sessions.get(t.sessionId!)!, { status: 'exit', pull_requests: [{ pr_url: `https://github.com/${REPO}/pull/12`, pr_state: 'open' }] });
    ghPrs = [];
    await refreshDevinTasks(deps());
    const after = readDevinTask(t.id)!;
    expect(after).toMatchObject({ state: 'expired', pr: null });
    expect(after.deliveryPin).toBeUndefined();
    expect(after.stateReason).toMatch(/not on ashlr-devin\//);
  });

  it('a PR whose head is a fork or another branch does not match; an ambiguous list changes nothing', async () => {
    const t = await seedRunning();
    ghPrs = [{
      number: 9, url: `https://github.com/${REPO}/pull/9`, state: 'OPEN', isDraft: false, title: 't', body: null,
      headRefName: 'devin/other', baseRefName: 'main', headRepository: { name: 'devin-canary' }, headRepositoryOwner: { login: 'ashlrai' }, isCrossRepository: false,
    }];
    await refreshDevinTasks(deps());
    expect(readDevinTask(t.id)).toMatchObject({ pr: null });
    expect(readDevinTask(t.id)!.deliveryPin).toBeUndefined();
  });
});

describe('messages', () => {
  it('replies to a waiting session (POST …/messages) and moves it back to running', async () => {
    await connect();
    const created = await launchDevinTask({ repo: REPO, prompt: 'x', origin: 'operator' }, deps());
    writeDevinTask({ ...created.task!, state: 'blocked', stateReason: 'Devin is waiting for your reply.' });
    const res = await messageDevinTask(created.task!.id, 'Yes, use the helper.', deps());
    expect(res).toMatchObject({ ok: true, task: { state: 'running' } });
    expect(api.requests.at(-1)).toMatchObject({ method: 'POST', body: { message: 'Yes, use the helper.' } });
    expect(await messageDevinTask('dv_20260927T0000_zzzzzz', 'x', deps())).toMatchObject({ ok: false, status: 404 });
  });
});

describe('HTTP module (pure parts)', () => {
  it('strict bodies: unknown keys and a `fleet` origin are refused; there is no key field anywhere', () => {
    expect(() => parseDevinLaunchBody({ repo: REPO, prompt: 'x', apiKey: FAKE_KEY })).toThrow(CloudInputError);
    expect(() => parseDevinLaunchBody({ repo: REPO, prompt: 'x', origin: 'fleet' })).toThrow(/Origin/);
    expect(parseDevinLaunchBody({ repo: REPO, prompt: 'x', origin: 'chat' })).toEqual({ repo: REPO, prompt: 'x', origin: 'chat' });
    expect(() => parseDevinBudgetBody({ maxAcuPerSession: 1.5 })).toThrow(/whole/);
    expect(() => parseDevinBudgetBody({})).toThrow(/Nothing/);
    expect(parseDevinBudgetBody({ acuBudgetTotal: 80, pauseAtFraction: 0.8 })).toEqual({ acuBudgetTotal: 80, pauseAtFraction: 0.8 });
    expect(() => parseDevinMessageBody({ message: '' })).toThrow();
  });

  it('Needs-you: a verified PR is an owner-lane item with the shared triage routed to /api/verse/devin; waiting and failed are chats items', () => {
    const now = new Date();
    const prOpen = task({ state: 'pr-open', pr: { number: 9, url: `https://github.com/${REPO}/pull/9`, state: 'open', draft: false, title: 't' }, deliveryPin: { number: 9, url: `https://github.com/${REPO}/pull/9` }, report: { status: 'done', summary: `done ${FAKE_KEY}`, testsRun: [], risks: [] } });
    const blocked = task({ state: 'blocked', stateReason: 'Devin is waiting for your reply.' });
    const failed = task({ state: 'failed', sessionId: null, sessionUrl: null, stateReason: 'Devin refused the API key (401).', failure: 'auth' });
    const preview: CloudPrPreview = {
      taskId: prOpen.id, itemId: `fleet:owner-lane-pr:devin-${prOpen.id}`, prNumber: 9, headSha: 'a'.repeat(40), baseBranch: 'main', open: true,
      wouldAutoLand: false, reason: 'Checks green.', landable: { ok: true, reason: null }, behind: false, checks: [], computedAt: now.toISOString(),
    } as unknown as CloudPrPreview;
    const items = devinNeedsYouItems([prOpen, blocked, failed], now, new Map([[prOpen.id, preview]]));
    expect(items.map((i) => [i.id, i.kind, i.source])).toEqual([
      [`fleet:owner-lane-pr:devin-${prOpen.id}`, 'owner-lane-pr', 'fleet'],
      [`chats:chat-failed:devin-${blocked.id}`, 'chat-failed', 'chats'],
      [`chats:chat-failed:devin-${failed.id}`, 'chat-failed', 'chats'],
    ]);
    const paths = items[0]!.actions.map((a) => a.request?.path);
    expect(paths).toEqual([
      `/api/verse/devin/tasks/${prOpen.id}/land`, `/api/verse/devin/tasks/${prOpen.id}/close`, `/api/verse/devin/tasks/${prOpen.id}/dismiss`,
    ]);
    expect(items[0]!.actions[0]!.request?.body).toEqual({ headSha: 'a'.repeat(40) });
    expect(JSON.stringify(items)).not.toContain(FAKE_KEY);
    expect(items[1]!.target).toEqual({ kind: 'url', url: blocked.sessionUrl });
  });

  it('dismiss marks the local record closed and never touches a merged task', () => {
    const t = task({ state: 'expired' });
    writeDevinTask(t);
    expect(dismissDevinTask(t.id)).toMatchObject({ ok: true, task: { state: 'closed' } });
    const m = task({ state: 'merged' });
    writeDevinTask(m);
    expect(dismissDevinTask(m.id)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('delivery contract and secret hygiene', () => {
  it('the prompt names the branch, the base, the report fence and forbids merging and secrets', () => {
    const t = task();
    const prompt = buildDevinPrompt(t);
    expect(prompt).toContain(`\`${t.branch}\``);
    expect(prompt).toContain('```ashlr-devin-report');
    expect(prompt).toMatch(/Never merge anything/);
    expect(prompt).toMatch(/never a fork/);
    expect(prompt).toMatch(/Never put secrets/);
  });

  it('the report parser reads only the Devin fence', () => {
    expect(parseDevinReport('```ashlr-devin-report\n{"status":"partial","summary":"s","testsRun":[],"risks":[]}\n```')).toMatchObject({ status: 'partial' });
    expect(parseDevinReport('```ashlr-cloud-report\n{"status":"done","summary":"s","testsRun":[],"risks":[]}\n```')).toBeNull();
  });

  it('scrubSecrets redacts Devin keys (cog_ and legacy apk_) but not look-alike identifiers', () => {
    expect(scrubSecrets(`key ${FAKE_KEY} end`)).toBe('key [REDACTED] end');
    expect(scrubSecrets('legacy apk_user_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toBe('legacy [REDACTED]');
    expect(scrubSecrets('const apk_version_code_for_android = 1')).toContain('apk_version_code_for_android');
  });
});
