/**
 * api/index.ts — the root entry of @ashlr/hub (M33).
 *
 * `import { loadConfig, recall, … } from '@ashlr/hub'` — the curated core
 * surface plus the public types. Plugin authors import from
 * '@ashlr/hub/plugin' instead (see ./plugin.ts).
 */

export * from './core.js';
export type * from './types.js';
