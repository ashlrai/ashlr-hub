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
 *     or session/new {cwd, mcpServers: []} → {sessionId}   (model: `acp --model`)
 *   → session/set_config_option {sessionId, configId, value}  (resume only: the
 *     chat's model, when it differs from the loaded conversation's — nextDevinModelStep)
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
 * PULL REQUESTS. The local agent opens PRs itself (`gh pr create`), so the
 * only trace is the URL in what it prints. A GitHub PR URL in an agent message
 * or a tool's output — and not already in the operator's own message — is
 * recorded for the chat (cli-prs.ts, which feeds Needs-you) and, the first
 * time this chat sees it, shown as the chat's PR card (`remote-pr`).
 *
 * USAGE. The CLI reports none over ACP (3000.11.3's `initialize` advertises
 * no usage capability and prompt answers carry only `stopReason`), so a CLI
 * turn is not counted against the Devin ACU budget; the Resources drawer says
 * so rather than implying it is.
 *
 * NOTHING FROM THE CLI'S STDERR IS FORWARDED. The CLI logs, among other
 * things, the commands it uses to start the operator's MCP servers (seen on
 * 3000.11.3), which can name secret-bearing wrappers. stderr is drained and
 * dropped; `_cognition.ai/*` notifications (the same output channel) are
 * ignored. Everything that is forwarded is scrubbed.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import { scrubSecrets } from '../util/scrub.js';
import { findGithubPrUrls, recordDevinCliPrs, type DevinCliPr } from './cli-prs.js';
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
  /** Record PRs the turn printed for this chat; returns the ones new to it (default: cli-prs.ts). */
  recordPrs?: (verseSessionId: string, found: ReadonlyArray<Pick<DevinCliPr, 'url' | 'repo' | 'number'>>) => ReadonlyArray<Pick<DevinCliPr, 'url'>>;
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

// ---------------------------------------------------------------------------
// Model switch on a resumed conversation
// ---------------------------------------------------------------------------

/** Effort words the CLI's model ids end with (`claude-opus-5-5-high`, `gpt-6-sol-none`). */
const LEVEL_TOKENS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Speed words (`…-high-fast`, `…-high-priority` — both "Fast" in the listing). */
const FAST_TOKENS = new Set(['fast', 'priority']);
const MAX_MODEL_STEPS = 6;

interface ConfigSelect { id: string; category: string | null; current: string | null; values: string[] }

function configSelects(configOptions: unknown): ConfigSelect[] {
  if (!Array.isArray(configOptions)) return [];
  const out: ConfigSelect[] = [];
  for (const option of configOptions) {
    if (!isRecord(option) || typeof option['id'] !== 'string' || !Array.isArray(option['options'])) continue;
    out.push({
      id: option['id'],
      category: typeof option['category'] === 'string' ? option['category'] : null,
      current: typeof option['currentValue'] === 'string' ? option['currentValue'] : null,
      values: option['options'].filter(isRecord).map((o) => o['value']).filter((v): v is string => typeof v === 'string'),
    });
  }
  return out;
}

/** A model id without its trailing effort / speed words: `claude-opus-5-5-high-fast` → `claude-opus-5-5`. */
function modelStem(id: string): string {
  const parts = id.split('-');
  while (parts.length > 1 && (LEVEL_TOKENS.has(parts.at(-1)!) || FAST_TOKENS.has(parts.at(-1)!))) parts.pop();
  return parts.join('-');
}

export type DevinModelStep =
  | { kind: 'set'; configId: string; value: string }
  | { kind: 'done' }
  | { kind: 'unplannable'; reason: string };

/**
 * The next `session/set_config_option` that moves a session toward `target`
 * (a `devin models list` id), from the session's current config options.
 * Pure; exported for tests.
 *
 * WHY. `devin acp --model` sets the model of NEW sessions only: a loaded
 * conversation keeps the model it was created with (checked on 3000.11.3 —
 * session/load under `--model claude-opus-5-5-high-fast` still reported
 * `swe-2-high`). Since 3000.11.1 the ACP server exposes the model as session
 * config options instead (CLI changelog: "ACP clients can select Devin
 * models, thinking effort, and speed through session configuration
 * controls"), seen on 3000.11.3 as three selects:
 *   model          (category `model`)        one value per family, named by
 *                                             the family's default row: `swe-2-high`,
 *                                             `claude-opus-5-5-medium`, …
 *   thought_level  (category `thought_level`) low|medium|high|xhigh|max (per family)
 *   speed          (category `model_config`)  standard|fast (families that have it)
 * Setting `model` resets the other two to that family's defaults, and each
 * answer carries the updated options — so this is asked once per step.
 *
 * DECOMPOSITION. The family is the `model` value whose stem (the id without
 * effort/speed words) is the longest prefix of the target; the target's
 * remaining words name the effort and, when `fast`/`priority`, the speed
 * (none = standard). A word that is neither (e.g. `-1m`) makes the target
 * unplannable unless it is itself a `model` value — the caller then leaves
 * the conversation's model alone, exactly as before this existed.
 */
