/**
 * core/plugins/types.ts — M33 plugin-system public types.
 *
 * CONTRACT RULES (non-negotiable):
 *  - PLUGIN_API_VERSION is the host's current API version. Plugins declare a
 *    semver RANGE in manifest.apiVersion; loadEnabledPlugins verifies
 *    compatibility before import.
 *  - PluginHost carries ONLY a deep-frozen copy of the plugin's own settings
 *    and an allowlisted VIEW of config — never the full AshlrConfig.
 *  - PluginContributions may include scanners, templates, providers, commands.
 *    Contributions whose kind is not declared in manifest.capabilities are
 *    DROPPED by the registry gate (capability-violation audit).
 *  - definePlugin is an identity helper so plugin authors get full type-checking
 *    on their module default export without an explicit cast.
 *  - Never throws from any type-level helper; all guards are pure.
 */

import type { WorkItem, ProjectTemplate } from '../types.js';

// ---------------------------------------------------------------------------
// Host API version
// ---------------------------------------------------------------------------

/**
 * The API version this host implements. Plugins declare a semver RANGE in
 * manifest.apiVersion; only compatible ranges are loaded.
 * Bumped when the PluginHost shape or contribution contracts change.
 */
export const PLUGIN_API_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Plugin capabilities
// ---------------------------------------------------------------------------

/**
 * The set of capability kinds a plugin may declare. A plugin may only
 * contribute items whose kind appears in manifest.capabilities — undeclared
 * contributions are DROPPED and audited as 'plugin:capability-violation'.
 */
export type PluginCapability = 'scanner' | 'template' | 'provider' | 'command';

// ---------------------------------------------------------------------------
// PluginManifest — the <dir>/manifest.json schema
// ---------------------------------------------------------------------------

/**
 * Parsed, validated shape of a plugin's manifest.json.
 *
 * VALIDATION RULES (enforced by readManifest — never assumed by callers):
 *  - name: ^[a-z][a-z0-9-]{0,39}$ AND must equal basename(dir).
 *  - version: plugin's own semver (informational; not range-evaluated).
 *  - apiVersion: semver RANGE evaluated against PLUGIN_API_VERSION.
 *    Supported forms: exact "1.0.0", caret "^1.0.0", tilde "~1.0.0", wildcard "1.x".
 *  - entry: relative path ("./index.js"); must resolve INSIDE the plugin dir
 *    (path-string containment check; entry file may not exist at discovery time).
 *  - capabilities: non-empty array of PluginCapability.
 *  - No __proto__ / constructor / prototype keys anywhere in the object.
 */
export interface PluginManifest {
  /** Plugin name — must match ^[a-z][a-z0-9-]{0,39}$ and equal basename(dir). */
  name: string;
  /** The plugin's own semver (e.g. "0.1.0"). */
  version: string;
  /**
   * Semver RANGE the plugin requires of the host API.
   * Forms: exact "1.0.0", caret "^1.0.0", tilde "~1.0.0", wildcard "1.x" / "1.0.x".
   */
  apiVersion: string;
  /** Short human-readable description. */
  description?: string;
  /**
   * Relative ESM entry path from the plugin dir (e.g. "./index.js").
   * Must resolve INSIDE the plugin dir — no ".." segments, no absolute paths.
   */
  entry: string;
  /** What this plugin contributes. Only declared kinds may appear in contributions. */
  capabilities: PluginCapability[];
  /** Optional link to plugin docs or homepage. */
  homepage?: string;
}

// ---------------------------------------------------------------------------
// PluginHost — the capability surface given to each plugin's activate()
// ---------------------------------------------------------------------------

/**
 * The host API handed to a plugin's activate() function.
 * Every property is read-only and frozen; the plugin cannot mutate host state.
 *
 * SAFETY:
 *  - `settings` is a deep-frozen structuredClone of cfg.plugins.settings[name] only.
 *    The plugin NEVER receives the full AshlrConfig.
 *  - `view` is a frozen, allowlisted projection — never the raw config.
 *  - `audit()` prefixes every action with "plugin:<name>:" automatically.
 *  - `log()` writes to stderr, prefixed "[plugin:<name>]".
 *  - `dataDir` is ~/.ashlr/plugin-data/<name>/; created eagerly on buildHostApi.
 */
