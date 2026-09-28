/**
 * The Devin CLI's model catalog (3.15): what `devin models list` offers this
 * account, typed, cached, and resolvable — so the Devin (CLI) chat seat, the
 * Resources drawer and (later) the Devin fleet engine all pick models from the
 * same list, with SWE-2 as the default.
 *
 * SOURCE. `devin models list` (checked on devin 3000.11.3, Devin Max plan)
 * prints one block per family:
 *
 *     Available models (52 families)
 *
 *     SWE-2 (swe-2)
 *       aliases: swe
 *       swe-2-high      SWE-2 High  [262K context, Free]
 *       swe-2-medium    SWE-2 Medium  [262K context, Free]
 *
 *     Claude Opus 5.5 (claude-opus-5.5)
 *       claude-opus-5-5-medium   Claude Opus 5.5 Medium  [1M context, $4 / 1M Input · $0.2 / 1M Cached input · $20 / 1M Output, new]
 *
 * A family header "Name (slug)" at column 0, an optional "aliases:" line, then
 * indented rows "id  Display  [context, price…, flags]". Context is "262K",
 * "1M" or a bare count ("202752"); a row may carry no context (Adaptive), a
 * "Free" price, sidekick prices (Fusion) and `new` / `beta` flags. Rows are
 * listed with the family's own default first — the ACP server's model menu
 * names each family by exactly that first row (`swe-2-high`,
 * `claude-opus-5-5-medium`), which is why `resolveDevinModel('swe')` means the
 * first row of the aliased family.
 *
 * NEVER ON A REQUEST PATH. Listing takes a few seconds (it asks Devin's
 * servers), so the catalog is kept in memory, persisted under
 * ~/.ashlr/devin/models-cache.json (the raw listing — re-parsed on read, so
 * the parser is also the validator), and refreshed in the BACKGROUND when
 * older than 6 hours. Every read returns at once: the fresh catalog, a stale
 * one while a refresh runs, or the built-in SWE-2 fallback when nothing was
 * ever listed. Only async fs / child_process calls — never a sync one.
 *
 * GRACEFUL. A missing or logged-out CLI (the shared probe, cli-probe.ts) is
 * never run; a failed listing keeps the last good catalog and is not retried
 * for 10 minutes.
 *
 * API for other lanes (the fleet engine, the router): getDevinModelCatalog(),
 * peekDevinModelCatalog(), resolveDevinModel(idOrAlias), devinDefaultModelId().
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AshlrConfig } from '../types.js';
import { probeDevinCli } from './cli-probe.js';
import { devinHome } from './store.js';

/** The seat's (and fleet's) default when config names none: SWE-2, free on every Devin plan that lists it. */
export const DEVIN_DEFAULT_MODEL = 'swe-2-high';
/** Refresh the listing in the background once it is older than this. */
export const DEVIN_MODELS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** After a failed listing, wait this long before trying again. */
export const DEVIN_MODELS_RETRY_MS = 10 * 60 * 1000;
export const DEVIN_MODELS_CACHE_FILE = 'models-cache.json';
const LIST_TIMEOUT_MS = 30_000;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 4_000;

/** Model ids the CLI accepts (`MODEL_PRIVATE_12` is a real one — hence `_`). */
export const DEVIN_MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

export interface DevinModelPricing {
  /** Listed as "Free" (SWE-2). */
  free: boolean;
  /** USD per 1M tokens; null when not listed. */
  inPerM: number | null;
  outPerM: number | null;
  cachedPerM: number | null;
}

export interface DevinModel {
  /** The family's slug, e.g. `swe-2`. */
  family: string;
  /** The family's display name, e.g. "SWE-2". */
  familyLabel: string;
  /** What `--model` takes, e.g. `swe-2-high`. */
  id: string;
  /** e.g. "SWE-2 High". */
  label: string;
  /** Tokens; null when the listing gives none. "262K" = 262,000 (the CLI reports that window as 262000). */
  contextTokens: number | null;
  pricing: DevinModelPricing;
  isNew: boolean;
  isBeta: boolean;
  /** The FAMILY's aliases (`swe`, `opus`), repeated on each model for convenience. */
  aliases: string[];
}

