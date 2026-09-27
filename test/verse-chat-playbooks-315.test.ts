/**
 * 3.15 follow-up — a `!macro` runs its playbook in EVERY Verse chat, through
 * the real session engine and the shared playbook code (playbooks/lanes.ts
 * `chatPlaybook` → resolve.ts). What the seat receives is recorded by each
 * adapter's `buildLaunch` (the one hand-off every seat shares); the logged
 * user message keeps the operator's text as typed, plus a chip naming the
 * playbook. Real (trivial) subprocesses per turn: real-io lane.
 *
 * Built-in playbooks resolve from code, so nothing is written to disk except
 * the one auto-matching playbook the "never auto" case saves (isolated HOME).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chatPlaybook } from '../src/core/playbooks/lanes.js';
import { savePlaybook } from '../src/core/playbooks/store.js';
import { createDevinParser, devinAdapter } from '../src/core/verse/adapters/devin.js';
import type { VerseAdapter } from '../src/core/verse/adapters/index.js';
import { createVerseEngine, type VerseEngineHandle, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { isTransientVerseEvent, type VerseEngine, type VerseEvent, type VerseSeat, type VerseSession } from '../src/core/verse/types.js';

const BLOCK_HEAD = '## Playbook: Fix a reported bug (!fix-bug';

function seat(id: string, engine: VerseEngine): VerseSeat {
  return {
    id,
    engine,
    label: id,
    accountId: id,
    models: [{ id: engine === 'devin' ? 'devin' : 'default', label: 'default', contextWindow: null }],
    contextWindow: null,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
  };
}

function untilTurnDone(engine: VerseEngineHandle, id: string, fromSeq = 0, timeoutMs = 15_000): Promise<VerseEvent[]> {
  return new Promise((resolve, reject) => {
    const seen: VerseEvent[] = [];
    const timer = setTimeout(() => { off(); reject(new Error(`turn-done not seen; saw ${seen.map((e) => e.type).join(',')}`)); }, timeoutMs);
    const off = engine.subscribe(id, fromSeq, (event) => {
      if (isTransientVerseEvent(event)) return;
      seen.push(event);
      if (event.type === 'turn-done') {
        clearTimeout(timer);
        off();
        resolve(seen);
      }
    });
  });
}

let work: string;
let project: string;
let engine: VerseEngineHandle;
/** Every text a seat was handed, by engine. */
let sent: Array<{ engine: VerseEngine; text: string; stdin: string | null }>;

