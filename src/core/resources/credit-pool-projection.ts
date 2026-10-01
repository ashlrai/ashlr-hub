/** Fixed worker-side display read. No provider refresh, enrollment or spending. */
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { accountsLedgerRoot } from '../verse/accounts.js';
import { resolveAccountsRoot } from '../verse/seats.js';
import { validateResourceConnectionConfig } from './connection-monitor.js';
import { readResourceJson } from './pool-runtime.js';
import { RESOURCE_POOL_MANIFEST_MAX_BYTES } from './pool-policy.js';
import { recheckResourceAccountIdentitySnapshot, type ResourceAccountIdentitySnapshot } from './account-identity-witness.js';
import { readResourceHistoricalIdentityWitnesses } from './reading-cache.js';
import { readCreditPoolObservations } from './credit-pool-observations.js';
import type { CreditPoolReadView } from './credit-pool-types.js';

export function readCreditPoolsProjection(cfg: AshlrConfig, snapshots: readonly ResourceAccountIdentitySnapshot[], invalidatedAccountIds: readonly string[], nowMs = Date.now()): CreditPoolReadView {
  const accountsRoot = resolveAccountsRoot(cfg);
  try {
    const config = validateResourceConnectionConfig(readResourceJson(join(accountsRoot, 'connections.json'), RESOURCE_POOL_MANIFEST_MAX_BYTES));
    const invalidated = new Set(invalidatedAccountIds);
    const byId = new Map(snapshots.map(s => [s.witness.accountId, s]));
    const historical = readResourceHistoricalIdentityWitnesses({ root: accountsLedgerRoot(accountsRoot), accountsRoot, accounts: config.accounts, nowMs });
    const past = new Map(historical.map(w => [w.accountId, w]));
    const witnesses = config.accounts.flatMap(account => {
      if (invalidated.has(account.id)) return [];
      const s = byId.get(account.id);
      const w = s ? recheckResourceAccountIdentitySnapshot(accountsRoot, account, s, nowMs) : null;
      const chosen = w ?? past.get(account.id);
      return chosen ? [chosen] : [];
    });
    return readCreditPoolObservations({ root: accountsRoot, currentWitnesses: witnesses, nowMs });
  } catch { return { v: 1, sourceState: 'unavailable', rows: [] }; }
}
