import type { CreditPoolReadView } from '../resources/credit-pool-types.js';
import type { ClaudeApiGrantReadView } from '../resources/claude-api-grant-types.js';

/** Account-bound recorded evidence only; this read cannot spend or refresh providers. */
export interface CreditPoolsReadV1 {
  v: 1;
  state: 'warming' | 'current' | 'stale' | 'unavailable';
  refreshedAt: string | null;
  pools: CreditPoolReadView | null;
}
/** API promotional dollars have their own evidence and never native usage windows. */
export interface CreditPoolsReadV2 extends Omit<CreditPoolsReadV1, 'v'> {
  v: 2;
  apiGrants: ClaudeApiGrantReadView;
}
export type CreditPoolsRead = CreditPoolsReadV1 | CreditPoolsReadV2;
export const CREDIT_POOLS_PATH = '/api/verse/resources/credit-pools';
