/**
 * Claude adapter (engine=claude and engine=local).
 *
 * Launch: one `claude -p --output-format stream-json --verbose
 * --include-partial-messages ... -- <text>` process per turn (`-p` is
 * boolean; the prompt is positional and goes last, behind `--`). The first turn
 * mints the conversation with `--session-id <uuid>`; once the CLI holds a
 * transcript for it, turns `--resume <uuid>` (V3.10 rule below).
 * For engine=local the plain `claude` binary is pointed via ANTHROPIC_BASE_URL
 * at whichever local Anthropic-compatible endpoint the seat's launch record
 * names: Ollama's by default, or — when the operator opted into the
 * llama-server lane — the normalising proxy in front of llama-server. The
 * adapter does not choose; it forwards the choice `seats.ts` already made.
 *
 * V3.9 context flags (docs/VERSE-CONTEXT.md). Every flag and env var below was
 * checked on BOTH binaries a seat can be pinned to — `claude --help` on
 * 2.1.257 and 2.1.280 lists `--autocompact <auto|tokens>`,
 * `--append-system-prompt <prompt>`, `--add-dir <directories...>` and
 * `--exclude-dynamic-system-prompt-sections`, and both binaries' strings
 * contain `CLAUDE_CODE_MAX_CONTEXT_TOKENS`:
 *
 *  - claude seats, 1M-native models: `--autocompact 400000` in standard mode,
 *    `--autocompact auto` in expansive (context-math `claudeAutocompactFlag`).
 *    200k models get no flag — they already compact near 167k natively.
 *  - local seats: `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<the session's window>` so
 *    the CLI compacts before Ollama truncates (without it the CLI assumes its
 *    200k unknown-model default and never compacts a 64k runner), plus
 *    `--exclude-dynamic-system-prompt-sections` so the per-launch git status
 *    and env block stop invalidating the local runner's prefix cache.
 *  - shared project memory (launch.memory): `--add-dir <dir>` when writable and
 *    `--append-system-prompt=<block>`, the SAME snapshotted block every turn so
 *    the prompt prefix stays byte-identical.
 *
 * Parse: claude's stream-json is JSONL where streaming deltas are wrapped as
 * `{type:'stream_event', event:{...Anthropic Messages wire event}}` and whole
 * messages arrive as `{type:'assistant'|'user', message:{content:[...]}}`,
 * followed by `{type:'result', ...}`. The wire-format machinery is shared with
 * the grok adapter, which emits the same events without the wrapper.
 *
 * V3.10 live reasoning + errors (docs: SPEC-310A §3 A4):
 *  - `--thinking-display summarized` on CLAUDE seats (never local) while the
 *    `thinkingDisplay` preference is on and the pinned binary is new enough
 *    (`claudeThinkingDisplayArgs`). Without it the CLI leaves the display to
 *    the API default, `omitted`, and 98% of Claude thinking blocks arrive as
 *    a bare signature.
 *  - the parser streams `thinking_delta` as transient `thinking-delta`,
 *    rate-limits `system/thinking_tokens` into `thinking-progress` (≤ 4 Hz),
 *    derives `progress` from block/tool transitions, turns `system/api_retry`
 *    into a `status` notice, records a signature-only block as
 *    `thinking {redacted:true}` instead of dropping it, and stamps `thinking`
 *    with `durationMs` and `kind`.
 *  - a failed `result` reports its `errors[]` text (it used to say only
 *    `error_during_execution`) plus a machine `code` (`classifyVerseCliError`).
 *  - `--session-id` vs `--resume` is chosen from the native transcript on disk
 *    (`chooseNativeSession`), not from `turnCount`: a turn stopped before
 *    its first parsed event left a transcript behind, and `--session-id` on it
 *    fails forever with "Session ID … is already in use".
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';

import { scrubSecrets } from '../../util/scrub.js';
import {
  canonicalModelId,
  claudeAutocompactFlag,
  hasExpansiveMode,
} from '../context-math.js';
import { cliVersionFromExecutable, compareCliVersions, legacyModelOptionFallback } from '../model-windows.js';
import { loadVersePreferences } from '../preferences.js';
import {
  VERSE_DEFAULT_CONTEXT_WINDOWS,
  verseSessionRoots,
  type VerseErrorCode,
  type VerseModelOption,
  type VerseProgressPhase,
  type VerseSession,
  type VerseThinkingKind,
  type VerseTurnLaunch,
  type VerseUsage,
} from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import { claudeEffortArgs, claudePermissionArgs } from '../session-controls.js';
import type { VerseAdapter, VerseParsedEvent, VerseTurnParser } from './index.js';
import { turnAttachmentDirs } from './turn-extras.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** Parse one JSONL line into an object, or null for anything that is not one. */
export function parseJsonObjectLine(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error classification (V3.10)
// ---------------------------------------------------------------------------

/**
 * The vendor sentences that mean "the conversation Verse asked to resume does
 * not exist" and "the id Verse asked to CREATE is taken". Every pattern is a
 * string captured from a real binary, not recalled:
 *
 *  - claude 2.1.257 + 2.1.280, `--resume <missing>`: stdout `result` with
 *    `errors:["No conversation found with session ID: <uuid>"]`, exit 1
 *    (reproduced 2026-09-23 against a scratch CLAUDE_CONFIG_DIR + Ollama).
 *  - claude 2.1.257 + 2.1.280, `--session-id <existing>`: STDERR ONLY
 *    `Error: Session ID <uuid> is already in use.`, exit 1, nothing on stdout.
 *  - codex 0.155 `exec resume <missing>`: `Error: thread/resume: thread/resume
 *    failed: no rollout found for thread id <uuid> (code -32600)`.
 *  - grok 0.2.118 binary string `No session found with id …`; its docs say
 *    `--session-id` "errors if … already in use under the target session
 *    directory" (the exact sentence is behind sign-in, so the pattern is the
 *    documented phrase).
 */
const NATIVE_THREAD_MISSING_RES: readonly RegExp[] = [
  /no conversation found with session id/i,
  /no rollout found for thread id/i,
  /thread\/resume failed/i,
  /no session found with id/i,
];

const SESSION_IN_USE_RES: readonly RegExp[] = [
  /session id \S+ is already in use/i,
  /session .{0,80}already (?:in use|exists)/i,
];

/**
 * A stable `error.code` for CLI text Verse acts on (VERSE_ERROR_CODES), or
 * null. Exported for the engine, which sees the stderr-only failures (claude's
 * "already in use" never reaches stdout) that no parser can.
 */
export function classifyVerseCliError(text: unknown): VerseErrorCode | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const sample = text.length > 8_192 ? text.slice(0, 8_192) : text;
  if (NATIVE_THREAD_MISSING_RES.some((re) => re.test(sample))) return 'native-thread-missing';
  if (SESSION_IN_USE_RES.some((re) => re.test(sample))) return 'session-in-use';
  return null;
}

/** Bounds on the vendor error text an `error` event carries. */
const MAX_ERROR_ENTRIES = 5;
const MAX_ERROR_ENTRY_CHARS = 1_000;

