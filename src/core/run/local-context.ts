/**
 * local-context.ts — M264: Elite Context Injection for local models.
 *
 * Assembles a rich, token-bounded system-prompt prefix for local api-model
 * engines (local-coder, local-agent) so they start each task context-aware
 * instead of context-blind. Frontier engines (claude, codex) are NEVER
 * modified — this only enriches the local model's system prompt.
 *
 * Sections (each in its own try/catch — never-throws, degrades to ''):
 *   1. NORTH-STAR summary — grand vision + three pillars + ambitious bets
 *   2. Ecosystem map    — 13-repo platform map + composition bets
 *   3. Genome recall    — top-K keyword hits relevant to the goal
 *   4. Repo tree        — shallow dir/entry-point orientation
 *
 * Length-bounded: each section is individually capped; total capped at
 * MAX_BUNDLE_CHARS (~2 400 chars / ~600 tokens) — safely under local model
 * context budgets. Any section may be '' when its source is absent/throws.
 *
 * Flag-off: when cfg.foundry.localContext === false the bundle is '' and
 * the injection is a no-op — system prompt is byte-identical to pre-M264.
 */

import { execFileSync } from 'node:child_process';
import type { AshlrConfig, PromptContextSummary, RunContextSummary } from '../types.js';
import {
  northStarDocSummary,
  ecosystemSummary,
} from '../ecosystem/map.js';
import { recall } from '../genome/recall.js';

// ---------------------------------------------------------------------------
// Section caps (chars)
// ---------------------------------------------------------------------------

const CAP_NORTH_STAR = 500;
const CAP_ECOSYSTEM  = 600;
const CAP_GENOME     = 500;
const CAP_REPO_TREE  = 400;

/** Hard ceiling on the assembled bundle (chars). ~600 tokens. */
const MAX_BUNDLE_CHARS = 2_400;

/** Top-K genome recall hits to include. */
const GENOME_TOP_K = 4;

// ---------------------------------------------------------------------------
// Section builders — each must never throw
// ---------------------------------------------------------------------------

function buildNorthStarSection(): string {
  try {
    return northStarDocSummary(CAP_NORTH_STAR);
  } catch {
    return '';
  }
}

function buildEcosystemSection(): string {
  try {
    return ecosystemSummary(CAP_ECOSYSTEM);
  } catch {
    return '';
  }
}

async function buildGenomeSection(
  goal: string,
  cfg: AshlrConfig,
): Promise<string> {
  try {
    const hits = await recall(goal, cfg, { limit: GENOME_TOP_K, embeddings: false });
    if (hits.length === 0) return '';
    const lines = hits.map((h) =>
      `- [${h.entry.tags.join(', ') || 'general'}] ${h.entry.title}: ${h.entry.text.slice(0, 80).replace(/\n/g, ' ')}`,
    );
    const body = lines.join('\n');
    return (
      '=== GENOME RECALL (prior work relevant to this goal) ===\n' + body
    ).slice(0, CAP_GENOME);
  } catch {
    return '';
  }
}

/**
 * Build a shallow repo orientation: top-level dirs + key TS entry points.
 * Uses `git ls-files` (fast, already in worktree context) with a fallback
 * to nothing when git is absent. Never throws.
 */
function buildRepoTreeSection(repo: string): string {
  try {
    // List top-level dirs from tracked files (cheap, no filesystem walk)
    const raw = execFileSync('git', ['ls-files', '--', '.'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });

    const files = raw.split('\n').filter(Boolean);
    if (files.length === 0) return '';

    // Top-level dirs (unique, sorted)
    const topDirs = [...new Set(
      files
        .map((f) => f.split('/')[0])
        .filter((d) => d && !d.startsWith('.')),
    )].sort();

    // Key TS entry-point files (src/core/run/ and src/core/types.ts)
    const keyFiles = files
      .filter(
        (f) =>
          (f.startsWith('src/core/run/') || f === 'src/core/types.ts') &&
          f.endsWith('.ts') &&
          !f.includes('.test.'),
      )
      .slice(0, 16);

    const parts: string[] = [
      '=== REPO ORIENTATION ===',
      `Top-level dirs: ${topDirs.slice(0, 12).join('  ')}`,
    ];
    if (keyFiles.length > 0) {
      parts.push('Key modules (src/core/run/):');
      parts.push(...keyFiles.map((f) => `  ${f}`));
    }

    return parts.join('\n').slice(0, CAP_REPO_TREE);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface LocalContextBundle {
  northStar: string;
  ecosystem: string;
  genome: string;
  repoTree: string;
}

export interface LocalContextSummaryOptions {
  toolCount?: number;
}

/**
 * Assemble the four context sections for a local model run.
 * Always resolves (never rejects). Any absent/erroring section is ''.
 * Each section is individually length-bounded; the assembled bundle is
 * capped at MAX_BUNDLE_CHARS total.
 */
export async function buildLocalContextBundle(
  goal: string,
  repo: string,
  cfg: AshlrConfig,
): Promise<LocalContextBundle> {
  const [northStar, ecosystem, genome] = await Promise.all([
    Promise.resolve(buildNorthStarSection()),
    Promise.resolve(buildEcosystemSection()),
    buildGenomeSection(goal, cfg),
  ]);

  const repoTree = buildRepoTreeSection(repo);

  return { northStar, ecosystem, genome, repoTree };
}

function localContextParts(bundle: LocalContextBundle): string[] {
  const parts: string[] = [];

  if (bundle.northStar) {
    parts.push(bundle.northStar);
  }

  if (bundle.ecosystem) {
    parts.push(bundle.ecosystem);
  }

  if (bundle.genome) {
    parts.push(bundle.genome);
  }

  if (bundle.repoTree) {
    parts.push(bundle.repoTree);
  }

  return parts;
}

function countGenomeHits(genome: string): number {
  if (!genome) return 0;
  const hitLines = genome
    .split('\n')
    .filter((line) => line.trimStart().startsWith('- '));
  return Math.min(GENOME_TOP_K, hitLines.length);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, Math.round((numerator / denominator) * 1_000) / 1_000));
}

