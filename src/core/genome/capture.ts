/**
 * capture.ts — Auto-capture structured GenomeEntry records from completed
 * runs and swarms (M16).
 *
 * GUARDRAILS:
 *  - PRIVACY: summary/metadata ONLY — no secrets, no raw prompts/completions,
 *    no tool args, no file contents. Hard cap on entry size.
 *  - FIRE-AND-FORGET: captureFromRun / captureFromSwarm never throw and never
 *    block the caller. All async work is kicked off without awaiting.
 *  - LOCAL-ONLY: no cloud calls; reuses appendHubEntry from store.ts.
 *  - DEDUPE-AWARE: skips append when a near-identical recent entry exists.
 *  - NO DATA LOSS: append-only; never deletes or overwrites.
 *  - HUB-ONLY FOOTPRINT: auto-capture passes hubOnly:true to appendHubEntry, so
 *    it writes to ~/.ashlr/genome/hub.jsonl ONLY and NEVER drops a note file
 *    into a repo's .ashlrcode/genome/hub-notes/ working tree (which could be
 *    git-committed). The project-note drop stays reserved for explicit
 *    `genome --teach` / `learn`.
 */

import type { AshlrConfig, RunState, SwarmRun } from '../types.js';
import { appendHubEntry, loadGenome } from './store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on the summary string returned by summarizeForGenome. */
const SUMMARY_MAX_CHARS = 800;

/** Max characters of a goal kept in the entry title. */
const TITLE_MAX_CHARS = 100;

/**
 * How many recent hub entries to check for deduplication.
 * Bounded to keep the hot path cheap.
 */
const DEDUPE_SCAN_LIMIT = 50;

/**
 * Jaccard similarity threshold above which an entry is considered a near-
 * duplicate and the new append is skipped.
 */
const DEDUPE_THRESHOLD = 0.72;

// ---------------------------------------------------------------------------
// Secret-stripping helpers
// ---------------------------------------------------------------------------

/**
 * Patterns that look like secret values. We only want goal/status/count
 * metadata in the genome — strip anything that resembles a token, key, or
 * credential so the auto-capture is safe even if a result string leaks one.
 *
 * Matches: bearer tokens, API keys (sk-…, pk-…, xoxb-…), AWS access key ids,
 * Google API keys, PEM private-key blocks, long hex/base64 blobs (≥32 chars),
 * passwords in URL authority, and generic token/secret/apikey assignments.
 *
 * NOTE: PEM blocks must be redacted BEFORE the base64/hex blob rules, otherwise
 * those greedy rules would shred the key body line-by-line and leave the
 * BEGIN/END markers behind. Order matters — keep multi-line patterns first.
 */