/**
 * `result.errors[]` → one line of text, or '' when absent. The CLI puts the
 * REAL cause here ("No conversation found …", "Not signed in …") while
 * `subtype` only says `error_during_execution`.
 */
function resultErrorsText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_ERROR_ENTRIES)
    .map((entry) => (entry.length > MAX_ERROR_ENTRY_CHARS ? `${entry.slice(0, MAX_ERROR_ENTRY_CHARS)}…` : entry))
    .join('; ');
}

/**
 * An `error` event from untrusted CLI text: secrets scrubbed (the text is
 * persisted and served), plus a code when the sentence is one Verse acts on.
 */
export function cliErrorEvent(turnId: string, engineLabel: string, detail: string): Extract<VerseParsedEvent, { type: 'error' }> {
  const code = classifyVerseCliError(detail);
  const message = scrubSecrets(`${engineLabel}: ${detail}`);
  return code ? { type: 'error', turnId, message, code } : { type: 'error', turnId, message };
}

/** Anthropic-style usage block → partial VerseUsage (fields missing → 0). */
function readAnthropicUsage(usage: unknown): AnthropicUsage | null {
  if (!isObject(usage)) return null;
  const hasAny = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .some((k) => typeof usage[k] === 'number');
  if (!hasAny) return null;
  return {
    input: num(usage['input_tokens']),
    output: num(usage['output_tokens']),
    cacheRead: num(usage['cache_read_input_tokens']),
    cacheCreation: num(usage['cache_creation_input_tokens']),
  };
}

interface AnthropicUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const ZERO_USAGE: AnthropicUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function addUsage(a: AnthropicUsage, b: AnthropicUsage): AnthropicUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

/**
 * Two readings of the SAME API call. Every bucket is either fixed for the call
 * (the prompt side, known at `message_start`) or cumulative within it (output,
 * which `message_delta` and each `assistant` envelope re-report as it grows),
 * so the per-bucket maximum is the call's final figure however many times and
 * in whatever order it was reported.
 */
function maxUsage(a: AnthropicUsage, b: AnthropicUsage): AnthropicUsage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheCreation: Math.max(a.cacheCreation, b.cacheCreation),
  };
}

function isZeroUsage(u: AnthropicUsage): boolean {
  return u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheCreation === 0;
}

function toVerseUsage(totals: AnthropicUsage, contextTokens: number, contextWindow: number | null): VerseUsage {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheCreationTokens: totals.cacheCreation,
    // Live context occupancy = prompt size of the most recent API call. NOT
    // clamped to the window: a reading above it is information.
    contextTokens,
    // The CLI's own figure for THIS turn (result.modelUsage), else null. The
    // engine decides whether it wins (it ignores it on engine=local, where
    // Verse set the window itself through CLAUDE_CODE_MAX_CONTEXT_TOKENS).
    contextWindow,
  };
}

/** `claude-opus-4-8[1m]` → `claude-opus-4-8`: the suffix is a request for the 1M window, not a different model. */
function stripOneMillionSuffix(id: string): string {
  return id.replace(/\[1m\]$/i, '');
}

/**
 * The context window the CLI reported for this turn's model in
 * `result.modelUsage` — the same number it compacts against, computed at
 * result time, so it already reflects a long-context credit clamp (1M → 200k)
 * or grok's mid-session window upgrade.
 *
 * Which row: `modelUsage` is keyed per model and a turn can touch several
 * (claude runs side calls on Haiku). So, in order:
 *   1. the row whose key IS the turn's model (canonicalised — a record naming
 *      the retired alias `claude-opus-5.5` still finds `claude-opus-5-5`);
 *   2. the same comparison with a `[1m]` suffix stripped from both sides;
 *   3. the ONLY row carrying a numeric `contextWindow` — grok's key can differ
 *      from the CLI id (`grok-4.6-build` for `grok-4.6`) and grok puts the
 *      window on the current model's row alone.
 * Anything else (several windowed rows, none matching) is ambiguous and yields
 * null: an unknown window is shown as unknown, never guessed.
 */
export function runtimeContextWindow(modelUsage: unknown, model: string | null): number | null {
  if (!isObject(modelUsage)) return null;
  const rows = Object.entries(modelUsage).filter((entry): entry is [string, JsonObject] => isObject(entry[1]));
  if (rows.length === 0) return null;
  if (model) {
    const wanted = canonicalModelId(model);
    const exact = rows.find(([key]) => canonicalModelId(key) === wanted);
    const exactWindow = exact ? positiveInt(exact[1]['contextWindow']) : null;
    if (exactWindow !== null) return exactWindow;
    const wantedBase = stripOneMillionSuffix(wanted);
    const stripped = rows.find(([key]) => stripOneMillionSuffix(canonicalModelId(key)) === wantedBase);
    const strippedWindow = stripped ? positiveInt(stripped[1]['contextWindow']) : null;
    if (strippedWindow !== null) return strippedWindow;
  }
  const windowed = rows.map(([, row]) => positiveInt(row['contextWindow'])).filter((w): w is number => w !== null);
  return windowed.length === 1 ? windowed[0] : null;
}

/**
 * `system/compact_boundary` → a `compaction` event. Both CLIs emit it (claude
 * as `compact_metadata:{trigger, pre_tokens, post_tokens?, duration_ms?}`;
 * grok documents the same line and ships the same field names). The camelCase
 * spelling Claude Code uses in its own transcripts is accepted too, so a
 * transcript-shaped line is never silently lost. Counts the CLI omitted stay
 * null — the UI then says "compacted" without inventing a size.
 */
function compactionFrom(turnId: string, ev: JsonObject): Extract<VerseParsedEvent, { type: 'compaction' }> {
  const meta = isObject(ev['compact_metadata'])
    ? ev['compact_metadata']
    : isObject(ev['compactMetadata']) ? ev['compactMetadata'] : {};
  const pick = (snake: string, camel: string): number | null => nonNegativeInt(meta[snake]) ?? nonNegativeInt(meta[camel]);
  return {
    type: 'compaction',
    turnId,
    // Only `manual` is distinguishable from the default; a headless turn that
    // compacted without being asked to did so automatically.
    trigger: meta['trigger'] === 'manual' ? 'manual' : 'auto',
    preTokens: pick('pre_tokens', 'preTokens'),
    postTokens: pick('post_tokens', 'postTokens'),
    durationMs: pick('duration_ms', 'durationMs'),
  };
}

/** Render a tool_result `content` field (string or content-block array) as text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isObject(block) && typeof block['text'] === 'string' ? block['text'] : ''))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (isObject(content)) {
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return '';
}

interface OpenBlock {
  type: string;
  id: string;
  name: string;
  text: string;
  partialJson: string;
  input: unknown;
  /** Clock reading when the block opened (thinking duration). */
  startedAt: number;
  /** Thinking signature, when the stream carried one (dedupes a text-less block). */
  signature: string;
}

/** Options for the shared parser. `now` is the clock (a test seam). */
export interface AnthropicStreamParserOptions {
  now?: () => number;
}

/**
 * `thinking-progress` is coalesced to at most one event per this interval
 * (≤ 4 Hz). A local qwen turn sent 30 `thinking_tokens` frames in 11 s, a
 * long Claude think sends thousands; the UI only needs a live counter.
 */
