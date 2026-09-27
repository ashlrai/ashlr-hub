/**
 * 3.15 — Devin as a Verse CHAT seat: the cloud turn runner against a fake
 * Devin v3 API (test/helpers/fake-devin.ts, an injected fetch — never the
 * network), the chat lane glue (start / message / terminate / read position),
 * seat discovery and readiness, and the adapter's line protocol.
 *
 * The runner's clock and sleeps are scripted: each `sleep` runs the next
 * step, which is where a test moves the fake session along ("Devin replies",
 * "Devin waits for you", "a PR appears").
 */
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { devinBudgetView } from '../src/core/devin/budget.js';
import { readDevinChatState, terminateDevinChat } from '../src/core/devin/chat.js';
import { remoteStateOf, runDevinCloudTurn, type DevinCloudTurnDeps, type DevinTurnIo } from '../src/core/devin/chat-runner.js';
import { devinNeedsYouItems } from '../src/core/devin/devin-api.js';
import { storeDevinKey } from '../src/core/devin/secret.js';
import { resetDevinStatusCacheForTest } from '../src/core/devin/service.js';
import { resetDevinCliProbeForTest } from '../src/core/devin/cli-probe.js';
import { devinHome, listDevinTasks, readDevinBudget, readDevinTask, updateDevinBudget, writeDevinConnection, writeDevinTask } from '../src/core/devin/store.js';
import { parseDevinTurnPayload, type DevinTurnLine, type DevinTurnPayload } from '../src/core/devin/turn-protocol.js';
import { createDevinParser, devinAdapter, devinLineToEvent } from '../src/core/verse/adapters/devin.js';
import { adapterFor } from '../src/core/verse/adapters/index.js';
import { devinSeatReadiness, discoverDevinSeats, DEVIN_CONNECT_HINT, DEVIN_CLI_LOGIN_HINT, DEVIN_ENABLE_HINT, mergeDevinSeats } from '../src/core/verse/devin-seats.js';
import { permissionOptionsFor, effortOptionsFor } from '../src/core/verse/session-controls.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { buildHandoffPreview } from '../src/core/verse/session-handoff.js';
import { savePlaybook } from '../src/core/playbooks/store.js';
import type { VerseSession } from '../src/core/verse/types.js';
import { FAKE_KEY, FAKE_ORG, fakeDevin, type FakeDevin } from './helpers/fake-devin.js';
import { fakeKeychain, type FakeKeychain } from './helpers/fake-keychain.js';

const REPO = 'ashlrai/devin-canary';
const VERSE_ID = '11111111-2222-3333-4444-555555555555';

let api: FakeDevin;
let keychain: FakeKeychain;

function deps(extra: Partial<DevinCloudTurnDeps> = {}): DevinCloudTurnDeps {
  return {
    keyStore: { run: keychain.run, platform: 'darwin' },
    fetch: api.fetch,
    sleep: async () => undefined,
    gh: async (args) => (args[0] === 'repo' && args[1] === 'view'
      ? { ok: true, stdout: 'main\n', stderr: '' }
      : { ok: true, stdout: '[]', stderr: '' }),
    config: () => ({ enabled: true }),
    policy: () => null,
    resolveRepo: async () => REPO,
    graceMs: 30_000,
    ...extra,
  };
}

async function connect(): Promise<void> {
  await storeDevinKey(FAKE_KEY, { run: keychain.run, platform: 'darwin' });
  writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain', connectedAt: new Date().toISOString() });
}

/** A scripted turn clock: every `sleep` advances time and runs the next step. */
function scripted(steps: Array<(() => void) | undefined>, opts: { abortAfter?: number } = {}) {
  const lines: DevinTurnLine[] = [];
  const controller = new AbortController();
  let t = 1_750_000_000_000;
  let i = 0;
  const io: DevinTurnIo = {
    emit: (line) => { lines.push(line); },
    signal: controller.signal,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      const step = steps[i];
      i += 1;
      step?.();
      if (opts.abortAfter !== undefined && i >= opts.abortAfter) controller.abort();
      if (i > 100) controller.abort(); // a runaway loop fails the test instead of hanging it
    },
  };
  return { io, lines, controller };
}

