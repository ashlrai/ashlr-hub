/**
 * test/verse-codex-adapter.test.ts — the V3.9 codex adapter: launch argv
 * (expansive config pair, shared project memory, canonical model id) and the
 * telemetry hooks that read the thread's rollout for an exact meter, the
 * window, compactions and the TRUE per-turn usage.
 *
 * The hooks are driven directly with a hand-built VerseAdapterTurnContext
 * against rollout fixtures in a private tmp "native profile", exactly the
 * layout `~/.ashlr/native-profiles/<account>/` has. Nothing is spawned; HOME
 * is relocated by test/setup/home.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adapterFor, type VerseAdapterTurnContext, type VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import {
  afterCodexTurn,
  codexAdapter,
  codexContextOverrides,
  codexReportedUsage,
  createCodexParser,
  pollCodexTelemetry,
  strictConfigVerified,
} from '../src/core/verse/adapters/codex.js';
import { resetCodexRolloutCaches } from '../src/core/verse/codex-rollout.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import type { VerseModelOption, VerseSeat, VerseSession } from '../src/core/verse/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = Date.parse('2026-09-23T12:00:00.000Z');
const TURN2 = BASE + 60_000;

/** GPT-6 as model-windows.ts builds it from a 0.155 catalog entry. */
const GPT6: VerseModelOption = {
  id: 'gpt-6-sol',
  label: 'GPT-6 Sol',
  contextWindow: 258_400,
  autoCompactAt: 244_800,
  expansive: { contextWindow: 828_400, autoCompactAt: 784_800, providerWindow: 872_000 },
  windowSource: 'provider-catalog',
  minCliVersion: null,
  unavailableReason: null,
};
const GPT55: VerseModelOption = { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 258_400, autoCompactAt: 244_800, windowSource: 'provider-catalog' };

function seat(models: VerseModelOption[]): VerseSeat {
  return {
    id: 'codex-b',
    engine: 'codex',
    label: 'Codex',
    accountId: 'codex-b',
    models,
    contextWindow: 258_400,
    health: { state: 'unknown', summary: null, windows: [], observedAt: null },
  };
}

function session(over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 's1',
    title: 't',
    projectPath: '/work/project',
    engine: 'codex',
    accountId: 'codex-b',
    seatId: 'codex-b',
    model: 'gpt-6-sol',
    nativeSessionId: null,
    createdAt: iso(BASE),
    updatedAt: iso(BASE),
    status: 'idle',
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 258_400 },
    lastError: null,
    ...over,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function threadIdAt(ms: number): string {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
}

const THREAD = threadIdAt(BASE);

interface Usage { input: number; cached?: number; output: number }

function usageBlock(u: Usage): Record<string, number> {
  return { input_tokens: u.input, cached_input_tokens: u.cached ?? 0, output_tokens: u.output, reasoning_output_tokens: 0, total_tokens: u.input + u.output };
}

function line(at: number, type: string, payload: unknown): string {
  return `${JSON.stringify({ timestamp: iso(at), type, payload })}\n`;
}

function tokenCount(at: number, total: Usage, last: Usage, window = 258_400): string {
  return line(at, 'event_msg', { type: 'token_count', info: { total_token_usage: usageBlock(total), last_token_usage: usageBlock(last), model_context_window: window } });
}

let work: string;
let profile: string;
let launcher: string;
let rollout: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'verse-codex-adapter-'));
  profile = join(work, 'native-profiles', 'codex-b');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  launcher = join(profile, 'launcher.mjs');
  writeFileSync(launcher, '// not executed by these tests\n', { mode: 0o600 });
  const nativeState = join(profile, 'native-state');
  writeFileSync(join(profile, 'profile.json'), JSON.stringify({ provider: 'codex', nativeStatePath: nativeState }), { mode: 0o600 });
  const created = new Date(BASE);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = join(nativeState, 'sessions', String(created.getFullYear()), pad(created.getMonth() + 1), pad(created.getDate()));
  mkdirSync(day, { recursive: true, mode: 0o700 });
  rollout = join(day, `rollout-2026-09-23T08-00-00-${THREAD}.jsonl`);
  resetCodexRolloutCaches();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  resetCodexRolloutCaches();
});

