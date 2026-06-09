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
 *     committed. Source: phantom (preferred) or ASHLR_PULSE_TOKEN env var.
 *   - All emits are best-effort: ok:false is logged to stderr only and NEVER
 *     blocks or propagates out of a run/swarm.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import type { AshlrConfig, GenAiSpan, TelemetryEmitResult } from '../types.js';
import { buildGenAiTrace } from './otlp.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHANTOM_BIN = 'phantom';
const PHANTOM_TIMEOUT_MS = 5_000;
/**
 * Fetch timeout for OTLP POST — bounded, never blocks a run. Kept short
 * (this is a fire-and-forget metadata POST); a dead/slow-but-reachable
 * endpoint must not add meaningful wall-clock latency to run/swarm completion.
 */
const OTLP_FETCH_TIMEOUT_MS = 3_000;
/**
 * Bounded budget for resolving the PAT via phantom on the emit hot path.
 * Uses async spawn (NOT spawnSync) so the Node event loop is never frozen.
 */
const PHANTOM_RESOLVE_TIMEOUT_MS = 3_000;
/** Secret name phantom stores for the Pulse PAT. */
const PHANTOM_PAT_KEY = 'ASHLR_PULSE_TOKEN';

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
 * Returns true when a Pulse PAT is discoverable — either via the
 * ASHLR_PULSE_TOKEN environment variable or via phantom (when installed,
 * initialized, and the key is present in the vault).
 *
 * NEVER reads, returns, or logs the PAT value — boolean only.
 *
 * `allowPhantomProbe` (default true) controls the blocking spawnSync phantom
 * probe. The doctor / `ashlr telemetry status` callers want the full probe
 * (they are NOT on a run's completion path). The emit hot path
 * (getSink -> patAvailable) MUST pass `false`: the spawnSync probe freezes the
 * event loop for up to ~10s (2x5s) and is redundant there — OtlpHttpSink.emit
 * resolves the PAT itself via the async, bounded resolvePatAsync. With the
 * probe off, patAvailable is a pure env-var check (no blocking).
 */
export function patAvailable(cfg: AshlrConfig, allowPhantomProbe = true): boolean {
  // 1. Env var check — existence only, never the value.
  if (process.env['ASHLR_PULSE_TOKEN'] !== undefined && process.env['ASHLR_PULSE_TOKEN'] !== '') {
    return true;
  }

  // 2. Phantom check — only when phantom integration is enabled in cfg AND the
  //    caller opted into the blocking probe (never on the emit hot path).
  if (!allowPhantomProbe) return false;
  if (!cfg.phantom?.enabled) return false;

  try {
    // Quick binary check.
    const versionResult = spawnSync(PHANTOM_BIN, ['--version'], {
      encoding: 'utf8',
      timeout: PHANTOM_TIMEOUT_MS,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });
    if (versionResult.error || versionResult.status !== 0) return false;

    // List secret names only — never values.
    const listResult = spawnSync(PHANTOM_BIN, ['list', '--json'], {
      encoding: 'utf8',
      timeout: PHANTOM_TIMEOUT_MS,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });
    if (listResult.error || listResult.status !== 0) return false;

    const raw = (listResult.stdout ?? '').trim();
    if (!raw) return false;

    // Parse names only — same conservative extraction as phantom.ts.
    const names = extractSecretNames(raw);
    return names.includes(PHANTOM_PAT_KEY);
  } catch {
    return false;
  }
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
 * `allowPhantomProbe` (default true) is forwarded to patAvailable. On the
 * emit hot path (orchestrator/swarm completion) callers MUST pass `false` so
 * the selection never runs a blocking spawnSync phantom probe: when an
 * endpoint is configured we hand off to OtlpHttpSink, which resolves the PAT
 * asynchronously with a bounded timeout (and degrades to a logged
 * 'PAT unavailable' no-op if none is found) — never freezing the event loop.
 * The CLI (`telemetry test`/`status`) keeps the default probe.
 */
export function getSink(cfg: AshlrConfig, allowPhantomProbe = true): TelemetrySink {
  if (cfg.telemetry?.pulse) {
    // On the emit path (probe off): select OTLP whenever an endpoint is set and
    // let OtlpHttpSink resolve the PAT async; if none, emit() is a logged no-op.
    if (!allowPhantomProbe) return new OtlpHttpSink(cfg);
    // CLI path: keep the synchronous PAT availability probe for accurate routing.
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
 * PAT sourced from phantom (preferred) or ASHLR_PULSE_TOKEN env — placed
 * ONLY in the Authorization header, never logged or returned.
 */
class OtlpHttpSink implements TelemetrySink {
  constructor(private readonly cfg: AshlrConfig) {}

  async emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult> {
    const endpoint = this.cfg.telemetry?.pulse;
    if (!endpoint) {
      return { sink: 'otlp', ok: false, detail: 'no endpoint configured' };
    }

    // Retrieve PAT asynchronously — value used only in the Authorization
    // header, never stored. Async + bounded so we never freeze the event loop
    // (the spawnSync variant could block for up to 5s; resolvePatAsync uses
    // spawn + a Promise.race timeout instead).
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

/**
 * Resolve the PAT value for use ONLY in the Authorization header — ASYNC and
 * bounded so it is safe on a run/swarm completion path. The previous spawnSync
 * implementation froze the Node event loop for up to PHANTOM_TIMEOUT_MS; this
 * uses node:child_process.spawn wrapped in a Promise.race against a short
 * timeout, so a hung phantom can never block the run.
 *
 * Sources (in order):
 *   1. ASHLR_PULSE_TOKEN env var (direct, no spawn).
 *   2. phantom exec — injects vault secrets as env vars into a subprocess;
 *      we spawn `node -e 'process.stdout.write(process.env.ASHLR_PULSE_TOKEN||"")'`
 *      under phantom exec so the value flows only into the header.
 *
 * Resolves to the PAT string, or null when unavailable.
 * NEVER logs, prints, stores, or returns via any other path. The subprocess
 * stdout is PAT-bearing — it is consumed locally and must never be logged.
 */
async function resolvePatAsync(cfg: AshlrConfig): Promise<string | null> {
  // 1. Env var — fastest path, no subprocess.
  const envPat = process.env['ASHLR_PULSE_TOKEN'];
  if (envPat) return envPat;

  // 2. Phantom exec — only when integration enabled.
  if (!cfg.phantom?.enabled) return null;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already exited */ }
      resolve(value);
    };

    // Bounded budget — a hung phantom never blocks the run.
    const timer = setTimeout(() => done(null), PHANTOM_RESOLVE_TIMEOUT_MS);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        PHANTOM_BIN,
        ['exec', '--', 'node', '-e', `process.stdout.write(process.env['${PHANTOM_PAT_KEY}']||'')`],
        { env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      done(null);
      return;
    }

    // out is PAT-bearing — consumed locally, never logged.
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0) { done(null); return; }
      const value = out.trim();
      done(value || null);
    });
  });
}

/**
 * Extract ONLY secret names from `phantom list --json` output.
 * Conservative — returns [] on any parse failure to avoid leaking values.
 * Mirrors the extraction logic in core/phantom.ts.
 */
function extractSecretNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      const names: string[] = [];
      for (const item of parsed) {
        if (item !== null && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (typeof obj['name'] === 'string') names.push(obj['name']);
          else if (typeof obj['key'] === 'string') names.push(obj['key']);
        } else if (typeof item === 'string') {
          names.push(item);
        }
      }
      return names;
    }

    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['secrets', 'keys', 'names']) {
        if (Array.isArray(obj[key])) {
          return extractSecretNames(JSON.stringify(obj[key]));
        }
      }
    }

    return [];
  } catch {
    // Line-based fallback — env-var name pattern only, no values.
    const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
    const names: string[] = [];
    for (const line of (raw ?? '').split('\n')) {
      const token = line.trim().split(/\s+/)[0];
      if (token && ENV_VAR_RE.test(token) && token !== 'NAME' && token !== 'KEY') {
        names.push(token);
      }
    }
    return names;
  }
}
