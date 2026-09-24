/**
 * core/verse/model-windows.ts — the per-model context budgets every seat is
 * built from (Verse 3.9, owner U4). docs/VERSE-CONTEXT.md §1 is the prose
 * authority; every number below was read from a CLI or a seat's own catalog on
 * 2026-09-23, never recalled.
 *
 * WHY THIS MODULE EXISTS. Until 3.9 every model option carried one number, and
 * for six of the eight Claude models it was wrong: they all inherited the
 * CLI's 200k "unknown model" fallback while the CLI itself ran them at 1M.
 * Codex showed its RAW 272k window while the CLI measures against 95% of it,
 * and Grok showed 256k against a 500k window. So the meter under- or
 * over-read on every native engine. This module is the single place a seat's
 * model list — windows, compaction points, expansive budgets and the binary
 * each model needs — is assembled, and it does the arithmetic ONLY through
 * `context-math.ts`, so "compacts at 367k" can never mean two numbers.
 *
 * SOURCES, in the order a seat prefers them:
 *
 *  Claude — the CLI's EMBEDDED catalog (`windowSource: 'cli-catalog'`). There
 *    is no per-seat file to read: the served catalog cache carries no windows
 *    (`max_input_tokens` absent on every row), so the binary is the authority.
 *    The table below is transcribed from the 2.1.257 and 2.1.280 binaries.
 *  Codex  — the seat's OWN `native-state/models_cache.json`
 *    (`provider-catalog`). Catalogs differ per ACCOUNT (codex-b lacks the
 *    daybreak slug the global cache has) and per BINARY, so the unpinned
 *    `~/.codex` cache is never consulted. No catalog yet → a documented list.
 *  Grok   — the seat's OWN `native-state/models_cache.json`, whose `.models`
 *    is a dict of `{info, api_key, env_key, api_base_url}`. ONLY `.info` is
 *    ever read: `api_key` is a credential slot and must not be touched, copied
 *    or returned, even though it is null today.
 *
 * Runtime readings (claude/grok `result.modelUsage`, codex rollouts) override
 * all of this per turn — see the session engine. These are the STARTING
 * budgets and the picker's promises, not the last word.
 *
 * Nothing here throws, spends, or reaches the network. File reads are
 * size-capped, symlink-refusing and cached by path + mtime + size.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  CLAUDE_STANDARD_AUTOCOMPACT_WINDOW,
  canonicalModelId,
  claudeAutoCompactAt,
  codexAutoCompactAt,
  codexEffectiveWindow,
  grokAutoCompactAt,
} from './context-math.js';
import {
  VERSE_DEFAULT_CONTEXT_WINDOWS,
  type VerseContextBudget,
  type VerseEngine,
  type VerseModelOption,
  type VerseWindowSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Claude — transcribed from the CLI's embedded catalog
// ---------------------------------------------------------------------------

/**
 * Every Claude model a seat offers, in picker order (first runnable = default).
 *
 * Transcribed from the embedded catalog of Claude Code 2.1.257 and 2.1.280
 * (`context.window`, `context.native_1m`, `max_output_tokens.default`):
 *
 *  - `native1m` is the catalog's own `native_1m` flag: the CLI runs these at
 *    1M with no `[1m]` suffix on a first-party seat. Never append `[1m]` to a
 *    200k model — the CLI would then CLAIM 1M for a model that has 200k.
 *  - `maxOutputTokens` is the catalog DEFAULT, not the upper bound: it is the
 *    number Claude Code reserves from (capped at 20k) when it computes the
 *    compaction point, which is all Verse uses it for.
 *  - `minCliVersion` is set only where a binary genuinely lacks the id.
 *    `claude-opus-5-5` is absent from 2.1.257 (0 occurrences) and present in
 *    2.1.280, and the served catalog cache says `min_claude_code_version:
 *    "2.1.280"`. An older binary does not reject it — its id normaliser falls
 *    back to `includes('claude-opus-5')` and silently runs Opus 5 — which is
 *    why a too-old seat lists it as UNAVAILABLE instead of offering it.
 *
 * The dotted `claude-opus-5.5` Verse once shipped is an ALIAS (context-math
 * `VERSE_MODEL_ID_ALIASES`): on every binary it resolves to Opus 5. It is
 * never offered; old records keep it and adapters send the canonical id.
 *
 * `claude-mythos-5` / `-5-1` are in the catalog too but are deliberately not
 * offered: whether a subscription seat may use them is unverified, and a
 * picker entry is a promise.
 */
