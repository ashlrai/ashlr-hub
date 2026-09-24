/**
 * Codex adapter.
 *
 * Launch: turn 1 is `codex exec [-c …] --json --model <m> --cd <cwd> --sandbox
 * workspace-write -` with the prompt on stdin; later turns are
 * `codex exec resume <thread_id> [-c …] --json -` (also stdin). The thread id is
 * not known until the first turn's `thread.started` line, so `nativeSessionId`
 * is null until then and the engine adopts it from `turn-done`.
 *
 * Every per-session setting rides on `-c key=value` config overrides, never on
 * flags, because `exec resume` accepts `-c` but not `--add-dir`/`--cd`: turn 1
 * and turn N of one chat must be launched with the SAME settings. Overrides:
 *   - `sandbox_workspace_write.writable_roots` — extra workspace roots, plus the
 *     shared project-memory directory when this session may write it;
 *   - `model_context_window` + `model_auto_compact_token_limit` — expansive
 *     mode only, ALWAYS as a pair (raising only the window breaks codex's
 *     auto-compaction, openai/codex#16068);
 *   - `developer_instructions` — the shared project-memory block.
 * Each key was verified as a KNOWN, correctly typed config field on both
 * pinned binaries (0.136.0 and 0.155.0-alpha.9.2), on `exec` and `exec
 * resume`, with `--strict-config` and an empty scratch CODEX_HOME — see
 * `strictConfigVerified` below for the no-spend method.
 *
 * Parse (codex JSONL; shapes as consumed by src/core/run/engines.ts
 * normaliseEngineOutputLine and src/core/resources/worker.ts parseCodex):
 *   thread.started{thread_id}
 *   item.started/item.completed{item:{id,type:'agent_message'|'command_execution'|
 *     'file_change'|'mcp_tool_call'|'reasoning', ...}}
 *   turn.completed{usage:{input_tokens,cached_input_tokens,[cache_write_input_tokens],output_tokens}}
 *   turn.failed{error:{message}} / error{message}
 *
 * V3.10 live reasoning + errors:
 *   - `-c model_reasoning_summary="detailed"` on exec AND exec resume while the
 *     `thinkingDisplay` preference is on. The seats have no config.toml, so
 *     codex used `auto`: only 17% of reasoning items carried any text (median
 *     32-47 chars of bold headers) vs a 1,100-char median with `detailed`,
 *     measured on this machine's own rollouts.
 *   - `--skip-git-repo-check` on every turn: without it codex refuses any
 *     non-git folder ("Not inside a trusted directory") before it even starts.
 *   - reasoning items → `thinking {kind:'summary', durationMs}` (an item with
 *     no text → `redacted`), item starts → transient `progress`, and failures
 *     carry a `code` (`native-thread-missing` for a vanished thread).
 *
 * Telemetry (V3.9): stdout never carries per-call context, so the exact meter,
 * the window, compactions and the TRUE per-turn usage come from the thread's
 * own rollout file (core/verse/codex-rollout.ts) via `pollTelemetry` (live)
 * and `afterTurn` (final). See `afterCodexTurn` for why the turn's `usage`
 * event is emitted there rather than from the parser.
 */

