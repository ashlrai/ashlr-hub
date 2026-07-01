/**
 * core/plugins/registry.ts — M33 plugin discovery, load, and accessors.
 *
 * CONTRACT RULES (non-negotiable):
 *  - discoverPlugins NEVER imports plugin code. It only reads manifest.json.
 *  - loadEnabledPlugins gate chain (in order):
 *      1. ASHLR_NO_PLUGINS=1 → return [] immediately.
 *      2. killSwitchOn() → return [] + audit 'plugin:load' refused.
 *      3. Only names in cfg.plugins?.enabled ?? [] (default empty → load NOTHING).
 *      4. Manifest valid + apiVersion compatible (via readManifest).
 *      5. verifyIntegrity passes.
 *      6. await import(pathToFileURL(entry).href) in try/catch.
 *      7. activate(host) raced against timeout.
 *      8. Capability filter: drop contributions whose kind is not declared.
 *  - A failing plugin is skipped (audited), NEVER fatal.
 *  - Module-level memo cache: one load per process.
 *  - homedir() re-resolved at call time for test HOME relocation.
 *
 * ZERO RUNTIME DEPS: only Node builtins + local imports.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { audit } from '../sandbox/audit.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { readManifest } from './manifest.js';
import { verifyIntegrity } from './integrity.js';
import { buildHostApi } from './host-api.js';
import { wrapScanner, validateTemplate, wrapCommand } from './wrappers.js';
import type { AshlrConfig, WorkItem, ProjectTemplate } from '../types.js';
import type {
  PluginManifest,
  PluginContributions,
  AshlrPlugin,
  PluginCommandSpec,
  PluginProviderSpec,
  PluginScanner,
} from './types.js';

// ---------------------------------------------------------------------------
// Timeout control (exported for tests via _setActivateTimeoutForTest)
// ---------------------------------------------------------------------------

/** Default activate() timeout in milliseconds. */
const DEFAULT_ACTIVATE_TIMEOUT_MS = 5000;

/** Current activate timeout; overridable for tests. */
let _activateTimeoutMs = DEFAULT_ACTIVATE_TIMEOUT_MS;

/**
 * Override the activate() timeout for tests. Pass undefined to reset to default.
 * Named with underscore prefix per house test-seam convention.
 */