function payload(patch: Partial<DevinTurnPayload> = {}): DevinTurnPayload {
  return {
    v: 1,
    lane: 'cloud',
    verseSessionId: VERSE_ID,
    nativeId: null,
    projectPath: '/tmp/project',
    text: 'Add a health check endpoint',
    permissionMode: 'accept-edits',
    cliPath: null,
    model: null,
    ...patch,
  };
}

const only = <T extends DevinTurnLine['type']>(lines: DevinTurnLine[], type: T) =>
  lines.filter((l): l is Extract<DevinTurnLine, { type: T }> => l.type === type);

function onlySession(): { id: string; session: NonNullable<ReturnType<FakeDevin['sessions']['get']>> } {
  const [id, session] = [...api.sessions.entries()].at(-1)!;
  return { id, session };
}

beforeEach(() => {
  rmSync(devinHome(), { recursive: true, force: true });
  api = fakeDevin();
  keychain = fakeKeychain();
  resetDevinStatusCacheForTest();
  resetDevinCliProbeForTest();
});

// ---------------------------------------------------------------------------
// The cloud turn
// ---------------------------------------------------------------------------

describe('cloud turn: first message starts a Devin session bound to the repo', () => {
  it('creates, streams replies, cards the PR, meters ACUs and ends on "waiting for you"', async () => {
    await connect();
    const turn = scripted([
      () => {
        const { id, session } = onlySession();
        Object.assign(session, { status: 'running', status_detail: 'working', acus_consumed: 0.4 });
        api.say(id, 'Looking at the router now.');
      },
      () => {
        const { id, session } = onlySession();
        Object.assign(session, {
          status: 'running',
          status_detail: 'waiting_for_user',
          acus_consumed: 1.6,
          pull_requests: [{ pr_url: `https://github.com/${REPO}/pull/42`, pr_state: 'open' }],
        });
        api.say(id, 'Opened a PR with the endpoint and a test.');
      },
    ]);
    const code = await runDevinCloudTurn(payload(), turn.io, deps());
    expect(code).toBe(0);

    // The create: the chat contract, the repo, the per-chat cap, no structured report.
    const create = api.requests.find((r) => r.method === 'POST' && r.path.endsWith('/sessions'))!;
    const body = create.body as Record<string, unknown>;
    expect(body['repos']).toEqual([REPO]);
    expect(body['max_acu_limit']).toBe(readDevinBudget().maxAcuPerSession);
    expect(String(body['prompt'])).toMatch(/^Add a health check endpoint/);
    expect(String(body['prompt'])).toMatch(/Ashlr Verse chat/);
    expect(String(body['prompt'])).not.toMatch(/still push an empty commit/);
    expect(body['structured_output_schema']).toBeUndefined();

    // The task record: the operator's (never fleet), bound to this chat.
    const [task] = listDevinTasks();
    expect(task).toMatchObject({ origin: 'chat', requestedBy: 'mason', verseSessionId: VERSE_ID, repo: REPO });
    expect(only(turn.lines, 'native-session')).toEqual([{ type: 'native-session', id: task!.id }]);

    // Devin's own words only — the operator's prompt is already in the chat.
    expect(only(turn.lines, 'assistant-message').map((l) => l.text)).toEqual([
      'Looking at the router now.',
      'Opened a PR with the endpoint and a test.',
    ]);
    expect(only(turn.lines, 'remote-pr')).toEqual([{ type: 'remote-pr', url: `https://github.com/${REPO}/pull/42`, state: 'open' }]);
    const statuses = only(turn.lines, 'remote-status');
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'starting', 'working', 'waiting']);
    expect(statuses.at(-1)).toMatchObject({ message: 'Devin is waiting for you.', acusConsumed: 1.6, acuCap: readDevinBudget().maxAcuPerSession });
    expect(statuses.at(-1)!.url).toMatch(/^https:\/\/app\.devin\.ai\/sessions\//);

    // The PR comes before the status that ends the turn; the reply before both.
    const order = turn.lines.map((l) => l.type).filter((t) => t === 'assistant-message' || t === 'remote-pr' || t === 'remote-status');
    expect(order.slice(-3)).toEqual(['assistant-message', 'remote-pr', 'remote-status']);

    // Read position persisted, so the next turn never repeats a message.
    const state = readDevinChatState(task!.id);
    expect(state.prUrls).toEqual([`https://github.com/${REPO}/pull/42`]);
    expect(state.cursor).not.toBeNull();

    // The key never reaches the transcript protocol.
    expect(JSON.stringify(turn.lines)).not.toContain(FAKE_KEY);
    expect(listDevinTasks()[0]!.state).toBe('blocked');
  });

  it('refuses to start when the Devin budget would be exceeded, with the reason, before any API call', async () => {
    await connect();
    updateDevinBudget({ acuBudgetTotal: 0 });
    const turn = scripted([]);
    const code = await runDevinCloudTurn(payload(), turn.io, deps());
    expect(code).toBe(1);
    expect(only(turn.lines, 'error')[0]!.message).toMatch(/^Devin budget: No Devin ACU budget is set/);
    expect(api.requests).toHaveLength(0);
    expect(listDevinTasks()).toHaveLength(0);
  });

  it('refuses a folder without a GitHub origin', async () => {
    await connect();
    const turn = scripted([]);
    const code = await runDevinCloudTurn(payload(), turn.io, deps({ resolveRepo: async () => null }));
    expect(code).toBe(1);
    expect(only(turn.lines, 'error')[0]!.message).toMatch(/no GitHub `origin` remote/);
    expect(api.requests).toHaveLength(0);
  });

  it('scrubs cog_ keys out of anything Devin says', async () => {
    await connect();
    const turn = scripted([
      () => {
        const { id, session } = onlySession();
        Object.assign(session, { status: 'running', status_detail: 'waiting_for_user' });
        api.say(id, 'The key you pasted was cog_abcdefghijklmnopqrstuvwx — rotate it.');
      },
    ]);
    await runDevinCloudTurn(payload(), turn.io, deps());
    const text = only(turn.lines, 'assistant-message').map((l) => l.text).join('\n');
    expect(text).not.toMatch(/cog_abcdefghijklmnop/);
    expect(text).toMatch(/rotate it/);
  });
});

