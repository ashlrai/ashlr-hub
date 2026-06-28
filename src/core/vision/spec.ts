/**
 * M121: EndStateSpec store — the north-star vision document for the ashlr fleet.
 *
 * Persists one spec per project at ~/.ashlr/vision/<id>.json.
 * The spec is Mason's evolving end-state vision; the Strategist agent reads it
 * to measure progress, raise ambition, and generate aligned goals.
 *
 * Design rules:
 *  - Never throws on read paths (loadSpec/listSpecs return null/[]).
 *  - Atomic write: <id>.json.tmp → rename.
 *  - applyEvolution bumps version, appends history — immutable audit trail.
 *  - A sensible default 'ecosystem' spec is created on first access.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecPriority {
  title: string;
  rationale: string;
  rank: number;
}

export interface SpecHistoryEntry {
  version: number;
  summary: string;
  ts: string;
}

/**
 * M179: Per-tool roadmap entry — the strategist's directional bet for one
 * enrolled repo in the ashlr ecosystem.
 */
export interface ToolRoadmapEntry {
  /** Repo/tool name (basename of the enrolled repo dir, e.g. 'ashlr-pulse'). */
  repo: string;
  /**
   * Ambition level 1–10 for this specific tool.
   * Distinct from the ecosystem-level ambitionLevel.
   */
  ambitionLevel: number;
  /**
   * The one-sentence vision for what would make this tool genuinely great —
   * first-principles, 10x thinking, not incremental tweaks.
   */
  vision: string;
  /**
   * The next concrete milestone to pursue for this tool.
   * Specific enough that an engineering agent can execute it.
   */
  nextMilestone: string;
}

export interface EndStateSpec {
  id: string;
  /** Repository/project name, or null for the global ecosystem spec. */
  project: string | null;
  /** One-sentence north star — the ultimate purpose. */
  northStar: string;
  /** Multi-sentence end-state description — what "done" looks like. */
  endState: string;
  /** Immutable design principles the fleet must never violate. */
  principles: string[];
  /** Ranked priorities driving current execution. */
  priorities: SpecPriority[];
  /** Open hard problems not yet solved. */
  openProblems: string[];
  /**
   * Ambition level 1–10.
   * 1 = maintenance-mode; 10 = category-defining moonshot.
   */
  ambitionLevel: number;
  /**
   * M179: Per-tool roadmap — one entry per enrolled ecosystem repo.
   * Set by the strategist during ecosystem-manager briefings.
   * Optional for backward compatibility with existing persisted specs.
   */
  toolRoadmap?: ToolRoadmapEntry[];
  version: number;
  updatedAt: string;
  /** Who last updated: Mason directly ('mason') or the Strategist agent ('strategist'). */
  updatedBy: 'mason' | 'strategist';
  history: SpecHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function visionDir(): string {
  return join(homedir(), '.ashlr', 'vision');
}

function specPath(id: string): string {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`Invalid spec id: ${id}`);
  return join(visionDir(), `${id}.json`);
}

