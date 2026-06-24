/**
 * fleet/pulse-export.ts — M89: Fleet→Pulse OTLP/HTTP exporter.
 *
 * Reads fleet activity (daemon ticks + inbox proposals) and emits them as
 * OTLP/JSON spans to ashlr-pulse.
 *
 * CONTRACT (Agent 3 ingests exactly this shape):
 *   POST <endpoint>/api/otlp/v1/traces
 *   Authorization: Bearer <ASHLR_PULSE_PAT>
 *   Content-Type: application/json
 *   Body: { resourceSpans: [{ scopeSpans: [{ spans: [ OtlpSpan ] }] }] }
 *
 * Dedup: spanId is derived deterministically from (ref_id + event) via a
 * FNV-1a hash so re-exports produce identical spanIds — ashlr-pulse dedups
 * on (user_id, span_id).
 *
 * Safety:
 *   - NEVER throws; all errors are caught + logged.
 *   - PAT is read from env only; NEVER hardcoded, printed, or logged.
 *   - No-op when PAT is absent (prints a hint once).
 *   - No-op when cfg.pulse?.enabled is false.
 */

import { basename } from 'node:path';
import { loadDaemonState } from '../daemon/state.js';
import { listProposals } from '../inbox/store.js';

// ---------------------------------------------------------------------------
// OTLP span shape (exact contract)
// ---------------------------------------------------------------------------

interface OtlpAttr {
  key: string;
  value: { stringValue: string } | { intValue: number };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
}

export interface OtlpPayload {
  resourceSpans: [{
    scopeSpans: [{
      spans: OtlpSpan[];
    }];
  }];
}

// ---------------------------------------------------------------------------
// Deterministic spanId via FNV-1a (no crypto dep needed — pure arithmetic)
// ---------------------------------------------------------------------------

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h;
}

/**
 * Derive a deterministic 8-byte spanId hex from (refId + event).
 * We run FNV-1a twice with a salt to get 64 bits.
 */
function deriveSpanId(refId: string, event: string): string {
  const key = `${event}:${refId}`;
  const lo = fnv1a32(key);
  const hi = fnv1a32(`hi:${key}`);
  return lo.toString(16).padStart(8, '0') + hi.toString(16).padStart(8, '0');
}

/** Derive a 16-byte traceId hex from the spanId (trace groups all fleet events). */
function deriveTraceId(spanId: string): string {
  const hi = fnv1a32(`trace:${spanId}`);
  return hi.toString(16).padStart(8, '0').repeat(4);
}

// ---------------------------------------------------------------------------
// Attribute builders
// ---------------------------------------------------------------------------

function str(key: string, value: string): OtlpAttr {
  return { key, value: { stringValue: value } };
}

function int(key: string, value: number): OtlpAttr {
  return { key, value: { intValue: Math.round(value) } };
}

// ---------------------------------------------------------------------------
// ISO → nanoseconds string
// ---------------------------------------------------------------------------

function toNano(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(Date.now() * 1_000_000);
  return String(ms * 1_000_000);
}

// ---------------------------------------------------------------------------
// Repo basename helper
// ---------------------------------------------------------------------------

function repoBasename(repo: string | null | undefined): string {
  if (!repo) return '(unscoped)';
  return basename(repo.replace(/\/$/, ''));
}

// ---------------------------------------------------------------------------
// Engine id from engineModel string (e.g. "codex:gpt-5.5" → "codex")
// ---------------------------------------------------------------------------

function engineSystem(engineModel: string | undefined): string {
  if (!engineModel) return 'builtin';
  const part = engineModel.split(':')[0]?.toLowerCase() ?? 'builtin';
  // Normalise to known ids; fall through to raw value for future engines.
  if (['codex', 'claude', 'builtin', 'hermes'].includes(part)) return part;
  return part;
}

// ---------------------------------------------------------------------------
// buildFleetSpans — pure read + shape; returns OTLP payload
// ---------------------------------------------------------------------------

/**
 * Build an OTLP payload from fleet state (daemon ticks + inbox proposals).
 *
 * @param sinceTs  ISO timestamp: only include events at or after this time.
 *                 When omitted, all available history is included.
 * @returns        OTLP/JSON payload object (not stringified).
 */