function launch(over: Partial<VerseSeatLaunch> = {}, models: VerseModelOption[] = [GPT6, GPT55]): VerseSeatLaunch {
  return { seat: seat(models), launcher: [process.execPath, launcher], ollamaBaseUrl: 'http://127.0.0.1:11434', ...over };
}

/** Turn 1 (two calls) of THREAD, already on disk before turn 2 is spawned at TURN2. */
function writeTurn1(): void {
  writeFileSync(rollout, [
    line(BASE, 'session_meta', { id: THREAD }),
    line(BASE + 5, 'event_msg', { type: 'task_started', model_context_window: 258_400 }),
    tokenCount(BASE + 10, { input: 10_000, output: 100 }, { input: 10_000, output: 100 }),
    tokenCount(BASE + 20, { input: 22_000, cached: 9_000, output: 250 }, { input: 12_000, cached: 9_000, output: 150 }),
  ].join(''));
}

function turn2Calls(): void {
  appendFileSync(rollout, [
    line(TURN2 + 5, 'event_msg', { type: 'task_started', model_context_window: 258_400 }),
    tokenCount(TURN2 + 10, { input: 35_000, cached: 20_000, output: 300 }, { input: 13_000, cached: 11_000, output: 50 }),
    tokenCount(TURN2 + 20, { input: 49_000, cached: 32_000, output: 380 }, { input: 14_000, cached: 12_000, output: 80 }),
  ].join(''));
}

function ctxFor(s: VerseSession, l: VerseSeatLaunch, turnOutput: string[] = []): VerseAdapterTurnContext {
  const parser = createCodexParser('turn-2');
  for (const out of turnOutput) parser.push(out);
  parser.finish(0);
  return { session: s, launch: l, turnId: 'turn-2', startedAt: TURN2, nativeSessionId: parser.nativeSessionId() ?? s.nativeSessionId, parser, state: {} };
}

const resumed = (): VerseSession => session({ nativeSessionId: THREAD, turnCount: 1 });

/** What `exec resume` prints: codex seeds its counter from the rollout, so this is turns 1 + 2. */
const CUMULATIVE_TURN_COMPLETED = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 49_000, cached_input_tokens: 32_000, output_tokens: 380 } });

function usageOf(events: VerseParsedEvent[]): Extract<VerseParsedEvent, { type: 'usage' }>['usage'] | undefined {
  const usage = events.filter((e) => e.type === 'usage');
  expect(usage.length).toBeLessThanOrEqual(1);
  return (usage[0] as Extract<VerseParsedEvent, { type: 'usage' }> | undefined)?.usage;
}

/** Every `-c` assignment in an argv, as the launcher sees it. */
/** V3.10: live reasoning is on by default, so every turn asks for detailed summaries (last override). */
const REASONING = 'model_reasoning_summary="detailed"';

