import type { CreditPoolReadView } from '../resources/credit-pool-types.js';

/** Account-bound recorded evidence only; this read cannot spend or refresh providers. */
export interface CreditPoolsRead {
  v: 1;
  state: 'warming' | 'current' | 'stale' | 'unavailable';
  refreshedAt: string | null;
  pools: CreditPoolReadView | null;
}
export const CREDIT_POOLS_PATH = '/api/verse/resources/credit-pools';