describe('cloud turn: follow-ups, suspension, errors, Stop', () => {
  async function startedChat(): Promise<string> {
    await connect();
    const first = scripted([() => Object.assign(onlySession().session, { status: 'running', status_detail: 'waiting_for_user' })]);
    expect(await runDevinCloudTurn(payload(), first.io, deps())).toBe(0);
    return listDevinTasks()[0]!.id;
  }

  it('posts the message and ignores a stale "waiting for you" until Devin picks it up', async () => {
    const taskId = await startedChat();
    const { id } = onlySession();
    const turn = scripted([
      // Poll 1 still reads the previous "waiting for you": the turn must not end on it.
      () => Object.assign(onlySession().session, { status: 'running', status_detail: 'working' }),
      () => {
        api.say(id, 'Done — the tests pass now.');
        Object.assign(onlySession().session, { status: 'running', status_detail: 'waiting_for_user' });
      },
    ]);
    const code = await runDevinCloudTurn(payload({ nativeId: taskId, text: 'Now fix the flaky test' }), turn.io, deps());
    expect(code).toBe(0);
    const post = api.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages'));
    expect(post).toHaveLength(1);
    expect(post[0]!.body).toEqual({ message: 'Now fix the flaky test' });
    expect(only(turn.lines, 'assistant-message').map((l) => l.text)).toEqual(['Done — the tests pass now.']);
    expect(only(turn.lines, 'remote-status').map((s) => s.state)).toEqual(['working', 'waiting']);
    expect(readDevinTask(taskId)!.messagesSent).toBe(1);
  });

  it('ends a turn when Devin goes to sleep, and a message wakes it (resume after suspension)', async () => {
    const taskId = await startedChat();
    const { id } = onlySession();
    Object.assign(onlySession().session, { status: 'running', status_detail: 'working' });
    const sleepy = scripted([() => Object.assign(onlySession().session, { status: 'suspended', status_detail: 'inactivity' })]);
    // First poll reads "working" (the message was picked up), second "suspended".
    const code = await runDevinCloudTurn(payload({ nativeId: taskId, text: 'Keep going' }), sleepy.io, deps());
    expect(code).toBe(0);
    expect(only(sleepy.lines, 'remote-status').at(-1)).toMatchObject({ state: 'suspended', message: expect.stringMatching(/went to sleep/) });

    // The next message resumes it (the fake wakes a suspended session on POST, as documented).
    const wake = scripted([() => {
      api.say(id, 'Back — picking up where I left off.');
      Object.assign(onlySession().session, { status: 'running', status_detail: 'waiting_for_user' });
    }]);
    expect(await runDevinCloudTurn(payload({ nativeId: taskId, text: 'Wake up' }), wake.io, deps())).toBe(0);
    expect(only(wake.lines, 'assistant-message').map((l) => l.text)).toEqual(['Back — picking up where I left off.']);
  });

  it('fails the turn when the session errors', async () => {
    const taskId = await startedChat();
    const turn = scripted([() => Object.assign(onlySession().session, { status: 'error', status_detail: 'error' })]);
    Object.assign(onlySession().session, { status: 'running', status_detail: 'working' });
    expect(await runDevinCloudTurn(payload({ nativeId: taskId, text: 'Try again' }), turn.io, deps())).toBe(1);
    expect(only(turn.lines, 'error').at(-1)!.message).toMatch(/ended in an error/);
  });

  it('Stop only stops watching: exit 130, and nothing is terminated', async () => {
    const taskId = await startedChat();
    Object.assign(onlySession().session, { status: 'running', status_detail: 'working' });
    const turn = scripted([undefined, undefined], { abortAfter: 1 });
    expect(await runDevinCloudTurn(payload({ nativeId: taskId, text: 'Long job' }), turn.io, deps())).toBe(130);
    expect(api.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(onlySession().session.status).toBe('running');
  });

  it('terminate = DELETE; the task closes; the next message asks the engine for a fresh session', async () => {
    const taskId = await startedChat();
    const result = await terminateDevinChat(taskId, deps());
    expect(result.ok).toBe(true);
    const del = api.requests.filter((r) => r.method === 'DELETE');
    expect(del).toHaveLength(1);
    expect(del[0]!.path).toBe(`/v3/organizations/${FAKE_ORG}/sessions/${onlySession().id}`);
    expect(readDevinTask(taskId)).toMatchObject({ state: 'closed', stateReason: 'Terminated from its Verse chat.' });

    const after = scripted([]);
    expect(await runDevinCloudTurn(payload({ nativeId: taskId, text: 'Hello?' }), after.io, deps())).toBe(1);
    expect(only(after.lines, 'error')[0]).toMatchObject({ code: 'native-thread-missing' });
  });

  it('a chat whose task is gone asks for a fresh session (native-thread-missing)', async () => {
    await connect();
    const turn = scripted([]);
    expect(await runDevinCloudTurn(payload({ nativeId: 'dv_20260927T0400_zzzzzz', text: 'hi' }), turn.io, deps())).toBe(1);
    expect(only(turn.lines, 'error')[0]).toMatchObject({ code: 'native-thread-missing' });
  });
});

describe('limits and handoff', () => {
  it('never truncates a long message silently', async () => {
    await connect();
    const turn = scripted([]);
    expect(await runDevinCloudTurn(payload({ text: 'x'.repeat(20_001) }), turn.io, deps())).toBe(1);
    expect(only(turn.lines, 'error')[0]!.message).toMatch(/up to 20,000 characters/);
    expect(api.requests).toHaveLength(0);
  });

  it('a Devin chat hands back as a summary: its replies become the handoff note’s state', () => {
    const s = session({ title: 'Health check' });
    const note = buildHandoffPreview(s, [
      { seq: 1, at: new Date(0).toISOString(), type: 'user-message', turnId: 't1', text: 'Add a health check endpoint' },
      { seq: 2, at: new Date(0).toISOString(), type: 'remote-status', turnId: 't1', provider: 'devin', state: 'working', message: 'Devin is working…', url: null, acusConsumed: null, acuCap: null },
      { seq: 3, at: new Date(0).toISOString(), type: 'assistant-message', turnId: 't1', text: 'Added GET /healthz and a test; PR #42 is open.' },
      { seq: 4, at: new Date(0).toISOString(), type: 'remote-pr', turnId: 't1', provider: 'devin', url: `https://github.com/${REPO}/pull/42`, state: 'open' },
      { seq: 5, at: new Date(0).toISOString(), type: 'turn-done', turnId: 't1', ok: true, nativeSessionId: 'dv_x', durationMs: 1 },
    ], { gitDiffStat: () => null });
    expect(note.text).toMatch(/Add a health check endpoint/);
    expect(note.text).toMatch(/Added GET \/healthz/);
  });
});

describe('playbooks in a Devin chat (3.15, #543)', () => {
  function playbookSource(): string {
    return [
      '---', 'id: ship-widget', 'name: Ship a widget', 'macro: !ship-widget', 'description: Build the widget the careful way.',
      'kinds: []', `repos: [${REPO}]`, 'globs: []', 'auto: true', 'budget-usd: 4', 'done-when:', '  - npm test passes', '---', '',
      '## Outcome', '', 'The widget ships.', '', '## Procedure', '', '1. Build it.', '2. Test it.', '',
      '## Forbidden actions', '', '- Do not skip tests.', '',
    ].join('\n');
  }

  async function firstPrompt(text: string): Promise<{ prompt: string; task: ReturnType<typeof listDevinTasks>[number] }> {
    await connect();
    const turn = scripted([() => Object.assign(onlySession().session, { status: 'running', status_detail: 'waiting_for_user' })]);
    expect(await runDevinCloudTurn(payload({ text }), turn.io, deps())).toBe(0);
    const create = api.requests.find((r) => r.method === 'POST' && r.path.endsWith('/sessions'))!;
    return { prompt: String((create.body as Record<string, unknown>)['prompt']), task: listDevinTasks()[0]! };
  }

  it('a `!macro` in the first message runs that playbook (block in the prompt, version on the task)', async () => {
    await savePlaybook(playbookSource(), { author: 'mason', note: 'first' });
    const { prompt, task } = await firstPrompt('!ship-widget add the settings page');
    expect(prompt).toMatch(/Build it\./);
    expect(prompt.indexOf('Build it.')).toBeLessThan(prompt.indexOf('If — and only if — you change code'));
    expect(task.playbookRef).toMatchObject({ id: 'ship-widget', version: 1 });
  });

  it('never auto-attaches a playbook to a conversation', async () => {
    await savePlaybook(playbookSource(), { author: 'mason', note: 'first' });
    const { prompt, task } = await firstPrompt('what does the settings page do?');
    expect(prompt).not.toMatch(/Build it\./);
    expect(task.playbookRef).toBeUndefined();
  });
});

describe('remote state words', () => {
  it('maps every documented status', () => {
    expect(remoteStateOf({ status: 'running', statusDetail: 'working' })).toMatchObject({ state: 'working', ends: false });
    expect(remoteStateOf({ status: 'running', statusDetail: 'waiting_for_approval' })).toMatchObject({ state: 'waiting', ends: true });
    expect(remoteStateOf({ status: 'running', statusDetail: 'finished' })).toMatchObject({ state: 'finished', ends: true });
    expect(remoteStateOf({ status: 'suspended', statusDetail: 'out_of_credits' })).toMatchObject({ state: 'suspended', message: expect.stringMatching(/out of credits/) });
    expect(remoteStateOf({ status: 'resuming', statusDetail: null })).toMatchObject({ state: 'starting', ends: false });
    expect(remoteStateOf({ status: 'exit', statusDetail: null })).toMatchObject({ state: 'finished', ends: true });
  });
});

// ---------------------------------------------------------------------------
// Interactive ≠ fleet; Needs-you
// ---------------------------------------------------------------------------

describe('interactive chats are the operator’s own', () => {
  it('count against the ACU budget but never against the fleet’s caps; Needs-you shows only their PRs', async () => {
    await connect();
    const run = scripted([
      () => Object.assign(onlySession().session, { status: 'running', status_detail: 'working', acus_consumed: 2 }),
      () => Object.assign(onlySession().session, { status: 'running', status_detail: 'waiting_for_user', acus_consumed: 2 }),
    ]);
    await runDevinCloudTurn(payload(), run.io, deps());
    const view = devinBudgetView(listDevinTasks(), readDevinBudget(), new Date());
    expect(view.acuUsed).toBeGreaterThan(0);
    expect(view.fleetRunning).toBe(0);
    expect(view.fleetSessionsToday).toBe(0);

    const chat = listDevinTasks()[0]!;
    // Waiting for the operator: the chat shows it; no Needs-you item.
    expect(devinNeedsYouItems([chat], new Date())).toEqual([]);
    // A verified PR from the chat IS a Needs-you item, naming the chat.
    const withPr = {
      ...chat,
      state: 'pr-open' as const,
      pr: { number: 42, url: `https://github.com/${REPO}/pull/42`, state: 'open' as const, draft: false, title: '[ashlr-devin] Add a health check endpoint' },
    };
    writeDevinTask(withPr);
    const items = devinNeedsYouItems([readDevinTask(chat.id)!], new Date());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'owner-lane-pr', subject: { sessionId: VERSE_ID, seatId: 'devin' } });
  });
});

