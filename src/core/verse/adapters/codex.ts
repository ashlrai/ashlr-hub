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

import { verseSessionRoots, type VerseSession, type VerseTurnLaunch } from '../types.js';
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

/**
 * One TOML string literal. Codex parses a `-c key=value` value AS TOML, so a
 * path has to be quoted and escaped the way TOML expects — a directory with a
 * quote or a backslash in its name would otherwise change the shape of the
 * array rather than sitting inside it.
 */
function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    // TOML basic strings forbid RAW control characters; they must be escaped.
    // Written as a scan rather than a regex character class on purpose: a
    // class spelling this range puts literal control bytes in the source
    // (and trips `no-control-regex`).
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

/**
 * Grant the extra roots the SAME sandbox treatment as the primary.
 *
 * WHY A CONFIG OVERRIDE RATHER THAN `--add-dir`, verified on codex-cli 0.136.0:
 *
 *   `codex exec --help`         has `--add-dir <DIR>  Additional directories
 *                               that should be writable alongside the primary
 *                               workspace`
 *   `codex exec resume --help`  has NEITHER `--add-dir` NOR `--cd`. It does
 *                               have `-c, --config <key=value>`.
 *
 * Turn 1 and turn 2 of one chat must grant the same write set, or the agent
 * reads a file on turn 3 that it could edit on turn 1 and produces a diff
 * that will not apply. `--add-dir` cannot express that on resume, so BOTH
 * turns use the config override instead of splitting the mechanism.
 *
 * `sandbox_workspace_write.writable_roots` was verified as a real, correctly
 * typed config key rather than recalled: `codex exec --strict-config -c
 * 'zzz_not_a_key.bogus=1' …` fails with "unknown configuration field
 * `zzz_not_a_key`", `-c 'sandbox_workspace_write.zzz_bogus_subfield=1'` fails
 * with "unknown configuration field `sandbox_workspace_write.
 * zzz_bogus_subfield`", and `-c 'sandbox_workspace_write.writable_roots=
 * ["/tmp"]'` passes config loading and starts the run.
 */
function writableRootsOverride(extraRoots: readonly string[]): string[] {
  if (extraRoots.length === 0) return [];
  const array = extraRoots.map(tomlString).join(',');
  return ['-c', `sandbox_workspace_write.writable_roots=[${array}]`];
}

function buildCodexLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch {
  const prefix = launch.launcher ? [...launch.launcher] : ['codex'];
  const extraRoots = verseSessionRoots(session).slice(1);
  const writable = writableRootsOverride(extraRoots);
  const argv = session.turnCount > 0 && session.nativeSessionId
    ? [...prefix, 'exec', 'resume', session.nativeSessionId, ...writable, '--json', '-']
    : [...prefix, 'exec', ...writable, '--json', '--model', session.model, '--cd', session.projectPath, '--sandbox', 'workspace-write', '-'];
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
