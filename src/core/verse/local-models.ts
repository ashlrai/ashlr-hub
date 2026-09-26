/**
 * core/verse/local-models.ts — local model AVAILABILITY for the Verse Usage
 * view (owner T, V2.1).
 *
 * A subscription meter answers "may I spend?". The local analogue is "can this
 * machine run this model right now, and can that model drive an agent?". Three
 * facts answer it, and every one of them was already reachable and thrown away:
 *
 *   1. RESIDENCY — Ollama `GET /api/ps` reports what is loaded this second:
 *      `size` (total resident bytes), `size_vram` (the share on the GPU) and
 *      `expires_at` (the keep-alive countdown). `size_vram === size` is fully
 *      on the GPU; `size_vram === 0` is fully on the CPU; anything between is a
 *      layer split, which is the difference between fast and unusable. The
 *      resident size against the machine's total memory is the meter.
 *   2. CAPABILITY — Ollama `GET /api/show` reports `capabilities`. A model
 *      WITHOUT `tools` cannot drive an agentic session at all. That is a
 *      first-class field here (`supportsTools`) and it is what `seats.ts` now
 *      filters on, instead of guessing from the model's NAME.
 *   3. SHAPE — `/api/show` also gives `details.parameter_size`,
 *      `details.quantization_level`, `details.family` and the architecture's
 *      native `model_info["<arch>.context_length"]`.
 *
 * LM Studio `GET /api/v0/models` is included because it is the cleanest
 * availability signal that runtime offers (`state`, `max_context_length`,
 * `loaded_context_length`, `quantization`, `arch`) and nothing in this repo
 * calls it today.
 *
 * RULES
 *  - Nothing here throws. Every probe has a short timeout and degrades to
 *    `reachable: false` with a reason, or to an `unknown` field.
 *  - Never invent a number the runtime did not give. `null` means "no signal",
 *    which is not the same as zero.
 *  - No secrets: these are loopback HTTP metadata reads with no auth material.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { freemem, homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { modelDisplayText } from './model-display-name.js';

import {
  VERSE_DEFAULT_CONTEXT_WINDOWS,
  type VerseLocalDispatch,
  type VerseWindowSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VERSE_DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';
export const VERSE_DEFAULT_LMSTUDIO_BASE = 'http://127.0.0.1:1234';

/** Loopback metadata reads. Short enough that a dead runtime never stalls a request. */
export const VERSE_LOCAL_PROBE_TIMEOUT_MS = 2_000;

/**
 * Reachability probes (`/api/tags`, `/api/ps`, `/api/v0/models`) get a longer
 * budget than the per-model detail probes.
 *
 * A detail probe that times out costs one row's metadata. A reachability probe
 * that times out declares the ENTIRE local runtime unusable — and the Usage
 * section mounts seven reads at once, several of which spawn account-probe
 * processes, so a 2s budget was being starved by our own burst roughly one
 * time in ten. Ollama answers `/api/tags` in ~17ms unloaded; 10s is not a
 * latency allowance, it is a floor well clear of self-inflicted contention.
 * The asymmetry is deliberate: a slow answer is not the same claim as "down".
 */
export const VERSE_LOCAL_REACHABILITY_TIMEOUT_MS = 10_000;

/**
 * How long a known-good runtime report stays usable as a fallback when a later
 * reachability probe TIMES OUT.
 *
 * This does not invent data. A timeout is "no answer yet", not "the runtime is
 * gone", so erasing a reading we genuinely took seconds ago is the bigger lie.
 * The served report carries `stale: true` and `staleForMs` so a consumer can
 * say how old it is. A REFUSED connection is real evidence of absence and
 * never falls back.
 */
export const VERSE_LOCAL_LAST_GOOD_TTL_MS = 30_000;

type LastGoodEntry = { report: VerseLocalRuntimeReport; at: number };
const lastGoodByRuntime = new Map<string, LastGoodEntry>();

/** Test seam: forget every cached runtime report. */
export function resetVerseLocalModelCache(): void {
  lastGoodByRuntime.clear();
}

function rememberGood(key: string, report: VerseLocalRuntimeReport, now: number): VerseLocalRuntimeReport {
  if (report.reachable) lastGoodByRuntime.set(key, { report, at: now });
  return report;
}

/**
 * Fall back to the last good report for a TIMED-OUT probe only, and only while
 * it is fresh. Anything else is returned untouched.
 */
function withLastGood(
  key: string,
  report: VerseLocalRuntimeReport,
  now: number,
  ttlMs: number,
): VerseLocalRuntimeReport {
  if (report.reachable) return rememberGood(key, report, now);
  if (!(report.reason ?? '').endsWith('-timeout')) return report;
  const cached = lastGoodByRuntime.get(key);
  if (!cached) return report;
  // ttlMs <= 0 disables retention outright, so the knob has an "off".
  const ageMs = now - cached.at;
  if (ttlMs <= 0 || ageMs < 0 || ageMs > ttlMs) return report;
  return { ...cached.report, stale: true, staleForMs: ageMs, reason: report.reason };
}

/** Upper bound on tags inspected by one sweep. */
export const VERSE_LOCAL_MAX_MODELS = 64;

