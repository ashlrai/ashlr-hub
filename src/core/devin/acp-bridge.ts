/**
 * One Verse turn on the Devin CLI seat (3.15): drive the local `devin` CLI over
 * the Agent Client Protocol and translate what it streams into transcript
 * lines (turn-protocol.ts).
 *
 * WHY ACP AND NOT `devin -p`. `-p/--print` prints only the final text: no
 * tool calls, no streaming, no session id to resume with (checked on devin
 * 3000.11.3: `devin --help` has no output-format flag). Its help says the
 * print mode's agent itself "runs in that child" — a `devin acp` server —
 * and `devin acp` is the documented structured interface ("Run as an ACP
 * (Agent Client Protocol) server over stdio"). Its `initialize` answer on
 * 3000.11.3 advertises `loadSession: true`, so a chat resumes the SAME Devin
 * conversation turn after turn.
 *
 * PROTOCOL (ACP v1, newline-delimited JSON-RPC 2.0 on stdio):
 *   → initialize {protocolVersion: 1, clientCapabilities: {fs: off, terminal: off}}
 *   → session/load {sessionId, cwd, mcpServers: []}   (resume; history replay is ignored)
 *     or session/new {cwd, mcpServers: []} → {sessionId}
 *   → session/prompt {sessionId, prompt: [{type: 'text', text}]} → {stopReason}
 *   ← session/update notifications: agent_message_chunk, agent_thought_chunk,
 *     tool_call, tool_call_update (plan / commands / mode updates are ignored)
 *   ← session/request_permission (a request we MUST answer): answered by the
 *     chat's permission mode — Plan allows read-only tool kinds and rejects
 *     the rest; every other mode allows (Accept edits runs with `--sandbox`,
 *     so exec-tool processes can write only inside the workspace).
 *   ← any other agent→client request (fs/*, terminal/*: capabilities we did
 *     not advertise) → JSON-RPC "method not found".
 *   → session/cancel (notification) on Stop, then the process is killed.
 *
 * NOTHING FROM THE CLI'S STDERR IS FORWARDED. The CLI logs, among other
 * things, the commands it uses to start the operator's MCP servers (seen on
 * 3000.11.3), which can name secret-bearing wrappers. stderr is drained and
 * dropped; `_cognition.ai/*` notifications (the same output channel) are
 * ignored. Everything that is forwarded is scrubbed.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import { scrubSecrets } from '../util/scrub.js';
import type { DevinTurnLine, DevinTurnPayload } from './turn-protocol.js';
import { DEVIN_TURN_EXIT, type DevinTurnIo } from './chat-runner.js';

export interface DevinAcpDeps {
  spawn?: typeof nodeSpawn;
  /** Env for the CLI (default: the turn process's own). */
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the CLI to answer a control request. */
  requestTimeoutMs?: number;
  /** After session/cancel, how long to wait for the prompt to settle before killing. */
  cancelGraceMs?: number;
}

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CANCEL_GRACE_MS = 3_000;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 8_000;
const MAX_TEXT = 60_000;

/** ACP tool kinds that only read (https://agentclientprotocol.com — ToolKind). */
const READ_ONLY_KINDS = new Set(['read', 'search', 'think', 'fetch']);

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