export const VERSE_CLAUDE_MODEL_SPECS: readonly {
  id: string;
  label: string;
  contextWindow: number;
  maxOutputTokens: number | null;
  minCliVersion: string | null;
  native1m: boolean;
}[] = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', contextWindow: 1_000_000, maxOutputTokens: 64_000, minCliVersion: null, native1m: true },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, minCliVersion: '2.1.280', native1m: true },
  { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindow: 1_000_000, maxOutputTokens: 64_000, minCliVersion: null, native1m: true },
  { id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 1_000_000, maxOutputTokens: 64_000, minCliVersion: null, native1m: true },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000, maxOutputTokens: 64_000, minCliVersion: null, native1m: true },
  // 200k and NOT native_1m: no expansive mode, no --autocompact flag.
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', contextWindow: 200_000, maxOutputTokens: 32_000, minCliVersion: null, native1m: false },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 1_000_000, maxOutputTokens: 64_000, minCliVersion: null, native1m: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200_000, maxOutputTokens: 32_000, minCliVersion: null, native1m: false },
];

type ClaudeModelSpec = (typeof VERSE_CLAUDE_MODEL_SPECS)[number];

/**
 * The spec for a model id, after alias canonicalisation — so an old session
 * stored as `claude-opus-5.5` finds Opus 5.5's budget. A trailing `[1m]`
 * (which the CLI strips from native-1M ids anyway) is tolerated. Null for an
 * id this table does not know: the caller falls back to the seat, then to
 * `VERSE_DEFAULT_CONTEXT_WINDOWS.claude` — never to a guess.
 */
export function claudeSpecFor(modelId: string): ClaudeModelSpec | null {
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  const canonical = canonicalModelId(modelId.trim());
  const bare = canonical.replace(/\[1m\]$/i, '');
  return VERSE_CLAUDE_MODEL_SPECS.find((spec) => spec.id === canonical || spec.id === bare) ?? null;
}

/** "Claude Opus 5.5" → "Opus 5.5" — how the CLI and the seat notes name a model. */
function shortClaudeLabel(label: string): string {
  return label.replace(/^Claude\s+/, '');
}

/**
 * One Claude spec as a model option on a seat pinned to `cliVersion`.
 *
 * Standard budget: 1M-native models run at `--autocompact 400000` (compaction
 * at 367k); 200k models compact natively (167k). Expansive exists only for
 * 1M-native models: the CLI's `auto` window, compacting at 967k — the
 * `pre_tokens` observed on real compactions.
 */
function claudeOption(spec: ClaudeModelSpec, cliVersion: string | null): VerseModelOption {
  const window = spec.contextWindow;
  const expansive: VerseContextBudget | null = spec.native1m
    ? { contextWindow: window, autoCompactAt: claudeAutoCompactAt(window, spec.maxOutputTokens, null) }
    : null;
  const standardCap = spec.native1m && window > CLAUDE_STANDARD_AUTOCOMPACT_WINDOW
    ? CLAUDE_STANDARD_AUTOCOMPACT_WINDOW
    : null;
  const tooOld = spec.minCliVersion !== null
    && cliVersion !== null
    && compareCliVersions(cliVersion, spec.minCliVersion) < 0;
  return {
    id: spec.id,
    label: spec.label,
    contextWindow: window,
    autoCompactAt: claudeAutoCompactAt(window, spec.maxOutputTokens, standardCap),
    ...(expansive ? { expansive } : {}),
    maxOutputTokens: spec.maxOutputTokens,
    windowSource: 'cli-catalog',
    minCliVersion: spec.minCliVersion,
    unavailableReason: tooOld
      ? `needs Claude Code ${spec.minCliVersion}; this seat runs ${cliVersion}`
      : null,
  };
}