/** Upper bound on `/api/show` round-trips per sweep (they are one-per-model). */
export const VERSE_LOCAL_MAX_SHOW_PROBES = 48;

/** `/api/show` concurrency — polite to a runtime that may be mid-generation. */
const SHOW_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VerseLocalRuntime = 'ollama' | 'lmstudio';

/**
 * Where the weights actually live. `split` is the one that matters: a model
 * that half-fits the GPU runs at a fraction of the speed of one that fits.
 */
export type VerseLocalPlacement = 'gpu' | 'cpu' | 'split' | 'unknown';

export interface VerseLocalModel {
  runtime: VerseLocalRuntime;
  /** Runtime-native id — an Ollama tag, or an LM Studio model key. */
  id: string;
  label: string;
  /** `loaded` = resident now; `available` = installed, not resident. */
  state: 'loaded' | 'available' | 'unknown';
  /** Total resident/on-disk bytes as reported, else null. */
  sizeBytes: number | null;
  /** Resident bytes on the GPU (Ollama `size_vram`), else null. */
  sizeVramBytes: number | null;
  placement: VerseLocalPlacement;
  /** Share of the resident bytes that sit on the GPU, 0-100, else null. */
  gpuPercent: number | null;
  /** Keep-alive expiry (Ollama `expires_at`) — when this unloads if untouched. */
  expiresAt: string | null;
  /** Effective context for the loaded instance, when the runtime reports one. */
  contextLength: number | null;
  /** The architecture's native maximum, which can be far larger than the above. */
  nativeContextLength: number | null;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
  arch: string | null;
  /** Ollama `capabilities`, verbatim. Empty when the runtime reported none. */
  capabilities: string[];
  /**
   * Can this model drive an agentic session? `null` means the runtime did not
   * say — which is NOT the same as `false`, and callers must not treat it so.
   */
  supportsTools: boolean | null;
  /** Resident size against total machine memory, 0-100, else null. */
  memoryPercent: number | null;
}

export interface VerseLocalRuntimeReport {
  /** True when this is a retained known-good reading, not a fresh probe. */
  stale?: boolean;
  /** Age in ms of that retained reading, when `stale`. */
  staleForMs?: number;
  reachable: boolean;
  baseUrl: string;
  models: VerseLocalModel[];
  /** Machine-readable degradation reason; null when reachable. */
  reason: string | null;
}

export interface VerseLocalModelsSnapshot {
  sampledAt: string;
  machine: {
    totalMemoryBytes: number;
    freeMemoryBytes: number;
  };
  ollama: VerseLocalRuntimeReport;
  lmStudio: VerseLocalRuntimeReport;
  /** Plain-language caveats the UI must show rather than imply precision. */
  notes: string[];
}

/** What `seats.ts` needs from `/api/show` for ONE tag. */
export interface VerseOllamaModelDetail {
  /**
   * Pinned context when the Modelfile pins one — `min(num_ctx, native)`, since
   * Ollama caps a pin at the trained length — else the architecture maximum.
   * The latter is an UPPER BOUND on what an unpinned tag is served; the real
   * figure comes from {@link resolveLocalContextWindow}.
   */
  contextWindow: number | null;
  /** Modelfile `PARAMETER num_ctx`, verbatim; null when the tag pins none. */
  numCtx?: number | null;
  nativeContextLength: number | null;
  capabilities: string[];
  supportsTools: boolean | null;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
  arch: string | null;
}

export interface VerseLocalProbeOptions {
  ollamaBaseUrl?: string;
  lmStudioBaseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Override the known-good retention window (tests). */
  lastGoodTtlMs?: number;
  /**
   * Ollama's unpinned-request default. `undefined` reads it
   * ({@link readOllamaServerDefault}); tests pass a value or `null` (unknown).
   */
  ollamaServerDefault?: VerseOllamaServerDefault | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // Ollama writes "0001-01-01T00:00:00Z" for "no keep-alive"; that is not an expiry.
  if (parsed <= 0) return null;
  return new Date(parsed).toISOString();
}

/** Strip a trailing slash and a trailing `/v1` (the OpenAI-compat prefix). */
export function normalizeLocalBaseUrl(raw: string | undefined, fallback: string): string {
  let out = (raw ?? '').trim();
  if (out.length === 0) out = fallback;
  out = out.replace(/\/+$/, '');
  if (out.endsWith('/v1')) out = out.slice(0, -3);
  return out.length > 0 ? out : fallback;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<unknown> {
  return (await fetchJsonDetailed(fetchImpl, url, timeoutMs, init)).body;
}

/**
 * Same request, but reporting WHY it failed. "Timed out" and "refused" are
 * different claims about a runtime — one says busy, the other says absent —
 * and a reader deciding whether their local stack is usable needs to be told
 * which one happened rather than a flat "unreachable".
 */
async function fetchJsonDetailed(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<{ body: unknown; failure: 'timeout' | 'refused' | 'http' | null }> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { body: null, failure: 'http' };
    return { body: (await res.json()) as unknown, failure: null };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return { body: null, failure: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'refused' };
  }
}

