/**
 * core/seams/portfolio.ts — PortfolioSync seam (M30).
 *
 * SEAM over core/quality/store.ts (HealthReport snapshots) + core/dashboard.ts
 * (the portfolio DashboardSnapshot).
 *
 *   (a) PortfolioSync        — the interface.
 *   (b) LocalPortfolioSync   — DEFAULT. Behavior-preserving adapter; delegates
 *                              1:1. Health snapshots write ONLY under
 *                              ~/.ashlr/quality/; snapshot build is read-only.
 *   (c) CloudPortfolioSync   — GATED stub; every method throws before any I/O.
 *   (d) selectPortfolioSync  — local by default; gated stub ONLY when an
 *                              endpoint is explicitly configured (still refuses).
 *
 * HARD SAFETY: local-first + self-hostable + cloud-gated. No new deps.
 */

import { listReports, loadPreviousReport, saveReport } from '../quality/store.js';
import { buildSnapshot } from '../dashboard.js';
import type { AshlrConfig, DashboardSnapshot, HealthReport } from '../types.js';
import { seamEndpoint } from './registry.js';
import { cloudGatedError } from './types.js';

export const PORTFOLIO_SEAM = {
  id: 'portfolio' as const,
  name: 'PortfolioSync',
  delegatesTo: 'core/quality/store.ts + core/dashboard.ts',
  summary: 'Portfolio health snapshots (~/.ashlr/quality/) + the org dashboard roll-up (read-only build).',
};

/** Health-snapshot persistence + portfolio dashboard build. */
export interface PortfolioSync {
  /** Persist a HealthReport snapshot; returns its path or null on failure. */
  saveReport(report: HealthReport): string | null;
  /** List persisted HealthReport snapshots, most-recent first (bounded). */
  listReports(): HealthReport[];
  /** Newest snapshot strictly before `before` (for trend deltas), or null. */
  loadPreviousReport(before?: string): HealthReport | null;
  /** Build the portfolio dashboard snapshot (read-only aggregation). */
  buildSnapshot(cfg: AshlrConfig): Promise<DashboardSnapshot>;
}

/** DEFAULT local impl — pass-through adapter over the quality store + dashboard. */
export class LocalPortfolioSync implements PortfolioSync {
  saveReport(report: HealthReport): string | null {
    return saveReport(report);
  }
  listReports(): HealthReport[] {
    return listReports();
  }
  loadPreviousReport(before?: string): HealthReport | null {
    return loadPreviousReport(before);
  }
  buildSnapshot(cfg: AshlrConfig): Promise<DashboardSnapshot> {
    return buildSnapshot(cfg);
  }
}

/** GATED cloud stub — a team-shared portfolio roll-up WOULD live here. Throws first. */
export class CloudPortfolioSync implements PortfolioSync {
  saveReport(_report: HealthReport): string | null {
    throw cloudGatedError(PORTFOLIO_SEAM.name, 'saveReport');
  }
  listReports(): HealthReport[] {
    throw cloudGatedError(PORTFOLIO_SEAM.name, 'listReports');
  }
  loadPreviousReport(_before?: string): HealthReport | null {
    throw cloudGatedError(PORTFOLIO_SEAM.name, 'loadPreviousReport');
  }
  buildSnapshot(_cfg: AshlrConfig): Promise<DashboardSnapshot> {
    throw cloudGatedError(PORTFOLIO_SEAM.name, 'buildSnapshot');
  }
}

/** Local by default; gated stub only when an endpoint is configured (refuses). */
export function selectPortfolioSync(cfg: AshlrConfig): PortfolioSync {
  return seamEndpoint(cfg, 'portfolio') ? new CloudPortfolioSync() : new LocalPortfolioSync();
}
