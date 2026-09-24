/**
 * test/verse-adapters.test.ts — Verse CLI adapters: argv/env construction and
 * stdout-line parsing for claude (stream-json), codex (exec JSONL) and grok
 * (Anthropic Messages wire NDJSON). Pure: no spawns, no filesystem. HOME is
 * still relocated for the whole file, so an import that ever grows a default
 * `homedir()` read can never reach the operator's real ~/.ashlr or ~/.claude.
 *
 * V3.9 coverage (docs/VERSE-CONTEXT.md): per-model `--autocompact` budgets,
 * canonical model ids, the local seat's CLAUDE_CODE_MAX_CONTEXT_TOKENS and
 * slim prompt, shared-memory flags, `result.modelUsage` → the usage event's
 * window, `compact_boundary` → `compaction`, and per-call usage dedupe.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adapterFor, type VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import { createAnthropicStreamParser, anthropicEnvBaseUrl, runtimeContextWindow } from '../src/core/verse/adapters/claude.js';
import { createCodexParser } from '../src/core/verse/adapters/codex.js';
import { claudeAutoCompactAt } from '../src/core/verse/context-math.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { VERSE_TRANSIENT_EVENT_TYPES, type VerseModelOption, type VerseSeat, type VerseSession } from '../src/core/verse/types.js';

let tmpHome = '';
let prevHome: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'verse-adapters-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

// A launch snapshot written BEFORE 3.9: one flat window, no budgets. The
// adapter must look such a model up in the verified per-model table.
const SEAT: VerseSeat = {
  id: 'claude-max',
  engine: 'claude',
  label: 'Claude Max',
  accountId: 'claude-max',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', contextWindow: 200_000 }],
  contextWindow: 200_000,
  health: { state: 'unknown', summary: null, windows: [], observedAt: null },
};

/** A V3.9 catalog option for a 1M-native Claude model (budgets stated). */
function oneMillionOption(id: string, maxOut = 64_000): VerseModelOption {
  return {
    id,
    label: id,
    contextWindow: 1_000_000,
    autoCompactAt: claudeAutoCompactAt(1_000_000, maxOut, 400_000),
    expansive: { contextWindow: 1_000_000, autoCompactAt: claudeAutoCompactAt(1_000_000, maxOut, null) },
    maxOutputTokens: maxOut,
    windowSource: 'cli-catalog',
    minCliVersion: null,
    unavailableReason: null,
  };
}

/** A V3.9 catalog option for a 200k Claude model: no expansive budget. */
function twoHundredKOption(id: string): VerseModelOption {
  return {
    id,
    label: id,
    contextWindow: 200_000,
    autoCompactAt: claudeAutoCompactAt(200_000, 32_000),
    maxOutputTokens: 32_000,
    windowSource: 'cli-catalog',
  };
}

const CATALOG_SEAT: VerseSeat = {
  ...SEAT,
  models: [
    oneMillionOption('claude-fable-5'),
    oneMillionOption('claude-opus-5-5', 128_000),
    twoHundredKOption('claude-haiku-4-5-20251001'),
    // A 1M-window option the catalog chose NOT to give an expansive mode: the
    // option is authoritative, the static table is not consulted.
    { id: 'claude-sonnet-5', label: 'Sonnet 5', contextWindow: 1_000_000, autoCompactAt: 967_000, windowSource: 'documented' },
  ],
  contextWindow: 1_000_000,
};

function session(overrides: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'sess-1',
    title: 'x',
    projectPath: '/tmp/proj',
    engine: 'claude',
    accountId: 'claude-max',
    seatId: 'claude-max',
    model: 'claude-opus-5',
    nativeSessionId: '11111111-2222-4333-8444-555555555555',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 200_000 },
    lastError: null,
    ...overrides,
  };
}

function launch(overrides: Partial<VerseSeatLaunch> = {}): VerseSeatLaunch {
  return { seat: SEAT, launcher: ['/usr/local/bin/node', '/home/u/.ashlr/native-profiles/claude-max/launcher.mjs'], ollamaBaseUrl: 'http://127.0.0.1:11434', ...overrides };
}

function feed(parser: { push(l: string): unknown[]; finish(c: number | null): unknown[] }, lines: unknown[], exitCode: number | null = 0): VerseParsedEvent[] {
  const out: VerseParsedEvent[] = [];
  for (const line of lines) {
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    out.push(...(parser.push(text) as VerseParsedEvent[]));
  }
  out.push(...(parser.finish(exitCode) as VerseParsedEvent[]));
  return out;
}

/**
 * V3.10: parsers interleave TRANSIENT events (progress, thinking-delta, …)
 * with the persisted ones. These tests pin the persisted sequence, which the
 * transient events must never change; test/verse-adapters-reasoning.test.ts
 * covers the transient ones.
 */
function persisted(events: VerseParsedEvent[]): VerseParsedEvent[] {
  return events.filter((e) => !VERSE_TRANSIENT_EVENT_TYPES.has(e.type));
}

/** The value following the LAST occurrence of `flag`, or undefined. */
function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.lastIndexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Every value following an occurrence of `flag`, in order. */
function valuesOf(argv: string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((part, i) => { if (part === flag && i + 1 < argv.length) out.push(argv[i + 1]!); });
  return out;
}