/** Run `work` over `items` with a bounded number in flight. Never throws. */
async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index]!);
    }
  });
  await Promise.all(runners);
  return out;
}

/** "gpt-oss 20B", "Qwen3.8 27B · q8_0" — the shared display name, quantization after a middle dot. */
function pretty(tag: string): string {
  return modelDisplayText(tag, true);
}

function percentOf(part: number | null, whole: number): number | null {
  if (part === null || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, (part / whole) * 100)) * 10) / 10;
}

/**
 * GPU/CPU split from `/api/ps`. `size_vram === size` is fully on the GPU,
 * `0` is fully on the CPU, anything between is a layer split.
 */
export function placementOf(sizeBytes: number | null, sizeVramBytes: number | null): VerseLocalPlacement {
  if (sizeBytes === null || sizeVramBytes === null || sizeBytes <= 0) return 'unknown';
  if (sizeVramBytes <= 0) return 'cpu';
  if (sizeVramBytes >= sizeBytes) return 'gpu';
  return 'split';
}

// ---------------------------------------------------------------------------
// Ollama — /api/tags, /api/ps, /api/show
// ---------------------------------------------------------------------------

interface OllamaTag {
  tag: string;
  sizeBytes: number | null;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
}

interface OllamaResident {
  tag: string;
  sizeBytes: number | null;
  sizeVramBytes: number | null;
  expiresAt: string | null;
  contextLength: number | null;
}

function tagNameOf(entry: Record<string, unknown>): string | null {
  return str(entry['name']) ?? str(entry['model']);
}

function detailsOf(entry: Record<string, unknown>): {
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
} {
  const details = entry['details'];
  if (!isRecord(details)) return { parameterSize: null, quantization: null, family: null };
  return {
    parameterSize: str(details['parameter_size']),
    quantization: str(details['quantization_level']),
    family: str(details['family']),
  };
}

/** Installed models. Returns null when the runtime did not answer. */
export async function probeOllamaTags(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs = VERSE_LOCAL_PROBE_TIMEOUT_MS,
): Promise<OllamaTag[] | null> {
  return parseOllamaTags(await fetchJson(fetchImpl, `${baseUrl}/api/tags`, timeoutMs));
}

/**
 * Split out so the reachability check and the model listing share ONE
 * `/api/tags` request. Probing twice would double this route's exposure to the
 * very contention that makes it fail.
 */
function parseOllamaTags(body: unknown): OllamaTag[] | null {
  if (!isRecord(body) || !Array.isArray(body['models'])) return null;
  const out: OllamaTag[] = [];
  const seen = new Set<string>();
  for (const entry of body['models']) {
    if (!isRecord(entry)) continue;
    const tag = tagNameOf(entry);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, sizeBytes: num(entry['size']), ...detailsOf(entry) });
    if (out.length >= VERSE_LOCAL_MAX_MODELS) break;
  }
  return out;
}

/**
 * What is resident RIGHT NOW (`GET /api/ps`) — the fact `fabric/resource-monitor.ts`
 * already fetches and discards. Returns null when the runtime did not answer.
 */
export async function probeOllamaResident(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs = VERSE_LOCAL_PROBE_TIMEOUT_MS,
): Promise<OllamaResident[] | null> {
  const body = await fetchJson(fetchImpl, `${baseUrl}/api/ps`, timeoutMs);
  if (!isRecord(body) || !Array.isArray(body['models'])) return null;
  const out: OllamaResident[] = [];
  for (const entry of body['models']) {
    if (!isRecord(entry)) continue;
    const tag = tagNameOf(entry);
    if (!tag) continue;
    out.push({
      tag,
      sizeBytes: num(entry['size']),
      sizeVramBytes: num(entry['size_vram']),
      expiresAt: isoOrNull(entry['expires_at']),
      contextLength: num(entry['context_length']),
    });
    if (out.length >= VERSE_LOCAL_MAX_MODELS) break;
  }
  return out;
}

/** `num_ctx` from the `/api/show` `parameters` block (Modelfile `PARAMETER num_ctx N`). */
export function numCtxFromShowParameters(parameters: unknown): number | null {
  if (typeof parameters !== 'string') return null;
  const m = /^\s*num_ctx\s+(\d{1,9})\s*$/m.exec(parameters);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The architecture's native context from `model_info["<arch>.context_length"]`. */
export function nativeContextFromModelInfo(modelInfo: unknown): { value: number | null; arch: string | null } {
  if (!isRecord(modelInfo)) return { value: null, arch: null };
  const arch = str(modelInfo['general.architecture']);
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return { value: Math.floor(value), arch: arch ?? key.slice(0, -'.context_length'.length) };
    }
  }
  return { value: null, arch };
}

/**
 * One `/api/show`. NOTE the context precedence: `parameters.num_ctx` WINS over
 * `model_info["<arch>.context_length"]`, because a `:ctx64k`-style Modelfile
 * variant pins `num_ctx 65536` while `model_info` still reports the
 * architecture maximum (e.g. 262144) — using the latter makes a context meter
 * under-read by 4x. Never throws; every field degrades to null independently.
 */
