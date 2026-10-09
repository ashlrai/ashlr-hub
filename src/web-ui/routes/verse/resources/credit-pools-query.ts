/** Shared recorded-credit query: no drawer component, CSS or rendering hooks. */
import { optionalQuery } from '../command/surface-data.js';
import { CREDIT_POOLS_PATH, type CreditPoolsRead } from '../../../../core/verse/credit-pools-api-types.js';
import { narrowClaudeApiGrantReadView } from '../../../../core/resources/claude-api-grant-types.js';
import { narrowCreditPoolsRead } from './credit-pool-model.js';

/** A read cannot promote captured balances into current native availability. */
export function narrowCreditPoolsEnvelope(raw: unknown): CreditPoolsRead | null {
  try {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    ![4, 5].includes(Reflect.ownKeys(raw).length) || !['v', 'state', 'refreshedAt', 'pools'].every(key =>
      Object.hasOwn(raw, key) && 'value' in Object.getOwnPropertyDescriptor(raw, key)!)) return null;
  const row = raw as Record<string, unknown>;
  if (!(row.v === 1 && Reflect.ownKeys(raw).length === 4 || row.v === 2 && Reflect.ownKeys(raw).length === 5 &&
    Object.hasOwn(row, 'apiGrants') && 'value' in Object.getOwnPropertyDescriptor(row, 'apiGrants')! && narrowClaudeApiGrantReadView(row.apiGrants)) ||
    typeof row.state !== 'string' || !['warming', 'current', 'stale', 'unavailable'].includes(row.state) ||
    row.refreshedAt !== null && (typeof row.refreshedAt !== 'string' || !Number.isFinite(Date.parse(row.refreshedAt)) ||
      new Date(row.refreshedAt).toISOString() !== row.refreshedAt)) return null;
  if (row.pools === null) return ['warming', 'unavailable'].includes(row.state) ? raw as CreditPoolsRead : null;
  return ['current', 'stale'].includes(row.state) && narrowCreditPoolsRead(row.pools) !== null ? raw as CreditPoolsRead : null;
  } catch { return null; }
}
export const creditPoolsQuery = optionalQuery('verse-credit-pools', CREDIT_POOLS_PATH, 'Recorded credit balances', narrowCreditPoolsEnvelope);