function configAssignments(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-c') out.push(argv[i + 1]!);
  return out;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

describe('buildLaunch', () => {
  it('standard mode: no context overrides — only the V3.10 reasoning summary and the git-repo skip', () => {
    const first = codexAdapter.buildLaunch(session(), 'hello', launch());
    expect(first.argv).toEqual([process.execPath, launcher, 'exec', '-c', REASONING, '--skip-git-repo-check', '--json', '--model', 'gpt-6-sol', '--cd', '/work/project', '--sandbox', 'workspace-write', '-']);
    expect(first.stdin).toBe('hello');
    expect(first.env).toEqual({});
    const next = codexAdapter.buildLaunch(resumed(), 'again', launch());
    expect(next.argv).toEqual([process.execPath, launcher, 'exec', 'resume', THREAD, '-c', REASONING, '--skip-git-repo-check', '--json', '-']);
  });

  it('expansive mode sends the window AND the compaction limit together, on exec and on resume', () => {
    const pair = ['-c', 'model_context_window=872000', '-c', 'model_auto_compact_token_limit=784800'];
    const first = codexAdapter.buildLaunch(session({ contextMode: 'expansive' }), 'x', launch());
    expect(first.argv.slice(2, 7)).toEqual(['exec', ...pair]);
    const next = codexAdapter.buildLaunch({ ...resumed(), contextMode: 'expansive' }, 'x', launch());
    expect(next.argv.slice(2, 9)).toEqual(['exec', 'resume', THREAD, ...pair]);
    expect(next.argv.slice(-2)).toEqual(['--json', '-']);
  });

  it('never sends half the pair: no expansive budget, standard mode, or unknown model → nothing', () => {
    expect(codexContextOverrides({ contextMode: 'expansive', model: 'gpt-5.5' }, launch())).toEqual([]);
    expect(codexContextOverrides({ contextMode: 'standard', model: 'gpt-6-sol' }, launch())).toEqual([]);
    expect(codexContextOverrides({ model: 'gpt-6-sol' }, launch())).toEqual([]);
    expect(codexContextOverrides({ contextMode: 'expansive', model: 'gpt-unknown' }, launch())).toEqual([]);
  });

  it('a 3.8 launch snapshot (flat raw window, no budgets) gets the documented expansive pair — the one the UI offered', () => {
    // What 3.8 pinned: `{id, label, contextWindow: 272000}` and nothing else.
    const legacy: VerseModelOption = { id: 'gpt-6-sol', label: 'GPT-6 Sol', contextWindow: 272_000 };
    expect(codexContextOverrides({ contextMode: 'expansive', model: 'gpt-6-sol' }, launch({}, [legacy])))
      .toEqual(['-c', 'model_context_window=872000', '-c', 'model_auto_compact_token_limit=784800']);
    // gpt-5.5 has no larger window documented, and an undocumented slug keeps
    // its (budget-less) snapshot: still never half a pair, never a guess.
    expect(codexContextOverrides({ contextMode: 'expansive', model: 'gpt-5.5' }, launch({}, [{ id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 }]))).toEqual([]);
    expect(codexContextOverrides({ contextMode: 'expansive', model: 'gpt-reserve' }, launch({}, [{ id: 'gpt-reserve', label: 'GPT-Reserve', contextWindow: 272_000 }]))).toEqual([]);
  });

  it('derives the raw window from an effective-only budget and never lets the limit exceed it', () => {
    const effectiveOnly: VerseModelOption = { ...GPT6, expansive: { contextWindow: 828_400, autoCompactAt: null } };
    expect(codexContextOverrides({ contextMode: 'expansive', model: 'gpt-6-sol' }, launch({}, [effectiveOnly])))
      .toEqual(['-c', 'model_context_window=872000', '-c', 'model_auto_compact_token_limit=784800']);
    const absurd: VerseModelOption = { ...GPT6, expansive: { contextWindow: 828_400, autoCompactAt: 9_999_999, providerWindow: 872_000 } };
    expect(codexContextOverrides({ contextMode: 'expansive', model: 'gpt-6-sol' }, launch({}, [absurd])))
      .toEqual(['-c', 'model_context_window=872000', '-c', 'model_auto_compact_token_limit=872000']);
  });

  it('sends the canonical model id for a stored alias and resolves the alias budget', () => {
    const aliased: VerseModelOption = { ...GPT6, id: 'claude-opus-5-5' };
    const s = session({ model: 'claude-opus-5.5', contextMode: 'expansive' });
    const argv = codexAdapter.buildLaunch(s, 'x', launch({}, [aliased])).argv;
    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', 'model_context_window=872000']));
  });

  it('writable project memory: its dir joins the extra roots and the block rides as developer_instructions', () => {
    const block = 'Project memory lives in /m.\n- Read "MEMORY.md" first.\n\\ backslash, tab\there, é';
    const memory = { dir: '/home/u/.ashlr/verse/memory/p-abc', block, writable: true };
    const s = session({ extraRoots: ['/work/lib', '/work/lib'] });
    const first = codexAdapter.buildLaunch(s, 'x', launch({ memory })).argv;
    const next = codexAdapter.buildLaunch({ ...s, nativeSessionId: THREAD, turnCount: 1 }, 'x', launch({ memory })).argv;
    for (const argv of [first, next]) {
      const config = configAssignments(argv);
      expect(config[0]).toBe('sandbox_workspace_write.writable_roots=["/work/lib","/home/u/.ashlr/verse/memory/p-abc"]');
      const instructions = config.find((c) => c.startsWith('developer_instructions='))!;
      // tomlString emits only \\, \" and \uXXXX escapes — all valid JSON too — so it round-trips.
      expect(JSON.parse(instructions.slice('developer_instructions='.length))).toBe(block);
      expect([...instructions].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
    }
    // Byte-identical on every turn: the prompt prefix (and its cache) is stable.
    expect(configAssignments(first)).toEqual(configAssignments(next));
  });

  it('read-only project memory: instructions only, no writable grant', () => {
    const memory = { dir: '/home/u/.ashlr/verse/memory/p-abc', block: 'read me', writable: false };
    const config = configAssignments(codexAdapter.buildLaunch(session(), 'x', launch({ memory })).argv);
    expect(config).toEqual(['developer_instructions="read me"', REASONING]);
  });

  it('DECISION: developer_instructions is resent on EVERY resume, not only turn 1', () => {
    // Codex diffs each turn against a baseline it restores from the rollout,
    // so an identical block adds nothing to the thread; dropping the key on a
    // resume would lose the block at the next compaction, which rebuilds the
    // developer context from the resuming process's config. See the WHY
    // comment on memoryOverrides in adapters/codex.ts.
    const memory = { dir: '/home/u/.ashlr/verse/memory/p-abc', block: 'Shared memory.', writable: false };
    const expected = 'developer_instructions="Shared memory."';
    for (const turnCount of [0, 1, 2, 7, 40]) {
      const s = turnCount === 0 ? session() : session({ nativeSessionId: THREAD, turnCount });
      const argv = codexAdapter.buildLaunch(s, 'x', launch({ memory })).argv;
      expect(argv.includes('resume')).toBe(turnCount > 0);
      expect(configAssignments(argv).filter((c) => c.startsWith('developer_instructions='))).toEqual([expected]);
    }
  });

  it('grants the memory dir write access only when writable is exactly true, on exec and resume', () => {
    const dir = '/home/u/.ashlr/verse/memory/p-abc';
    const variants: unknown[] = [false, undefined, null, 'true', 1];
    for (const writable of variants) {
      const memory = { dir, block: 'b', writable } as unknown as NonNullable<VerseSeatLaunch['memory']>;
      for (const s of [session({ extraRoots: ['/work/lib'] }), session({ extraRoots: ['/work/lib'], nativeSessionId: THREAD, turnCount: 3 })]) {
        const config = configAssignments(codexAdapter.buildLaunch(s, 'x', launch({ memory })).argv);
        expect(config).toEqual(['sandbox_workspace_write.writable_roots=["/work/lib"]', 'developer_instructions="b"', REASONING]);
        expect(config.join('\n')).not.toContain(dir);
      }
    }
    const writable = { dir, block: 'b', writable: true };
    const resumedConfig = configAssignments(codexAdapter.buildLaunch(session({ nativeSessionId: THREAD, turnCount: 3 }), 'x', launch({ memory: writable })).argv);
    expect(resumedConfig).toEqual([`sandbox_workspace_write.writable_roots=["${dir}"]`, 'developer_instructions="b"', REASONING]);
  });

  it('ignores a malformed memory snapshot rather than sending a broken override', () => {
    const bad = { dir: 'relative', block: 'x', writable: true };
    expect(configAssignments(codexAdapter.buildLaunch(session(), 'x', launch({ memory: bad })).argv)).toEqual([REASONING]);
    const empty = { dir: '/m', block: '   ', writable: true };
    expect(configAssignments(codexAdapter.buildLaunch(session(), 'x', launch({ memory: empty })).argv)).toEqual([REASONING]);
  });

  it('every override passes the native-profile launcher key check', () => {
    // The generated launcher.mjs refuses any -c whose key is not a simple dotted
    // name, and two auth keys outright (core/resources/native-profile.ts).
    const memory = { dir: '/m', block: 'b', writable: true };
    const s = session({ contextMode: 'expansive', extraRoots: ['/work/lib'] });
    const keys = configAssignments(codexAdapter.buildLaunch(s, 'x', launch({ memory })).argv).map((assignment) => {
      const match = /^\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*=/.exec(assignment);
      expect(match).not.toBeNull();
      return match![1]!;
    });
    expect(keys).toEqual(['sandbox_workspace_write.writable_roots', 'model_context_window', 'model_auto_compact_token_limit', 'developer_instructions', 'model_reasoning_summary']);
    expect(keys.every((key) => strictConfigVerified.includes(key))).toBe(true);
    expect(keys).not.toContain('cli_auth_credentials_store');
    expect(keys).not.toContain('forced_login_method');
  });
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('parser', () => {
  it('holds turn.completed usage for afterTurn instead of emitting it from finish', () => {
    const parser = createCodexParser('t');
    expect(parser.push(JSON.stringify({ type: 'thread.started', thread_id: THREAD }))).toEqual([]);
    expect(parser.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 100, cache_write_input_tokens: 20, output_tokens: 20 } }))).toEqual([]);
    expect(parser.finish(0)).toEqual([]);
    expect(parser.nativeSessionId()).toBe(THREAD);
    expect(codexReportedUsage(parser)).toMatchObject({ inputTokens: 300, cachedInputTokens: 100, cacheWriteInputTokens: 20, outputTokens: 20 });
  });

  it('reports no usage for a parser that saw none, or one that is not codex', () => {
    expect(codexReportedUsage(createCodexParser('t'))).toBeNull();
    expect(codexReportedUsage(adapterFor('claude').createParser('t'))).toBeNull();
  });

  it('is wired as the codex adapter with both telemetry hooks', () => {
    expect(adapterFor('codex')).toBe(codexAdapter);
    expect(codexAdapter.pollTelemetry).toBe(pollCodexTelemetry);
    expect(codexAdapter.afterTurn).toBe(afterCodexTurn);
  });
});