export async function probeOllamaModelDetail(
  fetchImpl: typeof fetch,
  baseUrl: string,
  tag: string,
  timeoutMs = VERSE_LOCAL_PROBE_TIMEOUT_MS,
): Promise<VerseOllamaModelDetail | null> {
  const body = await fetchJson(fetchImpl, `${baseUrl}/api/show`, timeoutMs, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: tag, model: tag }),
  });
  if (!isRecord(body)) return null;

  const native = nativeContextFromModelInfo(body['model_info']);
  const numCtx = numCtxFromShowParameters(body['parameters']);
  const details = detailsOf(body);

  // `capabilities` absent ⇒ the runtime did not say. That is `null`, not false:
  // an older Ollama simply has no such key, and hiding every model would be a
  // worse lie than showing one that might not support tools.
  let capabilities: string[] = [];
  let supportsTools: boolean | null = null;
  if (Array.isArray(body['capabilities'])) {
    capabilities = body['capabilities'].filter((c): c is string => typeof c === 'string' && c.length <= 64).slice(0, 32);
    supportsTools = capabilities.includes('tools');
  }

  return {
    // A pin above the trained length is capped by Ollama itself (it logs
    // "requested context size too large … n_ctx_train"), so never report more.
    contextWindow: numCtx !== null ? Math.min(numCtx, native.value ?? numCtx) : native.value,
    numCtx,
    nativeContextLength: native.value,
    capabilities,
    supportsTools,
    parameterSize: details.parameterSize,
    quantization: details.quantization,
    family: details.family,
    arch: native.arch,
  };
}

// ---------------------------------------------------------------------------
// The ONE local context-window resolver (seats and the Usage view both use it)
// ---------------------------------------------------------------------------

/**
 * `qwen3-coder-next:ctx64k` / `qwen3.8:27b-ctx64k` / `foo_ctx128K` → tokens;
 * null when the tag carries no such suffix.
 *
 * The suffix may follow `:`, `-` or `_`. It used to be `/:ctx(\d+)k$/`, which
 * missed the house default `qwen3.8:27b-ctx64k` entirely because its suffix
 * follows a hyphen. Only a LAST RESORT: it is a naming convention, not a
 * runtime statement, and is consulted only when `/api/show` failed.
 */
export function contextWindowFromTagSuffix(tag: string): number | null {
  const m = /(?:^|[:_-])ctx(\d+)k$/i.exec(tag);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 16_384 ? n * 1024 : null;
}

/**
 * The context Ollama gives a request that does NOT pin `num_ctx`, and where
 * that figure came from. Null `contextLength` means none could be read.
 *
 * Ollama does not expose this over HTTP. It is, in order of authority:
 *  - `server-log-env`  — `OLLAMA_CONTEXT_LENGTH` as the RUNNING server printed
 *                        it in its `server config` line. This is the value the
 *                        server actually runs with, so it outranks everything;
 *  - `server-log-vram` — the server's own `vram-based default context …
 *                        default_num_ctx=N`, which Ollama derives from GPU
 *                        memory (262144 on a 107 GiB machine, far less on a
 *                        small one — which is why the architecture maximum is
 *                        NOT a safe stand-in);
 *  - `env`             — `OLLAMA_CONTEXT_LENGTH` (> 0) in THIS process's
 *                        environment. Last resort, used only when no server log
 *                        is readable: on macOS Ollama.app does not inherit the
 *                        shell that launched the hub, so a variable exported
 *                        there for some other tool says nothing about the
 *                        server — ranking it first let the hub's environment
 *                        silently decide every unpinned tag's window (and the
 *                        CLAUDE_CODE_MAX_CONTEXT_TOKENS a chat is launched with).
 */
export interface VerseOllamaServerDefault {
  contextLength: number | null;
  source: 'env' | 'server-log-env' | 'server-log-vram' | null;
}

/** Ollama writes its server log here on macOS and in the default Linux install. */
export function ollamaServerLogPath(home: string = homedir()): string {
  return join(home, '.ollama', 'logs', 'server.log');
}

/**
 * Head of the server log to scan. Ollama rotates `server.log` on every start,
 * so the startup block (config dump on line 1, VRAM default ~line 10) is at
 * the TOP of the current file however long the server has been running.
 */
const OLLAMA_LOG_HEAD_BYTES = 256 * 1024;

/** Pure: the last startup facts in a server-log excerpt. */
export function parseOllamaServerLog(text: string): { contextLengthEnv: number | null; vramDefault: number | null } {
  let contextLengthEnv: number | null = null;
  let vramDefault: number | null = null;
  for (const line of text.split('\n')) {
    if (line.includes('msg="server config"')) {
      const m = /OLLAMA_CONTEXT_LENGTH:(\d{1,9})(?=[\s\]])/.exec(line);
      contextLengthEnv = m ? Number(m[1]) : null;
    } else if (line.includes('default context') || line.includes('default_num_ctx')) {
      const m = /default_num_ctx=(\d{1,9})\b/.exec(line);
      if (m) vramDefault = Number(m[1]);
    }
  }
  return {
    contextLengthEnv: contextLengthEnv !== null && contextLengthEnv > 0 ? contextLengthEnv : null,
    vramDefault: vramDefault !== null && vramDefault > 0 ? vramDefault : null,
  };
}