export function nextDevinModelStep(target: string, configOptions: unknown): DevinModelStep {
  const selects = configSelects(configOptions);
  const model = selects.find((s) => s.category === 'model') ?? selects.find((s) => s.id === 'model');
  if (!model) return { kind: 'unplannable', reason: 'this Devin CLI exposes no model control' };
  let family: string | null = null;
  let familyStem = '';
  for (const value of model.values) {
    const stem = modelStem(value);
    if ((target === stem || target.startsWith(`${stem}-`)) && stem.length > familyStem.length) {
      family = value;
      familyStem = stem;
    }
  }
  if (family === null) return { kind: 'unplannable', reason: `the Devin CLI does not offer ${target} here` };
  if (model.current !== family) return { kind: 'set', configId: model.id, value: family };

  const rest = target.length > familyStem.length ? target.slice(familyStem.length + 1).split('-').filter(Boolean) : [];
  const exactValue = model.values.includes(target);
  let level: string | null = null;
  let fast = false;
  for (const word of rest) {
    if (LEVEL_TOKENS.has(word)) level = word;
    else if (FAST_TOKENS.has(word)) fast = true;
    else if (!exactValue) return { kind: 'unplannable', reason: `cannot map "${word}" in ${target} to a Devin setting` };
  }
  const thought = selects.find((s) => s.category === 'thought_level') ?? selects.find((s) => s.id === 'thought_level');
  if (level !== null && thought) {
    if (!thought.values.includes(level)) return { kind: 'unplannable', reason: `${target}: effort ${level} is not offered` };
    if (thought.current !== level) return { kind: 'set', configId: thought.id, value: level };
  }
  const speed = selects.find((s) => s.category === 'model_config' && s.values.includes('fast') && s.values.includes('standard'))
    ?? selects.find((s) => s.id === 'speed');
  if (speed) {
    const want = fast ? 'fast' : 'standard';
    if (speed.values.includes(want) && speed.current !== want) return { kind: 'set', configId: speed.id, value: want };
  } else if (fast) {
    return { kind: 'unplannable', reason: `${target}: no fast mode is offered` };
  }
  return { kind: 'done' };
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
  const recordPrs = deps.recordPrs ?? ((chat, found) => recordDevinCliPrs(chat, found));
  /** URLs the operator typed are theirs, not something this turn opened. */
  const typedUrls = new Set(findGithubPrUrls(payload.text).map((p) => p.url.toLowerCase()));
  const notePrs = (text: string): void => {
    const found = findGithubPrUrls(text).filter((p) => !typedUrls.has(p.url.toLowerCase()));
    if (found.length === 0) return;
    let added: ReadonlyArray<Pick<DevinCliPr, 'url'>> = [];
    try {
      added = recordPrs(payload.verseSessionId, found);
    } catch {
      added = [];
    }
    for (const pr of added) emit({ type: 'remote-pr', url: pr.url, state: null });
  };
  const flushMessage = (): void => {
    const text = clean(message).trim();
    message = '';
    if (!text) return;
    emit({ type: 'assistant-message', text });
    notePrs(text);
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
        const output = toolOutputOf(update);
        emit({ type: 'tool-result', toolUseId: id, output, isError: status === 'failed' });
        if (status === 'completed') notePrs(output);
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
      let loaded: unknown;
      try {
        loaded = await request('session/load', { sessionId: payload.nativeId, cwd, mcpServers: [] });
      } catch (error) {
        replaying = false;
        if (error instanceof AcpError && (error.rpcCode === -32000 || /auth|log ?in/i.test(error.message))) return await failWith(loginHint);
        // The conversation is gone (deleted, another machine): one retry on a
        // new session seeded with this chat's handoff note (the engine's rule).
        return await failWith('The Devin CLI no longer has this conversation.', 'native-thread-missing');
      }
      replaying = false;
      sessionId = payload.nativeId;
      // The chat's model, applied to the resumed conversation (`--model`
      // only reaches new sessions; see nextDevinModelStep). A model the
      // options cannot express is left as it is; a switch the CLI refuses
      // fails the turn — never silently run a different (maybe paid) model.
      if (payload.model) {
        let options = isRecord(loaded) ? loaded['configOptions'] : undefined;
        for (let step = 0; step < MAX_MODEL_STEPS; step++) {
          const next = nextDevinModelStep(payload.model, options);
          if (next.kind !== 'set') break;
          try {
            const answer = await request('session/set_config_option', { sessionId, configId: next.configId, value: next.value });
            options = isRecord(answer) ? answer['configOptions'] : undefined;
          } catch (error) {
            const why = error instanceof AcpError ? error.message : 'no answer';
            return await failWith(`The Devin CLI could not switch this chat to ${payload.model} (${why}). Pick another model, or start a new chat.`);
          }
        }
      }
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
