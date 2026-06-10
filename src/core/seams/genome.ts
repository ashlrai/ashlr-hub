/**
 * core/seams/genome.ts — GenomeSync seam (M30).
 *
 * SEAM over core/genome/store.ts (loadGenome / appendHubEntry / genomeHubHealth).
 *
 *   (a) GenomeSync        — the interface.
 *   (b) LocalGenomeSync   — DEFAULT. Behavior-preserving adapter; delegates 1:1.
 *                           Append-only + bounded + local-only (the store's own
 *                           guardrails are preserved untouched).
 *   (c) CloudGenomeSync   — GATED stub; every method throws before any I/O.
 *   (d) selectGenomeSync  — local by default; gated stub ONLY when an endpoint
 *                           is explicitly configured (still refuses).
 *
 * HARD SAFETY: local-first + self-hostable + cloud-gated. No new deps.
 */

import { appendHubEntry, genomeHubHealth, loadGenome } from '../genome/store.js';
import type { AshlrConfig, GenomeEntry, GenomeHealth, LearnInput } from '../types.js';
import { seamEndpoint } from './registry.js';
import { cloudGatedError } from './types.js';

export const GENOME_SEAM = {
  id: 'genome' as const,
  name: 'GenomeSync',
  delegatesTo: 'core/genome/store.ts',
  summary: 'Shared-memory genome: load aggregated entries, append hub entries, hub health (append-only, local).',
};

/** Shared-memory genome load + append + health roll-up. */
export interface GenomeSync {
  /** Aggregate GenomeEntry records from all local sources (bounded). */
  load(cfg: AshlrConfig): GenomeEntry[];
  /** Append one entry to the local hub store (append-only; returns it). */
  append(input: LearnInput): GenomeEntry;
  /** Hub-only health roll-up (no portfolio disk scan). */
  hubHealth(): GenomeHealth;
}

/** DEFAULT local impl — pass-through adapter over core/genome/store.ts. */
export class LocalGenomeSync implements GenomeSync {
  load(cfg: AshlrConfig): GenomeEntry[] {
    return loadGenome(cfg);
  }
  append(input: LearnInput): GenomeEntry {
    return appendHubEntry(input);
  }
  hubHealth(): GenomeHealth {
    return genomeHubHealth();
  }
}

/** GATED cloud stub — a team-synced genome WOULD live here. Throws first. */
export class CloudGenomeSync implements GenomeSync {
  load(_cfg: AshlrConfig): GenomeEntry[] {
    throw cloudGatedError(GENOME_SEAM.name, 'load');
  }
  append(_input: LearnInput): GenomeEntry {
    throw cloudGatedError(GENOME_SEAM.name, 'append');
  }
  hubHealth(): GenomeHealth {
    throw cloudGatedError(GENOME_SEAM.name, 'hubHealth');
  }
}

/** Local by default; gated stub only when an endpoint is configured (refuses). */
export function selectGenomeSync(cfg: AshlrConfig): GenomeSync {
  return seamEndpoint(cfg, 'genome') ? new CloudGenomeSync() : new LocalGenomeSync();
}