export const THINKING_PROGRESS_MIN_INTERVAL_MS = 250;

/**
 * Which kind of reasoning text a CLAUDE-CLI turn returns, from the model the
 * CLI says it runs: Claude 4+ models never return raw chain of thought — any
 * text is a vendor summary — while a local model behind the same CLI (an
 * Ollama tag) streams its raw reasoning. Grok is left unknown (undefined): its
 * API does not say which it sends, and an unknown kind is reported as unknown.
 */
function thinkingKindFor(engineLabel: string, model: string | null): VerseThinkingKind | undefined {
  if (engineLabel !== 'claude' || !model) return undefined;
  return /^claude-/i.test(model) ? 'summary' : 'raw';
}

/**
 * `system/api_retry` → one sentence. Built only from numbers and a short
 * word-shaped error tag, so nothing the network said is echoed verbatim.
 */
function apiRetryMessage(ev: JsonObject): string {
  const attempt = positiveInt(ev['attempt']);
  const max = positiveInt(ev['max_retries']);
  const delayMs = nonNegativeInt(ev['retry_delay_ms']);
  const status = positiveInt(ev['error_status']);
  const tag = str(ev['error']);
  const cause = status !== null
    ? `HTTP ${status}`
    : /^[A-Za-z0-9_. -]{1,40}$/.test(tag) && tag !== 'unknown' ? tag : 'unknown error';
  const which = attempt !== null ? (max !== null ? `retry ${attempt} of ${max}` : `retry ${attempt}`) : 'retrying';
  const when = delayMs !== null ? ` in ${(delayMs / 1000).toFixed(1)}s` : '';
  return `Model API request failed (${cause}) — ${which}${when}`;
}

/**
 * Shared parser for the Anthropic Messages wire format. Accepts:
 *   - bare wire events (`message_start`, `content_block_start`, `content_block_delta`,
 *     `content_block_stop`, `message_delta`, `message_stop`) — grok's streaming-messages-json;
 *   - the same events wrapped in claude's `{type:'stream_event', event:{...}}`;
 *   - claude's whole-message envelopes `assistant` / `user` and the terminal `result`
 *     (whose `modelUsage` carries the CLI's context window for the turn);
 *   - `system` (`init` captures session_id and model; `compact_boundary`
 *     becomes a `compaction` event; V3.10: `thinking_tokens` → a rate-limited
 *     `thinking-progress`, `api_retry` → a `status` notice, `status` →
 *     `progress {phase:'waiting'}`).
 *
 * A text/tool_use/thinking block can arrive twice — once via the streamed
 * content_block_* events and again inside an `assistant` envelope — so block
 * events are deduplicated by content within a turn. A thinking block with no
 * text (Claude's default `omitted` display, or `redacted_thinking`) is kept as
 * `thinking {text:'', redacted:true}` — the model DID think, and the UI says
 * so — deduplicated by its signature, else once per API call.
 *
 * Usage is deduplicated the same way, by API call. With partial messages on,
 * ONE call is reported by `message_start` + `message_delta` AND by one
 * `assistant` envelope per content block. Summing every report (as this parser
 * once did) counted a two-block call three times; the turn total only looked
 * right because the terminal `result` replaced it. Each call is keyed by its
 * message id and its readings are merged, so the fallback total is right too
 * when a process dies before `result`.
 *
 * V3.10 transient events (never persisted; see VERSE_TRANSIENT_EVENT_TYPES):
 * `thinking-delta` per streamed reasoning chunk, `thinking-progress`,
 * `progress` on every phase/tool change (plus once per finished API call with
 * its measured output rate), and `status`. They are emitted in stream order
 * next to the persisted events, so a consumer that drops them sees exactly the
 * persisted sequence this parser produced before 3.10 — plus the richer
 * `thinking`/`error` fields.
 */
/**
 * Shared by the claude/local and grok adapters — both speak the Anthropic wire
 * format. `engineLabel` exists because the error text was previously hardcoded
 * to 'claude', so a failing Grok turn reported `claude: error_during_execution`
 * and sent me looking at the wrong adapter.
 */