export interface DevinModelFamily {
  id: string;
  label: string;
  aliases: string[];
  /** In the CLI's order: the family's default first. */
  models: DevinModel[];
}

export interface DevinModelCatalog {
  /** `cli` = listed now; `cache` = read from disk; `fallback` = never listed (built-in SWE-2 only). */
  source: 'cli' | 'cache' | 'fallback';
  /** When the listing was taken (ISO); null for the fallback. */
  fetchedAt: string | null;
  /** The header's "(52 families)", when printed. */
  declaredFamilyCount: number | null;
  /** Families with at least one model, in the CLI's order. */
  families: DevinModelFamily[];
}

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- stripping terminal colour codes is exactly matching ESC
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const HEADER_RE = /^Available models \((\d+) famil(?:y|ies)\)/i;
const FAMILY_RE = /^(\S[^()\n]*?) \(([a-z0-9][a-z0-9._-]{0,80})\)\s*$/i;
const ALIASES_RE = /^\s+aliases:\s*(.+?)\s*$/i;
const ROW_RE = /^\s+(\S+)\s+(.+?)\s+\[([^\]]*)\]\s*$/;
const CONTEXT_RE = /^([\d.]+)\s*([KM])?\s+context$/i;
const PRICE_RE = /^\$([\d.]+)\s*\/\s*1M\s+(.+)$/i;