/**
 * The Claude model list for a seat pinned to `cliVersion`.
 *
 * `cliVersion === null` means UNKNOWN, and unknown is not "too old": no model
 * is marked unavailable on a guess (the seat carries a note instead). Order is
 * the table's; callers put runnable models first.
 */
export function claudeModelOptions(cliVersion: string | null): VerseModelOption[] {
  return VERSE_CLAUDE_MODEL_SPECS.map((spec) => claudeOption(spec, cliVersion));
}

/** Specs a binary of `cliVersion` is too old for (empty when the version is unknown). */
export function claudeModelsNeedingNewerCli(cliVersion: string | null): ClaudeModelSpec[] {
  if (cliVersion === null) return [];
  return VERSE_CLAUDE_MODEL_SPECS.filter(
    (spec) => spec.minCliVersion !== null && compareCliVersions(cliVersion, spec.minCliVersion) < 0,
  );
}

/** Labels for a note: "Opus 5.5", "Opus 5.5 and Fable 6", "A, B and C". */
export function joinClaudeLabels(specs: readonly ClaudeModelSpec[]): string {
  const labels = specs.map((s) => shortClaudeLabel(s.label));
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// ---------------------------------------------------------------------------
// CLI versions
// ---------------------------------------------------------------------------

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?/;

/**
 * Compare two CLI versions: negative when `a` is older, 0 when equal, positive
 * when newer. Numeric per segment (2.1.280 > 2.1.257 > 2.1.99), and a
 * pre-release sorts before its release (0.155.0-alpha.9 < 0.155.0). Strings
 * with no `x.y.z` in them compare equal to each other and older than any real
 * version — an unparseable version is never allowed to unlock a model.
 */
export function compareCliVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const preA = pa[4] ?? null;
  const preB = pb[4] ?? null;
  if (preA === preB) return 0;
  if (preA === null) return 1;
  if (preB === null) return -1;
  return preA.localeCompare(preB, 'en', { numeric: true }) < 0 ? -1 : 1;
}

const MAX_PACKAGE_JSON_BYTES = 64 * 1024;

/**
 * The version of the CLI a native profile is pinned to, from the executable
 * path its launcher execs. Never runs the binary (that would be a process
 * spawn on the discovery path, and some CLIs phone home on `--version`).
 *
 *  - Claude Code installs each version as a file NAMED by it:
 *    `~/.local/share/claude/versions/2.1.257` → `2.1.257`.
 *  - Grok's downloads embed it: `grok-0.2.118-macos-aarch64` → `0.2.118`.
 *  - The npm codex wrapper is `…/@openai/codex/bin/codex.js`; its version is
 *    the package's own `package.json`, read with a size cap.
 *
 * Anything else (e.g. the codex binary inside ChatGPT.app) is null: unknown,
 * which is reported as unknown rather than guessed from a neighbour.
 */
export function cliVersionFromExecutable(executablePath: string): string | null {
  if (typeof executablePath !== 'string' || executablePath.length === 0) return null;
  const name = basename(executablePath);
  // Only the X.Y.Z core from a file name: `grok-0.2.118-macos-aarch64` has a
  // platform suffix that is not a pre-release tag.
  const fromName = /(?:^|[^0-9.])(\d+\.\d+\.\d+)(?=$|[^0-9.])/.exec(`-${name}`);
  if (fromName) return fromName[1]!;
  if (name === 'codex.js' || name === 'codex') {
    const pkg = readCappedJson(join(dirname(dirname(executablePath)), 'package.json'), MAX_PACKAGE_JSON_BYTES);
    if (isRecord(pkg) && typeof pkg['version'] === 'string' && VERSION_RE.test(pkg['version'])
      && (pkg['name'] === undefined || pkg['name'] === '@openai/codex')) {
      return pkg['version'].slice(0, 64);
    }
  }
  return null;
}

/** Where Claude Code's installer keeps one file per installed version. */
export function defaultClaudeVersionsRoot(home: string = homedir()): string {
  return join(home, '.local', 'share', 'claude', 'versions');
}

