import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushVerseReasoning,
  flushVerseReasoningQueue,
  ingestVerseSessionLogs,
  recordVerseReasoning,
  resetVerseReasoningTap,
} from '../src/core/reasoning/ingest-verse.js';
import { reasoningRoot, scanFeatures, scanSteps } from '../src/core/reasoning/store.js';
import type { TurnFeaturesV1 } from '../src/core/reasoning/extractors.js';
import type { ReasoningStepV1 } from '../src/core/reasoning/types.js';
import type { VerseEvent } from '../src/core/verse/types.js';

let home: string;
let verseRoot: string;
const savedHome = process.env['HOME'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reasoning-verse-'));
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
  verseRoot = join(home, '.ashlr', 'verse');
  mkdirSync(join(verseRoot, 'sessions'), { recursive: true });
  resetVerseReasoningTap(null);
});

afterEach(() => {
  resetVerseReasoningTap(null);
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const wide = { fromMs: Date.now() - 10 * 86_400_000, toMs: Date.now() + 86_400_000 };
async function steps(): Promise<ReasoningStepV1[]> {
  flushVerseReasoningQueue(); // live steps are batched (≤ 250 ms); make them visible now
  const out: ReasoningStepV1[] = [];
  await scanSteps(wide, (s) => { out.push(s); });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
async function features(): Promise<TurnFeaturesV1[]> {
  const out: TurnFeaturesV1[] = [];
  await scanFeatures(wide, (f) => { out.push(f); });
  return out;
}

const session = { id: 'sess1', engine: 'claude' as const, model: 'claude-opus-5', projectPath: '' };
const base = Date.now() - 3_600_000;
const t = (s: number): string => new Date(base + s * 1_000).toISOString();

function turn(turnId: string, startSeq: number, opts: { fail?: boolean; done?: boolean } = {}): VerseEvent[] {
  let seq = startSeq;
  const events: VerseEvent[] = [
    { seq: seq++, at: t(seq), type: 'user-message', turnId, text: 'fix the test' },
    { seq: seq++, at: t(seq), type: 'turn-started', turnId, pid: 1 },
    { seq: seq++, at: t(seq), type: 'thinking', turnId, text: "I'm not sure why this fails; it's unclear." },
    { seq: seq++, at: t(seq), type: 'tool-use', turnId, toolUseId: `${turnId}-u1`, name: 'Edit', input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } },
    { seq: seq++, at: t(seq), type: 'tool-result', turnId, toolUseId: `${turnId}-u1`, output: 'ok', isError: false },
    { seq: seq++, at: t(seq), type: 'thinking', turnId, text: 'Now run the tests.' },
    { seq: seq++, at: t(seq), type: 'tool-use', turnId, toolUseId: `${turnId}-u2`, name: 'Bash', input: { command: 'npm test' } },
    { seq: seq++, at: t(seq), type: 'tool-result', turnId, toolUseId: `${turnId}-u2`, output: 'x', isError: opts.fail === true },
    { seq: seq++, at: t(seq), type: 'assistant-message', turnId, text: 'Done, all tests pass.' },
  ];
  if (opts.done !== false) {
    events.push({ seq: seq++, at: t(seq), type: 'turn-done', turnId, ok: opts.fail !== true, nativeSessionId: null, durationMs: 1000 });
  }
  return events;
}

function writeSession(id: string, events: VerseEvent[], record: Record<string, unknown> = {}): string {
  const dir = join(verseRoot, 'sessions');
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, engine: 'claude', model: 'claude-opus-5', projectPath: join(home, 'code', 'app'), ...record }));
  const path = join(dir, `${id}.events.jsonl`);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