export interface PluginHost {
  /** The host's current API version (PLUGIN_API_VERSION). */
  readonly apiVersion: string;
  /** The name of this plugin (from its manifest). */
  readonly pluginName: string;
  /**
   * Write a log line to stderr. Output is prefixed "[plugin:<name>]".
   * Never throws.
   */
  log(msg: string): void;
  /**
   * Emit an audit record. The action is automatically namespaced as
   * "plugin:<name>:<action>" so plugin audit traffic is identifiable.
   * Delegates to core/sandbox/audit.ts audit(); never throws.
   */
  audit(action: string, summary: string): void;
  /**
   * Deep-frozen copy of cfg.plugins.settings[<name>] — the plugin's own
   * key/value settings ONLY. Never the full AshlrConfig.
   */
  readonly settings: Readonly<Record<string, unknown>>;
  /**
   * Frozen, allowlisted projection of the host config. Contains only
   * non-sensitive fields that plugins legitimately need.
   * Never the raw AshlrConfig.
   */
  readonly view: Readonly<{ editor: string; staleDays: number }>;
  /**
   * Absolute path to ~/.ashlr/plugin-data/<name>/.
   * Created eagerly by buildHostApi; the plugin may read/write here freely.
   */
  readonly dataDir: string;
}

// ---------------------------------------------------------------------------
// Contribution shapes
// ---------------------------------------------------------------------------

/** A scanner contributed by a plugin. */
export interface PluginScanner {
  /** Stable scanner id (e.g. "my-linter"). Namespaced on load: plugin:<name>:<id>. */
  id: string;
  /**
   * Scan a repo and return discovered WorkItems. Must not throw — errors should
   * be caught internally and return []. Called with a 15-second AbortSignal.
   */
  scan(repo: string, ctx: { signal: AbortSignal }): Promise<WorkItem[]>;
}

/** A provider spec contributed by a plugin. */
export interface PluginProviderSpec {
  /** Stable provider id. */
  id: string;
  /** Whether this provider runs locally or in the cloud. */
  tier: 'local' | 'cloud';
  /** Environment variable names this provider requires. */
  envKeys?: string[];
  /** Probe availability. Should resolve quickly; never throw. */
  probe(): Promise<unknown>;
  /** Create a client instance. */
  createClient(opts: { model?: string }): Promise<unknown>;
}

/** A CLI command contributed by a plugin. */
export interface PluginCommandSpec {
  /** The sub-command name (e.g. "lint"). Invoked as `ashlr plugin <name> <cmd>`. */
  name: string;
  /** Short description shown in help. */
  description: string;
  /**
   * Run the command. Return exit code (0 = success). Must not throw — the
   * wrapper catches throws and returns exit code 1.
   */
  run(args: string[], host: PluginHost): Promise<number>;
}

// ---------------------------------------------------------------------------
// PluginContributions — the activate() return value
// ---------------------------------------------------------------------------

/**
 * What a plugin contributes to the host after activate() resolves.
 * Contributions whose kind is not declared in manifest.capabilities are
 * silently DROPPED and audited by the registry gate.
 */
export interface PluginContributions {
  scanners?: PluginScanner[];
  templates?: ProjectTemplate[];
  providers?: PluginProviderSpec[];
  commands?: PluginCommandSpec[];
}

// ---------------------------------------------------------------------------
// AshlrPlugin — the plugin module's public interface
// ---------------------------------------------------------------------------

/**
 * The interface a plugin module must satisfy. The module's default export (or
 * named `plugin` export) must implement this.
 *
 * `activate(host)` is called once per process, raced against a 5-second
 * timeout. May be sync or async. Must not throw — failures are isolated by the
 * registry loader.
 */
export interface AshlrPlugin {
  activate(host: PluginHost): PluginContributions | Promise<PluginContributions>;
}

// ---------------------------------------------------------------------------
// definePlugin — identity helper
// ---------------------------------------------------------------------------

/**
 * Identity helper for plugin authors. Wrap your plugin object to get full
 * TypeScript checking without an explicit cast:
 *
 *   export default definePlugin({ activate(host) { ... } });
 *
 * At runtime this is a pure identity function — zero overhead.
 */
export function definePlugin(p: AshlrPlugin): AshlrPlugin {
  return p;
}
