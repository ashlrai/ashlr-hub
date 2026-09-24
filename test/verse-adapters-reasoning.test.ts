/**
 * test/verse-adapters-reasoning.test.ts — V3.10 unit A4: live reasoning and
 * error handling in the Verse CLI adapters (claude/local, codex, grok).
 *
 *  - REPLAYS of real CLI output captured by the 3.10 research (free local
 *    runs only — scratchpad cot-local/run1.jsonl, cot-local/codex-auto.jsonl,
 *    rel/proj/out1-5.txt) and by this unit (claude 2.1.257/2.1.280 resume and
 *    session-id failures against a scratch CLAUDE_CONFIG_DIR, grok 0.2.118
 *    signed-out result from a credential-less GROK_HOME).
 *  - transient events: thinking-delta, thinking-progress (≤ 4 Hz), progress,
 *    status — and the invariant that dropping them leaves the persisted
 *    sequence unchanged.
 *  - launch: `--thinking-display summarized` gating, codex reasoning summary
 *    + `--skip-git-repo-check`, grok `--no-auto-update`, and the
 *    `--session-id`/`--resume` choice from the native transcript on disk.
 *
 * Filesystem cases run against private tmp "native profiles" laid out like
 * `~/.ashlr/native-profiles/<account>/`; HOME is relocated for the whole file
 * (and by test/setup/home.ts), so nothing here can touch the real ~/.claude,
 * ~/.grok or ~/.ashlr. Nothing is spawned.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adapterFor, type VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import {
  CLAUDE_THINKING_DISPLAY_MIN_CLI,
  THINKING_PROGRESS_MIN_INTERVAL_MS,
  chooseNativeSession,
  claudeConversationState,
  claudeProjectSlug,
  claudeThinkingDisplayArgs,
  classifyVerseCliError,
  createAnthropicStreamParser,
  grokConversationState,
  readNativeProfileFacts,
  thinkingDisplayEnabled,
} from '../src/core/verse/adapters/claude.js';
import { codexResumes, createCodexParser } from '../src/core/verse/adapters/codex.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import {
  VERSE_ERROR_CODES,
  VERSE_TRANSIENT_EVENT_TYPES,
  type VerseSeat,
  type VerseSession,
} from '../src/core/verse/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpHome = '';
let prevHome: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'verse-a4-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** A controllable clock for the parsers' rate limit and durations. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

type Parser = { push(l: string): VerseParsedEvent[]; finish(c: number | null): VerseParsedEvent[] };

/** Feed lines (objects are JSON-encoded), advancing the clock `stepMs` BEFORE each. */
function replay(parser: Parser, lines: readonly unknown[], tick?: (ms: number) => void, stepMs = 0, exitCode: number | null = 0): VerseParsedEvent[] {
  const out: VerseParsedEvent[] = [];
  for (const line of lines) {
    if (tick && stepMs) tick(stepMs);
    out.push(...parser.push(typeof line === 'string' ? line : JSON.stringify(line)));
  }
  out.push(...parser.finish(exitCode));
  return out;
}

function persisted(events: VerseParsedEvent[]): VerseParsedEvent[] {
  return events.filter((e) => !VERSE_TRANSIENT_EVENT_TYPES.has(e.type));
}

function ofType<T extends VerseParsedEvent['type']>(events: VerseParsedEvent[], type: T): Array<Extract<VerseParsedEvent, { type: T }>> {
  return events.filter((e): e is Extract<VerseParsedEvent, { type: T }> => e.type === type);
}

const UUID = '3af9acda-048d-4310-9698-c7ff65d5380a';

const CLAUDE_SEAT: VerseSeat = {
  id: 'claude-a',
  engine: 'claude',
  label: 'Claude',
  accountId: 'claude-a',
  models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 200_000 }],
  contextWindow: 200_000,
  health: { state: 'unknown', summary: null, windows: [], observedAt: null },
};

function session(over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 's-a4',
    title: 't',
    projectPath: '/tmp/proj',
    engine: 'claude',
    accountId: 'claude-a',
    seatId: 'claude-a',
    model: 'claude-opus-5-5',
    nativeSessionId: UUID,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 200_000 },
    lastError: null,
    ...over,
  };
}

/** A launch record plus the optional per-turn fields the engine may add (read structurally). */
type TurnLaunch = VerseSeatLaunch & { thinkingDisplay?: boolean; nativeSession?: 'new' | 'resume' };

