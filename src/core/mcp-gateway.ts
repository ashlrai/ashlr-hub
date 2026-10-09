/**
 * core/mcp-gateway.ts — MCP aggregation gateway + per-server probe.
 *
 * Two responsibilities:
 *
 *   1. probeServer(spec, timeoutMs): start ONE downstream MCP server as a child,
 *      list its tools, tear it down, and return an McpServerHealth. NEVER throws —
 *      startup failures, timeouts, and crashes surface in the returned health
 *      object (ok:false + error). Used by `ashlr mcp doctor` and gateway startup.
 *
 *   2. startGateway(registry): run a stdio MCP server (this process) that starts
 *      every discovered downstream as a child, namespaces their tools as
 *      `<server>__<tool>`, and proxies tools/list + tools/call to the correct
 *      downstream. ROBUST: per-downstream startup timeout; a downstream that
 *      fails to start is skipped with a stderr warning and never crashes the
 *      gateway. Point ANY agent at `ashlr mcp` to get every discovered tool.
 *
 * This module is the ONLY place (besides mcp-registry) allowed to depend on
 * @modelcontextprotocol/sdk.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { McpRegistry, McpServerSpec, McpServerHealth, HealEvent } from './types.js';
import { loadConfig } from './config.js';
import { withToolEnv } from './env-bridge.js';
import { withHeal, defaultHealPolicy } from './run/self-heal.js';
import { listNativeTools, isNativeTool, callNativeTool } from './mcp-native.js';
import { listFirmResources, listFirmResourceTemplates, readFirmResource } from './mcp-firm-resources.js';
import { hasSecretLikeArgv, redactedCommand } from './mcp-argv-safety.js';
import { scrubSecrets } from './util/scrub.js';
import { getLocusJobEnv, hasLocusJobEnv, withLocusJobChildEnv } from './integrations/locus-job-env.js';

// ---------------------------------------------------------------------------
// M105: Browser MCP probe + tool-call helpers
// ---------------------------------------------------------------------------

/**
 * Server name keywords that identify a Claude-in-Chrome / browser MCP server.
 * Matching is case-insensitive substring check against the spec.name.
 */
const BROWSER_SERVER_KEYWORDS = ['claude-in-chrome', 'chrome', 'browser'] as const;

/**
 * Tools that a compatible browser MCP server must expose (at least one must
 * be present for us to consider it reachable and usable).
 */
const BROWSER_REQUIRED_TOOLS = ['navigate', 'read_page', 'computer'] as const;

/**
 * Result of a browser-MCP reachability probe.
 * Exposed so apply.ts can call the gateway without importing the SDK.
 */
export interface BrowserProbeResult {
  reachable: boolean;
  serverName: string | null;
  /** Tools actually found on the server (subset we care about). */
  availableTools: string[];
  error?: string;
}

/**
 * Probe the configured MCP registry for a reachable Claude-in-Chrome (or
 * compatible) browser automation server.
 *
 * NEVER throws. Returns { reachable:false } on any failure so apply.ts can
 * degrade gracefully without crashing.
 *
 * @param registry   The discovered MCP servers to search.
 * @param timeoutMs  Per-probe startup/list timeout (default 8s).
 */