/** A turn process that just prints a Devin `native-session` line and exits 0 (every engine's parser ignores what it cannot read). */
const TURN = [process.execPath, '-e', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'native-session',id:'native-1'})+'\\n')})`];

/** A recording adapter per engine; the Devin one keeps the real adapter's request and playbook rule. */
function recording(engineId: VerseEngine): VerseAdapter {
  if (engineId === 'devin') {
    return {
      buildLaunch: (session, text, launch) => {
        const real = devinAdapter.buildLaunch(session, text, launch);
        sent.push({ engine: engineId, text, stdin: real.stdin ?? null });
        return { ...real, argv: TURN };
      },
      createParser: createDevinParser,
      resolvesPlaybooks: devinAdapter.resolvesPlaybooks,
    };
  }
  return {
    buildLaunch: (_session, text) => {
      sent.push({ engine: engineId, text, stdin: null });
      return { argv: TURN, cwd: project, env: {}, stdin: '' };
    },
    createParser: createDevinParser,
  };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'verse-playbooks-'));
  project = join(work, 'project');
  mkdirSync(project, { mode: 0o700 });
  project = realpathSync(project);
  sent = [];
  engine = createVerseEngine({
    root: join(work, 'root'),
    reasoningTap: null,
    preflight: null,
    readiness: null,
    killGraceMs: 200,
    adapterFor: recording,
  });
});

afterEach(() => {
  engine.close();
  rmSync(work, { recursive: true, force: true });
});

function launchFor(s: VerseSeat, devin?: VerseSeatLaunch['devin']): VerseSeatLaunch {
  // The recording adapters never run the launcher; the engine only requires one for account seats.
  const launcher = s.engine === 'devin' || s.engine === 'local' ? null : [process.execPath, '/unused/launcher.js'];
  return { seat: s, launcher, ollamaBaseUrl: '', ...(devin ? { devin } : {}) };
}

async function turn(session: VerseSession, text: string, from = 0): Promise<VerseEvent[]> {
  const done = untilTurnDone(engine, session.id, from);
  engine.sendTurn(session.id, text);
  return done;
}

const userMessage = (events: VerseEvent[]) => events.find((e): e is Extract<VerseEvent, { type: 'user-message' }> => e.type === 'user-message')!;

describe('a `!macro` in any chat runs its playbook', () => {
  it.each([
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['grok', 'grok'],
    ['local', 'local'],
  ] as const)('%s seat: the seat gets the block after the text; the message is logged as typed, with a chip', async (id, engineId) => {
    const s = seat(id, engineId);
    const session = engine.createSession({ projectPath: project, seatId: s.id }, launchFor(s));
    const events = await turn(session, '!fix-bug the login page 500s');

    const logged = userMessage(events);
    expect(logged.text).toBe('!fix-bug the login page 500s');
    expect(logged.playbook).toEqual({ id: 'fix-issue', version: expect.any(Number), name: 'Fix a reported bug', macro: '!fix-bug' });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text.startsWith('!fix-bug the login page 500s\n\n')).toBe(true);
    expect(sent[0]!.text).toContain(BLOCK_HEAD);
    // Persisted with the chip (a reopened chat still shows it).
    expect(engine.getEvents(session.id).find((e) => e.type === 'user-message')).toMatchObject({ playbook: { id: 'fix-issue' } });
  });

  it('an unknown `!word`, or a macro inside code, is just text: byte-identical, no chip', async () => {
    const s = seat('claude', 'claude');
    const session = engine.createSession({ projectPath: project, seatId: s.id }, launchFor(s));
    const first = await turn(session, 'make the rule !important please');
    expect(userMessage(first).playbook).toBeUndefined();
    const second = await turn(session, 'what does `!fix-bug` expand to?', first.at(-1)!.seq);
    expect(userMessage(second).playbook).toBeUndefined();
    expect(sent.map((x) => x.text)).toEqual(['make the rule !important please', 'what does `!fix-bug` expand to?']);
  });

  it('Devin (CLI): the block rides in the turn request', async () => {
    const s = seat('devin-cli', 'devin');
    const session = engine.createSession({ projectPath: project, seatId: s.id }, launchFor(s, { lane: 'cli', cliPath: '/opt/homebrew/bin/devin' }));
    const events = await turn(session, '!fix-bug checkout rounds wrong');
    expect(userMessage(events).playbook).toMatchObject({ id: 'fix-issue' });
    expect(JSON.parse(sent[0]!.stdin!).text).toContain(BLOCK_HEAD);
  });

  it('Devin (cloud): the first message leaves the block to the Devin launch (no double block); follow-ups get it', async () => {
    const s = seat('devin', 'devin');
    const session = engine.createSession({ projectPath: project, seatId: s.id }, launchFor(s, { lane: 'cloud' }));
    const first = await turn(session, '!fix-bug checkout rounds wrong');
    // The chip still shows; launchDevinTask resolves the same `!fix-bug` from the text and pins it on the task.
    expect(userMessage(first).playbook).toMatchObject({ id: 'fix-issue' });
    expect(JSON.parse(sent[0]!.stdin!).text).toBe('!fix-bug checkout rounds wrong');

    const second = await turn(session, '!fix-test and the flaky spec', first.at(-1)!.seq);
    expect(userMessage(second).playbook).toMatchObject({ id: 'fix-failing-test', macro: '!fix-test' });
    expect(JSON.parse(sent[1]!.stdin!).text).toContain('## Playbook: Fix a failing test (!fix-test');
  });

  it('`playbookFor: null` turns it off', async () => {
    engine.close();
    engine = createVerseEngine({ root: join(work, 'root2'), reasoningTap: null, preflight: null, readiness: null, killGraceMs: 200, adapterFor: recording, playbookFor: null });
    const s = seat('claude', 'claude');
    const session = engine.createSession({ projectPath: project, seatId: s.id }, launchFor(s));
    const events = await turn(session, '!fix-bug x');
    expect(userMessage(events).playbook).toBeUndefined();
    expect(sent[0]!.text).toBe('!fix-bug x');
  });
});

describe('chatPlaybook (the shared hook)', () => {
  it('resolves a typed macro, pinned or not, and renders the same block the other lanes read', () => {
    const hit = chatPlaybook('!fix-bug the login page', null)!;
    expect(hit).toMatchObject({ ref: { id: 'fix-issue' }, name: 'Fix a reported bug', macro: '!fix-bug' });
    expect(hit.block.startsWith(BLOCK_HEAD)).toBe(true);
    expect(chatPlaybook('!fix-bug@v1 the login page', null)).toMatchObject({ ref: { id: 'fix-issue', version: 1 } });
    expect(chatPlaybook('!fix-bug@v999 the login page', null)).toBeNull();
    expect(chatPlaybook('no macro here', null)).toBeNull();
  });

  it('never auto-attaches a playbook to a chat message', async () => {
    await savePlaybook([
      '---', 'id: always-widget', 'name: Always a widget', 'macro: !always-widget', 'description: Auto-matches everything in the repo.',
      'kinds: []', 'repos: [ashlrai/widgets]', 'globs: []', 'auto: true', 'done-when:', '  - it ships', '---', '',
      '## Outcome', '', 'Done.', '', '## Procedure', '', '1. Do it.', '',
    ].join('\n'), { author: 'mason', note: 'first' });
    expect(chatPlaybook('fix the widget please', 'ashlrai/widgets')).toBeNull();
    // A macro still wins, and an unknown one next to it does not fall back to auto.
    expect(chatPlaybook('!always-widget now', 'ashlrai/widgets')).toMatchObject({ ref: { id: 'always-widget' } });
    expect(chatPlaybook('!nope now', 'ashlrai/widgets')).toBeNull();
  });
});
