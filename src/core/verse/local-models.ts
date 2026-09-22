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

import { totalmem, freemem } from 'node:os';

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
  /** Effective context: Modelfile `num_ctx` wins over the architecture maximum. */
  contextWindow: number | null;
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

function pretty(tag: string): string {
  const [base = tag, ...rest] = tag.split(':');
  const head = base
    .split('-')
    .map((seg) => (seg.length > 0 ? seg[0]!.toUpperCase() + seg.slice(1) : seg))
    .join('-');
  const variant = rest.join(':');
  return variant && variant !== 'latest' ? `${head} ${variant}` : head;
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
    contextWindow: numCtx ?? native.value,
    nativeContextLength: native.value,
    capabilities,
    supportsTools,
    parameterSize: details.parameterSize,
    quantization: details.quantization,
    family: details.family,
    arch: native.arch,
  };
}

async function collectOllama(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
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
      contextLength: live?.contextLength ?? detail?.contextWindow ?? null,
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
  const [ollamaFresh, lmStudioFresh] = await Promise.all([
    collectOllama(fetchImpl, ollamaBaseUrl, timeoutMs).catch((): VerseLocalRuntimeReport => ({
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