function usageOf(events: VerseParsedEvent[]): VerseSession['usage'] {
  const usage = events.find((e) => e.type === 'usage') as { usage: VerseSession['usage'] } | undefined;
  if (!usage) throw new Error('no usage event');
  return usage.usage;
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

describe('claude adapter — buildLaunch', () => {
  it('turn 1 uses --session-id via the account launcher; later turns --resume', () => {
    const a = adapterFor('claude');
    const first = a.buildLaunch(session(), 'hello world', launch());
    expect(first.argv.slice(0, 2)).toEqual(['/usr/local/bin/node', '/home/u/.ashlr/native-profiles/claude-max/launcher.mjs']);
    expect(first.argv).toContain('-p');
    // `-p` is boolean; the prompt is the positional, last, behind `--`.
    expect(first.argv.slice(-2)).toEqual(['--', 'hello world']);
    expect(first.argv).toContain('--session-id');
    expect(first.argv[first.argv.indexOf('--session-id') + 1]).toBe('11111111-2222-4333-8444-555555555555');
    expect(first.argv).not.toContain('--resume');
    expect(first.argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'claude-opus-5', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']));
    expect(first.stdin).toBeNull();
    expect(first.cwd).toBe('/tmp/proj');
    expect(first.env).toEqual({});
    // Claude seats keep the CLI's default system prompt layout.
    expect(first.argv).not.toContain('--exclude-dynamic-system-prompt-sections');

    const second = a.buildLaunch(session({ turnCount: 1 }), 'again', launch());
    expect(second.argv).toContain('--resume');
    expect(second.argv[second.argv.indexOf('--resume') + 1]).toBe('11111111-2222-4333-8444-555555555555');
    expect(second.argv).not.toContain('--session-id');
  });

  it('keeps a leading-dash message as text, never as options', () => {
    const a = adapterFor('claude');
    for (const text of ['- a\n- b', '--dangerously-skip-permissions rm -rf /', '--add-dir / && echo pwned', '--autocompact 1000000']) {
      const l = a.buildLaunch(session(), text, launch());
      expect(l.argv[l.argv.length - 1]).toBe(text);
      expect(l.argv[l.argv.length - 2]).toBe('--');
      // Every real option sits before the marker.
      expect(l.argv.indexOf('--permission-mode')).toBeLessThan(l.argv.indexOf('--'));
      expect(l.argv.indexOf('--autocompact')).toBeLessThan(l.argv.indexOf('--'));
      expect(l.argv.indexOf('--')).toBe(l.argv.lastIndexOf('--'));
      expect(l.stdin).toBeNull();
    }
  });

  it('sends the CANONICAL model id, never the retired dotted alias', () => {
    const a = adapterFor('claude');
    // A record stored as `claude-opus-5.5` (which the CLI fuzzy-matches to
    // Opus 5) launches as the real Opus 5.5 id on a seat listing either spelling.
    for (const seat of [CATALOG_SEAT, { ...SEAT, models: [{ id: 'claude-opus-5.5', label: 'Opus 5.5', contextWindow: 200_000 }] }]) {
      const l = a.buildLaunch(session({ model: 'claude-opus-5.5' }), 'hi', launch({ seat }));
      expect(valueOf(l.argv, '--model')).toBe('claude-opus-5-5');
      expect(l.argv).not.toContain('claude-opus-5.5');
      // Found through the alias, so it still gets its 1M standard budget.
      expect(valueOf(l.argv, '--autocompact')).toBe('400000');
    }
  });

  it('1M-native models: --autocompact 400000 in standard mode, auto in expansive', () => {
    const a = adapterFor('claude');
    const l = launch({ seat: CATALOG_SEAT });
    const standard = a.buildLaunch(session({ model: 'claude-fable-5' }), 'hi', l);
    expect(valuesOf(standard.argv, '--autocompact')).toEqual(['400000']);
    const explicitStandard = a.buildLaunch(session({ model: 'claude-fable-5', contextMode: 'standard' }), 'hi', l);
    expect(explicitStandard.argv).toEqual(standard.argv);

    const expansive = a.buildLaunch(session({ model: 'claude-fable-5', contextMode: 'expansive' }), 'hi', l);
    expect(valuesOf(expansive.argv, '--autocompact')).toEqual(['auto']);
    // The mode changes ONE flag value and nothing else, so switching mid-session
    // never changes prompt content (and never breaks the provider cache).
    const diff = standard.argv.map((part, i) => (part === expansive.argv[i] ? null : [part, expansive.argv[i]])).filter(Boolean);
    expect(diff).toEqual([['400000', 'auto']]);

    // Resumed turns carry the same flag: the budget holds for the whole session.
    const resumed = a.buildLaunch(session({ model: 'claude-fable-5', contextMode: 'expansive', turnCount: 4 }), 'hi', l);
    expect(valuesOf(resumed.argv, '--autocompact')).toEqual(['auto']);
  });

  it('200k models and options without an expansive budget get no --autocompact at all', () => {
    const a = adapterFor('claude');
    const l = launch({ seat: CATALOG_SEAT });
    for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-5']) {
      for (const contextMode of ['standard', 'expansive'] as const) {
        const argv = a.buildLaunch(session({ model, contextMode }), 'hi', l).argv;
        expect(argv, `${model}/${contextMode}`).not.toContain('--autocompact');
      }
    }
  });

  it('a pre-3.9 launch snapshot (flat window, no budgets) takes its budget from the verified table', () => {
    const a = adapterFor('claude');
    // SEAT lists claude-opus-5 as a flat 200k option; the table knows it is 1M-native.
    // (The adapter reads the MODE off the session. A pre-3.9 RECORD has none on
    // disk; the engine materialises `expansive` for it before any launch — see
    // test/verse-session-engine.test.ts "records written before 3.9" — so the
    // absent-mode case below is only ever reached by a direct caller.)
    expect(valuesOf(a.buildLaunch(session(), 'hi', launch()).argv, '--autocompact')).toEqual(['400000']);
    expect(valuesOf(a.buildLaunch(session({ contextMode: 'standard' }), 'hi', launch()).argv, '--autocompact')).toEqual(['400000']);
    expect(valuesOf(a.buildLaunch(session({ contextMode: 'expansive' }), 'hi', launch()).argv, '--autocompact')).toEqual(['auto']);
    // A model missing from the snapshot but known to the table.
    expect(valuesOf(a.buildLaunch(session({ model: 'claude-opus-4-8' }), 'hi', launch()).argv, '--autocompact')).toEqual(['400000']);
    // A 200k model in an old snapshot: still no flag.
    expect(a.buildLaunch(session({ model: 'claude-opus-4-5' }), 'hi', launch()).argv).not.toContain('--autocompact');
    // An id neither the snapshot budgets nor the table know: the CLI's own default applies.
    expect(a.buildLaunch(session({ model: 'claude-future-9' }), 'hi', launch()).argv).not.toContain('--autocompact');
  });

  it('engine=local runs the plain claude binary pointed at Ollama, told its real window', () => {
    const a = adapterFor('local');
    const l = a.buildLaunch(
      session({ engine: 'local', model: 'qwen3-coder:30b', usage: { ...session().usage, contextWindow: 65_536 } }),
      'hi',
      launch({ launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434/v1/' }),
    );
    expect(l.argv[0]).toBe('claude');
    expect(l.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // Without this the CLI assumes its 200k unknown-model default and never
      // compacts before a 64k runner truncates.
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '65536',
    });
    expect(l.argv[l.argv.indexOf('--model') + 1]).toBe('qwen3-coder:30b');
    // Slim, cache-stable local prompt: per-launch sections move out of the system prompt.
    expect(l.argv).toContain('--exclude-dynamic-system-prompt-sections');
    expect(l.argv.indexOf('--exclude-dynamic-system-prompt-sections')).toBeLessThan(l.argv.indexOf('--'));
    // Local seats compact through the window, never through --autocompact —
    // even when the tag happens to look like a Claude id or the mode says expansive.
    expect(l.argv).not.toContain('--autocompact');
    const odd = a.buildLaunch(session({ engine: 'local', model: 'claude-opus-5', contextMode: 'expansive' }), 'hi', launch({ launcher: null }));
    expect(odd.argv).not.toContain('--autocompact');
  });

  it('local window precedence: the session window, then the snapshot option, the seat, the named default', () => {
    const a = adapterFor('local');
    const localSeat: VerseSeat = {
      ...SEAT, id: 'local:q', engine: 'local', accountId: 'local',
      models: [{ id: 'q:ctx32k', label: 'Q', contextWindow: 32_768 }], contextWindow: 131_072,
    };
    const noWindow = { ...session().usage, contextWindow: null };
    const window = (s: VerseSession, seat: VerseSeat): string | undefined =>
      a.buildLaunch(s, 'hi', launch({ launcher: null, seat })).env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'];
    expect(window(session({ engine: 'local', model: 'q:ctx32k', usage: { ...noWindow, contextWindow: 16_384 } }), localSeat)).toBe('16384');
    expect(window(session({ engine: 'local', model: 'q:ctx32k', usage: noWindow }), localSeat)).toBe('32768');
    expect(window(session({ engine: 'local', model: 'other', usage: noWindow }), localSeat)).toBe('131072');
    expect(window(session({ engine: 'local', model: 'other', usage: noWindow }), { ...localSeat, contextWindow: null })).toBe('65536');
    // A nonsense stored window is not forwarded to the CLI.
    expect(window(session({ engine: 'local', model: 'q:ctx32k', usage: { ...noWindow, contextWindow: -5 } }), localSeat)).toBe('32768');
  });

  it('strips /v1 from the ollama base', () => {
    expect(anthropicEnvBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(anthropicEnvBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(anthropicEnvBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });
});

describe('claude adapter — shared project memory', () => {
  const MEMORY_DIR = '/home/u/.ashlr/verse/memory/proj-0123456789ab';
  const BLOCK = '# Shared project memory\nRead MEMORY.md in the memory directory before substantial work.\n\n- build: `make ci` (CI parity)';

  it('writable memory: --add-dir <dir> and the snapshotted block, identical on every turn', () => {
    for (const engine of ['claude', 'local'] as const) {
      const a = adapterFor(engine);
      const l = launch({ launcher: engine === 'local' ? null : launch().launcher, memory: { dir: MEMORY_DIR, block: BLOCK, writable: true } });
      const first = a.buildLaunch(session({ engine }), 'one', l);
      const later = a.buildLaunch(session({ engine, turnCount: 7 }), 'two', l);
      for (const turn of [first, later]) {
        expect(valuesOf(turn.argv, '--add-dir')).toEqual([MEMORY_DIR]);
        expect(turn.argv).toContain(`--append-system-prompt=${BLOCK}`);
        expect(turn.argv.indexOf(`--append-system-prompt=${BLOCK}`)).toBeLessThan(turn.argv.indexOf('--'));
        expect(turn.argv.indexOf('--add-dir')).toBeLessThan(turn.argv.indexOf('--'));
      }
      // Cache stability: everything before the session flags is byte-identical across turns.
      const head = (argv: string[]): string[] => argv.slice(0, argv.findIndex((p) => p === '--session-id' || p === '--resume'));
      expect(head(later.argv)).toEqual(head(first.argv));
    }
  });

  it('read-only memory appends the block but grants no directory', () => {
    const turn = adapterFor('claude').buildLaunch(session(), 'hi', launch({ memory: { dir: MEMORY_DIR, block: BLOCK, writable: false } }));
    expect(turn.argv).not.toContain('--add-dir');
    expect(turn.argv).toContain(`--append-system-prompt=${BLOCK}`);
  });

  it('binds a block that starts with a dash to its flag (the `=` spelling)', () => {
    const block = '--dangerously-skip-permissions is not a flag here';
    const turn = adapterFor('claude').buildLaunch(session(), 'hi', launch({ memory: { dir: MEMORY_DIR, block, writable: true } }));
    expect(turn.argv).toContain(`--append-system-prompt=${block}`);
    expect(turn.argv).not.toContain(block);
    expect(turn.argv).not.toContain('--dangerously-skip-permissions');
  });

  it('memory next to workspace roots: one flag per directory, never duplicated', () => {
    const turn = adapterFor('claude').buildLaunch(
      session({ extraRoots: ['/tmp/lib', MEMORY_DIR] }),
      'hi',
      launch({ memory: { dir: MEMORY_DIR, block: BLOCK, writable: true } }),
    );
    expect(valuesOf(turn.argv, '--add-dir')).toEqual(['/tmp/lib', MEMORY_DIR]);
  });

  it('no memory, or a malformed snapshot, adds nothing', () => {
    const plain = adapterFor('claude').buildLaunch(session(), 'hi', launch());
    const malformed = [
      { dir: 'relative/dir', block: BLOCK, writable: true },
      { dir: MEMORY_DIR, block: '   ', writable: true },
      { dir: MEMORY_DIR, block: 42, writable: true },
      null,
    ];
    for (const memory of malformed) {
      const turn = adapterFor('claude').buildLaunch(session(), 'hi', launch({ memory: memory as unknown as VerseSeatLaunch['memory'] }));
      expect(turn.argv).toEqual(plain.argv);
    }
    expect(plain.argv.some((p) => p.startsWith('--append-system-prompt'))).toBe(false);
    expect(plain.argv).not.toContain('--add-dir');
  });
});

const CLAUDE_TURN = [
  { type: 'system', subtype: 'init', session_id: 'sid-abc', model: 'claude-opus-5', cwd: '/tmp/proj' },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 1 } } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look.' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"/tmp/proj/a.ts"}' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
  { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } } },
  { type: 'stream_event', event: { type: 'message_stop' } },
  { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/proj/a.ts' } }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 20 } } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const a = 1;', is_error: false }] } },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2', role: 'assistant', content: [], usage: { input_tokens: 15, cache_read_input_tokens: 1210, cache_creation_input_tokens: 300, output_tokens: 1 } } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
  { type: 'stream_event', event: { type: 'message_stop' } },
  { type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 15, cache_read_input_tokens: 1210, cache_creation_input_tokens: 300, output_tokens: 3 } } },
  'this is not json',
  '{"type":"stream_event","event":',
  { type: 'result', subtype: 'success', is_error: false, session_id: 'sid-abc', num_turns: 2, result: 'Done.', usage: { input_tokens: 25, cache_read_input_tokens: 2210, cache_creation_input_tokens: 500, output_tokens: 23 } },
];

