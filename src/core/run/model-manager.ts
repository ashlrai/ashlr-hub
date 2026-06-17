/**
 * model-manager.ts — local model discovery and opt-in management.
 *
 * GUARDRAILS (non-negotiable):
 *  - `listLocalModels` and `ollamaInstalled` are PURE READ — no spawning work.
 *  - `pullModel` is EXPLICIT ONLY — called exclusively from `ashlr models pull`.
 *    Never invoked during routing or runs.
 *  - `startOllama` is EXPLICIT ONLY — called exclusively from `ashlr models start`.
 *    Never invoked during routing or runs.
 *  - Never throws — all failures surface as ok:false / empty arrays.
 *  - No new runtime dependencies.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AshlrConfig, LocalModelInfo } from '../types.js';
import { probeEndpoint } from '../providers.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bounded timeout for the Ollama /api/tags and LM Studio /v1/models probes. */
const PROBE_TIMEOUT_MS = 5_000;

/** Bounded timeout for waiting for Ollama to come up after `startOllama`. */
const START_WAIT_TIMEOUT_MS = 15_000;
const START_POLL_INTERVAL_MS = 500;

/** Maximum time allowed for `ollama pull` (large downloads; up to 10 min). */
const PULL_TIMEOUT_MS = 600_000;

/**
 * Valid model name characters for Ollama: alphanumeric, hyphen, underscore,
 * colon (for tag), period, and forward-slash (for namespace). No shell-special
 * characters. Must not be empty.
 */
const SAFE_MODEL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,254}$/;

// ---------------------------------------------------------------------------
// listLocalModels
// ---------------------------------------------------------------------------

/**
 * Probe Ollama (:11434 /api/tags) and LM Studio (:1234 /v1/models) and return
 * all discovered local models with their `active` flag set (matching the
 * configured default model per provider in cfg.models).
 *
 * Unreachable providers silently yield no entries — never throws.
 */
export async function listLocalModels(cfg: AshlrConfig): Promise<LocalModelInfo[]> {
  const [ollamaResult, lmResult] = await Promise.allSettled([
    probeEndpoint('ollama', cfg.models.ollama),
    probeEndpoint('lmstudio', cfg.models.lmstudio),
  ]);

  const results: LocalModelInfo[] = [];

  // --- Ollama ---
  if (ollamaResult.status === 'fulfilled' && ollamaResult.value.up) {
    const endpoint = ollamaResult.value;
    // Also attempt to get size info from /api/tags raw JSON
    const sizeMap = await fetchOllamaModelSizes(cfg.models.ollama);

    // Mark the model that pickModel() would actually select as the active
    // default for this provider (mirrors provider-client.ts so `ashlr models`
    // shows what a run would really use). ASHLR_MODEL override wins.
    const activeName = defaultModelFor(endpoint.models, process.env['ASHLR_MODEL']);

    for (const name of endpoint.models) {
      const sizeLabel = sizeMap.get(name);
      const entry: LocalModelInfo = { provider: 'ollama', name, active: name === activeName };
      if (sizeLabel) entry.sizeLabel = sizeLabel;
      results.push(entry);
    }
  }

  // --- LM Studio ---
  if (lmResult.status === 'fulfilled' && lmResult.value.up) {
    const endpoint = lmResult.value;
    const activeName = defaultModelFor(endpoint.models, process.env['ASHLR_MODEL']);

    for (const name of endpoint.models) {
      const entry: LocalModelInfo = { provider: 'lmstudio', name, active: name === activeName };
      results.push(entry);
    }
  }

  return results;
}

/**
 * Determine which model in `models` is the active default for a provider.
 *
 * This mirrors `pickModel` in provider-client.ts EXACTLY so that the model
 * marked active by `ashlr models` is the same one a run would actually use:
 *  1. ASHLR_MODEL override (exact match, else first substring match, else the
 *     verbatim override — which won't match any listed name, so nothing is
 *     marked active when the override names a model that isn't installed).
 *  2. Otherwise the local-first/cost-efficient default: the smallest/fastest
 *     non-embedding chat model, biased slightly toward coder models.
 *
 * Returns undefined when the list is empty.
 */
function defaultModelFor(models: string[], override: string | undefined): string | undefined {
  if (models.length === 0) return undefined;

  const trimmed = override?.trim();
  if (trimmed) {
    return (
      models.find((m) => m === trimmed) ??
      models.find((m) => m.toLowerCase().includes(trimmed.toLowerCase())) ??
      trimmed // names a model not in the list → no entry will match → none active
    );
  }

  const isEmbed = (m: string) => /embed|bge|e5|nomic/i.test(m);
  const pool = models.filter((m) => !isEmbed(m));
  const ranked = (pool.length ? pool : models).slice();
  const sizeOf = (m: string): number => {
    const b = m.match(/(\d+(?:\.\d+)?)\s*b\b/i); // "3b" / "7b" / "72b"
    if (b) return parseFloat(b[1]!);
    if (/mini|small|tiny|nano|phi/i.test(m)) return 3; // unlabeled small models
    return 999; // unknown size -> deprioritize
  };
  const score = (m: string): number => sizeOf(m) - (/coder|code/i.test(m) ? 0.5 : 0);
  ranked.sort((a, b) => score(a) - score(b));
  return ranked[0];
}

/**
 * Fetch Ollama /api/tags with a bounded timeout and extract model size labels.
 * Returns an empty Map on any failure — never throws.
 */
