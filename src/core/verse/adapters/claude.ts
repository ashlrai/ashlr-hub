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
 * Parse: claude's stream-json is JSONL where streaming deltas are wrapped as
 * `{type:'stream_event', event:{...Anthropic Messages wire event}}` and whole
 * messages arrive as `{type:'assistant'|'user', message:{content:[...]}}`,
 * followed by `{type:'result', ...}`. The wire-format machinery is shared with
 * the grok adapter, which emits the same events without the wrapper.
 */

import type { VerseSession, VerseTurnLaunch, VerseUsage } from '../types.js';
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

function toVerseUsage(totals: AnthropicUsage, last: AnthropicUsage): VerseUsage {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheCreationTokens: totals.cacheCreation,
    // Live context occupancy = prompt size of the most recent API call.
    contextTokens: last.input + last.cacheRead + last.cacheCreation,
    contextWindow: null,
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
 *   - claude's whole-message envelopes `assistant` / `user` and the terminal `result`;
 *   - `system` (`init` captures session_id).
 *
 * A text/tool_use/thinking block can arrive twice — once via the streamed
 * content_block_* events and again inside an `assistant` envelope — so block
 * events are deduplicated by content within a turn.
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
  const open = new Map<number, OpenBlock>();
  const emittedText = new Set<string>();
  const emittedThinking = new Set<string>();
  const emittedToolUse = new Set<string>();
  const emittedToolResult = new Set<string>();
  let lastCallUsage: AnthropicUsage | null = null;
  let turnTotals: AnthropicUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let resultTotals: AnthropicUsage | null = null;
  let usageEmitted = false;
  // message_start carries input-side usage, message_delta the output side; they
  // describe the same API call, so merge them before rolling into the totals.
  let pendingCall: AnthropicUsage | null = null;

  function commitPendingCall(): void {
    if (!pendingCall) return;
    lastCallUsage = pendingCall;
    turnTotals = {
      input: turnTotals.input + pendingCall.input,
      output: turnTotals.output + pendingCall.output,
      cacheRead: turnTotals.cacheRead + pendingCall.cacheRead,
      cacheCreation: turnTotals.cacheCreation + pendingCall.cacheCreation,
    };
    pendingCall = null;
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
    commitPendingCall();
    const totals = resultTotals ?? turnTotals;
    const last = lastCallUsage ?? resultTotals;
    if (!last) return;
    usageEmitted = true;
    out.push({ type: 'usage', turnId, usage: toVerseUsage(totals, last) });
  }

  function handleWireEvent(out: VerseParsedEvent[], ev: JsonObject): void {
    const type = str(ev['type']);
    switch (type) {
      case 'message_start': {
        commitPendingCall();
        const message = isObject(ev['message']) ? ev['message'] : null;
        const usage = readAnthropicUsage(message?.['usage']);
        if (usage) pendingCall = usage;
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
          if (pendingCall) {
            pendingCall = {
              input: usage.input || pendingCall.input,
              output: usage.output || pendingCall.output,
              cacheRead: usage.cacheRead || pendingCall.cacheRead,
              cacheCreation: usage.cacheCreation || pendingCall.cacheCreation,
            };
          } else {
            pendingCall = usage;
          }
        }
        return;
      }
      case 'message_stop': {
        for (const index of [...open.keys()]) closeBlock(out, index);
        commitPendingCall();
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
        if (ev['subtype'] === 'init' && typeof ev['session_id'] === 'string') nativeId = ev['session_id'];
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
          const usage = readAnthropicUsage(message['usage']);
          if (usage) {
            pendingCall = null;
            lastCallUsage = usage;
            turnTotals = {
              input: turnTotals.input + usage.input,
              output: turnTotals.output + usage.output,
              cacheRead: turnTotals.cacheRead + usage.cacheRead,
              cacheCreation: turnTotals.cacheCreation + usage.cacheCreation,
            };
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

function buildClaudeLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch {
  if (!session.nativeSessionId) {
    throw new Error('claude session is missing its native session id');
  }
  const prefix = session.engine === 'local' || !launch.launcher ? ['claude'] : [...launch.launcher];
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
    '--model', session.model,
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    ...(session.turnCount > 0 ? ['--resume', session.nativeSessionId] : ['--session-id', session.nativeSessionId]),
    '--', text,
  ];
  const env: Record<string, string> = session.engine === 'local'
    ? {
      // The launch record's dispatch address wins; `ollamaBaseUrl` is the
      // default lane and the fallback for records written before lanes existed.
      ANTHROPIC_BASE_URL: anthropicEnvBaseUrl(launch.anthropicBaseUrl ?? launch.ollamaBaseUrl),
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    : {};
  return { argv, cwd: session.projectPath, env, stdin: null };
}

export const claudeAdapter: VerseAdapter = {
  buildLaunch: buildClaudeLaunch,
  createParser: createAnthropicStreamParser,
};