/** CLAUDE_TURN with its terminal `result` swapped for one carrying `modelUsage`. */
function withModelUsage(modelUsage: unknown, lines: unknown[] = CLAUDE_TURN): unknown[] {
  return lines.map((line) => (typeof line === 'object' && line !== null && (line as { type?: string }).type === 'result'
    ? { ...(line as object), modelUsage }
    : line));
}

describe('claude adapter — parser', () => {
  it('normalizes a tool-using turn: deltas, deduped messages, tool use/result, usage, session id', () => {
    const a = adapterFor('claude');
    const parser = a.createParser('t1');
    const events = feed(parser, CLAUDE_TURN);

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'text-delta')).toHaveLength(3);
    expect(types.filter((t) => t === 'assistant-message')).toHaveLength(2);
    expect(types.filter((t) => t === 'tool-use')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool-result')).toHaveLength(1);
    expect(types.filter((t) => t === 'usage')).toHaveLength(1);
    expect(types).not.toContain('error');
    expect(types).not.toContain('compaction');

    const messages = events.filter((e) => e.type === 'assistant-message').map((e) => (e as { text: string }).text);
    expect(messages).toEqual(['Let me look.', 'Done.']);

    const toolUse = events.find((e) => e.type === 'tool-use') as { toolUseId: string; name: string; input: unknown };
    expect(toolUse.toolUseId).toBe('toolu_1');
    expect(toolUse.name).toBe('Read');
    expect(toolUse.input).toEqual({ file_path: '/tmp/proj/a.ts' });

    const toolResult = events.find((e) => e.type === 'tool-result') as { toolUseId: string; output: string; isError: boolean };
    expect(toolResult).toMatchObject({ toolUseId: 'toolu_1', output: 'export const a = 1;', isError: false });

    const usage = usageOf(events);
    // Turn totals come from `result`; context occupancy from the LAST assistant call.
    expect(usage.inputTokens).toBe(25);
    expect(usage.outputTokens).toBe(23);
    expect(usage.cacheReadTokens).toBe(2210);
    expect(usage.cacheCreationTokens).toBe(500);
    expect(usage.contextTokens).toBe(15 + 1210 + 300);
    // No `modelUsage` on this result → the window is unknown, never guessed.
    expect(usage.contextWindow).toBeNull();

    // Ordering: deltas precede the deduped message; usage comes last before finish.
    expect(types.indexOf('text-delta')).toBeLessThan(types.indexOf('assistant-message'));
    expect(types[types.length - 1]).toBe('usage');

    expect(parser.nativeSessionId()).toBe('sid-abc');
    for (const e of events) expect((e as { turnId: string }).turnId).toBe('t1');
  });

  it('counts each API call ONCE when the process dies before `result`', () => {
    // msg_1 is reported by message_start, message_delta and TWO assistant
    // envelopes; summing them all used to triple-count it. Without `result`,
    // the deduped per-call sum must equal what the CLI itself would have said.
    const noResult = CLAUDE_TURN.filter((l) => typeof l !== 'object' || (l as { type?: string }).type !== 'result');
    const usage = usageOf(feed(adapterFor('claude').createParser('t-dead'), noResult, 1));
    expect(usage).toEqual({
      inputTokens: 25,
      outputTokens: 23,
      cacheReadTokens: 2210,
      cacheCreationTokens: 500,
      contextTokens: 15 + 1210 + 300,
      contextWindow: null,
    });
  });

  it('an id-less envelope after message_stop belongs to the call that just ended', () => {
    const usage = usageOf(feed(createAnthropicStreamParser('t-noid'), [
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'message_stop' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 7 } } },
    ]));
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 7, contextTokens: 100 });
  });

  it('reads the turn window from result.modelUsage (the row for the init model)', () => {
    const usage = usageOf(feed(adapterFor('claude').createParser('t-mu'), withModelUsage({
      'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens: 20, contextWindow: 200_000, maxOutputTokens: 32_000 },
      'claude-opus-5': { inputTokens: 25, outputTokens: 23, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
    })));
    expect(usage.contextWindow).toBe(1_000_000);
    // The window is information only: token totals still come from `result.usage`.
    expect(usage).toMatchObject({ inputTokens: 25, outputTokens: 23, contextTokens: 1525 });
  });

  it('the credit clamp shows through: a 1M model the CLI ran at 200k reports 200k', () => {
    const usage = usageOf(feed(createAnthropicStreamParser('t-clamp'), withModelUsage({ 'claude-opus-5': { contextWindow: 200_000 } })));
    expect(usage.contextWindow).toBe(200_000);
  });

  it('parses the real local-seat result line (claude 2.1.280 → Ollama, CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536)', () => {
    // Captured 2026-09-23 from a real turn built by this adapter (see the U2 report).
    const events = feed(createAnthropicStreamParser('t-local'), [
      { type: 'system', subtype: 'init', session_id: '6a1f3a52-3c52-4c61-9d3e-5d2f6f7b8e90', model: 'qwen3.8:27b-ctx64k', permissionMode: 'acceptEdits', claude_code_version: '2.1.280' },
      { type: 'assistant', message: { id: 'msg_local_1', model: 'qwen3.8:27b-ctx64k', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 14942, output_tokens: 45, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { duration_api_ms: 60713, stop_reason: 'end_turn', session_id: '6a1f3a52-3c52-4c61-9d3e-5d2f6f7b8e90', total_cost_usd: 0.060668, usage: { input_tokens: 14942, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 45, output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard' }, modelUsage: { 'qwen3.8:27b-ctx64k': { inputTokens: 14942, outputTokens: 45, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.060668, contextWindow: 65536, maxOutputTokens: 32000, thinkingTokens: 0, canonicalModel: 'qwen3.8:27b-ctx64k', provider: 'firstParty', costBasis: 'unknown' } }, permission_denials: [], terminal_reason: 'completed', is_error: false, num_turns: 1, subtype: 'success', api_error_status: null, result: 'OK', type: 'result', duration_ms: 60766 },
    ]);
    expect(events.map((e) => e.type)).toEqual(['assistant-message', 'usage']);
    expect(usageOf(events)).toEqual({
      inputTokens: 14942, outputTokens: 45, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 14942, contextWindow: 65536,
    });
  });

  it('emits an error for a non-success result; exit codes are left to the engine', () => {
    const a = adapterFor('claude');
    const bad = feed(a.createParser('t2'), [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(bad.map((e) => e.type)).toEqual(['error', 'usage']);
    expect((bad[0] as { message: string }).message).toContain('error_max_turns');

    // Exit-code errors are the engine's job (it holds the stderr tail); the parser stays quiet.
    const crashed = feed(a.createParser('t3'), [{ type: 'system', subtype: 'init', session_id: 's' }], 1);
    expect(crashed).toEqual([]);

    const clean = feed(a.createParser('t4'), [], 0);
    expect(clean).toEqual([]);
  });

  it('never throws on garbage and surfaces thinking blocks', () => {
    const parser = createAnthropicStreamParser('t5');
    expect(parser.push('')).toEqual([]);
    expect(parser.push('{')).toEqual([]);
    expect(parser.push('[1,2]')).toEqual([]);
    expect(parser.push('{"type":"stream_event","event":null}')).toEqual([]);
    expect(parser.push('{"type":"result","modelUsage":"nope","usage":null}')).toEqual([]);
    expect(parser.push('{"type":"system","subtype":"compact_boundary","compact_metadata":"garbage"}')).toEqual([
      { type: 'compaction', turnId: 't5', trigger: 'auto', preTokens: null, postTokens: null, durationMs: null },
    ]);
    expect(parser.push('{"type":"assistant","message":{"content":"plain string"}}')).toEqual([
      { type: 'assistant-message', turnId: 't5', text: 'plain string' },
    ]);
    expect(parser.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }))).toEqual([
      { type: 'thinking', turnId: 't5', text: 'hmm' },
    ]);
  });
});

describe('runtimeContextWindow — which modelUsage row is the turn\'s', () => {
  it('prefers the exact (canonicalised) model row', () => {
    const rows = { 'claude-haiku-4-5-20251001': { contextWindow: 200_000 }, 'claude-fable-5': { contextWindow: 1_000_000 } };
    expect(runtimeContextWindow(rows, 'claude-fable-5')).toBe(1_000_000);
    expect(runtimeContextWindow(rows, 'claude-haiku-4-5-20251001')).toBe(200_000);
    // The retired alias still finds the real id's row.
    expect(runtimeContextWindow({ 'claude-opus-5-5': { contextWindow: 1_000_000 }, x: { contextWindow: 5 } }, 'claude-opus-5.5')).toBe(1_000_000);
  });

  it('matches across a [1m] suffix in either direction', () => {
    const haiku = { contextWindow: 200_000 };
    expect(runtimeContextWindow({ 'claude-opus-4-8[1m]': { contextWindow: 1_000_000 }, 'claude-haiku-4-5-20251001': haiku }, 'claude-opus-4-8')).toBe(1_000_000);
    expect(runtimeContextWindow({ 'claude-opus-4-8': { contextWindow: 1_000_000 }, 'claude-haiku-4-5-20251001': haiku }, 'claude-opus-4-8[1m]')).toBe(1_000_000);
  });

  it('falls back to the single row that carries a window (grok keys differ from the CLI id)', () => {
    expect(runtimeContextWindow({ 'grok-4.6-build': { inputTokens: 5, contextWindow: 500_000 }, 'grok-4.5': { inputTokens: 1 } }, 'grok-4.6')).toBe(500_000);
    expect(runtimeContextWindow({ 'grok-4.6-build': { contextWindow: 500_000 } }, null)).toBe(500_000);
    // A matched row WITHOUT a window defers to the single windowed row.
    expect(runtimeContextWindow({ 'grok-4.6': { inputTokens: 1 }, 'grok-4.6-build': { contextWindow: 500_000 } }, 'grok-4.6')).toBe(500_000);
  });

  it('is null — never a guess — when the rows are ambiguous or absent', () => {
    const two = { a: { contextWindow: 200_000 }, b: { contextWindow: 1_000_000 } };
    expect(runtimeContextWindow(two, null)).toBeNull();
    expect(runtimeContextWindow(two, 'c')).toBeNull();
    expect(runtimeContextWindow({}, 'a')).toBeNull();
    expect(runtimeContextWindow(null, 'a')).toBeNull();
    expect(runtimeContextWindow([{ contextWindow: 5 }], null)).toBeNull();
    expect(runtimeContextWindow({ a: { contextWindow: 0 } }, 'a')).toBeNull();
    expect(runtimeContextWindow({ a: { contextWindow: -1 } }, 'a')).toBeNull();
    expect(runtimeContextWindow({ a: { contextWindow: '1000000' } }, 'a')).toBeNull();
    expect(runtimeContextWindow({ a: 'nope' }, 'a')).toBeNull();
  });

  it('falls back to the assistant frame model when init carried none', () => {
    const usage = usageOf(feed(createAnthropicStreamParser('t-frame'), [
      { type: 'assistant', message: { id: 'm', model: 'claude-fable-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 3, output_tokens: 1 } } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 3, output_tokens: 1 }, modelUsage: { 'claude-haiku-4-5-20251001': { contextWindow: 200_000 }, 'claude-fable-5': { contextWindow: 1_000_000 } } },
    ]));
    expect(usage.contextWindow).toBe(1_000_000);
  });
});

describe('claude adapter — compaction', () => {
  // Captured 2026-09-23: a headless `/compact` turn on a local seat (claude
  // 2.1.280 → Ollama). The compaction's own call is not streamed and the
  // result's usage is all zeros; post_tokens is the only occupancy reading.
  const REAL_COMPACT_TURN = [
    { type: 'system', subtype: 'init', session_id: '6a1f3a52-3c52-4c61-9d3e-5d2f6f7b8e90', model: 'qwen3.8:27b-ctx64k' },
    { type: 'system', subtype: 'compact_boundary', session_id: '6a1f3a52-3c52-4c61-9d3e-5d2f6f7b8e90', uuid: '9300f601-0a59-4c16-8ff2-778ef6126d56', compact_metadata: { trigger: 'manual', pre_tokens: 14988, post_tokens: 1750, cumulative_dropped_tokens: 13238, duration_ms: 156052 }, logical_parent_uuid: 'd3ce8119-2fa7-4483-a64a-0d43c5ded6e1' },
    { is_error: false, duration_api_ms: 0, num_turns: 0, stop_reason: null, session_id: '6a1f3a52-3c52-4c61-9d3e-5d2f6f7b8e90', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, modelUsage: { 'qwen3.8:27b-ctx64k': { inputTokens: 16316, outputTokens: 1551, cacheReadInputTokens: 14986, contextWindow: 65536, maxOutputTokens: 32000 } }, subtype: 'success', result: '', local_command: 'compact', type: 'result' },
  ];

  it('turns compact_boundary into a compaction event and reports the post-compaction occupancy', () => {
    const events = feed(createAnthropicStreamParser('t-compact'), REAL_COMPACT_TURN);
    expect(events).toEqual([
      { type: 'compaction', turnId: 't-compact', trigger: 'manual', preTokens: 14988, postTokens: 1750, durationMs: 156052 },
      {
        type: 'usage',
        turnId: 't-compact',
        // No call followed the compaction, so the CLI's post-compaction size is
        // the live occupancy — not a stale pre-compaction call.
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 1750, contextWindow: 65536 },
      },
    ]);
  });

  it('an auto-compaction mid-turn: the next call\'s prompt is the occupancy', () => {
    const events = feed(createAnthropicStreamParser('t-auto'), [
      { type: 'system', subtype: 'init', session_id: 's', model: 'claude-fable-5' },
      { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'before' }], usage: { input_tokens: 5, cache_read_input_tokens: 399_000, output_tokens: 10 } } },
      { type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'auto', pre_tokens: 399_005 } },
      { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'after' }], usage: { input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 10 } } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 40_005, cache_read_input_tokens: 399_000, cache_creation_input_tokens: 2_000, output_tokens: 20 }, modelUsage: { 'claude-fable-5': { contextWindow: 1_000_000 } } },
    ]);
    expect(events.find((e) => e.type === 'compaction')).toEqual({
      type: 'compaction', turnId: 't-auto', trigger: 'auto', preTokens: 399_005, postTokens: null, durationMs: null,
    });
    expect(usageOf(events)).toMatchObject({ contextTokens: 42_000, contextWindow: 1_000_000 });
    const types = events.map((e) => e.type);
    expect(types.indexOf('compaction')).toBeLessThan(types.indexOf('usage'));
  });

  it('accepts the camelCase transcript spelling and defaults an unknown trigger to auto', () => {
    const parser = createAnthropicStreamParser('t-camel');
    expect(parser.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'weird', preTokens: 967_391, postTokens: 41_000, durationMs: 118_000 } }))).toEqual([
      { type: 'compaction', turnId: 't-camel', trigger: 'auto', preTokens: 967_391, postTokens: 41_000, durationMs: 118_000 },
    ]);
    // Negative / non-numeric counts are unknown, not zero.
    expect(parser.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: -3, post_tokens: '12', duration_ms: null } }))).toEqual([
      { type: 'compaction', turnId: 't-camel', trigger: 'auto', preTokens: null, postTokens: null, durationMs: null },
    ]);
  });

  it('a compaction with no post size and no calls emits no invented usage', () => {
    const events = feed(createAnthropicStreamParser('t-bare'), [
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100 } },
    ]);
    expect(events.map((e) => e.type)).toEqual(['compaction']);
  });
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

