/**
 * Devin CLI's own terminals, run in a VISIBLE Verse terminal tab (3.15 agent
 * tools).
 *
 * When the chat's grant holds the `terminal` scope, the ACP bridge
 * (acp-bridge.ts) advertises `clientCapabilities.terminal` and Devin asks the
 * CLIENT to run its commands: terminal/create, terminal/output,
 * terminal/wait_for_exit, terminal/kill, terminal/release. Each one is served
 * here by calling Verse's MCP server — the same endpoint and the same rules
 * every other seat gets (verse-mcp-terminal.ts): the command runs in an
 * agent-owned tab the operator can watch, destructive commands wait for the
 * operator, a takeover pauses it. So Devin never runs a shell Verse cannot see.
 *
 * The turn process is a plain MCP client here (loopback HTTP, the turn's
 * bearer token from its stdin payload).
 */
import type { DevinTurnVerseMcp } from './turn-protocol.js';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

export const ACP_TERMINAL_METHODS = ['terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release'] as const;
const POLL_MS = 500;
const MAX_WAIT_MS = 4 * 60 * 60 * 1000;

export interface VerseToolAnswer {
  header: Json;
  body: string;
  isError: boolean;
  text: string;
}

/** Split a Verse terminal tool's text: the JSON header line and the untrusted body. Exported for tests. */
export function parseVerseToolText(text: string, isError: boolean): VerseToolAnswer {
  const newline = text.indexOf('\n');
  const first = newline >= 0 ? text.slice(0, newline) : text;
  let header: Json = {};
  try {
    const parsed: unknown = JSON.parse(first);
    if (isRecord(parsed)) header = parsed;
  } catch { /* an error sentence, not a header */ }
  const framed = /<untrusted id=([0-9a-f]+)>\n([\s\S]*)\n<\/untrusted id=\1>/.exec(text);
  return { header, body: framed ? framed[2]! : '', isError, text };
}

export async function callVerseTool(mcp: Pick<DevinTurnVerseMcp, 'url' | 'token'>, name: string, args: Json, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<VerseToolAnswer> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await doFetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 404 ? 'Verse tools are no longer available to this turn' : `Verse answered ${response.status}`);
  const body: unknown = await response.json();
  const result = isRecord(body) && isRecord(body['result']) ? body['result'] : null;
  if (!result) {
    const message = isRecord(body) && isRecord(body['error']) && typeof body['error']['message'] === 'string' ? body['error']['message'] : 'Verse refused the call';
    throw new Error(message);
  }
  const content = Array.isArray(result['content']) ? result['content'] : [];
  const text = content.filter(isRecord).map((c) => (c['type'] === 'text' && typeof c['text'] === 'string' ? c['text'] : '')).join('\n');
  return parseVerseToolText(text, result['isError'] === true);
}

/** POSIX single-quote a word unless it is plainly safe. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** An ACP terminal/create → one command line for terminal_run. Exported for tests. */
export function acpCommandLine(params: Json): string | null {
  const command = typeof params['command'] === 'string' ? params['command'] : '';
  if (!command.trim()) return null;
  const args = Array.isArray(params['args']) ? params['args'].filter((a): a is string => typeof a === 'string') : [];
  const env = Array.isArray(params['env']) ? params['env'].filter(isRecord) : [];
  const assignments = env
    .filter((e) => typeof e['name'] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e['name']) && typeof e['value'] === 'string')
    .map((e) => `${e['name'] as string}=${shellQuote(e['value'] as string)}`);
  // A bare command with no args may itself be a shell line (`npm test && npm run lint`): typed as-is.
  const main = args.length === 0 ? command : [command, ...args].map(shellQuote).join(' ');
  const cwd = typeof params['cwd'] === 'string' && params['cwd'].startsWith('/') ? params['cwd'] : null;
  const line = [...assignments, main].join(' ');
  return cwd ? `cd ${shellQuote(cwd)} && ${line}` : line;
}

interface TrackedTerminal {
  tabId: string;
  blockId: string | null;
  outputLimit: number | null;
}

export interface AcpTerminalRouter {
  handles(method: string): boolean;
  handle(method: string, params: Json): Promise<{ result: unknown } | { error: { code: number; message: string } }>;
}