function launch(over: Partial<TurnLaunch> = {}): VerseSeatLaunch {
  return { seat: CLAUDE_SEAT, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434', ...over } as VerseSeatLaunch;
}

/** A private native profile: `<root>/native-profiles/<name>/{launcher.mjs,profile.json,native-state/}`. */
function makeProfile(root: string, name: string, manifest: Record<string, unknown> | null): { launcher: string; state: string } {
  const dir = join(root, 'native-profiles', name);
  const state = join(dir, 'native-state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const launcherPath = join(dir, 'launcher.mjs');
  writeFileSync(launcherPath, '// never executed\n', { mode: 0o600 });
  if (manifest) writeFileSync(join(dir, 'profile.json'), JSON.stringify({ nativeStatePath: state, ...manifest }), { mode: 0o600 });
  return { launcher: launcherPath, state };
}

function sessionFlag(argv: string[]): '--resume' | '--session-id' | null {
  if (argv.includes('--resume')) return '--resume';
  if (argv.includes('--session-id')) return '--session-id';
  return null;
}

// ---------------------------------------------------------------------------
// Fixtures (real CLI output; see the file header for provenance)
// ---------------------------------------------------------------------------

/**
 * cot-local/run1.jsonl — claude 2.1.280 → Ollama qwen3.8:27b-ctx64k, prompt
 * "17*23", captured 2026-09-23. Verbatim frames except: the init line keeps
 * only the fields the parser reads (its tool/skill lists are noise), and the
 * per-frame `uuid`/`parent_tool_use_id`/`session_id` bookkeeping is dropped.
 */
const LOCAL_THINKING_RUN: readonly unknown[] = [
  {"type": "system", "subtype": "init", "cwd": "/tmp/proj", "session_id": "08ead875-6dd8-4da9-b743-71d5983dcd9d", "model": "qwen3.8:27b-ctx64k", "permissionMode": "default", "apiKeySource": "none", "claude_code_version": "2.1.280"},
  {"type": "system", "subtype": "status", "status": "requesting"},
  {"type": "stream_event", "event": {"type": "message_start", "message": {"id": "msg_aee167bec78f9830bf40c49c", "type": "message", "role": "assistant", "model": "qwen3.8:27b-ctx64k", "content": [], "usage": {"input_tokens": 1602, "output_tokens": 0}}}, "ttft_ms": 6407},
  {"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 2, "estimated_tokens_delta": 2},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Thinking"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 3, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": ":"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 4, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " 1"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 5, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "7"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 6, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "*"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 7, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "2"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 8, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "3"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 9, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " ="}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 10, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " 1"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 11, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "7"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 12, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "*"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 13, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "2"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 14, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "0"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 15, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " +"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 16, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " 1"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 17, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "7"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 18, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "*"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 19, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "3"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 20, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " ="}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 21, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " 3"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 22, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "4"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 23, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "0"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 24, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " +"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 25, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " 5"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 26, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "1"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 27, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " ="}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 28, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": " 3"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 29, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "9"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 30, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "1"}}},
  {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 31, "estimated_tokens_delta": 1},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "."}}},
  {"type": "assistant", "message": {"id": "msg_aee167bec78f9830bf40c49c", "type": "message", "role": "assistant", "model": "qwen3.8:27b-ctx64k", "content": [{"type": "thinking", "thinking": "Thinking: 17*23 = 17*20 + 17*3 = 340 + 51 = 391.", "signature": ""}], "usage": {"input_tokens": 1602, "output_tokens": 0}, "context_management": null}, "timestamp": "2026-09-24T00:33:31.057Z"},
  {"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}},
  {"type": "stream_event", "event": {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "3"}}},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "9"}}},
  {"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "1"}}},
  {"type": "assistant", "message": {"id": "msg_aee167bec78f9830bf40c49c", "type": "message", "role": "assistant", "model": "qwen3.8:27b-ctx64k", "content": [{"type": "text", "text": "391"}], "usage": {"input_tokens": 1602, "output_tokens": 0}, "context_management": null}, "timestamp": "2026-09-24T00:33:31.388Z"},
  {"type": "stream_event", "event": {"type": "content_block_stop", "index": 1}},
  {"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"input_tokens": 1658, "cache_read_input_tokens": 0, "output_tokens": 43}}},
  {"type": "stream_event", "event": {"type": "message_stop"}},
  {"type": "system", "subtype": "post_turn_summary", "summarizes_uuid": "73d1cde8-ca13-47e7-8330-1e93aae7c88c", "status_category": "review_ready", "status_detail": "391", "needs_action": ""},
  {"duration_api_ms": 11119, "stop_reason": "end_turn", "session_id": "08ead875-6dd8-4da9-b743-71d5983dcd9d", "total_cost_usd": 0.007492, "usage": {"input_tokens": 1658, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 43, "output_tokens_details": {"thinking_tokens": 0}, "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0}, "service_tier": "standard", "cache_creation": {"ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0}, "inference_geo": "", "iterations": [], "speed": "standard"}, "modelUsage": {"qwen3.8:27b-ctx64k": {"inputTokens": 1658, "outputTokens": 43, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0, "webSearchRequests": 0, "costUSD": 0.007492, "contextWindow": 200000, "maxOutputTokens": 32000, "thinkingTokens": 0, "canonicalModel": "qwen3.8:27b-ctx64k", "provider": "firstParty", "costBasis": "unknown"}}, "permission_denials": [], "terminal_reason": "completed", "fast_mode_state": "off", "fast_mode_disabled_reason": "sdk_opt_in_required", "subagent_stats": {"spawned": 0, "requested": {"background": 0, "foreground": 0, "unset": 0}, "started_in_background": 0, "max_depth": 0, "spawned_by_subagents": 0, "completed": 0, "failed": 0, "killed": {"parent": 0, "user": 0, "system": 0}, "refused": {"depth_limit": 0, "concurrency_limit": 0, "budget": 0}, "by_type": {}}, "is_error": false, "num_turns": 1, "subtype": "success", "api_error_status": null, "result": "391", "ttft_ms": 10779, "type": "result", "duration_ms": 11162, "ttft_stream_ms": 6442, "time_to_request_ms": 35, "first_content_frame_ms": 6443, "queued_turn_count": 0, "result_index": 0},
];

/** cot-local/codex-auto.jsonl — `codex exec --oss` (local), verbatim. */
const CODEX_LOCAL_RUN: readonly unknown[] = [
  { type: 'thread.started', thread_id: '01a0d0d6-088c-7282-957a-f6fad627f77e' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'The user is asking for 17×23. 17×23 = 391. Just the number.' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '391' } },
  { type: 'turn.completed', usage: { input_tokens: 11075, cached_input_tokens: 0, output_tokens: 35, reasoning_output_tokens: 0 } },
];

/** rel/proj/out1.txt + this unit's 2.1.257/2.1.280 repro: `claude --resume <missing>` (usage block trimmed). */
const CLAUDE_RESUME_MISSING = {
  type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0,
  stop_reason: null, session_id: 'e3f2192e-c3fa-4be3-982a-ce7605436b70', total_cost_usd: 0,
  usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  modelUsage: {}, permission_denials: [],
  errors: ['No conversation found with session ID: e3f2192e-c3fa-4be3-982a-ce7605436b70'],
};