const CODEX_SEAT: VerseSeat = { ...SEAT, id: 'codex-a', engine: 'codex', accountId: 'codex-a', models: [{ id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 }] };

describe('codex adapter — buildLaunch', () => {
  it('turn 1 is `exec --json ... -` with the prompt on stdin; later turns `exec resume <thread>`', () => {
    const a = adapterFor('codex');
    const l = launch({ seat: CODEX_SEAT, launcher: ['/usr/local/bin/node', '/x/launcher.mjs'] });
    const first = a.buildLaunch(session({ engine: 'codex', seatId: 'codex-a', model: 'gpt-5.5', nativeSessionId: null }), 'do it', l);
    // V3.10: detailed reasoning summaries (live reasoning is on by default) and
    // no git-repo gate, on exec and resume alike.
    expect(first.argv).toEqual(['/usr/local/bin/node', '/x/launcher.mjs', 'exec', '-c', 'model_reasoning_summary="detailed"', '--skip-git-repo-check', '--json', '--model', 'gpt-5.5', '--cd', '/tmp/proj', '--sandbox', 'workspace-write', '-']);
    expect(first.stdin).toBe('do it');
    expect(first.env).toEqual({});

    const second = a.buildLaunch(session({ engine: 'codex', seatId: 'codex-a', model: 'gpt-5.5', nativeSessionId: 'thread-9', turnCount: 1 }), 'more', l);
    expect(second.argv).toEqual(['/usr/local/bin/node', '/x/launcher.mjs', 'exec', 'resume', 'thread-9', '-c', 'model_reasoning_summary="detailed"', '--skip-git-repo-check', '--json', '-']);
    expect(second.stdin).toBe('more');
  });

  it('falls back to a fresh exec when turn 1 never produced a thread id', () => {
    const a = adapterFor('codex');
    const l = launch({ seat: CODEX_SEAT, launcher: ['/x/launcher.mjs'] });
    const again = a.buildLaunch(session({ engine: 'codex', nativeSessionId: null, turnCount: 1, model: 'gpt-5.5' }), 'retry', l);
    expect(again.argv[1]).toBe('exec');
    expect(again.argv).not.toContain('resume');
    expect(again.argv).toContain('--model');
  });
});

