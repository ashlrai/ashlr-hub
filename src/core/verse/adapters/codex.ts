/**
 * Codex adapter.
 *
 * Launch: turn 1 is `codex exec --json --model <m> --cd <cwd> --sandbox
 * workspace-write -` with the prompt on stdin; later turns are
 * `codex exec resume <thread_id> --json -` (also stdin). The thread id is not
 * known until the first turn's `thread.started` line, so `nativeSessionId`
 * is null until then and the engine adopts it from `turn-done`.
 *
 * Parse (codex JSONL; shapes as consumed by src/core/run/engines.ts
 * normaliseEngineOutputLine and src/core/resources/worker.ts parseCodex):
 *   thread.started{thread_id}
 *   item.started/item.completed{item:{id,type:'agent_message'|'command_execution'|
 *     'file_change'|'mcp_tool_call'|'reasoning', ...}}
 *   turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens}}
 *   turn.failed{error:{message}} / error{message}
 */

import type { VerseSession, VerseTurnLaunch } from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import type { VerseAdapter, VerseParsedEvent, VerseTurnParser } from './index.js';
import { parseJsonObjectLine } from './claude.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

function buildCodexLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch {
  const prefix = launch.launcher ? [...launch.launcher] : ['codex'];
  const argv = session.turnCount > 0 && session.nativeSessionId
    ? [...prefix, 'exec', 'resume', session.nativeSessionId, '--json', '-']
    : [...prefix, 'exec', '--json', '--model', session.model, '--cd', session.projectPath, '--sandbox', 'workspace-write', '-'];
  return { argv, cwd: session.projectPath, env: {}, stdin: text };
}

/** Describe a tool-like codex item for the `tool-use` event. */
function describeItem(item: JsonObject): { name: string; input: unknown } {
  const type = str(item['type']);
  if (type === 'command_execution') {
    return { name: 'command_execution', input: { command: item['command'] ?? '', cwd: item['cwd'] ?? undefined } };
  }
  if (type === 'file_change') {
    return { name: 'file_change', input: { changes: item['changes'] ?? [] } };
  }
  if (type === 'mcp_tool_call') {
    const server = str(item['server']);
    const tool = str(item['tool']);
    return { name: server && tool ? `mcp:${server}.${tool}` : 'mcp_tool_call', input: item['arguments'] ?? {} };
  }
  return { name: type || 'item', input: {} };
}

/** Render the result side of a completed tool-like codex item. */
function describeResult(item: JsonObject): { output: string; isError: boolean } {
  const type = str(item['type']);
  const status = str(item['status']);
  const failed = status === 'failed' || status === 'error' || status === 'declined';
  if (type === 'command_execution') {
    const exitCode = item['exit_code'];
    const output = str(item['aggregated_output']) || str(item['output']);
    const codeFailed = typeof exitCode === 'number' && exitCode !== 0;
    return { output, isError: failed || codeFailed };
  }
  if (type === 'file_change') {
    const changes = Array.isArray(item['changes']) ? item['changes'] : [];
    const summary = changes
      .map((change) => (isObject(change) ? `${str(change['kind']) || 'change'} ${str(change['path'])}`.trim() : ''))
      .filter((s) => s.length > 0)
      .join('\n');
    return { output: summary || (failed ? 'file change failed' : 'file change applied'), isError: failed };
  }
  if (type === 'mcp_tool_call') {
    const result = item['result'];
    const error = item['error'];
    if (error !== undefined && error !== null) {
      return { output: isObject(error) ? str(error['message']) || safeJson(error) : String(error), isError: true };
    }
    return { output: typeof result === 'string' ? result : safeJson(result ?? ''), isError: failed };
  }
  return { output: safeJson(item), isError: failed };
}

const TOOL_ITEM_TYPES = new Set(['command_execution', 'file_change', 'mcp_tool_call']);

