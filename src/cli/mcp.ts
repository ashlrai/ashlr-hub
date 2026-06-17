/**
 * `ashlr mcp` command dispatcher.
 *
 * Subcommands:
 *   (default / "run")  — run the aggregation gateway on stdio
 *   "list"             — print discovered servers + per-server tool counts; --json
 *   "doctor"           — per-server health (starts? #tools?); --json; exit 1 if required servers down
 *   "install <target> [--config <path>]" — idempotently add "ashlr" gateway entry to a target config
 *
 * SAFETY: install NEVER targets real configs unless explicitly passed via --config or invoked
 * interactively with the real target paths. In tests, always pass --config to a temp file.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

import type { McpServerSpec, McpServerHealth } from '../core/types.js';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

import { pad, makeColors, isTty } from './ui.js';

const { bold, dim, red, green, yellow, cyan, gray, magenta } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy imports — the gateway/registry modules depend on @modelcontextprotocol/sdk
// and must be dynamically imported so that non-gateway commands stay fast.
// ---------------------------------------------------------------------------

async function importRegistry() {
  return import('../core/mcp-registry.js') as Promise<{
    discoverMcpServers: () => import('../core/types.js').McpRegistry;
    knownConfigPaths: () => string[];
  }>;
}

async function importGateway() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await (import('../core/mcp-gateway.js' as string) as Promise<any>);
  return mod as {
    startGateway: (registry: import('../core/types.js').McpRegistry) => Promise<void>;
    probeServer: (spec: McpServerSpec, timeoutMs?: number) => Promise<McpServerHealth>;
  };
}

async function importToolsRegistry() {
  return import('../core/tools-registry.js') as Promise<{
    getToolsRegistry: () => import('../core/types.js').ToolsRegistry;
  }>;
}

// ---------------------------------------------------------------------------
// Redaction — env values MUST never be printed
// ---------------------------------------------------------------------------

function redactEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    result[key] = '<set>';
  }
  return result;
}

// Secrets are frequently passed as CLI args (e.g. `--access-token sbp_…`,
// `--api-key=sk_test_…`), not just env. Redact them before any display so
// `mcp list` / `--json` never surface real credentials.
const SENSITIVE_FLAG = /(?:^|[-_])(?:token|key|secret|password|passwd|auth|credential|api[-_]?key|access[-_]?token|bearer|dsn)$/i;
const SECRET_TOKEN = /(?:sk-|sk_live_|sk_test_|rk_live_|rk_test_|sbp_|pk_live_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{10,}|eyJ[A-Za-z0-9_-]{10,})/;

export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) { out.push('<redacted>'); redactNext = false; continue; }
    const eq = arg.match(/^(--?[A-Za-z0-9][\w-]*)=(.+)$/);
    if (eq && SENSITIVE_FLAG.test(eq[1])) { out.push(`${eq[1]}=<redacted>`); continue; }
    if (/^--?[A-Za-z]/.test(arg) && SENSITIVE_FLAG.test(arg.replace(/^--?/, ''))) { out.push(arg); redactNext = true; continue; }
    if (SECRET_TOKEN.test(arg)) { out.push('<redacted>'); continue; }
    out.push(arg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolve the absolute path to the bin/ashlr executable
// ---------------------------------------------------------------------------

function resolveAshlrBin(): string {
  // __filename is unavailable in ESM; resolve relative to this module file
  const thisFile = fileURLToPath(import.meta.url);
  // src/cli/mcp.ts  ->  two levels up = project root
  const projectRoot = resolve(dirname(thisFile), '..', '..');
  const binPath = join(projectRoot, 'bin', 'ashlr');
  return binPath;
}

// ---------------------------------------------------------------------------
// Default target config paths for `ashlr mcp install`
// ---------------------------------------------------------------------------

const DEFAULT_TARGETS: Record<string, string> = {
  claude:     join(homedir(), '.claude.json'),
  ashlrcode:  join(homedir(), '.ashlrcode', 'settings.json'),
};

// ---------------------------------------------------------------------------
// Subcommand: run (default)
// ---------------------------------------------------------------------------

async function cmdMcpRun(): Promise<number> {
  // Pure stdio — log only to stderr, never stdout
  try {
    const { discoverMcpServers } = await importRegistry();
    const { startGateway } = await importGateway();
    const registry = discoverMcpServers();
    process.stderr.write(`[ashlr mcp] starting gateway with ${registry.servers.length} discovered server(s)\n`);
    await startGateway(registry);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ashlr mcp] gateway error: ${msg}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

async function cmdMcpList(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');

  const { discoverMcpServers } = await importRegistry();
  const { getToolsRegistry } = await importToolsRegistry();

  const registry = discoverMcpServers();
  const toolsReg = getToolsRegistry();

  // M31: native ashlr tools served by the gateway itself (no probe needed).
  const { nativeToolDefs } = await import('../core/mcp-native.js');
  const native = nativeToolDefs();

  if (jsonMode) {
    // Redact env before serializing
    const safe = registry.servers.map(s => ({
      ...s,
      args: redactArgs(s.args),
      env: redactEnv(s.env),
    }));
    process.stdout.write(
      JSON.stringify(
        {
          servers: safe,
          tools: toolsReg,
          native: native.map(t => ({ name: t.name, safety: t.safety })),
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  // Human output
  console.log('');
  console.log(bold('  ashlr mcp list') + gray(`  — ${registry.servers.length} discovered server(s) + ${native.length} native tool(s)`));
  console.log('');

  // Native (built-in) tools — always available, served by the gateway itself.
  console.log(bold('  Native (built-in)') + gray('  — served by `ashlr mcp` directly'));
  console.log('');
  {
    const nameW = Math.max(10, ...native.map(t => t.name.length));
    for (const t of native) {
      const safetyStr =
        t.safety === 'read' ? green(t.safety) : t.safety === 'append' ? yellow(t.safety) : magenta(t.safety);
      console.log(`  ${pad(cyan(t.name), nameW)}  ${pad(safetyStr, 10)}  ${dim(t.description.split('. ')[0] ?? '')}`);
    }
    console.log('');
  }

  if (registry.servers.length === 0) {
    console.log('  ' + dim('No MCP servers discovered.'));
    console.log('');
  } else {
    const nameW = Math.max(8, ...registry.servers.map(s => s.name.length));
    const srcW  = Math.max(8, ...registry.servers.map(s => s.source.length));
    const cmdW  = 36;

    console.log(
      `  ${bold(pad('Name', nameW))}  ${bold(pad('Source', srcW))}  ${bold(pad('Command', cmdW))}`
    );
    console.log(`  ${'─'.repeat(nameW)}  ${'─'.repeat(srcW)}  ${'─'.repeat(cmdW)}`);

    for (const srv of registry.servers) {
      const isAshlr   = srv.name === 'ashlr';
      const isPhantom = srv.name === 'phantom-secrets';
      const nameStr   = isAshlr
        ? magenta(srv.name)
        : isPhantom
          ? cyan(srv.name)
          : srv.name;

      const safeArgs = redactArgs(srv.args);
      const cmdStr = [srv.command, ...(safeArgs.length > 0 ? safeArgs : [])].join(' ');
      const cmdTrunc = cmdStr.length > cmdW ? cmdStr.slice(0, cmdW - 1) + '…' : cmdStr;
      const envCount = srv.env ? Object.keys(srv.env).length : 0;
      const envStr   = envCount > 0 ? gray(` +${envCount} env`) : '';

      console.log(
        `  ${pad(nameStr, nameW)}  ${pad(gray(srv.source), srcW)}  ${dim(cmdTrunc)}${envStr}`
      );
    }
    console.log('');
  }

  // Tools registry summary
  const installed = toolsReg.tools.filter(t => t.installed);
  console.log(bold('  Ecosystem tools') + gray(`  — ${installed.length}/${toolsReg.tools.length} installed`));
  console.log('');

  if (toolsReg.tools.length > 0) {
    const idW  = Math.max(8, ...toolsReg.tools.map(t => t.id.length));
    const verW = 12;

    console.log(`  ${bold(pad('Tool', idW))}  ${bold(pad('Version', verW))}  ${bold('Path')}`);
    console.log(`  ${'─'.repeat(idW)}  ${'─'.repeat(verW)}  ${'─'.repeat(40)}`);

    for (const tool of toolsReg.tools) {
      const nameStr = tool.installed ? green(tool.id) : dim(tool.id);
      const verStr  = tool.version ? cyan(tool.version) : dim('—');
      const pathStr = tool.path
        ? gray(tool.path.replace(homedir(), '~'))
        : dim('not found');
      console.log(`  ${pad(nameStr, idW)}  ${pad(verStr, verW)}  ${pathStr}`);
    }
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: doctor
// ---------------------------------------------------------------------------

/** Required server names — gateway is unhealthy if these are down. */
const REQUIRED_SERVERS = new Set(['ashlr', 'phantom-secrets']);