export function buildFleetSpans(sinceTs?: string): OtlpPayload {
  const sinceCutoff = sinceTs ? Date.parse(sinceTs) : 0;

  const spans: OtlpSpan[] = [];

  // ── Daemon ticks ──────────────────────────────────────────────────────────
  try {
    const state = loadDaemonState();
    for (const tick of state.ticks) {
      const tickMs = Date.parse(tick.ts);
      if (Number.isNaN(tickMs) || tickMs < sinceCutoff) continue;

      const refId = tick.ts;
      const spanId = deriveSpanId(refId, 'fleet.tick');
      const traceId = deriveTraceId(spanId);
      const startNano = toNano(tick.ts);

      const backends = tick.backends
        ? Object.keys(tick.backends).join(',')
        : 'builtin';
      const primaryEngine = tick.backends
        ? (Object.keys(tick.backends)[0] ?? 'builtin')
        : 'builtin';

      spans.push({
        traceId,
        spanId,
        name: 'fleet.tick',
        startTimeUnixNano: startNano,
        endTimeUnixNano: startNano,
        attributes: [
          str('ashlr.source', 'ashlr-fleet'),
          str('gen_ai.system', primaryEngine),
          int('gen_ai.usage.input_tokens', 0),
          int('gen_ai.usage.output_tokens', 0),
          str('ashlr.fleet.event', 'tick'),
          str('ashlr.fleet.repo', backends),
          str('ashlr.fleet.outcome', tick.reason),
          str('ashlr.fleet.cost_usd', tick.spentUsd.toFixed(6)),
          str('ashlr.fleet.ref_id', refId),
        ],
      });

      // Emit a separate fleet.merge span for each auto-merged proposal this tick.
      if (tick.merged && tick.merged > 0) {
        const mergeSpanId = deriveSpanId(refId, 'fleet.merge');
        const mergeTraceId = deriveTraceId(mergeSpanId);
        spans.push({
          traceId: mergeTraceId,
          spanId: mergeSpanId,
          name: 'fleet.merge',
          startTimeUnixNano: startNano,
          endTimeUnixNano: startNano,
          attributes: [
            str('ashlr.source', 'ashlr-fleet'),
            str('gen_ai.system', primaryEngine),
            int('gen_ai.usage.input_tokens', 0),
            int('gen_ai.usage.output_tokens', 0),
            str('ashlr.fleet.event', 'merge'),
            str('ashlr.fleet.repo', backends),
            str('ashlr.fleet.outcome', 'applied'),
            str('ashlr.fleet.cost_usd', '0'),
            str('ashlr.fleet.ref_id', `${refId}:merge`),
          ],
        });
      }
    }
  } catch {
    // Daemon state unavailable — degrade gracefully, no ticks emitted.
  }

  // ── Inbox proposals ───────────────────────────────────────────────────────
  try {
    const proposals = listProposals();
    for (const p of proposals) {
      const createdMs = Date.parse(p.createdAt);
      if (Number.isNaN(createdMs) || createdMs < sinceCutoff) continue;

      // Map proposal status → fleet event name
      const isMerge = p.status === 'applied';
      const isDecline = p.status === 'rejected';
      const event = isMerge ? 'fleet.merge' : isDecline ? 'fleet.decline' : 'fleet.proposal';
      const fleetEvent = isMerge ? 'merge' : isDecline ? 'decline' : 'proposal';

      const outcome =
        p.status === 'applied' ? 'applied'
        : p.status === 'rejected' ? 'rejected'
        : 'pending';

      const spanId = deriveSpanId(p.id, event);
      const traceId = deriveTraceId(spanId);
      const startNano = toNano(p.createdAt);
      const endNano = p.decidedAt ? toNano(p.decidedAt) : startNano;

      spans.push({
        traceId,
        spanId,
        name: event,
        startTimeUnixNano: startNano,
        endTimeUnixNano: endNano,
        attributes: [
          str('ashlr.source', 'ashlr-fleet'),
          str('gen_ai.system', engineSystem(p.engineModel)),
          int('gen_ai.usage.input_tokens', 0),
          int('gen_ai.usage.output_tokens', 0),
          str('ashlr.fleet.event', fleetEvent),
          str('ashlr.fleet.repo', repoBasename(p.repo)),
          str('ashlr.fleet.outcome', outcome),
          str('ashlr.fleet.cost_usd', '0'),
          str('ashlr.fleet.ref_id', p.id),
        ],
      });
    }
  } catch {
    // Inbox unavailable — degrade gracefully, no proposal spans emitted.
  }

  return {
    resourceSpans: [{
      scopeSpans: [{
        spans,
      }],
    }],
  };
}

// ---------------------------------------------------------------------------
// exportToPulse — POST the OTLP payload to ashlr-pulse
// ---------------------------------------------------------------------------

export interface PulseExportCfg {
  pulse?: {
    enabled?: boolean;
    endpoint?: string;
  };
}

/**
 * Build fleet spans (since sinceTs) and POST to ashlr-pulse.
 *
 * - No-op (returns early) when cfg.pulse?.enabled is falsy.
 * - No-op (logs a hint) when ASHLR_PULSE_PAT env var is absent.
 * - NEVER throws.
 * - NEVER logs the PAT value.
 */
export async function exportToPulse(
  cfg: PulseExportCfg,
  opts?: { sinceTs?: string; dryRun?: boolean },
): Promise<void> {
  try {
    if (!cfg.pulse?.enabled) return;

    const pat = process.env['ASHLR_PULSE_PAT'];
    if (!pat) {
      console.log('[ashlr-fleet] pulse export: ASHLR_PULSE_PAT not set — skipping (set it to enable fleet→pulse telemetry)');
      return;
    }

    const endpoint = (cfg.pulse?.endpoint ?? 'http://localhost:3000').replace(/\/$/, '');
    const url = `${endpoint}/api/otlp/v1/traces`;

    const payload = buildFleetSpans(opts?.sinceTs);

    if (opts?.dryRun) {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      return;
    }

    // POST — best-effort; never throws
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pat}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Network errors, unreachable endpoint, etc. — swallow silently.
    // The fleet daemon must never crash due to telemetry.
  }
}
