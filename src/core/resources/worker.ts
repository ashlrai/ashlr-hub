/** Explicit operator-owned worker transports; completion is not independent task verification. */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildOpenAICompatibleClient } from '../run/provider-client.js';
import { normalizeNumericLoopbackOllamaBaseUrl } from '../run/ollama-identity.js';
import { runVerifySubprocessAsync } from '../run/verify-commands.js';
import { MAX_RESOURCE_OBSERVATION_AGE_MS, validateResourcePool, type ResourceObservation, type ResourcePool, type ResourceWorker } from './pool-policy.js';
import { mergeClaudeResourceObservation } from './provider-observations.js';
import { validResourceNativeProcessSignal, type ResourceNativeProcessDiagnostic } from './native-diagnostics.js';

export type ResourceBinding =
  | { workerId: string; capacityKey: string; kind: 'native-cli'; command: string[] }
  | { workerId: string; capacityKey: string; kind: 'local-chat'; endpoint: string };
export interface ResourceWorkerTask {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  maxOutputTokens: number;
  mode: 'read-only' | 'workspace-write';
}
export interface ResourceWorkerResult {
  status: 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'uncertain';
  output: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Meaning of the existing paired counters, not total account usage or billing. */
  usageScope?: 'codex-turn' | 'claude-main-loop' | 'local-chat-completion';
  /** Fixed adapter code, never raw provider diagnostics or task text. */
  reason: string;
  /** Only after native subprocess invocation; never raw stdout/stderr or provider error text. */
  nativeProcess?: ResourceNativeProcessDiagnostic;
  /** Native quota metadata only; capture time is conservatively dispatch start. */
  observation?: ResourceObservation;
}

const MAX_BYTES = 1024 * 1024;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function array(value: unknown, min: number, max: number): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max &&
    Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, i) => i)
      .every((i) => Object.hasOwn(value, i) && 'value' in Object.getOwnPropertyDescriptor(value, i)!);
}
function identifier(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER.test(value); }
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
    Buffer.byteLength(value, 'utf8') <= limit;
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function sum(values: unknown[]): number | null {
  if (!values.every(count)) return null;
  const total = values.reduce((total, value) => total + value, 0);
  return count(total) ? total : null;
}
function empty(reason: string, status: ResourceWorkerResult['status'] = 'failed'): ResourceWorkerResult {
  return { status, output: '', inputTokens: null, outputTokens: null, reason };
}

/**
 * Bindings are trusted operator configuration, not model input. Prefix argv may
 * select an owner-authenticated wrapper; the adapter does not discover accounts,
 * accept credentials/environment overrides, or prove a wrapper's behavior.
 */
export function validateResourceBindings(value: unknown, pool: ResourcePool): ResourceBinding[] {
  const definition = validateResourcePool(pool);
  if (!array(value, 1, 32) || value.length !== definition.workers.length) throw new Error('Invalid resource bindings');
  const workers = new Map(definition.workers.map((worker) => [worker.id, worker]));
  const seen = new Set<string>(); const capacities = new Map<string, ResourceWorker>();
  const result: ResourceBinding[] = [];
  for (const row of value) {
    const kind = object(row) ? Object.getOwnPropertyDescriptor(row, 'kind')?.value : undefined;
    if (!object(row) || !exact(row, kind === 'native-cli'
      ? ['workerId', 'capacityKey', 'kind', 'command'] : ['workerId', 'capacityKey', 'kind', 'endpoint']) ||
        !identifier(row.workerId) || !identifier(row.capacityKey) || seen.has(row.workerId)) {
      throw new Error('Invalid resource bindings');
    }
    const worker = workers.get(row.workerId); const shared = capacities.get(row.capacityKey);
    if (!worker || (shared && (shared.provider !== worker.provider || shared.maxConcurrent !== worker.maxConcurrent ||
        shared.maxTasksPerWindow !== worker.maxTasksPerWindow || shared.taskWindowMs !== worker.taskWindowMs))) {
      throw new Error('Invalid resource bindings: shared capacity requires consistent provider and task bounds');
    }
    let binding: ResourceBinding;
    if (row.kind === 'native-cli' && worker.provider !== 'local' && array(row.command, 1, 32) &&
        row.command.every((arg) => text(arg, 4_096)) && isAbsolute(row.command[0] as string) &&
        row.command.reduce((bytes, arg) => bytes + Buffer.byteLength(arg as string, 'utf8'), 0) <= 16 * 1024) {
      const command = [...row.command] as string[]; Object.freeze(command);
      binding = { workerId: row.workerId, capacityKey: row.capacityKey, kind: 'native-cli', command };
    } else if (row.kind === 'local-chat' && worker.provider === 'local' && text(row.endpoint, 512)) {
      const endpoint = normalizeNumericLoopbackOllamaBaseUrl(row.endpoint);
      if (!endpoint) throw new Error('Invalid resource bindings: numeric loopback endpoint required');
      binding = { workerId: row.workerId, capacityKey: row.capacityKey, kind: 'local-chat', endpoint };
    } else throw new Error('Invalid resource bindings');
    seen.add(worker.id); capacities.set(row.capacityKey, worker); result.push(Object.freeze(binding));
  }
  return Object.freeze(result) as ResourceBinding[];
}