const CODEX_TURN = [
  { type: 'thread.started', thread_id: 'thr_123' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: 'reasoning', text: '' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Need to inspect the file.' } },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'cat a.ts', cwd: '/tmp/proj', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat a.ts', aggregated_output: 'export const a = 1;\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'file_change', status: 'completed', changes: [{ path: '/tmp/proj/a.ts', kind: 'update' }] } },
  { type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call', server: 'fs', tool: 'stat', arguments: { path: 'a.ts' }, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'fs', tool: 'stat', arguments: { path: 'a.ts' }, status: 'failed', error: { message: 'no such tool' } } },
  { type: 'item.started', item: { id: 'item_4', type: 'agent_message', text: '' } },
  { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Updated a.ts.' } },
  'not json at all',
  { type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 120 } },
];

describe('codex adapter — parser', () => {
  it('captures thread_id and normalizes items into tool-use/result, thinking and message', () => {
    const parser = createCodexParser('c1');
    const events = persisted(feed(parser, CODEX_TURN));
    expect(parser.nativeSessionId()).toBe('thr_123');

    // No `usage` from the codex PARSER any more (V3.9): `exec resume` prints the
    // thread's running total, so the adapter's afterTurn hook emits the turn's
    // usage once, from the rollout when it can (see "codex adapter — afterTurn").
    expect(events.map((e) => e.type)).toEqual([
      'thinking',
      'tool-use', 'tool-result',
      'tool-use', 'tool-result',
      'tool-use', 'tool-result',
      'assistant-message',
    ]);

    const [, cmdUse, cmdResult, fcUse, fcResult, mcpUse, mcpResult, message] = events as Array<Record<string, unknown>>;
    expect(cmdUse).toMatchObject({ toolUseId: 'item_1', name: 'command_execution', input: { command: 'cat a.ts', cwd: '/tmp/proj' } });
    expect(cmdResult).toMatchObject({ toolUseId: 'item_1', output: 'export const a = 1;\n', isError: false });
    expect(fcUse).toMatchObject({ toolUseId: 'item_2', name: 'file_change' });
    expect(fcResult).toMatchObject({ toolUseId: 'item_2', output: 'update /tmp/proj/a.ts', isError: false });
    expect(mcpUse).toMatchObject({ toolUseId: 'item_3', name: 'mcp:fs.stat', input: { path: 'a.ts' } });
    expect(mcpResult).toMatchObject({ toolUseId: 'item_3', output: 'no such tool', isError: true });
    expect(message).toMatchObject({ text: 'Updated a.ts.' });
  });

  it('reports turn.failed as an error and a failed command as an error result', () => {
    const failed = persisted(feed(createCodexParser('c2'), [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'completed' } },
      { type: 'turn.failed', error: { message: 'model overloaded' } },
    ]));
    expect(failed.map((e) => e.type)).toEqual(['tool-use', 'tool-result', 'error']);
    expect(failed[1]).toMatchObject({ isError: true });
    expect((failed[2] as { message: string }).message).toBe('codex: model overloaded');

    const crashed = feed(createCodexParser('c3'), [], 2);
    expect(crashed).toEqual([]);
  });
});

