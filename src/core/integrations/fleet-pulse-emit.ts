/**
 * core/integrations/fleet-pulse-emit.ts — M214: live fleet dashboard emit.
 *
 * Fire-and-forget GenAI-OTel span emitter for fleet daemon events (proposal
 * created, merge, judge verdict, tick cost) to the Pulse OTLP ingest.
 *
 * DESIGN CONSTRAINTS (non-negotiable):
 *  - NEVER throws from any exported function. Telemetry must never crash the fleet.
 *  - Flag-gated: cfg.foundry?.pulseEmit (default OFF). A complete no-op when
 *    the flag is absent or falsy. The daemon/merge control flow is NEVER altered.
 *  - ADDITIVE ONLY: this module only observes; it never mutates daemon state.
 *  - Fire-and-forget: callers use void / .catch(() => {}) — no await in hot paths.
 *  - METADATA ONLY: spans carry ids, counts, outcomes, engine labels, costs —
 *    never prompts, completions, code, file contents, or diffs.
 *  - Endpoint: cfg.comms?.pulseOtlpUrl (first) OR PULSE_OTLP_URL env OR
 *    cfg.pulse?.endpoint (existing M89 key, reused for compat) OR localhost:3000.
 *  - Reuses pulse-exporter's FleetSpanInput / exportFleetEvents entirely —
 *    this module is a thin gated facade over what already exists.
 *
 * SAFE OBSERVATION POINTS (where hooks are placed):
 *  1. proposal created  — after daemon:proposal-created audit log in loop.ts
 *  2. merge             — next to M212 notifyFleetEvent('merge', …) in automerge-pass.ts
 *  3. judge verdict     — next to out.judged++ in automerge-pass.ts
 *  4. tick cost         — next to runPulseSync lazy-import in loop.ts
 *
 * All four hooks are single fire-and-forget lines: void emitXxx(…).catch(() => {})
 */

import type { AshlrConfig } from '../types.js';
import {
  exportFleetEvents,
  type FleetSpanInput,
  type ExportResult,
} from './pulse-exporter.js';
import type { OutwardMutationFence } from '../sandbox/mutation-fence.js';

// ---------------------------------------------------------------------------
// Internal config bridge
// ---------------------------------------------------------------------------

/** Env var for the dedicated M214 OTLP endpoint. Falls back to M89 vars. */
const PULSE_OTLP_URL_ENV = 'PULSE_OTLP_URL';

/** Is the M214 fleet-pulse emit enabled for this config? */
export function fleetPulseEnabled(cfg: AshlrConfig): boolean {
  // Primary gate: foundry.pulseEmit must be explicitly true.
  return (cfg.foundry as Record<string, unknown> | undefined)?.['pulseEmit'] === true;
}

/**
 * Resolve the OTLP endpoint for M214 emit.
 * Priority: cfg.comms?.pulseOtlpUrl → PULSE_OTLP_URL env → cfg.pulse?.endpoint → localhost:3000.
 */
function resolveOtlpEndpoint(cfg: AshlrConfig): string {
  const fromComms = (cfg.comms as Record<string, unknown> | undefined)?.['pulseOtlpUrl'];
  if (typeof fromComms === 'string' && fromComms.length > 0) return fromComms;
  const fromEnv = process.env[PULSE_OTLP_URL_ENV];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const fromPulse = cfg.pulse?.endpoint;
  if (fromPulse && fromPulse.length > 0) return fromPulse;
  return 'http://localhost:3000';
}

/** Build the PulseExporterConfig the M89 exporter expects. */
function exporterCfg(cfg: AshlrConfig): import('./pulse-exporter.js').PulseExporterConfig {
  return {
    pulse: { enabled: true, endpoint: resolveOtlpEndpoint(cfg) },
    ...(cfg.user ? { user: { id: cfg.user.id, name: cfg.user.name } } : {}),
  };
}

/** Resolve PAT for the emit (same env chain as pulse-sync). */
function resolveEmitPat(): string | undefined {
  const pat =
    process.env['PULSE_FLEET_PAT'] ??
    process.env['ASHLR_PULSE_READ_PAT'] ??
    process.env['ASHLR_PULSE_PAT'];
  return pat && pat.length > 0 ? pat : undefined;
}

// ---------------------------------------------------------------------------
// Core fire-and-forget emitter (internal)
// ---------------------------------------------------------------------------

/**
 * Emit a single fleet event span. Returns ExportResult (never throws).
 * Callers should call this fire-and-forget: void emitFleetPulseSpan(…).catch(() => {})
 */