async function cmdMcpDoctor(args: string[]): Promise<number> {
  const jsonMode  = args.includes('--json');
  const timeoutMs = 8000;

  const { discoverMcpServers } = await importRegistry();
  const { probeServer } = await importGateway();

  const registry = discoverMcpServers();

  if (!jsonMode) {
    console.log('');
    console.log(bold('  ashlr mcp doctor') + gray(`  — probing ${registry.servers.length} server(s)`));
    console.log('');
  }

  // Probe all servers in parallel
  const probes = registry.servers.map(async (srv) => {
    if (!jsonMode) {
      process.stderr.write(`  probing ${srv.name}…\n`);
    }
    const health = await probeServer(srv, timeoutMs);
    return health;
  });

  // M31: native tools need no probe — they are in-process and always present.
  const { nativeToolDefs } = await import('../core/mcp-native.js');
  const nativeCount = nativeToolDefs().length;
  if (!jsonMode) {
    console.log(`  ${bold('native')}  ${green('ok')}      ${cyan(String(nativeCount))} built-in ashlr tool(s) (no probe needed)`);
    console.log('');
  }

  const results = await Promise.allSettled(probes);
  const healths: McpServerHealth[] = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      name:      registry.servers[i]!.name,
      ok:        false,
      toolCount: 0,
      tools:     [],
      error:     r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(healths, null, 2) + '\n');
  } else {
    // Clear the "probing…" lines were written to stderr; now print table to stdout
    const nameW  = Math.max(8, ...healths.map(h => h.name.length));
    const statusW = 6;
    const toolW  = 7;

    console.log(
      `  ${bold(pad('Server', nameW))}  ${bold(pad('Status', statusW))}  ${bold(pad('#Tools', toolW))}  ${bold('Info')}`
    );
    console.log(`  ${'─'.repeat(nameW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(toolW)}  ${'─'.repeat(40)}`);

    for (const h of healths) {
      const isRequired  = REQUIRED_SERVERS.has(h.name);
      const statusStr   = h.ok ? green('ok') : (isRequired ? red('DOWN') : yellow('down'));
      const toolStr     = h.ok ? cyan(String(h.toolCount)) : dim('0');
      const infoStr     = h.ok
        ? dim(h.tools.slice(0, 3).join(', ') + (h.tools.length > 3 ? ` +${h.tools.length - 3} more` : ''))
        : red(h.error ?? 'failed');

      console.log(
        `  ${pad(bold(h.name), nameW)}  ${pad(statusStr, statusW)}  ${pad(toolStr, toolW)}  ${infoStr}`
      );
    }
    console.log('');
  }

  // Exit 1 if any REQUIRED server is down
  const anyRequiredDown = healths.some(h => REQUIRED_SERVERS.has(h.name) && !h.ok);
  if (anyRequiredDown && !jsonMode) {
    console.log(red('  One or more required servers (ashlr, phantom-secrets) are down.'));
    console.log('');
  }

  return anyRequiredDown ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Subcommand: install