describe('codex adapter — afterTurn usage without a readable rollout', () => {
  /** Run one codex turn's stdout through the parser, then the adapter's afterTurn hook, as the engine does. */
  function codexTurnUsage(lines: unknown[]): VerseParsedEvent[] {
    const adapter = adapterFor('codex');
    const parser = adapter.createParser('c-after');
    feed(parser, lines);
    // The launcher lives in the relocated tmp HOME, so no native-state (and no
    // rollout) exists: this pins the stdout fallback, never a real file.
    const l = launch({ seat: CODEX_SEAT, launcher: ['/usr/local/bin/node', join(tmpHome, 'codex-seat', 'launcher.mjs')] });
    const s = session({ engine: 'codex', seatId: 'codex-a', model: 'gpt-5.5', nativeSessionId: null });
    return adapter.afterTurn?.({ session: s, launch: l, turnId: 'c-after', startedAt: Date.now(), nativeSessionId: parser.nativeSessionId(), parser, state: {} }) ?? [];
  }

  it('two model calls in one turn: totals are split once and contextTokens is the turn total, marked as an upper bound', () => {
    // `exec --json` reports one aggregate usage per turn — there is no per-call
    // prompt size — so 2 calls of ~3k prompt each show as input 6000 / cached 2500.
    const events = codexTurnUsage([
      { type: 'thread.started', thread_id: 't2' },
      { type: 'item.completed', item: { id: 'a', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 6000, cached_input_tokens: 2500, output_tokens: 40 } },
    ]);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(1);
    expect((usage[0] as unknown as { usage: Record<string, unknown> }).usage).toEqual({
      inputTokens: 3500, outputTokens: 40, cacheReadTokens: 2500, cacheCreationTokens: 0,
      contextTokens: 6000, contextWindow: null, contextTokensExact: false,
    });
  });

  it('a cached figure larger than input (malformed) never produces negative input', () => {
    const events = codexTurnUsage([{ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 400, output_tokens: 1 } }]);
    const usage = events.find((e) => e.type === 'usage') as unknown as { usage: Record<string, number> };
    expect(usage.usage).toMatchObject({ inputTokens: 0, cacheReadTokens: 100 });
  });

  it('a turn that printed no usage emits none', () => {
    expect(codexTurnUsage([{ type: 'thread.started', thread_id: 't3' }]).filter((e) => e.type === 'usage')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// grok
// ---------------------------------------------------------------------------

// Real ids and windows from the grok-a seat's own catalog (0.2.118): every
// model is 500k and compacts at 80%.
const GROK_SEAT: VerseSeat = {
  ...SEAT,
  id: 'grok',
  engine: 'grok',
  accountId: 'grok',
  models: [
    { id: 'grok-4.7', label: 'Grok 4.7', contextWindow: 500_000, autoCompactAt: 400_000, windowSource: 'provider-catalog' },
    { id: 'grok-4.7-build-fast', label: 'Grok 4.7 Fast', contextWindow: 500_000, autoCompactAt: 400_000, windowSource: 'provider-catalog' },
  ],
  contextWindow: 500_000,
};

function grokSession(overrides: Partial<VerseSession> = {}): VerseSession {
  return session({ engine: 'grok', seatId: 'grok', accountId: 'grok', model: 'grok-4.7', nativeSessionId: 'g-uuid', ...overrides });
}

describe('grok adapter — buildLaunch', () => {
  it('builds streaming-messages-json argv with --session-id then --resume', () => {
    const a = adapterFor('grok');
    const l = launch({ seat: GROK_SEAT, launcher: ['/usr/local/bin/node', '/g/launcher.mjs'] });
    const first = a.buildLaunch(grokSession(), 'yo', l);
    expect(first.argv).toEqual([
      '/usr/local/bin/node', '/g/launcher.mjs',
      // V3.10: a seat turn never lets the pinned CLI update itself.
      '--no-auto-update',
      '--output-format', 'streaming-messages-json',
      '--include-partial-messages',
      '--cwd', '/tmp/proj',
      '--model', 'grok-4.7',
      // dontAsk, not acceptEdits: Grok's acceptEdits leaves
      // `run_terminal_command` needing an approver that a seat does not have,
      // and the turn is cancelled mid-run. Measured against the real CLI.
      '--permission-mode', 'dontAsk',
      '--session-id', 'g-uuid',
      '--single=yo',
    ]);
    expect(first.stdin).toBeNull();
    expect(first.env).toEqual({});
    const second = a.buildLaunch(grokSession({ turnCount: 3 }), 'yo', l);
    expect(second.argv.slice(-3)).toEqual(['--resume', 'g-uuid', '--single=yo']);
  });

  it('passes a leading-dash message in the --single=<text> spelling clap accepts as a value', () => {
    const a = adapterFor('grok');
    const l = launch({ seat: GROK_SEAT, launcher: ['/usr/local/bin/node', '/g/launcher.mjs'] });
    for (const text of ['- a\n- b', '--dangerously-skip-permissions x']) {
      const argv = a.buildLaunch(grokSession(), text, l).argv;
      expect(argv[argv.length - 1]).toBe(`--single=${text}`);
      expect(argv).not.toContain('-p');
      expect(argv).not.toContain(text);
    }
  });

  it('has no context-mode flags: an expansive record launches exactly like a standard one', () => {
    const a = adapterFor('grok');
    const l = launch({ seat: GROK_SEAT, launcher: ['/g/launcher.mjs'] });
    const standard = a.buildLaunch(grokSession(), 'x', l).argv;
    expect(a.buildLaunch(grokSession({ contextMode: 'expansive' }), 'x', l).argv).toEqual(standard);
    expect(standard.some((p) => /autocompact|compact|context/i.test(p))).toBe(false);
  });

  it('shared memory reaches grok as --rules=<block>, read-only: no directory is ever granted', () => {
    const a = adapterFor('grok');
    const BLOCK = '- Shared project memory (read-only on this seat).\n- build: `make ci`';
    const l = launch({ seat: GROK_SEAT, launcher: ['/g/launcher.mjs'], memory: { dir: '/home/u/.ashlr/verse/memory/p-0123456789ab', block: BLOCK, writable: false } });
    const first = a.buildLaunch(grokSession(), 'hi', l);
    const later = a.buildLaunch(grokSession({ turnCount: 2 }), 'again', l);
    for (const turn of [first, later]) {
      // `=` spelling: the block starts with `-` and must stay a value.
      expect(turn.argv).toContain(`--rules=${BLOCK}`);
      expect(turn.argv).not.toContain(BLOCK);
      expect(turn.argv.indexOf(`--rules=${BLOCK}`)).toBeLessThan(turn.argv.findIndex((p) => p === '--session-id' || p === '--resume'));
      expect(turn.argv.join('\n')).not.toContain('/home/u/.ashlr/verse/memory');
      expect(turn.argv[turn.argv.length - 1]).toBe(turn === first ? '--single=hi' : '--single=again');
    }
    // Byte-identical block every turn (cache-stable).
    expect(first.argv.filter((p) => p.startsWith('--rules='))).toEqual(later.argv.filter((p) => p.startsWith('--rules=')));
    // Memory off → no --rules at all.
    expect(a.buildLaunch(grokSession(), 'hi', launch({ seat: GROK_SEAT, launcher: ['/g/launcher.mjs'] })).argv.some((p) => p.startsWith('--rules'))).toBe(false);
    expect(a.buildLaunch(grokSession(), 'hi', launch({ seat: GROK_SEAT, launcher: ['/g/launcher.mjs'], memory: { dir: '/x', block: '  ', writable: false } })).argv.some((p) => p.startsWith('--rules'))).toBe(false);
  });

  it('sends the canonical model id', () => {
    const argv = adapterFor('grok').buildLaunch(grokSession({ model: 'grok-4.7-build-fast' }), 'x', launch({ seat: GROK_SEAT })).argv;
    expect(valueOf(argv, '--model')).toBe('grok-4.7-build-fast');
  });
});

const GROK_TURN = [
  { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'grok-4.7', content: [], usage: { input_tokens: 800, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'a.ts\nb.ts' }], is_error: false }] } },
  { type: 'message_start', message: { id: 'm2', type: 'message', role: 'assistant', model: 'grok-4.7', content: [], usage: { input_tokens: 950, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Two files.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
];

describe('grok adapter — parser', () => {
  it('parses bare Anthropic wire events and totals usage across API calls', () => {
    const a = adapterFor('grok');
    const parser = a.createParser('g1');
    const events = persisted(feed(parser, GROK_TURN));
    expect(events.map((e) => e.type)).toEqual([
      'text-delta', 'text-delta', 'assistant-message',
      'tool-use',
      'tool-result',
      'text-delta', 'assistant-message',
      'usage',
    ]);
    expect(events[2]).toMatchObject({ text: 'Hello there' });
    expect(events[3]).toMatchObject({ toolUseId: 'tu_1', name: 'bash', input: { cmd: 'ls' } });
    expect(events[4]).toMatchObject({ toolUseId: 'tu_1', output: 'a.ts\nb.ts', isError: false });
    expect(events[7]).toMatchObject({
      usage: { inputTokens: 1750, outputTokens: 16, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 950, contextWindow: null },
    });
    // grok's conversation id is the uuid we minted; nothing to capture from output.
    expect(parser.nativeSessionId()).toBeNull();
  });

  it('accepts the same events wrapped in claude\'s stream_event envelope', () => {
    const wrapped = GROK_TURN.map((ev) => (ev.type === 'user' ? ev : { type: 'stream_event', event: ev }));
    const bare = feed(adapterFor('grok').createParser('g2'), GROK_TURN);
    const viaWrapper = feed(adapterFor('grok').createParser('g2'), wrapped);
    expect(viaWrapper).toEqual(bare);
  });

  it('partial framing plus the flushed assistant frame count each response once', () => {
    // Grok emits BOTH the partial message_start…message_stop framing and one
    // `assistant` frame per response; the frame must not double the totals.
    const withFrames = [
      ...GROK_TURN.slice(0, 10),
      { type: 'assistant', message: { id: 'm1', model: 'grok-4.7', content: [{ type: 'text', text: 'Hello there' }, { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } }], usage: { input_tokens: 800, output_tokens: 12 } } },
      ...GROK_TURN.slice(10),
      { type: 'assistant', message: { id: 'm2', model: 'grok-4.7', content: [{ type: 'text', text: 'Two files.' }], usage: { input_tokens: 950, output_tokens: 4 } } },
    ];
    const events = feed(adapterFor('grok').createParser('g-frames'), withFrames);
    expect(usageOf(events)).toMatchObject({ inputTokens: 1750, outputTokens: 16, contextTokens: 950 });
    expect(events.filter((e) => e.type === 'assistant-message')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'tool-use')).toHaveLength(1);
  });

  it('takes the window from the single windowed modelUsage row even when its key differs from the CLI id', () => {
    const events = feed(adapterFor('grok').createParser('g-mu'), [
      { type: 'system', subtype: 'init', session_id: 'g-uuid', model: 'grok-4.6', cwd: '/tmp/proj' },
      ...GROK_TURN,
      {
        type: 'result', subtype: 'success', is_error: false, session_id: 'g-uuid', num_turns: 2, result: 'Two files.',
        usage: { input_tokens: 1750, output_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        // Only the CURRENT model's row carries the window (grok headless docs).
        modelUsage: { 'grok-4.6-build': { inputTokens: 1750, outputTokens: 16, costUSD: 0, contextWindow: 500_000 }, 'grok-4.5': { inputTokens: 0, outputTokens: 0, costUSD: 0 } },
      },
    ]);
    expect(usageOf(events)).toEqual({
      inputTokens: 1750, outputTokens: 16, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 950, contextWindow: 500_000,
    });
  });

  it('an all-zero result usage means "unknown" on grok, so the observed calls are used instead', () => {
    const events = feed(adapterFor('grok').createParser('g-zero'), [
      ...GROK_TURN,
      { type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} },
    ]);
    expect(usageOf(events)).toEqual({
      inputTokens: 1750, outputTokens: 16, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 950, contextWindow: null,
    });
  });

  it('reports grok\'s compact_boundary as a compaction and error results under the grok label', () => {
    const events = feed(adapterFor('grok').createParser('g-compact'), [
      { type: 'system', subtype: 'compact_boundary', session_id: 'g-uuid', compact_metadata: { trigger: 'auto', pre_tokens: 401_234, post_tokens: 38_000 } },
      ...GROK_TURN,
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'cancelled', usage: { input_tokens: 1750, output_tokens: 16 } },
    ]);
    expect(events[0]).toEqual({ type: 'compaction', turnId: 'g-compact', trigger: 'auto', preTokens: 401_234, postTokens: 38_000, durationMs: null });
    const error = events.find((e) => e.type === 'error') as { message: string };
    expect(error.message).toBe('grok: cancelled');
    // Calls followed the compaction, so the last call — not post_tokens — is the occupancy.
    expect(usageOf(events).contextTokens).toBe(950);
  });
});

describe('adapterFor', () => {
  it('maps every engine and shares the claude adapter for local', () => {
    expect(adapterFor('local')).toBe(adapterFor('claude'));
    expect(adapterFor('codex')).not.toBe(adapterFor('claude'));
    expect(adapterFor('grok')).not.toBe(adapterFor('claude'));
    expect(() => adapterFor('nope' as never)).toThrow(/unknown verse engine/);
  });

  it('claude and grok need no telemetry hooks: everything they report is on stdout', () => {
    for (const engine of ['claude', 'local', 'grok'] as const) {
      expect(adapterFor(engine).pollTelemetry).toBeUndefined();
      expect(adapterFor(engine).afterTurn).toBeUndefined();
    }
  });
});
