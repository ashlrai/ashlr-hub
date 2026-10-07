import type { ResourceConnectionQuotaWindow } from './connection-types.js';
import type { CodexCredits } from './codex-credits.js';

/** Original credit observation for display only; never spendable capacity. */
export interface ResourceCodexCreditHistory {
  reading: CodexCredits;
  observedAt: string;
  expiresAt: string;
  planType: string | null;
}

/** Historical display only. Never merge these windows into capacity or current credits. */
export interface ResourceLastKnownUsage {
  observedAt: string;
  expiresAt: string;
  windows: ResourceConnectionQuotaWindow[];
  creditHistory?: ResourceCodexCreditHistory;
  source: 'native-account-checked-history';
  identitySource: 'native-account-checked' | 'native-account-checked-local-epoch' | 'native-account-checked-display-identity';
}
