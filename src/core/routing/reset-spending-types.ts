/** Browser-safe readback. Configuration, current admission and history are distinct. */
export type ResetSpendingMode = 'legacy-priority' | 'enabled' | 'disabled';
export type SubscriptionOnlyState = 'verified' | 'unsupported' | 'unknown';
/** A native source port must establish this from provider billing controls, never operator preferences. */
export interface SubscriptionOnlyBoundary {
  source: 'claude-native-extra-usage' | 'codex-siwc-app-credit-control';
  accountHint: string;
  observedAt: string;
  expiresAt: string;
  creditsEnabled: false;
}
export interface ResetSpendingForecastBasis {
  taskId: string; engine: string; model: string; taskKind: string;
  seatId: string | null; p75Ms: number; samples: number; pooled: boolean;
}
export type ResetSpendingState = 'disabled' | 'legacy-priority' | 'authority-paused' | 'account-disabled' |
  'producer-not-granted' | 'signed-floor' | 'unqualified' | 'overage-unverified' | 'execution-unbound' | 'waiting-for-estimate' |
  'cannot-fit' | 'held' | 'ordinary' | 'ready';
export interface ResetSpendingAccountStatus {
  mode: 'inherit' | 'enabled' | 'disabled'; enabled: boolean;
  savedReservePercent: number; signedFloorPercent: number | null; effectiveReservePercent: number | null;
  state: ResetSpendingState; reason: string; constraints: string[];
  deadline: string | null; forecastBasis: ResetSpendingForecastBasis | null;
  subscriptionOnly: SubscriptionOnlyState;
}
export interface ResetSpendingStatus {
  mode: ResetSpendingMode; checkedAt: string;
  authorityState: 'active' | 'paused' | 'unknown';
  accounts: Record<string, ResetSpendingAccountStatus>;
}