function validateTask(task: ResourceWorkerTask): ResourceWorkerTask {
  if (!object(task) || !exact(task, ['prompt', 'cwd', 'timeoutMs', 'maxOutputTokens', 'mode']) ||
      typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.includes('\0') ||
      Buffer.byteLength(task.prompt, 'utf8') > MAX_BYTES || !text(task.cwd, 4_096) || !isAbsolute(task.cwd) ||
      !Number.isSafeInteger(task.timeoutMs) || task.timeoutMs < 1 || task.timeoutMs > 900_000 ||
      !Number.isSafeInteger(task.maxOutputTokens) || task.maxOutputTokens < 1 || task.maxOutputTokens > 16_384 ||
      !['read-only', 'workspace-write'].includes(task.mode) || !statSync(task.cwd).isDirectory()) {
    throw new Error('Invalid resource worker task');
  }
  return { ...task };
}

function events(output: string): Record<string, unknown>[] | null {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length || lines.length > 4_096) return null;
  try {
    const parsed: unknown[] = lines.map((line) => JSON.parse(line));
    return parsed.every((row) => object(row) && typeof row.type === 'string') ? parsed as Record<string, unknown>[] : null;
  } catch { return null; }
}

/** Recognize only the observed structured compatibility rejection, never infer faults from task text. */
function codexUpgradeRequired(row: Record<string, unknown>, model: string): boolean {
  const message = row.type === 'error' ? row.message
    : row.type === 'turn.failed' && object(row.error) ? row.error.message : undefined;
  if (typeof message !== 'string') return false;
  try {
    const failure: unknown = JSON.parse(message);
    return object(failure) && failure.type === 'error' && failure.status === 400 && object(failure.error) &&
      failure.error.type === 'invalid_request_error' && failure.error.message ===
        `The '${model}' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.`;
  } catch { return false; }
}

function parseCodex(output: string, model: string): ResourceWorkerResult {
  const rows = events(output);
  if (!rows) return empty('worker-invalid-events');
  const completed = rows.filter((row) => row.type === 'turn.completed');
  const terminal = rows.at(-1)?.type === 'turn.completed';
  const failure = rows.some((row) => row.type === 'turn.failed' || row.type === 'error');
  let inputTokens: number | null = null; let outputTokens: number | null = null;
  if (terminal && completed.length && !failure) {
    inputTokens = sum(completed.map((row) => object(row.usage) ? row.usage.input_tokens : undefined));
    outputTokens = sum(completed.map((row) => object(row.usage) ? row.usage.output_tokens : undefined));
    if (inputTokens === null || outputTokens === null || !count(inputTokens + outputTokens)) { inputTokens = null; outputTokens = null; }
  }
  const message = rows.filter((row) => row.type === 'item.completed' && object(row.item) &&
    row.item.type === 'agent_message').at(-1)?.item;
  const result = typeof (message as Record<string, unknown> | undefined)?.text === 'string'
    ? (message as { text: string }).text : '';
  return { status: terminal && !failure && result.trim() ? 'completed' : 'failed', output: result,
    inputTokens, outputTokens, reason: failure ? rows.some((row) => codexUpgradeRequired(row, model))
      ? 'worker-cli-upgrade-required' : 'worker-terminal-failed' : !terminal ? 'worker-terminal-missing'
      : !result.trim() ? 'worker-output-missing' : 'worker-completed' };
}

