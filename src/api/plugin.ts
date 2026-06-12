/**
 * api/plugin.ts — the PUBLIC plugin-system surface of @ashlr/hub (M33).
 *
 * Curated re-exports for plugin authors:
 *   import type { PluginManifest, AshlrPlugin, ... } from '@ashlr/hub/plugin';
 *   import { definePlugin, PLUGIN_API_VERSION } from '@ashlr/hub/plugin';
 *
 * Internals (registry, host-api, wrappers, manifest reader) stay unexported —
 * add exports deliberately, never wholesale.
 */

// Types + identity helper for plugin authors.
export {
  PLUGIN_API_VERSION,
  definePlugin,
} from '../core/plugins/types.js';

export type {
  PluginCapability,
  PluginManifest,
  PluginHost,
  PluginScanner,
  PluginProviderSpec,
  PluginCommandSpec,
  PluginContributions,
  AshlrPlugin,
} from '../core/plugins/types.js';