export function createAnthropicStreamParser(
  turnId: string,
  engineLabel = 'claude',
  options: AnthropicStreamParserOptions = {},
): VerseTurnParser {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const turnStartedAt = now();
  let nativeId: string | null = null;
  /** The model the CLI says it runs (`system/init.model`, else the latest assistant frame's). */
  let initModel: string | null = null;
  let frameModel: string | null = null;
  const open = new Map<number, OpenBlock>();
  const emittedText = new Set<string>();
  const emittedThinking = new Set<string>();
  const emittedToolUse = new Set<string>();
  const emittedToolResult = new Set<string>();
  /** Codes already reported from a non-JSON stdout line (one error per cause). */
  const emittedPlainErrors = new Set<string>();
  /**
   * One entry per API call, in the order the calls STARTED (Map keeps first
   * insertion order on update), so the last entry is the latest call — whose
   * prompt size is the live context occupancy.
   */
  const calls = new Map<string, AnthropicUsage>();
  /** The call the wire stream is currently inside (set by `message_start`). */
  let currentCall: string | null = null;
  /** When the current call's first content block opened (output-rate clock). */
  let currentCallFirstBlockAt: number | null = null;
  let syntheticCalls = 0;
  let resultTotals: AnthropicUsage | null = null;
  let runtimeWindow: number | null = null;
  /**
   * `post_tokens` of a compaction that happened AFTER the latest call. The
   * latest call's prompt size predates it, so the usage event reports the
   * CLI's post-compaction figure instead (a manual `/compact` turn makes no
   * further call). Cleared as soon as another call starts.
   */
  let postCompactionTokens: number | null = null;
  let usageEmitted = false;

  // ---- live state (V3.10) --------------------------------------------------
  let phase: VerseProgressPhase | null = null;
  let phaseTool: string | null = null;
  /** Output rate of the latest finished call, tokens/s; null until measured. */
  let lastTokPerSec: number | null = null;
  /** Latest `thinking_tokens` estimate, and the last one actually emitted. */
  let thinkingTokens: number | null = null;
  let emittedThinkingTokens: number | null = null;
  let lastThinkingProgressAt = Number.NEGATIVE_INFINITY;

  function syntheticKey(kind: string): string {
    syntheticCalls += 1;
    return `${kind}#${syntheticCalls}`;
  }

  function recordCall(key: string, usage: AnthropicUsage): void {
    const previous = calls.get(key);
    if (!previous) postCompactionTokens = null;
    calls.set(key, previous ? maxUsage(previous, usage) : usage);
  }

  function lastCall(): AnthropicUsage | null {
    let last: AnthropicUsage | null = null;
    for (const usage of calls.values()) last = usage;
    return last;
  }

  function callTotals(): AnthropicUsage {
    let totals = ZERO_USAGE;
    for (const usage of calls.values()) totals = addUsage(totals, usage);
    return totals;
  }

  function progressEvent(): VerseParsedEvent {
    const event: Extract<VerseParsedEvent, { type: 'progress' }> = {
      type: 'progress',
      turnId,
      phase: phase ?? 'waiting',
      elapsedMs: Math.max(0, Math.round(now() - turnStartedAt)),
    };
    if (phaseTool) event.tool = phaseTool;
    // Only MEASURED figures: output tokens the API reported, and a rate over a
    // finished call. Absent = not measured yet — never an estimate from chars.
    const outTokens = callTotals().output;
    if (outTokens > 0) event.outTokens = outTokens;
    if (lastTokPerSec !== null) event.tokPerSec = lastTokPerSec;
    return event;
  }

  /** Emit `progress` when the phase or the running tool changes. */
  function setPhase(out: VerseParsedEvent[], next: VerseProgressPhase, tool: string | null = null): void {
    if (phase === next && phaseTool === tool) return;
    phase = next;
    phaseTool = tool;
    out.push(progressEvent());
  }

  function emitThinkingProgress(out: VerseParsedEvent[]): void {
    if (thinkingTokens === null || thinkingTokens === emittedThinkingTokens) return;
    emittedThinkingTokens = thinkingTokens;
    lastThinkingProgressAt = now();
    out.push({ type: 'thinking-progress', turnId, estimatedTokens: thinkingTokens });
  }

  /** The trailing estimate the rate limit held back, so the counter ends on the true figure. */
  function flushThinkingProgress(out: VerseParsedEvent[]): void {
    emitThinkingProgress(out);
  }

  function emitText(out: VerseParsedEvent[], text: string): void {
    if (!text || emittedText.has(text)) return;
    emittedText.add(text);
    out.push({ type: 'assistant-message', turnId, text });
  }

  /**
   * Persist one thinking block. `startedAt` is when its stream opened (null
   * for an envelope-only block, whose duration is unknown and so omitted).
   */
  function emitThinking(out: VerseParsedEvent[], text: string, signature: string, startedAt: number | null): void {
    const redacted = text.length === 0;
    const callKey = `call:${currentCall ?? ''}`;
    const key = redacted ? (signature ? `sig:${signature}` : callKey) : `text:${text}`;
    if (emittedThinking.has(key)) return;
    emittedThinking.add(key);
    // A signed marker also claims its call, so a signature-less copy of the
    // same block (an envelope that dropped it) is not shown twice.
    if (redacted) emittedThinking.add(callKey);
    flushThinkingProgress(out);
    const event: Extract<VerseParsedEvent, { type: 'thinking' }> = { type: 'thinking', turnId, text };
    if (redacted) event.redacted = true;
    if (startedAt !== null) event.durationMs = Math.max(0, Math.round(now() - startedAt));
    const kind = redacted ? undefined : thinkingKindFor(engineLabel, initModel ?? frameModel);
    if (kind) event.kind = kind;
    out.push(event);
  }

  /** An envelope's thinking block: borrow the clock of the streamed block it duplicates, if one is open. */
  function emitEnvelopeThinking(out: VerseParsedEvent[], text: string, signature: string): void {
    let startedAt: number | null = null;
    for (const block of open.values()) {
      if (block.type !== 'thinking' && block.type !== 'redacted_thinking') continue;
      if ((text && block.text === text) || (!text && (!signature || block.signature === signature))) {
        startedAt = block.startedAt;
        break;
      }
    }
    emitThinking(out, text, signature, startedAt);
  }

  function emitToolUse(out: VerseParsedEvent[], id: string, name: string, input: unknown): void {
    const key = id || `${name}:${JSON.stringify(input ?? null)}`;
    if (emittedToolUse.has(key)) return;
    emittedToolUse.add(key);
    out.push({ type: 'tool-use', turnId, toolUseId: id, name, input });
    if (name) setPhase(out, 'tool', name);
  }

  function emitToolResult(out: VerseParsedEvent[], id: string, output: string, isError: boolean): void {
    const key = `${id}:${output}`;
    if (emittedToolResult.has(key)) return;
    emittedToolResult.add(key);
    out.push({ type: 'tool-result', turnId, toolUseId: id, output, isError });
    // The tool finished; the CLI now sends its result back to the model.
    setPhase(out, 'waiting');
  }

  function emitBlock(out: VerseParsedEvent[], block: JsonObject): void {
    const type = str(block['type']);
    if (type === 'text') emitText(out, str(block['text']));
    else if (type === 'thinking') emitEnvelopeThinking(out, str(block['thinking']), str(block['signature']));
    else if (type === 'redacted_thinking') emitEnvelopeThinking(out, '', str(block['data']));
    else if (type === 'tool_use') emitToolUse(out, str(block['id']), str(block['name']), block['input']);
    else if (type === 'tool_result') {
      emitToolResult(out, str(block['tool_use_id']), toolResultText(block['content']), block['is_error'] === true);
    }
  }

  function closeBlock(out: VerseParsedEvent[], index: number): void {
    const block = open.get(index);
    if (!block) return;
    open.delete(index);
    if (block.type === 'text') emitText(out, block.text);
    else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      emitThinking(out, block.type === 'thinking' ? block.text : '', block.signature, block.startedAt);
    } else if (block.type === 'tool_use') {
      let input: unknown = block.input;
      if (block.partialJson) {
        try { input = JSON.parse(block.partialJson); } catch { input = block.partialJson; }
      }
      emitToolUse(out, block.id, block.name, input);
    }
  }

  function emitUsage(out: VerseParsedEvent[]): void {
    if (usageEmitted) return;
    const summed = callTotals();
    // `result.usage` is the CLI's own turn total and wins — except when it is
    // all zeros while calls were observed: grok documents an all-zero result
    // usage as "unknown", not "free", so the observed calls are the better truth.
    const totals = resultTotals && !(isZeroUsage(resultTotals) && !isZeroUsage(summed)) ? resultTotals : summed;
    const last = lastCall() ?? resultTotals;
    if (!last && postCompactionTokens === null) return;
    usageEmitted = true;
    const contextTokens = postCompactionTokens
      ?? (last ? last.input + last.cacheRead + last.cacheCreation : 0);
    out.push({ type: 'usage', turnId, usage: toVerseUsage(totals, contextTokens, runtimeWindow) });
  }

  function handleWireEvent(out: VerseParsedEvent[], ev: JsonObject): void {
    const type = str(ev['type']);
    switch (type) {
      case 'message_start': {
        const message = isObject(ev['message']) ? ev['message'] : null;
        currentCall = str(message?.['id']) || syntheticKey('wire');
        currentCallFirstBlockAt = null;
        if (typeof message?.['model'] === 'string' && message['model']) frameModel = message['model'];
        const usage = readAnthropicUsage(message?.['usage']);
        if (usage) recordCall(currentCall, usage);
        open.clear();
        return;
      }
      case 'content_block_start': {
        const index = num(ev['index']);
        const cb = isObject(ev['content_block']) ? ev['content_block'] : {};
        const blockType = str(cb['type']);
        const startedAt = now();
        if (currentCallFirstBlockAt === null) currentCallFirstBlockAt = startedAt;
        open.set(index, {
          type: blockType,
          id: str(cb['id']),
          name: str(cb['name']),
          text: str(cb['text']) || str(cb['thinking']),
          partialJson: '',
          input: cb['input'],
          startedAt,
          signature: str(cb['signature']) || (blockType === 'redacted_thinking' ? str(cb['data']) : ''),
        });
        if (blockType === 'thinking' || blockType === 'redacted_thinking') setPhase(out, 'thinking');
        else if (blockType === 'text') setPhase(out, 'writing');
        else if (blockType === 'tool_use') setPhase(out, 'tool', str(cb['name']) || null);
        return;
      }
      case 'content_block_delta': {
        const index = num(ev['index']);
        const delta = isObject(ev['delta']) ? ev['delta'] : {};
        const deltaType = str(delta['type']);
        let block = open.get(index);
        if (!block) {
          // Delta without a start (e.g. we joined mid-stream): open an implicit block.
          const startedAt = now();
          if (currentCallFirstBlockAt === null) currentCallFirstBlockAt = startedAt;
          block = {
            type: deltaType === 'thinking_delta' || deltaType === 'signature_delta' ? 'thinking' : 'text',
            id: '',
            name: '',
            text: '',
            partialJson: '',
            input: undefined,
            startedAt,
            signature: '',
          };
          open.set(index, block);
        }
        if (deltaType === 'text_delta') {
          const text = str(delta['text']);
          if (text) {
            block.text += text;
            setPhase(out, 'writing');
            out.push({ type: 'text-delta', turnId, text });
          }
        } else if (deltaType === 'thinking_delta') {
          const text = str(delta['thinking']);
          if (text) {
            block.text += text;
            setPhase(out, 'thinking');
            // Transient: the whole block is persisted once as `thinking` when
            // it closes, so the log never holds per-chunk reasoning.
            out.push({ type: 'thinking-delta', turnId, text });
          }
        } else if (deltaType === 'signature_delta') {
          block.signature += str(delta['signature']);
        } else if (deltaType === 'input_json_delta') {
          block.partialJson += str(delta['partial_json']);
        }
        return;
      }
      case 'content_block_stop': {
        closeBlock(out, num(ev['index']));
        return;
      }
      case 'message_delta': {
        const usage = readAnthropicUsage(ev['usage']);
        if (usage) {
          if (!currentCall) currentCall = syntheticKey('wire');
          recordCall(currentCall, usage);
          // The call's output count is final here: measure its rate over the
          // time its content streamed (from the first block, so the prompt's
          // queue/prefill time is not counted as slow generation).
          const callOutput = calls.get(currentCall)?.output ?? 0;
          const since = currentCallFirstBlockAt;
          const seconds = since === null ? 0 : (now() - since) / 1000;
          if (callOutput > 0 && seconds >= 0.25) {
            lastTokPerSec = Math.round((callOutput / seconds) * 10) / 10;
            out.push(progressEvent());
          }
        }
        return;
      }
      case 'message_stop': {
        for (const index of [...open.keys()]) closeBlock(out, index);
        // `currentCall` stays set: an id-less `assistant` envelope that follows
        // describes this same call, not a new one.
        return;
      }
      default:
        return;
    }
  }

  function handleSystem(out: VerseParsedEvent[], ev: JsonObject): void {
    const subtype = ev['subtype'];
    if (subtype === 'init') {
      // Non-empty only: grok's signed-out init carries `session_id: ""`.
      if (typeof ev['session_id'] === 'string' && ev['session_id']) nativeId = ev['session_id'];
      if (typeof ev['model'] === 'string' && ev['model']) initModel = ev['model'];
    } else if (subtype === 'compact_boundary') {
      const compaction = compactionFrom(turnId, ev);
      postCompactionTokens = compaction.postTokens;
      out.push(compaction);
    } else if (subtype === 'thinking_tokens') {
      // Arrives even when the display omits the text (claude 2.1.280), so it
      // is the one live signal a Claude think always has. Cumulative within
      // the block; a bare delta is accumulated when the total is missing.
      const total = nonNegativeInt(ev['estimated_tokens']);
      const delta = nonNegativeInt(ev['estimated_tokens_delta']);
      if (total !== null) thinkingTokens = total;
      else if (delta !== null) thinkingTokens = (thinkingTokens ?? 0) + delta;
      else return;
      setPhase(out, 'thinking');
      if (now() - lastThinkingProgressAt >= THINKING_PROGRESS_MIN_INTERVAL_MS) emitThinkingProgress(out);
    } else if (subtype === 'api_retry') {
      // Without this a dead endpoint looked like a silent spinner for minutes
      // (10 retries with backoff, measured against a stopped Ollama).
      out.push({ type: 'status', turnId, kind: 'retry', message: apiRetryMessage(ev) });
      setPhase(out, 'waiting');
    } else if (subtype === 'status') {
      if (ev['status'] === 'requesting') setPhase(out, 'waiting');
    }
  }

  function handleResult(out: VerseParsedEvent[], ev: JsonObject): void {
    if (typeof ev['session_id'] === 'string' && ev['session_id']) nativeId = ev['session_id'];
    const usage = readAnthropicUsage(ev['usage']);
    if (usage) resultTotals = usage;
    runtimeWindow = runtimeContextWindow(ev['modelUsage'], initModel ?? frameModel);
    const subtype = str(ev['subtype']);
    const errors = resultErrorsText(ev['errors']);
    if (subtype && subtype !== 'success') {
      // `errors[]` first: it holds the cause; `subtype` is only the category.
      const detail = errors || str(ev['error']) || str(ev['result']) || subtype;
      out.push(cliErrorEvent(turnId, engineLabel, detail));
    } else if (ev['is_error'] === true) {
      out.push(cliErrorEvent(turnId, engineLabel, errors || str(ev['result']) || 'result reported an error'));
    }
    emitUsage(out);
  }

  function handleEnvelope(out: VerseParsedEvent[], ev: JsonObject): boolean {
    const type = str(ev['type']);
    switch (type) {
      case 'system': {
        handleSystem(out, ev);
        return true;
      }
      case 'stream_event': {
        if (isObject(ev['event'])) handleWireEvent(out, ev['event']);
        return true;
      }
      case 'assistant':
      case 'user': {
        const message = isObject(ev['message']) ? ev['message'] : null;
        if (!message) return true;
        if (type === 'assistant') {
          if (typeof message['model'] === 'string' && message['model']) frameModel = message['model'];
          const usage = readAnthropicUsage(message['usage']);
          if (usage) {
            const key = str(message['id']) || currentCall || syntheticKey('envelope');
            recordCall(key, usage);
          }
        }
        const content = message['content'];
        if (typeof content === 'string') {
          if (type === 'assistant') emitText(out, content);
        } else if (Array.isArray(content)) {
          for (const block of content) if (isObject(block)) emitBlock(out, block);
        }
        return true;
      }
      case 'result': {
        handleResult(out, ev);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * A non-JSON stdout line is the CLI talking, never the model (model output
   * is always inside a JSON frame). Only the sentences Verse acts on become an
   * `error`; anything else stays dropped, as before.
   */
  function handlePlainLine(line: string): VerseParsedEvent[] {
    const text = line.trim();
    if (!text) return [];
    const code = classifyVerseCliError(text);
    if (!code || emittedPlainErrors.has(code)) return [];
    emittedPlainErrors.add(code);
    return [cliErrorEvent(turnId, engineLabel, text.replace(/^error:\s*/i, '').slice(0, MAX_ERROR_ENTRY_CHARS))];
  }

  return {
    push(line: string): VerseParsedEvent[] {
      if (typeof line !== 'string') return [];
      const ev = parseJsonObjectLine(line);
      const out: VerseParsedEvent[] = [];
      try {
        if (!ev) return handlePlainLine(line);
        if (!handleEnvelope(out, ev)) handleWireEvent(out, ev);
      } catch {
        // Parsers never throw on odd input; drop the line.
      }
      return out;
    },
    finish(_exitCode: number | null): VerseParsedEvent[] {
      // Exit-code errors are the engine's to report (it also has the stderr tail).
      const out: VerseParsedEvent[] = [];
      try {
        for (const index of [...open.keys()]) closeBlock(out, index);
        emitUsage(out);
      } catch {
        // never throw
      }
      // Transient events after the process is gone would only flicker a
      // spinner that is about to disappear; the turn's end is the last word.
      return out.filter((event) => event.type !== 'progress' && event.type !== 'thinking-progress');
    },
    nativeSessionId(): string | null {
      return nativeId;
    },
  };
}

/**
 * Strip a trailing `/v1` (and slashes) so ANTHROPIC_BASE_URL names an ORIGIN.
 *
 * Claude Code appends `/v1/messages` itself, so a base URL that already ends
 * in `/v1` would ask for `/v1/v1/messages`. Both lanes hand us their address
 * spelled that way — `resolveLocalAnthropicBaseUrl` returns `.../v1` exactly
 * like a configured Ollama URL might — so the same normalisation covers both.
 */
export function anthropicEnvBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

// ---------------------------------------------------------------------------
// Launch helpers (pure: they read only the session and its launch snapshot)
// ---------------------------------------------------------------------------

/** The seat option for the session's model — exact id first, then canonical id (alias ↔ real id). */
function seatModelOption(session: VerseSession, launch: VerseSeatLaunch): VerseModelOption | null {
  const models = Array.isArray(launch.seat?.models) ? launch.seat.models : [];
  const exact = models.find((m) => m.id === session.model);
  if (exact) return exact;
  const wanted = canonicalModelId(session.model);
  return models.find((m) => canonicalModelId(m.id) === wanted) ?? null;
}

/**
 * The option whose budgets decide a CLAUDE seat's `--autocompact` flag.
 *
 * Normally the launch snapshot's own option. A snapshot written before 3.9
 * carries only the old flat 200k window and no budgets, so its model is looked
 * up in the verified per-model table (model-windows.ts) instead — through
 * `legacyModelOptionFallback`, the SAME helper the engine's
 * `effectiveModelOption` calls, so the compaction point the engine records is
 * exactly the one this flag tells the CLI. A model neither knows keeps its
 * snapshot option (and so, lacking an expansive budget, gets no flag: the
 * CLI's own default applies).
 *
 * The MODE is the session's. A pre-3.9 record has none on disk; the engine
 * materialises one (`expansive` for a 1M model — what 3.8 ran) before it ever
 * builds a launch, so this adapter never has to guess what "absent" meant.
 */
function claudeBudgetOption(session: VerseSession, launch: VerseSeatLaunch): VerseModelOption | null {
  return legacyModelOptionFallback('claude', session.model, seatModelOption(session, launch));
}

/**
 * `--autocompact` for a claude seat, or nothing.
 *
 * Only 1M-native models (the ones with a real expansive budget) are steered:
 * standard mode caps compaction at `claudeAutocompactFlag` (400k), expansive
 * passes `auto` — explicitly, so a stray `autoCompactWindow` in the seat's own
 * settings cannot silently shrink a budget the operator chose. A 200k model
 * gets no flag at all; the CLI's `auto` already is its budget.
 */
function autocompactArgs(session: VerseSession, launch: VerseSeatLaunch): string[] {
  if (session.engine !== 'claude') return [];
  const option = claudeBudgetOption(session, launch);
  if (!hasExpansiveMode(option)) return [];
  const flag = claudeAutocompactFlag(option, session.contextMode ?? 'standard');
  return ['--autocompact', flag === null ? 'auto' : String(flag)];
}

/**
 * The window a LOCAL seat's CLI is told it has. The session's own window first
 * (set from the seat's resolved num_ctx at creation, and never replaced by a
 * runtime reading on engine=local), then the launch snapshot's option, then the
 * seat's, then the named default the local seats pin.
 */
function localContextWindow(session: VerseSession, launch: VerseSeatLaunch): number {
  return positiveInt(session.usage?.contextWindow)
    ?? positiveInt(seatModelOption(session, launch)?.contextWindow)
    ?? positiveInt(launch.seat?.contextWindow)
    ?? VERSE_DEFAULT_CONTEXT_WINDOWS['local'];
}

/** A launch record's memory snapshot, if it is well-formed; anything else is treated as "memory off". */
function launchMemory(launch: VerseSeatLaunch): { dir: string; block: string; writable: boolean } | null {
  const memory: unknown = launch.memory;
  if (!isObject(memory)) return null;
  const dir = memory['dir'];
  const block = memory['block'];
  if (typeof dir !== 'string' || !dir.startsWith('/') || typeof block !== 'string' || block.trim().length === 0) return null;
  return { dir, block, writable: memory['writable'] === true };
}

// ---------------------------------------------------------------------------
// V3.10 launch facts read from disk
//
// `buildLaunch` was pure. Two decisions now need one bounded look at the CLI's
// own files — which binary the seat's profile pins (does it know
// `--thinking-display`?) and whether the native transcript already exists
// (`--session-id` or `--resume`?). Both are a handful of stat/small-file reads
// (sub-millisecond), synchronous, never throw, and never read file CONTENTS
// beyond the profile manifest. Nothing read here leaves the process: paths go
// into no argv the adapter did not already emit.
// ---------------------------------------------------------------------------

/** Vendor ids are interpolated into file names, so anything but a UUID is refused. */
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const MAX_PROFILE_BYTES = 64 * 1024;

export interface NativeProfileFacts {
  /** The profile directory (`…/native-profiles/<account>`). */
  directory: string;
  /** The CLI's pinned home (CLAUDE_CONFIG_DIR / GROK_HOME / CODEX_HOME), when the manifest names one. */
  nativeStatePath: string | null;
  /** The one binary the launcher execs, when the manifest names one. */
  executable: string | null;
}

function cleanAbsolute(value: unknown): string | null {
  return typeof value === 'string' && value.length > 1 && value.length <= 4096 && isAbsolute(value)
    && !value.includes('\0') && normalize(value) === value ? value : null;
}

/**
 * The native profile behind a launcher argv (`…/<profile>/launcher.mjs` ⇒ its
 * `profile.json`) — the same derivation seats.ts `readSeatProfile` and
 * codex-rollout `codexNativeStatePath` use. A manifest naming ANOTHER provider
 * yields null (reading a codex home for a claude seat would be worse than
 * reading none); an absent or unreadable manifest yields the directory alone.
 */
export function readNativeProfileFacts(
  launcher: readonly string[] | null | undefined,
  provider: 'claude' | 'codex' | 'grok',
): NativeProfileFacts | null {
  if (!Array.isArray(launcher)) return null;
  const launcherPath = [...launcher].reverse().find((part) => cleanAbsolute(part) !== null && part.endsWith('/launcher.mjs'));
  if (!launcherPath) return null;
  const directory = dirname(launcherPath);
  const facts: NativeProfileFacts = { directory, nativeStatePath: null, executable: null };
  try {
    const manifestPath = join(directory, 'profile.json');
    const stat = statSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) return facts;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!isObject(manifest)) return facts;
    if (manifest['provider'] !== undefined && manifest['provider'] !== provider) return null;
    facts.nativeStatePath = cleanAbsolute(manifest['nativeStatePath']);
    facts.executable = cleanAbsolute(manifest['executable']);
  } catch {
    // No manifest: the launcher's sibling `native-state` is the pinned home.
  }
  return facts;
}