// ---------------------------------------------------------------------------

/** Shape of an mcpServers map as found in a config file. */
type McpServersConfig = Record<string, {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}>;

/** Top-level config file shape (just what we care about). */
interface ConfigFileShape {
  mcpServers?: McpServersConfig;
  [key: string]: unknown;
}

/**
 * Sentinel thrown by parseConfigFile when a target file exists and is non-empty
 * but is NOT valid JSON. cmdMcpInstall MUST abort on this rather than treating
 * the file as {} — otherwise a deep-merge would clobber the user's real config
 * (every other key AND every other mcpServers entry) down to just our entry.
 */
class ConfigParseError extends Error {
  constructor(public readonly path: string) {
    super(`config is not valid JSON: ${path}`);
    this.name = 'ConfigParseError';
  }
}

/**
 * Parse a target config file.
 *   - absent or empty            → {} (a fresh config we may safely create)
 *   - present + valid JSON       → the parsed object
 *   - present + UNPARSEABLE JSON → throws ConfigParseError (caller aborts; we
 *     never derive a merged write from a file we failed to parse).
 */
function parseConfigFile(filePath: string): ConfigFileShape {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ConfigFileShape;
  } catch {
    throw new ConfigParseError(filePath);
  }
}

async function cmdMcpInstall(args: string[]): Promise<number> {
  // Parse: install <target> [--config <path>]
  const positional = args.filter(a => !a.startsWith('--'));
  const target = positional[0];

  if (!target || (target !== 'claude' && target !== 'ashlrcode')) {
    console.error(red('error: ') + 'Usage: ashlr mcp install <claude|ashlrcode> [--config <path>]');
    return 2;
  }

  // --config override
  const configFlagIdx = args.indexOf('--config');
  const configPath = configFlagIdx !== -1 && args[configFlagIdx + 1]
    ? resolve(args[configFlagIdx + 1]!)
    : DEFAULT_TARGETS[target]!;

  const binPath = resolveAshlrBin();

  // The gateway entry we want to install
  const gatewayEntry = {
    command: binPath,
    args:    ['mcp'],
  };

  // ── Parse FIRST — abort on malformed input, before any write/backup ──────
  // A file that exists but is not valid JSON must be left byte-for-byte
  // unchanged. Parsing before backup/write guarantees we never destroy a real
  // config (or its .bak) because of a transient trailing comma / partial write.
  let existing: ConfigFileShape;
  try {
    existing = parseConfigFile(configPath);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      console.error(
        red('error: ') +
        `refusing to write: ${err.path} is not valid JSON; ` +
        `restore it or pass a clean --config <path>.`,
      );
      return 1;
    }
    throw err;
  }

  // ── Backup (only after a clean parse) ────────────────────────────────────
  if (existsSync(configPath)) {
    // Primary recovery slot: <config>.bak (documented; what users look for).
    const bakPath = configPath + '.bak';
    // If a .bak already exists that we did NOT create this run, snapshot it to a
    // timestamped sidecar first so a second run can't destroy an older backup.
    if (existsSync(bakPath)) {
      try {
        copyFileSync(bakPath, `${bakPath}.${Date.now()}`);
      } catch { /* best-effort — never block install on backup-of-backup */ }
    }
    copyFileSync(configPath, bakPath);
    console.log(dim(`  backed up: ${configPath} → ${bakPath}`));
  } else {
    // Ensure the parent directory exists
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });
  }

  // ── Idempotency check ────────────────────────────────────────────────────
  const existingServers: McpServersConfig = existing.mcpServers ?? {};
  const existingEntry = existingServers['ashlr'];

  if (existingEntry) {
    const same =
      existingEntry.command === gatewayEntry.command &&
      JSON.stringify(existingEntry.args ?? []) === JSON.stringify(gatewayEntry.args);

    if (same) {
      console.log(green('  ✓ already installed — no changes needed.'));
      console.log(dim(`    config: ${configPath}`));
      return 0;
    }

    // Entry exists but differs — update it
    console.log(yellow('  ! existing "ashlr" entry differs — updating.'));
  }

  // ── Deep merge: add/update "ashlr" key only, preserve all others ─────────
  const merged: ConfigFileShape = {
    ...existing,
    mcpServers: {
      ...existingServers,
      ashlr: gatewayEntry,
    },
  };

  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  console.log('');
  console.log(green('  ✓ installed') + '  ashlr gateway → ' + cyan(configPath));
  console.log('');
  console.log(`  ${bold('entry added:')}`);
  console.log(`  ${gray('"mcpServers"')}: {`);
  console.log(`    ${gray('"ashlr"')}: {`);
  console.log(`      ${gray('"command"')}: ${cyan(`"${gatewayEntry.command}"`)},`);
  console.log(`      ${gray('"args"')}: ${cyan(JSON.stringify(gatewayEntry.args))}`);
  console.log(`    }`);
  console.log(`  }`);
  console.log('');
  console.log(dim(`  Point your agent at this config to get every discovered MCP tool.`));
  console.log('');

  return 0;
}


