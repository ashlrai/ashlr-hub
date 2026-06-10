/**
 * core/seams/index.ts — M30 seams barrel.
 *
 * Single import surface for the v2 cloud-ready seams. Re-exports every seam's
 * interface + LOCAL impl + GATED cloud stub + selector, plus the registry and
 * shared types. The TelemetrySink seam (M19) is the CANONICAL reference and is
 * CITED via the registry — it is NOT re-exported/duplicated here.
 *
 * HARD SAFETY: importing this barrel performs NO I/O and activates NOTHING.
 * Every selector returns the LOCAL impl by default; cloud stubs throw.
 */

export * from './types.js';
export * from './registry.js';
export * from './run-swarm.js';
export * from './backlog.js';
export * from './inbox.js';
export * from './daemon-coordinator.js';
export * from './genome.js';
export * from './portfolio.js';
export * from './identity.js';
