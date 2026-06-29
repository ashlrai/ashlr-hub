/**
 * M184: Ecosystem map loader.
 *
 * Reads docs/ECOSYSTEM-MAP.md (resolved relative to the repo root — the
 * directory containing package.json, walked up from __dirname) and exposes
 * two functions consumed by the strategist and the invent engine:
 *
 *   loadEcosystemMap(): string | null
 *     Full file contents. Returns null if the file is absent or unreadable.
 *     Result is cached (one read per process). Never throws.
 *
 *   ecosystemSummary(maxChars?: number): string
 *     A bounded digest (~2-3 KB by default) suitable for injecting into
 *     prompts without blowing the context budget. Extracts:
 *       - One-liner capability profiles (## The repos section, bullet lines)
 *       - Full "## Composition bets" section
 *     Falls back to a truncated raw map when parsing yields nothing useful.
 *     Returns '' when the map is absent. Never throws.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Repo-root resolution
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` looking for the nearest directory that contains
 * package.json. Returns that directory, or null if we reach the filesystem
 * root without finding one.
 */
function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve('/');
  while (dir !== root) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break; // at root
    dir = parent;
  }
  // check root itself
  if (existsSync(join(root, 'package.json'))) return root;
  return null;
}

// __dirname equivalent in ESM
const _thisDir = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