/** rel/proj/out3.txt (= this unit's repro): the ONLY output of `--session-id <existing>`; claude prints it to stderr. */
const CLAUDE_SESSION_IN_USE = 'Error: Session ID ff73399c-9626-4cb3-97b2-550aa5ae4fdd is already in use.';

/** rel/proj/out5.txt: `codex exec resume <missing>`. */
const CODEX_THREAD_MISSING = 'Error: thread/resume: thread/resume failed: no rollout found for thread id b1382324-3504-49d7-897f-fefc17aeb3b0 (code -32600)';

/** rel/proj/out4.txt: claude 2.1.280 against a dead Ollama — the first three of nine retry frames. */
const CLAUDE_API_RETRIES: readonly unknown[] = [
  { type: 'system', subtype: 'init', session_id: '6065ea5e-b8e1-4e05-87de-417ee50250a4', model: 'qwen3.8:27b-ctx64k' },
  { type: 'system', subtype: 'status', status: 'requesting', session_id: '6065ea5e-b8e1-4e05-87de-417ee50250a4' },
  { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 623, error_status: null, error: 'unknown', session_id: '6065ea5e-b8e1-4e05-87de-417ee50250a4' },
  { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1015, error_status: null, error: 'unknown', session_id: '6065ea5e-b8e1-4e05-87de-417ee50250a4' },
  { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 2039, error_status: null, error: 'unknown', session_id: '6065ea5e-b8e1-4e05-87de-417ee50250a4' },
];

/** grok 0.2.118 with a credential-less GROK_HOME (this unit's repro): init with an EMPTY session id, then the cause in errors[]. */
const GROK_SIGNED_OUT: readonly unknown[] = [
  { type: 'system', subtype: 'init', session_id: '', apiKeySource: 'user', model: 'unknown', cwd: '', permissionMode: 'default', tools: [] },
  {
    type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, duration_api_ms: 0, num_turns: 0, stop_reason: null, total_cost_usd: 0.0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 } },
    modelUsage: {},
    errors: ['Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.'],
    session_id: '',
  },
];

// ---------------------------------------------------------------------------
// claude/local parser — live reasoning
// ---------------------------------------------------------------------------

describe('claude parser — replaying the real local thinking run (cot-local/run1)', () => {
  it('streams every reasoning chunk live and persists the block once, as raw text with its duration', () => {
    const c = clock();
    const events = replay(createAnthropicStreamParser('t', 'claude', { now: c.now }), LOCAL_THINKING_RUN, c.advance, 100);

    const deltas = ofType(events, 'thinking-delta');
    const thinking = ofType(events, 'thinking');
    expect(deltas).toHaveLength(30);
    expect(thinking).toHaveLength(1);
    // The live chunks ARE the persisted block, in order.
    expect(deltas.map((d) => d.text).join('')).toBe('Thinking: 17*23 = 17*20 + 17*3 = 340 + 51 = 391.');
    expect(thinking[0]).toMatchObject({ turnId: 't', text: 'Thinking: 17*23 = 17*20 + 17*3 = 340 + 51 = 391.', kind: 'raw' });
    expect(thinking[0]!.redacted).toBeUndefined();
    // Opened at content_block_start, persisted when the envelope arrived 61 frames later.
    expect(thinking[0]!.durationMs).toBe(61 * 100);
    // Every chunk precedes the persisted block.
    expect(events.indexOf(deltas[deltas.length - 1]!)).toBeLessThan(events.indexOf(thinking[0]!));
  });

  it('coalesces 30 thinking_tokens frames to ≤ 4 Hz and still ends on the true total', () => {
    const c = clock();
    // 100 ms per frame: 30 token frames over ~6 s.
    const events = replay(createAnthropicStreamParser('t', 'claude', { now: c.now }), LOCAL_THINKING_RUN, c.advance, 100);
    const progress = ofType(events, 'thinking-progress');
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.length).toBeLessThan(30);
    expect(progress[progress.length - 1]!.estimatedTokens).toBe(31);
    // Strictly increasing, never repeated.
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]!.estimatedTokens).toBeGreaterThan(progress[i - 1]!.estimatedTokens);
  });

  it('never emits two thinking-progress events inside the rate-limit window (apart from the closing flush)', () => {
    const c = clock();
    const parser = createAnthropicStreamParser('t', 'claude', { now: c.now });
    const at: number[] = [];
    for (let i = 1; i <= 40; i += 1) {
      c.advance(20);
      for (const e of parser.push(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: i * 3 }))) {
        if (e.type === 'thinking-progress') at.push(c.now());
      }
    }
    // 40 frames × 20 ms = 800 ms → at most ceil(800 / 250) + 1 emissions.
    expect(at.length).toBeLessThanOrEqual(Math.ceil(800 / THINKING_PROGRESS_MIN_INTERVAL_MS) + 1);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(THINKING_PROGRESS_MIN_INTERVAL_MS);
  });

  it('derives progress phases and a measured output rate; the persisted sequence is exactly the pre-3.10 one', () => {
    const c = clock();
    const events = replay(createAnthropicStreamParser('t', 'claude', { now: c.now }), LOCAL_THINKING_RUN, c.advance, 100);
    const phases = ofType(events, 'progress').map((p) => p.phase);
    expect(phases).toEqual(['waiting', 'thinking', 'writing', 'writing']);
    const last = ofType(events, 'progress').at(-1)!;
    // message_delta reported 43 output tokens; the rate is measured from the
    // call's first content block to that frame (100 ms per replayed frame).
    const wireType = (l: unknown): unknown => (l as { event?: { type?: unknown } }).event?.type;
    const firstBlock = LOCAL_THINKING_RUN.findIndex((l) => wireType(l) === 'content_block_start');
    const callEnd = LOCAL_THINKING_RUN.findIndex((l) => wireType(l) === 'message_delta');
    const seconds = ((callEnd - firstBlock) * 100) / 1000;
    expect(last.outTokens).toBe(43);
    expect(last.tokPerSec).toBe(Math.round((43 / seconds) * 10) / 10);
    expect(last.elapsedMs).toBeGreaterThan(0);
    expect(persisted(events).map((e) => e.type)).toEqual(['thinking', 'text-delta', 'text-delta', 'text-delta', 'assistant-message', 'usage']);
    expect(ofType(events, 'text-delta').map((d) => d.text).join('')).toBe('391');
    // The research run did not set CLAUDE_CODE_MAX_CONTEXT_TOKENS, so the CLI reported its 200k default.
    expect(ofType(events, 'usage')[0]!.usage).toMatchObject({ inputTokens: 1658, outputTokens: 43, contextWindow: 200_000 });
  });

  it('finish() flushes blocks but emits no transient events after the process is gone', () => {
    const c = clock();
    const parser = createAnthropicStreamParser('t', 'claude', { now: c.now });
    parser.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } }));
    parser.push(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 }));
    c.advance(10);
    parser.push(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 9 }));
    parser.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'half a thought' } } }));
    c.advance(1_500);
    const tail = parser.finish(null);
    expect(tail.map((e) => e.type)).toEqual(['thinking']);
    expect(tail[0]).toMatchObject({ text: 'half a thought', durationMs: 1_510 });
  });
});

