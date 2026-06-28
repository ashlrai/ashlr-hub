/**
 * localize.ts — M154: heuristic work-item localization.
 *
 * Given a WorkItem (title + detail + optional hinted files) and a RepoMap,
 * produce a tight ranked set of candidate edit-location files + symbols.
 * Pure/heuristic — zero LLM calls, never throws.
 *
 * Ranking heuristic (highest → lowest priority):
 *   1. Files explicitly listed in item.files (exact, if the field exists)
 *   2. Files whose path contains a keyword from the item title/detail
 *   3. Files that export a symbol whose name contains a keyword
 *   4. High-refCount files (general context — ranked by centrality)
 *
 * The result is capped at MAX_FILES candidates to keep engine context tight.
 */

import type { RepoMap, RepoMapFile } from './repo-map.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal shape of a work item needed for localization. */
export interface LocalizeItem {
  title: string;
  detail?: string;
  /** Optional pre-hinted file paths (repo-relative or absolute). */
  files?: string[];
}

/** Localization result. */
export interface LocalizeResult {
  /** Repo-relative paths of candidate edit locations, ranked by confidence. */
  files: string[];
  /**
   * Symbol names that matched a keyword from the item.
   * Useful as additional context for the engine prompt.
   */
  symbols: string[];
  /** Human-readable explanation of how the set was selected. */
  reason: string;
}

/** Options for localize(). */
export interface LocalizeOptions {
  /** Max candidate files to return (default 10). */
  maxFiles?: number;
  /** Max keywords extracted from title+detail (default 20). */
  maxKeywords?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cap for candidate files returned. */
const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_KEYWORDS = 20;

/** Minimum keyword length to avoid noise from common words. */
const MIN_KW_LEN = 3;

/** Common English stop-words to skip. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'has', 'was',
  'not', 'but', 'its', 'also', 'can', 'will', 'when', 'all', 'any', 'use',
  'add', 'run', 'get', 'set', 'new', 'old', 'via', 'per', 'out', 'fix',
  'bug', 'todo', 'fixme', 'hack', 'xxx',
]);

/**
 * Extract lowercased keyword tokens from text. Splits on non-alphanumeric,
 * deduplicates, filters stop-words and short tokens.
 */
function extractKeywords(text: string, max: number): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9_]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw) {
    if (tok.length < MIN_KW_LEN) continue;
    if (STOP_WORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Score a repo-map file against a keyword set.
 * Returns a non-negative integer (higher = better match).
 */
function scoreFile(file: RepoMapFile, keywords: string[]): number {
  const pathLower = file.path.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (pathLower.includes(kw)) score += 2;
    for (const sym of file.symbols) {
      if (sym.name.toLowerCase().includes(kw)) score += 1;
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a ranked candidate edit-location set for `item` using `repoMap`.
 * Never throws; returns an empty result when inputs are degenerate.
 */
export function localize(
  item: LocalizeItem,
  repoMap: RepoMap,
  opts?: LocalizeOptions,
): LocalizeResult {
  try {
    const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
    const maxKw = opts?.maxKeywords ?? DEFAULT_MAX_KEYWORDS;

    // --- Extract keywords from title + detail ---
    const kwText = [item.title, item.detail ?? ''].join(' ');
    const keywords = extractKeywords(kwText, maxKw);

    // If no repo-map files, fall back to hinted files only
    if (repoMap.files.length === 0) {
      const hinted = (item.files ?? []).slice(0, maxFiles);
      return {
        files: hinted,
        symbols: [],
        reason: hinted.length > 0
          ? 'item.files used directly (empty repo-map)'
          : 'no candidates (empty repo-map, no item.files)',
      };
    }

    // Build a path-lookup for fast hinted-file matching
    // Item files may be absolute or relative; we match by suffix
    const hintedSet = new Set<string>();
    for (const f of item.files ?? []) {
      const norm = f.replace(/\\/g, '/');
      // add both the raw value and the bare basename for fuzzy suffix match
      hintedSet.add(norm);
    }

    // --- Score every file in the map ---
    interface Candidate {
      file: RepoMapFile;
      tier: number;   // 1=hinted, 2=path-kw, 3=sym-kw, 4=refcount
      kwScore: number;
    }

    const candidates: Candidate[] = [];

    for (const file of repoMap.files) {
      // Tier 1: explicitly hinted
      const isHinted = (() => {
        for (const h of hintedSet) {
          if (file.path === h || file.path.endsWith('/' + h) || h.endsWith('/' + file.path)) {
            return true;
          }
        }
        return false;
      })();
      if (isHinted) {
        candidates.push({ file, tier: 1, kwScore: 100 });
        continue;
      }

      const kwScore = scoreFile(file, keywords);
      if (kwScore > 0) {
        // Tier 2: path matched, Tier 3: symbol-only match (path didn't match)
        const pathLower = file.path.toLowerCase();
        const pathHit = keywords.some((kw) => pathLower.includes(kw));
        candidates.push({ file, tier: pathHit ? 2 : 3, kwScore });
      } else {
        // Tier 4: no keyword match — include high-refCount files as context
        if (file.refCount > 0) {
          candidates.push({ file, tier: 4, kwScore: file.refCount });
        }
      }
    }

    // Sort: tier asc, then kwScore desc, then path asc
    candidates.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (b.kwScore !== a.kwScore) return b.kwScore - a.kwScore;
      return a.file.path.localeCompare(b.file.path);
    });

    const top = candidates.slice(0, maxFiles);
    const files = top.map((c) => c.file.path);

    // Collect matched symbols (tier 1-3 only, to keep context focused)
    const symbols: string[] = [];
    const symSeen = new Set<string>();
    for (const c of top) {
      if (c.tier > 3) continue;
      for (const sym of c.file.symbols) {
        const nameLower = sym.name.toLowerCase();
        if (keywords.some((kw) => nameLower.includes(kw)) && !symSeen.has(sym.name)) {
          symSeen.add(sym.name);
          symbols.push(sym.name);
        }
      }
    }

    // Build reason string
    const hintedCount = top.filter((c) => c.tier === 1).length;
    const kwCount = top.filter((c) => c.tier <= 3).length - hintedCount;
    const refCount = top.filter((c) => c.tier === 4).length;
    const parts: string[] = [];
    if (hintedCount > 0) parts.push(`${hintedCount} from item.files`);
    if (kwCount > 0) parts.push(`${kwCount} keyword-matched (${keywords.slice(0, 5).join(', ')})`);
    if (refCount > 0) parts.push(`${refCount} high-refcount context`);
    const reason = parts.length > 0 ? parts.join('; ') : 'no candidates found';

    return { files, symbols, reason };
  } catch {
    return { files: item.files ?? [], symbols: [], reason: 'localization error (safe fallback)' };
  }
}

/**
 * Render a localization result as a compact string for engine context.
 * Intended to be prepended to the goal string.
 */
export function renderLocalization(loc: LocalizeResult): string {
  if (loc.files.length === 0) return '';
  const lines = ['<!-- localization (M154) -->', `<!-- reason: ${loc.reason} -->`];
  lines.push('Candidate edit locations (ranked):');
  for (const f of loc.files) lines.push(`  ${f}`);
  if (loc.symbols.length > 0) {
    lines.push('Matched symbols:');
    for (const s of loc.symbols) lines.push(`  ${s}`);
  }
  lines.push('<!-- end localization -->');
  return lines.join('\n');
}