describe('recordVerseReasoning (live tap)', () => {
  it('writes each thinking step once the next event reveals the tool it led to', async () => {
    const events = turn('t1', 1);
    for (const event of events.slice(0, 3)) recordVerseReasoning(event, session);
    expect(await steps()).toEqual([]); // held until the next event
    recordVerseReasoning(events[3]!, session); // tool-use Edit
    let got = await steps();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'verse:sess1:3', source: 'verse', sessionId: 'sess1', engine: 'claude', model: 'claude-opus-5', turnId: 't1', kind: 'thinking', toolAfter: 'Edit' });
    for (const event of events.slice(4)) recordVerseReasoning(event, session);
    got = await steps();
    expect(got.map((s) => s.toolAfter)).toEqual(['Edit', 'Bash']);
    // The tap never writes features: the backfill owns them (it sees the whole log).
    expect(await features()).toEqual([]);
  });

  it('batches live writes: nothing hits disk until the flush window or the batch size', async () => {
    const readRaw = async (): Promise<number> => {
      const out: ReasoningStepV1[] = [];
      await scanSteps(wide, (s) => { out.push(s); });
      return out.length;
    };
    recordVerseReasoning({ seq: 1, at: t(1), type: 'thinking', turnId: 'q', text: 'a' }, session);
    recordVerseReasoning({ seq: 2, at: t(2), type: 'tool-use', turnId: 'q', toolUseId: 'x', name: 'Bash', input: {} }, session);
    expect(await readRaw()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await readRaw()).toBe(1);
  });

  it('ignores transient events and never throws on junk', async () => {
    recordVerseReasoning({ seq: 1, at: t(1), type: 'thinking-delta', turnId: 't', text: 'partial' }, session);
    recordVerseReasoning({ seq: 1, at: t(1), type: 'progress', turnId: 't', phase: 'thinking', elapsedMs: 5 }, session);
    expect(() => recordVerseReasoning(null as never, session)).not.toThrow();
    expect(() => recordVerseReasoning({ seq: 2 } as never, null as never)).not.toThrow();
    expect(await steps()).toEqual([]);
  });

  it('maps thinking kinds and keeps redacted blocks as empty-text steps', async () => {
    recordVerseReasoning({ seq: 1, at: t(1), type: 'thinking', turnId: 't', text: 'summary text', kind: 'summary' }, { ...session, engine: 'codex' });
    recordVerseReasoning({ seq: 2, at: t(2), type: 'thinking', turnId: 't', text: '', redacted: true }, { ...session, engine: 'codex' });
    recordVerseReasoning({ seq: 3, at: t(3), type: 'turn-done', turnId: 't', ok: true, nativeSessionId: null, durationMs: 1 }, { ...session, engine: 'codex' });
    const got = await steps();
    expect(got.map((s) => [s.kind, s.text, s.engine])).toEqual([['summary', 'summary text', 'codex'], ['thinking', '', 'codex']]);
  });

  it('flushVerseReasoning writes a held step on shutdown', async () => {
    recordVerseReasoning({ seq: 1, at: t(1), type: 'thinking', turnId: 't', text: 'held' }, session);
    flushVerseReasoning();
    expect((await steps()).map((s) => s.text)).toEqual(['held']);
  });

  it('scrubs secrets from live reasoning before it touches disk', async () => {
    const secret = 'ghp_' + 'z'.repeat(36);
    recordVerseReasoning({ seq: 1, at: t(1), type: 'thinking', turnId: 't', text: `token is ${secret}` }, session);
    flushVerseReasoning();
    const [only] = await steps();
    expect(only?.text).not.toContain(secret);
    expect(only?.text).toContain('[REDACTED]');
  });
});

