/**
 * gateway-shadow.ts — M334 stage 1: observe-only comparison of the M247
 * InferenceGateway against the live legacy routing path.
 *
 * When cfg.foundry.fabric.gatewayShadow is true (and fabric.gateway is off),
 * the daemon runs gateway.decide() BESIDE the legacy path for each dispatched
 * item and appends a comparison record here. THE LEGACY RESULT ALWAYS WINS —
 * shadow mode never changes a routing decision.
 *
 * divergenceStats() is the stage-2 exit-criteria instrument
 * (docs/contracts/CONTRACT-M334.md): flip fabric.gateway on only after ≥200
 * shadowed decisions with <2% divergence and ZERO safety-relevant
 * divergences (gateway-would-dispatch where legacy blocked).
 *
 * Append-only (~/.ashlr/fabric/gateway-shadow.jsonl per day); never throws.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';

export interface GatewayShadowRecord {
  ts: string;
  workItemId?: string;
  source?: string;
  /** What the LIVE legacy path decided (this is what actually ran). */
  legacy: { backend: string; tier: string | null; model?: string | null; dispatched: boolean };
  /** What the gateway WOULD have decided (observe-only). */
  gateway: { backend: string; tier: string | null; model?: string | null; wouldDispatch: boolean };
  diverged: boolean;
  /**
   * SAFETY-RELEVANT divergence: the gateway would have dispatched an item the
   * legacy path blocked (throttle/budget/resource). Any occurrence blocks the
   * stage-3 default flip.
   */
  safetyRelevant: boolean;
}

export function gatewayShadowDir(): string {
  return join(homedir(), '.ashlr', 'fabric');
}

function shadowFile(day: string): string {
  return join(gatewayShadowDir(), `gateway-shadow-${day}.jsonl`);
}

/** Compare a legacy decision with the gateway's would-be decision. PURE. */
export function compareDecisions(
  legacy: GatewayShadowRecord['legacy'],
  gateway: GatewayShadowRecord['gateway'],
): { diverged: boolean; safetyRelevant: boolean } {
  const diverged =
    legacy.backend !== gateway.backend ||
    (legacy.model ?? null) !== (gateway.model ?? null) ||
    legacy.dispatched !== gateway.wouldDispatch;
  const safetyRelevant = gateway.wouldDispatch && !legacy.dispatched;
  return { diverged, safetyRelevant };
}

/** Append one shadow record. Never throws. */
export function recordGatewayShadow(rec: GatewayShadowRecord): void {
  try {
    const dir = gatewayShadowDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const day = rec.ts.slice(0, 10) || new Date().toISOString().slice(0, 10);
    appendFileSync(shadowFile(day), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // shadow telemetry is best-effort — never affects a dispatch
  }
}

/** Read shadow records (newest file first). Never throws. */
export function readGatewayShadow(opts?: { sinceMs?: number; limit?: number }): GatewayShadowRecord[] {
  try {
    const dir = gatewayShadowDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('gateway-shadow-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
    const out: GatewayShadowRecord[] = [];
    const cap = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : Infinity;
    for (const file of files) {
      if (out.length >= cap) break;
      let raw: string;
      try {
        raw = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n').reverse()) {
        if (out.length >= cap) break;
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (typeof parsed['ts'] !== 'string' || typeof parsed['diverged'] !== 'boolean') continue;
          if (opts?.sinceMs !== undefined && Date.parse(parsed['ts']) < opts.sinceMs) continue;
          out.push(parsed as unknown as GatewayShadowRecord);
        } catch {
          // skip malformed line
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface GatewayShadowStats {
  decisions: number;
  divergences: number;
  divergenceRate: number;
  safetyRelevant: number;
  /** The stage-2 exit criteria, evaluated live. */
  readyToFlip: boolean;
}

/** Evaluate the CONTRACT-M334 stage-2 exit criteria. Never throws. */
export function divergenceStats(opts?: { sinceMs?: number }): GatewayShadowStats {
  const records = readGatewayShadow(opts);
  const decisions = records.length;
  const divergences = records.filter((r) => r.diverged).length;
  const safetyRelevant = records.filter((r) => r.safetyRelevant).length;
  const divergenceRate = decisions > 0 ? divergences / decisions : 0;
  return {
    decisions,
    divergences,
    divergenceRate,
    safetyRelevant,
    readyToFlip: decisions >= 200 && divergenceRate < 0.02 && safetyRelevant === 0,
  };
}
