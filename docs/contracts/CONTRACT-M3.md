# CONTRACT-M3 — MCP single entry point

M3 makes `ashlr` the single MCP entry point for any agent: a discovery registry,
an aggregation gateway, an ecosystem tools registry, and the `ashlr mcp` CLI.

Runtime dependency: `@modelcontextprotocol/sdk` (gateway/registry ONLY). All other
core/cli modules stay zero-dep.

All shared types live in `src/core/types.ts` (added this milestone):
`McpServerSpec`, `McpRegistry`, `AggregatedTool`, `McpServerHealth`, `ToolInfo`,
`ToolsRegistry`. Build agents import these and MUST NOT redefine them.

Each build agent writes ONLY its own file(s). Do NOT git commit.

---

## SAFETY GUARDRAILS (mandatory for every build agent)

- NEVER run `ashlr mcp install` (or otherwise write) against the REAL
  `~/.claude.json`, `~/.claude/settings.json`, `~/.mcp.json`, or
  `~/.ashlrcode/settings.json` during build/verify. Test install ONLY against a
  TEMP config file (e.g. `os.tmpdir()`). Install code must back up + merge
  idempotently — never clobber.
- Discovery/registry READS the real configs (read-only) — fine. Never print
  secret env VALUES; redact every env value to the literal string `<set>` in any
  printed/serialized-for-display form.
- Gateway startup of real downstreams during verify must use short timeouts; do
  not let anything hang. Per-downstream startup TIMEOUT is 8s; a downstream that
  fails to start is skipped with a warning to stderr and never crashes the
  gateway.

---

## EXACT SIGNATURES

### `src/core/mcp-registry.ts`

```ts
import type { McpRegistry } from './types.js';

/**
 * Discover MCP servers already configured on this machine.
 *
 * Reads the known config paths (see knownConfigPaths), parses each `mcpServers`
 * object ({ <name>: { command, args, env? } }), and returns deduped specs
 * (dedupe by `name`; first occurrence wins, stable order). Recognizes the
 * ashlr-plugin server (name "ashlr") and phantom (name "phantom-secrets") when
 * present. Never throws: unreadable/malformed configs are skipped. When
 * producing ANY printed/displayed form, redact every env value to '<set>'.
 */
export function discoverMcpServers(): McpRegistry;

/**
 * The known config file paths discovery scans, in scan order. Absolute paths:
 *   ~/.claude.json, ~/.claude/settings.json, ~/.mcp.json,
 *   ~/.ashlrcode/settings.json, and ashlr-workbench agent settings.
 */
export function knownConfigPaths(): string[];
```

### `src/core/mcp-gateway.ts`

```ts
import type { McpRegistry, McpServerSpec, McpServerHealth } from './types.js';

/**
 * Run the stdio MCP aggregation gateway.
 *
 * Starts each discovered downstream server as a child, lists their tools, and
 * exposes them namespaced as `<server>__<tool>`. Proxies tools/list and
 * tools/call to the correct downstream. Per-downstream startup TIMEOUT is 8s; a
 * downstream that fails to start is skipped with a warning logged to stderr and
 * never crashes the gateway. Resolves when the server is wired to stdio.
 */
export async function startGateway(registry: McpRegistry): Promise<void>;

/**
 * Probe a single downstream server: start it, list its tools, return health,
 * and ALWAYS tear it down (even on error/timeout). Default timeout 8000ms.
 * Never throws — failures are reported via the returned health (ok:false,
 * error set).
 */
export async function probeServer(spec: McpServerSpec, timeoutMs?: number): Promise<McpServerHealth>;
```

### `src/core/tools-registry.ts`

```ts
import type { ToolsRegistry } from './types.js';

/**
 * Detect installed ecosystem tools + versions via PATH (which + --version).
 * Fast and NEVER throws — a missing tool yields { installed:false, version:null,
 * path:null }. Detects: phantom, ashlr/ashlr-plugin, stack, pulse/pulse-agent,
 * ashlrcode, aw (ashlr-workbench), morphkit, binshield, ashlr-md, ashlr-hub.
 */
export function getToolsRegistry(): ToolsRegistry;
```

### `src/cli/mcp.ts`

```ts
/**
 * `ashlr mcp` command dispatcher. Subcommands (args[0]):
 *   - (default / "run"): run the aggregation gateway on stdio
 *       (discoverMcpServers -> startGateway).
 *   - "list":   print the registry + per-server tool counts (env values redacted).
 *   - "doctor": per-server health (starts? #tools?) via probeServer.
 *   - "install <claude|ashlrcode> [--config <path>]": idempotently add the ashlr
 *       gateway to a target mcpServers config. BACK UP the file first; merge,
 *       don't clobber. NEVER target the real configs during verify — only a TEMP
 *       path passed via --config.
 * Returns a process exit code (0 = success).
 */
export async function cmdMcp(args: string[]): Promise<number>;
```

---

## CLI surface (`ashlr mcp ...`)

- `ashlr mcp` — run the gateway on stdio (default). Point any agent here.
- `ashlr mcp list` — registry + per-server tool counts.
- `ashlr mcp doctor` — per-server health (starts? #tools?).
- `ashlr mcp install <claude|ashlrcode> [--config <path>]` — idempotently add the
  ashlr gateway to a target mcpServers config (back up first; merge, don't clobber).

Additionally, `ashlr status` and `ashlr doctor` surface the ecosystem tools
summary from `getToolsRegistry()`.