function ecosystemMapPath(): string | null {
  try {
    const repoRoot = findRepoRoot(_thisDir) ?? process.cwd();
    const candidate = join(repoRoot, 'docs', 'ECOSYSTEM-MAP.md');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let _cache: string | null | undefined; // undefined = not-yet-loaded; null = absent

/**
 * Load docs/ECOSYSTEM-MAP.md from the repo root.
 * Returns the file contents as a string, or null if absent/unreadable.
 * Caches the result for the lifetime of the process. Never throws.
 */
export function loadEcosystemMap(): string | null {
  if (_cache !== undefined) return _cache;
  try {
    const mapPath = ecosystemMapPath();
    if (!mapPath) {
      _cache = null;
      return null;
    }
    _cache = readFileSync(mapPath, 'utf8');
    return _cache;
  } catch {
    _cache = null;
    return null;
  }
}

/** Reset the in-process cache. Only needed in tests. */
export function _resetEcosystemMapCache(): void {
  _cache = undefined;
}

// ---------------------------------------------------------------------------
// M231: North-Star doc loader — reads docs/NORTH-STAR.md and distils a
// token-bounded summary of the 3 pillars + grand directives for prompt injection.
// ---------------------------------------------------------------------------

let _northStarCache: string | null | undefined; // undefined=unloaded; null=absent

function northStarDocPath(): string | null {
  try {
    const repoRoot = findRepoRoot(_thisDir) ?? process.cwd();
    const candidate = join(repoRoot, 'docs', 'NORTH-STAR.md');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Load docs/NORTH-STAR.md from the repo root.
 * Returns the file contents as a string, or null if absent/unreadable.
 * Caches the result for the lifetime of the process. Never throws.
 */
export function loadNorthStarDoc(): string | null {
  if (_northStarCache !== undefined) return _northStarCache;
  try {
    const p = northStarDocPath();
    if (!p) { _northStarCache = null; return null; }
    _northStarCache = readFileSync(p, 'utf8');
    return _northStarCache;
  } catch {
    _northStarCache = null;
    return null;
  }
}

/** Reset the north-star cache. Only needed in tests. */
export function _resetNorthStarDocCache(): void {
  _northStarCache = undefined;
}

/**
 * Return a concise, token-bounded distillation of docs/NORTH-STAR.md for
 * prompt injection. Extracts the 3 pillars + grand measurement + substantive
 * value directive. Always ≤ maxChars (default ~1200 chars / ~300 tokens).
 * Returns '' when the doc is absent. Never throws.
 *
 * Format:
 *   === NORTH-STAR: GRAND VISION ===
 *   Vision: <one-liner>
 *   Pillars: 1. Recursive self-improvement … 2. Ecosystem product factory … 3. Composition flywheel
 *   Measure grand not vanity: products shipped+adopted, capabilities invented, compounding velocity.
 *   Goals must be: substantive (value≥4), bound to a concrete enrolled repo, decomposable into shippable milestones.
 */
export function northStarDocSummary(maxChars = 1200): string {
  try {
    const raw = loadNorthStarDoc();
    if (!raw) return '';

    const lines = raw.split('\n');

    // Extract vision one-liner (first non-empty line after "## Vision")
    let vision = '';
    let inVision = false;
    // Extract pillar lines (lines starting with "1." / "2." / "3." under "## Three pillars")
    const pillars: string[] = [];
    let inPillars = false;
    // Extract near-term bets (bullet lines under "## Near-term ambitious bets")
    const bets: string[] = [];
    let inBets = false;

    for (const line of lines) {
      const t = line.trim();
      if (/^##\s+Vision/i.test(t)) { inVision = true; inPillars = false; inBets = false; continue; }
      if (/^##\s+Three pillars/i.test(t)) { inPillars = true; inVision = false; inBets = false; continue; }
      if (/^##\s+Near-term ambitious bets/i.test(t)) { inBets = true; inPillars = false; inVision = false; continue; }
      if (/^##\s/.test(t)) { inVision = false; inPillars = false; inBets = false; continue; }

      if (inVision && !vision && t.length > 10) vision = t;
      if (inPillars && /^\d+\.\s+\*\*/.test(t)) pillars.push(t.replace(/\*\*/g, '').replace(/\(.*?\)/g, '').trim());
      if (inBets && /^-\s+/.test(t) && bets.length < 4) bets.push(t.replace(/^-\s+/, '').trim());
    }

    const parts: string[] = ['=== NORTH-STAR: GRAND VISION ==='];
    if (vision) parts.push(`Vision: ${vision.replace(/\*\*/g, '').slice(0, 220)}`);
    if (pillars.length > 0) {
      parts.push('Three pillars (in priority order):');
      pillars.forEach((p, i) => parts.push(`  ${i + 1}. ${p.slice(0, 160)}`));
    }
    parts.push('');
    parts.push('Measure GRAND not vanity: products shipped+adopted, net-new capabilities invented, compounding velocity (merges/week UP, cost/merge DOWN), safety never weakened.');
    parts.push('');
    parts.push('Every goal/idea MUST be: substantive (value≥4 — real capability or product, NOT docs/version-bumps/lint), bound to a concrete enrolled repo, decomposable into shippable milestones.');
    if (bets.length > 0) {
      parts.push('');
      parts.push('Ambitious bets (examples of the right altitude):');
      bets.forEach((b) => parts.push(`  - ${b.slice(0, 140)}`));
    }

    return parts.join('\n').slice(0, maxChars);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Summary extractor
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 3000; // ~750 tokens — safe budget for prompt injection

/**
 * Return a bounded digest of the ecosystem map suitable for prompt injection.
 *
 * Format:
 *   === ECOSYSTEM MAP (capability profiles + composition bets) ===
 *   [capability one-liners from "## The repos" section]
 *   [full "## Composition bets" section]
 *
 * If the map is absent → returns ''.
 * Result is always capped to maxChars. Never throws.
 */
export function ecosystemSummary(maxChars: number = DEFAULT_MAX_CHARS): string {
  try {
    const raw = loadEcosystemMap();
    if (!raw) return '';

    const lines = raw.split('\n');

    // ── Extract capability one-liners from "## The repos" section ────────────
    // Pattern: lines that start with "- **<name>**" inside the repos section.
    const capabilityLines: string[] = [];
    let inReposSection = false;
    let inCompositionSection = false;
    const compositionLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Section detection
      if (/^##\s+The repos/i.test(trimmed)) {
        inReposSection = true;
        inCompositionSection = false;
        continue;
      }
      if (/^##\s+Composition bets/i.test(trimmed)) {
        inCompositionSection = true;
        inReposSection = false;
        compositionLines.push(line);
        continue;
      }
      if (/^##\s/.test(trimmed) && inCompositionSection) {
        // New top-level section after composition bets — stop collecting
        inCompositionSection = false;
        continue;
      }
      if (/^##\s/.test(trimmed)) {
        inReposSection = false;
        continue;
      }

      if (inReposSection) {
        // Capture bullet lines with bold tool name (capability profile lines)
        if (/^-\s+\*\*/.test(trimmed)) {
          // Condense: strip sub-bullets and keep just the one-liner.
          // Take up to first period or em-dash that ends the description.
          const shortened = trimmed.replace(/\.\s+\*The [^*]+\*\s*$/, '.').replace(/\*$/, '').trimEnd();
          capabilityLines.push(shortened);
        }
      }

      if (inCompositionSection) {
        compositionLines.push(line);
      }
    }

    // ── Assemble ─────────────────────────────────────────────────────────────
    const parts: string[] = [
      '=== ECOSYSTEM MAP (capability profiles + composition bets) ===',
    ];

    if (capabilityLines.length > 0) {
      parts.push('');
      parts.push('Capability profiles:');
      parts.push(...capabilityLines);
    }

    if (compositionLines.length > 0) {
      parts.push('');
      parts.push(...compositionLines);
    }

    const assembled = parts.join('\n');

    // ── Fallback: if parsing yielded nothing substantive, truncate raw ────────
    if (capabilityLines.length === 0 && compositionLines.length === 0) {
      const fallback = `=== ECOSYSTEM MAP ===\n${raw}`;
      return fallback.slice(0, maxChars);
    }

    return assembled.slice(0, maxChars);
  } catch {
    return '';
  }
}
