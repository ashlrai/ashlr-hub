/** Isolated native adapter: native Claude owns its login; this broker owns only tool
 * capabilities. No Fleet matcher or credential source is installed by this module. */
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { NativeSeatLaunch } from '../resources/native-profile.js';
import { workerEnvironment } from '../resources/worker.js';
import { scrubSecrets } from '../util/scrub.js';

const HASH = /^[a-f0-9]{64}$/;
const MAX_REQUEST = 1024 * 1024;
const TOOLS = ['read_file', 'write_file'] as const;
export interface ClaudeBrokerScope {
  runId: string; seatId: string; accountDigest: string; profileDigest: string; epochDigest: string; model: string;
}
/** Supplied by the host's validated native observations, never request JSON. */
export interface ClaudeBrokerObservation extends ClaudeBrokerScope {
  observedAtMs: number; expiresAtMs: number; authMethod: 'claude.ai'; extraUsageEnabled: false;
}
export type ClaudeBrokerExecutor = (call: { name: typeof TOOLS[number]; path: string; text?: string },
  signal: AbortSignal, admission: () => boolean) => Promise<string>;

function exactScope(a: ClaudeBrokerScope, b: ClaudeBrokerScope): boolean {
  return a.runId === b.runId && a.seatId === b.seatId && a.accountDigest === b.accountDigest &&
    a.profileDigest === b.profileDigest && a.epochDigest === b.epochDigest && a.model === b.model;
}
function validScope(scope: ClaudeBrokerScope): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(scope.runId) && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope.seatId) &&
    [scope.accountDigest, scope.profileDigest, scope.epochDigest].every(value => HASH.test(value)) &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(scope.model);
}
/** Native restricted mode plus an empty built-in tool list leaves only our
 * explicitly supplied MCP server. Prompt goes on stdin, never in argv. */
export function claudeBrokerCommand(launch: NativeSeatLaunch, scope: ClaudeBrokerScope, mcpConfigPath: string): {
  bin: string; args: string[];
} {
  if (!validScope(scope) || launch.provider !== 'claude' || launch.seatId !== scope.seatId ||
    launch.command.length !== 2 || !launch.command.every(isAbsolute) || !isAbsolute(mcpConfigPath)) {
    throw new Error('native broker launch unconfirmed');
  }
  return { bin: launch.command[0], args: [launch.command[1], '-p', '--output-format', 'stream-json', '--verbose',
    '--model', scope.model, '--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--allowedTools=mcp__ashlr-fleet-broker', '--no-chrome', '--no-session-persistence'] };
}
/** Native authentication belongs to the pinned launcher. API keys, loader,
 * proxy and account-switching overrides from the host are never inherited. */