const SECRET_PATTERNS: RegExp[] = [
  // PEM private-key blocks (multi-line) — redact the whole block first.
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  // Fallback: any stray BEGIN-private-key marker line (truncated/partial blocks).
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[^\n]*/g,
  /\b(sk|pk|xoxb|xoxp|ghp|ghs|glpat|ey[A-Za-z0-9])[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,                 // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g,            // Google API key
  /Bearer\s+[A-Za-z0-9\-._~+/]{8,}/gi,
  // Generic token/secret/apikey/api_key = <value> assignments.
  /\b(?:api[_-]?key|apikey|secret|token|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{6,}["']?/gi,
  /[A-Fa-f0-9]{32,}/g,
  /[A-Za-z0-9+/]{40,}={0,2}/g,           // long base64 blobs
  /:[^@\s]{8,}@[a-zA-Z0-9.-]+/g,        // password in URL
  /password=[^\s]{4,}/gi,                  // password= assignments
];

/** Strip secret-shaped substrings from a string. */
function stripSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text similarity (Jaccard on trigrams) — for deduplication
// ---------------------------------------------------------------------------

/** Produce the set of character trigrams from a string (lowercased). */
function trigrams(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
  const result = new Set<string>();
  for (let i = 0; i + 2 < norm.length; i++) {
    result.add(norm.slice(i, i + 3));
  }
  return result;
}

/** Jaccard similarity between two trigram sets. Returns 0–1. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// ---------------------------------------------------------------------------
// Deduplication check
// ---------------------------------------------------------------------------

/**
 * Returns true when the genome already contains a near-identical recent entry
 * for the same goal + project. Scans only the most recent DEDUPE_SCAN_LIMIT
 * hub entries for performance. Never throws.
 */
function isDuplicate(goal: string, project: string | null, summaryText: string, cfg: AshlrConfig): boolean {
  try {
    const all = loadGenome(cfg);
    // Only look at hub-sourced entries (auto-captures live there), most recent first.
    const hubEntries = all
      .filter((e) => e.source === 'hub')
      .slice(-DEDUPE_SCAN_LIMIT);

    const newTrigoals = trigrams(goal);
    const newTriText = trigrams(summaryText);

    for (const e of hubEntries) {
      // Project must match (or both null/empty).
      const eProj = e.project ?? null;
      const projMatch = eProj === project || (!eProj && !project);
      if (!projMatch) continue;

      // Goal similarity check.
      const goalSim = jaccardSimilarity(newTrigoals, trigrams(e.title));
      if (goalSim < 0.5) continue;

      // Summary/text overlap check.
      const textSim = jaccardSimilarity(newTriText, trigrams(e.text));
      if (goalSim + textSim >= DEDUPE_THRESHOLD * 2) {
        return true;
      }
    }
    return false;
  } catch {
    // On any error be conservative: allow the append.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public: summarizeForGenome
// ---------------------------------------------------------------------------

/**
 * Produce a concise METADATA/SUMMARY-ONLY string describing a completed run
 * or swarm. Deterministic; no I/O; no model call; never throws.
 *
 * Captures: goal, outcome gist, and for swarms a bounded task-count sketch.
 * NEVER includes: secrets, raw result bodies, full prompts, tool args, or
 * file contents.
 */
export function summarizeForGenome(input: {
  goal: string;
  result?: string;
  tasks?: unknown[];
}): string {
  const parts: string[] = [];

  // Goal line (truncated + secret-stripped).
  const goal = stripSecrets((input.goal ?? '').trim()).slice(0, 200);
  if (goal) {
    parts.push(`Goal: ${goal}`);
  }

  // Task sketch — counts and goals only, no result bodies.
  if (Array.isArray(input.tasks) && input.tasks.length > 0) {
    // Filter out null/non-object elements defensively.
    const tasks = (input.tasks as unknown[])
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null);
    const total = tasks.length;
    const done = tasks.filter((t) => t['status'] === 'done').length;
    const failed = tasks.filter((t) => t['status'] === 'failed').length;
    const skipped = tasks.filter((t) => t['status'] === 'skipped').length;

    parts.push(`Tasks: ${total} total — ${done} done, ${failed} failed, ${skipped} skipped`);

    // Include up to 5 task goals (goal text only, never result/error bodies).
    const taskGoals = tasks
      .slice(0, 5)
      .map((t) => {
        const tgoal = typeof t['goal'] === 'string' ? stripSecrets(t['goal']).trim().slice(0, 80) : null;
        const tstatus = typeof t['status'] === 'string' ? t['status'] : '';
        return tgoal ? `  • [${tstatus}] ${tgoal}` : null;
      })
      .filter((s): s is string => s !== null);

    if (taskGoals.length > 0) {
      parts.push(taskGoals.join('\n'));
    }
    if (total > 5) {
      parts.push(`  … and ${total - 5} more`);
    }
  }

  // Outcome gist — first sentence of result only, stripped of secrets.
  if (typeof input.result === 'string' && input.result.trim()) {
    const firstSentence = input.result
      .trim()
      .replace(/\n+/g, ' ')
      .slice(0, 300)
      .split(/(?<=[.!?])\s+/)[0] ?? '';
    const cleaned = stripSecrets(firstSentence).trim().slice(0, 250);
    if (cleaned) {
      parts.push(`Outcome: ${cleaned}`);
    }
  }

  const raw = parts.join('\n');
  // Hard cap — truncate with elision marker if needed.
  if (raw.length <= SUMMARY_MAX_CHARS) return raw;
  return raw.slice(0, SUMMARY_MAX_CHARS - 3) + '...';
}

// ---------------------------------------------------------------------------
// Outcome mapping helpers
// ---------------------------------------------------------------------------

function mapRunOutcome(status: string): 'done' | 'aborted' | 'failed' {
  if (status === 'done') return 'done';
  if (status === 'aborted') return 'aborted';
  return 'failed';
}

function mapSwarmOutcome(status: string): 'done' | 'aborted' | 'failed' {
  if (status === 'done') return 'done';
  if (status === 'aborted') return 'aborted';
  return 'failed';
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

/** Produce a deduped, lowercased tag array. */
function buildTags(...parts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const t = p.trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public: captureFromRun
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: capture a GenomeEntry summarising a completed RunState.
 *
 * - MUST NOT throw. MUST NOT block the caller (all async appends are
 *   unobserved Promises; never awaited in the hot path).
 * - No-op when cfg.genome?.autoCapture === false.
 * - Dedupe-aware: skips near-identical recent entries.
 */
export function captureFromRun(run: RunState, cfg: AshlrConfig): void {
  // Fast no-op guard — synchronous, never throws.
  if (!cfg || cfg.genome?.autoCapture === false) return;

  // Kick off async work without blocking the caller.
  void (async () => {
    try {
      const goal = stripSecrets((run.goal ?? '').trim());
      if (!goal) return;

      // Derive project from run's cwd or engine — not available on RunState
      // directly, so we leave it null (hub-scoped).
      const project: string | null = null;

      const summary = summarizeForGenome({
        goal,
        result: run.result,
        tasks: run.tasks,
      });

      if (isDuplicate(goal, project, summary, cfg)) return;

      const outcome = mapRunOutcome(run.status);
      const tags = buildTags(
        'run',
        outcome,
        run.engine,
        run.provider,
      );

      appendHubEntry({
        title: goal.slice(0, TITLE_MAX_CHARS),
        text: summary,
        project: project ?? undefined,
        tags,
        // Auto-capture: hub store only — never write into a repo working tree.
        hubOnly: true,
      });
    } catch {
      // Swallow all errors — never surface to caller.
    }
  })();
}

// ---------------------------------------------------------------------------
// Public: captureFromSwarm
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: capture a GenomeEntry summarising a completed SwarmRun.
 *
 * - MUST NOT throw. MUST NOT block the caller.
 * - No-op when cfg.genome?.autoCapture === false.
 * - Dedupe-aware: skips near-identical recent entries.
 */
export function captureFromSwarm(s: SwarmRun, cfg: AshlrConfig): void {
  if (!cfg || cfg.genome?.autoCapture === false) return;

  void (async () => {
    try {
      const goal = stripSecrets((s.goal ?? '').trim());
      if (!goal) return;

      // Project: the swarm has an explicit project path; use its basename.
      const project: string | null = s.project
        ? s.project.trim() || null
        : null;

      // Build task list for summarizer — use SwarmTaskRun records (status +
      // goal from the plan spec via id match). We pass SwarmTaskRun as tasks;
      // summarizeForGenome reads .goal and .status generically.
      const planTasksByPhase = s.plan?.tasks ?? [];
      // Merge plan goals onto task run statuses for a richer sketch.
      const taskSummaries = s.tasks.map((t) => {
        const spec = planTasksByPhase.find((p) => p.id === t.id);
        return {
          id: t.id,
          status: t.status,
          // Goal from the spec (never from result/error body).
          goal: typeof (spec as unknown as Record<string, unknown> | undefined)?.['goal'] === 'string'
            ? ((spec as unknown as Record<string, unknown>)['goal'] as string)
            : t.id,
        };
      });

      // Phase sketch (count only, no content).
      const phases = new Set(s.tasks.map((t) => t.phase).filter(Boolean));
      const phaseNote = phases.size > 0
        ? `Phases: ${[...phases].join(', ')}`
        : '';

      const summary = summarizeForGenome({
        goal,
        result: phaseNote || s.result,
        tasks: taskSummaries,
      });

      if (isDuplicate(goal, project, summary, cfg)) return;

      const outcome = mapSwarmOutcome(s.status);
      const tags = buildTags(
        'swarm',
        outcome,
        project,
        phases.size > 0 ? `phases:${phases.size}` : null,
      );

      appendHubEntry({
        title: goal.slice(0, TITLE_MAX_CHARS),
        text: summary,
        project: project ?? undefined,
        tags,
        // Auto-capture: hub store only — never write into a repo working tree.
        hubOnly: true,
      });
    } catch {
      // Swallow all errors — never surface to caller.
    }
  })();
}