// ---------------------------------------------------------------------------
// Subcommand: ecosystem
// ---------------------------------------------------------------------------

/**
 * Canonical ecosystem MCP server definitions.
 * Each entry declares a well-known tool name, the binary to probe in PATH,
 * and the stable command + args to launch it as an MCP stdio server.
 *
 * Keep this list conservative: only add servers that are verifiably
 * installable and stable. Absent tools are skipped — never error.
 */
interface EcosystemServer {
  name: string;         // Key used in mcpServers map
  probe: string;        // Executable to look for in PATH
  command: string;      // Launch command
  args: string[];       // Launch args
  label: string;        // Human display name
}

const ECOSYSTEM_SERVERS: EcosystemServer[] = [
  {
    name: 'phantom-secrets',
    probe: 'phantom',
    command: 'phantom',
    args: ['mcp', 'serve'],
    label: 'Phantom Secrets (phantom-mcp)',
  },
];

/** Resolve a binary's full path from PATH; returns undefined if not found. */
function resolveInPath(bin: string): string | undefined {
  // Honour injected PATH (tests) or fall back to process.env.PATH.
  const pathDirs = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Shape of ~/.ashlr/settings.json for MCP purposes. */
interface AshlrSettingsShape {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  [key: string]: unknown;
}

/** Path to the hub settings file that the gateway also scans. */
function ashlrSettingsPath(): string {
  return join(homedir(), '.ashlr', 'settings.json');
}

/** Load ~/.ashlr/settings.json; returns {} on absence/parse error. */
function loadAshlrSettings(settingsPath?: string): AshlrSettingsShape {
  const p = settingsPath ?? ashlrSettingsPath();
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AshlrSettingsShape;
  } catch {
    return {};
  }
}