// ---------------------------------------------------------------------------
// Telemetry hooks
// ---------------------------------------------------------------------------

describe('pollTelemetry', () => {
  it('turns each new token_count into one exact context reading, never repeating one', () => {
    writeTurn1();
    const ctx = ctxFor(resumed(), launch());
    // Nothing from this turn yet: the previous turn's reading is not re-announced.
    expect(pollCodexTelemetry(ctx)).toEqual([]);
    turn2Calls();
    expect(pollCodexTelemetry(ctx)).toEqual([{ type: 'context', turnId: 'turn-2', contextTokens: 14_080, contextWindow: 258_400, exact: true }]);
    expect(pollCodexTelemetry(ctx)).toEqual([]);
    appendFileSync(rollout, tokenCount(TURN2 + 30, { input: 64_000, cached: 45_000, output: 400 }, { input: 15_000, output: 20 }));
    expect(pollCodexTelemetry(ctx)).toEqual([{ type: 'context', turnId: 'turn-2', contextTokens: 15_020, contextWindow: 258_400, exact: true }]);
  });

  it('shows a compaction as soon as the post-compaction reading lands, once', () => {
    writeTurn1();
    turn2Calls();
    const ctx = ctxFor(resumed(), launch());
    pollCodexTelemetry(ctx);
    appendFileSync(rollout, line(TURN2 + 40, 'compacted', { message: '', replacement_history: [] }));
    expect(pollCodexTelemetry(ctx)).toEqual([]);
    appendFileSync(rollout, tokenCount(TURN2 + 41, { input: 49_000, cached: 32_000, output: 380 }, { input: 30_000, output: 900 }));
    const events = pollCodexTelemetry(ctx);
    expect(events).toEqual([
      { type: 'compaction', turnId: 'turn-2', trigger: 'auto', preTokens: 14_080, postTokens: 30_900, durationMs: null },
      { type: 'context', turnId: 'turn-2', contextTokens: 30_900, contextWindow: 258_400, exact: true },
    ]);
    expect(pollCodexTelemetry(ctx)).toEqual([]);
    expect(afterCodexTurn(ctx).filter((e) => e.type === 'compaction')).toEqual([]);
  });

  it('does nothing without a thread id, a pinned profile, or a rollout', () => {
    expect(pollCodexTelemetry(ctxFor(session(), launch()))).toEqual([]);
    expect(pollCodexTelemetry(ctxFor(resumed(), launch({ launcher: null })))).toEqual([]);
    expect(pollCodexTelemetry(ctxFor(resumed(), launch()))).toEqual([]);
  });
});

