/** Browser-safe connection evidence. Labels are operator supplied, never native identities. */
import type { ResourceQuotaWindow } from './pool-policy.js';
import { sanitizeCodexProbeCleanupDiagnostics, type CodexProbeCleanupDiagnostics } from './codex-probe-diagnostics.js';

export interface ResourceConnectionFailure {
  accountId: string;
  observedAt: string;
  reasonCode: 'native-cleanup-unconfirmed' | 'native-result-invalid' | 'native-call-rejected' | 'activity-settlement-failed';
  /** A cancelled peer is not evidence of the initiating failure. */
  cancellationAlreadyRequested: boolean;
  cleanupDiagnostics?: CodexProbeCleanupDiagnostics;
}

/** Closed browser contract, separate from the native error or cancellation authority. */
export function validResourceConnectionFailure(value: unknown): value is ResourceConnectionFailure {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = ['accountId', 'observedAt', 'reasonCode', 'cancellationAlreadyRequested',
      ...(Object.hasOwn(value, 'cleanupDiagnostics') ? ['cleanupDiagnostics'] : [])];
    if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => {
      const property = Object.getOwnPropertyDescriptor(value, key); return property && 'value' in property;
    })) return false;
    const row = value as ResourceConnectionFailure;
    if (typeof row.accountId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.accountId) ||
      typeof row.observedAt !== 'string' || !Number.isFinite(Date.parse(row.observedAt)) || new Date(row.observedAt).toISOString() !== row.observedAt ||
      !['native-cleanup-unconfirmed', 'native-result-invalid', 'native-call-rejected', 'activity-settlement-failed'].includes(row.reasonCode) ||
      typeof row.cancellationAlreadyRequested !== 'boolean') return false;
    if (Object.hasOwn(value, 'cleanupDiagnostics')) {
      const diagnostic = row.cleanupDiagnostics;
      if (!diagnostic || Reflect.ownKeys(diagnostic).length !== 4 || !sanitizeCodexProbeCleanupDiagnostics(diagnostic)) return false;
    }
    return true;
  } catch { return false; }
}

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
  /** First failure observed by this monitor, not necessarily by the shared collector. */
  firstFailure?: ResourceConnectionFailure;
}
