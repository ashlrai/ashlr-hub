/**
 * core/plugins/host-api.ts — M33 PluginHost factory.
 *
 * CONTRACT RULES (non-negotiable):
 *  - buildHostApi returns a fully frozen PluginHost. Every nested object is
 *    deep-frozen via structuredClone + recursive Object.freeze.
 *  - `settings` is a deep-frozen copy of cfg.plugins.settings[name] ONLY.
 *    The plugin NEVER receives the full AshlrConfig.
 *  - `view` is a frozen allowlisted projection — only editor + staleDays.
 *  - `audit()` delegates to core/sandbox/audit.ts and prefixes the action
 *    with "plugin:<name>:" automatically. Never throws.
 *  - `log()` writes to stderr, prefixed "[plugin:<name>]". Never throws.
 *  - `dataDir` is created eagerly at ~/.ashlr/plugin-data/<name>/ if absent.
 *  - homedir() is resolved at call time so tests can relocate HOME.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { audit } from '../sandbox/audit.js';
import { PLUGIN_API_VERSION, type PluginHost } from './types.js';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Deep-freeze helper
// ---------------------------------------------------------------------------

/**
 * Recursively freeze `value` and all nested plain-object/array values.
 * Returns the input (mutated in-place by Object.freeze, same reference).
 * Only freezes plain objects and arrays to avoid freezing class instances.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// buildHostApi — public factory
// ---------------------------------------------------------------------------

/**
 * Build a fully frozen PluginHost for a plugin identified by `manifest.name`.
 *
 * `cfg` is the current AshlrConfig. Only a safe projection is exposed to the
 * plugin — never the full config object.
 *
 * dataDir (~/.ashlr/plugin-data/<name>/) is created eagerly so the plugin can
 * use it immediately after activate() without setup.
 */
export function buildHostApi(
  manifest: { name: string },
  cfg: AshlrConfig,
): PluginHost {
  const name = manifest.name;

  // --- dataDir: created eagerly ---
  // Re-resolve homedir() at call time (house convention: tests relocate HOME).
  const dataDir = join(homedir(), '.ashlr', 'plugin-data', name);
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // best-effort: if creation fails, log but don't throw — the host is still usable.
  }

  // --- settings: deep-frozen copy of the plugin's own settings only ---
  const rawSettings: Record<string, unknown> =
    (cfg.plugins?.settings?.[name] as Record<string, unknown> | undefined) ?? {};
  const frozenSettings = deepFreeze(structuredClone(rawSettings)) as Readonly<
    Record<string, unknown>
  >;

  // --- view: frozen allowlisted projection ---
  const frozenView = Object.freeze({
    editor: cfg.editor ?? 'vscode',
    staleDays: cfg.staleDays ?? 30,
  });

  // --- Build the host (freeze the outer object last) ---
  const host: PluginHost = {
    apiVersion: PLUGIN_API_VERSION,
    pluginName: name,

    log(msg: string): void {
      try {
        process.stderr.write(`[plugin:${name}] ${msg}\n`);
      } catch {
        // log must never throw
      }
    },

    audit(action: string, summary: string): void {
      // Delegate to core audit(), prefixing action with "plugin:<name>:".
      // audit() never throws (house invariant).
      audit({
        action: `plugin:${name}:${action}`,
        repo: null,
        sandboxId: null,
        summary,
        result: 'ok',
      });
    },

    get settings(): Readonly<Record<string, unknown>> {
      return frozenSettings;
    },

    get view(): Readonly<{ editor: string; staleDays: number }> {
      return frozenView;
    },

    get dataDir(): string {
      return dataDir;
    },
  };

  // Freeze the host object itself. Methods are enumerable only if they appear
  // on the object, not the prototype, so we freeze the literal object.
  return Object.freeze(host) as PluginHost;
}