describe('ingestVerseSessionLogs (backfill)', () => {
  it('produces steps and one feature per CLOSED turn, and is incremental', async () => {
    const path = writeSession('s1', [...turn('t1', 1, { fail: true }), ...turn('t2', 20, { done: false })]);
    const first = await ingestVerseSessionLogs({ verseRoot });
    expect(first).toMatchObject({ sessionsScanned: 1, sessionsChanged: 1, features: 1, steps: 2 });
    const [feature] = await features();
    expect(feature).toMatchObject({
      id: 'verse:s1:t1', outcome: 'error', edits: 1, tests: 1, testsFailed: 1, claimUnverified: true,
      repo: '~/code/app', engine: 'claude',
    });
    expect(feature?.uncertaintyScore).toBe(4);

    // Unchanged file → nothing re-read.
    expect(await ingestVerseSessionLogs({ verseRoot })).toMatchObject({ sessionsChanged: 0, features: 0, steps: 0 });

    // The open turn finishes later → only it is ingested; nothing duplicated.
    appendFileSync(path, JSON.stringify({ seq: 40, at: t(40), type: 'turn-done', turnId: 't2', ok: true, nativeSessionId: null, durationMs: 5 }) + '\n');
    const third = await ingestVerseSessionLogs({ verseRoot });
    expect(third).toMatchObject({ features: 1, steps: 2 });
    const all = await features();
    expect(all.map((f) => f.id).sort()).toEqual(['verse:s1:t1', 'verse:s1:t2']);
    expect(all.find((f) => f.id === 'verse:s1:t2')).toMatchObject({ outcome: 'ok', win: true, claimUnverified: false });
    expect(await steps()).toHaveLength(4);
  });

  it('leaves steps from the tap\'s first seq on to the tap, but still writes the features', async () => {
    const events = [...turn('t1', 1), ...turn('t2', 20)];
    writeSession('sess1', events);
    // The tap came up mid-history: it saw t2 only.
    for (const event of events.filter((e) => e.seq >= 20)) recordVerseReasoning(event, session);
    const tapSteps = (await steps()).length;
    expect(tapSteps).toBe(2);
    const result = await ingestVerseSessionLogs({ verseRoot });
    expect(result.features).toBe(2);
    expect(result.steps).toBe(2); // t1's two steps only
    expect(await steps()).toHaveLength(4);
  });

  it('handles grok/codex tool names from real logs and skips malformed lines and ids', async () => {
    const turnId = 'g1';
    const events: VerseEvent[] = [
      { seq: 1, at: t(1), type: 'turn-started', turnId, pid: null },
      { seq: 2, at: t(2), type: 'tool-use', turnId, toolUseId: 'a', name: 'read_file', input: { target_file: 'src/x.ts' } },
      { seq: 3, at: t(3), type: 'tool-result', turnId, toolUseId: 'a', output: '', isError: false },
      { seq: 4, at: t(4), type: 'tool-use', turnId, toolUseId: 'b', name: 'search_replace', input: { file_path: 'src/x.ts', old_string: 'a', new_string: 'b' } },
      { seq: 5, at: t(5), type: 'tool-result', turnId, toolUseId: 'b', output: '', isError: false },
      { seq: 6, at: t(6), type: 'tool-use', turnId, toolUseId: 'c', name: 'command_execution', input: { command: '/bin/zsh -lc "npx vitest run"' } },
      { seq: 7, at: t(7), type: 'tool-result', turnId, toolUseId: 'c', output: '', isError: false },
      { seq: 8, at: t(8), type: 'turn-done', turnId, ok: true, nativeSessionId: null, durationMs: 1 },
    ];
    const path = writeSession('grok1', events, { engine: 'grok', model: 'grok-4.6' });
    appendFileSync(path, 'not json\n{"half":\n');
    writeSession('bad id!', turn('t9', 1));
    await ingestVerseSessionLogs({ verseRoot });
    const got = await features();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ engine: 'grok', model: 'grok-4.6', edits: 1, tests: 1, testsPassed: 1, win: true });
  });

  it('forgets cursors of deleted sessions and survives a missing verse dir', async () => {
    writeSession('gone', turn('t1', 1));
    await ingestVerseSessionLogs({ verseRoot });
    rmSync(join(verseRoot, 'sessions'), { recursive: true, force: true });
    await expect(ingestVerseSessionLogs({ verseRoot })).resolves.toMatchObject({ sessionsScanned: 0 });
    expect(reasoningRoot()).toContain(home);
  });
});