export function createAcpTerminalRouter(mcp: DevinTurnVerseMcp, opts: { fetch?: typeof fetch; signal: AbortSignal; sleep: (ms: number) => Promise<void> }): AcpTerminalRouter {
  const terminals = new Map<string, TrackedTerminal>();
  let counter = 0;
  const call = (name: string, args: Json): Promise<VerseToolAnswer> => callVerseTool(mcp, name, args, { ...(opts.fetch ? { fetch: opts.fetch } : {}), signal: opts.signal });
  const fail = (message: string) => ({ error: { code: -32603, message: message.slice(0, 500) } });
  const tracked = (params: Json): TrackedTerminal | null => {
    const id = typeof params['terminalId'] === 'string' ? params['terminalId'] : '';
    return terminals.get(id) ?? null;
  };

  const output = async (t: TrackedTerminal): Promise<{ output: string; truncated: boolean; done: boolean; exitCode: number | null }> => {
    const answer = t.blockId
      ? await call('terminal_read', { tab_id: t.tabId, block_id: t.blockId })
      : await call('terminal_read', { tab_id: t.tabId, max_chars: 20_000 });
    if (answer.isError) throw new Error(answer.text);
    let text = answer.body;
    let truncated = answer.header['truncated'] === true;
    if (t.outputLimit !== null && Buffer.byteLength(text) > t.outputLimit) {
      text = Buffer.from(text).subarray(-t.outputLimit).toString('utf8');
      truncated = true;
    }
    const done = t.blockId ? answer.header['state'] === 'done' : answer.header['running_block_id'] === null || answer.header['exited'] === true;
    const exitCode = typeof answer.header['exit_code'] === 'number' ? answer.header['exit_code'] : null;
    return { output: text, truncated, done, exitCode };
  };

  return {
    handles: (method) => (ACP_TERMINAL_METHODS as readonly string[]).includes(method),
    async handle(method, params) {
      try {
        switch (method) {
          case 'terminal/create': {
            const line = acpCommandLine(params);
            if (!line) return fail('terminal/create needs a command');
            const answer = await call('terminal_run', { command: line, wait: 'none' });
            if (answer.isError) return fail(answer.text);
            const tabId = typeof answer.header['tab_id'] === 'string' ? answer.header['tab_id'] : null;
            if (!tabId) return fail('Verse did not say which terminal ran the command');
            const limit = typeof params['outputByteLimit'] === 'number' && params['outputByteLimit'] > 0 ? Math.floor(params['outputByteLimit']) : null;
            const terminalId = `vt_${(counter += 1)}_${tabId}`;
            terminals.set(terminalId, { tabId, blockId: typeof answer.header['block_id'] === 'string' ? answer.header['block_id'] : null, outputLimit: limit });
            return { result: { terminalId } };
          }
          case 'terminal/output': {
            const t = tracked(params);
            if (!t) return fail('unknown terminal');
            const out = await output(t);
            return { result: { output: out.output, truncated: out.truncated, exitStatus: out.done ? { exitCode: out.exitCode, signal: null } : null } };
          }
          case 'terminal/wait_for_exit': {
            const t = tracked(params);
            if (!t) return fail('unknown terminal');
            const started = Date.now();
            for (;;) {
              const out = await output(t);
              if (out.done) return { result: { exitCode: out.exitCode, signal: null } };
              if (opts.signal.aborted || Date.now() - started > MAX_WAIT_MS) return { result: { exitCode: null, signal: 'SIGINT' } };
              await opts.sleep(POLL_MS);
            }
          }
          case 'terminal/kill': {
            const t = tracked(params);
            if (!t) return fail('unknown terminal');
            const answer = await call('terminal_interrupt', { tab_id: t.tabId });
            return answer.isError ? fail(answer.text) : { result: {} };
          }
          case 'terminal/release': {
            const id = typeof params['terminalId'] === 'string' ? params['terminalId'] : '';
            const t = terminals.get(id);
            terminals.delete(id);
            if (t) {
              // Still running → stop it (ACP: release kills a running command). The tab stays for reuse.
              const out = await output(t).catch(() => null);
              if (out && !out.done) await call('terminal_interrupt', { tab_id: t.tabId }).catch(() => null);
            }
            return { result: {} };
          }
          default:
            return { error: { code: -32601, message: 'Method not found' } };
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** The mcpServers entry Devin gets in session/new|load: http when it can, else the stdio bridge with the token FILE. */
export function acpMcpServers(mcp: DevinTurnVerseMcp | null | undefined, agentCapabilities: Json): Json[] {
  if (!mcp) return [];
  const mcpCaps = isRecord(agentCapabilities['mcpCapabilities']) ? agentCapabilities['mcpCapabilities'] : {};
  if (mcpCaps['http'] === true) {
    return [{ type: 'http', name: 'ashlr-verse', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }];
  }
  const [command, ...args] = mcp.stdio;
  return [{ name: 'ashlr-verse', command, args, env: [{ name: 'ASHLR_VERSE_MCP_TOKEN_FILE', value: mcp.tokenFile }] }];
}
