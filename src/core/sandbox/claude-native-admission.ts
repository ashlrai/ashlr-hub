/** Host-owned native observation. This module never reads a provider credential. */
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { resolveAccountsRoot } from '../verse/seats.js';
import { readResourceJson } from '../resources/pool-runtime.js';
import { validateResourceConnectionConfig } from '../resources/connection-monitor.js';
import { readResourceAccountLocalEpoch, resourceAccountProfileDigest } from '../resources/account-identity-witness.js';
import { resolveNativeSeatLaunch, type NativeSeatLaunch } from '../resources/native-profile.js';
import { probeClaudeAccountUsage, type ClaudeAccountUsageResult } from '../resources/claude-account-usage.js';
import { canonical, digest } from '../universe/artifacts.js';
import type { ClaudeBrokerObservation } from './claude-native-broker.js';

export interface ClaudeNativeBinding {
  launch: NativeSeatLaunch;
  profileDigest: string;
  epochDigest: string;
  localAccountDigest: string | null;
  expectedAccountDigest: string | null;
}
/** The auth status command, not this metadata, establishes the native principal.
 * File epochs fence replacement of the exact launch/profile during an invocation. */
export function readClaudeNativeBinding(cfg: AshlrConfig, seatId: string): ClaudeNativeBinding | null {
  try {
    const accountsRoot = resolveAccountsRoot(cfg);
    const account = validateResourceConnectionConfig(readResourceJson(join(accountsRoot, 'connections.json')))
      .accounts.find(row => row.id === seatId && row.provider === 'claude');
    const found = resolveNativeSeatLaunch({ accountsRoot, provider: 'claude', seatId, requireClaudeBrokerSafety: true });
    if (!account || !found.ok || canonical(account.command) !== canonical(found.launch.command)) return null;
    const paths = [found.launch.command[0], found.launch.command[1], found.launch.executable,
      join(dirname(found.launch.command[1]), 'profile.json')];
    const stamps = paths.map(path => {
      const s = lstatSync(path, { bigint: true });
      if (!s.isFile() || s.isSymbolicLink()) throw new Error();
      return [path, ...[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String)];
    });
    const local = readResourceAccountLocalEpoch(accountsRoot, account);
    // Keychain-native authentication can have no local OAuth account file.
    // An existing but unreadable/unsafe metadata file must never be ignored.
    if (!local) {
      try { lstatSync(join(found.launch.nativeStatePath, '.claude.json')); return null; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    }
    return { launch: found.launch, profileDigest: resourceAccountProfileDigest(account),
      // Mutable account-display cache stat is not a credential identity.
      // Native before/after auth + current usage below owns that proof.
      epochDigest: digest(canonical(['claude-native-launch-epoch-v1', stamps])),
      localAccountDigest: local?.accountDigest ?? null, expectedAccountDigest: account.expectedAccountHint ?? null };
  } catch { return null; }
}
export function sameClaudeNativeBinding(a: ClaudeNativeBinding, b: ClaudeNativeBinding): boolean {
  return a.profileDigest === b.profileDigest && a.epochDigest === b.epochDigest &&
    canonical(a.launch) === canonical(b.launch) && (a.localAccountDigest === null || b.localAccountDigest === null || a.localAccountDigest === b.localAccountDigest) && a.expectedAccountDigest === b.expectedAccountDigest;
}
export function claudeNativeObservation(binding: ClaudeNativeBinding, report: ClaudeAccountUsageResult,
  runId: string, model: string, nowMs = Date.now()): ClaudeBrokerObservation | null {
  const at = Date.parse(report.startedAt);
  if (report.status !== 'observed' || report.loggedIn !== true || report.authMethod !== 'claude.ai' ||
    report.quotaFresh !== true || report.extraUsageEnabled !== false || !report.accountHint ||
    !/^[a-f0-9]{64}$/.test(report.accountHint) || binding.expectedAccountDigest !== null && binding.expectedAccountDigest !== report.accountHint || binding.localAccountDigest !== null && binding.localAccountDigest !== report.accountHint ||
    !Number.isSafeInteger(at) || at > nowMs || at + 60_000 <= nowMs) return null;
  return { runId, model, seatId: binding.launch.seatId, accountDigest: report.accountHint,
    profileDigest: binding.profileDigest, epochDigest: binding.epochDigest,
    observedAtMs: at, expiresAtMs: at + 60_000, authMethod: 'claude.ai', extraUsageEnabled: false };
}
/** Metadata-only exact profile calls; default source cannot be supplied by a model. */
export async function observeClaudeNativeBinding(cfg: AshlrConfig, seatId: string, runId: string, model: string,
  cwd: string, signal: AbortSignal, admitted: () => boolean): Promise<{binding: ClaudeNativeBinding; observation: ClaudeBrokerObservation} | null> {
  if (signal.aborted || !admitted()) return null;
  const before = readClaudeNativeBinding(cfg, seatId);
  if (!before) return null;
  const report = await probeClaudeAccountUsage({ command: [...before.launch.command], cwd, timeoutMs: 20_000, signal });
  const after = readClaudeNativeBinding(cfg, seatId);
  if (signal.aborted || !admitted() || !after || !sameClaudeNativeBinding(before, after)) return null;
  if (!claudeNativeObservation(before, report, runId, model)) return null;
  const observation = claudeNativeObservation(after, report, runId, model);
  return observation ? { binding: after, observation } : null;
}