function parseClaude(output: string): ResourceWorkerResult {
  const rows = events(output);
  if (!rows) return empty('worker-invalid-events');
  const results = rows.filter((row) => row.type === 'result');
  const terminal = rows.at(-1);
  if (results.length !== 1 || terminal?.type !== 'result') return empty('worker-terminal-missing');
  // This adapter supplies one prompt, not a resumable streaming-input session.
  // Reset results can omit earlier usage; injected turns are not our task's
  // result. Neither may establish completed work or attributable token totals.
  // Wire names are confirmed by Anthropic's native-message parser:
  // https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/message_parser.py
  if (rows.some((row) => row.type === 'conversation_reset')) return empty('worker-conversation-reset');
  if (terminal.origin !== undefined && terminal.origin !== null &&
      (!object(terminal.origin) || terminal.origin.kind !== 'human')) return empty('worker-result-origin-unexpected');
  const usage = object(terminal.usage) ? terminal.usage : {};
  // Preserve the historical main-loop, cache-inclusive counter semantics.
  // modelUsage is a different, cumulative query-pipeline measurement; it must
  // not replace these fields or be summed with assistant/child usage. Helpers
  // outside that pipeline are excluded even from modelUsage (not billing).
  // https://code.claude.com/docs/en/agent-sdk/python#resultmessage
  let inputTokens = sum([usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]);
  let outputTokens = count(usage.output_tokens) ? usage.output_tokens : null;
  if (inputTokens === null || outputTokens === null || !count(inputTokens + outputTokens)) { inputTokens = null; outputTokens = null; }
  const result = typeof terminal.result === 'string' ? terminal.result : '';
  const completedReason = terminal.terminal_reason === undefined || terminal.terminal_reason === null ||
    terminal.terminal_reason === 'completed';
  const success = terminal.subtype === 'success' && terminal.is_error === false && completedReason &&
    (terminal.api_error_status === undefined || terminal.api_error_status === null) &&
    (terminal.deferred_tool_use === undefined || terminal.deferred_tool_use === null) && result.trim();
  return { status: success ? 'completed' : 'failed', output: result, inputTokens, outputTokens,
    reason: success ? 'worker-completed' : 'worker-terminal-failed' };
}

export function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // HOME is copied unchanged. Account-specific auth belongs to the explicit
  // wrapper; no API keys, proxy, loader, or account-switching variables pass.
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function executeNative(worker: ResourceWorker, binding: Extract<ResourceBinding, { kind: 'native-cli' }>,
  task: ResourceWorkerTask, signal?: AbortSignal): Promise<ResourceWorkerResult> {
  const dispatchedAt = Date.now();
  const suffix = worker.provider === 'codex'
    ? ['exec', '--model', worker.model, '--cd', task.cwd, '--sandbox', task.mode,
      '--json', '--ephemeral', '--ignore-user-config', '-']
    : ['-p', '--model', worker.model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--safe-mode', '--restricted', '--strict-mcp-config', '--tools',
      task.mode === 'read-only' ? '' : 'Read,Glob,Grep,Edit,Write', '--permission-mode',
      task.mode === 'read-only' ? 'plan' : 'acceptEdits'];
  const processResult = await runVerifySubprocessAsync([...binding.command, ...suffix], {
    cwd: task.cwd, env: workerEnvironment(), timeoutMs: task.timeoutMs, input: task.prompt, maxOutputChars: MAX_BYTES, signal,
  });
  const parsed = processResult.outputTruncated ? empty('worker-output-truncated')
    : worker.provider === 'codex' ? parseCodex(processResult.stdout, worker.model) : parseClaude(processResult.stdout);
  // The runner uses synthetic exit codes for timeouts, cancellation and signals.
  // Preserve only an ordinary observed POSIX exit, not a guessed process outcome.
  parsed.nativeProcess = { schemaVersion: 1, scope: 'native-process',
    exitCode: !processResult.timedOut && !processResult.cancelled && !processResult.error && !processResult.signal &&
      Number.isSafeInteger(processResult.exitCode) && processResult.exitCode >= 0 && processResult.exitCode <= 255
      ? processResult.exitCode : null,
    signal: validResourceNativeProcessSignal(processResult.signal) ? processResult.signal : null,
    stderrPresent: processResult.stderr.length > 0, outputTruncated: processResult.outputTruncated === true };
  if (worker.provider === 'claude' && !processResult.outputTruncated) {
    let observed: ResourceObservation | null = null;
    for (const event of events(processResult.stdout) ?? []) {
      if (event.type !== 'rate_limit_event') continue;
      const next = mergeClaudeResourceObservation(worker.id, event, observed,
        { nowMs: dispatchedAt, ttlMs: MAX_RESOURCE_OBSERVATION_AGE_MS });
      if (next) observed = next;
    }
    // Buffered JSONL proves neither per-event capture time nor current account
    // headroom. Dispatch is the lower bound; long tasks yield stale evidence.
    if (observed) parsed.observation = observed;
  }
  if (processResult.error?.startsWith('termination authority lost:') ||
      processResult.error === 'termination deadline elapsed with process-group exit unconfirmed') {
    return { ...parsed, status: 'uncertain', reason: 'worker-termination-uncertain' };
  }
  if (processResult.cancelled) return { ...parsed, status: 'cancelled', reason: 'worker-cancelled' };
  if (processResult.timedOut) return { ...parsed, status: 'timed-out', reason: 'worker-timed-out' };
  if (processResult.outputTruncated) return parsed;
  if (processResult.error) return { ...parsed, status: 'failed', reason: 'worker-process-failed' };
  if (processResult.exitCode !== 0 || processResult.signal) return { ...parsed, status: 'failed',
    reason: !processResult.signal && parsed.reason === 'worker-cli-upgrade-required' ? parsed.reason : 'worker-exit-failed' };
  // CLI tasks may make multiple internal requests. Their output token setting
  // is a reported-usage cutoff, not a preventive native provider spend cap.
  if (parsed.outputTokens !== null && parsed.outputTokens > task.maxOutputTokens) {
    return { ...parsed, status: 'failed', reason: 'worker-output-token-limit' };
  }
  return parsed;
}

