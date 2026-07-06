/**
 * verify-to-green.ts — M331 (completes M140): bounded repair loop that turns
 * a failed verification into a green worktree before a proposal is filed.
 *
 * The loop itself is engine-agnostic: the CALLER supplies `verify` (re-run
 * the completeness gate / test suite) and `repair` (re-invoke the SAME engine
 * inside the SAME confined worktree with the failure tail). sandboxed-engine
 * wires both with its existing containment (contained env + OS sandbox
 * launcher), so a repair run is exactly as jailed as the original run.
 *
 * DEFAULT OFF (cfg.foundry.verifyToGreen.enabled). Bounded by maxIterations
 * (1–5, default 3) and the caller's per-run timeout. Never throws.
 */

import type { AshlrConfig } from '../types.js';

export interface VerifyToGreenCfg {
  enabled?: boolean;
  /** Max repair iterations (clamped 1–5, default 3). */
  maxIterations?: number;
  /** Per repair-run timeout in ms (default 180_000) — enforced by the caller's spawn. */
  perRunTimeoutMs?: number;
  /** Verification-failure tail bytes fed back to the engine (default 8192). */
  failureTailBytes?: number;
}

export interface IterateToGreenResult {
  green: boolean;
  /** Repair iterations actually spent (0 when disabled). */
  iterations: number;
  stopped: 'green' | 'max-iterations' | 'repair-failed' | 'disabled';
  /** The last verification failure text ('' when green). */
  lastFailure: string;
}

export async function iterateToGreen(opts: {
  cfg: AshlrConfig;
  /** The failure text from the initial (pre-loop) verification. */
  initialFailure: string;
  /** Re-run verification against the current worktree state. */
  verify: () => Promise<{ pass: boolean; reason: string }>;
  /**
   * Re-invoke the engine with the failure tail. Return null or {ok:false}
   * when the repair run could not execute — the loop stops (fail-closed:
   * the proposal is simply not filed; nothing is ever force-merged).
   */
  repair: (failureTail: string) => Promise<{ ok: boolean } | null>;
}): Promise<IterateToGreenResult> {
  const v2g = (opts.cfg.foundry?.verifyToGreen ?? {}) as VerifyToGreenCfg;
  if (v2g.enabled !== true) {
    return { green: false, iterations: 0, stopped: 'disabled', lastFailure: opts.initialFailure };
  }
  const maxIter = Math.max(1, Math.min(5, Math.floor(v2g.maxIterations ?? 3)));
  const tailBytes = Math.max(512, Math.min(32_768, Math.floor(v2g.failureTailBytes ?? 8_192)));

  let failure = opts.initialFailure;
  for (let i = 1; i <= maxIter; i++) {
    try {
      const r = await opts.repair(failure.slice(-tailBytes));
      if (!r || !r.ok) {
        return { green: false, iterations: i, stopped: 'repair-failed', lastFailure: failure };
      }
      const v = await opts.verify();
      if (v.pass) return { green: true, iterations: i, stopped: 'green', lastFailure: '' };
      failure = v.reason;
    } catch {
      return { green: false, iterations: i, stopped: 'repair-failed', lastFailure: failure };
    }
  }
  return { green: false, iterations: maxIter, stopped: 'max-iterations', lastFailure: failure };
}