/**
 * The CLI home a turn will run against, or null when it cannot be known.
 * A launcher's profile pins it (`native-state` next to the launcher unless the
 * manifest says otherwise); a launcher-less spawn inherits the server's HOME
 * (the engine passes HOME but no CLAUDE_CONFIG_DIR/GROK_HOME through), so the
 * CLI's own default applies.
 */
export function nativeStateDir(
  launcher: readonly string[] | null | undefined,
  provider: 'claude' | 'grok',
  defaultDir: string,
): string | null {
  if (!launcher) return defaultDir;
  const facts = readNativeProfileFacts(launcher, provider);
  if (!facts) return null;
  return facts.nativeStatePath ?? join(facts.directory, 'native-state');
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function pathExists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

/** The cwd as given and as the OS resolves it (`/tmp` → `/private/tmp`), deduplicated. */
function cwdSpellings(projectPath: string): string[] {
  const out = [projectPath];
  try {
    const physical = realpathSync.native(projectPath);
    if (physical !== projectPath) out.push(physical);
  } catch {
    // A missing project dir has only the spelling we were given.
  }
  return out;
}

/** Java-style 32-bit string hash — claude's own (`AQ` in the 2.1.280 bundle). */
function claudePathHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return hash;
}

/** Longest project directory name claude writes before it appends a hash (2.1.280: `gQ=200`). */
const CLAUDE_PROJECT_SLUG_MAX = 200;

