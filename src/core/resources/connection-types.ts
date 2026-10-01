/** Browser-safe connection evidence. Labels are operator supplied, never native identities. */
import type { ResourceQuotaWindow } from './pool-policy.js';

export interface ResourceConnectionQuotaWindow extends ResourceQuotaWindow {
  /** Advisory provider period, outside canonical resource observations. */
  resetProvenance?: import('../routing/scheduling-types.js').ResetProvenance;
  /** Legacy prose is display only; structured current rows use a distinct exact-version source. */
  nativeReport?: { source: 'claude-usage' | 'claude-usage-structured'; resetDescription: string | null };
}

export interface ResourceAccountConnection {
  id: string;
  label: string;
  provider: 'codex' | 'claude' | 'grok';
  state: 'checking' | 'observed' | 'signed-out' | 'unavailable';
  authentication: 'signed-in' | 'signed-out' | 'unknown';
  health: 'reachable' | 'unknown' | 'unavailable';
  planType: string | null;
  observedAt: string | null;
  expiresAt: string | null;
  windows: ResourceConnectionQuotaWindow[];
  /** Current account-checked native metadata only; independent of subscription quota/admission. */
  codexCredits?: import('./codex-credits.js').CodexCredits | null;
  reason: string;
  onDemandEnabled: boolean | null;
  /** Adapter availability only, never an admission decision or authenticated canary. */
  executionSupported: boolean;
}

export interface ResourceConnectionsSnapshot {
  sampledAt: string;
  refreshing: boolean;
  accounts: ResourceAccountConnection[];
}
