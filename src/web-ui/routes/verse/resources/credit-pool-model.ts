import { formatDecimalMetric } from '../../../components/charts/format-metric.js';
import { usedPercentText } from '../percent-text.js';
import type { CreditPoolReadView, CreditPoolRowView } from '../../../../core/resources/credit-pool-types.js';
import type { ClaudeApiGrantView } from '../../../../core/resources/claude-api-grant-types.js';

const MAX_BYTES = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function iso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}
function decimal(value: unknown): boolean {
  return value === null || typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
}
function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length > MAX_BYTES / 2) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.every(key => key === 'length' || typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) &&
    Number(key) < value.length && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}

function greater(a: string, b: string): boolean {
  const parts = [a.split('.'), b.split('.')];
  const scale = Math.max(parts[0]![1]?.length ?? 0, parts[1]![1]?.length ?? 0);
  const ints = parts.map(row => BigInt(row[0]! + (row[1] ?? '').padEnd(scale, '0')));
  return ints[0]! > ints[1]!;
}

/** Incompatible or identity-leaking shapes are unavailable, never a zero wallet. */
export function narrowCreditPoolsRead(raw: unknown): CreditPoolReadView | null {
  try {
    if (!object(raw) || !exact(raw, ['v', 'sourceState', 'rows']) || raw.v !== 1 ||
      typeof raw.sourceState !== 'string' || !['healthy', 'missing', 'unavailable'].includes(raw.sourceState) || !dense(raw.rows) ||
      raw.sourceState !== 'healthy' && raw.rows.length !== 0) return null;
    const seen = new Set<string>();
    for (const value of raw.rows) {
      if (!object(value) || !exact(value, ['poolId', 'accountId', 'provider', 'kind', 'amount', 'total', 'unit', 'surface', 'capturedAt',
        'expiresAt', 'expiryKind', 'source', 'identityState', 'evidenceState', 'expiryState']) ||
        typeof value.poolId !== 'string' || !ID.test(value.poolId) || typeof value.accountId !== 'string' || !ID.test(value.accountId) ||
        typeof value.provider !== 'string' || !['claude', 'codex', 'grok'].includes(value.provider) ||
        !decimal(value.amount) || !decimal(value.total) || !iso(value.capturedAt) || !(value.expiresAt === null || iso(value.expiresAt)) ||
        typeof value.expiryKind !== 'string' || !['fixed', 'rolling-release', 'unknown'].includes(value.expiryKind) ||
        (value.expiryKind === 'unknown') !== (value.expiresAt === null) ||
        !object(value.source) || !exact(value.source, ['kind', 'adapter']) ||
        typeof value.identityState !== 'string' || !['matched', 'unknown', 'mismatch'].includes(value.identityState) ||
        typeof value.evidenceState !== 'string' || !['recorded', 'current-native', 'stale-native', 'identity-unknown', 'identity-mismatch'].includes(value.evidenceState) ||
        typeof value.expiryState !== 'string' || !['upcoming', 'expired', 'unknown'].includes(value.expiryState) ||
        (value.expiryState === 'unknown') !== (value.expiresAt === null) ||
        value.amount !== null && value.total !== null && greater(value.amount as string, value.total as string)) return null;
      if (value.identityState !== 'matched' && (value.amount !== null || value.total !== null ||
        value.evidenceState !== (value.identityState === 'unknown' ? 'identity-unknown' : 'identity-mismatch'))) return null;
      if (value.kind === 'gifted-cloud' || value.kind === 'purchased-usage') {
        if (value.provider !== 'claude' || value.unit !== 'USD' || value.source.kind !== 'verified-manual' || value.source.adapter !== 'claude-account-ui' ||
          value.surface !== (value.kind === 'gifted-cloud' ? 'cloud-session' : 'over-plan-usage') || value.expiryKind === 'rolling-release' ||
          value.identityState === 'matched' && value.evidenceState !== 'recorded') return null;
      } else if (value.kind === 'subscription-allowance') {
        const adapter = value.provider === 'claude' ? 'claude-usage' : value.provider === 'codex' ? 'codex-rate-limits' : 'grok-usage';
        if (value.unit !== 'percent' || value.total !== null || value.amount !== null && greater(value.amount as string, '100') || value.surface !== 'subscription' ||
          value.source.kind !== 'native-metadata' || value.source.adapter !== adapter ||
          value.identityState === 'matched' && !['current-native', 'stale-native'].includes(value.evidenceState)) return null;
      } else return null;
      const key = `${value.provider}:${value.accountId}:${value.poolId}`;
      if (seen.has(key)) return null;
      seen.add(key);
    }
    if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_BYTES) return null;
    return raw as unknown as CreditPoolReadView;
  } catch { return null; }
}

export interface CreditPoolDisplay {
  title: string;
  amountText: string;
  sourceText: string;
  capturedAt: string;
  expiryText: string;
  expiresAt: string | null;
  scopeText: string;
}

/** Exact integer conversion; display rounding never alters reserved dollars. */
export function apiGrantUsdDecimal(micros: string): string {
  const padded = micros.padStart(7, '0');
  return `${padded.slice(0, -6)}.${padded.slice(-6)}`;
}

export function apiGrantDisplay(row: ClaudeApiGrantView): { amountText: string; expiryText: string } {
  return {
    amountText: row.remainingUsdMicros === null ? 'API promotional balance unknown'
      : `$${formatDecimalMetric(apiGrantUsdDecimal(row.remainingUsdMicros))} last recorded`,
    expiryText: row.expiryDate === null ? 'API credit expiry unknown'
      : `Expires ${row.expiryDate} UTC`,
  };
}
/** Display only: no dollar conversion, allowance inference, admission or spend-down priority. */
export function creditPoolDisplay(row: CreditPoolRowView, nowMs: number): CreditPoolDisplay {
  const title = row.kind === 'gifted-cloud' ? 'Cloud gift' : row.kind === 'purchased-usage' ? 'Purchased usage credits' : 'Subscription window';
  const historical = row.evidenceState !== 'current-native' || row.expiresAt !== null && Date.parse(row.expiresAt) <= nowMs;
  const amountText = row.identityState === 'unknown' ? 'Balance hidden · account not verified'
    : row.identityState === 'mismatch' ? 'Balance hidden · account changed'
      : row.amount === null ? row.kind === 'subscription-allowance' ? 'Usage unknown' : 'Balance unknown'
        : row.unit === 'USD' ? `$${formatDecimalMetric(row.amount)} last recorded` : `${usedPercentText(/^100(?:\.0+)?$/u.test(row.amount) ? 100 : Math.min(99.999, Number(row.amount)))} used${historical ? ' · last recorded' : ''}`;
  return { title, amountText, capturedAt: row.capturedAt, expiresAt: row.expiresAt,
    sourceText: row.source.kind === 'verified-manual' ? 'Verified account UI capture · historical reading' : historical ? 'Native metadata · historical reading' : 'Native metadata · last reading',
    expiryText: row.expiresAt === null ? 'Expiry unknown' : Date.parse(row.expiresAt) <= nowMs ? 'Recorded deadline has passed'
      : row.expiryKind === 'rolling-release' ? 'Rolling release, not credit expiry' : row.kind === 'subscription-allowance' ? 'Recorded subscription reset' : 'Verified credit expiry',
    scopeText: row.kind === 'gifted-cloud' ? 'Claude cloud sessions only; excludes Projects and Routines.'
      : row.kind === 'purchased-usage' ? 'Usage beyond your plan; separate from cloud gifts.' : 'Subscription usage; separate from dollar credits.' };
}