/**
 * The directory under `<CLAUDE_CONFIG_DIR>/projects` claude keeps a cwd's
 * transcripts in. Transcribed from the 2.1.280 bundle (`kT`):
 * every non-alphanumeric → `-`; past 200 chars, the first 200 plus
 * `-<|hash(cwd)| base 36>`.
 */
export function claudeProjectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= CLAUDE_PROJECT_SLUG_MAX) return slug;
  return `${slug.slice(0, CLAUDE_PROJECT_SLUG_MAX)}-${Math.abs(claudePathHash(cwd)).toString(36)}`;
}

/** `present`/`absent` are facts read from disk; `unknown` means the CLI home itself could not be found. */
export type NativeConversationState = 'present' | 'absent' | 'unknown';

/**
 * Does claude already hold a transcript for this session id in this cwd?
 * Scoped to the cwd's own project directory because that is exactly where the
 * CLI looks: measured on 2.1.280, a transcript planted under ANOTHER project
 * directory did not trip "already in use", one under the cwd's did.
 */
export function claudeConversationState(configDir: string | null, projectPath: string, nativeId: string): NativeConversationState {
  if (!configDir || !isDirectory(configDir) || !UUID_RE.test(nativeId)) return 'unknown';
  for (const cwd of cwdSpellings(projectPath)) {
    if (pathExists(join(configDir, 'projects', claudeProjectSlug(cwd), `${nativeId}.jsonl`))) return 'present';
  }
  return 'absent';
}