function readHead(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, Math.max(0, n)).toString('utf8');
    // Parse whole lines only: a line cut by the byte cap is dropped.
    const cut = n >= maxBytes ? text.lastIndexOf('\n') : text.length;
    return cut > 0 ? text.slice(0, cut) : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Read Ollama's unpinned-request default: the server's own log first, this
 * process's environment only when the log says nothing (see
 * {@link VerseOllamaServerDefault}). Never throws; unknown is `{null, null}`.
 */
export function readOllamaServerDefault(
  opts: { env?: NodeJS.ProcessEnv; logPath?: string } = {},
): VerseOllamaServerDefault {
  const text = readHead(opts.logPath ?? ollamaServerLogPath(), OLLAMA_LOG_HEAD_BYTES);
  if (text !== null) {
    const parsed = parseOllamaServerLog(text);
    if (parsed.contextLengthEnv !== null) return { contextLength: parsed.contextLengthEnv, source: 'server-log-env' };
    if (parsed.vramDefault !== null) return { contextLength: parsed.vramDefault, source: 'server-log-vram' };
  }
  const env = opts.env ?? process.env;
  const fromEnv = Number((env['OLLAMA_CONTEXT_LENGTH'] ?? '').trim());
  if (Number.isFinite(fromEnv) && fromEnv > 0) return { contextLength: Math.floor(fromEnv), source: 'env' };
  return { contextLength: null, source: null };
}

/**
 * llama-server's PER-SLOT context — what one agent actually gets on the
 * llama-server lane, whatever the tag's Modelfile says (`-c 262144 --parallel
 * 4` is 65536 per slot). Read back from the live server, exactly as
 * `local-runtime/llama/health.ts` derives `contextPerSlot`:
 *
 *   `/props.default_generation_settings.n_ctx` → `/slots[0].n_ctx` →
 *   `floor(requestedContext / total_slots)` (the `-c` we launched it with,
 *   from the ownership record, over the slot count the SERVER reports).
 *
 * Null when the server does not answer — the caller then falls back to the
 * Ollama figure and says so. Never throws.
 */
export async function probeLlamaSlotContext(
  fetchImpl: typeof fetch,
  origin: string,
  opts: { timeoutMs?: number; requestedContext?: number | null } = {},
): Promise<{ perSlot: number | null; totalSlots: number | null; source: 'props' | 'slots' | 'requested' | null }> {
  const timeoutMs = opts.timeoutMs ?? VERSE_LOCAL_PROBE_TIMEOUT_MS;
  const base = origin.replace(/\/+$/, '').replace(/\/v1$/, '');
  const [props, slots] = await Promise.all([
    fetchJsonDetailed(fetchImpl, `${base}/props`, timeoutMs),
    fetchJsonDetailed(fetchImpl, `${base}/slots`, timeoutMs),
  ]);
  const { deriveSlotCapacity } = await import('../local-runtime/llama/health.js');
  const capacity = deriveSlotCapacity(
    { httpStatus: props.failure === null ? 200 : null, body: props.body, error: props.failure },
    { httpStatus: slots.failure === null ? 200 : null, body: slots.body, error: slots.failure },
  );
  const totalSlots = capacity.configured;
  const generation = isRecord(props.body) ? props.body['default_generation_settings'] : null;
  const fromProps = isRecord(generation) ? num(generation['n_ctx']) : null;
  if (fromProps !== null && fromProps > 0) return { perSlot: Math.floor(fromProps), totalSlots, source: 'props' };
  const first = Array.isArray(slots.body) ? slots.body[0] : null;
  const fromSlots = isRecord(first) ? num(first['n_ctx']) : null;
  if (fromSlots !== null && fromSlots > 0) return { perSlot: Math.floor(fromSlots), totalSlots, source: 'slots' };
  const requested = opts.requestedContext ?? null;
  if (requested !== null && requested > 0 && totalSlots !== null && totalSlots > 0) {
    return { perSlot: Math.floor(requested / totalSlots), totalSlots, source: 'requested' };
  }
  return { perSlot: null, totalSlots, source: null };
}

/** How a local window was decided — for notes and tests, never for the wire. */
export type VerseLocalWindowBasis =
  | 'llama-slot'
  | 'num-ctx'
  | 'resident'
  | 'server-default'
  | 'native-estimate'
  | 'tag-suffix'
  | 'default';

export interface VerseLocalWindow {
  window: number;
  source: VerseWindowSource;
  basis: VerseLocalWindowBasis;
}

export interface VerseLocalWindowInput {
  tag: string;
  lane: VerseLocalDispatch;
  /** llama-server per-slot context; consulted ONLY on the llama-server lane. */
  llamaSlotWindow?: number | null;
  /** `/api/show` for this tag; null when it failed. */
  detail: VerseOllamaModelDetail | null;
  /**
   * `/api/ps` `context_length` when this tag is resident. Consulted only when
   * no server default is known: it describes whatever request LOADED the
   * runner, which may have pinned its own `options.num_ctx`.
   */
  residentContext?: number | null;
  serverDefault?: VerseOllamaServerDefault | null;
}