async function fetchOllamaModelSizes(ollamaBase: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      const url = ollamaBase.replace(/\/+$/, '') + '/api/tags';
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return map;
    const body = (await response.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>)['models'])
    ) {
      return map;
    }
    const models = (body as { models: unknown[] }).models;
    for (const m of models) {
      if (typeof m !== 'object' || m === null) continue;
      const entry = m as Record<string, unknown>;
      const name = typeof entry['name'] === 'string' ? entry['name'] : undefined;
      if (!name) continue;
      // Ollama reports size in bytes under `size`
      const sizeBytes = typeof entry['size'] === 'number' ? entry['size'] : undefined;
      if (sizeBytes !== undefined) {
        map.set(name, formatBytes(sizeBytes));
      }
    }
  } catch {
    // Silently return empty map
  }
  return map;
}

/** Format a byte count into a compact human-readable label (e.g. "4.7 GB"). */
function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    return (bytes / 1_073_741_824).toFixed(1) + ' GB';
  }
  if (bytes >= 1_048_576) {
    return (bytes / 1_048_576).toFixed(0) + ' MB';
  }
  return bytes + ' B';
}

// ---------------------------------------------------------------------------
// ollamaInstalled
// ---------------------------------------------------------------------------

/**
 * Detect whether the `ollama` binary is available on PATH.
 *
 * Synchronous, no I/O beyond a single `which` call. Returns false on any
 * error (binary not found, PATH issues, etc.). Never throws.
 */
export function ollamaInstalled(): boolean {
  try {
    // Cross-platform probe: `where` on Windows, `which` on POSIX.
    // execFileSync throws when exit code != 0.
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// pullModel
// ---------------------------------------------------------------------------

/**
 * EXPLICIT pull of a named Ollama model.
 *
 * Called ONLY from `ashlr models pull <name>` — NEVER from routing or runs.
 *
 * Validates the model name is a safe ref (no shell-special chars), then runs
 * `ollama pull <name>` via execFile (NOT a shell — no injection risk). Returns
 * a progress summary. Allows up to 10 minutes for the download.
 *
 * Returns { ok: false, detail: <reason> } when:
 *   - ollama is not installed
 *   - the model name fails validation
 *   - the pull command exits non-zero
 */
export async function pullModel(name: string): Promise<{ ok: boolean; detail: string }> {
  // 1. Validate model name — reject anything with shell-special chars.
  if (!name || !SAFE_MODEL_NAME_RE.test(name)) {
    return {
      ok: false,
      detail: `Invalid model name: "${name}". Use only alphanumeric characters, hyphens, underscores, colons, dots, and slashes (e.g. "llama3:8b").`,
    };
  }

  // 2. Require ollama binary.
  if (!ollamaInstalled()) {
    return {
      ok: false,
      detail: 'ollama binary not found on PATH. Install Ollama from https://ollama.com and retry.',
    };
  }

  // 3. Run `ollama pull <name>` — NO shell; execFile passes args directly.
  try {
    const { stdout, stderr } = await execFileAsync('ollama', ['pull', name], {
      timeout: PULL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10 MB output buffer
    });

    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    const summary = combined.length > 0 ? combined : `Pull of '${name}' completed.`;
    return { ok: true, detail: summary };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `ollama pull ${name} failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// startOllama
// ---------------------------------------------------------------------------

/**
 * Best-effort start of a LOCAL installed Ollama.
 *
 * Called ONLY from `ashlr models start` — NEVER from routing or runs.
 *
 * Strategy (macOS-first, matching the target platform):
 *  1. If Ollama is already responding on :11434, return ok immediately.
 *  2. If not installed, return ok:false immediately.
 *  3. Try `open -a Ollama` (macOS app) first — this launches the menu-bar app.
 *  4. Fall back to spawning `ollama serve` detached if the app open fails or
 *     if we're on non-macOS.
 *  5. Poll :11434 up to START_WAIT_TIMEOUT_MS for the server to come up.
 *  6. Return { ok, detail } — never throws.
 */
export async function startOllama(): Promise<{ ok: boolean; detail: string }> {
  // 1. Already up?
  if (await isOllamaUp()) {
    return { ok: true, detail: 'Ollama is already running.' };
  }

  // 2. Installed?
  if (!ollamaInstalled()) {
    return {
      ok: false,
      detail: 'ollama binary not found on PATH. Install Ollama from https://ollama.com.',
    };
  }

  // 3. Try launching the macOS app bundle first (silent on non-mac).
  const isMac = process.platform === 'darwin';
  let launchAttempted = false;

  if (isMac) {
    try {
      await execFileAsync('open', ['-a', 'Ollama'], { timeout: 5_000 });
      launchAttempted = true;
    } catch {
      // App not installed or open failed — fall through to `ollama serve`.
    }
  }

  // 4. If the app launch didn't work (or non-mac), spawn `ollama serve` detached.
  if (!launchAttempted) {
    try {
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
      });
      // Unref so the parent can exit independently of this background process.
      child.unref();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `Failed to start Ollama: ${msg}` };
    }
  }

  // 5. Poll :11434 until up or timeout.
  const deadline = Date.now() + START_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(START_POLL_INTERVAL_MS);
    if (await isOllamaUp()) {
      return { ok: true, detail: 'Ollama started and is now responding.' };
    }
  }

  return {
    ok: false,
    detail: `Ollama was started but did not respond on :11434 within ${START_WAIT_TIMEOUT_MS / 1000}s. ` +
      'It may still be loading — retry in a moment.',
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Quick liveness check for Ollama at the default :11434 address.
 * Returns true if GET /api/tags responds with HTTP 200.
 * Never throws.
 */
async function isOllamaUp(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    let response: Response;
    try {
      response = await fetch('http://127.0.0.1:11434/api/tags', {
        method: 'GET',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    return response.ok;
  } catch {
    return false;
  }
}

/** Simple promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
