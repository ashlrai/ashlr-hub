/** Browser-safe connection evidence. Labels are operator supplied, never native identities. */
import type { ResourceQuotaWindow } from './pool-policy.js';

export interface ResourceConnectionQuotaWindow extends ResourceQuotaWindow {
  /** Display only: native /usage floors percentages and hides cached fallback provenance. */
  nativeReport?: { source: 'claude-usage'; resetDescription: string | null };
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