describe('afterTurn', () => {
  it('REGRESSION: a resumed turn reports ITS OWN usage, not the thread running total codex printed', () => {
    writeTurn1();
    turn2Calls();
    const ctx = ctxFor(resumed(), launch(), [JSON.stringify({ type: 'thread.started', thread_id: THREAD }), CUMULATIVE_TURN_COMPLETED]);
    const events = afterCodexTurn(ctx);
    // Turn 2's two calls: input 27,000 of which 23,000 cached; output 130.
    expect(usageOf(events)).toEqual({
      inputTokens: 4_000,
      cacheReadTokens: 23_000,
      cacheCreationTokens: 0,
      outputTokens: 130,
      contextTokens: 14_080,
      contextWindow: 258_400,
      contextTokensExact: true,
    });
    expect(events[events.length - 1]).toEqual({ type: 'context', turnId: 'turn-2', contextTokens: 14_080, contextWindow: 258_400, exact: true });
    expect(events.map((e) => e.type)).toEqual(['usage', 'context']);
  });

  it('uses the CLI own per-turn record when it wrote one (it includes compaction calls)', () => {
    writeTurn1();
    turn2Calls();
    appendFileSync(rollout, line(TURN2 + 50, 'token_usage_record', {
      thread_id: THREAD,
      turn_token_usage: usageBlock({ input: 270_000, cached: 230_000, output: 3_130 }),
    }));
    const usage = usageOf(afterCodexTurn(ctxFor(resumed(), launch(), [CUMULATIVE_TURN_COMPLETED])));
    expect(usage).toMatchObject({ inputTokens: 40_000, cacheReadTokens: 230_000, outputTokens: 3_130, contextTokensExact: true });
  });

  it('emits compactions the turn ended on, with what is known', () => {
    writeTurn1();
    turn2Calls();
    appendFileSync(rollout, line(TURN2 + 60, 'compacted', { message: '', replacement_history: [] }));
    const events = afterCodexTurn(ctxFor(resumed(), launch(), [CUMULATIVE_TURN_COMPLETED]));
    expect(events.map((e) => e.type)).toEqual(['compaction', 'usage', 'context']);
    expect(events[0]).toEqual({ type: 'compaction', turnId: 'turn-2', trigger: 'auto', preTokens: 14_080, postTokens: null, durationMs: null });
  });

  it('still accounts a stopped turn that never printed turn.completed', () => {
    writeTurn1();
    turn2Calls();
    const usage = usageOf(afterCodexTurn(ctxFor(resumed(), launch())));
    expect(usage).toMatchObject({ inputTokens: 4_000, cacheReadTokens: 23_000, outputTokens: 130, contextTokensExact: true });
  });

  it('falls back to the printed figure, marked as an upper bound, when no rollout is readable', () => {
    const printed = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 20 } });
    for (const l of [launch({ launcher: null }), launch()]) {
      const events = afterCodexTurn(ctxFor(session(), l, [JSON.stringify({ type: 'thread.started', thread_id: THREAD }), printed]));
      expect(events).toEqual([{
        type: 'usage',
        turnId: 'turn-2',
        usage: { inputTokens: 200, cacheReadTokens: 100, cacheCreationTokens: 0, outputTokens: 20, contextTokens: 300, contextWindow: null, contextTokensExact: false },
      }]);
    }
  });

  it('splits cache writes out of input so the session totals count every token once', () => {
    const printed = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 100, cache_write_input_tokens: 50, output_tokens: 20 } });
    expect(usageOf(afterCodexTurn(ctxFor(session(), launch({ launcher: null }), [printed])))).toMatchObject({ inputTokens: 150, cacheReadTokens: 100, cacheCreationTokens: 50 });
  });

  it('finds the printed figure by turn id when the engine hands the hook a WRAPPED parser', () => {
    const inner = createCodexParser('turn-wrapped');
    inner.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 20 } }));
    const wrapper = { push: (l: string) => inner.push(l), finish: (c: number | null) => inner.finish(c), nativeSessionId: () => inner.nativeSessionId() };
    const ctx: VerseAdapterTurnContext = { session: session(), launch: launch({ launcher: null }), turnId: 'turn-wrapped', startedAt: TURN2, nativeSessionId: null, parser: wrapper, state: {} };
    expect(usageOf(afterCodexTurn(ctx))).toMatchObject({ inputTokens: 200, cacheReadTokens: 100, outputTokens: 20, contextTokensExact: false });
    // Read once: the per-turn entry is released after afterTurn.
    expect(codexReportedUsage(wrapper, 'turn-wrapped')).toBeNull();
    expect(codexReportedUsage(inner)).not.toBeNull();
  });

  it('emits nothing for a turn that made no call and printed no usage', () => {
    expect(afterCodexTurn(ctxFor(resumed(), launch({ launcher: null })))).toEqual([]);
  });

  it('re-states the last exact reading when the turn demonstrably made no call', () => {
    writeTurn1();
    const events = afterCodexTurn(ctxFor(resumed(), launch()));
    expect(events).toEqual([{ type: 'context', turnId: 'turn-2', contextTokens: 12_150, contextWindow: 258_400, exact: true }]);
  });

  it('first turn of a thread: every call counted from the file start', () => {
    writeFileSync(rollout, [
      line(TURN2 + 1, 'session_meta', { id: THREAD }),
      line(TURN2 + 2, 'event_msg', { type: 'task_started', model_context_window: 828_400 }),
      tokenCount(TURN2 + 10, { input: 10_000, output: 100 }, { input: 10_000, output: 100 }, 828_400),
      tokenCount(TURN2 + 20, { input: 22_000, cached: 9_000, output: 250 }, { input: 12_000, cached: 9_000, output: 150 }, 828_400),
    ].join(''));
    const printed = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 22_000, cached_input_tokens: 9_000, output_tokens: 250 } });
    const ctx = ctxFor(session({ contextMode: 'expansive' }), launch(), [JSON.stringify({ type: 'thread.started', thread_id: THREAD }), printed]);
    expect(usageOf(afterCodexTurn(ctx))).toEqual({
      inputTokens: 13_000, cacheReadTokens: 9_000, cacheCreationTokens: 0, outputTokens: 250,
      contextTokens: 12_150, contextWindow: 828_400, contextTokensExact: true,
    });
  });

  it('never puts a native-profile path into an event', () => {
    writeTurn1();
    turn2Calls();
    appendFileSync(rollout, line(TURN2 + 60, 'compacted', { message: '', replacement_history: [] }));
    const ctx = ctxFor(resumed(), launch(), [CUMULATIVE_TURN_COMPLETED]);
    const text = JSON.stringify([...pollCodexTelemetry(ctx), ...afterCodexTurn(ctx)]);
    expect(text).not.toContain(work);
    expect(text).not.toContain('native-profiles');
    expect(text).not.toContain('rollout-');
  });

  it('survives a garbage context without throwing', () => {
    const broken = { session: session(), launch: null, turnId: 't', startedAt: TURN2, nativeSessionId: THREAD, parser: createCodexParser('t'), state: {} } as unknown as VerseAdapterTurnContext;
    expect(() => pollCodexTelemetry(broken)).not.toThrow();
    expect(afterCodexTurn(broken)).toEqual([]);
  });
});