export async function probeBrowserMcp(
  registry: McpRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BrowserProbeResult> {
  // Find candidate specs by keyword matching on spec.name (case-insensitive).
  const candidates = registry.servers.filter((spec) => {
    const lower = spec.name.toLowerCase();
    return BROWSER_SERVER_KEYWORDS.some((kw) => lower.includes(kw));
  });

  if (candidates.length === 0) {
    return {
      reachable: false,
      serverName: null,
      availableTools: [],
      error: 'no browser MCP server configured (no spec name matches claude-in-chrome / chrome / browser)',
    };
  }

  // Try each candidate in order; first reachable one wins.
  for (const spec of candidates) {
    const health = await probeServer(spec, timeoutMs);
    if (!health.ok) continue;

    // Check that at least one required browser tool is present.
    const found = BROWSER_REQUIRED_TOOLS.filter((t) => health.tools.includes(t));
    if (found.length === 0) continue;

    return {
      reachable: true,
      serverName: spec.name,
      availableTools: health.tools,
    };
  }

  return {
    reachable: false,
    serverName: null,
    availableTools: [],
    error: `browser MCP server(s) found (${candidates.map((s) => s.name).join(', ')}) but none reachable or missing required tools`,
  };
}

/**
 * Call a tool on a browser MCP server (already known-reachable via
 * probeBrowserMcp). Opens a fresh connection, calls the tool, closes it.
 *
 * NEVER throws — any failure is returned as { ok:false, detail }.
 * The caller (apply.ts) is responsible for auditing the result.
 *
 * @param spec      The server spec to connect to.
 * @param toolName  The tool to call (e.g. 'navigate', 'read_page').
 * @param args      Arguments to pass to the tool.
 * @param timeoutMs Per-call timeout (default 8s).
 */
export async function callBrowserTool(
  spec: McpServerSpec,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string; result?: unknown }> {
  let client: Client | null = null;
  let cfgForCall: ReturnType<typeof loadConfig> | undefined;
  try { cfgForCall = loadConfig(); } catch { /* non-fatal */ }
  try {
    client = await connectDownstream(spec, timeoutMs, cfgForCall);
    const result = await withDeadline(
      client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs }),
      timeoutMs, `callTool(${spec.name}/${toolName})`,
    );
    return { ok: true, detail: `${spec.name}/${toolName} succeeded`, result };
  } catch (err) {
    const msg = safeErrorMessage(err);
    return { ok: false, detail: `${spec.name}/${toolName} failed: ${msg}` };
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Look up a browser MCP server spec by name in the registry.
 * Returns null when not found.
 */
export function findBrowserSpec(registry: McpRegistry, serverName: string): McpServerSpec | null {
  return registry.servers.find((s) => s.name === serverName) ?? null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-downstream startup/list timeout. */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Namespacing separator: gateway tool name = `<server>__<tool>`. */
const NS = '__';

/**
 * Env var set on every downstream child the gateway spawns. A downstream that
 * is itself an ashlr gateway can read this to refuse re-aggregation, providing
 * a second line of defense against the self-spawn fork bomb (the primary
 * defense is isSelfGateway() filtering at startGateway).
 */
export const GATEWAY_ENV_MARKER = 'ASHLR_MCP_GATEWAY';

// The MCP SDK deliberately spawns downstream servers with a NARROW env allowlist
// (not the full process.env) so ambient secrets don't leak into third-party servers.
// We preserve that isolation: downstreams get this safe base + ashlr's non-secret
// config keys (via withToolEnv) + their own declared spec.env — never the hub's full env.
const SAFE_CHILD_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'ASHLR_HOME',
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
] as const;
function safeChildBase(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const k of SAFE_CHILD_ENV_KEYS) {
    if (getLocusJobEnv()[k] !== undefined) base[k] = getLocusJobEnv()[k];
  }
  return base;
}

/**
 * True when a spec resolves to THIS aggregation gateway — i.e. running it as a
 * downstream would recurse (`ashlr mcp install` writes exactly such an entry:
 * name "ashlr", command <bin>/ashlr, args ['mcp']). We detect it structurally
 * (no path resolution needed): the canonical installed entry is `args`
 * containing 'mcp' AND the command basename being `ashlr`, OR the conventional
 * name 'ashlr' paired with an 'mcp' arg. Skipping these prevents an unbounded
 * fan-out of nested gateways.
 */
