/**
 * core/verse/terminal-assist.ts — plain language → a shell command (3.15).
 *
 * The ONE place a terminal request reaches a model. terminal.ts keeps its
 * promise ("never a model call"); this file is only ever reached from an
 * explicit operator action — `#…` or ⌘I in the input editor, or ⌘K
 * "Generate command…" — through POST /api/verse/terminal/assist.
 *
 * WHAT IS SENT. The request, the shell's directory (home spelled `~`), the
 * OS and shell name, and the last few command blocks — command, exit code,
 * the TAIL of the output — all as plain text through scrubSecrets, capped
 * (ASSIST_MAX_BLOCKS × ASSIST_BLOCK_OUTPUT_CHARS). Nothing else.
 *
 * WHERE. The LOCAL model first (Ollama / LM Studio / llama-server through
 * provider-client's `getActiveClient(cfg, { allowCloud: false })` — a cloud
 * provider is refused there). Only in mode `auto`, and only when no local
 * model answers, Grok — when an xAI key is configured AND the local-only
 * policy permits the `grok` engine. Mode `off` never calls anything.
 *
 * WHAT COMES BACK is TEXT. The server never types it into a shell and never
 * runs it: the page puts it in the editor for the operator to read, change
 * and run (or not). A destructive-looking command is flagged `risky` by the
 * model or by `isRiskyCommand`, and the page asks for a second Enter.
 *
 * Dynamic imports are string literals (the bun sidecar bundles them).
 */
import { homedir, arch, platform, release } from 'node:os';

import type { AshlrConfig, ChatMessage } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import type { VerseTerminalAssistMode, VerseTerminalAssistResponse } from './workbench-types.js';

export const ASSIST_MAX_BLOCKS = 3;
export const ASSIST_BLOCK_OUTPUT_CHARS = 1_500;
export const ASSIST_COMMAND_MAX_CHARS = 4_000;
export const ASSIST_TIMEOUT_MS = 45_000;
export const ASSIST_MAX_OUTPUT_TOKENS = 400;

export interface AssistBlockContext {
  command: string;
  exitCode: number | null;
  /** Plain text (escape sequences already removed). Scrubbed and cut to its tail here. */
  output: string;
}

export interface AssistContext {
  request: string;
  cwd: string | null;
  /** e.g. "macOS (darwin 25.6.0, arm64)". Default: this machine. */
  os?: string;
  /** The shell's name (zsh, bash, fish), when known. */
  shell: string | null;
  blocks: AssistBlockContext[];
}

/** One model, ready to answer: messages in, text out. */
export type AssistModelCall = (messages: ChatMessage[], signal: AbortSignal) => Promise<{ text: string; model: string }>;

export interface AssistDeps {
  /** The local model, or null when none is reachable. */
  local?: (cfg: AshlrConfig) => Promise<AssistModelCall | null>;
  /** Grok, or null when it is not configured or not permitted. */
  grok?: (cfg: AshlrConfig) => Promise<AssistModelCall | null>;
  timeoutMs?: number;
}

export type TerminalAssistErrorCode = 'ASSIST_OFF' | 'ASSIST_NO_MODEL' | 'ASSIST_FAILED' | 'ASSIST_EMPTY';

export class TerminalAssistError extends Error {
  constructor(public readonly code: TerminalAssistErrorCode, message: string) {
    super(message);
    this.name = 'TerminalAssistError';
  }
}

export function describeOs(): string {
  const name = platform() === 'darwin' ? 'macOS' : platform() === 'linux' ? 'Linux' : platform();
  return `${name} (${platform()} ${release()}, ${arch()})`;
}