/**
 * Merge detected ecosystem servers into ~/.ashlr/settings.json.
 * - Never clobbers unrelated keys.
 * - Skips servers already present (by name) — idempotent.
 * - Creates the file + parent dir if absent.
 * Returns the names of servers actually written (not already present).
 */
export function mergeEcosystemServers(
  detected: Array<{ name: string; command: string; args: string[] }>,
  settingsPath: string,
): string[] {
  const existing = loadAshlrSettings(settingsPath);
  const existingServers = existing.mcpServers ?? {};

  const added: string[] = [];
  const mergedServers: AshlrSettingsShape['mcpServers'] = { ...existingServers };

  for (const srv of detected) {
    if (mergedServers[srv.name]) continue; // already present — skip
    mergedServers[srv.name] = { command: srv.command, args: srv.args };
    added.push(srv.name);
  }

  const merged: AshlrSettingsShape = {
    ...existing,
    mcpServers: mergedServers,
  };

  const dir = dirname(settingsPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return added;
}

async function cmdMcpEcosystem(args: string[]): Promise<number> {
  const writeMode = args.includes('--write');
  const settingsPath = ashlrSettingsPath();

  console.log('');
  console.log(bold('  ashlr mcp ecosystem') + gray('  — unified MCP surface (M66)'));
  console.log('');

  // Detect which ecosystem servers are available in PATH.
  const detected: Array<EcosystemServer & { resolvedBin: string }> = [];
  const missing: EcosystemServer[] = [];

  for (const srv of ECOSYSTEM_SERVERS) {
    const resolved = resolveInPath(srv.probe);
    if (resolved) {
      detected.push({ ...srv, resolvedBin: resolved });
    } else {
      missing.push(srv);
    }
  }

  // Load current settings to check registration state.
  const currentSettings = loadAshlrSettings(settingsPath);
  const currentServers = currentSettings.mcpServers ?? {};

  // Print detected servers.
  if (detected.length === 0) {
    console.log('  ' + dim('No ecosystem MCP servers found in PATH.'));
  } else {
    const nameW = Math.max(10, ...detected.map(s => s.label.length));
    console.log(bold('  Available:'));
    console.log('');
    for (const srv of detected) {
      const isRegistered = Boolean(currentServers[srv.name]);
      const regStr = isRegistered ? green('registered') : yellow('not registered');
      const cmdStr = dim([srv.command, ...srv.args].join(' '));
      console.log(
        '    ' + cyan(pad(srv.label, nameW)) +
        '  ' + regStr +
        '  ' + gray(srv.resolvedBin) +
        '\n    ' + ' '.repeat(nameW + 4) + cmdStr
      );
      console.log('');
    }
  }

  // Print absent servers.
  if (missing.length > 0) {
    console.log(bold('  Not installed (skipped):'));
    for (const srv of missing) {
      console.log('    ' + dim(srv.label) + gray('  — ' + srv.probe + ' not found in PATH'));
    }
    console.log('');
  }

  if (!writeMode) {
    console.log(
      dim('  Run ') + cyan('ashlr mcp ecosystem --write') +
      dim(' to register available servers into ~/.ashlr/settings.json.')
    );
    console.log(dim('  The gateway then aggregates them automatically on next start.'));
    console.log('');
    return 0;
  }

  // --write: merge detected servers into ~/.ashlr/settings.json.
  if (detected.length === 0) {
    console.log(yellow('  Nothing to register — no ecosystem servers found in PATH.'));
    console.log('');
    return 0;
  }

  const added = mergeEcosystemServers(
    detected.map(s => ({ name: s.name, command: s.command, args: s.args })),
    settingsPath,
  );

  if (added.length === 0) {
    console.log(green('  ✓ All available servers already registered — no changes.'));
  } else {
    console.log(green('  ✓ Registered ' + String(added.length) + ' server(s) into ' + settingsPath));
    for (const name of added) {
      console.log('    ' + cyan('+ ' + name));
    }
    console.log('');
    console.log(
      dim('  Agents pointed at ') + cyan('ashlr mcp') +
      dim(' now get all registered ecosystem tools automatically.')
    );
  }
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log('');
  console.log(bold('  ashlr mcp') + dim(' — MCP aggregation gateway'));
  console.log('');
  console.log('  ' + bold('Subcommands:'));
  console.log('');

  const cmds: [string, string][] = [
    ['(default)',                       'Run the aggregation gateway on stdio. Point any agent here.'],
    ['list [--json]',                   'Print discovered servers + ecosystem tools summary.'],
    ['doctor [--json]',                 'Probe each server; exit 1 if required servers (ashlr/phantom) are down.'],
    ['install <claude|ashlrcode>',      'Idempotently add the ashlr gateway to a target config (backs up first).'],
    ['install <target> --config <path>', 'Install to a specific config path (use in tests to avoid real configs).'],
    ['ecosystem',                        'Detect installed ecosystem MCP servers + show registration status.'],
    ['ecosystem --write',                'Register detected servers into ~/.ashlr/settings.json (idempotent).'],
  ];

  const cmdW = Math.max(...cmds.map(([c]) => c.length));
  for (const [cmd, desc] of cmds) {
    console.log(`    ${cyan(pad(cmd, cmdW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${dim('# Run as MCP server (stdio)')}`)
  console.log(`    ashlr mcp`);
  console.log('');
  console.log(`    ${dim('# List what would be aggregated')}`);
  console.log(`    ashlr mcp list`);
  console.log('');
  console.log(`    ${dim('# Health-check all downstream servers')}`);
  console.log(`    ashlr mcp doctor`);
  console.log('');
  console.log(`    ${dim('# Install gateway into Claude config (backs up ~/.claude.json first)')}`);
  console.log(`    ashlr mcp install claude`);
  console.log('');
  console.log(`    ${dim('# Install into a temp file for testing')}`);
  console.log(`    ashlr mcp install claude --config /tmp/test-claude.json`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

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
export async function cmdMcp(args: string[]): Promise<number> {
  const sub = args[0];

  // Help shortcircuit
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return 0;
  }

  // Default / explicit "run"
  if (!sub || sub === 'run') {
    return cmdMcpRun();
  }

  if (sub === 'list') {
    return cmdMcpList(args.slice(1));
  }

  if (sub === 'doctor') {
    return cmdMcpDoctor(args.slice(1));
  }

  if (sub === 'install') {
    return cmdMcpInstall(args.slice(1));
  }

  if (sub === 'ecosystem') {
    return cmdMcpEcosystem(args.slice(1));
  }

  // Unknown subcommand
  console.error(red('error: ') + `unknown subcommand: ${bold(sub)}`);
  console.error(dim('Run `ashlr mcp help` for usage.'));
  return 2;
}