export function _setActivateTimeoutForTest(ms: number | undefined): void {
  _activateTimeoutMs = ms !== undefined ? ms : DEFAULT_ACTIVATE_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Module-level cache (one load per process)
// ---------------------------------------------------------------------------

/** Memoised result of loadEnabledPlugins, keyed on JSON-sorted enabled names. */
let _cache: Map<string, LoadedPlugin[]> | null = null;

/**
 * Reset the plugin cache. For tests only — allows re-loading after config changes.
 * Named with underscore prefix per house test-seam convention.
 */
export function _resetPluginCacheForTest(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A fully-loaded, activated plugin with its contributions. */
export interface LoadedPlugin {
  name: string;
  manifest: PluginManifest;
  contributions: PluginContributions;
}

// ---------------------------------------------------------------------------
// discoverPlugins — list ~/.ashlr/plugins/*/, read manifests
// ---------------------------------------------------------------------------

/**
 * Discover all plugin directories under ~/.ashlr/plugins/.
 * For each subdirectory, attempts to read and validate manifest.json.
 *
 * NEVER imports plugin code — manifest read only.
 * NEVER throws.
 *
 * homedir() is resolved at call time so tests can relocate HOME.
 */
export function discoverPlugins(): Array<{
  dir: string;
  manifest?: PluginManifest;
  ok: boolean;
  reason?: string;
}> {
  try {
    const pluginsDir = join(homedir(), '.ashlr', 'plugins');

    let entries: string[];
    try {
      entries = readdirSync(pluginsDir);
    } catch {
      // Plugins dir absent — no plugins discovered.
      return [];
    }

    const results: Array<{
      dir: string;
      manifest?: PluginManifest;
      ok: boolean;
      reason?: string;
    }> = [];

    for (const entry of entries) {
      const dir = join(pluginsDir, entry);

      // Only descend into directories (skip files, symlinks, etc.).
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }

      const result = readManifest(dir);
      if (result.ok) {
        results.push({ dir, manifest: result.manifest, ok: true });
      } else {
        results.push({ dir, ok: false, reason: result.reason });
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal: raceActivate — activate with timeout
// ---------------------------------------------------------------------------

/**
 * Race plugin.activate(host) against a timeout.
 * Returns contributions on success, or throws on timeout/error.
 */
function raceActivate(
  plugin: AshlrPlugin,
  host: ReturnType<typeof buildHostApi>,
): Promise<PluginContributions> {
  return new Promise<PluginContributions>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('plugin activate() timed out'));
    }, _activateTimeoutMs);

    Promise.resolve()
      .then(() => plugin.activate(host))
      .then((contributions) => {
        clearTimeout(timer);
        resolve(contributions);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

// ---------------------------------------------------------------------------
// Internal: filterContributions — drop undeclared capability kinds
// ---------------------------------------------------------------------------

/**
 * Drop contributions whose kind is not declared in manifest.capabilities.
 * Audits a 'plugin:capability-violation' for each dropped kind.
 */
function filterContributions(
  name: string,
  manifest: PluginManifest,
  raw: PluginContributions,
): PluginContributions {
  const caps = new Set(manifest.capabilities);
  const filtered: PluginContributions = {};

  if (raw.scanners !== undefined) {
    if (caps.has('scanner')) {
      filtered.scanners = raw.scanners;
    } else {
      audit({
        action: 'plugin:capability-violation',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" contributed scanners but did not declare 'scanner' capability`,
        result: 'refused',
      });
    }
  }

  if (raw.templates !== undefined) {
    if (caps.has('template')) {
      filtered.templates = raw.templates;
    } else {
      audit({
        action: 'plugin:capability-violation',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" contributed templates but did not declare 'template' capability`,
        result: 'refused',
      });
    }
  }

  if (raw.providers !== undefined) {
    if (caps.has('provider')) {
      filtered.providers = raw.providers;
    } else {
      audit({
        action: 'plugin:capability-violation',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" contributed providers but did not declare 'provider' capability`,
        result: 'refused',
      });
    }
  }

  if (raw.commands !== undefined) {
    if (caps.has('command')) {
      filtered.commands = raw.commands;
    } else {
      audit({
        action: 'plugin:capability-violation',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" contributed commands but did not declare 'command' capability`,
        result: 'refused',
      });
    }
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// loadEnabledPlugins — the main loader
// ---------------------------------------------------------------------------

/**
 * Load all enabled plugins per cfg.plugins.enabled gate chain.
 *
 * Gate chain (each step audited):
 *  1. ASHLR_NO_PLUGINS=1 → return [].
 *  2. killSwitchOn() → return [] + audit refused.
 *  3. cfg.plugins?.enabled ?? [] (default empty → load NOTHING).
 *  4. Manifest valid + apiVersion compatible.
 *  5. verifyIntegrity passes.
 *  6. await import(pathToFileURL(entry).href).
 *  7. activate(host) raced against timeout.
 *  8. Capability filter.
 *
 * A failing plugin is skipped (audited), never fatal.
 * Results are cached per process (keyed on sorted enabled names).
 */
export async function loadEnabledPlugins(cfg: AshlrConfig): Promise<LoadedPlugin[]> {
  // Gate 1: ASHLR_NO_PLUGINS
  if (process.env.ASHLR_NO_PLUGINS === '1') {
    return [];
  }

  // Gate 2: kill switch
  if (killSwitchOn()) {
    audit({
      action: 'plugin:load',
      repo: null,
      sandboxId: null,
      summary: 'plugin loading refused: kill switch is ON',
      result: 'refused',
    });
    return [];
  }

  // Gate 3: enabled list (default empty = load nothing)
  const enabled: string[] = cfg.plugins?.enabled ?? [];
  if (enabled.length === 0) {
    return [];
  }

  // Cache key: sorted enabled names (order-independent)
  const cacheKey = JSON.stringify([...enabled].sort());
  if (_cache !== null) {
    const cached = _cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  const pluginsDir = join(homedir(), '.ashlr', 'plugins');
  const loaded: LoadedPlugin[] = [];

  for (const name of enabled) {
    const dir = join(pluginsDir, name);

    // Gate 4: read + validate manifest (also checks apiVersion range)
    const manifestResult = readManifest(dir);
    if (!manifestResult.ok) {
      audit({
        action: 'plugin:load',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" refused: invalid manifest — ${manifestResult.reason}`,
        result: 'refused',
      });
      continue;
    }

    const manifest = manifestResult.manifest;
    const entryPath = resolvePath(dir, manifest.entry);

    // Gate 5: integrity verification
    const integrityResult = verifyIntegrity(cfg, name, entryPath);
    if (!integrityResult.ok) {
      audit({
        action: 'plugin:load',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" refused: integrity check failed — ${integrityResult.reason ?? 'unknown'}`,
        result: 'refused',
      });
      continue;
    }

    // Gate 6: dynamic import
    let pluginModule: unknown;
    try {
      try {
        pluginModule = await import(/* @vite-ignore */ pathToFileURL(entryPath).href);
      } catch (err) {
        if (!existsSync(entryPath)) throw err;
        const source = readFileSync(entryPath, 'utf8');
        const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
        pluginModule = await import(/* @vite-ignore */ dataUrl);
      }
    } catch (err) {
      audit({
        action: 'plugin:load',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" error: import failed — ${err instanceof Error ? err.message : String(err)}`,
        result: 'error',
      });
      continue;
    }

    // Resolve module default export or named 'plugin' export
    let plugin: unknown;
    if (pluginModule !== null && typeof pluginModule === 'object') {
      const mod = pluginModule as Record<string, unknown>;
      if ('default' in mod) {
        plugin = mod['default'];
      } else if ('plugin' in mod) {
        plugin = mod['plugin'];
      } else {
        plugin = pluginModule;
      }
    } else {
      plugin = pluginModule;
    }

    // Validate AshlrPlugin shape (must have activate function)
    if (
      plugin === null ||
      typeof plugin !== 'object' ||
      typeof (plugin as Record<string, unknown>)['activate'] !== 'function'
    ) {
      audit({
        action: 'plugin:load',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" error: module does not export an AshlrPlugin (missing activate function)`,
        result: 'error',
      });
      continue;
    }

    const ashlrPlugin = plugin as AshlrPlugin;

    // Gate 7: activate with timeout
    const host = buildHostApi(manifest, cfg);
    let contributions: PluginContributions;
    try {
      contributions = await raceActivate(ashlrPlugin, host);
    } catch (err) {
      audit({
        action: 'plugin:load',
        repo: null,
        sandboxId: null,
        summary: `plugin "${name}" error: activate() failed — ${err instanceof Error ? err.message : String(err)}`,
        result: 'error',
      });
      continue;
    }

    // Gate 8: capability filter (drops undeclared kinds + audits violations)
    const filtered = filterContributions(name, manifest, contributions);

    audit({
      action: 'plugin:load',
      repo: null,
      sandboxId: null,
      summary: `plugin "${name}" loaded successfully`,
      result: 'ok',
    });

    loaded.push({ name, manifest, contributions: filtered });
  }

  // Store in cache
  if (_cache === null) {
    _cache = new Map();
  }
  _cache.set(cacheKey, loaded);

  return loaded;
}

// ---------------------------------------------------------------------------
// Accessors — async helpers over loadEnabledPlugins
// ---------------------------------------------------------------------------

/**
 * Get all plugin scanners, wrapped for safety (timeout, cap, scrub, namespace).
 * Returns wrapped functions (repo: string) => Promise<WorkItem[]>.
 */
export async function getPluginScanners(
  cfg: AshlrConfig,
): Promise<Array<(repo: string) => Promise<WorkItem[]>>> {
  const plugins = await loadEnabledPlugins(cfg);
  const wrapped: Array<(repo: string) => Promise<WorkItem[]>> = [];
  for (const p of plugins) {
    for (const scanner of (p.contributions.scanners ?? []) as PluginScanner[]) {
      wrapped.push(wrapScanner(p.name, scanner));
    }
  }
  return wrapped;
}

/**
 * Get all plugin templates, validated (id-prefixed, path-checked).
 */
export async function getPluginTemplates(cfg: AshlrConfig): Promise<ProjectTemplate[]> {
  const plugins = await loadEnabledPlugins(cfg);
  const templates: ProjectTemplate[] = [];
  for (const p of plugins) {
    for (const t of p.contributions.templates ?? []) {
      const validated = validateTemplate(p.name, t);
      if (validated !== null) {
        templates.push(validated);
      }
    }
  }
  return templates;
}

/**
 * Get all plugin providers (raw, as contributed after capability filtering).
 */
export async function getPluginProviders(cfg: AshlrConfig): Promise<PluginProviderSpec[]> {
  const plugins = await loadEnabledPlugins(cfg);
  const providers: PluginProviderSpec[] = [];
  for (const p of plugins) {
    for (const provider of p.contributions.providers ?? []) {
      providers.push(provider);
    }
  }
  return providers;
}

/**
 * Get all plugin commands, wrapped for safety (audit, exit-code catch).
 */
export async function getPluginCommands(cfg: AshlrConfig): Promise<PluginCommandSpec[]> {
  const plugins = await loadEnabledPlugins(cfg);
  const commands: PluginCommandSpec[] = [];
  for (const p of plugins) {
    for (const cmd of p.contributions.commands ?? []) {
      commands.push(wrapCommand(p.name, cmd));
    }
  }
  return commands;
}