/**
 * THE local context-window resolver. Precedence (docs/VERSE-CONTEXT.md §1):
 *
 *  1. llama-server lane — the per-slot `n_ctx` (`runtime`). The Modelfile is
 *     irrelevant there: llama-server allocates per slot.
 *  2. Ollama, `num_ctx` pinned — `min(num_ctx, native)` (`provider-catalog`:
 *     the runtime's own model record).
 *  3. Ollama, not pinned — `min(serverDefault, native)` (`provider-catalog`),
 *     serverDefault being what the server would give an unpinned request
 *     (its logged OLLAMA_CONTEXT_LENGTH, else its VRAM default, else this
 *     process's env — {@link readOllamaServerDefault}).
 *  4. Ollama, not pinned, no server default known — the resident instance's
 *     `/api/ps` context (`runtime`), capped by native. Only here, because
 *     residency describes the request that loaded the runner, and ANOTHER
 *     client's `/api/chat` with `options.num_ctx=8192` loads it at 8192. Verse's
 *     turns send no num_ctx, so Ollama reloads the tag at its default: letting
 *     a foreign runner define the window told the CLI 8192 (every turn blocked)
 *     or, with a larger foreign num_ctx, overstated it (overflow without
 *     compaction). With neither, the trained maximum — marked `fallback`,
 *     because Ollama may allocate far less.
 *  5. `/api/show` said nothing usable — the tag suffix, then
 *     `VERSE_DEFAULT_CONTEXT_WINDOWS.local`, both `fallback`.
 *
 * A server default is never used WITHOUT a native length to cap it: a 262144
 * VRAM default applied to an 8k embedding model would be a 32× overstatement.
 * (With no native length, residency — a real allocation — is the best fact.)
 */
export function resolveLocalContextWindow(input: VerseLocalWindowInput): VerseLocalWindow {
  const slot = input.lane === 'llama-server' ? positive(input.llamaSlotWindow) : null;
  if (slot !== null) return { window: slot, source: 'runtime', basis: 'llama-slot' };

  const detail = input.detail;
  const native = positive(detail?.nativeContextLength ?? null);
  const numCtx = positive(detail?.numCtx ?? null);
  if (numCtx !== null) {
    return { window: native !== null ? Math.min(numCtx, native) : numCtx, source: 'provider-catalog', basis: 'num-ctx' };
  }

  if (detail !== null) {
    const serverDefault = positive(input.serverDefault?.contextLength ?? null);
    if (native !== null && serverDefault !== null) {
      return { window: Math.min(serverDefault, native), source: 'provider-catalog', basis: 'server-default' };
    }
    const resident = positive(input.residentContext ?? null);
    if (resident !== null) {
      return { window: native !== null ? Math.min(resident, native) : resident, source: 'runtime', basis: 'resident' };
    }
    if (native !== null) return { window: native, source: 'fallback', basis: 'native-estimate' };
  }

  const fromSuffix = contextWindowFromTagSuffix(input.tag);
  if (fromSuffix !== null) return { window: fromSuffix, source: 'fallback', basis: 'tag-suffix' };
  return { window: VERSE_DEFAULT_CONTEXT_WINDOWS['local'] ?? 65_536, source: 'fallback', basis: 'default' };
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

async function collectOllama(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  serverDefault: VerseOllamaServerDefault | null,
): Promise<VerseLocalRuntimeReport> {
  // Reachability gets the long budget; per-model detail keeps the short one.
  // A detail probe that times out costs one row; a reachability probe that
  // times out declares the whole runtime dead.
  const reachTimeoutMs = Math.max(timeoutMs, VERSE_LOCAL_REACHABILITY_TIMEOUT_MS);
  const [tagsProbe, resident] = await Promise.all([
    fetchJsonDetailed(fetchImpl, `${baseUrl}/api/tags`, reachTimeoutMs),
    probeOllamaResident(fetchImpl, baseUrl, reachTimeoutMs),
  ]);
  const tags = parseOllamaTags(tagsProbe.body);
  if (tags === null) {
    return {
      reachable: false,
      baseUrl,
      models: [],
      // "Slow" and "absent" are different claims. Only a refused connection
      // means the runtime is not there.
      reason: tagsProbe.failure === 'timeout' ? 'ollama-timeout' : 'ollama-unreachable',
    };
  }

  const residentByTag = new Map<string, OllamaResident>();
  for (const row of resident ?? []) residentByTag.set(row.tag, row);

  const probeTargets = tags.slice(0, VERSE_LOCAL_MAX_SHOW_PROBES);
  const details = await mapLimited(probeTargets, SHOW_CONCURRENCY, (t) =>
    probeOllamaModelDetail(fetchImpl, baseUrl, t.tag, timeoutMs));

  const total = totalmem();
  const models: VerseLocalModel[] = tags.map((tag, index) => {
    const detail = index < details.length ? details[index] ?? null : null;
    const live = residentByTag.get(tag.tag) ?? null;
    const sizeBytes = live?.sizeBytes ?? tag.sizeBytes;
    const sizeVramBytes = live?.sizeVramBytes ?? null;
    return {
      runtime: 'ollama',
      id: tag.tag,
      label: pretty(tag.tag),
      state: live ? 'loaded' : 'available',
      sizeBytes,
      sizeVramBytes,
      placement: live ? placementOf(live.sizeBytes, sizeVramBytes) : 'unknown',
      gpuPercent: live && live.sizeBytes !== null ? percentOf(sizeVramBytes, live.sizeBytes) : null,
      expiresAt: live?.expiresAt ?? null,
      // Resident: what the loaded instance was given — a fact about the runner
      // in memory now (possibly loaded by another client's num_ctx, which is
      // why the SEAT window does not trust it). Otherwise what the next
      // unpinned request WILL be given — the same resolver the seats use. Null
      // only when `/api/show` itself failed: the tag-suffix guess is not a
      // runtime fact.
      contextLength: live?.contextLength ?? (detail !== null
        ? resolveLocalContextWindow({ tag: tag.tag, lane: 'ollama', detail, serverDefault }).window
        : null),
      nativeContextLength: detail?.nativeContextLength ?? null,
      parameterSize: detail?.parameterSize ?? tag.parameterSize,
      quantization: detail?.quantization ?? tag.quantization,
      family: detail?.family ?? tag.family,
      arch: detail?.arch ?? null,
      capabilities: detail?.capabilities ?? [],
      supportsTools: detail?.supportsTools ?? null,
      memoryPercent: percentOf(sizeBytes, total),
    };
  });

  // Loaded first, then biggest — "what can I use now" before "what is installed".
  models.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'loaded' ? -1 : 1;
    return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
  });
  return { reachable: true, baseUrl, models, reason: null };
}