function positiveNumber(text: string): number | null {
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseContext(part: string): number | null {
  const m = CONTEXT_RE.exec(part);
  if (!m) return null;
  const n = positiveNumber(m[1]!);
  if (n === null) return null;
  const unit = (m[2] ?? '').toUpperCase();
  return Math.round(unit === 'K' ? n * 1_000 : unit === 'M' ? n * 1_000_000 : n);
}

/** The bracket after a row: "262K context, Free" / "1M context, $4 / 1M Input · … , new". Exported for tests. */
export function parseDevinModelMeta(bracket: string): Pick<DevinModel, 'contextTokens' | 'pricing' | 'isNew' | 'isBeta'> {
  const pricing: DevinModelPricing = { free: false, inPerM: null, outPerM: null, cachedPerM: null };
  let contextTokens: number | null = null;
  let isNew = false;
  let isBeta = false;
  for (const raw of bracket.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const lower = part.toLowerCase();
    if (lower === 'free') { pricing.free = true; continue; }
    if (lower === 'new') { isNew = true; continue; }
    if (lower === 'beta') { isBeta = true; continue; }
    const ctx = parseContext(part);
    if (ctx !== null) { contextTokens = ctx; continue; }
    for (const segment of part.split('·')) {
      const price = PRICE_RE.exec(segment.trim());
      if (!price) continue; // "Sidekick: Free" and anything unknown
      const amount = positiveNumber(price[1]!);
      const kind = price[2]!.trim().toLowerCase();
      if (kind === 'input') pricing.inPerM = amount;
      else if (kind === 'output') pricing.outPerM = amount;
      else if (kind === 'cached input') pricing.cachedPerM = amount;
      // Sidekick input/output (Fusion): a second model's price, not this row's.
    }
  }
  if (!pricing.free && pricing.inPerM === 0 && pricing.outPerM === 0) pricing.free = true;
  return { contextTokens, pricing, isNew, isBeta };
}

/** `devin models list` → families (empty families dropped). Pure; never throws. */
export function parseDevinModelsList(text: string): { declaredFamilyCount: number | null; families: DevinModelFamily[] } {
  const families: DevinModelFamily[] = [];
  let declaredFamilyCount: number | null = null;
  let current: DevinModelFamily | null = null;
  let rows = 0;
  const seen = new Set<string>();
  for (const rawLine of String(text ?? '').replace(ANSI, '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    const header = HEADER_RE.exec(line);
    if (header) {
      declaredFamilyCount = Number(header[1]);
      continue;
    }
    if (!/^\s/.test(line)) {
      const fam = FAMILY_RE.exec(line);
      current = fam ? { id: fam[2]!.toLowerCase(), label: fam[1]!.trim().slice(0, 120), aliases: [], models: [] } : null;
      if (current) families.push(current);
      continue;
    }
    if (!current) continue;
    const aliases = ALIASES_RE.exec(line);
    if (aliases) {
      current.aliases = aliases[1]!.split(',').map((a) => a.trim().toLowerCase()).filter((a) => DEVIN_MODEL_ID_RE.test(a)).slice(0, 20);
      for (const model of current.models) model.aliases = [...current.aliases];
      continue;
    }
    const row = ROW_RE.exec(line);
    if (!row || rows >= MAX_ROWS) continue;
    const id = row[1]!;
    if (!DEVIN_MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    rows++;
    current.models.push({
      family: current.id,
      familyLabel: current.label,
      id,
      label: row[2]!.trim().slice(0, 200),
      ...parseDevinModelMeta(row[3]!),
      aliases: [...current.aliases],
    });
  }
  return { declaredFamilyCount, families: families.filter((f) => f.models.length > 0) };
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * Before the first listing (or with no CLI): SWE-2 only — the default must
 * always be offered. Mirrors the 3000.11.3 listing.
 */
export function fallbackDevinModelCatalog(): DevinModelCatalog {
  const variant = (id: string, label: string): DevinModel => ({
    family: 'swe-2', familyLabel: 'SWE-2', id, label, contextTokens: 262_000,
    pricing: { free: true, inPerM: null, outPerM: null, cachedPerM: null }, isNew: false, isBeta: false, aliases: ['swe'],
  });
  const models = [variant('swe-2-high', 'SWE-2 High'), variant('swe-2-medium', 'SWE-2 Medium'), variant('swe-2-max', 'SWE-2 Max')];
  return { source: 'fallback', fetchedAt: null, declaredFamilyCount: null, families: [{ id: 'swe-2', label: 'SWE-2', aliases: ['swe'], models }] };
}

// ---------------------------------------------------------------------------
// Resolution (pure given a catalog)
// ---------------------------------------------------------------------------

/** Every model, in catalog order. */
export function devinCatalogModels(catalog: DevinModelCatalog): DevinModel[] {
  return catalog.families.flatMap((f) => f.models);
}

/**
 * A model id, family slug or alias → the model `--model` should get:
 * an exact id is itself; a family slug (`swe-2`, `claude-opus-5.5`) or an
 * alias (`swe`, `opus`) is that family's first (default) row. Case-insensitive.
 * Null when the catalog has no such name. Default catalog: the latest known
 * (memory), else the fallback.
 */
export function resolveDevinModel(idOrAlias: string | null | undefined, catalog: DevinModelCatalog | null = null): DevinModel | null {
  if (typeof idOrAlias !== 'string') return null;
  const wanted = idOrAlias.trim().toLowerCase();
  if (!wanted || wanted.length > 120) return null;
  const cat = catalog ?? current ?? fallbackDevinModelCatalog();
  for (const family of cat.families) {
    const exact = family.models.find((m) => m.id.toLowerCase() === wanted);
    if (exact) return exact;
  }
  const family = cat.families.find((f) => f.id === wanted)
    ?? cat.families.find((f) => f.aliases.includes(wanted));
  return family?.models[0] ?? null;
}

/** `devin.defaultModel` from config, else SWE-2 High. Just the configured string — resolve it against a catalog. */
export function devinDefaultModelOf(section: AshlrConfig['devin'] | undefined): string {
  const configured = section?.defaultModel;
  return typeof configured === 'string' && DEVIN_MODEL_ID_RE.test(configured.trim()) ? configured.trim() : DEVIN_DEFAULT_MODEL;
}

/**
 * The default model's id, resolved: the configured one when the catalog knows
 * it, else SWE-2 High, else the catalog's first model.
 */
export function devinDefaultModelId(section: AshlrConfig['devin'] | undefined, catalog: DevinModelCatalog | null = null): string {
  const cat = catalog ?? current ?? fallbackDevinModelCatalog();
  return resolveDevinModel(devinDefaultModelOf(section), cat)?.id
    ?? resolveDevinModel(DEVIN_DEFAULT_MODEL, cat)?.id
    ?? devinCatalogModels(cat)[0]?.id
    ?? DEVIN_DEFAULT_MODEL;
}

function money(n: number): string {
  return `$${Number.isInteger(n) ? n : Number(n.toFixed(3))}`;
}

/** "Free" / "$4 in · $20 out per 1M" / null when no price is listed. */
export function devinPriceNote(model: Pick<DevinModel, 'pricing'>): string | null {
  const p = model.pricing;
  if (p.free) return 'Free';
  if (p.inPerM === null && p.outPerM === null) return null;
  const parts = [p.inPerM === null ? null : `${money(p.inPerM)} in`, p.outPerM === null ? null : `${money(p.outPerM)} out`].filter(Boolean);
  return `${parts.join(' · ')} per 1M`;
}

/** "262K ctx" / "1M ctx" / null. */
export function devinContextNote(model: Pick<DevinModel, 'contextTokens'>): string | null {
  const n = model.contextTokens;
  if (n === null || n <= 0) return null;
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M ctx`;
  return `${Math.round(n / 1_000)}K ctx`;
}

/** A family is free when every model in it is. */
export function devinFamilyIsFree(family: DevinModelFamily): boolean {
  return family.models.length > 0 && family.models.every((m) => m.pricing.free);
}

/** What the Resources card says about the catalog. Pure. */
export interface DevinModelsSummary {
  source: DevinModelCatalog['source'];
  fetchedAt: string | null;
  /** Labels of the free families ("SWE-2"). */
  freeFamilies: string[];
  paidFamilyCount: number;
  defaultModel: { id: string; label: string; free: boolean; price: string | null };
}

export function summarizeDevinModels(catalog: DevinModelCatalog, section: AshlrConfig['devin'] | undefined): DevinModelsSummary {
  const defaultId = devinDefaultModelId(section, catalog);
  const model = resolveDevinModel(defaultId, catalog);
  return {
    source: catalog.source,
    fetchedAt: catalog.fetchedAt,
    freeFamilies: catalog.families.filter(devinFamilyIsFree).map((f) => f.label),
    paidFamilyCount: catalog.families.filter((f) => !devinFamilyIsFree(f)).length,
    defaultModel: {
      id: defaultId,
      label: model?.label ?? defaultId,
      free: model?.pricing.free === true,
      price: model ? devinPriceNote(model) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Cache + background refresh
// ---------------------------------------------------------------------------

export interface DevinModelCatalogOptions {
  /**
   * The CLI to list with. Omitted: ask the shared probe (a missing or
   * logged-out CLI is never run). `null`: never list — memory / disk /
   * fallback only.
   */
  cliPath?: string | null;
  /** Refresh when the catalog is older than this. Default 6 h. */
  maxAgeMs?: number;
  /** Await a refresh when one is due (the CLI; never a Verse request). Default false. */
  wait?: boolean;
  /** Runs `devin models list` and returns stdout (tests). */
  runList?: (cliPath: string) => Promise<string>;
  /** Where the listing is persisted (tests; default ~/.ashlr/devin/models-cache.json). */
  cachePath?: string;
  now?: () => number;
}

let current: DevinModelCatalog | null = null;
let diskRead: Promise<void> | null = null;
let refreshing: Promise<DevinModelCatalog | null> | null = null;
let lastFailureAt: number | null = null;

export function devinModelsCachePath(): string {
  return join(devinHome(), DEVIN_MODELS_CACHE_FILE);
}

function defaultRunList(cliPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, ['models', 'list'], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: MAX_LIST_BYTES,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

function catalogFrom(text: string, source: 'cli' | 'cache', fetchedAt: string): DevinModelCatalog | null {
  const parsed = parseDevinModelsList(text);
  if (parsed.families.length === 0) return null;
  return { source, fetchedAt, declaredFamilyCount: parsed.declaredFamilyCount, families: parsed.families };
}

async function readDiskCache(path: string): Promise<DevinModelCatalog | null> {
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > MAX_LIST_BYTES * 2) return null;
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object') return null;
    const { v, fetchedAt, text } = value as Record<string, unknown>;
    if (v !== 1 || typeof fetchedAt !== 'string' || !Number.isFinite(Date.parse(fetchedAt)) || typeof text !== 'string') return null;
    return catalogFrom(text, 'cache', new Date(Date.parse(fetchedAt)).toISOString());
  } catch {
    return null;
  }
}

async function writeDiskCache(path: string, fetchedAt: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify({ v: 1, fetchedAt, text })}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } catch {
    await unlink(tmp).catch(() => undefined);
  }
}

function ageMs(catalog: DevinModelCatalog | null, now: number): number {
  if (!catalog || catalog.fetchedAt === null) return Number.POSITIVE_INFINITY;
  return now - Date.parse(catalog.fetchedAt);
}

/** Run one listing; on success replace memory + disk. Never throws; null on failure. */
async function refresh(cliPath: string, opts: DevinModelCatalogOptions, now: () => number): Promise<DevinModelCatalog | null> {
  try {
    const text = await (opts.runList ?? defaultRunList)(cliPath);
    const fetchedAt = new Date(now()).toISOString();
    const catalog = catalogFrom(text, 'cli', fetchedAt);
    if (!catalog) {
      lastFailureAt = now();
      return null;
    }
    current = catalog;
    lastFailureAt = null;
    await writeDiskCache(opts.cachePath ?? devinModelsCachePath(), fetchedAt, text);
    return catalog;
  } catch {
    lastFailureAt = now();
    return null;
  }
}

/**
 * The catalog, at once: memory, else the disk cache, else the fallback. When
 * it is older than `maxAgeMs` (or was never listed) and a runnable CLI is
 * known, a listing starts in the background (single-flight; not retried for
 * 10 minutes after a failure). `wait: true` awaits that listing.
 */
export async function getDevinModelCatalog(opts: DevinModelCatalogOptions = {}): Promise<DevinModelCatalog> {
  const now = opts.now ?? Date.now;
  const maxAge = typeof opts.maxAgeMs === 'number' && opts.maxAgeMs >= 0 ? opts.maxAgeMs : DEVIN_MODELS_MAX_AGE_MS;
  if (!current) {
    diskRead ??= readDiskCache(opts.cachePath ?? devinModelsCachePath()).then((cached) => {
      if (cached && !current) current = cached;
    });
    await diskRead;
  }
  const due = ageMs(current, now()) > maxAge && (lastFailureAt === null || now() - lastFailureAt >= DEVIN_MODELS_RETRY_MS);
  if (due && opts.cliPath !== null) {
    if (!refreshing) {
      const started = (async () => {
        let cliPath = opts.cliPath;
        if (cliPath === undefined) {
          const probe = await probeDevinCli();
          cliPath = probe.state === 'ready' ? probe.cliPath : null;
        }
        if (!cliPath || !cliPath.startsWith('/')) return null;
        return refresh(cliPath, opts, now);
      })().catch(() => null).finally(() => { refreshing = null; });
      refreshing = started;
    }
  }
  // Also a listing an earlier call started (it may still be persisting).
  if (opts.wait && refreshing) await refreshing;
  return current ?? fallbackDevinModelCatalog();
}

/** The latest catalog in memory, or null before the first read. Sync — for the adapter building a turn. */
export function peekDevinModelCatalog(): DevinModelCatalog | null {
  return current;
}

/** Test hook: forget everything in memory. */
export function resetDevinModelCatalogForTest(): void {
  current = null;
  diskRead = null;
  refreshing = null;
  lastFailureAt = null;
}
