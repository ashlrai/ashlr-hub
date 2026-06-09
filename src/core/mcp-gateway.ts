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
} from '@modelcontextprotocol/sdk/types.js';

import type { McpRegistry, McpServerSpec, McpServerHealth, HealEvent } from './types.js';
import { loadConfig } from './config.js';
import { withToolEnv } from './env-bridge.js';
import { withHeal, defaultHealPolicy } from './run/self-heal.js';

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
const SAFE_CHILD_ENV_KEYS = ['HOME', 'PATH', 'SHELL', 'TERM', 'USER', 'LOGNAME'] as const;
function safeChildBase(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const k of SAFE_CHILD_ENV_KEYS) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
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

/** Reject after `ms` with a timeout error. */
function timeout<T>(ms: number, label: string): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Don't keep the event loop alive solely for this timer.
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Build a connected SDK Client for one downstream spec, racing the connect
 * against a timeout. The caller owns closing the returned client.
 * Throws on failure (caller wraps).
 */
async function connectDownstream(spec: McpServerSpec, timeoutMs: number, cfg?: ReturnType<typeof loadConfig>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    // Merge spec env with a self-marker so any downstream that happens to be an
    // ashlr gateway can detect it was launched BY a gateway and refuse to
    // re-aggregate (belt-and-suspenders against the self-spawn fork bomb).
    // M10 env-bridge: project unified config into each downstream child, then
    // let spec.env override (per-server keys win over hub-wide defaults).
    // The gateway marker is set last so it can never be clobbered by spec.env.
    env: {
      ...(cfg ? withToolEnv(cfg, safeChildBase()) : safeChildBase()),
      ...(spec.env ?? {}),
      [GATEWAY_ENV_MARKER]: '1',
    },
    // Surface child stderr to our stderr for debugging; never pollutes stdio JSON-RPC.
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'ashlr-gateway', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    // Capture the connect promise and pre-attach a no-op catch so that when the
    // timeout branch wins the race, the still-pending connect's eventual
    // rejection has a handler — otherwise it surfaces as an unhandledRejection
    // (noisy on Node 22, fatal under --unhandled-rejections=throw).
    const connectPromise = client.connect(transport);
    connectPromise.catch(() => { /* losing-branch rejection swallowed */ });
    await Promise.race([
      connectPromise,
      timeout<void>(timeoutMs, `connect(${spec.name})`),
    ]);
  } catch (err) {
    // Ensure the child is reaped on a failed/timed-out connect.
    try { await client.close(); } catch { /* ignore */ }
    try { await transport.close(); } catch { /* ignore */ }
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

    const listed = await Promise.race([
      client.listTools({}, { timeout: timeoutMs }),
      timeout<{ tools: { name: string }[] }>(timeoutMs, `tools/list(${spec.name})`),
    ]);

    const tools = (listed.tools ?? []).map((t) => t.name);
    return {
      name: spec.name,
      ok: true,
      toolCount: tools.length,
      tools,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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

/** A connected downstream and the tools it advertises (downstream names). */
interface Downstream {
  spec: McpServerSpec;
  client: Client;
  toolNames: Set<string>;
}

/**
 * Run the aggregation gateway on stdio.
 *
 * Starts every server in `registry` as a child (skipping any that fail to start
 * within the timeout, with a stderr warning), exposes their tools namespaced as
 * `<server>__<tool>`, and proxies tools/list + tools/call to the owning
 * downstream. Resolves only when the gateway transport closes (stdin EOF).
 *
 * @param registry   The discovered MCP servers to aggregate.
 * @param timeoutMs  Per-downstream startup timeout (default 8s).
 */
export async function startGateway(
  registry: McpRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  // M10: load config once for the gateway lifetime so all downstream spawns
  // inherit the unified config env. Non-fatal if config is unreadable.
  let gatewayCfg: ReturnType<typeof loadConfig> | undefined;
  try { gatewayCfg = loadConfig(); } catch { /* non-fatal: fall back to process.env */ }

  // ── Self-exclusion: never aggregate ourself (fork-bomb guard) ─────────────
  // `ashlr mcp install` writes a downstream entry pointing back at this gateway.
  // Discovering and spawning it would recurse without bound. Filter it out here
  // (primary defense); the ASHLR_MCP_GATEWAY env marker on spawned children is
  // the secondary defense for any path that bypasses this.
  const aggregable = registry.servers.filter((spec) => {
    if (isSelfGateway(spec)) {
      process.stderr.write(
        `[ashlr mcp] skipping self "${spec.name}" (${spec.command} ${spec.args.join(' ')}) — would recurse\n`,
      );
      return false;
    }
    return true;
  });

  // ── Connect every downstream in parallel; skip failures ───────────────────
  const settled = await Promise.allSettled(
    aggregable.map(async (spec): Promise<Downstream> => {
      // M20: bounded self-heal — restart a crashed downstream up to maxRestarts
      // times before falling through to the existing skip-on-failure path.
      // Opt-out: ASHLR_NO_HEAL env var disables the heal wrapper.
      const noHeal = process.env['ASHLR_NO_HEAL'] === '1';
      let client: Client;
      if (noHeal) {
        client = await connectDownstream(spec, timeoutMs, gatewayCfg);
      } else {
        const healPolicy = defaultHealPolicy();
        client = await withHeal(
          (_attempt) => connectDownstream(spec, timeoutMs, gatewayCfg),
          healPolicy,
          (event: HealEvent) => {
            process.stderr.write(
              `[ashlr mcp] heal(${event.kind}) "${spec.name}" attempt ${event.attempt}: ${event.detail}\n`,
            );
          },
        );
      }
      let toolNames = new Set<string>();
      try {
        const listed = await Promise.race([
          client.listTools({}, { timeout: timeoutMs }),
          timeout<{ tools: { name: string }[] }>(timeoutMs, `tools/list(${spec.name})`),
        ]);
        toolNames = new Set((listed.tools ?? []).map((t) => t.name));
      } catch (err) {
        // Connected but couldn't list — close and rethrow so it's skipped.
        try { await client.close(); } catch { /* ignore */ }
        throw err;
      }
      return { spec, client, toolNames };
    }),
  );

  const downstreams: Downstream[] = [];
  settled.forEach((result, i) => {
    const name = aggregable[i]?.name ?? '(unknown)';
    if (result.status === 'fulfilled') {
      downstreams.push(result.value);
      process.stderr.write(
        `[ashlr mcp] connected "${name}" (${result.value.toolNames.size} tools)\n`,
      );
    } else {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      process.stderr.write(`[ashlr mcp] WARN skipping "${name}": ${reason}\n`);
    }
  });

  // ── Route map: namespaced gateway tool name -> { downstream, originalName } ─
  interface Route { downstream: Downstream; original: string }
  const routes = new Map<string, Route>();
  for (const d of downstreams) {
    for (const toolName of d.toolNames) {
      const key = `${d.spec.name}${NS}${toolName}`;
      // Guard: a server name containing the NS separator can collide with a
      // different (server, tool) pair, silently shadowing one route. Warn so the
      // ambiguity is visible rather than last-writer-wins.
      const prior = routes.get(key);
      if (prior && prior.downstream.spec.name !== d.spec.name) {
        process.stderr.write(
          `[ashlr mcp] WARN namespace collision on "${key}" ` +
          `("${prior.downstream.spec.name}" vs "${d.spec.name}") — last one wins\n`,
        );
      }
      routes.set(key, { downstream: d, original: toolName });
    }
  }

  // ── Build the gateway server ──────────────────────────────────────────────
  const server = new Server(
    { name: 'ashlr', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // tools/list — aggregate every downstream's tools, namespaced.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: { name: string; description?: string; inputSchema: unknown }[] = [];
    // Re-list live so the gateway reflects the current downstream tool set.
    for (const d of downstreams) {
      try {
        const listed = await d.client.listTools({}, { timeout: timeoutMs });
        for (const t of listed.tools ?? []) {
          tools.push({
            name: `${d.spec.name}${NS}${t.name}`,
            description: t.description
              ? `[${d.spec.name}] ${t.description}`
              : `[${d.spec.name}] ${t.name}`,
            inputSchema: t.inputSchema ?? { type: 'object' },
          });
          // Keep the route map fresh for tools/call.
          routes.set(`${d.spec.name}${NS}${t.name}`, { downstream: d, original: t.name });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ashlr mcp] WARN tools/list("${d.spec.name}") failed: ${msg}\n`);
      }
    }
    // The SDK validates the result against ListToolsResultSchema.
    return { tools } as { tools: { name: string; description?: string; inputSchema: object }[] };
  });

  // tools/call — proxy to the owning downstream by namespaced name.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requested = request.params.name;
    const route = routes.get(requested);
    if (!route) {
      throw new Error(
        `Unknown tool "${requested}". Expected "<server>${NS}<tool>" form. ` +
        `Run \`ashlr mcp list\` to see available tools.`,
      );
    }
    const result = await route.downstream.client.callTool(
      {
        name: route.original,
        arguments: request.params.arguments ?? {},
      },
      undefined,
      { timeout: timeoutMs },
    );
    return result;
  });

  // ── Graceful shutdown: close every downstream on exit ─────────────────────
  // Runs exactly once even if multiple shutdown paths fire (stdin EOF +
  // SIGTERM/SIGINT). Tracks downstreams via closure so signal handlers reach
  // them and reap the spawned children rather than orphaning them.
  let closed = false;
  const closeAll = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const d of downstreams) {
      try { await d.client.close(); } catch { /* ignore */ }
    }
  };

  // ── Serve on stdio ────────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[ashlr mcp] gateway ready — ${routes.size} tool(s) from ` +
    `${downstreams.length}/${aggregable.length} server(s)\n`,
  );

  // Resolve when the transport closes (stdin EOF) OR a termination signal
  // arrives — awaiting closeAll() in every path so children are torn down
  // before we exit (the SDK's own child SIGTERM→SIGKILL teardown can take ~4s).
  await new Promise<void>((resolve) => {
    const finish = (): void => { void closeAll().finally(() => resolve()); };

    // stdin EOF (normal MCP client disconnect).
    server.onclose = finish;

    // Signal-based shutdown (common, normal termination path) — onclose does
    // not necessarily fire, so handle SIGINT/SIGTERM explicitly.
    const onSignal = (sig: NodeJS.Signals): void => {
      process.stderr.write(`[ashlr mcp] received ${sig} — shutting down\n`);
      finish();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}