// ---------------------------------------------------------------------------
// LM Studio — GET /api/v0/models
// ---------------------------------------------------------------------------

/**
 * LM Studio's own REST API (not the OpenAI-compat `/v1`). It reports `state`
 * (`loaded` / `not-loaded`), `max_context_length`, `loaded_context_length`,
 * `quantization` and `arch` — the cleanest availability signal that runtime
 * gives, and nothing in this repo calls it today.
 */
export async function probeLmStudioModels(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs = VERSE_LOCAL_PROBE_TIMEOUT_MS,
): Promise<VerseLocalRuntimeReport> {
  const body = await fetchJson(
    fetchImpl,
    `${baseUrl}/api/v0/models`,
    Math.max(timeoutMs, VERSE_LOCAL_REACHABILITY_TIMEOUT_MS),
  );
  if (!isRecord(body) || !Array.isArray(body['data'])) {
    return { reachable: false, baseUrl, models: [], reason: 'lmstudio-unreachable' };
  }
  const total = totalmem();
  const models: VerseLocalModel[] = [];
  const seen = new Set<string>();
  for (const entry of body['data']) {
    if (!isRecord(entry)) continue;
    const id = str(entry['id']);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawState = str(entry['state']);
    const sizeBytes = num(entry['size_bytes']) ?? num(entry['size']);
    models.push({
      runtime: 'lmstudio',
      id,
      label: pretty(id),
      state: rawState === 'loaded' ? 'loaded' : rawState === 'not-loaded' ? 'available' : 'unknown',
      sizeBytes,
      // LM Studio does not report a GPU/CPU split on this endpoint.
      sizeVramBytes: null,
      placement: 'unknown',
      gpuPercent: null,
      expiresAt: null,
      contextLength: num(entry['loaded_context_length']),
      nativeContextLength: num(entry['max_context_length']),
      parameterSize: null,
      quantization: str(entry['quantization']),
      family: null,
      arch: str(entry['arch']),
      capabilities: [],
      // This endpoint carries no tool-capability field; `null` says exactly that.
      supportsTools: null,
      memoryPercent: percentOf(sizeBytes, total),
    });
    if (models.length >= VERSE_LOCAL_MAX_MODELS) break;
  }
  models.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'loaded' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return { reachable: true, baseUrl, models, reason: null };
}

// ---------------------------------------------------------------------------
// llama-server — /health, /props, /v1/models (V3.10, Apps & Accounts)
// ---------------------------------------------------------------------------

export const VERSE_DEFAULT_LLAMA_SERVER_BASE = 'http://127.0.0.1:8080';

/**
 * `ok` = /health answered 200; `loading` = 503 (llama-server answers that
 * while it maps the weights); `error` = any other HTTP status; `down` = no
 * answer at all (refused or timed out — see `reason`).
 */
export type VerseLlamaServerStatus = 'ok' | 'loading' | 'error' | 'down';

export interface VerseLlamaServerReport {
  reachable: boolean;
  baseUrl: string;
  status: VerseLlamaServerStatus;
  /**
   * Served model names — ONLY those that are not filesystem paths. llama-server
   * started on a raw GGUF (the Ollama-blob case on this machine) names the model
   * by its absolute path, which carries the operator's home directory; that is
   * reported as a count, never as text.
   */
  models: string[];
  modelCount: number | null;
  /** `/props.total_slots` — what the server BUILT, not the `--parallel` it was asked for. */
  slots: number | null;
  /** Machine-readable; null when `ok`. */
  reason: string | null;
}