// ---------------------------------------------------------------------------
// Seat discovery + readiness
// ---------------------------------------------------------------------------

describe('Devin seats', () => {
  const noCli = { cliCandidates: [] as string[] };

  it('not connected: listed, disabled, with the connect command; context window "remote" (null)', async () => {
    const { seats, launches } = await discoverDevinSeats({ ...noCli, status: async () => ({ state: 'not-connected', reason: 'No Devin API key yet.' }) });
    expect(seats.map((s) => s.id)).toEqual(['devin']);
    expect(seats[0]).toMatchObject({ engine: 'devin', label: 'Devin (cloud)', contextWindow: null, health: { state: 'unavailable', summary: DEVIN_CONNECT_HINT } });
    expect(seats[0]!.models[0]).toMatchObject({ id: 'devin', unavailableReason: DEVIN_CONNECT_HINT });
    expect(launches.get('devin')).toMatchObject({ launcher: null, devin: { lane: 'cloud' } });
    // Nothing secret in what the page receives.
    expect(JSON.stringify(seats)).not.toMatch(/cog_/);
  });

  it('connected but switched off: the enable command', async () => {
    const { seats } = await discoverDevinSeats({ ...noCli, status: async () => ({ state: 'disabled', reason: 'Connected, but the Devin lane is turned off (`ashlr devin enable`).' }) });
    expect(seats[0]!.health).toMatchObject({ state: 'unavailable', summary: DEVIN_ENABLE_HINT });
  });

  it('ready: runnable, with today’s ACUs and the per-chat cap as its summary', async () => {
    const { seats } = await discoverDevinSeats({ ...noCli, status: async () => ({ state: 'ready', reason: 'Connected.' }) });
    expect(seats[0]!.health.state).toBe('ready');
    expect(seats[0]!.health.summary).toMatch(/ACUs? of \d+ ACUs today · up to \d+ ACUs per chat/);
    expect(seats[0]!.models[0]!.unavailableReason).toBeUndefined();
  });

  it('the CLI seat appears only when the binary exists, and is disabled until logged in', async () => {
    const dir = join(tmpdir(), `devin-cli-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'devin');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    const creds = join(dir, 'credentials.toml');
    const status = async () => ({ state: 'not-connected' as const, reason: '' });

    const out = await discoverDevinSeats({ status, cliCandidates: [bin], cliCredentialsPath: creds });
    const cli = out.seats.find((s) => s.id === 'devin-cli')!;
    expect(cli).toMatchObject({ label: 'Devin (CLI)', engine: 'devin', health: { state: 'unavailable', summary: DEVIN_CLI_LOGIN_HINT } });
    expect(out.launches.get('devin-cli')).toMatchObject({ devin: { lane: 'cli', cliPath: bin } });

    writeFileSync(creds, 'x');
    const loggedIn = await discoverDevinSeats({ status, cliCandidates: [bin], cliCredentialsPath: creds });
    expect(loggedIn.seats.find((s) => s.id === 'devin-cli')!.health.state).toBe('ready');

    const none = await discoverDevinSeats({ status, cliCandidates: [join(dir, 'nope')] });
    expect(none.seats.map((s) => s.id)).toEqual(['devin']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('merge never replaces an existing seat id', async () => {
    const devin = await discoverDevinSeats({ ...noCli, status: async () => ({ state: 'ready', reason: '' }) });
    const merged = mergeDevinSeats({ seats: [], launches: new Map(), localRuntime: { ollama: { reachable: false, baseUrl: '', models: [] } } }, devin);
    expect(merged.seats.map((s) => s.id)).toEqual(['devin']);
    expect(merged.launches.has('devin')).toBe(true);
  });

  it('readiness: a new chat is refused past the budget with its reason; a chat with a session is admitted', () => {
    updateDevinBudget({ acuBudgetTotal: 0 });
    const refused = devinSeatReadiness('devin', { nativeSessionId: null });
    expect(refused).toMatchObject({ ready: false, reason: expect.stringMatching(/^Devin budget: /) });
    expect(devinSeatReadiness('devin', { nativeSessionId: 'dv_20260927T0400_aaaaaa' })).toMatchObject({ ready: true });
    expect(devinSeatReadiness('claude')).toBeNull();
    expect(devinSeatReadiness('devin-cli')).toMatchObject({ ready: true });
  });

  it('controls: no effort; permission modes without a separate auto', () => {
    expect(effortOptionsFor('devin').every((o) => !o.available)).toBe(true);
    const modes = permissionOptionsFor('devin');
    expect(modes.find((m) => m.id === 'auto')).toMatchObject({ available: false });
    expect(modes.filter((m) => m.available).map((m) => m.id)).toEqual(['plan', 'accept-edits', 'bypass']);
  });
});

// ---------------------------------------------------------------------------
// Adapter: launch + line protocol
// ---------------------------------------------------------------------------

function session(patch: Partial<VerseSession> = {}): VerseSession {
  return {
    id: VERSE_ID,
    title: 'Devin chat',
    projectPath: '/tmp/project',
    engine: 'devin',
    accountId: 'devin',
    seatId: 'devin',
    model: 'devin',
    nativeSessionId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    status: 'idle',
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null },
    lastError: null,
    ...patch,
  };
}

describe('devin adapter', () => {
  const launch = (patch: Partial<VerseSeatLaunch> = {}): VerseSeatLaunch => ({
    seat: { id: 'devin', engine: 'devin', label: 'Devin (cloud)', accountId: 'devin', models: [], contextWindow: null, health: { state: 'ready', summary: null, windows: [], observedAt: null } },
    launcher: null,
    ollamaBaseUrl: '',
    devin: { lane: 'cloud' },
    ...patch,
  });

  it('is the adapter for engine devin', () => {
    expect(adapterFor('devin')).toBe(devinAdapter);
  });

  it('carries the request on stdin (never argv), with no secret', () => {
    const built = devinAdapter.buildLaunch(session({ nativeSessionId: 'dv_20260927T0400_aaaaaa' }), 'Ship it -- now', launch());
    expect(built.argv.join(' ')).not.toContain('Ship it');
    expect(built.stdin).not.toBeNull();
    const parsed = parseDevinTurnPayload(JSON.parse(built.stdin!));
    expect(parsed).toMatchObject({ lane: 'cloud', verseSessionId: VERSE_ID, nativeId: 'dv_20260927T0400_aaaaaa', text: 'Ship it -- now', permissionMode: 'accept-edits', cliPath: null, model: null });
    expect(built.stdin).not.toMatch(/cog_/);
    expect(Object.keys(built.env).every((k) => ['ASHLR_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'].includes(k))).toBe(true);
  });

  it('the CLI lane carries its binary and model', () => {
    const built = devinAdapter.buildLaunch(session({ seatId: 'devin-cli', model: 'opus', controls: { permissionMode: 'plan' } }), 'hi', launch({ devin: { lane: 'cli', cliPath: '/opt/homebrew/bin/devin' } }));
    expect(parseDevinTurnPayload(JSON.parse(built.stdin!))).toMatchObject({ lane: 'cli', cliPath: '/opt/homebrew/bin/devin', model: 'opus', permissionMode: 'plan' });
    expect(() => devinAdapter.buildLaunch(session({ seatId: 'devin-cli' }), 'hi', launch({ devin: { lane: 'cli' } }))).toThrow(/not found/);
  });

  it('parses exactly the protocol, and drops anything malformed', () => {
    const parser = createDevinParser('t1');
    expect(parser.push(JSON.stringify({ type: 'native-session', id: 'dv_20260927T0400_aaaaaa' }))).toEqual([]);
    expect(parser.nativeSessionId()).toBe('dv_20260927T0400_aaaaaa');
    expect(parser.push(JSON.stringify({ type: 'assistant-message', text: 'hello' }))).toEqual([{ type: 'assistant-message', turnId: 't1', text: 'hello' }]);
    expect(parser.push(JSON.stringify({ type: 'remote-status', state: 'waiting', message: 'Devin is waiting for you.', url: 'https://app.devin.ai/sessions/devin-1', acusConsumed: 1.5, acuCap: 10 })))
      .toEqual([{ type: 'remote-status', turnId: 't1', provider: 'devin', state: 'waiting', message: 'Devin is waiting for you.', url: 'https://app.devin.ai/sessions/devin-1', acusConsumed: 1.5, acuCap: 10 }]);
    expect(parser.push(JSON.stringify({ type: 'remote-pr', url: `https://github.com/${REPO}/pull/7`, state: 'open' })))
      .toEqual([{ type: 'remote-pr', turnId: 't1', provider: 'devin', url: `https://github.com/${REPO}/pull/7`, state: 'open' }]);
    // Malformed / hostile lines never become events.
    expect(parser.push('not json')).toEqual([]);
    expect(parser.push(JSON.stringify({ type: 'remote-status', state: 'hacked', message: 'x', url: null, acusConsumed: null, acuCap: null }))).toEqual([]);
    expect(parser.push(JSON.stringify({ type: 'remote-status', state: 'working', message: 'x', url: 'javascript:alert(1)', acusConsumed: null, acuCap: null }))).toEqual([]);
    expect(parser.push(JSON.stringify({ type: 'remote-pr', url: 'https://evil.example/pull/1', state: null }))).toEqual([]);
    expect(parser.push(JSON.stringify({ type: 'turn-done', ok: true }))).toEqual([]);
    expect(parser.push(JSON.stringify({ type: 'usage', usage: { inputTokens: 1e9 } }))).toEqual([]);
    expect(devinLineToEvent({ type: 'progress', phase: 'tool', elapsedMs: 5, tool: 'Devin' }, 't')).toEqual({ type: 'progress', turnId: 't', phase: 'tool', elapsedMs: 5, tool: 'Devin' });
    expect(parser.finish(0)).toEqual([]);
  });
});