export function claudeBrokerNativeEnvironment(): NodeJS.ProcessEnv {
  return { ...workerEnvironment(), CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

export interface ClaudeBrokerOptions {
  scope: ClaudeBrokerScope;
  /** A read-only current source port; an older matching profile is not a login. */
  observation(): ClaudeBrokerObservation | null;
  admission(): boolean;
  execute: ClaudeBrokerExecutor;
  signal?: AbortSignal;
  now?: () => number;
}
export interface ClaudeBrokerHandle {
  url: string;
  /** A run-local tool capability, not a provider credential. Write only into a
   * private MCP config outside the agent worktree; never log or put in argv. */
  capability: string;
  close(): Promise<void>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function credentialMatches(raw: string | undefined, capability: string): boolean {
  // HTTP permits Latin-1 header bytes. Equal JS character counts do not prove
  // equal UTF-8 byte counts; timingSafeEqual throws on mismatched buffers.
  if (typeof raw !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(raw)) return false;
  const candidate = Buffer.from(raw.slice(7), 'ascii');
  const expected = Buffer.from(capability, 'ascii');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST) throw new Error('request too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function startClaudeNativeBroker(options: ClaudeBrokerOptions): Promise<ClaudeBrokerHandle> {
  if (!validScope(options.scope)) throw new Error('invalid native broker scope');
  const scope = Object.freeze({ ...options.scope });
  const now = options.now ?? Date.now;
  const capability = randomBytes(32).toString('base64url');
  const active = new Set<AbortController>();
  const requests = new Set<Promise<void>>();
  let closing: Promise<void> | null = null;
  const current = (): boolean => {
    try {
      const observation = options.observation(); const time = now();
      return closing === null && !options.signal?.aborted && options.admission() === true && observation !== null &&
        exactScope(scope, observation) && observation.authMethod === 'claude.ai' && observation.extraUsageEnabled === false &&
        Number.isSafeInteger(time) && Number.isSafeInteger(observation.observedAtMs) && Number.isSafeInteger(observation.expiresAtMs) &&
        observation.observedAtMs <= time && observation.expiresAtMs > time &&
        observation.expiresAtMs - observation.observedAtMs <= 60_000;
    } catch { return false; }
  };
  const server = createServer((req, res) => {
    const answer = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      const text = JSON.stringify(value);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text);
    };
    if (req.url !== '/mcp' || req.headers.origin !== undefined ||
      req.headers['x-api-key'] !== undefined || req.headers['proxy-authorization'] !== undefined ||
      !credentialMatches(req.headers.authorization, capability)) {
      req.resume(); answer(403, { error: 'tool capability refused' }); return;
    }
    if (!current()) { req.resume(); answer(403,{error:'tool authority unavailable'}); return; }
    if (req.method !== 'POST') {
      req.resume(); res.writeHead(405,{Allow:'POST'}); res.end(); return;
    }
    const protocol = req.headers['mcp-protocol-version'];
    if (protocol !== undefined && !['2024-11-05','2025-03-26','2025-06-18'].includes(String(protocol))) {
      req.resume(); answer(400,{error:'unsupported negotiated protocol'}); return;
    }
    const controller = new AbortController(); active.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const request = (async () => {
      const input = await body(req);
      if (!record(input) || input.jsonrpc !== '2.0' || typeof input.method !== 'string' || !current()) {
        answer(403, { error: 'tool authority unavailable' }); return;
      }
      if (input.id === undefined && input.method === 'notifications/initialized') {
        res.writeHead(202); res.end(); return;
      }
      if (!(typeof input.id === 'string' && input.id.length <= 256 || typeof input.id === 'number' && Number.isSafeInteger(input.id))) {
        answer(400, {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}}); return;
      }
      const result = (value: unknown) => answer(200, { jsonrpc: '2.0', id: input.id, result: value });
      const rpcError = (code: number, message: string) => answer(200, {jsonrpc:'2.0',id:input.id,error:{code,message}});
      if (input.method === 'ping') { result({}); return; }
      if (input.method === 'initialize') {
        const version = record(input.params) ? input.params.protocolVersion : null;
        if (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version)) { rpcError(-32602,'Invalid initialization parameters'); return; }
        const negotiated = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(version) ? version : '2025-06-18';
        result({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: { name: 'ashlr-fleet-broker', version: '0.1.0' } }); return;
      }
      if (input.method === 'tools/list') {
        result({ tools: TOOLS.map(name => ({ name, description: name === 'read_file' ? 'Read a worktree file' : 'Write a worktree file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, ...(name === 'write_file' ? { text: { type: 'string' } } : {}) },
            required: name === 'write_file' ? ['path', 'text'] : ['path'], additionalProperties: false } })) }); return;
      }
      if (input.method !== 'tools/call') { rpcError(-32601,'Method not found'); return; }
      const params = input.params;
      const args = record(params) ? params.arguments : null;
      if (!record(params) || !TOOLS.includes(params.name as typeof TOOLS[number]) ||
        !record(args) || typeof args.path !== 'string' || args.path.length > 4096 ||
        Object.keys(args).some(key => key !== 'path' && key !== 'text') ||
        (params.name === 'write_file' ? typeof args.text !== 'string' : args.text !== undefined)) {
        rpcError(-32602,'Unsupported tool parameters'); return;
      }
      let text: string;
      try {
        text = await options.execute({ name: params.name as typeof TOOLS[number], path: args.path,
          ...(typeof args.text === 'string' ? { text: args.text } : {}) }, controller.signal,
        () => !controller.signal.aborted && current());
      } catch {
        if (!current() || controller.signal.aborted) { answer(403,{error:'tool authority changed'}); return; }
        // A filesystem failure is model-readable, without exposing exception
        // paths, credentials or private host metadata.
        result({content:[{type:'text',text:'Tool request refused'}],isError:true}); return;
      }
      if (!current() || controller.signal.aborted) { answer(403, { error: 'tool authority changed' }); return; }
      result({ content: [{ type: 'text', text: scrubSecrets(text).slice(0, 32 * 1024) }] });
    })().catch(() => answer(400, {jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid request body'}})).finally(() => {
      active.delete(controller); requests.delete(request);
    });
    requests.add(request);
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('native broker listener unavailable');
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = new Promise<void>(resolve => {
      for (const controller of active) controller.abort();
      server.close(() => resolve()); server.closeAllConnections();
    }).then(async () => { await Promise.allSettled([...requests]); });
    options.signal?.removeEventListener('abort', onAbort);
    return closing;
  };
  const onAbort = () => { void close(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) await close();
  return { url: `http://127.0.0.1:${address.port}/mcp`, capability, close };
}