async function probeStatus(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ status: number | null; failure: 'timeout' | 'refused' | null }> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    // Drain so the socket is released; the body of /health is not needed.
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, failure: null };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return { status: null, failure: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'refused' };
  }
}

/**
 * A light liveness read of a llama-server, for the Apps page. Never throws.
 *
 * Deliberately NOT `local-runtime/llama/health.ts#probeLlamaRuntime`: that one
 * also inspects the process table and the ownership record (it answers "is
 * OUR supervised server healthy"), which costs process spawns a page render
 * must not pay. This answers only "does something on the port serve", from
 * three loopback GETs with a short timeout.
 */
export async function probeLlamaServer(opts: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<VerseLlamaServerReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? VERSE_LOCAL_PROBE_TIMEOUT_MS;
  const baseUrl = normalizeLocalBaseUrl(opts.baseUrl, VERSE_DEFAULT_LLAMA_SERVER_BASE);
  const health = await probeStatus(fetchImpl, `${baseUrl}/health`, timeoutMs);
  if (health.status === null) {
    return {
      reachable: false,
      baseUrl,
      status: 'down',
      models: [],
      modelCount: null,
      slots: null,
      reason: health.failure === 'timeout' ? 'llama-server-timeout' : 'llama-server-refused',
    };
  }
  const status: VerseLlamaServerStatus = health.status === 200 ? 'ok' : health.status === 503 ? 'loading' : 'error';
  if (status !== 'ok') {
    return {
      reachable: true,
      baseUrl,
      status,
      models: [],
      modelCount: null,
      slots: null,
      reason: status === 'loading' ? 'llama-server-loading' : `llama-server-http-${health.status}`,
    };
  }
  const [props, models] = await Promise.all([
    fetchJson(fetchImpl, `${baseUrl}/props`, timeoutMs),
    fetchJson(fetchImpl, `${baseUrl}/v1/models`, timeoutMs),
  ]);
  const slots = isRecord(props) ? num(props['total_slots']) : null;
  let modelCount: number | null = null;
  const names: string[] = [];
  if (isRecord(models) && Array.isArray(models['data'])) {
    modelCount = 0;
    for (const entry of models['data']) {
      if (!isRecord(entry)) continue;
      modelCount += 1;
      const id = str(entry['id']);
      // A path is not a name (and carries the home directory): count it only.
      if (id !== null && !id.includes('/') && !id.includes('\\') && names.length < 8) names.push(id);
    }
  }
  return {
    reachable: true,
    baseUrl,
    status,
    models: names,
    modelCount,
    slots: slots === null ? null : Math.round(slots),
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const VERSE_LOCAL_MODEL_NOTES: readonly string[] = [
  'A model without the `tools` capability cannot drive an agentic session.',
  '`supportsTools: null` means the runtime did not report capabilities — not that tools are unsupported.',
  'Resident size is measured against total machine memory, which is shared with everything else running.',
];

/**
 * One sweep of every local runtime. Never throws: an unreachable runtime is
 * reported as `reachable: false` with a reason, and the other still answers.
 */
export async function collectVerseLocalModels(
  opts: VerseLocalProbeOptions = {},
): Promise<VerseLocalModelsSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? VERSE_LOCAL_PROBE_TIMEOUT_MS;
  const ollamaBaseUrl = normalizeLocalBaseUrl(opts.ollamaBaseUrl, VERSE_DEFAULT_OLLAMA_BASE);
  const lmStudioBaseUrl = normalizeLocalBaseUrl(opts.lmStudioBaseUrl, VERSE_DEFAULT_LMSTUDIO_BASE);

  const ttlMs = opts.lastGoodTtlMs ?? VERSE_LOCAL_LAST_GOOD_TTL_MS;
  const now = Date.now();
  const serverDefault = opts.ollamaServerDefault !== undefined ? opts.ollamaServerDefault : readOllamaServerDefault();
  const [ollamaFresh, lmStudioFresh] = await Promise.all([
    collectOllama(fetchImpl, ollamaBaseUrl, timeoutMs, serverDefault).catch((): VerseLocalRuntimeReport => ({
      reachable: false, baseUrl: ollamaBaseUrl, models: [], reason: 'ollama-probe-failed',
    })),
    probeLmStudioModels(fetchImpl, lmStudioBaseUrl, timeoutMs).catch((): VerseLocalRuntimeReport => ({
      reachable: false, baseUrl: lmStudioBaseUrl, models: [], reason: 'lmstudio-probe-failed',
    })),
  ]);
  // A timed-out probe must not erase a reading we genuinely took seconds ago.
  const ollama = withLastGood(`ollama:${ollamaBaseUrl}`, ollamaFresh, now, ttlMs);
  const lmStudio = withLastGood(`lmstudio:${lmStudioBaseUrl}`, lmStudioFresh, now, ttlMs);

  return {
    sampledAt: new Date().toISOString(),
    machine: { totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() },
    ollama,
    lmStudio,
    notes: [...VERSE_LOCAL_MODEL_NOTES],
  };
}
