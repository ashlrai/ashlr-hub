/**
 * Claude adapter (engine=claude and engine=local).
 *
 * Launch: one `claude -p --output-format stream-json --verbose
 * --include-partial-messages ... -- <text>` process per turn (`-p` is
 * boolean; the prompt is positional and goes last, behind `--`). Turn 1 mints the
 * conversation with `--session-id <uuid>`; later turns `--resume <uuid>`.
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
 */

import {
  canonicalModelId,
  claudeAutocompactFlag,
  hasExpansiveMode,
} from '../context-math.js';
import { legacyModelOptionFallback } from '../model-windows.js';
import {
  VERSE_DEFAULT_CONTEXT_WINDOWS,
  verseSessionRoots,
  type VerseModelOption,
  type VerseSession,
  type VerseTurnLaunch,
  type VerseUsage,
} from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import type { VerseAdapter, VerseParsedEvent, VerseTurnParser } from './index.js';

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
}

/**
 * Shared parser for the Anthropic Messages wire format. Accepts:
 *   - bare wire events (`message_start`, `content_block_start`, `content_block_delta`,
 *     `content_block_stop`, `message_delta`, `message_stop`) — grok's streaming-messages-json;
 *   - the same events wrapped in claude's `{type:'stream_event', event:{...}}`;
 *   - claude's whole-message envelopes `assistant` / `user` and the terminal `result`
 *     (whose `modelUsage` carries the CLI's context window for the turn);
 *   - `system` (`init` captures session_id and model; `compact_boundary`
 *     becomes a `compaction` event).
 *
 * A text/tool_use/thinking block can arrive twice — once via the streamed
 * content_block_* events and again inside an `assistant` envelope — so block
 * events are deduplicated by content within a turn.
 *
 * Usage is deduplicated the same way, by API call. With partial messages on,
 * ONE call is reported by `message_start` + `message_delta` AND by one
 * `assistant` envelope per content block. Summing every report (as this parser
 * once did) counted a two-block call three times; the turn total only looked
 * right because the terminal `result` replaced it. Each call is keyed by its
 * message id and its readings are merged, so the fallback total is right too
 * when a process dies before `result`.
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
): VerseTurnParser {
  let nativeId: string | null = null;
  /** The model the CLI says it runs (`system/init.model`, else the latest assistant frame's). */
  let initModel: string | null = null;
  let frameModel: string | null = null;
  const open = new Map<number, OpenBlock>();
  const emittedText = new Set<string>();
  const emittedThinking = new Set<string>();
  const emittedToolUse = new Set<string>();
  const emittedToolResult = new Set<string>();
  /**
   * One entry per API call, in the order the calls STARTED (Map keeps first
   * insertion order on update), so the last entry is the latest call — whose
   * prompt size is the live context occupancy.
   */
  const calls = new Map<string, AnthropicUsage>();
  /** The call the wire stream is currently inside (set by `message_start`). */
  let currentCall: string | null = null;
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

  function emitText(out: VerseParsedEvent[], text: string): void {
    if (!text || emittedText.has(text)) return;
    emittedText.add(text);
    out.push({ type: 'assistant-message', turnId, text });
  }

  function emitThinking(out: VerseParsedEvent[], text: string): void {
    if (!text || emittedThinking.has(text)) return;
    emittedThinking.add(text);
    out.push({ type: 'thinking', turnId, text });
  }

  function emitToolUse(out: VerseParsedEvent[], id: string, name: string, input: unknown): void {
    const key = id || `${name}:${JSON.stringify(input ?? null)}`;
    if (emittedToolUse.has(key)) return;
    emittedToolUse.add(key);
    out.push({ type: 'tool-use', turnId, toolUseId: id, name, input });
  }

  function emitToolResult(out: VerseParsedEvent[], id: string, output: string, isError: boolean): void {
    const key = `${id}:${output}`;
    if (emittedToolResult.has(key)) return;
    emittedToolResult.add(key);
    out.push({ type: 'tool-result', turnId, toolUseId: id, output, isError });
  }

  function emitBlock(out: VerseParsedEvent[], block: JsonObject): void {
    const type = str(block['type']);
    if (type === 'text') emitText(out, str(block['text']));
    else if (type === 'thinking') emitThinking(out, str(block['thinking']));
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
    else if (block.type === 'thinking') emitThinking(out, block.text);
    else if (block.type === 'tool_use') {
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
        if (typeof message?.['model'] === 'string' && message['model']) frameModel = message['model'];
        const usage = readAnthropicUsage(message?.['usage']);
        if (usage) recordCall(currentCall, usage);
        open.clear();
        return;
      }
      case 'content_block_start': {
        const index = num(ev['index']);
        const cb = isObject(ev['content_block']) ? ev['content_block'] : {};
        open.set(index, {
          type: str(cb['type']),
          id: str(cb['id']),
          name: str(cb['name']),
          text: str(cb['text']) || str(cb['thinking']),
          partialJson: '',
          input: cb['input'],
        });
        return;
      }
      case 'content_block_delta': {
        const index = num(ev['index']);
        const delta = isObject(ev['delta']) ? ev['delta'] : {};
        const deltaType = str(delta['type']);
        let block = open.get(index);
        if (!block) {
          // Delta without a start (e.g. we joined mid-stream): open an implicit block.
          block = { type: deltaType === 'thinking_delta' ? 'thinking' : 'text', id: '', name: '', text: '', partialJson: '', input: undefined };
          open.set(index, block);
        }
        if (deltaType === 'text_delta') {
          const text = str(delta['text']);
          if (text) {
            block.text += text;
            out.push({ type: 'text-delta', turnId, text });
          }
        } else if (deltaType === 'thinking_delta') {
          block.text += str(delta['thinking']);
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

  function handleEnvelope(out: VerseParsedEvent[], ev: JsonObject): boolean {
    const type = str(ev['type']);
    switch (type) {
      case 'system': {
        const subtype = ev['subtype'];
        if (subtype === 'init') {
          if (typeof ev['session_id'] === 'string') nativeId = ev['session_id'];
          if (typeof ev['model'] === 'string' && ev['model']) initModel = ev['model'];
        } else if (subtype === 'compact_boundary') {
          const compaction = compactionFrom(turnId, ev);
          postCompactionTokens = compaction.postTokens;
          out.push(compaction);
        }
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
        if (typeof ev['session_id'] === 'string') nativeId = ev['session_id'];
        const usage = readAnthropicUsage(ev['usage']);
        if (usage) resultTotals = usage;
        runtimeWindow = runtimeContextWindow(ev['modelUsage'], initModel ?? frameModel);
        const subtype = str(ev['subtype']);
        if (subtype && subtype !== 'success') {
          const detail = str(ev['error']) || str(ev['result']) || subtype;
          out.push({ type: 'error', turnId, message: `${engineLabel}: ${detail}` });
        } else if (ev['is_error'] === true) {
          out.push({ type: 'error', turnId, message: `${engineLabel}: ${str(ev['result']) || 'result reported an error'}` });
        }
        emitUsage(out);
        return true;
      }
      default:
        return false;
    }
  }

  return {
    push(line: string): VerseParsedEvent[] {
      const ev = parseJsonObjectLine(line);
      if (!ev) return [];
      const out: VerseParsedEvent[] = [];
      try {
        if (!handleEnvelope(out, ev)) handleWireEvent(out, ev);
      } catch {
        // Parsers never throw on odd input; drop the line.
      }
      return out;
    },
    finish(_exitCode: number | null): VerseParsedEvent[] {
      // Exit-code errors are the engine's to report (it also has the stderr tail).
      const out: VerseParsedEvent[] = [];
      for (const index of [...open.keys()]) closeBlock(out, index);
      emitUsage(out);
      return out;
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
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    ...autocompactArgs(session, launch),
    // Local only: move the per-launch sections (cwd, env, git status) out of
    // the system prompt so the local runner's prefix cache survives between
    // turns. Claude seats keep the CLI default.
    ...(isLocal ? ['--exclude-dynamic-system-prompt-sections'] : []),
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
    ...(session.turnCount > 0 ? ['--resume', session.nativeSessionId] : ['--session-id', session.nativeSessionId]),
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
  createParser: createAnthropicStreamParser,
};