/**
 * The same question for grok: `<GROK_HOME>/sessions/<encoded-cwd>/<id>/`
 * (grok docs 17-sessions.md; the percent-encoded cwd was confirmed on this
 * machine's grok-a home).
 */
export function grokConversationState(grokHome: string | null, projectPath: string, nativeId: string): NativeConversationState {
  if (!grokHome || !isDirectory(grokHome) || !UUID_RE.test(nativeId)) return 'unknown';
  for (const cwd of cwdSpellings(projectPath)) {
    if (pathExists(join(grokHome, 'sessions', encodeURIComponent(cwd), nativeId))) return 'present';
  }
  return 'absent';
}

/**
 * The engine's explicit instruction for THIS turn, when it gives one
 * (read structurally: optional, absent on every launch record). The engine
 * sets `new` when it deliberately starts a fresh native conversation — e.g.
 * recovering a vanished thread with a handoff — and `resume` to retry after
 * "already in use".
 */
export function nativeSessionOverride(launch: VerseSeatLaunch): 'new' | 'resume' | null {
  const value = (launch as { nativeSession?: unknown }).nativeSession;
  return value === 'new' || value === 'resume' ? value : null;
}

/** Did this chat ever complete a real model exchange? (Its totals are only ever non-zero after one.) */
function hadVendorExchange(session: VerseSession): boolean {
  const u = session.usage;
  if (!u || typeof u !== 'object') return false;
  return num(u.inputTokens) + num(u.outputTokens) + num(u.cacheReadTokens) + num(u.cacheCreationTokens) > 0;
}

/**
 * Create (`new`) or continue (`resume`) the native conversation.
 *
 *  - override from the engine → as told;
 *  - transcript present → resume. This is the turn-1 Stop fix: a turn
 *    stopped (or a server restarted) before the first parsed event leaves
 *    `turnCount` at 0 but the CLI already wrote the transcript at init, and
 *    `--session-id` on it fails every later turn with "already in use";
 *  - transcript absent on a conversation that has completed turns AND
 *    exchanged tokens → resume anyway, on purpose: the vendor thread was lost
 *    (claude prunes transcripts after 30 days), and quietly minting a blank
 *    conversation under the same id would drop the whole context without a
 *    word. `--resume` fails with a coded `native-thread-missing` error the
 *    engine recovers from with a handoff;
 *  - any other absent transcript → new: a turn 1 that died before init (e.g.
 *    signed out) must not resume nothing, and the engine's recovery hands in
 *    a fresh native id with `turnCount: 0` precisely to mint a conversation
 *    (its session totals still carry the old tokens, so turnCount decides);
 *  - home unknown (no readable profile) → the pre-3.10 rule, by turn count.
 */
export function chooseNativeSession(
  session: VerseSession,
  state: NativeConversationState,
  override: 'new' | 'resume' | null,
): 'new' | 'resume' {
  if (override) return override;
  if (state === 'present') return 'resume';
  if (state === 'absent') return session.turnCount > 0 && hadVendorExchange(session) ? 'resume' : 'new';
  return session.turnCount > 0 ? 'resume' : 'new';
}

/** `--session-id <id>` or `--resume <id>` for a claude/local turn. */
export function claudeNativeSessionArgs(session: VerseSession, launch: VerseSeatLaunch): string[] {
  const id = session.nativeSessionId ?? '';
  const isLocal = session.engine === 'local';
  const configDir = isLocal
    ? join(homedir(), '.claude')
    : nativeStateDir(launch.launcher, 'claude', join(homedir(), '.claude'));
  const choice = chooseNativeSession(session, claudeConversationState(configDir, session.projectPath, id), nativeSessionOverride(launch));
  return choice === 'resume' ? ['--resume', id] : ['--session-id', id];
}