/**
 * Summarize local context injection without persisting any prompt section text,
 * file paths, diffs, model output, tool arguments, or stdout/stderr.
 */
export function summarizeLocalContextBundle(
  bundle: LocalContextBundle,
  opts: LocalContextSummaryOptions = {},
): RunContextSummary {
  const parts = localContextParts(bundle);
  const unbounded = parts.join('\n\n');
  const renderedChars = Math.min(unbounded.length, MAX_BUNDLE_CHARS);
  const genomeHits = countGenomeHits(bundle.genome);
  const toolCount = typeof opts.toolCount === 'number' && Number.isFinite(opts.toolCount)
    ? Math.max(0, Math.trunc(opts.toolCount))
    : undefined;
  const layersIncluded: NonNullable<PromptContextSummary['layersIncluded']> = ['base'];
  if ((toolCount ?? 0) > 0) layersIncluded.push('tool');
  if (renderedChars > 0) layersIncluded.push('memory');

  return {
    prompt: {
      role: 'executor',
      profileId: 'local-context-v1',
      estimatedPromptTokens: Math.ceil(renderedChars / 4),
      promptCharCap: MAX_BUNDLE_CHARS,
      assembledSystemChars: renderedChars,
      promptBudgetRatio: ratio(renderedChars, MAX_BUNDLE_CHARS),
      layersIncluded,
      ...(toolCount !== undefined ? { toolCount } : {}),
    },
    retrieval: {
      source: 'local-context',
      requestedLimit: GENOME_TOP_K,
      hitCount: genomeHits,
      injectedHitCount: genomeHits,
      limitHitRate: ratio(genomeHits, GENOME_TOP_K),
      ...(genomeHits > 0 ? { methodCounts: { keyword: genomeHits } } : {}),
      injectedChars: renderedChars,
    },
    compression: {
      source: 'local-context',
      strategy: 'truncate',
      inputChars: unbounded.length,
      outputChars: renderedChars,
      maxChars: MAX_BUNDLE_CHARS,
      droppedChars: Math.max(0, unbounded.length - renderedChars),
      compressionRatio: ratio(renderedChars, unbounded.length),
      truncated: unbounded.length > MAX_BUNDLE_CHARS,
    },
  };
}

/**
 * Render the bundle as a system-prompt prefix.
 *
 * Structure:
 *   === GRAND VISION (orient all work here) ===
 *   {northStar}
 *
 *   === PLATFORM MAP (13 repos, composition bets) ===
 *   {ecosystem}
 *
 *   {genome}
 *
 *   {repoTree}
 *
 * Empty sections are omitted entirely (no blank headings).
 * Returns '' when all sections are empty (flag-off / no docs).
 * Total length bounded at MAX_BUNDLE_CHARS.
 */
export function renderLocalContextBundle(bundle: LocalContextBundle): string {
  const parts = localContextParts(bundle);

  if (parts.length === 0) return '';

  return parts.join('\n\n').slice(0, MAX_BUNDLE_CHARS);
}

/**
 * Returns true when the local-context injection is enabled for `engine`.
 *
 * Rules:
 *   - Only for api-model local engines: 'local-coder', 'local-agent'.
 *   - Disabled when cfg.foundry.localContext === false (flag-off).
 *   - Enabled by default (absent → true).
 */
export function isLocalContextEnabled(
  engine: string,
  cfg: AshlrConfig,
): boolean {
  const LOCAL_ENGINES = new Set(['local-coder', 'local-agent']);
  if (!LOCAL_ENGINES.has(engine)) return false;

  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  // Default-on: only off when explicitly false
  return foundry?.['localContext'] !== false;
}