/**
 * The newest Claude Code version installed on this machine, or null. Only
 * regular files named exactly `x.y.z` count — the installer's lock and
 * partial-download files are skipped.
 */
export function newestInstalledClaudeVersion(root: string = defaultClaudeVersionsRoot()): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  let best: string | null = null;
  for (const name of entries.slice(0, 256)) {
    if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
    try {
      if (!statSync(join(root, name)).isFile()) continue;
    } catch {
      continue;
    }
    if (best === null || compareCliVersions(name, best) > 0) best = name;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Bounded, cached file reads
// ---------------------------------------------------------------------------

/** Every catalog read is capped here — codex's is ~350 KB today. */
export const VERSE_CATALOG_MAX_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: unknown;
}

const fileCache = new Map<string, CacheEntry>();

/** Test seam: forget every cached catalog read. */
export function resetModelWindowCaches(): void {
  fileCache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read and parse a JSON file WITHOUT following a symlink at its final
 * component, refusing anything that is not a regular file or is over
 * `maxBytes`, and parsing it through `parse` exactly once per (path, mtime,
 * size). The cached value is the PARSED result, so a 350 KB catalog is not
 * re-parsed on every seat poll. Returns null on any failure.
 */
function readCachedFile<T>(path: string, maxBytes: number, kind: string, parse: (raw: unknown) => T | null): T | null {
  let fd: number | null = null;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
    const key = `${kind}\u0000${path}`;
    const cached = fileCache.get(key);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.value as T | null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(buf.subarray(0, read).toString('utf8')) as unknown;
    } catch {
      raw = undefined;
    }
    const value = raw === undefined ? null : parse(raw);
    if (fileCache.size >= MAX_CACHE_ENTRIES) fileCache.clear();
    fileCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function readCappedJson(path: string, maxBytes: number): unknown {
  return readCachedFile(path, maxBytes, 'json', (raw) => raw);
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function percentOrNull(value: unknown): number | null {
  const n = positiveInt(value);
  return n !== null && n <= 100 ? n : null;
}

/**
 * A model id that is safe to put on an argv as `--model <id>`: what every
 * provider id looks like, and nothing that could read as a flag or carry
 * whitespace. A catalog row with anything else is skipped, not sanitised.
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function labelOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Codex — the seat's own models_cache.json
// ---------------------------------------------------------------------------

/** One row of a codex `models_cache.json`, reduced to what budgets need. */
export interface CodexCatalogEntry {
  slug: string;
  displayName: string | null;
  /** `list`, `hide`, … — `hide` rows are never offered. */
  visibility: string | null;
  /** RAW window the model is configured with by default (272_000). */
  contextWindow: number;
  /** Largest window `model_context_window` may be raised to (872_000); null when absent. */
  maxContextWindow: number | null;
  /** Share of the raw window the CLI measures against (95); null → the documented default. */
  effectiveContextWindowPercent: number | null;
  /** Explicit auto-compaction limit from the catalog; null → 90% of the raw window. */
  autoCompactTokenLimit: number | null;
  priority: number | null;
}

function parseCodexCatalog(raw: unknown): CodexCatalogEntry[] | null {
  if (!isRecord(raw) || !Array.isArray(raw['models'])) return null;
  const out: CodexCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const row of raw['models'].slice(0, 256)) {
    if (!isRecord(row)) continue;
    const slug = row['slug'];
    if (typeof slug !== 'string' || !MODEL_ID_RE.test(slug) || seen.has(slug)) continue;
    const contextWindow = positiveInt(row['context_window']);
    if (contextWindow === null) continue;
    seen.add(slug);
    out.push({
      slug,
      displayName: labelOrNull(row['display_name']),
      visibility: typeof row['visibility'] === 'string' ? row['visibility'] : null,
      contextWindow,
      maxContextWindow: positiveInt(row['max_context_window']),
      effectiveContextWindowPercent: percentOrNull(row['effective_context_window_percent']),
      autoCompactTokenLimit: positiveInt(row['auto_compact_token_limit']),
      priority: typeof row['priority'] === 'number' && Number.isFinite(row['priority']) ? row['priority'] : null,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * The seat's own codex catalog, or null when it has none yet (a seat that has
 * never run a turn has not fetched one) or it is unreadable. `nativeStatePath`
 * is the seat profile's `CODEX_HOME` — NEVER the unpinned `~/.codex`, whose
 * catalog belongs to a different account and binary.
 */
export function readCodexCatalog(nativeStatePath: string): CodexCatalogEntry[] | null {
  if (typeof nativeStatePath !== 'string' || nativeStatePath.length === 0) return null;
  return readCachedFile(join(nativeStatePath, 'models_cache.json'), VERSE_CATALOG_MAX_BYTES, 'codex', parseCodexCatalog);
}

/**
 * The documented list a codex seat offers before its first turn fetches a
 * catalog: the slugs every current codex catalog carries, with the windows
 * those catalogs report (272k raw, 872k max, 95% effective; gpt-5.5 has no
 * larger window). Hidden slugs (`gpt-reserve`, `codex-auto-review`) are not
 * here — they are not offered even when a catalog lists them.
 */
const CODEX_DOCUMENTED_MODELS: readonly CodexCatalogEntry[] = [
  ['gpt-6-astra', 'GPT-6 Astra', 872_000],
  ['gpt-6-sol', 'GPT-6 Sol', 872_000],
  ['gpt-6-luna', 'GPT-6 Luna', 872_000],
  ['gpt-5.6-sol', 'GPT-5.6 Sol', 872_000],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', 872_000],
  ['gpt-5.6-luna', 'GPT-5.6 Luna', 872_000],
  ['gpt-5.5', 'GPT-5.5', 272_000],
].map(([slug, displayName, max]) => ({
  slug: slug as string,
  displayName: displayName as string,
  visibility: 'list',
  contextWindow: 272_000,
  maxContextWindow: max as number,
  effectiveContextWindowPercent: 95,
  autoCompactTokenLimit: null,
  priority: null,
}));

function codexOption(entry: CodexCatalogEntry, source: VerseWindowSource): VerseModelOption {
  const pct = entry.effectiveContextWindowPercent;
  const max = entry.maxContextWindow;
  // Expansive only where the catalog offers a genuinely larger window. The
  // adapter must pass BOTH `-c model_context_window=<providerWindow>` and
  // `-c model_auto_compact_token_limit=<autoCompactAt>`: raising only the
  // window breaks codex's auto-compaction (openai/codex#16068).
  const expansive: VerseContextBudget | null = max !== null && max > entry.contextWindow
    ? { contextWindow: codexEffectiveWindow(max, pct), autoCompactAt: codexAutoCompactAt(max), providerWindow: max }
    : null;
  return {
    id: entry.slug,
    label: entry.displayName ?? entry.slug,
    // The EFFECTIVE window: what codex's own rollouts report as
    // `model_context_window` (258_400 for every 272k model).
    contextWindow: codexEffectiveWindow(entry.contextWindow, pct),
    autoCompactAt: entry.autoCompactTokenLimit ?? codexAutoCompactAt(entry.contextWindow),
    ...(expansive ? { expansive } : {}),
    windowSource: source,
    minCliVersion: null,
    unavailableReason: null,
  };
}

/** Catalog order is the provider's priority; ties and unranked rows keep file order. */
function byPriority(entries: readonly CodexCatalogEntry[]): CodexCatalogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const pa = a.entry.priority ?? Number.POSITIVE_INFINITY;
      const pb = b.entry.priority ?? Number.POSITIVE_INFINITY;
      return pa === pb ? a.index - b.index : pa - pb;
    })
    .map(({ entry }) => entry);
}

/**
 * A codex seat's model list: every VISIBLE slug in its own catalog, in the
 * provider's priority order, or the documented list (`windowSource:
 * 'documented'`) when the seat has not fetched a catalog yet.
 */
export function codexModelOptions(catalog: CodexCatalogEntry[] | null): VerseModelOption[] {
  const visible = (catalog ?? []).filter((entry) => entry.visibility !== 'hide');
  if (visible.length === 0) return CODEX_DOCUMENTED_MODELS.map((entry) => codexOption(entry, 'documented'));
  return byPriority(visible).map((entry) => codexOption(entry, 'provider-catalog'));
}

// ---------------------------------------------------------------------------
// Grok — the seat's own models_cache.json (ONLY `.info`)
// ---------------------------------------------------------------------------

/** One grok catalog row, lifted out of `.models[id].info` and nothing else. */
export interface GrokCatalogEntry {
  id: string;
  name: string | null;
  contextWindow: number | null;
  autoCompactThresholdPercent: number | null;
  maxCompletionTokens: number | null;
  hidden: boolean;
  supportedInApi: boolean;
}

function parseGrokCatalog(raw: unknown): GrokCatalogEntry[] | null {
  if (!isRecord(raw) || !isRecord(raw['models'])) return null;
  const out: GrokCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(raw['models']).slice(0, 256)) {
    if (!isRecord(entry)) continue;
    // `.info` ONLY. The sibling `api_key` / `env_key` slots are credential
    // material and are never read, copied or compared — not even for null.
    const info = entry['info'];
    if (!isRecord(info)) continue;
    const idRaw = typeof info['id'] === 'string' ? info['id'] : key;
    if (!MODEL_ID_RE.test(idRaw) || seen.has(idRaw)) continue;
    seen.add(idRaw);
    out.push({
      id: idRaw,
      name: labelOrNull(info['name']),
      contextWindow: positiveInt(info['context_window']),
      autoCompactThresholdPercent: percentOrNull(info['auto_compact_threshold_percent']),
      maxCompletionTokens: positiveInt(info['max_completion_tokens']),
      hidden: info['hidden'] === true,
      supportedInApi: info['supported_in_api'] !== false,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * The seat's own grok catalog (`<GROK_HOME>/models_cache.json`), or null. The
 * unpinned `~/.grok` cache is stale on this machine (fetched weeks earlier,
 * two models) and is never consulted.
 */
export function readGrokCatalog(nativeStatePath: string): GrokCatalogEntry[] | null {
  if (typeof nativeStatePath !== 'string' || nativeStatePath.length === 0) return null;
  return readCachedFile(join(nativeStatePath, 'models_cache.json'), VERSE_CATALOG_MAX_BYTES, 'grok', parseGrokCatalog);
}

/** Grok 0.2.118's catalog, for a seat that has none yet. Names are the catalog's. */
const GROK_DOCUMENTED_MODELS: readonly GrokCatalogEntry[] = [
  ['grok-4.7', 'Grok 4.7'],
  ['grok-4.7-build-fast', 'Grok 4.7 Fast'],
  ['grok-4.6', 'Grok 4.6'],
  ['grok-4.5', 'Grok 4.5'],
].map(([id, name]) => ({
  id: id as string,
  name: name as string,
  contextWindow: 500_000,
  autoCompactThresholdPercent: 80,
  maxCompletionTokens: null,
  hidden: false,
  supportedInApi: true,
}));

function grokOption(entry: GrokCatalogEntry, source: VerseWindowSource): VerseModelOption {
  const window = entry.contextWindow ?? VERSE_DEFAULT_CONTEXT_WINDOWS['grok'] ?? 500_000;
  return {
    id: entry.id,
    label: entry.name ?? entry.id,
    contextWindow: window,
    autoCompactAt: grokAutoCompactAt(window, entry.autoCompactThresholdPercent),
    ...(entry.maxCompletionTokens !== null ? { maxOutputTokens: entry.maxCompletionTokens } : {}),
    // A row without a window got the named default, and says so.
    windowSource: entry.contextWindow === null ? 'fallback' : source,
    minCliVersion: null,
    unavailableReason: null,
  };
}

/**
 * A grok seat's model list: every entry that is not hidden and not flagged
 * unsupported, in the catalog's own order (JSON object order is preserved and
 * is the CLI's), or the documented list when the seat has no catalog. Grok has
 * no expansive mode: its CLI cannot be told a larger budget per invocation.
 */
export function grokModelOptions(catalog: GrokCatalogEntry[] | null): VerseModelOption[] {
  const offered = (catalog ?? []).filter((entry) => !entry.hidden && entry.supportedInApi);
  if (offered.length === 0) return GROK_DOCUMENTED_MODELS.map((entry) => grokOption(entry, 'documented'));
  return offered.map((entry) => grokOption(entry, 'provider-catalog'));
}

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

/**
 * A local (Ollama / llama-server) model option. Local turns run the Claude
 * Code binary with `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<window>`, so they compact
 * by the Claude formula over the window Verse resolved; max output is unknown
 * for a non-Claude id, which the formula treats as the 20k reserve cap. No
 * expansive mode: the window IS the runtime's allocation.
 */
export function localModelOption(tag: string, label: string, window: number, source: VerseWindowSource): VerseModelOption {
  // Below ~33k the formula reaches zero: the 20k reply reserve plus the 13k
  // buffer swallow the whole window, so there is no meaningful point at which
  // the CLI "will compact". Null (unknown) says that; a 0 would draw a tick at
  // the left edge of the meter and claim every turn is past compaction.
  const compactAt = claudeAutoCompactAt(window, null, null);
  return {
    id: tag,
    label,
    contextWindow: window,
    autoCompactAt: compactAt > 0 ? compactAt : null,
    windowSource: source,
  };
}

// ---------------------------------------------------------------------------
// Launch snapshots written before 3.9
// ---------------------------------------------------------------------------

/** Whether an option was built by the V3.9 catalog (it states its budgets), rather than read from an older launch snapshot. */
function hasCatalogBudgets(option: VerseModelOption): boolean {
  return option.autoCompactAt !== undefined || option.expansive !== undefined || option.windowSource !== undefined;
}

/** The documented V3.9 option for a model id on an engine, or null when this module has none. */
function documentedOption(engine: VerseEngine, model: string): VerseModelOption | null {
  const wanted = canonicalModelId(model);
  switch (engine) {
    case 'claude': {
      const spec = claudeSpecFor(model);
      return spec ? claudeOption(spec, null) : null;
    }
    case 'codex':
      return codexModelOptions(null).find((m) => canonicalModelId(m.id) === wanted) ?? null;
    case 'grok':
      return grokModelOptions(null).find((m) => canonicalModelId(m.id) === wanted) ?? null;
    default:
      // Local windows are the runtime's allocation at discovery time, not a
      // property of the tag; there is nothing documented to fall back to (the
      // engine refreshes them from live discovery instead — `refreshLocalWindow`).
      return null;
  }
}

/**
 * The option whose budgets govern a session, given the option its PINNED
 * launch snapshot lists (`snapshot`, null when the snapshot no longer lists
 * the model).
 *
 * Normally the snapshot's own option. The exception is a snapshot written
 * before 3.9: its options carry one flat window and no budgets (claude: the
 * CLI's 200k fallback for every model; codex: the RAW 272k window, which the
 * CLI measures against 95% of; grok: the 500k default), so it can state
 * neither a compaction point nor an expansive budget. For those, the model's
 * DOCUMENTED option from this module supplies the budgets — the same builders
 * the live seat lists are made from, so the web UI (which reads the live seat)
 * and the engine and adapters (which read the snapshot) can never disagree
 * about whether a mode exists or what it costs. The snapshot keeps its identity
 * (id, label); only budgets are borrowed.
 *
 * ONE helper, used by the engine (`effectiveModelOption`) and by every adapter
 * that turns a budget into CLI flags (claude `--autocompact`, codex
 * `-c model_context_window`), because two copies of this rule would drift and
 * the flag the CLI is given must be the budget the meter shows.
 *
 * A model this module does not know keeps its snapshot option (and, lacking an
 * expansive budget, gets no expansive mode — absent, never faked). Local is
 * never substituted.
 */
export function legacyModelOptionFallback(
  engine: VerseEngine,
  model: string,
  snapshot: VerseModelOption | null,
): VerseModelOption | null {
  if (snapshot && hasCatalogBudgets(snapshot)) return snapshot;
  const known = documentedOption(engine, snapshot?.id ?? model);
  if (!known) return snapshot;
  return { ...known, id: snapshot?.id ?? model, label: snapshot?.label ?? known.label, unavailableReason: null };
}
