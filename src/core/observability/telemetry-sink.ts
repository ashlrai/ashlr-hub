/**
 * core/observability/telemetry-sink.ts — M19 telemetry sink seam.
 *
 * Two implementations:
 *   LocalFileSink  — default (no endpoint / no PAT). Appends spans as JSONL
 *                    to a daily file under ~/.ashlr/telemetry/. What `ashlr
 *                    pulse` already aggregates locally.
 *   OtlpHttpSink   — opt-in, only when cfg.telemetry.pulse AND a PAT are
 *                    both present. Builds an OTLP/HTTP-JSON trace and POSTs
 *                    it to the configured endpoint. Fire-and-forget, bounded
 *                    timeout, never throws/blocks.
 *
 * GUARDRAILS:
 *   - PRIVACY: JSONL records and span attributes are METADATA ONLY (model,
 *     token counts, cost, ids, provider, tier, status, duration). NEVER
 *     prompt/response text, tool args, file contents, or secrets.
 *   - PAT/SECRET SAFETY: PAT lives ONLY in the Authorization header. It is
 *     NEVER logged, printed, returned, placed in span attrs or `detail`, or
 *     committed. Source: existing ASHLR_PULSE_TOKEN env var. Vault transport is unsupported.
 *   - All emits are best-effort: ok:false is logged to stderr only and NEVER
 *     blocks or propagates out of a run/swarm.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolveProviderKey } from '../integrations/secrets.js';
import type { AshlrConfig, GenAiSpan, TelemetryEmitResult } from '../types.js';
import { buildGenAiTrace } from './otlp.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fetch timeout for OTLP POST — bounded, never blocks a run. Kept short
 * (this is a fire-and-forget metadata POST); a dead/slow-but-reachable
 * endpoint must not add meaningful wall-clock latency to run/swarm completion.
 */
const OTLP_FETCH_TIMEOUT_MS = 3_000;
// ---------------------------------------------------------------------------
// Public: localTelemetryDir
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the local telemetry directory:
 * ~/.ashlr/telemetry
 *
 * Re-resolves homedir() at call time so a relocated HOME in tests is honored.
 */
export function localTelemetryDir(): string {
  return join(homedir(), '.ashlr', 'telemetry');
}

// ---------------------------------------------------------------------------
// Public: patAvailable
// ---------------------------------------------------------------------------

/**
 * Current OTLP readiness requires a valid existing environment PAT.
 * Vault-name presence does not qualify a parent-process request transport.
 * The second parameter is retained for public API compatibility; no probe runs.
 */
export function patAvailable(cfg: AshlrConfig, _allowPhantomProbe = true): boolean {
  return resolveProviderKey('ASHLR_PULSE_TOKEN', cfg) !== undefined;
}

// ---------------------------------------------------------------------------
// Public: TelemetrySink interface
// ---------------------------------------------------------------------------

export interface TelemetrySink {
  emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult>;
}

// ---------------------------------------------------------------------------
// Public: getSink
// ---------------------------------------------------------------------------

/**
 * Returns the appropriate TelemetrySink for the given config:
 *   - OtlpHttpSink when cfg.telemetry.pulse is set AND a PAT is available.
 *   - LocalFileSink (default, 100% local) otherwise.
 *
 * The existing probe-off emit path selects OTLP for a configured endpoint;
 * absent credentials produce an unavailable result. Other callers select local
 * storage unless the existing environment credential is currently usable.
 */
export function getSink(cfg: AshlrConfig, allowPhantomProbe = true): TelemetrySink {
  if (cfg.telemetry?.pulse) {
    // On the emit path (probe off): select OTLP whenever an endpoint is set and
    // let OtlpHttpSink resolve the PAT async; if none, emit() is a logged no-op.
    if (!allowPhantomProbe) return new OtlpHttpSink(cfg);
    // CLI path: use current environment availability; no vault subprocess.
    if (patAvailable(cfg, true)) return new OtlpHttpSink(cfg);
  }
  return new LocalFileSink();
}

// ---------------------------------------------------------------------------
// LocalFileSink — default, 100% local
// ---------------------------------------------------------------------------

/**
 * Appends spans as JSONL to a daily file under ~/.ashlr/telemetry/.
 * File name: telemetry-YYYY-MM-DD.jsonl
 * Each line is a single JSON object containing one span (metadata only).
 * What `ashlr pulse` already aggregates locally.
 */
class LocalFileSink implements TelemetrySink {
  async emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult> {
    if (spans.length === 0) {
      return { sink: 'local', ok: true, detail: 'no spans' };
    }
    try {
      const dir = localTelemetryDir();
      mkdirSync(dir, { recursive: true });

      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const filePath = join(dir, `telemetry-${date}.jsonl`);

      const lines = spans.map((span) => JSON.stringify(span)).join('\n') + '\n';
      appendFileSync(filePath, lines, 'utf8');

      return { sink: 'local', ok: true, detail: `appended ${spans.length} span(s) to ${filePath}` };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashlr telemetry] LocalFileSink error: ${detail}\n`);
      return { sink: 'local', ok: false, detail };
    }
  }
}

// ---------------------------------------------------------------------------
// OtlpHttpSink — opt-in, endpoint + PAT required
// ---------------------------------------------------------------------------

/**
 * Builds an OTLP/HTTP-JSON trace payload from the spans and POSTs it to
 * cfg.telemetry.pulse. Uses a bounded fetch timeout (fire-and-forget).
 * PAT sourced from the existing ASHLR_PULSE_TOKEN environment route — placed
 * ONLY in the Authorization header, never logged or returned.
 */
class OtlpHttpSink implements TelemetrySink {
  constructor(private readonly cfg: AshlrConfig) {}

  async emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult> {
    const endpoint = this.cfg.telemetry?.pulse;
    if (!endpoint) {
      return { sink: 'otlp', ok: false, detail: 'no endpoint configured' };
    }

    // Resolve the existing environment credential without subprocesses.
    const pat = await resolvePatAsync(this.cfg);
    if (!pat) {
      return { sink: 'otlp', ok: false, detail: 'PAT unavailable' };
    }

    if (spans.length === 0) {
      return { sink: 'otlp', ok: true, detail: 'no spans' };
    }

    try {
      const body = JSON.stringify(buildGenAiTrace(spans));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OTLP_FETCH_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // PAT only in the Authorization header — never logged, never in detail.
            Authorization: `Bearer ${pat}`,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        return { sink: 'otlp', ok: true, detail: `HTTP ${res.status}` };
      }

      const detail = `HTTP ${res.status}`;
      process.stderr.write(`[ashlr telemetry] OtlpHttpSink: ${detail}\n`);
      return { sink: 'otlp', ok: false, detail };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const detail = isAbort ? 'request timed out' : err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashlr telemetry] OtlpHttpSink error: ${detail}\n`);
      return { sink: 'otlp', ok: false, detail };
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Existing environment-only PAT. Never consume exec banners/placeholders. */
async function resolvePatAsync(cfg: AshlrConfig): Promise<string | null> {
  return resolveProviderKey('ASHLR_PULSE_TOKEN', cfg) ?? null;
}