export function isSelfGateway(spec: McpServerSpec): boolean {
  const hasMcpArg = spec.args.includes('mcp');
  if (!hasMcpArg) return false;
  // basename of the command (handles absolute paths like /…/bin/ashlr)
  const base = spec.command.split('/').pop() ?? spec.command;
  return base === 'ashlr' || spec.name === 'ashlr';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bound an operation and clear its deadline on either settlement path. */
async function withDeadline<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function downstreamEnv(spec: McpServerSpec, cfg?: ReturnType<typeof loadConfig>): Record<string, string> {
  // Validate AFTER the per-server override. A declared HOME/LOCUS scope must
  // never replace a delegated job's captured identity at the final spawn.
  const merged = withLocusJobChildEnv({
    ...(cfg ? withToolEnv(cfg, safeChildBase()) : safeChildBase()),
    ...(spec.env ?? {}),
    [GATEWAY_ENV_MARKER]: '1',
  });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function refuseSharedJobGateway(): void {
  if (hasLocusJobEnv()) throw new Error('Shared MCP gateway unavailable inside a delegated Locus job');
}

function safeErrorMessage(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * Build a connected SDK Client for one downstream spec, racing the connect
 * against a timeout. The caller owns closing the returned client.
 * Throws on failure (caller wraps).
 */
async function connectDownstream(spec: McpServerSpec, timeoutMs: number, cfg?: ReturnType<typeof loadConfig>, capturedEnv?: Record<string, string>): Promise<Client> {
  if (hasSecretLikeArgv(spec.args)) {
    throw new Error(
      `unsafe MCP argv refused for "${spec.name}": ${redactedCommand(spec.command, spec.args)} ` +
      '(move credentials to env, Phantom, or a wrapper/config file)',
    );
  }
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    // Persistent recovery reuses the exact captured startup environment. One-off
    // job probes validate the final configured override against their snapshot.
    env: capturedEnv ? { ...capturedEnv } : downstreamEnv(spec, cfg),
    // Surface child stderr to our stderr for debugging; never pollutes stdio JSON-RPC.
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'ashlr-gateway', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    const connectPromise = client.connect(transport);
    let cancelled = false;
    // A late connect must not leave an unowned child after its deadline won.
    void connectPromise.then(() => {
      if (cancelled) {
        void client.close().catch(() => {});
        void transport.close().catch(() => {});
      }
    }, () => {});
    try {
      await withDeadline(connectPromise, timeoutMs, `connect(${spec.name})`);
    } catch (err) {
      cancelled = true;
      throw err;
    }
  } catch (err) {
    // SDK transport teardown reaps its child; bound awaiting a broken peer.
    try { await withDeadline(client.close(), timeoutMs, `close(${spec.name})`); } catch { /* ignore */ }
    try { await withDeadline(transport.close(), timeoutMs, `transport-close(${spec.name})`); } catch { /* ignore */ }
    throw err;
  }

  return client;
}

// ---------------------------------------------------------------------------
// probeServer
// ---------------------------------------------------------------------------

/**
 * Start a single downstream MCP server, list its tools, and tear it down.
 * NEVER throws — all failures (ENOENT, crash, timeout) are reported via the
 * returned McpServerHealth (ok:false, toolCount:0, tools:[], error:<msg>).
 *
 * @param spec       The downstream server spec to probe.
 * @param timeoutMs  Per-probe startup/list timeout (default 8s).
 */
export async function probeServer(
  spec: McpServerSpec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<McpServerHealth> {
  // M10: load config once so probeServer also bridges env into probed children.
  // loadConfig() is lightweight (fs read + merge); safe to call per-probe.
  let cfgForProbe: ReturnType<typeof loadConfig> | undefined;
  try { cfgForProbe = loadConfig(); } catch { /* non-fatal: fall back to process.env */ }
  let client: Client | null = null;
  try {
    client = await connectDownstream(spec, timeoutMs, cfgForProbe);

    const listed = await withDeadline(
      client.listTools({}, { timeout: timeoutMs }), timeoutMs, `tools/list(${spec.name})`,
    );

    const tools = (listed.tools ?? []).map((t) => t.name);
    return {
      name: spec.name,
      ok: true,
      toolCount: tools.length,
      tools,
    };
  } catch (err) {
    const msg = safeErrorMessage(err);
    return {
      name: spec.name,
      ok: false,
      toolCount: 0,
      tools: [],
      error: msg,
    };
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// startGateway
// ---------------------------------------------------------------------------

interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Keep failed configured servers too; discovery may recover them later. */
interface Downstream {
  spec: McpServerSpec;
  env: Record<string, string>;
  client: Client | null;
  tools: DownstreamTool[];
  generation: number;
  failures: number;
  retryAfter: number;
  inFlight?: Promise<void>;
}

/**
 * Persistent stdio aggregation. Read-only tools/list may reconnect a failed
 * configured server once after bounded backoff; effectful calls are never
 * retried. Recovery preserves the captured command, args and child environment.
 */
export async function startGateway(
  registry: McpRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  refuseSharedJobGateway();
  let gatewayCfg: ReturnType<typeof loadConfig> | undefined;
  try { gatewayCfg = loadConfig(); } catch { /* non-fatal; retain narrow child env */ }

  const downstreams: Downstream[] = registry.servers.filter((spec) => {
    if (!isSelfGateway(spec)) return true;
    process.stderr.write(`[ashlr mcp] skipping self "${spec.name}" (${redactedCommand(spec.command, spec.args)}) — would recurse\n`);
    return false;
  }).map((original) => {
    const spec = { ...original, args: [...original.args], env: original.env ? { ...original.env } : undefined };
    Object.freeze(spec.args);
    if (spec.env) Object.freeze(spec.env);
    Object.freeze(spec);
    return { spec, env: downstreamEnv(spec, gatewayCfg), client: null, tools: [], generation: 0, failures: 0, retryAfter: 0 };
  });
  interface Route { downstream: Downstream; client: Client; original: string }
  const routes = new Map<string, Route>();
  let closed = false;
  const noHeal = process.env['ASHLR_NO_HEAL'] === '1';

  const rebuildRoutes = (): void => {
    routes.clear();
    if (closed) return;
    for (const d of downstreams) {
      if (!d.client) continue;
      for (const tool of d.tools) {
        const key = `${d.spec.name}${NS}${tool.name}`;
        if (isNativeTool(key)) continue;
        routes.set(key, { downstream: d, client: d.client, original: tool.name });
      }
    }
  };
  const closeClient = async (client: Client): Promise<void> => {
    try { await withDeadline(client.close(), timeoutMs, 'downstream close'); } catch { /* best effort; no retry */ }
  };
  const drop = async (d: Downstream, client: Client | null): Promise<void> => {
    if (client && d.client !== client) return; // an old peer cannot revoke its replacement
    d.generation++;
    d.client = null;
    d.tools = [];
    d.failures++;
    d.retryAfter = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(d.failures - 1, 6));
    rebuildRoutes(); // revoke before awaiting cleanup
    if (client) await closeClient(client);
  };

  const refresh = (d: Downstream, startup = false): Promise<void> => {
    if (closed) return Promise.resolve();
    if (d.inFlight) return d.inFlight;
    if (!d.client && Date.now() < d.retryAfter) return Promise.resolve();
    const generation = d.generation;
    const operation = (async (): Promise<void> => {
      let client = d.client;
      try {
        if (!client) {
          const connect = (): Promise<Client> => connectDownstream(d.spec, timeoutMs, undefined, d.env);
          client = startup && !noHeal
            ? await withHeal(connect, defaultHealPolicy(), (event: HealEvent) => {
              process.stderr.write(`[ashlr mcp] heal(${event.kind}) "${d.spec.name}" attempt ${event.attempt}: ${safeErrorMessage(event.detail)}\n`);
            })
            : await connect();
          if (closed || generation !== d.generation) { await closeClient(client); return; }
          d.client = client;
          const connected = client;
          client.onclose = () => { if (!closed && d.client === connected) void drop(d, connected); };
        }
        const listed = await withDeadline(client.listTools({}, { timeout: timeoutMs }), timeoutMs, `tools/list(${d.spec.name})`);
        const tools = (listed.tools ?? []).map((tool) => {
          if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('Invalid downstream tool name');
          return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
        });
        if (closed || generation !== d.generation || d.client !== client) return;
        d.tools = tools;
        d.failures = 0;
        d.retryAfter = 0;
        rebuildRoutes(); // replace the complete inventory, including deleted tools
      } catch (err) {
        if (closed || generation !== d.generation) return;
        await drop(d, client);
        process.stderr.write(`[ashlr mcp] WARN tools/list("${d.spec.name}") failed: ${safeErrorMessage(err)}\n`);
      }
    })();
    d.inFlight = operation;
    const clearFlight = (): void => { if (d.inFlight === operation) d.inFlight = undefined; };
    void operation.then(clearFlight, clearFlight);
    return operation;
  };

  await Promise.all(downstreams.map((d) => refresh(d, true)));
  const server = new Server({ name: 'ashlr', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
  const assertUsable = (): void => {
    refuseSharedJobGateway();
    if (closed) throw new Error('MCP gateway is closed');
  };
  server.setRequestHandler(ListResourcesRequestSchema, async () => { assertUsable(); return listFirmResources(); });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => { assertUsable(); return listFirmResourceTemplates(); });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => { assertUsable(); return readFirmResource(request.params.uri); });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    assertUsable();
    const tools: { name: string; description?: string; inputSchema: unknown }[] = listNativeTools()
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    await Promise.all(downstreams.map((d) => refresh(d)));
    assertUsable();
    // Completion order never changes route precedence or response order.
    for (const d of downstreams) {
      if (!d.client) continue;
      for (const tool of d.tools) {
        const key = `${d.spec.name}${NS}${tool.name}`;
        if (isNativeTool(key)) {
          process.stderr.write(`[ashlr mcp] WARN downstream "${key}" collides with a native ashlr tool — skipped\n`);
          continue;
        }
        tools.push({ name: key, description: `[${d.spec.name}] ${tool.description ?? tool.name}`, inputSchema: tool.inputSchema ?? { type: 'object' } });
      }
    }
    return { tools } as { tools: { name: string; description?: string; inputSchema: object }[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    assertUsable();
    const requested = request.params.name;
    if (isNativeTool(requested)) return callNativeTool(requested, request.params.arguments ?? {});
    const route = routes.get(requested);
    if (!route || route.downstream.client !== route.client) {
      throw new Error(`Unknown tool "${requested}". Run \`ashlr mcp list\` to see available tools.`);
    }
    try {
      return await withDeadline(route.client.callTool({ name: route.original, arguments: request.params.arguments ?? {} }, undefined, { timeout: timeoutMs }), timeoutMs, `tools/call(${route.downstream.spec.name})`);
    } catch (err) {
      await drop(route.downstream, route.client);
      throw err; // never replay an effectful request, even after reconnection
    }
  });

  let closing: Promise<void> | undefined;
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  let onSignal: (signal: NodeJS.Signals) => void;
  const closeAll = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    const clients = downstreams.flatMap((d) => {
      d.generation++;
      const client = d.client;
      d.client = null;
      d.tools = [];
      return client ? [client] : [];
    });
    routes.clear();
    // Defer teardown until `closing` is assigned: server.close may call our
    // onclose handler synchronously, and every shutdown path shares this job.
    closing = Promise.resolve().then(async () => {
      await Promise.all([
        Promise.all(clients.map(closeClient)),
        withDeadline(server.close(), timeoutMs, 'gateway close').catch(() => {}),
        Promise.allSettled(downstreams.map((d) => d.inFlight)),
      ]);
    });
    return closing;
  };
  const finished = new Promise<void>((resolve) => {
    const finish = (): void => { void closeAll().then(resolve, resolve); };
    server.onclose = finish;
    onSignal = (signal): void => {
      process.stderr.write(`[ashlr mcp] received ${signal} — shutting down\n`);
      finish();
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
  try {
    await server.connect(new StdioServerTransport());
    if (!closed) process.stderr.write(`[ashlr mcp] gateway ready — ${listNativeTools().length} native ashlr tool(s) + ${routes.size} downstream tool(s) from ${downstreams.filter((d) => d.client).length}/${downstreams.length} server(s)\n`);
    await finished;
  } finally {
    await closeAll();
  }
}