/**
 * The oldest pinned claude build verified to accept `--thinking-display
 * summarized`: 2.1.243, 2.1.257 and 2.1.280 all define the (hidden) option
 * with choices ["summarized","omitted"(,"highlights")] — read from each
 * binary's own option table. An older or unknown build gets no flag: commander
 * rejects unknown options, so guessing would fail EVERY turn, while omitting it
 * only hides the reasoning text.
 */
export const CLAUDE_THINKING_DISPLAY_MIN_CLI = '2.1.243';

/**
 * Is live vendor reasoning on for this turn? The engine's per-turn value when
 * it passes one (structural, optional), else the operator preference; absent
 * everywhere = on (Mason's default). Never throws.
 */
export function thinkingDisplayEnabled(launch: VerseSeatLaunch): boolean {
  const explicit = (launch as { thinkingDisplay?: unknown }).thinkingDisplay;
  if (typeof explicit === 'boolean') return explicit;
  try {
    return loadVersePreferences().thinkingDisplay !== false;
  } catch {
    return true;
  }
}

/** The claude build this seat will actually exec: its profile's pinned binary, else the launch snapshot's. */
export function pinnedClaudeVersion(launch: VerseSeatLaunch): string | null {
  const facts = launch.launcher ? readNativeProfileFacts(launch.launcher, 'claude') : null;
  const fromProfile = facts?.executable ? cliVersionFromExecutable(facts.executable) : null;
  if (fromProfile) return fromProfile;
  const snapshot = launch.seat?.cliVersion;
  return typeof snapshot === 'string' && snapshot.length > 0 ? snapshot : null;
}

/**
 * `--thinking-display summarized` for a claude seat, or nothing. Never on a
 * local seat: a local model streams its raw reasoning anyway, and the flag
 * would ask a non-Anthropic endpoint for an Anthropic display mode.
 */
export function claudeThinkingDisplayArgs(session: Pick<VerseSession, 'engine'>, launch: VerseSeatLaunch): string[] {
  if (session.engine !== 'claude') return [];
  if (!thinkingDisplayEnabled(launch)) return [];
  const version = pinnedClaudeVersion(launch);
  if (version === null || compareCliVersions(version, CLAUDE_THINKING_DISPLAY_MIN_CLI) < 0) return [];
  return ['--thinking-display', 'summarized'];
}

function buildClaudeLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch {
  if (!session.nativeSessionId) {
    throw new Error('claude session is missing its native session id');
  }
  const isLocal = session.engine === 'local';
  const prefix = isLocal || !launch.launcher ? ['claude'] : [...launch.launcher];
  // Workspace roots beyond the primary. `verseSessionRoots` puts the primary
  // first and it is already the cwd, so only the tail needs a flag.
  const extraRoots = verseSessionRoots(session).slice(1);
  const memory = launchMemory(launch);
  // The memory directory is granted only when the snapshot says this seat may
  // WRITE it: `--add-dir` has no read-only form, and a read-only seat already
  // has the file's contents in the appended block.
  const addDirs = [...extraRoots];
  if (memory?.writable && !addDirs.includes(memory.dir) && memory.dir !== session.projectPath) addDirs.push(memory.dir);
  // V3.10 attachments: exactly the one directory this message's `@path`
  // tokens name (the engine resolved them), so the CLI may read those files
  // and nothing else of the store around them.
  for (const dir of turnAttachmentDirs(launch)) {
    if (!addDirs.includes(dir) && dir !== session.projectPath) addDirs.push(dir);
  }
  // `-p` is boolean (`--print`); the prompt is the positional `[prompt]`. It
  // goes LAST, behind the end-of-options marker, so a message that starts
  // with `-` (a bullet list, or a literal `--dangerously-skip-permissions`)
  // is text to the model rather than a flag commander honours.
  const argv = [
    ...prefix,
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Always the CANONICAL id: `claude-opus-5.5` (an id Verse once shipped) is
    // fuzzy-matched by the CLI to Opus 5, so a stored alias must never reach it.
    '--model', canonicalModelId(session.model),
    // V3.10 per-chat permission mode (session-controls.ts); the default is
    // `acceptEdits`, exactly the flag every turn carried before 3.10.
    ...claudePermissionArgs(session),
    // V3.10 per-chat effort — claude seats on a build that knows `--effort`
    // only; nothing by default, so an untouched chat launches as before.
    ...claudeEffortArgs(session, session.engine === 'claude' ? pinnedClaudeVersion(launch) : null),
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    ...autocompactArgs(session, launch),
    // Local only: move the per-launch sections (cwd, env, git status) out of
    // the system prompt so the local runner's prefix cache survives between
    // turns. Claude seats keep the CLI default.
    ...(isLocal ? ['--exclude-dynamic-system-prompt-sections'] : []),
    // V3.10 live reasoning: summaries instead of the API's `omitted` default.
    ...claudeThinkingDisplayArgs(session, launch),
    // VERIFIED against `claude --help` on 2.1.280:
    //   `--add-dir <directories...>  Additional directories to allow tool access to`
    // It is variadic, so it is spelled ONE DIRECTORY PER FLAG rather than
    // `--add-dir a b c`: a variadic option swallows following words until the
    // next flag, and the prompt is a positional. `--add-dir /a /b -- text`
    // would hand commander an ambiguity we have no reason to create.
    // Repetition was checked on the real binary, not assumed: commander
    // rejects unknown options loudly (`claude --zzz …` → "error: unknown
    // option"), and `claude --add-dir /tmp --add-dir /private/var/tmp -p
    // --session-id NOTAUUID -- hi` got PAST option parsing to the downstream
    // "Invalid session ID" check, so both flags parsed.
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    // The `=` spelling binds the block to the flag whatever its first
    // character is — commander never re-reads it as an option.
    ...(memory ? [`--append-system-prompt=${memory.block}`] : []),
    // From the transcript on disk, not `turnCount` — see chooseNativeSession.
    ...claudeNativeSessionArgs(session, launch),
    '--', text,
  ];
  const env: Record<string, string> = isLocal
    ? {
      // The launch record's dispatch address wins; `ollamaBaseUrl` is the
      // default lane and the fallback for records written before lanes existed.
      ANTHROPIC_BASE_URL: anthropicEnvBaseUrl(launch.anthropicBaseUrl ?? launch.ollamaBaseUrl),
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // An Ollama tag is not a Claude id, so the CLI honours this as the
      // model's window: auto-compaction and `result.modelUsage.contextWindow`
      // then match what the runner actually serves. Not credential-shaped
      // (`_TOKENS`), so the engine's env filter passes it through.
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(localContextWindow(session, launch)),
    }
    : {};
  return { argv, cwd: session.projectPath, env, stdin: null };
}

export const claudeAdapter: VerseAdapter = {
  buildLaunch: buildClaudeLaunch,
  createParser: (turnId: string) => createAnthropicStreamParser(turnId, 'claude'),
};
