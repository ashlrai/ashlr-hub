/**
 * core/doctor.ts — one-glance health check for ashlr-hub.
 *
 * `runDoctor` probes all configured integrations and returns a typed
 * DoctorReport. It NEVER throws — a failed probe becomes a 'fail' DoctorCheck.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AshlrConfig, DoctorCheck, DoctorCheckStatus, DoctorReport, McpRegistry, ToolsRegistry } from './types.js';
import { loadConfig } from './config.js';
import { getPhantomStatus } from './phantom.js';
import { getProviderRegistry } from './providers.js';
import { parseRemoteCasAuthorityConfig } from './inbox/remote-cas-authority.js';
// H7 — 5 NEW read-only probes share the SAME read-only readiness facets that
// `ashlr preflight` uses, from the shared readiness module (single source of
// truth; no drift). See docs/contracts/CONTRACT-H7.md (BUILD ITEM 2). These
// helpers MUTATE NOTHING (the lone write is checkAshlrWriteable's self-cleaning
// sentinel under ~/.ashlr). Imported so doctor + preflight never diverge.
import {
  readEnrollmentState,
  readDaemonHealth,
  readKillState,
  checkAshlrWriteable,
  readSandboxHealth,
  SANDBOX_ORPHAN_WARN_THRESHOLD,
} from './readiness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function check(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  detail: string,
  fix?: string,
): DoctorCheck {
  const c: DoctorCheck = { id, label, status, detail };
  if (fix !== undefined) c.fix = fix;
  return c;
}

/** Run a command synchronously, returning stdout trimmed or null on error. */
function runCmd(cmd: string, args: string[]): string | null {
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    return (result.stdout ?? '').trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// M33: plugin-layer probe (read-only; manifests + integrity pins only)
// ---------------------------------------------------------------------------

async function checkPlugins(cfg: AshlrConfig): Promise<DoctorCheck> {
  try {
    const { discoverPlugins } = await import('./plugins/registry.js');
    const { hashEntry } = await import('./plugins/integrity.js');
    const { join } = await import('node:path');

    const enabled = cfg.plugins?.enabled ?? [];
    if (enabled.length === 0) {
      return check('plugins', 'Plugins', 'pass', 'none enabled (default-off)');
    }

    const found = discoverPlugins();
    const problems: string[] = [];
    for (const name of enabled) {
      const p = found.find((f) => f.manifest?.name === name);
      if (!p) {
        problems.push(`${name}: enabled but missing under ~/.ashlr/plugins/`);
        continue;
      }
      if (!p.ok || !p.manifest) {
        problems.push(`${name}: invalid manifest (${p.reason ?? 'unknown'})`);
        continue;
      }
      const pin = cfg.plugins?.integrity?.[name];
      const live = hashEntry(join(p.dir, p.manifest.entry));
      if (!pin) problems.push(`${name}: no integrity pin — re-run \`ashlr plugins enable ${name}\``);
      else if (live !== pin) problems.push(`${name}: entry file changed since enable (integrity mismatch)`);
    }

    if (problems.length > 0) {
      return check(
        'plugins', 'Plugins', 'warn',
        problems.join('; '),
        'Fix or re-enable the listed plugins (`ashlr plugins enable <name>`), or disable them.',
      );
    }
    return check('plugins', 'Plugins', 'pass', `${enabled.length} enabled, all pins verified`);
  } catch {
    return check('plugins', 'Plugins', 'pass', 'plugin layer not built — skipped');
  }
}

// ---------------------------------------------------------------------------
// Dynamic import helpers for M3 modules — gracefully no-ops if not built yet
// ---------------------------------------------------------------------------

/**
 * Attempt to load discoverMcpServers from mcp-registry.
 * Returns null if the module is unavailable (not yet built).
 */
async function tryDiscoverMcpServers(): Promise<McpRegistry | null> {
  try {
    // Dynamic import so doctor.ts compiles and runs even before mcp-registry is built.
    const mod = await import('./mcp-registry.js') as { discoverMcpServers: () => McpRegistry };
    return mod.discoverMcpServers();
  } catch {
    return null;
  }
}

/**
 * Attempt to load getToolsRegistry from tools-registry.
 * Returns null if the module is unavailable (not yet built).
 */
async function tryGetToolsRegistry(): Promise<ToolsRegistry | null> {
  try {
    const mod = await import('./tools-registry.js') as { getToolsRegistry: () => ToolsRegistry };
    return mod.getToolsRegistry();
  } catch {
    return null;
  }
}

/**
 * Attempt to build a rollup via the M5 observability module for the budget
 * window configured in cfg (default '7d'). Returns null when the module is
 * not yet built or if any error occurs — caller must degrade gracefully.
 */
async function tryBuildBudgetRollup(
  cfg: AshlrConfig,
): Promise<import('./types.js').ActivityRollup | null> {
  try {
    const win: '1d' | '7d' | '30d' = cfg.telemetry?.budgetWindow ?? '7d';
    // Defeat static resolution so tsc doesn't error when the M5 module is not
    // yet built. Same pattern used for the M3 mcp-registry / tools-registry
    // dynamic imports above. At runtime Node resolves the real .js path.
    const specifier = './observability/rollup.js';
    const mod = await import(/* @vite-ignore */ specifier) as {
      buildRollup: (
        window: '1d' | '7d' | '30d',
        cfg: AshlrConfig,
      ) => import('./types.js').ActivityRollup;
    };
    return mod.buildRollup(win, cfg);
  } catch {
    return null;
  }
}


/**
 * Attempt to call evalGovernance from the M19 governance module.
 * Returns null if the module is unavailable (not yet built) or throws.
 * NEVER returns PAT values — only the GovernanceStatus metadata shape.
 */
async function tryEvalGovernance(
  cfg: AshlrConfig,
): Promise<import('./types.js').GovernanceStatus | null> {
  try {
    const specifier = './observability/governance.js';
    const mod = await import(/* @vite-ignore */ specifier) as {
      evalGovernance: (cfg: AshlrConfig) => import('./types.js').GovernanceStatus;
    };
    return mod.evalGovernance(cfg);
  } catch {
    return null;
  }
}

/**
 * Attempt to load patAvailable from the M19 telemetry-sink module and derive
 * the active sink type. Returns null if the module is unavailable or throws.
 * Boolean flags ONLY — PAT value is never returned, logged, or stored here.
 */
async function tryGetTelemetrySinkInfo(
  cfg: AshlrConfig,
): Promise<{ sinkType: 'local' | 'otlp'; endpointConfigured: boolean; patConfigured: boolean } | null> {
  try {
    const specifier = './observability/telemetry-sink.js';
    const mod = await import(/* @vite-ignore */ specifier) as {
      patAvailable: (cfg: AshlrConfig) => boolean;
    };
    const endpointConfigured = Boolean(cfg.telemetry?.pulse);
    const patConfigured = mod.patAvailable(cfg); // boolean only — never logs/returns the value
    // OtlpHttpSink is selected only when BOTH endpoint AND PAT are present.
    const sinkType: 'local' | 'otlp' = endpointConfigured && patConfigured ? 'otlp' : 'local';
    return { sinkType, endpointConfigured, patConfigured };
  } catch {
    return null;
  }
}

/**
 * Attempt to load genomeHealth from the M7 genome store module.
 * Returns null if the module is unavailable (not yet built) or throws.
 */
async function tryGetGenomeHealth(
  cfg: AshlrConfig,
): Promise<import('./types.js').GenomeHealth | null> {
  try {
    const specifier = './genome/store.js';
    const mod = await import(/* @vite-ignore */ specifier) as {
      genomeHealth: (cfg: AshlrConfig) => import('./types.js').GenomeHealth;
    };
    return mod.genomeHealth(cfg);
  } catch {
    return null;
  }
}

/**
 * Attempt to load getIdentity from the M18 identity integration module.
 * Returns null if the module is unavailable (not yet built) or throws.
 * NAMES/status only — NEVER secret values.
 */
async function tryGetIdentity(): Promise<import('./types.js').Identity | null> {
  try {
    const specifier = './integrations/identity.js';
    const mod = await import(/* @vite-ignore */ specifier) as {
      getIdentity: () => import('./types.js').Identity;
    };
    return mod.getIdentity();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Individual check implementations — each returns a DoctorCheck, never throws
// ---------------------------------------------------------------------------

/**
 * Check: Spend budget (M5 observability).
 * id: 'budget-spend'
 *
 * Builds a rollup for the configured budget window (default '7d') and
 * inspects the BudgetAlert level:
 *   - 'ok' or no cap configured  → pass
 *   - 'warn' (>= 80 % of cap)    → warn
 *   - 'over' (cap exceeded)      → fail
 *
 * If the rollup module is not yet available or throws, degrades to pass/skip
 * so that doctor never hangs or crashes due to missing M5 modules.
 *
 * @param rollup - pre-fetched rollup result (or null on unavailability)
 */
function checkSpendBudget(
  rollup: import('./types.js').ActivityRollup | null,
): DoctorCheck {
  // Module not available yet or rollup failed — degrade silently to pass.
  if (rollup === null) {
    return check(
      'budget-spend',
      'Spend budget',
      'pass',
      'Observability module not yet available — skipping budget check',
    );
  }

  const { budget } = rollup;

  // No cap configured on either dimension → nothing to alert on.
  if (budget.capUsd === null && budget.capTokens === null) {
    return check(
      'budget-spend',
      'Spend budget',
      'pass',
      `No budget cap configured for ${budget.window} window`,
    );
  }

  if (budget.level === 'over') {
    return check(
      'budget-spend',
      'Spend budget',
      'fail',
      budget.message,
      'review ashlr pulse; raise cap or reduce spend',
    );
  }

  if (budget.level === 'warn') {
    return check(
      'budget-spend',
      'Spend budget',
      'warn',
      budget.message,
      'review ashlr pulse; raise cap or reduce spend',
    );
  }

  // level === 'ok'
  return check('budget-spend', 'Spend budget', 'pass', budget.message);
}

/** node version >= 18 */
function checkNodeVersion(): DoctorCheck {
  try {
    const ver = process.version; // e.g. "v22.1.0"
    const major = parseInt(ver.replace(/^v/, '').split('.')[0] ?? '0', 10);
    if (major >= 18) {
      return check('node', 'Node.js version', 'pass', `${ver} (>= 18 required)`);
    }
    return check(
      'node',
      'Node.js version',
      'fail',
      `${ver} — need >= v18`,
      'Install Node.js 18+ from https://nodejs.org',
    );
  } catch (err) {
    return check('node', 'Node.js version', 'fail', String(err));
  }
}

/** git present on PATH */
function checkGit(): DoctorCheck {
  const out = runCmd('git', ['--version']);
  if (out) {
    return check('git', 'git installed', 'pass', out);
  }
  return check(
    'git',
    'git installed',
    'fail',
    'git not found on PATH',
    'Install git: https://git-scm.com',
  );
}

/** ~/.local/bin on PATH */
function checkLocalBin(): DoctorCheck {
  const localBin = join(homedir(), '.local/bin');
  const pathDirs = (process.env['PATH'] ?? '').split(delimiter);
  if (pathDirs.includes(localBin)) {
    return check('local-bin', '~/.local/bin on PATH', 'pass', `${localBin} is on PATH`);
  }
  return check(
    'local-bin',
    '~/.local/bin on PATH',
    'warn',
    `${localBin} is NOT on PATH`,
    `Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"`,
  );
}

/** ashlr binary present (which/where ashlr) */
function checkAshlrInstalled(): DoctorCheck {
  // `which` is Unix-only; Windows uses `where`.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const out = runCmd(finder, ['ashlr']);
  if (out) {
    return check('ashlr', 'ashlr installed', 'pass', out);
  }
  return check(
    'ashlr',
    'ashlr installed',
    'fail',
    'ashlr not found on PATH',
    'Run: npm install -g ashlr  (or ensure ~/.local/bin is on PATH)',
  );
}

/** ~/.ashlr/config.json exists and parses */
function checkConfig(): DoctorCheck {
  const configPath = join(homedir(), '.ashlr', 'config.json');
  try {
    if (!existsSync(configPath)) {
      return check(
        'config',
        'Config file exists',
        'fail',
        `${configPath} not found`,
        'Run: ashlr init',
      );
    }
    loadConfig(); // will throw on parse failure
    return check('config', 'Config file exists', 'pass', `${configPath} is valid JSON`);
  } catch (err) {
    return check(
      'config',
      'Config file exists',
      'fail',
      `${configPath} is invalid: ${String(err)}`,
      'Fix JSON syntax errors in ~/.ashlr/config.json',
    );
  }
}

/** ~/.ashlr/index.json present + not stale (> 7 days old = warn) */
function checkIndex(): DoctorCheck {
  const indexPath = join(homedir(), '.ashlr', 'index.json');
  try {
    if (!existsSync(indexPath)) {
      return check(
        'index',
        'Index file present',
        'warn',
        `${indexPath} not found — run ashlr index to build it`,
        'ashlr index',
      );
    }

    const raw = readFileSync(indexPath, 'utf8');
    let generatedAt: Date | null = null;
    try {
      const parsed = JSON.parse(raw) as { generatedAt?: string };
      if (parsed.generatedAt) {
        generatedAt = new Date(parsed.generatedAt);
      }
    } catch {
      // If we can't parse it, fall back to mtime
    }

    const ageMs = generatedAt
      ? Date.now() - generatedAt.getTime()
      : Date.now() - statSync(indexPath).mtimeMs;

    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const ageLabel = `${ageDays.toFixed(1)} days old`;

    if (ageDays > 7) {
      return check(
        'index',
        'Index file freshness',
        'warn',
        `Index is ${ageLabel} (> 7 days)`,
        'ashlr index',
      );
    }
    return check('index', 'Index file freshness', 'pass', `Index is ${ageLabel}`);
  } catch (err) {
    return check(
      'index',
      'Index file present',
      'warn',
      `Could not read index: ${String(err)}`,
      'ashlr index',
    );
  }
}

/** phantom installed + initialized */
function checkPhantom(): DoctorCheck {
  try {
    const status = getPhantomStatus();
    if (!status.installed) {
      return check(
        'phantom',
        'Phantom secrets CLI',
        'warn',
        'phantom not found on PATH',
        'Install: brew install ashlrai/tap/phantom  or  https://phantom.sh',
      );
    }
    const ver = status.version ? ` v${status.version}` : '';
    if (!status.initialized) {
      return check(
        'phantom',
        'Phantom secrets CLI',
        'warn',
        `phantom${ver} installed but vault not initialized`,
        'phantom init',
      );
    }
    const count = status.secretNames.length;
    return check(
      'phantom',
      'Phantom secrets CLI',
      'pass',
      `phantom${ver} installed, vault initialized (${count} secret${count !== 1 ? 's' : ''})`,
    );
  } catch (err) {
    return check(
      'phantom',
      'Phantom secrets CLI',
      'warn',
      `Could not determine phantom status: ${String(err)}`,
    );
  }
}

/**
 * Detect whether the ashlr MCP server is registered in any of the known
 * Claude Code config locations. Upgraded in M3: also accepts discovery via
 * discoverMcpServers() so it passes if the "ashlr" server is found in any
 * known config file (including ~/.ashlrcode/settings.json, ashlr-workbench, etc.).
 *
 * The mcpRegistry parameter is the pre-fetched result of discoverMcpServers()
 * (or null when the module is not available), passed in from runDoctor to avoid
 * duplicate invocations.
 */
function checkMcpPlugin(mcpRegistry: McpRegistry | null): DoctorCheck {
  // First: check via the M3 mcp-registry if available — covers all known paths
  // including ~/.ashlrcode/settings.json and ashlr-workbench agent settings.
  if (mcpRegistry !== null) {
    const ashlrServer = mcpRegistry.servers.find(
      (s) => s.name === 'ashlr' || s.name.includes('ashlr'),
    );
    if (ashlrServer) {
      return check(
        'mcp-plugin',
        'ashlr MCP plugin registered',
        'pass',
        `Found server "${ashlrServer.name}" in ${ashlrServer.source}`,
      );
    }
  }

  // Fallback: manual scan of the canonical three paths (works even without mcp-registry).
  const candidates = [
    join(homedir(), '.claude/settings.json'),
    join(homedir(), '.mcp.json'),
    join(homedir(), '.claude.json'),
  ];

  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue;
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // mcpServers is the standard key in both settings.json and .mcp.json
      const servers = parsed['mcpServers'];
      if (typeof servers === 'object' && servers !== null) {
        const keys = Object.keys(servers as Record<string, unknown>);
        // Look for any key that is exactly "ashlr" or contains "ashlr"
        const found = keys.find((k) => k === 'ashlr' || k.includes('ashlr'));
        if (found) {
          return check(
            'mcp-plugin',
            'ashlr MCP plugin registered',
            'pass',
            `Found server "${found}" in ${filePath}`,
          );
        }
      }
    } catch {
      // Ignore unreadable/unparseable files
    }
  }

  return check(
    'mcp-plugin',
    'ashlr MCP plugin registered',
    'warn',
    'ashlr MCP server not found in ~/.claude/settings.json, ~/.mcp.json, or ~/.claude.json',
    'Add the ashlr MCP server via: ashlr init  or install the ashlr Claude Code plugin',
  );
}

/**
 * Check: MCP servers discovered.
 * id: 'mcp-servers-discovered'
 * pass if >=1 server found, warn if 0.
 *
 * The mcpRegistry parameter is the pre-fetched result of discoverMcpServers()
 * (or null when the module is not available).
 */
function checkMcpServersDiscovered(mcpRegistry: McpRegistry | null): DoctorCheck {
  if (mcpRegistry === null) {
    // Module not available (not yet built) — soft warn rather than fail.
    return check(
      'mcp-servers-discovered',
      'MCP servers discovered',
      'warn',
      'MCP registry module not available',
      'configure MCP servers or run ashlr init',
    );
  }

  const count = mcpRegistry.servers.length;
  if (count >= 1) {
    return check(
      'mcp-servers-discovered',
      'MCP servers discovered',
      'pass',
      `${count} MCP server${count !== 1 ? 's' : ''} discovered across known configs`,
    );
  }

  return check(
    'mcp-servers-discovered',
    'MCP servers discovered',
    'warn',
    'No MCP servers discovered in known config locations',
    'configure MCP servers or run ashlr init',
  );
}

/**
 * Build a compact version-aware summary for installed ecosystem tools.
 *
 * Returns a string like:
 *   "phantom 0.6.0, ashlrcode 1.2.3, aw (no version); 3/10 installed"
 *
 * Rules:
 *  - Only installed tools are listed (installed === true).
 *  - Version shown when non-null; "(no version)" appended when null.
 *  - At most MAX_LISTED tool names shown inline; excess collapsed to "+ N more".
 *  - Trailing summary "X/Y installed" always appended.
 *  - Never throws.
 */
function buildVersionDetail(tools: import('./types.js').ToolInfo[], count: number, total: number): string {
  // Max tools to list by name before collapsing — keeps the detail line readable.
  const MAX_LISTED = 6;

  const installed = tools.filter((t) => t.installed);
  const listed = installed.slice(0, MAX_LISTED);
  const overflow = installed.length - listed.length;

  const parts = listed.map((t) =>
    t.version ? `${t.id} ${t.version}` : `${t.id} (no version)`,
  );

  if (overflow > 0) {
    parts.push(`+${overflow} more`);
  }

  const suffix = `${count}/${total} installed`;
  if (parts.length === 0) {
    return suffix;
  }
  return `${parts.join(', ')}; ${suffix}`;
}

/**
 * Check: Ashlr ecosystem tools installed.
 * id: 'ashlr-tools-installed'
 * pass with count, warn if <2 tools installed.
 *
 * The toolsRegistry parameter is the pre-fetched result of getToolsRegistry()
 * (or null when the module is not available).
 *
 * M10: detail now includes per-tool version strings so `ashlr doctor` surfaces
 * lightweight version awareness without any network calls.
 * Example detail: "phantom 0.6.0, ashlrcode 1.2.3, aw (no version); 3/10 installed"
 */
function checkAshlrToolsInstalled(toolsRegistry: ToolsRegistry | null): DoctorCheck {
  if (toolsRegistry === null) {
    // Module not available (not yet built) — soft warn rather than fail.
    return check(
      'ashlr-tools-installed',
      'Ashlr tools installed',
      'warn',
      'Tools registry module not available',
      'run ashlr init to set up the ecosystem',
    );
  }

  const count = toolsRegistry.installedCount;
  const total = toolsRegistry.tools.length;
  const detail = buildVersionDetail(toolsRegistry.tools, count, total);

  if (count >= 2) {
    return check(
      'ashlr-tools-installed',
      'Ashlr tools installed',
      'pass',
      detail,
    );
  }

  return check(
    'ashlr-tools-installed',
    'Ashlr tools installed',
    'warn',
    count === 0 ? `No ecosystem tools installed; ${count}/${total} installed` : detail,
    'Install ashlr ecosystem tools (phantom, ashlrcode, aw, etc.)',
  );
}


/**
 * Check: Genome memory (M7).
 * id: 'genome-memory'
 *
 * Passes when the aggregated genome has at least one entry; warns when empty
 * so the user knows to seed it. Never throws.
 *
 * @param health - pre-fetched genomeHealth result (or null when module unavailable)
 */
function checkGenomeMemory(
  health: import('./types.js').GenomeHealth | null,
): DoctorCheck {
  // Module not yet built — degrade silently to pass so doctor never breaks.
  if (health === null) {
    return check(
      'genome-memory',
      'Genome memory',
      'pass',
      'Genome module not yet available — skipping memory check',
    );
  }

  if (health.totalEntries > 0) {
    const embLabel = health.embeddingsAvailable ? 'embeddings available' : 'keyword-only';
    return check(
      'genome-memory',
      'Genome memory',
      'pass',
      `${health.totalEntries} entr${health.totalEntries !== 1 ? 'ies' : 'y'} across ${health.projects} project${health.projects !== 1 ? 's' : ''} (${embLabel})`,
    );
  }

  return check(
    'genome-memory',
    'Genome memory',
    'warn',
    'No genome entries found',
    'run ashlr learn to seed memory, or ensure .ashlrcode/genome exists',
  );
}

// ---------------------------------------------------------------------------
// M18: Identity check
// ---------------------------------------------------------------------------

/**
 * Check: Phantom cloud identity (M18).
 * id: 'identity'
 *
 * Passes when phantom is logged in; warns (not fails) when phantom is not
 * logged in or the module is unavailable — identity is opt-in. NAMES/status
 * only — NEVER secret values. Degrades gracefully.
 *
 * @param identity - pre-fetched Identity result (or null when module unavailable)
 */
function checkIdentity(
  identity: import('./types.js').Identity | null,
): DoctorCheck {
  // Module not yet built — degrade to pass so doctor never breaks.
  if (identity === null) {
    return check(
      'identity',
      'Phantom identity',
      'pass',
      'Identity module not yet available — skipping',
    );
  }

  if (identity.loggedIn) {
    const parts: string[] = [];
    if (identity.user)  parts.push(identity.user);
    if (identity.tier)  parts.push(`tier ${identity.tier}`);
    if (identity.team)  parts.push(`team ${identity.team}`);
    const detail = parts.length > 0 ? parts.join(' · ') : 'logged in';
    return check('identity', 'Phantom identity', 'pass', detail);
  }

  return check(
    'identity',
    'Phantom identity',
    'warn',
    'Not logged in to Phantom cloud — identity unavailable',
    'phantom login  (or phantom cloud login)',
  );
}

// ---------------------------------------------------------------------------
// M19: Spend governance check
// ---------------------------------------------------------------------------

/**
 * Check: Spend governance (M19).
 * id: 'spend-governance'
 *
 * Evaluates the period spend vs. the configured cap via evalGovernance:
 *   - ok or no cap  → pass
 *   - warn (>= 80%) → warn
 *   - over (> cap)  → fail with fix hint
 *
 * Degrades to pass when the governance module is not yet available.
 * Never throws. NEVER exposes PAT, endpoint URL body, or spend detail beyond
 * what GovernanceStatus.message already contains (metadata only).
 *
 * @param governance - pre-fetched GovernanceStatus result (or null when unavailable)
 */
function checkSpendGovernance(
  governance: import('./types.js').GovernanceStatus | null,
): DoctorCheck {
  if (governance === null) {
    return check(
      'spend-governance',
      'Spend governance',
      'pass',
      'Governance module not yet available — skipping',
    );
  }

  if (governance.capUsd === null) {
    return check(
      'spend-governance',
      'Spend governance',
      'pass',
      `No spend cap configured (window: ${governance.window})`,
    );
  }

  if (governance.level === 'over') {
    return check(
      'spend-governance',
      'Spend governance',
      'fail',
      governance.message,
      'Review `ashlr pulse`; raise cfg.telemetry.budgetUsd or reduce spend. Pass --over-budget to proceed when govAction is block.',
    );
  }

  if (governance.level === 'warn') {
    return check(
      'spend-governance',
      'Spend governance',
      'warn',
      governance.message,
      'Review `ashlr pulse`; consider raising cfg.telemetry.budgetUsd or reducing spend.',
    );
  }

  // level === 'ok'
  return check('spend-governance', 'Spend governance', 'pass', governance.message);
}

// ---------------------------------------------------------------------------
// M19: Telemetry sink check
// ---------------------------------------------------------------------------

/**
 * Check: Telemetry sink (M19).
 * id: 'telemetry-sink'
 *
 * Reports the active sink type (local vs otlp) and whether an endpoint + PAT
 * are configured — as booleans only (never values). This is an informational
 * check (info → 'pass'); it warns if the module is unavailable. Never throws.
 * PAT value is NEVER logged, returned, or placed in any detail field.
 *
 * @param sinkInfo - pre-fetched telemetry sink info (or null when unavailable)
 */
function checkTelemetrySink(
  sinkInfo: { sinkType: 'local' | 'otlp'; endpointConfigured: boolean; patConfigured: boolean } | null,
): DoctorCheck {
  if (sinkInfo === null) {
    return check(
      'telemetry-sink',
      'Telemetry sink',
      'pass',
      'Telemetry sink module not yet available — default: local',
    );
  }

  const { sinkType, endpointConfigured, patConfigured } = sinkInfo;
  const endpointLabel = endpointConfigured ? 'endpoint: configured' : 'endpoint: not configured';
  const patLabel = patConfigured ? 'PAT: configured' : 'PAT: not configured';

  if (sinkType === 'otlp') {
    return check(
      'telemetry-sink',
      'Telemetry sink',
      'pass',
      `Active sink: otlp (${endpointLabel}, ${patLabel})`,
    );
  }

  // Local sink — always passes; note if endpoint/PAT partially set so user
  // can diagnose why OTLP is not active without revealing any values.
  const detail = endpointConfigured && !patConfigured
    ? `Active sink: local (${endpointLabel}, ${patLabel} — set ASHLR_PULSE_TOKEN or add via phantom to activate OTLP)`
    : `Active sink: local (${endpointLabel}, ${patLabel})`;

  return check('telemetry-sink', 'Telemetry sink', 'pass', detail);
}

// ---------------------------------------------------------------------------
// H7: 5 NEW read-only probes (enrollment / daemon-state / kill-switch /
// ~/.ashlr writeable / sandbox health). Each returns a DoctorCheck via the
// existing check() helper, reads via the shared readiness facets, and MUTATES
// NOTHING. STUBS — BUILD fills in per docs/contracts/CONTRACT-H7.md (BUILD
// ITEM 2). Status rules: pass/warn/info, except ~/.ashlr-not-writeable ⇒ fail.
// ---------------------------------------------------------------------------

/**
 * Probe: enrollment registry (H7).
 * id: 'enrollment'
 *
 * READ-ONLY via readEnrollmentState() → readEnrollmentRegistry(). A degraded
 * registry fails because it cannot be treated as valid empty authority. A valid
 * empty registry remains the legitimate fresh-install default (DEFAULT EMPTY),
 * so 0 enrolled passes with a "none yet — run `ashlr onboard`" note. Mutates
 * nothing. Never throws.
 */
function checkEnrollment(): DoctorCheck {
  try {
    const enrollment = readEnrollmentState();
    if ('degraded' in enrollment) {
      return check(
        'enrollment',
        'Enrollment registry',
        'fail',
        `Enrollment registry degraded: ${enrollment.reason}`,
        'Repair ~/.ashlr/enrollment.json before running autonomy.',
      );
    }
    if (enrollment.count > 0) {
      return check(
        'enrollment',
        'Enrollment registry',
        'pass',
        `${enrollment.count} repo${enrollment.count !== 1 ? 's' : ''} enrolled`,
      );
    }
    return check(
      'enrollment',
      'Enrollment registry',
      'pass',
      'No repos enrolled yet — a fresh install is fine',
      'Run `ashlr onboard` to safely enroll your first repo',
    );
  } catch (err) {
    // readEnrollmentState never throws, but degrade defensively regardless.
    return check('enrollment', 'Enrollment registry', 'fail', `enrollment unreadable: ${String(err)}`);
  }
}

/**
 * Probe: daemon state (H7).
 * id: 'daemon-state'
 *
 * READ-ONLY via readDaemonHealth() → loadDaemonState() (which applies the H5
 * reconcileDaemonState self-heal at the load chokepoint). Reports:
 *  - a live running daemon (running flag + a still-alive pid) as a PASS
 *    (truthful, expected during autonomy);
 *  - a stopped daemon as a PASS — this INCLUDES a stale dead-pid `running:true`
 *    flag, which the H5 reconcile has already flipped to running:false at load,
 *    so the probe truthfully reports "stopped" rather than a phantom-live daemon.
 * Never fails — a daemon's run-state is observability, not a blocker. The load's
 * self-heal is observability-only and is not persisted by this read. Mutates
 * nothing. Never throws.
 */
function checkDaemonState(): DoctorCheck {
  try {
    const { running, pid, pidAlive } = readDaemonHealth();
    if (running && pidAlive) {
      return check(
        'daemon-state',
        'Daemon state',
        'pass',
        `Daemon running (pid ${pid ?? '?'})`,
      );
    }
    // running:false OR a running:true flag whose pid the H5 load already
    // self-healed to a truthful stopped state.
    return check('daemon-state', 'Daemon state', 'pass', 'Daemon stopped');
  } catch (err) {
    return check('daemon-state', 'Daemon state', 'pass', `daemon state unreadable: ${String(err)}`);
  }
}

/**
 * Probe: kill switch (H7).
 * id: 'kill-switch'
 *
 * READ-ONLY via readKillState() → killSwitchOn(). PASS when OFF; WARN when ON
 * (autonomy is paused — nothing will run, which a user may or may not intend).
 * Mutates nothing. Never throws.
 */
function checkKillSwitch(): DoctorCheck {
  try {
    const { on } = readKillState();
    if (on) {
      return check(
        'kill-switch',
        'Kill switch',
        'warn',
        'Kill switch is ON — autonomy paused (nothing will run)',
        'Clear it when ready: `ashlr kill off` (or remove ~/.ashlr/KILL)',
      );
    }
    return check('kill-switch', 'Kill switch', 'pass', 'Kill switch is OFF');
  } catch (err) {
    return check('kill-switch', 'Kill switch', 'pass', `kill state unreadable: ${String(err)}`);
  }
}

/**
 * Probe: ~/.ashlr writeable (H7).
 * id: 'ashlr-writeable'
 *
 * The lone WRITE among the 5 — but it writes then IMMEDIATELY UNLINKS a private,
 * self-cleaning sentinel under ~/.ashlr (shared with preflight via
 * checkAshlrWriteable in readiness.ts). PASS when writeable; FAIL when not
 * (nothing can persist — config/enrollment/daemon state all live under ~/.ashlr).
 * Touches no repo, no enrollment, no kill, no daemon state; leaves no artifact.
 * Never throws.
 */
function checkAshlrWriteableProbe(): DoctorCheck {
  try {
    if (checkAshlrWriteable()) {
      return check('ashlr-writeable', '~/.ashlr writeable', 'pass', '~/.ashlr is writeable');
    }
    return check(
      'ashlr-writeable',
      '~/.ashlr writeable',
      'fail',
      '~/.ashlr is NOT writeable — nothing can persist',
      'Fix permissions on ~/.ashlr (chmod u+rwx ~/.ashlr) or free disk space',
    );
  } catch (err) {
    // checkAshlrWriteable never throws, but treat any surprise as a hard fail
    // (we could not prove ~/.ashlr is writeable).
    return check(
      'ashlr-writeable',
      '~/.ashlr writeable',
      'fail',
      `could not verify ~/.ashlr is writeable: ${String(err)}`,
      'Fix permissions on ~/.ashlr (chmod u+rwx ~/.ashlr) or free disk space',
    );
  }
}

/**
 * Probe: sandbox health (H7).
 * id: 'sandbox-health'
 *
 * READ-ONLY via readSandboxHealth() → listSandboxes() (counts only — removes
 * NOTHING). PASS when there are zero/low orphans; WARN when the orphan count
 * reaches SANDBOX_ORPHAN_WARN_THRESHOLD, with a `ashlr sandbox gc` fix hint.
 * Mutates nothing. Never throws.
 */
function checkSandboxHealth(): DoctorCheck {
  try {
    const { total, orphans } = readSandboxHealth();
    if (orphans >= SANDBOX_ORPHAN_WARN_THRESHOLD) {
      return check(
        'sandbox-health',
        'Sandbox health',
        'warn',
        `${orphans} orphan sandbox${orphans !== 1 ? 'es' : ''} of ${total} on disk`,
        'Reclaim them: `ashlr sandbox gc`',
      );
    }
    return check(
      'sandbox-health',
      'Sandbox health',
      'pass',
      `${total} sandbox${total !== 1 ? 'es' : ''} on disk (${orphans} orphan${orphans !== 1 ? 's' : ''})`,
    );
  } catch (err) {
    return check('sandbox-health', 'Sandbox health', 'pass', `sandbox health unreadable: ${String(err)}`);
  }
}

/**
 * Reports the configuration boundary only. A reachable endpoint, valid or
 * otherwise, cannot establish remote-CAS semantics or activate recovery.
 */
function checkRemoteCasAuthority(cfg: AshlrConfig): DoctorCheck {
  const parsed = parseRemoteCasAuthorityConfig(cfg.fleet?.remoteCasAuthority);
  if (parsed.state === 'off') {
    return check(
      'remote-cas-authority',
      'Remote CAS authority',
      'pass',
      'disabled (default; recovery executor remains disabled)',
    );
  }
  if (parsed.state === 'probe') {
    return check(
      'remote-cas-authority',
      'Remote CAS authority',
      'warn',
      'configured for observation only; recovery executor remains disabled',
      'A configured endpoint is not authority; require authenticated CAS, durable epochs, and signed responses before activation.',
    );
  }
  return check(
    'remote-cas-authority',
    'Remote CAS authority',
    'warn',
    `configuration invalid (${parsed.reason}); recovery executor remains disabled`,
    'Correct the remote CAS configuration; it remains observational until an authenticated authority is deployed.',
  );
}

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

/**
 * Run all health checks and return a DoctorReport.
 * Never throws — each check is isolated and returns a typed result.
 *
 * New checks added in M3:
 *   - 'mcp-servers-discovered': MCP servers discovered via mcp-registry
 *   - 'ashlr-tools-installed': Ashlr ecosystem tools via tools-registry
 * New checks added in M7:
 *   - 'genome-memory': Genome memory health via genome/store.genomeHealth
 */
export async function runDoctor(cfg: AshlrConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // --- Pre-fetch M3 + M5 + M7 + M19 registry results (all async-safe, never throw) ---
  const [mcpRegistry, toolsRegistry, budgetRollup, genomeHealth, identity, governance, telemetrySinkInfo] = await Promise.all([
    tryDiscoverMcpServers(),
    tryGetToolsRegistry(),
    tryBuildBudgetRollup(cfg),
    tryGetGenomeHealth(cfg),
    tryGetIdentity(),
    tryEvalGovernance(cfg),
    tryGetTelemetrySinkInfo(cfg),
  ]);

  // --- Synchronous checks ---
  checks.push(checkNodeVersion());
  checks.push(checkGit());
  checks.push(checkLocalBin());
  checks.push(checkAshlrInstalled());
  checks.push(checkConfig());
  checks.push(checkIndex());
  checks.push(checkPhantom());
  // Upgraded: also accepts discovery via discoverMcpServers (mcpRegistry)
  checks.push(checkMcpPlugin(mcpRegistry));

  // --- M3 checks ---
  checks.push(checkMcpServersDiscovered(mcpRegistry));
  checks.push(checkAshlrToolsInstalled(toolsRegistry));

  // --- M5 checks ---
  checks.push(checkSpendBudget(budgetRollup));

  // --- M7 checks ---
  checks.push(checkGenomeMemory(genomeHealth));

  // --- M18 checks ---
  checks.push(checkIdentity(identity));

  // --- M19 checks ---
  checks.push(checkSpendGovernance(governance));
  checks.push(checkTelemetrySink(telemetrySinkInfo));

  // --- H7 checks (5 NEW read-only probes). All read-only; the lone write is
  // checkAshlrWriteable's self-cleaning sentinel under ~/.ashlr (written then
  // immediately unlinked). NONE mutates enrollment / kill / daemon / sandbox /
  // repo state. See docs/contracts/CONTRACT-H7.md §2 (BUILD ITEM 2).
  checks.push(checkEnrollment());
  checks.push(checkDaemonState());
  checks.push(checkKillSwitch());
  checks.push(checkAshlrWriteableProbe());
  checks.push(checkSandboxHealth());
  checks.push(checkRemoteCasAuthority(cfg));

  // --- M33: plugin layer (read-only; discovery never executes plugin code) ---
  checks.push(await checkPlugins(cfg));

  // --- Async: provider registry ---
  try {
    const registry = await getProviderRegistry(cfg);

    for (const provider of registry.providers) {
      const id = `provider:${provider.id}`;
      const label = `Local provider: ${provider.id}`;
      if (provider.up) {
        const modelCount = provider.models.length;
        checks.push(
          check(
            id,
            label,
            'pass',
            `${provider.url} is up (${modelCount} model${modelCount !== 1 ? 's' : ''})`,
          ),
        );
      } else {
        const detail = provider.error
          ? `${provider.url} is down — ${provider.error}`
          : `${provider.url} is down`;
        let fixHint: string;
        if (provider.id === 'lmstudio') {
          fixHint = 'Start LM Studio and enable the local server';
        } else if (provider.id === 'ollama') {
          fixHint = 'Start Ollama: ollama serve';
        } else {
          fixHint = `Start the ${provider.id} provider`;
        }
        checks.push(check(id, label, 'warn', detail, fixHint));
      }
    }

    // At least one local provider must be up
    if (registry.activeProvider === null) {
      checks.push(
        check(
          'provider:active',
          'Active local provider',
          'fail',
          'No local provider is reachable — cannot run local-first AI',
          'Start LM Studio or Ollama (ollama serve)',
        ),
      );
    } else {
      // activeProvider may be a local endpoint OR a cloud fallback (e.g.
      // 'anthropic' when its env key is set and locals are down). Label
      // accordingly so the status text is accurate.
      const isLocal = registry.providers.some(
        p => p.id === registry.activeProvider,
      );
      const detail = isLocal
        ? `Active provider: ${registry.activeProvider} (local)`
        : `Active provider: ${registry.activeProvider} (cloud fallback)`;
      checks.push(
        check(
          'provider:active',
          'Active provider',
          'pass',
          detail,
        ),
      );
    }
  } catch (err) {
    // Probe machinery itself failed — record as fail rather than crashing
    checks.push(
      check(
        'provider:registry',
        'Local provider registry',
        'fail',
        `Could not probe providers: ${String(err)}`,
        'Check network access and restart LM Studio / Ollama',
      ),
    );
  }

  // --- Summary ---
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    summary[c.status]++;
  }

  return {
    generatedAt: new Date().toISOString(),
    checks,
    summary,
  };
}
