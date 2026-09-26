/**
 * routes/verse/usage/local-model.ts — local availability, projected for
 * display.
 *
 * "Can I run this locally right now" is a different question from "is it
 * installed", and the answer has four independent parts the old surface threw
 * away (docs/VERSE-TELEMETRY-V2.md, "Local models"):
 *
 *   - RESIDENT vs INSTALLED — `/api/ps` vs `/api/tags`. Only a resident model
 *     answers without a load delay.
 *   - GPU/CPU SPLIT — `size_vram` against `size`. A model that spilled to CPU
 *     is usable but slow, and that is a fact the operator should see, not
 *     discover mid-turn.
 *   - KEEP-ALIVE — `expires_at` is when residency ends. Rendered as a
 *     countdown because it genuinely is one (unlike Claude's reset prose,
 *     which is not a timestamp and must stay verbatim).
 *   - TOOLS — a model whose `capabilities` lack `tools` CANNOT drive an
 *     agentic session at all. That is a hard gate, so it is stated up front
 *     rather than failing at turn time. `capabilities: null` means the list
 *     was not reported, which is NOT the same as "no tool support" and is
 *     rendered as unknown.
 *
 * Pure: no React, no I/O.
 */
import { modelDisplayName, modelDisplayText } from '../../../../core/verse/model-display-name.js';
import type { LocalModel, LocalModelsSnapshot, LocalRuntimeStatus } from './usage-contract.js';

export type ToolSupport = 'supported' | 'unsupported' | 'unknown';

export interface LocalModelRow {
  /** The runtime's own tag (`qwen3.8:27b-q8_0`): the row key and the tooltip. */
  name: string;
  /** "Qwen3.8 27B" — what a person reads (core/verse/model-display-name.ts). */
  displayName: string;
  /** "q8_0" — the quantization from the tag, shown subtly beside the name; null when none. */
  nameDetail: string | null;
  /** Which runtime reported it, so a flattened list stays attributable. */
  runtime: LocalModel['runtime'];
  resident: boolean;
  /**
   * Where the weights sit. `split` is the one that changes the answer: a model
   * that only half-fits the GPU is usable but slow, and an operator should see
   * that before picking the seat rather than discovering it mid-turn.
   */
  placement: LocalModel['placement'];
  /** Resident size against total machine memory (0–100), or null. */
  memoryPct: number | null;
  family: string | null;
  sizeBytes: number | null;
  sizeVramBytes: number | null;
  /** Share of resident bytes held in VRAM (0–100), or null when unreported. */
  gpuPct: number | null;
  /** ms until keep-alive expiry AT BUILD TIME; null when not resident or not reported. */
  expiresInMs: number | null;
  /**
   * Epoch ms of the keep-alive expiry — the durable fact. A rendered countdown
   * must derive from THIS against a live clock; `expiresInMs` is frozen into
   * the view model and would print the same number forever.
   */
  expiresAtMs: number | null;
  parameterSize: string | null;
  quantization: string | null;
  nativeContext: number | null;
  configuredContext: number | null;
  /** True when Ashlr runs this model at less than its native context. */
  contextTruncated: boolean;
  tools: ToolSupport;
}

export function toolSupport(capabilities: string[] | null): ToolSupport {
  if (capabilities === null) return 'unknown';
  return capabilities.includes('tools') ? 'supported' : 'unsupported';
}

/**
 * The runtime's own `supportsTools` is AUTHORITATIVE and outranks the
 * capability array.
 *
 * The server sends `capabilities: []` when a runtime reported no capability
 * list at all, and reading that array alone renders "no tools" — a hard gate
 * that would wrongly tell the operator a model cannot drive an agentic
 * session. `supportsTools: null` is the honest "the runtime did not say".
 */
export function resolveToolSupport(
  supportsTools: boolean | null,
  capabilities: string[] | null,
): ToolSupport {
  if (supportsTools !== null) return supportsTools ? 'supported' : 'unsupported';
  if (capabilities !== null && capabilities.length === 0) return 'unknown';
  return toolSupport(capabilities);
}

export function buildLocalModelRow(model: LocalModel, now: number): LocalModelRow {
  const expiresMs = model.expiresAt ? Date.parse(model.expiresAt) : Number.NaN;
  // The runtime's own `gpuPercent` is authoritative — it knows how the layers
  // were actually placed. Recomputing from size/size_vram is the fallback for
  // a server that predates the field, never an override of it.
  const gpuPct =
    model.gpuPercent ??
    (model.sizeBytes !== null && model.sizeBytes > 0 && model.sizeVramBytes !== null
      ? Math.max(0, Math.min(100, (model.sizeVramBytes / model.sizeBytes) * 100))
      : null);

  const display = modelDisplayName(model.name);
  return {
    name: model.name,
    displayName: display.name,
    nameDetail: display.detail,
    runtime: model.runtime,
    resident: model.loaded,
    placement: model.placement,
    // Only a RESIDENT model occupies memory. `sizeBytes` for an unloaded model
    // is the on-disk size, so a machine-memory share computed from it would
    // report memory that is not in use.
    memoryPct: model.loaded ? model.memoryPercent : null,
    family: model.family,
    sizeBytes: model.sizeBytes,
    sizeVramBytes: model.sizeVramBytes,
    gpuPct,
    expiresInMs: model.loaded && !Number.isNaN(expiresMs) ? expiresMs - now : null,
    expiresAtMs: model.loaded && !Number.isNaN(expiresMs) ? expiresMs : null,
    parameterSize: model.parameterSize,
    quantization: model.quantization,
    nativeContext: model.nativeContext,
    configuredContext: model.configuredContext,
    contextTruncated:
      model.nativeContext !== null &&
      model.configuredContext !== null &&
      model.configuredContext < model.nativeContext,
    tools: resolveToolSupport(model.supportsTools, model.capabilities),
  };
}

