/**
 * core/doctor.ts — one-glance health check for ashlr-hub.
 *
 * `runDoctor` probes all configured integrations and returns a typed
 * DoctorReport. It NEVER throws — a failed probe becomes a 'fail' DoctorCheck.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AshlrConfig, DoctorCheck, DoctorCheckStatus, DoctorReport, McpRegistry, ToolsRegistry } from './types.js';
import { CONFIG_PATH, INDEX_PATH, loadConfig } from './config.js';
import { getPhantomStatus } from './phantom.js';
import { getProviderRegistry } from './providers.js';

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

// ---------------------------------------------------------------------------
// Individual check implementations — each returns a DoctorCheck, never throws
// ---------------------------------------------------------------------------

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
  const pathDirs = (process.env['PATH'] ?? '').split(':');
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

/** ashlr binary present (which ashlr) */
function checkAshlrInstalled(): DoctorCheck {
  const out = runCmd('which', ['ashlr']);
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
  try {
    if (!existsSync(CONFIG_PATH)) {
      return check(
        'config',
        'Config file exists',
        'fail',
        `${CONFIG_PATH} not found`,
        'Run: ashlr init',
      );
    }
    loadConfig(); // will throw on parse failure
    return check('config', 'Config file exists', 'pass', `${CONFIG_PATH} is valid JSON`);
  } catch (err) {
    return check(
      'config',
      'Config file exists',
      'fail',
      `${CONFIG_PATH} is invalid: ${String(err)}`,
      'Fix JSON syntax errors in ~/.ashlr/config.json',
    );
  }
}

/** ~/.ashlr/index.json present + not stale (> 7 days old = warn) */
function checkIndex(): DoctorCheck {
  try {
    if (!existsSync(INDEX_PATH)) {
      return check(
        'index',
        'Index file present',
        'warn',
        `${INDEX_PATH} not found — run ashlr index to build it`,
        'ashlr index',
      );
    }

    const raw = readFileSync(INDEX_PATH, 'utf8');
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
      : Date.now() - statSync(INDEX_PATH).mtimeMs;

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
 * Check: Ashlr ecosystem tools installed.
 * id: 'ashlr-tools-installed'
 * pass with count, warn if <2 tools installed.
 *
 * The toolsRegistry parameter is the pre-fetched result of getToolsRegistry()
 * (or null when the module is not available).
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

  if (count >= 2) {
    return check(
      'ashlr-tools-installed',
      'Ashlr tools installed',
      'pass',
      `${count}/${total} ecosystem tool${count !== 1 ? 's' : ''} installed`,
    );
  }

  return check(
    'ashlr-tools-installed',
    'Ashlr tools installed',
    'warn',
    `Only ${count}/${total} ecosystem tool${count !== 1 ? 's' : ''} installed`,
    'Install ashlr ecosystem tools (phantom, ashlrcode, aw, etc.)',
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
 */
export async function runDoctor(cfg: AshlrConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // --- Pre-fetch M3 registry results (both are async-safe, never throw) ---
  const [mcpRegistry, toolsRegistry] = await Promise.all([
    tryDiscoverMcpServers(),
    tryGetToolsRegistry(),
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
        const fixHint =
          provider.id === 'lmstudio'
            ? 'Start LM Studio and enable the local server'
            : provider.id === 'ollama'
              ? 'Start Ollama: ollama serve'
              : `Start the ${provider.id} provider`;
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