async function executeLocal(worker: ResourceWorker, binding: Extract<ResourceBinding, { kind: 'local-chat' }>,
  task: ResourceWorkerTask, signal?: AbortSignal): Promise<ResourceWorkerResult> {
  const started = performance.now();
  const controller = new AbortController(); let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, task.timeoutMs);
  let inputTokens: number | null = null; let outputTokens: number | null = null;
  try {
    if (controller.signal.aborted) return empty('worker-cancelled', 'cancelled');
    const client = buildOpenAICompatibleClient(binding.endpoint, '', worker.model, false, undefined, controller.signal,
      { redirect: 'error', timeoutMs: task.timeoutMs, maxRequestBytes: MAX_BYTES, maxResponseBytes: MAX_BYTES,
        maxOutputTokens: task.maxOutputTokens });
    const response = await client.chat([{ role: 'user', content: task.prompt }], undefined, controller.signal);
    if (response.usageKnown === true && count(response.usage.tokensIn) && count(response.usage.tokensOut) &&
        count(response.usage.tokensIn + response.usage.tokensOut)) {
      inputTokens = response.usage.tokensIn; outputTokens = response.usage.tokensOut;
    }
    if (performance.now() - started >= task.timeoutMs) { timedOut = true; controller.abort(); }
    const base = { output: response.content, inputTokens, outputTokens };
    if (controller.signal.aborted) return { ...base, status: timedOut ? 'timed-out' : 'cancelled',
      reason: timedOut ? 'worker-timed-out' : 'worker-cancelled' };
    if (response.toolCalls?.length) return { ...base, status: 'failed', reason: 'worker-tool-calls-not-allowed' };
    if (outputTokens !== null && outputTokens > task.maxOutputTokens) return { ...base, status: 'failed', reason: 'worker-output-token-limit' };
    if (!response.content.trim()) return { ...base, status: 'failed', reason: 'worker-output-missing' };
    return { ...base, status: 'completed', reason: 'worker-completed' };
  } catch {
    return { ...empty(timedOut ? 'worker-timed-out' : controller.signal.aborted ? 'worker-cancelled' : 'worker-transport-failed',
      timedOut ? 'timed-out' : controller.signal.aborted ? 'cancelled' : 'failed'), inputTokens, outputTokens };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

/** One explicit task on one chosen worker. No retries, fallback, account discovery, or verification claims. */
export async function executeResourceWorker(worker: ResourceWorker, binding: ResourceBinding,
  task: ResourceWorkerTask, signal?: AbortSignal): Promise<ResourceWorkerResult> {
  if (signal?.aborted) return empty('worker-cancelled', 'cancelled');
  let validatedWorker: ResourceWorker; let validatedBinding: ResourceBinding; let validatedTask: ResourceWorkerTask;
  try {
    const pool = validateResourcePool({ schemaVersion: 1, id: 'worker-execution', workers: [worker] });
    validatedWorker = pool.workers[0]!; validatedBinding = validateResourceBindings([binding], pool)[0]!;
    validatedTask = validateTask(task);
  } catch { return empty('worker-invalid-configuration'); }
  if (signal?.aborted) return empty('worker-cancelled', 'cancelled');
  const result = validatedBinding.kind === 'native-cli'
    ? await executeNative(validatedWorker, validatedBinding, validatedTask, signal)
    : await executeLocal(validatedWorker, validatedBinding, validatedTask, signal);
  if (result.inputTokens === null || result.outputTokens === null) return result;
  return { ...result, usageScope: validatedWorker.provider === 'codex' ? 'codex-turn'
    : validatedWorker.provider === 'claude' ? 'claude-main-loop' : 'local-chat-completion' };
}