export interface LocalModelsView {
  reachable: boolean;
  reason: string | null;
  /** Resident first (they are the answer to "right now"), then by name. */
  rows: LocalModelRow[];
  residentBytes: number | null;
  memoryBudgetBytes: number | null;
  memoryUsedPct: number | null;
  /** The machine's own reported free memory, or null. */
  freeMemoryBytes: number | null;
  /** Per-runtime reachability and staleness, for the panel's banner. */
  runtimes: LocalRuntimeStatus[];
  /** The server's plain-language caveats for this snapshot. */
  notes: string[];
  /** Models that CAN drive an agentic session. */
  agenticCount: number;
  /** Models that explicitly cannot. Separate from `unknownToolCount`. */
  nonAgenticCount: number;
  /** Models whose runtime did not say — never counted as "cannot". */
  unknownToolCount: number;
}

/**
 * The staleness verdict for the whole local reading.
 *
 * A retained known-good report is the right server-side choice (a timeout is
 * "no answer yet", not "the runtime is gone"), but it obliges this surface to
 * say the numbers are N seconds old rather than presenting them as fresh.
 * The oldest retained report wins, because a panel is only as fresh as its
 * stalest input.
 */
export interface LocalStaleness {
  stale: boolean;
  /** Age of the OLDEST retained reading, in ms. Null when nothing is stale. */
  staleForMs: number | null;
  /** Which runtimes were served from a retained reading. */
  runtimes: LocalRuntimeStatus['runtime'][];
}

export function localStaleness(runtimes: readonly LocalRuntimeStatus[]): LocalStaleness {
  const stale = runtimes.filter((r) => r.stale);
  if (stale.length === 0) return { stale: false, staleForMs: null, runtimes: [] };
  const ages = stale.map((r) => r.staleForMs).filter((ms): ms is number => ms !== null);
  return {
    stale: true,
    // A retained report with no reported age is still stale; the age is simply
    // unknown, and null says that rather than implying "0ms old".
    staleForMs: ages.length === 0 ? null : Math.max(...ages),
    runtimes: stale.map((r) => r.runtime),
  };
}

/** "12s" / "4m 30s" — how old a retained reading is, for a plain sentence. */
export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'an unreported interval';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function buildLocalModelsView(
  snapshot: LocalModelsSnapshot | null,
  now: number = Date.now(),
): LocalModelsView | null {
  if (!snapshot) return null;
  const rows = snapshot.models
    .map((m) => buildLocalModelRow(m, now))
    .sort((a, b) => Number(b.resident) - Number(a.resident) || a.displayName.localeCompare(b.displayName));

  const resident = rows.filter((r) => r.resident);
  // A resident model with no reported size makes the TOTAL unknown — summing
  // the rest would understate it, and understating a memory figure is exactly
  // the kind of quiet lie this surface refuses.
  const residentBytes = resident.some((r) => r.sizeBytes === null)
    ? null
    : resident.reduce((acc, r) => acc + (r.sizeBytes ?? 0), 0);

  const budget = snapshot.memoryBudgetBytes;
  return {
    reachable: snapshot.reachable,
    reason: snapshot.reason,
    rows,
    residentBytes,
    memoryBudgetBytes: budget,
    memoryUsedPct:
      residentBytes !== null && budget !== null && budget > 0
        ? Math.max(0, Math.min(100, (residentBytes / budget) * 100))
        : null,
    freeMemoryBytes: snapshot.freeMemoryBytes,
    runtimes: snapshot.runtimes,
    notes: snapshot.notes,
    // Three counts, not two: "cannot drive a session" and "the runtime did not
    // say" are different facts, and folding the second into the first would
    // turn an unanswered question into a hard gate.
    agenticCount: rows.filter((r) => r.tools === 'supported').length,
    nonAgenticCount: rows.filter((r) => r.tools === 'unsupported').length,
    unknownToolCount: rows.filter((r) => r.tools === 'unknown').length,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers local to this panel (chartFormat owns counts/currency;
// bytes and countdowns are not in its vocabulary).
// ---------------------------------------------------------------------------

/** Binary-ish GB, matching how Ollama and Activity Monitor talk about models. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${gb.toFixed(0)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${Math.round(mb)} MB`;
}

/** "expires in 4m 12s" material. Past-due reads as expired, never negative. */
export function formatCountdown(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'expired';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * "Qwen3 32B · Q4_K_M" for a model named in running text (the serving
 * runtime's model, a GGUF file name). A wrapper, not a re-export, on
 * purpose: the web UI then reaches core/verse/model-display-name.ts through
 * this one module, so the bundler folds it into this chunk. Imported from a
 * second chunk (a re-export resolves to the original) it became a chunk of
 * its own — one more name in the first-paint files' preload tables.
 */
export function modelNameInText(tag: string): string {
  return modelDisplayText(tag, true);
}
