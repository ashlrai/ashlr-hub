/** Browser-safe API promotion contracts. Historical records never authorize contact. */
export interface ClaudeApiGrantBinding {
  organizationDigest: string;
  workspaceDigest: string;
  credentialDigest: string;
  generation: string;
}
export type ClaudeApiGrantExpiry =
  | { precision: 'date'; date: string; timezone: 'UTC'; instant: null }
  | { precision: 'instant'; date: string; timezone: 'UTC'; instant: string }
  | { precision: 'unknown'; date: null; timezone: null; instant: null };
export interface ClaudeApiGrantObservationV1 {
  v: 1;
  kind: 'claude-api-promotion';
  observationId: string;
  cycleId: string;
  binding: ClaudeApiGrantBinding;
  remainingUsdMicros: string | null;
  totalUsdMicros: string | null;
  capturedAt: string;
  expiry: ClaudeApiGrantExpiry;
  evidenceDigest: string;
}
/** Verified console history with explicitly unknown execution identity. Never financial proof. */
export interface ClaudeApiGrantHistoryObservationV1 extends Omit<ClaudeApiGrantObservationV1, 'kind' | 'binding' | 'cycleId'> {
  kind: 'claude-api-promotion-history';
  binding: null;
  cycleId: null;
}
export type ClaudeApiGrantRecordedObservation = ClaudeApiGrantObservationV1 | ClaudeApiGrantHistoryObservationV1;
/** Only a source-owned reader can supply this; no HTTP/request DTO may become it. */
export interface FreshClaudeApiGrantProof {
  observation: ClaudeApiGrantObservationV1;
  observedAt: string;
  validUntil: string;
  funding: {
    source: 'verified-provider-billing';
    prepaid: boolean;
    invoiced: boolean | null;
    autoReload: 'off' | 'on' | 'unknown';
    purchasedUsdMicros: string | null;
    otherPaidFunding: boolean | null;
  };
  authority: {
    active: boolean;
    stop: boolean;
    localOnly: boolean;
    engineEnabled: boolean;
    repoAuthorized: boolean;
    roleAuthorized: boolean;
    /** Existing signed ceiling. Zero remains a refusal for this metered lane. */
    meteredCeilingUsdMicros: string;
    dailyRemainingUsdMicros: string | null;
    identityDigest: string;
  };
}
export type ReadFreshClaudeApiGrantProof = () => FreshClaudeApiGrantProof | null;
export type ClaudeApiGrantHoldReason =
  | 'proof-missing' | 'proof-invalid' | 'proof-stale' | 'binding-changed'
  | 'funding-unverified' | 'authority-held' | 'expiry-unknown' | 'cutoff-reached'
  | 'balance-unknown' | 'balance-exhausted' | 'daily-limit' | 'store-unavailable'
  | 'store-busy' | 'request-recorded' | 'reservation-invalid' | 'request-not-reserved'
  | 'settlement-invalid' | 'cost-exceeds-reservation' | 'ambiguous-contact';
export interface ClaudeApiGrantView {
  v: 1;
  state: 'recorded' | 'missing' | 'unavailable';
  remainingUsdMicros: string | null;
  totalUsdMicros: string | null;
  capturedAt: string | null;
  expiryDate: string | null;
  admissionCutoff: string | null;
  cutoffPolicy: 'expiry-day-start/v1' | 'verified-instant/v1' | null;
  /** Evidence display does not claim current spendability. */
  automaticAdmission: 'held';
}
/** Opaque in-process capabilities; object contents/serialization are never accepted. */
export interface ClaudeApiGrantAdmission { readonly kind: 'claude-api-admission'; }
export interface ClaudeApiGrantReservation { readonly kind: 'claude-api-reservation'; }
export type ClaudeApiGrantResult<T> = { ok: true; value: T } | { ok: false; reason: ClaudeApiGrantHoldReason };

export interface ClaudeApiGrantReadView {
  v: 1;
  state: 'healthy' | 'missing' | 'unavailable';
  rows: ClaudeApiGrantView[];
}
/** Strict display-only transport validation. This cannot manufacture a spend capability. */
export function narrowClaudeApiGrantReadView(value: unknown): ClaudeApiGrantReadView | null {
  const exact = (row: unknown, keys: string[]): row is Record<string, unknown> => !!row && typeof row === 'object' &&
    !Array.isArray(row) && [Object.prototype, null].includes(Object.getPrototypeOf(row)) &&
    Reflect.ownKeys(row).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(row, key); return !!descriptor && 'value' in descriptor;
    });
  const money = (v: unknown) => v === null || typeof v === 'string' && /^(?:0|[1-9][0-9]{0,39})$/.test(v);
  const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  try {
    if (!exact(value, ['v', 'state', 'rows']) || value.v !== 1 ||
      typeof value.state !== 'string' || !['healthy', 'missing', 'unavailable'].includes(value.state) || !Array.isArray(value.rows) || Object.getPrototypeOf(value.rows) !== Array.prototype ||
      value.rows.length > 4096 || Reflect.ownKeys(value.rows).length !== value.rows.length + 1 ||
      Array.from({ length: value.rows.length }, (_, i) => Object.getOwnPropertyDescriptor(value.rows, String(i))).some(d => !d || !('value' in d)) ||
      value.state !== 'healthy' && value.rows.length !== 0) return null;
    for (const row of value.rows) {
      if (!exact(row, ['v', 'state', 'remainingUsdMicros', 'totalUsdMicros', 'capturedAt', 'expiryDate', 'admissionCutoff', 'cutoffPolicy', 'automaticAdmission']) ||
        row.v !== 1 || row.state !== 'recorded' || row.automaticAdmission !== 'held' || !money(row.remainingUsdMicros) ||
        !money(row.totalUsdMicros) || !iso(row.capturedAt)) return null;
      if (row.remainingUsdMicros !== null && row.totalUsdMicros !== null && BigInt(row.remainingUsdMicros as string) > BigInt(row.totalUsdMicros as string)) return null;
      if (row.expiryDate === null) {
        if (row.admissionCutoff !== null || row.cutoffPolicy !== null) return null;
      } else {
        if (typeof row.expiryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiryDate) || !iso(row.admissionCutoff) ||
          row.admissionCutoff.slice(0, 10) !== row.expiryDate || typeof row.cutoffPolicy !== 'string' || !['expiry-day-start/v1', 'verified-instant/v1'].includes(row.cutoffPolicy) ||
          row.cutoffPolicy === 'expiry-day-start/v1' && row.admissionCutoff !== `${row.expiryDate}T00:00:00.000Z`) return null;
      }
    }
    return value as unknown as ClaudeApiGrantReadView;
  } catch { return null; }
}