function ensureDir(): void {
  try {
    const dir = visionDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Default ecosystem spec (first-run bootstrap)
// ---------------------------------------------------------------------------

function defaultEcosystemSpec(): EndStateSpec {
  const now = new Date().toISOString();
  return {
    id: 'ecosystem',
    project: null,
    northStar: 'Build the autonomous engineering fleet that ships production-quality software end-to-end without human intervention for routine tasks.',
    endState:
      'A self-improving, multi-backend engineering fleet that decomposes goals into milestones, executes them in sandboxed agents, gates merges through tiered trust, measures its own quality, and continuously raises the bar — freeing Mason to focus exclusively on direction and vision.',
    principles: [
      'Proposal-first: every mutation is a reviewable proposal before it is applied.',
      'Never throw on read paths: the fleet degrades gracefully, never catastrophically.',
      'Local-first: zero network calls for core fleet operations; cloud is optional.',
      'Tiered trust: the system earns the right to merge autonomously through track record.',
      'First-principles ambition: when a bottleneck is solved, immediately identify the next one.',
    ],
    priorities: [
      {
        title: 'End-to-end autonomy for well-scoped tasks',
        rationale: 'The fleet must complete routine engineering tasks without any human touchpoint.',
        rank: 1,
      },
      {
        title: 'Quality gate robustness',
        rationale: 'False-positive merges erode trust faster than missed opportunities.',
        rank: 2,
      },
      {
        title: 'Multi-backend polyglot support',
        rationale: 'The fleet must not be locked to a single model or provider.',
        rank: 3,
      },
      {
        title: 'Self-improving via genome + strategist feedback loop',
        rationale: 'The system must learn from its own outputs and raise ambition over time.',
        rank: 4,
      },
    ],
    openProblems: [
      'Reliable end-to-end test generation without false positives.',
      'Cross-repo dependency awareness during milestone execution.',
      'Automatic ambition calibration: when is the bar high enough?',
    ],
    ambitionLevel: 9,
    version: 1,
    updatedAt: now,
    updatedBy: 'mason',
    history: [
      { version: 1, summary: 'Initial ecosystem spec (auto-generated on first run).', ts: now },
    ],
  };
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

function isValidSpec(parsed: unknown): parsed is EndStateSpec {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const s = parsed as Record<string, unknown>;
  return (
    typeof s['id'] === 'string' &&
    typeof s['northStar'] === 'string' &&
    typeof s['endState'] === 'string' &&
    Array.isArray(s['principles']) &&
    Array.isArray(s['priorities']) &&
    Array.isArray(s['openProblems']) &&
    typeof s['version'] === 'number' &&
    Array.isArray(s['history'])
  );
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Load a spec by id. Returns the default ecosystem spec if id==='ecosystem'
 * and no file exists yet. Returns null for any other missing spec.
 * Never throws.
 */
export function loadSpec(id: string): EndStateSpec | null {
  try {
    const p = specPath(id);
    if (!existsSync(p)) {
      if (id === 'ecosystem') return defaultEcosystemSpec();
      return null;
    }
    const raw = readFileSync(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSpec(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a spec atomically. Creates the vision dir if needed.
 * Never throws.
 */
export function saveSpec(spec: EndStateSpec): void {
  try {
    ensureDir();
    const p = specPath(spec.id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch { /* best-effort */ }
}

/**
 * List all persisted specs. Returns [] on any error.
 * Never throws.
 */
export function listSpecs(): EndStateSpec[] {
  try {
    const dir = visionDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    const specs: EndStateSpec[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(dir, f), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isValidSpec(parsed)) specs.push(parsed);
      } catch { /* skip malformed */ }
    }
    return specs;
  } catch {
    return [];
  }
}

/**
 * Apply a partial evolution to a spec: bumps version, stamps updatedAt/updatedBy,
 * appends a history entry, persists. Returns the updated spec.
 *
 * If the spec does not exist yet, creates it from the default ecosystem spec
 * (for id==='ecosystem') or from a minimal blank (for other ids).
 * Never throws.
 */
export function applyEvolution(
  id: string,
  partial: Partial<Omit<EndStateSpec, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'history'>>,
  by: 'mason' | 'strategist',
  summarize?: string,
): EndStateSpec {
  try {
    const existing = loadSpec(id) ?? defaultEcosystemSpec();
    const now = new Date().toISOString();
    const newVersion = existing.version + 1;

    const updated: EndStateSpec = {
      ...existing,
      ...partial,
      id,
      version: newVersion,
      updatedAt: now,
      updatedBy: by,
      history: [
        ...existing.history,
        {
          version: newVersion,
          summary: summarize ?? `Version ${newVersion} — ${by} update.`,
          ts: now,
        },
      ],
    };

    saveSpec(updated);
    return updated;
  } catch {
    // Degrade: return the loaded spec unmodified rather than throwing.
    return loadSpec(id) ?? defaultEcosystemSpec();
  }
}