function clean(text: string, max = MAX_TEXT): string {
  const scrubbed = scrubSecrets(text).replace(/\bcog_[A-Za-z0-9_-]+/g, '[REDACTED]');
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

/** The CLI's root flags for this chat (before `acp`). Exported for tests. */
export function devinAcpArgs(payload: Pick<DevinTurnPayload, 'permissionMode' | 'model'>): string[] {
  const permission = payload.permissionMode === 'plan'
    ? ['--permission-mode', 'auto']
    : payload.permissionMode === 'bypass'
      ? ['--permission-mode', 'dangerous']
      : ['--sandbox', '--permission-mode', 'accept-edits'];
  return [...permission, 'acp', ...(payload.model ? ['--model', payload.model] : [])];
}

/**
 * The option to pick for a permission request, by the chat's mode. Returns
 * the option id, or null to answer "cancelled" (no acceptable option).
 */
export function choosePermission(mode: DevinTurnPayload['permissionMode'], params: Json): string | null {
  const options = Array.isArray(params['options']) ? params['options'].filter(isRecord) : [];
  const toolCall = isRecord(params['toolCall']) ? params['toolCall'] : {};
  const kind = typeof toolCall['kind'] === 'string' ? toolCall['kind'] : 'other';
  const allow = mode !== 'plan' || READ_ONLY_KINDS.has(kind);
  const pick = (kinds: string[]): string | null => {
    for (const wanted of kinds) {
      const found = options.find((o) => o['kind'] === wanted && typeof o['optionId'] === 'string');
      if (found) return found['optionId'] as string;
    }
    return null;
  };
  // allow_once, never allow_always: a chat's answer must not become a standing rule in the CLI's config.
  return allow ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
}

function textOf(content: unknown): string {
  if (!isRecord(content)) return '';
  if (content['type'] === 'text' && typeof content['text'] === 'string') return content['text'];
  return '';
}

/** tool_call_update.content → plain text (text blocks and diffs by path). */
function toolOutputOf(update: Json): string {
  const parts: string[] = [];
  const content = Array.isArray(update['content']) ? update['content'] : [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item['type'] === 'content') parts.push(textOf(item['content']));
    else if (item['type'] === 'diff' && typeof item['path'] === 'string') parts.push(`edited ${item['path']}`);
    else if (item['type'] === 'terminal') parts.push('(terminal output)');
  }
  if (parts.length === 0 && update['rawOutput'] !== undefined) {
    try {
      parts.push(typeof update['rawOutput'] === 'string' ? update['rawOutput'] : JSON.stringify(update['rawOutput']));
    } catch { /* unserialisable output is dropped */ }
  }
  return clean(parts.filter(Boolean).join('\n'), MAX_TOOL_OUTPUT);
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
}

class AcpError extends Error {
  constructor(message: string, readonly rpcCode: number | null) {
    super(message);
  }
}

/**
 * Run one CLI turn. Returns the process exit code (DEVIN_TURN_EXIT). Never
 * throws.
 */