import {
  budgetFor,
  canonicalModelId,
  CODEX_EFFECTIVE_WINDOW_PERCENT,
  codexAutoCompactAt,
} from '../context-math.js';
import {
  advanceCodexTurnTracker,
  codexNativeStatePath,
  codexTotals,
  codexTurnUsage,
  createCodexTurnTracker,
  isCodexThreadId,
  locateCodexRollout,
  type CodexTokenTotals,
  type CodexTurnTracker,
} from '../codex-rollout.js';
import { legacyModelOptionFallback } from '../model-windows.js';
import { verseSessionRoots, type VerseModelOption, type VerseSession, type VerseTurnLaunch, type VerseUsage } from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import type { VerseAdapter, VerseAdapterTurnContext, VerseParsedEvent, VerseTurnParser } from './index.js';
import { cliErrorEvent, classifyVerseCliError, nativeSessionOverride, parseJsonObjectLine, thinkingDisplayEnabled } from './claude.js';
import type { VerseProgressPhase } from '../types.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
function writableRootsOverride(roots: readonly string[]): string[] {
  const unique = [...new Set(roots.filter((root) => typeof root === 'string' && root.length > 0))];
  if (unique.length === 0) return [];
  const array = unique.map(tomlString).join(',');
  return ['-c', `sandbox_workspace_write.writable_roots=[${array}]`];
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * The seat option a session's model resolves to: the exact stored id first,
 * then its canonical form — the same lookup the engine uses, so the flags the
 * CLI is given and the budget the meter shows come from one option.
 *
 * A launch snapshot written before 3.9 lists `{id, label, contextWindow}` and
 * no budgets, so it would deny an expansive mode the live seat (and so the
 * UI) offers for the same model. `legacyModelOptionFallback` — the one rule the
 * engine's `effectiveModelOption` also applies — borrows the documented
 * budgets for such a snapshot, so a switch the engine accepts is a switch
 * this adapter actually carries out.
 */
function modelOptionFor(launch: VerseSeatLaunch, model: string): VerseModelOption | null {
  const models = Array.isArray(launch.seat?.models) ? launch.seat.models : [];
  const wanted = canonicalModelId(model);
  const snapshot = models.find((m) => m.id === model) ?? models.find((m) => canonicalModelId(m.id) === wanted) ?? null;
  return legacyModelOptionFallback('codex', model, snapshot);
}

/**
 * Expansive mode → the config pair that makes codex measure against, and
 * compact inside, the model's catalog maximum. BOTH keys or neither: codex
 * resets its token accounting when only `model_context_window` is set and
 * then never auto-compacts (openai/codex#16068), so a half-applied override
 * is worse than none.
 *
 * `providerWindow` is the RAW window codex must be told (872_000 for GPT-6 /
 * GPT-5.6); codex itself then measures against 95% of it (828_400), which is
 * the budget's `contextWindow`. An older option that carries only the
 * effective window is inverted through the same 95% — never guessed upward.
 *
 * Standard mode passes nothing: codex's own catalog budget applies, and a
 * session switched back from expansive simply stops sending the pair.
 */
export function codexContextOverrides(session: Pick<VerseSession, 'contextMode' | 'model'>, launch: VerseSeatLaunch): string[] {
  if (session.contextMode !== 'expansive') return [];
  const budget = budgetFor(modelOptionFor(launch, session.model), 'expansive');
  if (!budget) return [];
  const effective = positiveInt(budget.contextWindow);
  const providerWindow = positiveInt(budget.providerWindow ?? null)
    ?? (effective !== null ? Math.round((effective * 100) / CODEX_EFFECTIVE_WINDOW_PERCENT) : null);
  if (providerWindow === null) return [];
  const limit = Math.min(positiveInt(budget.autoCompactAt) ?? codexAutoCompactAt(providerWindow), providerWindow);
  return ['-c', `model_context_window=${providerWindow}`, '-c', `model_auto_compact_token_limit=${limit}`];
}

/** The launch's pinned project memory, when it is well-formed. */
function memoryOf(launch: VerseSeatLaunch): { dir: string; block: string; writable: boolean } | null {
  const memory = launch.memory;
  if (!memory || typeof memory !== 'object') return null;
  const { dir, block, writable } = memory;
  if (typeof dir !== 'string' || !dir.startsWith('/') || typeof block !== 'string' || block.trim().length === 0) return null;
  return { dir, block, writable: writable === true };
}

/**
 * Shared project memory → codex.
 *
 *  - The block rides as `developer_instructions` on EVERY turn — `exec` AND
 *    every `exec resume` — byte-identical (it was snapshotted at
 *    createSession), so the prompt prefix — and with it the provider's prompt
 *    cache — is stable, and a compaction cannot summarise it away the way it
 *    would a first-turn stdin prefix.
 *  - The memory directory joins the sandbox's writable roots only when this
 *    session may write it (`writable === true` exactly; anything else is
 *    read-only). Reading needs no grant: workspace-write keeps the whole disk
 *    readable.
 *
 * WHY resending does not append the block to the thread every turn, and why
 * sending it on turn 1 only would be WRONG (checked 2026-09-23 without a model
 * call, against this machine's ~4,000 real rollouts and both pinned binaries):
 *  - Codex persists a context BASELINE in the rollout and diffs each new turn
 *    against it; resume restores the baseline from the file. 0.136 (codex-a)
 *    documents its TurnContextItem as "persist once per real user turn after
 *    computing that turn's model-visible context updates … so resume/fork
 *    replay can recover the latest durable baseline". 0.142+ (codex-b's
 *    0.155) writes `world_state` records instead — one `full` snapshot, then
 *    `full:false` records carrying ONLY the sections that changed — and
 *    `managed_developer_instructions` (this config key) is one of those
 *    sections ("failed to restore world-state section snapshot" in 0.155).
 *  - Observed: an unchanged fragment is never re-sent mid-thread. In main
 *    threads, `<skills_instructions>` was re-emitted 53 times — all with a
 *    CHANGED text, 0 identical — and `<permissions instructions>` 6 times, 5
 *    changed plus 1 forced by a model switch; 72 turns resumed after >6 h idle
 *    (process restarts) re-emitted nothing. So an identical block is a no-op.
 *  - Compaction rebuilds the full developer context from the CURRENT
 *    process's settings (526 of 537 compacted records carry the permissions
 *    and skills blocks in `replacement_history`). A resume launched WITHOUT
 *    the key would therefore lose the memory block at its first compaction
 *    (and on 0.142+ record the section as changed to empty).
 *  Honest gap: no rollout here has ever carried a non-empty
 *  developer_instructions (all 1,351 `managed_developer_instructions`
 *  snapshots are `{}`), and no `codex exec resume` thread exists locally, so
 *  the no-duplication claim rests on the sibling sections above. If a real
 *  multi-turn rollout ever shows the block repeating, the fix is NOT turn-1
 *  only (see compaction) but upstream.
 */
function memoryOverrides(launch: VerseSeatLaunch): { writableRoots: string[]; config: string[] } {
  const memory = memoryOf(launch);
  if (!memory) return { writableRoots: [], config: [] };
  return {
    writableRoots: memory.writable ? [memory.dir] : [],
    config: ['-c', `developer_instructions=${tomlString(memory.block)}`],
  };
}

/**
 * How the config keys above were verified WITHOUT a model call (2026-09-23):
 * `CODEX_HOME=<empty scratch dir> codex exec [resume <id>] --strict-config
 * -c <key>=<value> -c 'model_instructions_file="/nonexistent"' --json -`.
 * An unknown key fails config loading ("unknown configuration field"); a
 * known one gets past it and stops at the missing instructions file — before
 * authentication, so nothing can reach a provider. Kept as data so the method
 * travels with the keys it vouches for.
 */
export const strictConfigVerified: readonly string[] = [
  'sandbox_workspace_write.writable_roots',
  'model_context_window',
  'model_auto_compact_token_limit',
  'developer_instructions',
  // V3.10, same method on 0.136.0 (homebrew) and 0.155.0-alpha.9.2 (the
  // seats' ChatGPT.app binary), exec AND exec resume: `"detailed"` passes
  // config loading, `"bogusvalue"` fails with "unknown variant `bogusvalue`,
  // expected one of `auto`, `concise`, `detailed`, `none`".
  'model_reasoning_summary',
];

/**
 * Reasoning summaries for this turn: `detailed` while live reasoning is on,
 * nothing otherwise (codex then keeps its own default). Sent on every turn,
 * like the other overrides, so a resumed turn reasons out loud as turn 1 did.
 */
export function codexReasoningOverrides(launch: VerseSeatLaunch): string[] {
  return thinkingDisplayEnabled(launch) ? ['-c', 'model_reasoning_summary="detailed"'] : [];
}

/**
 * `--skip-git-repo-check`, on `exec` and `exec resume` (both list it in
 * `--help` on 0.136.0 and 0.155.0-alpha.9.2). Verse already confines the
 * agent to the session's roots; codex's own "trusted git directory" gate only
 * made every non-git project fail turn 1 before authentication.
 */
const CODEX_SKIP_GIT_CHECK = '--skip-git-repo-check';

/**
 * Whether this turn is `exec resume <thread>` (true) or a fresh `exec`.
 * The thread id only exists once a turn printed it, so resuming needs one.
 * The engine may force a fresh thread (recovering a vanished one) with
 * `nativeSession: 'new'`, or a resume with `'resume'`; otherwise a thread that
 * already ran a turn is resumed. Shared by the launch and `afterTurn` (whose
 * usage arithmetic differs for a thread's first turn).
 */
export function codexResumes(session: Pick<VerseSession, 'nativeSessionId' | 'turnCount'>, launch: VerseSeatLaunch | null | undefined): boolean {
  if (!session.nativeSessionId) return false;
  const override = launch ? nativeSessionOverride(launch) : null;
  if (override === 'new') return false;
  return override === 'resume' || session.turnCount > 0;
}

function buildCodexLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch {
  const prefix = launch.launcher ? [...launch.launcher] : ['codex'];
  const memory = memoryOverrides(launch);
  const config = [
    ...writableRootsOverride([...verseSessionRoots(session).slice(1), ...memory.writableRoots]),
    ...codexContextOverrides(session, launch),
    ...memory.config,
    ...codexReasoningOverrides(launch),
  ];
  const argv = codexResumes(session, launch) && session.nativeSessionId
    ? [...prefix, 'exec', 'resume', session.nativeSessionId, ...config, CODEX_SKIP_GIT_CHECK, '--json', '-']
    // Always the CANONICAL id: a stored alias (e.g. a pre-3.9 record) must
    // reach the CLI as the model the label promised.
    : [...prefix, 'exec', ...config, CODEX_SKIP_GIT_CHECK, '--json', '--model', canonicalModelId(session.model), '--cd', session.projectPath, '--sandbox', 'workspace-write', '-'];
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

/** Options for the codex parser. `now` is the clock (a test seam). */
export interface CodexParserOptions {
  now?: () => number;
}

export function createCodexParser(turnId: string, options: CodexParserOptions = {}): VerseTurnParser {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const turnStartedAt = now();
  let threadId: string | null = null;
  const startedTools = new Set<string>();
  const completedTools = new Set<string>();
  const emittedMessages = new Set<string>();
  /** Reasoning item id → when its `item.started` arrived (thinking duration). */
  const reasoningStartedAt = new Map<string, number>();
  const emittedReasoning = new Set<string>();
  let reported: CodexTokenTotals | null = null;
  let phase: VerseProgressPhase | null = null;
  let phaseTool: string | null = null;

  /**
   * Transient `progress` on a phase/tool change. Codex prints no streaming
   * token counts, so `outTokens`/`tokPerSec` stay absent (unmeasured).
   */
  function setPhase(out: VerseParsedEvent[], next: VerseProgressPhase, tool: string | null = null): void {
    if (phase === next && phaseTool === tool) return;
    phase = next;
    phaseTool = tool;
    const event: Extract<VerseParsedEvent, { type: 'progress' }> = {
      type: 'progress',
      turnId,
      phase: next,
      elapsedMs: Math.max(0, Math.round(now() - turnStartedAt)),
    };
    if (tool) event.tool = tool;
    out.push(event);
  }

  function handleReasoning(out: VerseParsedEvent[], phaseName: 'started' | 'completed', item: JsonObject): void {
    const id = str(item['id']);
    if (phaseName === 'started') {
      if (id && !reasoningStartedAt.has(id)) reasoningStartedAt.set(id, now());
      setPhase(out, 'thinking');
      return;
    }
    const text = str(item['text']);
    // Dedupe by item id; an id-less item by its text (codex always sends ids).
    const key = id || `text:${text}`;
    if (emittedReasoning.has(key)) return;
    emittedReasoning.add(key);
    const event: Extract<VerseParsedEvent, { type: 'thinking' }> = { type: 'thinking', turnId, text };
    if (text) {
      // Hosted codex models never return raw chain of thought; the text is
      // the summary `model_reasoning_summary` asked for.
      event.kind = 'summary';
    } else {
      // The model reasoned but no summary text came back (encrypted content
      // only): keep the marker so the UI can say it thought.
      event.redacted = true;
    }
    const startedAt = id ? reasoningStartedAt.get(id) : undefined;
    if (startedAt !== undefined) {
      event.durationMs = Math.max(0, Math.round(now() - startedAt));
      reasoningStartedAt.delete(id);
    }
    out.push(event);
  }

  function handleItem(out: VerseParsedEvent[], phaseName: 'started' | 'completed', item: JsonObject): void {
    const type = str(item['type']);
    const id = str(item['id']);
    if (type === 'agent_message') {
      if (phaseName !== 'completed') {
        setPhase(out, 'writing');
        return;
      }
      const text = str(item['text']);
      const key = id || text;
      if (!text || emittedMessages.has(key)) return;
      emittedMessages.add(key);
      out.push({ type: 'assistant-message', turnId, text });
      return;
    }
    if (type === 'reasoning') {
      handleReasoning(out, phaseName, item);
      return;
    }
    if (!TOOL_ITEM_TYPES.has(type)) return;
    const toolUseId = id || `${type}:${startedTools.size + completedTools.size + 1}`;
    if (!startedTools.has(toolUseId)) {
      startedTools.add(toolUseId);
      const described = describeItem(item);
      out.push({ type: 'tool-use', turnId, toolUseId, name: described.name, input: described.input });
      // The same name as the tool-use event, so the UI labels both one way.
      setPhase(out, 'tool', described.name);
    }
    if (phaseName === 'completed' && !completedTools.has(toolUseId)) {
      completedTools.add(toolUseId);
      const result = describeResult(item);
      out.push({ type: 'tool-result', turnId, toolUseId, output: result.output, isError: result.isError });
      setPhase(out, 'waiting');
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
      case 'turn.started': {
        setPhase(out, 'waiting');
        return;
      }
      case 'item.started':
      case 'item.completed': {
        if (isObject(ev['item'])) handleItem(out, type === 'item.started' ? 'started' : 'completed', ev['item']);
        return;
      }
      case 'turn.completed': {
        // Held, not emitted: see `afterCodexTurn`. On `exec resume` this figure
        // is the THREAD's running total, so only the rollout can say what this
        // turn used; the printed figure is the fallback when it cannot.
        const usage = codexTotals(ev['usage']);
        if (usage) reported = usage;
        return;
      }
      case 'turn.failed':
      case 'error': {
        const error = ev['error'];
        const message = isObject(error) ? str(error['message']) : str(error) || str(ev['message']);
        out.push(cliErrorEvent(turnId, 'codex', message || type));
        return;
      }
      default:
        return;
    }
  }

  /**
   * A non-JSON stdout line is codex itself talking. Only a sentence Verse
   * acts on (a vanished thread) becomes an `error`; the rest stays dropped.
   */
  let plainErrorEmitted = false;
  function handlePlainLine(line: string): VerseParsedEvent[] {
    const text = line.trim();
    if (!text || plainErrorEmitted || classifyVerseCliError(text) === null) return [];
    plainErrorEmitted = true;
    return [cliErrorEvent(turnId, 'codex', text.replace(/^error:\s*/i, '').slice(0, 1_000))];
  }

  const parser: VerseTurnParser = {
    push(line: string): VerseParsedEvent[] {
      if (typeof line !== 'string') return [];
      const out: VerseParsedEvent[] = [];
      try {
        const ev = parseJsonObjectLine(line);
        if (!ev) return handlePlainLine(line);
        handle(out, ev);
      } catch { /* never throw on odd input */ }
      return out;
    },
    finish(_exitCode: number | null): VerseParsedEvent[] {
      // Exit-code errors are the engine's to report (it also has the stderr
      // tail); this turn's `usage` is emitted by `afterTurn`, which runs next.
      return [];
    },
    nativeSessionId(): string | null {
      return threadId;
    },
  };
  const read = (): CodexTokenTotals | null => reported;
  reportedUsage.set(parser, read);
  rememberByTurn(turnId, read);
  return parser;
}

// ---------------------------------------------------------------------------
// Telemetry hooks (V3.9)
// ---------------------------------------------------------------------------

/**
 * `turn.completed.usage` as the CLI printed it, per parser. A WeakMap rather
 * than a method so the frozen `VerseTurnParser` interface is untouched and
 * the figure dies with its parser.
 */
const reportedUsage = new WeakMap<VerseTurnParser, () => CodexTokenTotals | null>();

/**
 * The same getters keyed by turn id, for a hook context whose `parser` is a
 * WRAPPER around the codex parser (an engine or test that decorates parser
 * output). Bounded, and each entry is dropped once `afterTurn` has read it.
 */
const reportedByTurn = new Map<string, () => CodexTokenTotals | null>();
const MAX_TRACKED_TURNS = 64;

function rememberByTurn(turnId: string, read: () => CodexTokenTotals | null): void {
  if (typeof turnId !== 'string' || turnId.length === 0) return;
  reportedByTurn.delete(turnId);
  if (reportedByTurn.size >= MAX_TRACKED_TURNS) {
    const oldest = reportedByTurn.keys().next().value;
    if (oldest !== undefined) reportedByTurn.delete(oldest);
  }
  reportedByTurn.set(turnId, read);
}

/**
 * What the codex parser captured from `turn.completed`, or null (none printed
 * / not a codex parser). Looked up by parser identity, then by `turnId`.
 */
export function codexReportedUsage(parser: VerseTurnParser, turnId?: string): CodexTokenTotals | null {
  try {
    const read = reportedUsage.get(parser) ?? (turnId !== undefined ? reportedByTurn.get(turnId) : undefined);
    return read?.() ?? null;
  } catch {
    return null;
  }
}

/** Per-turn hook scratch, kept in `ctx.state` under this key. */
const STATE_KEY = 'codexRollout';

interface CodexHookState {
  tracker: CodexTurnTracker;
  /** Located rollout for this turn's thread (private path; never leaves this module). */
  file: string | null;
  /** The bounded full-tree search runs at most once per turn; later polls only probe the id's own date. */
  searched: boolean;
  /** Identity of the last `context` reading emitted, so a poll never repeats one. */
  emittedReading: string | null;
  /** Compactions already emitted (the tracker's list is append-only). */
  emittedCompactions: number;
}

function hookState(ctx: VerseAdapterTurnContext): CodexHookState {
  const existing = ctx.state[STATE_KEY] as CodexHookState | undefined;
  if (existing && typeof existing === 'object' && existing.tracker) return existing;
  const fresh: CodexHookState = {
    tracker: createCodexTurnTracker(),
    file: null,
    searched: false,
    emittedReading: null,
    emittedCompactions: 0,
  };
  ctx.state[STATE_KEY] = fresh;
  return fresh;
}

/**
 * Read whatever the thread's rollout gained since the last call. False when
 * there is nothing to read yet (no thread id, no pinned CODEX_HOME, no file).
 */
function observe(ctx: VerseAdapterTurnContext, state: CodexHookState): boolean {
  const threadId = ctx.nativeSessionId;
  if (!isCodexThreadId(threadId)) return false;
  const nativeState = codexNativeStatePath(ctx.launch?.launcher ?? null);
  if (!nativeState) return false;
  if (!state.file) {
    state.file = locateCodexRollout(nativeState, threadId, { fullScan: !state.searched });
    state.searched = true;
    if (!state.file) return false;
  }
  if (advanceCodexTurnTracker(state.tracker, state.file, ctx.startedAt, threadId)) return true;
  // Pruned or replaced mid-turn: look it up again next time.
  state.file = null;
  return false;
}

/**
 * Whether the tracker's latest reading describes the context NOW. A reading
 * this turn produced always does. One left over from the previous turn does
 * only when this turn demonstrably made no model call — otherwise the prompt
 * has grown past it and presenting it as exact would understate occupancy.
 */
function currentReading(state: CodexHookState, reported: CodexTokenTotals | null): CodexTurnTracker['reading'] {
  const reading = state.tracker.initialized ? state.tracker.reading : null;
  if (!reading) return null;
  if (reading.inTurn) return reading;
  const noCallsThisTurn = state.tracker.calls === 0 && (!reported || reported.inputTokens === 0);
  return noCallsThisTurn ? reading : null;
}

function compactionEvents(ctx: VerseAdapterTurnContext, state: CodexHookState, final: boolean): VerseParsedEvent[] {
  const out: VerseParsedEvent[] = [];
  const all = state.tracker.compactions;
  while (state.emittedCompactions < all.length) {
    const compaction = all[state.emittedCompactions]!;
    // Mid-turn, wait for the post-compaction reading so the divider can say
    // "240k → 35k"; after the turn, emit what is known.
    if (!final && compaction.postTokens === null) break;
    state.emittedCompactions += 1;
    out.push({
      type: 'compaction',
      turnId: ctx.turnId,
      // `exec` has no manual compact verb; every rollout compaction is codex's own.
      trigger: 'auto',
      preTokens: compaction.preTokens,
      postTokens: compaction.postTokens,
      durationMs: null,
    });
  }
  return out;
}

function contextEvent(ctx: VerseAdapterTurnContext, reading: NonNullable<CodexTurnTracker['reading']>): VerseParsedEvent {
  return { type: 'context', turnId: ctx.turnId, contextTokens: reading.tokens, contextWindow: reading.window, exact: true };
}

/** Codex usage totals → Verse's disjoint buckets (codex's input INCLUDES cached and cache-write tokens). */
function verseUsageFrom(totals: CodexTokenTotals): Pick<VerseUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'> {
  const input = totals.inputTokens;
  const cacheRead = Math.min(totals.cachedInputTokens, input);
  const cacheWrite = Math.min(totals.cacheWriteInputTokens, input - cacheRead);
  return {
    inputTokens: input - cacheRead - cacheWrite,
    outputTokens: totals.outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
  };
}

/**
 * Live meter: while the turn runs, every new `token_count` becomes an exact
 * `context` reading, and a compaction becomes a divider as soon as the
 * reading after it lands. Never emits usage (that is `afterTurn`'s, once).
 */
export function pollCodexTelemetry(ctx: VerseAdapterTurnContext): VerseParsedEvent[] {
  try {
    const state = hookState(ctx);
    if (!observe(ctx, state)) return [];
    const out = compactionEvents(ctx, state, false);
    const reading = state.tracker.reading;
    if (reading?.inTurn) {
      const key = `${reading.offset}:${reading.tokens}:${reading.window ?? ''}`;
      if (key !== state.emittedReading) {
        state.emittedReading = key;
        out.push(contextEvent(ctx, reading));
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * After the process exits: any compactions not yet shown, then THE turn's
 * `usage` event, then the final exact `context` reading.
 *
 * WHY USAGE IS EMITTED HERE AND NOT BY THE PARSER. The engine SUMS `usage`
 * events into the session's totals, and codex's `turn.completed.usage` on
 * `exec resume` is the thread's running total (codex seeds its token counter
 * from the rollout on resume). Emitted from the parser, turn N would add turns
 * 1…N again. The parser runs before this hook and cannot read files, so it
 * holds the printed figure and this hook emits exactly one `usage` per turn
 * from the best evidence (`codexTurnUsage`): the CLI's own per-turn record,
 * else the sum of this turn's calls, else the printed figure — converted to a
 * delta when it matches the rollout's running total. With no readable rollout
 * the printed figure is used as-is, marked as an upper-bound reading.
 */
export function afterCodexTurn(ctx: VerseAdapterTurnContext): VerseParsedEvent[] {
  const out: VerseParsedEvent[] = [];
  let reported: CodexTokenTotals | null = null;
  try { reported = codexReportedUsage(ctx.parser, ctx.turnId); } catch { reported = null; }
  reportedByTurn.delete(ctx.turnId);
  let state: CodexHookState | null = null;
  try {
    state = hookState(ctx);
    observe(ctx, state);
    out.push(...compactionEvents(ctx, state, true));
  } catch {
    // Telemetry is best effort; the usage below still falls back to stdout.
  }

  try {
    const tracker = state?.tracker.initialized ? state.tracker : null;
    // The same decision the launch made: a forced fresh thread is a first turn.
    const firstTurn = !codexResumes(ctx.session, ctx.launch);
    const turn = codexTurnUsage(tracker, reported, firstTurn);
    const reading = state ? currentReading(state, reported) : null;
    if (turn) {
      const buckets = verseUsageFrom(turn.totals);
      out.push({
        type: 'usage',
        turnId: ctx.turnId,
        usage: {
          ...buckets,
          // Exact when the rollout says what is in context now; otherwise the
          // turn's own prompt total, an UPPER BOUND (it sums every call).
          contextTokens: reading ? reading.tokens : turn.totals.inputTokens,
          contextWindow: reading ? reading.window : tracker?.taskStartedWindow ?? null,
          contextTokensExact: reading !== null,
        },
      });
    }
    if (reading) out.push(contextEvent(ctx, reading));
  } catch {
    // Never let a telemetry failure take the turn's usage with it.
    if (reported && !out.some((event) => event.type === 'usage')) {
      out.push({
        type: 'usage',
        turnId: ctx.turnId,
        usage: { ...verseUsageFrom(reported), contextTokens: reported.inputTokens, contextWindow: null, contextTokensExact: false },
      });
    }
  }
  return out;
}

export const codexAdapter: VerseAdapter = {
  buildLaunch: buildCodexLaunch,
  createParser: (turnId: string) => createCodexParser(turnId),
  pollTelemetry: pollCodexTelemetry,
  afterTurn: afterCodexTurn,
};