async function emitFleetPulseSpan(
  cfg: AshlrConfig,
  event: FleetSpanInput,
  authority?: OutwardMutationFence,
): Promise<ExportResult> {
  if (!fleetPulseEnabled(cfg)) {
    return { ok: false, skipped: true, status: null, spanCount: 0, detail: 'fleet-pulse emit disabled (cfg.foundry.pulseEmit is falsy)' };
  }
  try {
    const pat = resolveEmitPat();
    return await exportFleetEvents(exporterCfg(cfg), [event], {
      ...(pat ? { pat } : {}),
      ...(authority ? { authority } : {}),
    });
  } catch {
    return { ok: false, skipped: false, status: null, spanCount: 1, detail: 'fleet-pulse: unexpected error' };
  }
}

// ---------------------------------------------------------------------------
// Public: typed event emitters — one per observation point
// ---------------------------------------------------------------------------

/**
 * Emit a 'proposal' span when the daemon creates a new PENDING proposal.
 * Call fire-and-forget next to daemon:proposal-created audit. NEVER throws.
 *
 * @param refId    proposal id or a stable fallback (e.g. item.id + tick ts)
 * @param outcome  free-form label: 'pending' | 'empty' | 'best-of-n-empty' …
 * @param repo     repo path / full name (metadata only)
 * @param engine   engine label ('claude' | 'builtin' | tier string)
 */
export async function emitProposalCreated(
  cfg: AshlrConfig,
  refId: string,
  outcome: string,
  repo?: string | null,
  engine?: string | null,
): Promise<ExportResult> {
  return emitFleetPulseSpan(cfg, {
    event: 'proposal',
    refId,
    outcome,
    ...(repo ? { repo } : {}),
    ...(engine ? { engine } : {}),
  });
}

/**
 * Emit a 'merge' span when the M47 gate auto-merges a proposal.
 * Call fire-and-forget next to M212 notifyFleetEvent('merge', …). NEVER throws.
 *
 * @param proposalId  the merged proposal's id
 * @param repo        repo path / full name (metadata only)
 * @param engine      engine tier ('frontier' | 'mid' | …)
 */
export async function emitMerge(
  cfg: AshlrConfig,
  proposalId: string,
  repo?: string | null,
  engine?: string | null,
  opts?: { authority?: OutwardMutationFence },
): Promise<ExportResult> {
  return emitFleetPulseSpan(cfg, {
    event: 'merge',
    refId: proposalId,
    outcome: 'merged',
    ...(repo ? { repo } : {}),
    ...(engine ? { engine } : {}),
  }, opts?.authority);
}

/**
 * Emit a 'decline' span for a judge verdict that is NOT 'ship'
 * (verdict ∈ 'review' | 'noise' | 'harmful'). Also covers judge-unavailable
 * (emit a 'decline' with outcome 'judge-unavailable').
 * Call fire-and-forget next to out.judged++ in automerge-pass. NEVER throws.
 *
 * @param proposalId  the judged proposal's id
 * @param verdict     the judge's verdict string
 * @param repo        repo path / full name (metadata only)
 * @param engine      engine tier / label
 */
export async function emitJudgeVerdict(
  cfg: AshlrConfig,
  proposalId: string,
  verdict: string,
  repo?: string | null,
  engine?: string | null,
  opts?: { authority?: OutwardMutationFence },
): Promise<ExportResult> {
  // 'ship' verdicts are covered by emitMerge when the merge actually fires.
  // Here we emit a span for every verdict so the Pulse dashboard has full coverage.
  const event = verdict === 'ship' ? 'proposal' : 'decline';
  return emitFleetPulseSpan(cfg, {
    event,
    refId: proposalId,
    outcome: `judge:${verdict}`,
    ...(repo ? { repo } : {}),
    ...(engine ? { engine } : {}),
  }, opts?.authority);
}

/**
 * Emit a 'tick' span with cost metadata for the daemon tick summary.
 * Call fire-and-forget next to the runPulseSync lazy-import in loop.ts. NEVER throws.
 *
 * @param tickTs      ISO ts of this tick (used as dedup refId)
 * @param spentUsd    total USD spent this tick (metadata attribute)
 * @param proposals   number of proposals created this tick
 * @param merged      number of merges this tick
 */
export async function emitTickCost(
  cfg: AshlrConfig,
  tickTs: string,
  spentUsd: number,
  proposals: number,
  merged: number,
): Promise<ExportResult> {
  // Encode cost + counts in the outcome string (METADATA ONLY — no code/diffs).
  const outcome = `tick:proposals=${proposals},merged=${merged},cost=${spentUsd.toFixed(6)}`;
  return emitFleetPulseSpan(cfg, {
    event: 'tick',
    refId: tickTs,
    outcome,
    startTs: tickTs,
    endTs: tickTs,
  });
}
