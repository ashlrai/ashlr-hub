import type { ResourceAccountIdentityWitness } from './account-identity-witness.js';

export type CreditPoolKind = 'gifted-cloud' | 'purchased-usage' | 'subscription-allowance';
export type CreditPoolUnit = 'USD' | 'percent';
export type CreditPoolSurface = 'cloud-session' | 'over-plan-usage' | 'subscription';
export type CreditPoolAdapter = 'claude-account-ui' | 'codex-rate-limits' | 'claude-usage' | 'grok-usage';

/** Private evidence only. Never changes a budget, binding, quota or admission. */
export interface CreditPoolObservation {
  v: 1;
  poolId: string;
  kind: CreditPoolKind;
  accountId: string;
  provider: ResourceAccountIdentityWitness['provider'];
  /** USD remaining for credit pools; percent used for subscription windows. Never token availability. */
  amount: string | null;
  total: string | null;
  unit: CreditPoolUnit;
  surface: CreditPoolSurface;
  capturedAt: string;
  expiresAt: string | null;
  expiryKind: 'fixed' | 'rolling-release' | 'unknown';
  source: { kind: 'verified-manual' | 'native-metadata'; adapter: CreditPoolAdapter };
  /** A manual claim alone is insufficient: capture requires matching native witnesses. */
  capture: { before: ResourceAccountIdentityWitness; after: ResourceAccountIdentityWitness };
}

/** Explicit projection excludes native identity hashes, generations, paths and credentials. */
export interface CreditPoolRowView {
  poolId: string;
  accountId: string;
  provider: CreditPoolObservation['provider'];
  kind: CreditPoolKind;
  amount: string | null;
  total: string | null;
  unit: CreditPoolUnit;
  surface: CreditPoolSurface;
  capturedAt: string;
  expiresAt: string | null;
  expiryKind: CreditPoolObservation['expiryKind'];
  source: CreditPoolObservation['source'];
  identityState: 'matched' | 'unknown' | 'mismatch';
  evidenceState: 'recorded' | 'current-native' | 'stale-native' | 'identity-unknown' | 'identity-mismatch';
  expiryState: 'upcoming' | 'expired' | 'unknown';
}
export interface CreditPoolReadView {
  v: 1;
  sourceState: 'healthy' | 'missing' | 'unavailable';
  rows: CreditPoolRowView[];
}