export async function runDevinCliTurn(payload: DevinTurnPayload, io: DevinTurnIo, deps: DevinAcpDeps = {}): Promise<number> {
  const spawn = deps.spawn ?? nodeSpawn;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const cancelGraceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const started = io.now();
  if (!payload.cliPath) {
    io.emit({ type: 'error', message: 'The Devin CLI was not found. Install it (`brew install --cask devin-cli`) and log in with `devin auth login`.' });
    return DEVIN_TURN_EXIT.failed;
  }

  let child: ChildProcess;
  try {
    child = spawn(payload.cliPath, devinAcpArgs(payload), {
      cwd: payload.projectPath,
      env: deps.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    io.emit({ type: 'error', message: 'The Devin CLI could not be started.' });
    return DEVIN_TURN_EXIT.failed;
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let buffer = '';
  let exited = false;
  /** ENOENT / EACCES: the binary discovery found is gone or not runnable. */
  let spawnFailed = false;
  let sessionId: string | null = null;
  /** While session/load replays history, updates are the past, not this turn. */
  let replaying = false;
  let message = '';
  let thought = '';
  const openTools = new Set<string>();

  const emit = (line: DevinTurnLine): void => io.emit(line);
  const flushMessage = (): void => {
    const text = clean(message).trim();
    message = '';
    if (text) emit({ type: 'assistant-message', text });
  };
  const flushThought = (): void => {
    const text = clean(thought).trim();
    thought = '';
    if (text) emit({ type: 'thinking', text });
  };

  const write = (value: Json): void => {
    if (exited || !child.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
    } catch { /* EPIPE after exit */ }
  };
  const request = (method: string, params: Json, timeoutMs: number | null = requestTimeoutMs): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        pending.delete(id);
        reject(new AcpError(`the Devin CLI did not answer ${method}`, null));
      }, timeoutMs);
      timer?.unref?.();
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  };

  const onUpdate = (params: Json): void => {
    if (replaying) return;
    if (sessionId !== null && params['sessionId'] !== sessionId) return;
    const update = isRecord(params['update']) ? params['update'] : null;
    if (!update) return;
    switch (update['sessionUpdate']) {
      case 'agent_message_chunk': {
        const text = textOf(update['content']);
        if (!text) return;
        if (thought) flushThought();
        message += text;
        emit({ type: 'text-delta', text: clean(text, 8_000) });
        return;
      }
      case 'agent_thought_chunk': {
        const text = textOf(update['content']);
        if (!text) return;
        thought += text;
        emit({ type: 'thinking-delta', text: clean(text, 8_000) });
        return;
      }
      case 'tool_call': {
        flushThought();
        flushMessage();
        const id = typeof update['toolCallId'] === 'string' ? update['toolCallId'].slice(0, 200) : `tool-${openTools.size + 1}`;
        const title = typeof update['title'] === 'string' && update['title'].trim() ? update['title'].trim().slice(0, 200) : null;
        const kind = typeof update['kind'] === 'string' ? update['kind'].slice(0, 40) : 'other';
        openTools.add(id);
        let input: unknown = update['rawInput'] ?? (title ? { title } : {});
        try {
          input = JSON.parse(clean(JSON.stringify(input ?? {}), MAX_TOOL_OUTPUT));
        } catch {
          input = title ? { title } : {};
        }
        emit({ type: 'tool-use', toolUseId: id, name: title ?? kind, input });
        emit({ type: 'progress', phase: 'tool', tool: (title ?? kind).slice(0, 80), elapsedMs: Math.max(0, io.now() - started) });
        return;
      }
      case 'tool_call_update': {
        const id = typeof update['toolCallId'] === 'string' ? update['toolCallId'].slice(0, 200) : null;
        const status = update['status'];
        if (!id || !openTools.has(id) || (status !== 'completed' && status !== 'failed')) return;
        openTools.delete(id);
        emit({ type: 'tool-result', toolUseId: id, output: toolOutputOf(update), isError: status === 'failed' });
        return;
      }
      default:
        // plan, available_commands_update, current_mode_update, user_message_chunk …
        return;
    }
  };

  const onRequest = (id: unknown, method: string, params: Json): void => {
    if (method === 'session/request_permission') {
      const optionId = choosePermission(payload.permissionMode, params);
      write({ id, result: { outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } } });
      return;
    }
    write({ id, error: { code: -32601, message: 'Method not found' } });
  };

  const onLine = (line: string): void => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    const method = typeof msg['method'] === 'string' ? msg['method'] : null;
    if (method !== null) {
      const params = isRecord(msg['params']) ? msg['params'] : {};
      if (msg['id'] !== undefined && msg['id'] !== null) onRequest(msg['id'], method, params);
      else if (method === 'session/update') onUpdate(params);
      // `_cognition.ai/*` and other notifications: ignored on purpose (see the header).
      return;
    }
    const id = typeof msg['id'] === 'number' ? msg['id'] : null;
    if (id === null) return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (isRecord(msg['error'])) {
      const err = msg['error'];
      waiter.reject(new AcpError(typeof err['message'] === 'string' ? err['message'] : 'the Devin CLI refused the request', typeof err['code'] === 'number' ? err['code'] : null));
    } else {
      waiter.resolve(msg['result']);
    }
  };

  const exitedPromise = new Promise<number | null>((resolve) => {
    child.on('error', () => {
      exited = true;
      spawnFailed = true;
      resolve(null);
    });
    child.on('close', (code) => {
      exited = true;
      resolve(code);
    });
  });
  exitedPromise.then(() => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new AcpError('the Devin CLI exited', null));
    }
  }, () => undefined);

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_CHARS && !buffer.includes('\n')) buffer = '';
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onLine(line);
    }
  });
  // Drained and dropped: see the header.
  child.stderr?.on('data', () => undefined);
  child.stdin?.on('error', () => undefined);

  const stop = async (): Promise<void> => {
    if (exited) return;
    try { child.stdin?.end(); } catch { /* already closed */ }
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1_000);
    killer.unref?.();
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    await exitedPromise;
    clearTimeout(killer);
  };

  const failWith = async (message: string, code?: string): Promise<number> => {
    flushThought();
    flushMessage();
    emit({ type: 'error', message: clean(message, 2_000), ...(code ? { code } : {}) });
    await stop();
    return DEVIN_TURN_EXIT.failed;
  };

  const loginHint = 'The Devin CLI is not logged in. Run `devin auth login` in a terminal, then send again.';
  const describe = (error: unknown): string => {
    if (spawnFailed) return 'The Devin CLI could not be started. Install it (`brew install --cask devin-cli`), log in with `devin auth login`, then send again.';
    if (!(error instanceof AcpError)) return 'The Devin CLI stopped unexpectedly.';
    // -32000 is ACP's auth_required.
    if (error.rpcCode === -32000 || /auth|log ?in|credential/i.test(error.message)) return loginHint;
    return `The Devin CLI refused the turn: ${error.message}`;
  };

  try {
    const init = await request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const caps = isRecord(init) && isRecord(init['agentCapabilities']) ? init['agentCapabilities'] : {};
    const cwd = payload.projectPath;

    if (payload.nativeId) {
      if (caps['loadSession'] !== true) {
        return await failWith('This Devin CLI cannot resume a conversation.', 'native-thread-missing');
      }
      replaying = true;
      try {
        await request('session/load', { sessionId: payload.nativeId, cwd, mcpServers: [] });
      } catch (error) {
        replaying = false;
        if (error instanceof AcpError && (error.rpcCode === -32000 || /auth|log ?in/i.test(error.message))) return await failWith(loginHint);
        // The conversation is gone (deleted, another machine): one retry on a
        // new session seeded with this chat's handoff note (the engine's rule).
        return await failWith('The Devin CLI no longer has this conversation.', 'native-thread-missing');
      }
      replaying = false;
      sessionId = payload.nativeId;
    } else {
      const created = await request('session/new', { cwd, mcpServers: [] });
      const id = isRecord(created) && typeof created['sessionId'] === 'string' ? created['sessionId'] : null;
      if (!id || id.length > 200) return await failWith('The Devin CLI did not start a session.');
      sessionId = id;
    }
    emit({ type: 'native-session', id: sessionId });
    emit({ type: 'progress', phase: 'thinking', elapsedMs: Math.max(0, io.now() - started) });

    const prompt = request('session/prompt', { sessionId, prompt: [{ type: 'text', text: payload.text }] }, null);
    const aborted = new Promise<'aborted'>((resolve) => {
      if (io.signal.aborted) resolve('aborted');
      else io.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const outcome = await Promise.race([prompt.then((r) => ({ result: r }), (e: unknown) => ({ error: e })), aborted]);

    if (outcome === 'aborted') {
      write({ method: 'session/cancel', params: { sessionId } });
      const settle = new Promise((resolve) => { const t = setTimeout(resolve, cancelGraceMs); t.unref?.(); });
      await Promise.race([prompt.catch(() => undefined), settle]);
      flushThought();
      flushMessage();
      await stop();
      return DEVIN_TURN_EXIT.stopped;
    }
    if ('error' in outcome) return await failWith(describe(outcome.error));
    flushThought();
    flushMessage();
    const stopReason = isRecord(outcome.result) && typeof outcome.result['stopReason'] === 'string' ? outcome.result['stopReason'] : 'end_turn';
    await stop();
    if (stopReason === 'refusal') {
      emit({ type: 'error', message: 'Devin declined this request.' });
      return DEVIN_TURN_EXIT.failed;
    }
    if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      emit({ type: 'remote-status', state: 'waiting', message: 'Devin stopped at its per-turn limit. Send a message to continue.', url: null, acusConsumed: null, acuCap: null });
    }
    return stopReason === 'cancelled' ? DEVIN_TURN_EXIT.stopped : DEVIN_TURN_EXIT.ok;
  } catch (error) {
    return await failWith(describe(error));
  }
}
