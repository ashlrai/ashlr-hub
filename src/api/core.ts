/**
 * api/core.ts — the PUBLIC programmatic surface of @ashlr/hub (M33).
 *
 * Curated, read-heavy re-exports so other tools can build on ashlr's local
 * stores without shelling out to the CLI. Everything here follows the same
 * safety rules as the CLI: reads are free; the only mutation exposed is the
 * inbox proposal path (pending, human-gated) — applyProposal is deliberately
 * NOT exported.
 */

// Config (read + write of ~/.ashlr/config.json with validation)
export { loadConfig, saveConfig, defaultConfig, CONFIG_PATH } from '../core/config.js';
export { buildEffectiveConfigSnapshot, loadEffectiveConfigSnapshot } from '../core/effective-config.js';
export type { EffectiveConfigSnapshot, EffectiveConfigValue, EffectiveBackendConfig } from '../core/effective-config.js';

// Desktop index (read-only)
export { loadIndex } from '../core/index-engine.js';

// Orientation — the composite session-start context (M31)
export { buildOrientation } from '../core/orient.js';

// Genome memory
export { recall } from '../core/genome/recall.js';
export { loadGenome, appendHubEntry } from '../core/genome/store.js';

// Portfolio intelligence (read-only)
export { loadBacklog } from '../core/portfolio/backlog.js';
export { loadPreviousReport, listReports } from '../core/quality/store.js';
export { ask } from '../core/knowledge/ask.js';
export { impact, buildGraph } from '../core/knowledge/graph.js';

// Runs + swarms (read-only history)
export { listRuns, loadRun } from '../core/run/orchestrator.js';
export { listSwarms, loadSwarm } from '../core/swarm/store.js';

// Pre-flight estimation (M32)
export { estimateRun, estimateSwarm } from '../core/observability/estimate.js';
export { buildRollup } from '../core/observability/rollup.js';

// Approval inbox — list/load + CREATE (pending only). Approval/apply is
// deliberately NOT exported: that path stays human-gated via the CLI/web.
export { listProposals, loadProposal, createProposal, pendingCount } from '../core/inbox/store.js';

// Audit trail (read-only)
export { readAudit } from '../core/sandbox/audit.js';

// Providers + seams (read-only diagnostics)
export { getProviderRegistry } from '../core/providers.js';
export { buildSeamRegistry } from '../core/seams/registry.js';

// Native MCP tool registry (M31) — for hosts embedding ashlr's agent tools
export { nativeToolDefs, listNativeTools, isNativeTool, callNativeTool } from '../core/mcp-native.js';

// Dashboard snapshot (read-only aggregate)
export { buildSnapshot } from '../core/dashboard.js';
