import type { ResourceConnectionQuotaWindow } from './connection-types.js';

/** Historical display only. Never merge these windows into capacity or current credits. */
export interface ResourceLastKnownUsage {
  observedAt: string;
  expiresAt: string;
  windows: ResourceConnectionQuotaWindow[];
  source: 'native-account-checked-history';
  identitySource: 'native-account-checked' | 'native-account-checked-local-epoch';
}