function homeTilde(path: string): string {
  const home = homedir();
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max + 1)}`;
}

/** The two messages sent to the model. Everything user-derived is scrubbed here. */
export function buildAssistMessages(ctx: AssistContext): ChatMessage[] {
  const shell = ctx.shell ?? 'a POSIX shell';
  const system = [
    'You turn a request into a shell command for the user\'s terminal.',
    `OS: ${ctx.os ?? describeOs()}. Shell: ${shell}. Current directory: ${ctx.cwd ? scrubSecrets(homeTilde(ctx.cwd)) : 'unknown'}.`,
    'Reply with ONLY a JSON object: {"command": "<the command>", "explanation": "<one short sentence>", "risky": <true|false>}.',
    'The command must run as-is in that shell. Prefer one line; chain with && when needed. Use tools that ship with the OS unless the recent commands show others are installed.',
    'Set "risky" to true when it deletes or overwrites files, rewrites git history, force-pushes, kills processes, needs sudo, or changes system settings.',
    'The user reads and edits the command before running it: never claim it has run.',
  ].join('\n');
  const recent = ctx.blocks.slice(-ASSIST_MAX_BLOCKS).map((b) => {
    const status = b.exitCode === null ? '' : ` (exit ${b.exitCode})`;
    const out = tail(scrubSecrets(b.output).trim(), ASSIST_BLOCK_OUTPUT_CHARS);
    return `$ ${scrubSecrets(b.command)}${status}${out ? `\n${out}` : ''}`;
  });
  const user = [
    ...(recent.length > 0 ? ['Recent commands in this terminal:', ...recent, ''] : []),
    `Request: ${scrubSecrets(ctx.request.trim())}`,
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

function cleanCommand(raw: string): string {
  let cmd = raw.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').trim();
  // A model that answers in a prompt's voice: `$ ls` → `ls`.
  cmd = cmd.split('\n').map((line) => line.replace(/^\s*\$\s+/, '')).join('\n').trim();
  return cmd.length > ASSIST_COMMAND_MAX_CHARS ? cmd.slice(0, ASSIST_COMMAND_MAX_CHARS) : cmd;
}

/**
 * A model's reply → command, explanation, risky. JSON first (bare, or inside
 * a ``` fence); then the first fenced code block; then the first non-empty
 * line. Null when nothing usable came back.
 */
export function parseAssistReply(text: string): { command: string; explanation: string | null; risky: boolean } | null {
  const body = text.trim();
  if (!body) return null;
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(body);
  if (fenced) candidates.push(fenced[1]!.trim());
  const brace = body.indexOf('{');
  const close = body.lastIndexOf('}');
  if (brace >= 0 && close > brace) candidates.push(body.slice(brace, close + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && typeof parsed['command'] === 'string') {
        const command = cleanCommand(parsed['command']);
        if (!command) continue;
        const explanation = typeof parsed['explanation'] === 'string' ? parsed['explanation'].replace(CONTROL_RE, '').trim().slice(0, 300) || null : null;
        return { command, explanation, risky: parsed['risky'] === true };
      }
    } catch {
      /* not JSON */
    }
  }
  const code = /```[a-z]*\s*\n([\s\S]*?)```/i.exec(body);
  if (code) {
    const command = cleanCommand(code[1]!);
    if (command) return { command, explanation: null, risky: false };
  }
  const first = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('{'));
  if (!first) return null;
  const command = cleanCommand(first.replace(/^`+|`+$/g, ''));
  return command ? { command, explanation: null, risky: false } : null;
}

const RISKY_RES: readonly RegExp[] = [
  /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+/, // rm -rf / rm -f / rm -r
  /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+(?:branch\s+-D|checkout\s+--\s|restore\s)/,
  /\bsudo\b/,
  /\bdd\s+[^\n]*\bof=/,
  /\bmkfs\b/,
  /\b(?:chmod|chown)\s+-R\b/,
  /\b(?:kill\s+-9|killall|pkill)\b/,
  /\b(?:shutdown|reboot|halt)\b/,
  /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /(?:^|[^>])>\s*(?:\/dev\/(?:sd|disk|nvme)|~?\/[^\s]*\/?\.(?:zshrc|bashrc|profile))/,
  /\bfind\b[^\n]*\s-delete\b/,
  /\bcurl\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
];

/** A second opinion on "destructive", independent of the model's. */
export function isRiskyCommand(command: string): boolean {
  return RISKY_RES.some((re) => re.test(command));
}