describe('claude parser — Claude models (summaries, omitted display, redacted blocks)', () => {
  const init = { type: 'system', subtype: 'init', session_id: UUID, model: 'claude-opus-5-5' };

  it('text from a Claude model is a vendor SUMMARY', () => {
    const events = replay(createAnthropicStreamParser('t'), [
      init,
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'Plan: read the file first.', signature: 'sig-1' }] } },
    ]);
    expect(ofType(events, 'thinking')).toEqual([{ type: 'thinking', turnId: 't', text: 'Plan: read the file first.', kind: 'summary' }]);
  });

  it('a signature-only block (the API default `omitted`) is kept as ONE redacted marker, not dropped', () => {
    const c = clock();
    const sig = 'EqQBCkgIBxABGAIqQO9';
    const events = replay(createAnthropicStreamParser('t', 'claude', { now: c.now }), [
      init,
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 0 } } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 400, estimated_tokens_delta: 400 },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } } },
      // The envelope repeats the block (before content_block_stop, as 2.1.280 orders it).
      { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: sig }], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'message_stop' } },
    ], c.advance, 1_000);
    const thinking = ofType(events, 'thinking');
    expect(thinking).toEqual([{ type: 'thinking', turnId: 't', text: '', redacted: true, durationMs: 3_000 }]);
    // No text → no kind (unknown), and no streamed chunks.
    expect(ofType(events, 'thinking-delta')).toEqual([]);
    expect(ofType(events, 'thinking-progress').map((p) => p.estimatedTokens)).toEqual([400]);
  });

  it('`redacted_thinking` blocks become redacted markers too, deduplicated by their data', () => {
    const events = replay(createAnthropicStreamParser('t'), [
      init,
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque-1' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'redacted_thinking', data: 'opaque-1' }] } },
    ]);
    expect(ofType(events, 'thinking')).toEqual([expect.objectContaining({ text: '', redacted: true })]);
  });

  it('a grok parser leaves `kind` unknown rather than guessing raw vs summary', () => {
    const events = replay(createAnthropicStreamParser('g', 'grok'), [
      { type: 'message_start', message: { id: 'g1', model: 'grok-4.7' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user wants ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a fix.' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    expect(ofType(events, 'thinking-delta').map((d) => d.text)).toEqual(['The user wants ', 'a fix.']);
    const [thinking] = ofType(events, 'thinking');
    expect(thinking).toMatchObject({ text: 'The user wants a fix.' });
    expect(thinking!.kind).toBeUndefined();
  });
});

describe('claude parser — progress around tools', () => {
  it('tool start → phase tool (named), tool result → waiting, next call → thinking/writing', () => {
    const events = replay(createAnthropicStreamParser('t'), [
      { type: 'system', subtype: 'init', session_id: UUID, model: 'claude-opus-5-5' },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Tests pass.' } } },
    ]);
    const progress = ofType(events, 'progress');
    expect(progress.map((p) => [p.phase, p.tool ?? null])).toEqual([['tool', 'Bash'], ['waiting', null], ['writing', null]]);
    // text-delta is PERSISTED (only the four V3.10 types are transient).
    expect(persisted(events).map((e) => e.type)).toEqual(['tool-use', 'tool-result', 'text-delta', 'assistant-message']);
    expect(ofType(events, 'tool-use')[0]).toMatchObject({ name: 'Bash', input: { command: 'npm test' } });
  });

  it('unmeasured figures stay absent (no char-count estimates)', () => {
    const events = replay(createAnthropicStreamParser('t'), [
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a long answer '.repeat(50) } } },
    ]);
    const [p] = ofType(events, 'progress');
    expect(p).toMatchObject({ phase: 'writing' });
    expect(p!.outTokens).toBeUndefined();
    expect(p!.tokPerSec).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Errors and plumbing notices
// ---------------------------------------------------------------------------

describe('errors carry the real cause and a code', () => {
  it('classifies the captured vendor sentences (and nothing else)', () => {
    expect(classifyVerseCliError(CLAUDE_RESUME_MISSING.errors[0])).toBe('native-thread-missing');
    expect(classifyVerseCliError(CLAUDE_SESSION_IN_USE)).toBe('session-in-use');
    expect(classifyVerseCliError(CODEX_THREAD_MISSING)).toBe('native-thread-missing');
    expect(classifyVerseCliError('No session found with id 1b5023d7-df09-4788-8c04-ae7af7cc2973.')).toBe('native-thread-missing');
    expect(classifyVerseCliError('errors if that ID already has a session: session abc already exists')).toBe('session-in-use');
    for (const benign of ['', 'model overloaded', 'Not signed in.', 'process exited with code 1', null, 42]) {
      expect(classifyVerseCliError(benign)).toBeNull();
    }
    // Every code the classifier returns is a contract code.
    expect(VERSE_ERROR_CODES).toEqual(expect.arrayContaining(['native-thread-missing', 'session-in-use']));
  });

  it('claude --resume <missing>: the error says "No conversation found" (not error_during_execution) and is coded', () => {
    const events = replay(adapterFor('claude').createParser('t'), [CLAUDE_RESUME_MISSING], undefined, 0, 1);
    const [error] = ofType(events, 'error');
    expect(error).toEqual({
      type: 'error',
      turnId: 't',
      message: 'claude: No conversation found with session ID: e3f2192e-c3fa-4be3-982a-ce7605436b70',
      code: 'native-thread-missing',
    });
  });

  it('a session-in-use line that reaches stdout becomes one coded error; other plain lines stay dropped', () => {
    const parser = adapterFor('claude').createParser('t');
    expect(parser.push('Warning: no stdin data received in 3s, proceeding without it.')).toEqual([]);
    expect(parser.push('[claude-code:unrecognized_model] {"model":"qwen3.8:27b-ctx64k"}')).toEqual([]);
    expect(parser.push(CLAUDE_SESSION_IN_USE)).toEqual([{
      type: 'error', turnId: 't', message: 'claude: Session ID ff73399c-9626-4cb3-97b2-550aa5ae4fdd is already in use.', code: 'session-in-use',
    }]);
    expect(parser.push(CLAUDE_SESSION_IN_USE)).toEqual([]);
  });

  it('grok signed out: the errors[] sentence is the message, no invented code, no empty native id', () => {
    const parser = adapterFor('grok').createParser('g');
    const events = replay(parser, GROK_SIGNED_OUT, undefined, 0, 1);
    const [error] = ofType(events, 'error');
    expect(error!.message.startsWith('grok: Not signed in.')).toBe(true);
    expect(error!.code).toBeUndefined();
    expect(parser.nativeSessionId()).toBeNull();
  });

  it('secrets in vendor error text are scrubbed before they are persisted', () => {
    const events = replay(createAnthropicStreamParser('t'), [
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['auth failed for key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'] },
    ]);
    const [error] = ofType(events, 'error');
    expect(error!.message).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(error!.message).toContain('[REDACTED]');
  });

  it('bounds errors[]: at most five entries, each capped', () => {
    const events = replay(createAnthropicStreamParser('t'), [
      { type: 'result', subtype: 'error_during_execution', errors: ['a'.repeat(5_000), 'b', 'c', 'd', 'e', 'f', 42, ''] },
    ]);
    const [error] = ofType(events, 'error');
    expect(error!.message.length).toBeLessThan(1_200);
    expect(error!.message).toContain('; b; c; d; e');
    expect(error!.message).not.toContain('; f');
  });

  it('codex: a vanished thread on turn.failed or a plain line is coded', () => {
    const failed = replay(createCodexParser('c'), [{ type: 'turn.failed', error: { message: 'thread/resume failed: no rollout found for thread id x' } }]);
    expect(ofType(failed, 'error')[0]).toMatchObject({ code: 'native-thread-missing' });
    const plain = createCodexParser('c2');
    expect(plain.push(CODEX_THREAD_MISSING)).toEqual([{
      type: 'error', turnId: 'c2', code: 'native-thread-missing',
      message: 'codex: thread/resume: thread/resume failed: no rollout found for thread id b1382324-3504-49d7-897f-fefc17aeb3b0 (code -32600)',
    }]);
    expect(plain.push('Reading prompt from stdin...')).toEqual([]);
  });
});

describe('api_retry → status (a dead endpoint is no longer a silent spinner)', () => {
  it('replays the captured retry frames as transient retry notices', () => {
    const events = replay(createAnthropicStreamParser('t'), CLAUDE_API_RETRIES, undefined, 0, null);
    expect(ofType(events, 'status')).toEqual([
      { type: 'status', turnId: 't', kind: 'retry', message: 'Model API request failed (unknown error) — retry 1 of 10 in 0.6s' },
      { type: 'status', turnId: 't', kind: 'retry', message: 'Model API request failed (unknown error) — retry 2 of 10 in 1.0s' },
      { type: 'status', turnId: 't', kind: 'retry', message: 'Model API request failed (unknown error) — retry 3 of 10 in 2.0s' },
    ]);
    // Nothing about the retries is persisted.
    expect(persisted(events)).toEqual([]);
    expect(ofType(events, 'progress').map((p) => p.phase)).toEqual(['waiting']);
  });

  it('names the HTTP status when there is one, and never echoes a free-form error string', () => {
    const [status529] = ofType(replay(createAnthropicStreamParser('t'), [
      { type: 'system', subtype: 'api_retry', attempt: 4, max_retries: 10, retry_delay_ms: 8600, error_status: 529, error: 'overloaded_error' },
    ]), 'status');
    expect(status529!.message).toBe('Model API request failed (HTTP 529) — retry 4 of 10 in 8.6s');
    const [odd] = ofType(replay(createAnthropicStreamParser('t'), [
      { type: 'system', subtype: 'api_retry', error: 'Bearer abc.def <script>' },
    ]), 'status');
    expect(odd!.message).toBe('Model API request failed (unknown error) — retrying');
  });
});

// ---------------------------------------------------------------------------
// codex parser — reasoning
// ---------------------------------------------------------------------------

describe('codex parser — reasoning items', () => {
  it('replays the real local codex run: reasoning becomes thinking (summary), then the answer', () => {
    const events = replay(createCodexParser('c'), CODEX_LOCAL_RUN);
    expect(persisted(events)).toEqual([
      { type: 'thinking', turnId: 'c', text: 'The user is asking for 17×23. 17×23 = 391. Just the number.', kind: 'summary' },
      { type: 'assistant-message', turnId: 'c', text: '391' },
    ]);
    expect(ofType(events, 'progress').map((p) => p.phase)).toEqual(['waiting']);
  });

  it('measures a reasoning item from item.started to item.completed; an empty one is a redacted marker', () => {
    const c = clock();
    const parser = createCodexParser('c', { now: c.now });
    const events = replay(parser, [
      { type: 'item.started', item: { id: 'r1', type: 'reasoning', text: '' } },
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: '**Planning**\n\nRead a.ts, then patch.' } },
      { type: 'item.started', item: { id: 'r2', type: 'reasoning', text: '' } },
      { type: 'item.completed', item: { id: 'r2', type: 'reasoning', text: '' } },
      { type: 'item.completed', item: { id: 'r2', type: 'reasoning', text: '' } },
      { type: 'item.started', item: { id: 'x1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'x1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 } },
    ], c.advance, 500);
    expect(ofType(events, 'thinking')).toEqual([
      { type: 'thinking', turnId: 'c', text: '**Planning**\n\nRead a.ts, then patch.', kind: 'summary', durationMs: 500 },
      { type: 'thinking', turnId: 'c', text: '', redacted: true, durationMs: 500 },
    ]);
    expect(ofType(events, 'progress').map((p) => [p.phase, p.tool ?? null])).toEqual([
      ['thinking', null], ['tool', 'command_execution'], ['waiting', null],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Launch — thinking display, codex/grok flags
// ---------------------------------------------------------------------------

describe('claude launch — --thinking-display summarized', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'verse-a4-profiles-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function claudeProfile(executable: string | null): string[] {
    const p = makeProfile(root, 'claude-a', { provider: 'claude', ...(executable ? { executable } : {}) });
    return ['/usr/local/bin/node', p.launcher];
  }

  it('on for a claude seat pinned to a verified build, placed among the options (before `--`)', () => {
    for (const version of ['2.1.243', '2.1.257', '2.1.280', '2.2.0']) {
      const l = launch({ launcher: claudeProfile(`/Users/u/.local/share/claude/versions/${version}`) });
      const argv = adapterFor('claude').buildLaunch(session(), '- a bullet', l).argv;
      const i = argv.indexOf('--thinking-display');
      expect(i).toBeGreaterThan(0);
      expect(argv[i + 1]).toBe('summarized');
      expect(i).toBeLessThan(argv.indexOf('--'));
    }
  });

  it('off for an older or unknown build — an unknown option would fail every turn', () => {
    expect(claudeThinkingDisplayArgs(session(), launch({ launcher: claudeProfile('/Users/u/.local/share/claude/versions/2.1.200') }))).toEqual([]);
    expect(claudeThinkingDisplayArgs(session(), launch({ launcher: claudeProfile('/opt/claude/bin/claude') }))).toEqual([]);
    expect(claudeThinkingDisplayArgs(session(), launch({ launcher: claudeProfile(null) }))).toEqual([]);
    // No profile at all, no snapshot version: unknown.
    expect(claudeThinkingDisplayArgs(session(), launch({ launcher: null }))).toEqual([]);
    expect(CLAUDE_THINKING_DISPLAY_MIN_CLI).toBe('2.1.243');
  });

  it('falls back to the launch snapshot\'s pinned version when the profile names no binary', () => {
    const l = launch({ launcher: claudeProfile(null), seat: { ...CLAUDE_SEAT, cliVersion: '2.1.280' } });
    expect(claudeThinkingDisplayArgs(session(), l)).toEqual(['--thinking-display', 'summarized']);
  });

  it('never on a local seat, and off when the engine passes thinkingDisplay:false for the turn', () => {
    const pinned = claudeProfile('/Users/u/.local/share/claude/versions/2.1.280');
    expect(claudeThinkingDisplayArgs(session({ engine: 'local' }), launch({ launcher: pinned }))).toEqual([]);
    const local = adapterFor('local').buildLaunch(session({ engine: 'local', model: 'qwen3.8:27b-ctx64k' }), 'hi', launch());
    expect(local.argv).not.toContain('--thinking-display');
    expect(claudeThinkingDisplayArgs(session(), launch({ launcher: pinned, thinkingDisplay: false }))).toEqual([]);
    expect(claudeThinkingDisplayArgs(session(), launch({ launcher: pinned, thinkingDisplay: true }))).toEqual(['--thinking-display', 'summarized']);
  });

  it('the preference defaults to ON when nothing says otherwise (absent = on)', () => {
    expect(thinkingDisplayEnabled(launch())).toBe(true);
  });

  it('a profile whose manifest names another provider is ignored', () => {
    const p = makeProfile(root, 'odd', { provider: 'codex', executable: '/Users/u/.local/share/claude/versions/2.1.280' });
    expect(readNativeProfileFacts(['/usr/local/bin/node', p.launcher], 'claude')).toBeNull();
    expect(claudeThinkingDisplayArgs(session(), launch({ launcher: ['/usr/local/bin/node', p.launcher] }))).toEqual([]);
  });
});

describe('codex launch — reasoning summary, git-repo skip, engine override', () => {
  const codexSession = (over: Partial<VerseSession> = {}): VerseSession => session({ engine: 'codex', model: 'gpt-5.5', nativeSessionId: null, ...over });

  it('drops the reasoning override (and only it) when live reasoning is off', () => {
    const on = adapterFor('codex').buildLaunch(codexSession(), 'x', launch({ launcher: ['/x/launcher.mjs'] })).argv;
    const off = adapterFor('codex').buildLaunch(codexSession(), 'x', launch({ launcher: ['/x/launcher.mjs'], thinkingDisplay: false })).argv;
    expect(on).toContain('model_reasoning_summary="detailed"');
    expect(off).not.toContain('model_reasoning_summary="detailed"');
    expect(off).toContain('--skip-git-repo-check');
    expect(on.filter((a) => !['-c', 'model_reasoning_summary="detailed"'].includes(a))).toEqual(off);
  });

  it('nativeSession:"new" starts a fresh thread; "resume" is honoured only with a thread id', () => {
    const threaded = codexSession({ nativeSessionId: '019a0000-0000-7000-8000-000000000001', turnCount: 4 });
    expect(adapterFor('codex').buildLaunch(threaded, 'x', launch()).argv).toContain('resume');
    expect(adapterFor('codex').buildLaunch(threaded, 'x', launch({ nativeSession: 'new' })).argv).not.toContain('resume');
    expect(codexResumes(codexSession({ turnCount: 3 }), launch({ nativeSession: 'resume' }))).toBe(false);
    expect(codexResumes({ nativeSessionId: 'thr', turnCount: 0 }, launch({ nativeSession: 'resume' }))).toBe(true);
  });
});

describe('grok launch — --no-auto-update on every turn', () => {
  it('first and resumed turns both carry it, before the prompt', () => {
    const grok = (over: Partial<VerseSession>): VerseSession => session({ engine: 'grok', model: 'grok-4.7', ...over });
    for (const s of [grok({}), grok({ turnCount: 5 })]) {
      const argv = adapterFor('grok').buildLaunch(s, 'hi', launch({ launcher: ['/usr/local/bin/node', '/g/launcher.mjs'] })).argv;
      expect(argv.filter((a) => a === '--no-auto-update')).toHaveLength(1);
      expect(argv.indexOf('--no-auto-update')).toBeLessThan(argv.indexOf('--single=hi'));
    }
  });
});

// ---------------------------------------------------------------------------
// --session-id vs --resume from the transcript on disk (the turn-1 Stop fix)
// ---------------------------------------------------------------------------

describe('native session choice', () => {
  let root = '';
  let project = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'verse-a4-native-'));
    project = join(root, 'work', 'my.project');
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function plantClaudeTranscript(state: string, cwd: string, id = UUID): void {
    const dir = join(state, 'projects', claudeProjectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), '{"type":"summary"}\n');
  }

  const spent = { inputTokens: 1_200, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 1_240, contextWindow: 200_000 };

  it('slug: claude\'s own rule, including the hashed form for long paths (verified against 2.1.280 on disk)', () => {
    expect(claudeProjectSlug('/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub')).toBe('-Users-masonwyatt-Desktop-github-dev-tools-ashlr-hub');
    expect(claudeProjectSlug('/private/tmp/claude-501/x_y.z')).toBe('-private-tmp-claude-501-x-y-z');
    // A real 2.1.280 run in this >200-char cwd created exactly this directory.
    const long = '/private/tmp/claude-501/-Users-masonwyatt-Desktop-github-dev-tools-ashlr-hub/f387891f-3962-43eb-90fc-2c5b22fac1e5/scratchpad/a4-slug/'
      + `${'a'.repeat(108)}/${'b'.repeat(82)}.ccc`;
    expect(claudeProjectSlug(long)).toBe('-private-tmp-claude-501--Users-masonwyatt-Desktop-github-dev-tools-ashlr-hub-f387891f-3962-43eb-90fc-2c5b22fac1e5-scratchpad-a4-slug-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-eymrt7');
  });

  it('THE FIX: a turn stopped before its first parsed event (turnCount 0) resumes the transcript the CLI already wrote', () => {
    const p = makeProfile(root, 'claude-a', { provider: 'claude' });
    plantClaudeTranscript(p.state, project);
    const argv = adapterFor('claude').buildLaunch(session({ projectPath: project, turnCount: 0 }), 'again', launch({ launcher: ['/usr/local/bin/node', p.launcher] })).argv;
    expect(sessionFlag(argv)).toBe('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe(UUID);
  });

  it('a first turn with no transcript mints the conversation', () => {
    const p = makeProfile(root, 'claude-a', { provider: 'claude' });
    const argv = adapterFor('claude').buildLaunch(session({ projectPath: project }), 'hi', launch({ launcher: ['/usr/local/bin/node', p.launcher] })).argv;
    expect(sessionFlag(argv)).toBe('--session-id');
  });

  it('a turn 1 that died before init (no transcript, nothing ever exchanged) mints again even though turnCount advanced', () => {
    const p = makeProfile(root, 'claude-a', { provider: 'claude' });
    const argv = adapterFor('claude').buildLaunch(session({ projectPath: project, turnCount: 1 }), 'hi', launch({ launcher: ['/usr/local/bin/node', p.launcher] })).argv;
    expect(sessionFlag(argv)).toBe('--session-id');
  });

  it('a transcript that vanished after real exchanges is RESUMED on purpose, so the loss surfaces as native-thread-missing', () => {
    const p = makeProfile(root, 'claude-a', { provider: 'claude' });
    const argv = adapterFor('claude').buildLaunch(session({ projectPath: project, turnCount: 3, usage: spent }), 'hi', launch({ launcher: ['/usr/local/bin/node', p.launcher] })).argv;
    expect(sessionFlag(argv)).toBe('--resume');
  });

  it('the engine\'s explicit override wins (recovery mints; an in-use retry resumes)', () => {
    const p = makeProfile(root, 'claude-a', { provider: 'claude' });
    plantClaudeTranscript(p.state, project);
    const l = (nativeSession: 'new' | 'resume'): VerseSeatLaunch => launch({ launcher: ['/usr/local/bin/node', p.launcher], nativeSession });
    expect(sessionFlag(adapterFor('claude').buildLaunch(session({ projectPath: project, usage: spent }), 'x', l('new')).argv)).toBe('--session-id');
    const fresh = session({ projectPath: join(root, 'elsewhere') });
    expect(sessionFlag(adapterFor('claude').buildLaunch(fresh, 'x', l('resume')).argv)).toBe('--resume');
  });

  it('finds the transcript under the PHYSICAL cwd (claude records `/private/tmp`, Verse may hold `/tmp`)', () => {
    const p = makeProfile(root, 'claude-a', { provider: 'claude' });
    const link = join(root, 'link-to-project');
    symlinkSync(project, link);
    // claude keys the transcript by the PHYSICAL cwd (getcwd), e.g. /private/var/… for /var/….
    plantClaudeTranscript(p.state, realpathSync.native(project));
    expect(claudeConversationState(p.state, link, UUID)).toBe('present');
    expect(claudeConversationState(p.state, link, '0f0f0f0f-0000-4000-8000-000000000000')).toBe('absent');
  });

  it('honours the manifest\'s nativeStatePath over the launcher\'s sibling directory', () => {
    const p = makeProfile(root, 'claude-a', null);
    const elsewhere = join(root, 'pinned-home');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(root, 'native-profiles', 'claude-a', 'profile.json'), JSON.stringify({ provider: 'claude', nativeStatePath: elsewhere }));
    plantClaudeTranscript(elsewhere, project);
    const argv = adapterFor('claude').buildLaunch(session({ projectPath: project }), 'x', launch({ launcher: ['/usr/local/bin/node', p.launcher] })).argv;
    expect(sessionFlag(argv)).toBe('--resume');
  });

  it('unknown home (profile not on this machine) keeps the pre-3.10 turn-count rule', () => {
    const l = launch({ launcher: ['/usr/local/bin/node', '/nowhere/native-profiles/claude-a/launcher.mjs'] });
    expect(sessionFlag(adapterFor('claude').buildLaunch(session({ projectPath: project }), 'x', l).argv)).toBe('--session-id');
    expect(sessionFlag(adapterFor('claude').buildLaunch(session({ projectPath: project, turnCount: 2 }), 'x', l).argv)).toBe('--resume');
  });

  it('local seats look in $HOME/.claude (the engine passes HOME and no CLAUDE_CONFIG_DIR)', () => {
    const localSession = session({ engine: 'local', model: 'qwen3.8:27b-ctx64k', projectPath: project });
    expect(sessionFlag(adapterFor('local').buildLaunch(localSession, 'x', launch()).argv)).toBe('--session-id');
    plantClaudeTranscript(join(tmpHome, '.claude'), project);
    expect(sessionFlag(adapterFor('local').buildLaunch(localSession, 'x', launch()).argv)).toBe('--resume');
  });

  it('refuses a non-UUID id as a file name component (state unknown, never a path probe)', () => {
    const p = makeProfile(root, 'claude-a', { provider: 'claude' });
    expect(claudeConversationState(p.state, project, '../../etc/passwd')).toBe('unknown');
    expect(grokConversationState(p.state, project, '../x')).toBe('unknown');
  });

  it('grok: <GROK_HOME>/sessions/<encoded cwd>/<id>/ decides the same way', () => {
    const p = makeProfile(root, 'grok-a', { provider: 'grok' });
    const grok = session({ engine: 'grok', model: 'grok-4.7', projectPath: project });
    const l = launch({ launcher: ['/usr/local/bin/node', p.launcher] });
    expect(sessionFlag(adapterFor('grok').buildLaunch(grok, 'x', l).argv)).toBe('--session-id');
    mkdirSync(join(p.state, 'sessions', encodeURIComponent(project), UUID), { recursive: true });
    expect(sessionFlag(adapterFor('grok').buildLaunch(grok, 'x', l).argv)).toBe('--resume');
  });

  it('chooseNativeSession truth table', () => {
    const fresh = session();
    const used = session({ turnCount: 2, usage: spent });
    expect(chooseNativeSession(fresh, 'present', null)).toBe('resume');
    expect(chooseNativeSession(fresh, 'absent', null)).toBe('new');
    expect(chooseNativeSession(used, 'absent', null)).toBe('resume');
    expect(chooseNativeSession(session({ turnCount: 2 }), 'absent', null)).toBe('new');
    expect(chooseNativeSession(fresh, 'unknown', null)).toBe('new');
    expect(chooseNativeSession(session({ turnCount: 1 }), 'unknown', null)).toBe('resume');
    expect(chooseNativeSession(used, 'present', 'new')).toBe('new');
    expect(chooseNativeSession(fresh, 'absent', 'resume')).toBe('resume');
    // The engine's recovery convention: a fresh id with turnCount 0 mints,
    // even though the session's totals still hold the old conversation's tokens.
    expect(chooseNativeSession(session({ turnCount: 0, usage: spent }), 'absent', null)).toBe('new');
  });

  it('engine recovery (fresh native id, turnCount 0, old totals kept) launches --session-id with the NEW id', () => {
    const p = makeProfile(root, 'claude-a', { provider: 'claude' });
    plantClaudeTranscript(p.state, project); // the OLD id's transcript is still there
    const freshId = '5d1e9c2a-7b3f-4e8a-9c0d-1f2e3a4b5c6d';
    const recovery = session({ projectPath: project, nativeSessionId: freshId, turnCount: 0, usage: spent });
    const argv = adapterFor('claude').buildLaunch(recovery, 'handoff note + text', launch({ launcher: ['/usr/local/bin/node', p.launcher] })).argv;
    expect(sessionFlag(argv)).toBe('--session-id');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(freshId);
  });
});
