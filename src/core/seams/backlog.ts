/**
 * core/seams/backlog.ts — BacklogSource seam (M30).
 *
 * SEAM over core/portfolio/backlog.ts (loadBacklog / buildBacklog + scanners).
 *
 *   (a) BacklogSource        — the interface.
 *   (b) LocalBacklogSource   — DEFAULT. Behavior-preserving adapter delegating
 *                              1:1 to the existing functions (scanners run
 *                              exactly as before; enrollment-scoped; read-only).
 *   (c) CloudBacklogSource   — GATED stub; every method throws before any I/O.
 *   (d) selectBacklogSource  — local by default; gated stub ONLY when a cloud
 *                              endpoint is explicitly configured (still refuses).
 *
 * HARD SAFETY: local-first + self-hostable + cloud-gated. No new deps.
 */

import { buildBacklog, loadBacklog } from '../portfolio/backlog.js';
import type { AshlrConfig, Backlog } from '../types.js';
import { seamEndpoint } from './registry.js';
import { cloudGatedError } from './types.js';

export const BACKLOG_SEAM = {
  id: 'backlog' as const,
  name: 'BacklogSource',
  delegatesTo: 'core/portfolio/backlog.ts',
  summary: 'Aggregate scored work items across ENROLLED repos (read-only).',
};

/** Read + (re)build the scored, deduped work backlog. */
export interface BacklogSource {
  /** Load the persisted backlog, or null when absent/malformed. */
  load(): Backlog | null;
  /** Re-scan enrolled repos (or `opts.repos`) and rebuild the backlog. */
  build(opts?: { repos?: string[] }): Promise<Backlog>;
}

/** DEFAULT local impl — pass-through adapter over core/portfolio/backlog.ts. */
export class LocalBacklogSource implements BacklogSource {
  load(): Backlog | null {
    return loadBacklog();
  }
  build(opts?: { repos?: string[] }): Promise<Backlog> {
    return buildBacklog(opts);
  }
}

/** GATED cloud stub — a shared team backlog WOULD live here. Throws first. */
export class CloudBacklogSource implements BacklogSource {
  load(): Backlog | null {
    throw cloudGatedError(BACKLOG_SEAM.name, 'load');
  }
  build(_opts?: { repos?: string[] }): Promise<Backlog> {
    throw cloudGatedError(BACKLOG_SEAM.name, 'build');
  }
}

/** Local by default; gated stub only when an endpoint is configured (refuses). */
export function selectBacklogSource(cfg: AshlrConfig): BacklogSource {
  return seamEndpoint(cfg, 'backlog') ? new CloudBacklogSource() : new LocalBacklogSource();
}