async function defaultLocal(cfg: AshlrConfig): Promise<AssistModelCall | null> {
  const { getActiveClient } = await import('../run/provider-client.js');
  let client: Awaited<ReturnType<typeof getActiveClient>>;
  try {
    // allowCloud: false — a cloud provider at the head of the chain is refused, never used.
    client = await getActiveClient(cfg, { allowCloud: false });
  } catch {
    return null;
  }
  return async (messages, signal) => {
    const res = await client.chat(messages, undefined, signal, { maxOutputTokens: ASSIST_MAX_OUTPUT_TOKENS });
    return { text: res.content ?? '', model: `local:${client.model ?? client.id}` };
  };
}

async function defaultGrok(cfg: AshlrConfig): Promise<AssistModelCall | null> {
  const [{ enginePermitted }, { resolveProviderKey }, registry, { buildOpenAICompatibleClient }] = await Promise.all([
    import('../policy/local-only.js'),
    import('../integrations/secrets.js'),
    import('../run/engine-registry.js'),
    import('../run/provider-client.js'),
  ]);
  if (!enginePermitted('grok', cfg).permitted) return null;
  const base = registry.BUILTIN_ENGINE_REGISTRY['grok'];
  const api = base ? registry.applyGrokConfig(base, cfg).api : undefined;
  if (!api) return null;
  const key = resolveProviderKey(api.envKey, cfg) ?? resolveProviderKey('GROK_API_KEY', cfg);
  if (!key) return null;
  const baseUrl = (api.baseUrlEnv ? process.env[api.baseUrlEnv]?.trim() : '') || api.defaultBaseUrl;
  if (!baseUrl) return null;
  const model = api.defaultModel ?? 'grok-4';
  const client = buildOpenAICompatibleClient(baseUrl, key, model, false);
  return async (messages, signal) => {
    const res = await client.chat(messages, undefined, signal, { maxOutputTokens: ASSIST_MAX_OUTPUT_TOKENS });
    return { text: res.content ?? '', model: `grok:${model}` };
  };
}

/**
 * Ask for a command. Throws TerminalAssistError: ASSIST_OFF (mode off),
 * ASSIST_NO_MODEL (nothing to ask), ASSIST_FAILED (the model errored or timed
 * out), ASSIST_EMPTY (it answered with nothing usable).
 */
export async function runTerminalAssist(
  cfg: AshlrConfig,
  ctx: AssistContext,
  mode: VerseTerminalAssistMode,
  deps: AssistDeps = {},
): Promise<VerseTerminalAssistResponse> {
  if (mode === 'off') throw new TerminalAssistError('ASSIST_OFF', 'Plain-language commands are turned off in the terminal\'s settings.');
  const messages = buildAssistMessages(ctx);
  const callers: Array<() => Promise<AssistModelCall | null>> = [() => (deps.local ?? defaultLocal)(cfg)];
  if (mode === 'auto') callers.push(() => (deps.grok ?? defaultGrok)(cfg));

  let lastError: unknown = null;
  let asked = false;
  for (const resolve of callers) {
    let call: AssistModelCall | null = null;
    try {
      call = await resolve();
    } catch (err) {
      lastError = err;
      call = null;
    }
    if (!call) continue;
    asked = true;
    const signal = AbortSignal.timeout(deps.timeoutMs ?? ASSIST_TIMEOUT_MS);
    let reply: { text: string; model: string };
    try {
      reply = await call(messages, signal);
    } catch (err) {
      // The local model errored: fall through to the next (Grok, in `auto`).
      lastError = err;
      continue;
    }
    const parsed = parseAssistReply(reply.text);
    if (!parsed) throw new TerminalAssistError('ASSIST_EMPTY', 'The model did not suggest a command. Try saying it another way.');
    return {
      command: parsed.command,
      explanation: parsed.explanation,
      provider: reply.model,
      risky: parsed.risky || isRiskyCommand(parsed.command),
    };
  }
  if (!asked) {
    throw new TerminalAssistError(
      'ASSIST_NO_MODEL',
      mode === 'auto'
        ? 'No local model is running and Grok is not configured. Start Ollama or LM Studio to turn requests into commands.'
        : 'No local model is running. Start Ollama or LM Studio to turn requests into commands.',
    );
  }
  const reason = lastError instanceof Error && lastError.name === 'TimeoutError' ? 'took too long' : 'failed';
  throw new TerminalAssistError('ASSIST_FAILED', `The model ${reason}. Try again, or check that it is still running.`);
}
