/** Native account identity for a selected quota reading. Metadata probes never
 * request inference or grant funding; the role's admission owns those checks. */
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { resolveAccountsRoot } from '../verse/seats.js';
import { canonical } from '../universe/artifacts.js';
import { readResourceJson } from '../resources/pool-runtime.js';
import { validateResourceConnectionConfig } from '../resources/connection-monitor.js';
import { readResourceAccountLocalEpoch } from '../resources/account-identity-witness.js';
import { resolveNativeSeatLaunch, type NativeSeatLaunch } from '../resources/native-profile.js';
import { probeCodexResourceAccount } from '../resources/codex-account-probe.js';
import { probeGrokAccount } from '../resources/grok-account-probe.js';

/** The native check and private auth-file epoch are inseparable. A subsequent
 * reconnection invalidates the observation even if the seat ID is unchanged. */
export function roleAccountEpoch(cfg: AshlrConfig, launch: NativeSeatLaunch, accountHint: string): string | null {
  try {
    if (!/^[a-f0-9]{64}$/.test(accountHint)) return null;
    const root = resolveAccountsRoot(cfg);
    const account = validateResourceConnectionConfig(readResourceJson(join(root, 'connections.json'))).accounts
      .find(row => row.id === launch.seatId && row.provider === launch.provider);
    if (!account || canonical(account.command) !== canonical(launch.command) ||
        account.expectedAccountHint !== undefined && account.expectedAccountHint !== accountHint) return null;
    const current = resolveNativeSeatLaunch({ accountsRoot: root, provider: launch.provider, seatId: launch.seatId });
    if (!current.ok || canonical(current.launch) !== canonical(launch)) return null;
    const epoch = readResourceAccountLocalEpoch(root, account);
    return epoch && (epoch.accountDigest === undefined || epoch.accountDigest === accountHint) ? canonical(epoch) : null;
  } catch { return null; }
}

export async function observeRoleAccount(options: {
  cfg: AshlrConfig; launch: NativeSeatLaunch; accountHint: string; cwd: string; signal: AbortSignal; admitted(): boolean;
}): Promise<{ epoch: string | null; uncertain: boolean }> {
  const { cfg, launch, accountHint, cwd, signal, admitted } = options;
  const before = roleAccountEpoch(cfg, launch, accountHint);
  if (!before || signal.aborted || !admitted()) return { epoch: null, uncertain: false };
  let observed = false, uncertain = false;
  if (launch.provider === 'codex') {
    const result = await probeCodexResourceAccount({
      pool: { schemaVersion: 1, id: 'role-account-metadata', workers: [{ id: launch.seatId, provider: 'codex',
        model: 'metadata-only', maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 1, taskWindowMs: 60_000, priority: 1 }] },
      bindings: [{ workerId: launch.seatId, capacityKey: launch.seatId, kind: 'native-cli', command: [...launch.command] }],
      workerId: launch.seatId, bucketIds: ['codex'], expectedAccountHint: accountHint, cwd, signal, timeoutMs: 10_000,
    });
    uncertain = result.status === 'uncertain';
    observed = result.status === 'observed' && result.accountHint === accountHint && result.observation !== null &&
      result.observation.windows.length > 0 && result.observation.windows.every(window =>
        typeof window.usedPercent === 'number' && window.usedPercent < 100);
  } else if (launch.provider === 'grok') {
    const result = await probeGrokAccount({ command: [...launch.command], cwd, signal, timeoutMs: 20_000, expectedAccountHint: accountHint });
    uncertain = result.status === 'uncertain';
    observed = result.status === 'observed' && result.accountHint === accountHint && result.onDemandEnabled === false &&
      result.windows.length > 0 && result.windows.every(window => typeof window.usedPercent === 'number' && window.usedPercent < 100);
  }
  const after = roleAccountEpoch(cfg, launch, accountHint);
  return { epoch: observed && !signal.aborted && admitted() && before === after ? after : null, uncertain };
}