export function createCodexParser(turnId: string): VerseTurnParser {
  let threadId: string | null = null;
  const startedTools = new Set<string>();
  const completedTools = new Set<string>();
  const emittedMessages = new Set<string>();
  let usage: VerseParsedEvent | null = null;
  let usageEmitted = false;

  function handleItem(out: VerseParsedEvent[], phase: 'started' | 'completed', item: JsonObject): void {
    const type = str(item['type']);
    const id = str(item['id']);
    if (type === 'agent_message') {
      if (phase !== 'completed') return;
      const text = str(item['text']);
      const key = id || text;
      if (!text || emittedMessages.has(key)) return;
      emittedMessages.add(key);
      out.push({ type: 'assistant-message', turnId, text });
      return;
    }
    if (type === 'reasoning') {
      if (phase !== 'completed') return;
      const text = str(item['text']);
      if (text) out.push({ type: 'thinking', turnId, text });
      return;
    }
    if (!TOOL_ITEM_TYPES.has(type)) return;
    const toolUseId = id || `${type}:${startedTools.size + completedTools.size + 1}`;
    if (!startedTools.has(toolUseId)) {
      startedTools.add(toolUseId);
      const described = describeItem(item);
      out.push({ type: 'tool-use', turnId, toolUseId, name: described.name, input: described.input });
    }
    if (phase === 'completed' && !completedTools.has(toolUseId)) {
      completedTools.add(toolUseId);
      const result = describeResult(item);
      out.push({ type: 'tool-result', turnId, toolUseId, output: result.output, isError: result.isError });
    }
  }

  function handle(out: VerseParsedEvent[], ev: JsonObject): void {
    const type = str(ev['type']);
    switch (type) {
      case 'thread.started': {
        const id = str(ev['thread_id']);
        if (id) threadId = id;
        return;
      }
      case 'item.started':
      case 'item.completed': {
        if (isObject(ev['item'])) handleItem(out, type === 'item.started' ? 'started' : 'completed', ev['item']);
        return;
      }
      case 'turn.completed': {
        const u = isObject(ev['usage']) ? ev['usage'] : null;
        if (u) {
          const input = num(u['input_tokens']);
          const cached = num(u['cached_input_tokens']);
          usage = {
            type: 'usage',
            turnId,
            usage: {
              // codex's input_tokens already includes the cached portion, so
              // split it: the session totals (engine sums input + cache read)
              // must count each token once.
              inputTokens: Math.max(0, input - cached),
              outputTokens: num(u['output_tokens']),
              cacheReadTokens: Math.min(cached, input),
              cacheCreationTokens: 0,
              // `exec --json` has no per-call prompt size — only the turn
              // total across every model call — so the codex context meter is
              // a per-turn UPPER BOUND; the engine clamps it to the window.
              contextTokens: input,
              contextWindow: null,
            },
          };
        }
        return;
      }
      case 'turn.failed':
      case 'error': {
        const error = ev['error'];
        const message = isObject(error) ? str(error['message']) : str(error) || str(ev['message']);
        out.push({ type: 'error', turnId, message: `codex: ${message || type}` });
        return;
      }
      default:
        return;
    }
  }

  return {
    push(line: string): VerseParsedEvent[] {
      const ev = parseJsonObjectLine(line);
      if (!ev) return [];
      const out: VerseParsedEvent[] = [];
      try { handle(out, ev); } catch { /* never throw on odd input */ }
      return out;
    },
    finish(_exitCode: number | null): VerseParsedEvent[] {
      // Exit-code errors are the engine's to report (it also has the stderr tail).
      const out: VerseParsedEvent[] = [];
      if (usage && !usageEmitted) {
        usageEmitted = true;
        out.push(usage);
      }
      return out;
    },
    nativeSessionId(): string | null {
      return threadId;
    },
  };
}

export const codexAdapter: VerseAdapter = {
  buildLaunch: buildCodexLaunch,
  createParser: createCodexParser,
};
