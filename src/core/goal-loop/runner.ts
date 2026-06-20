/**
 * The Goal Loop driver + default per-milestone executor
 * (see docs/MILESTONE-CONTRACT.md).
 *
 * The driver is a tiny, durable loop: it reads the roadmap + state, dispatches
 * each incomplete milestone to a RunMilestoneFn, ticks verified steps back into
 * the milestone file, persists a few-KB summary, and STOPS cleanly the moment a
 * milestone needs a human / is blocked / is only partially done. It holds no
 * agent context — only the small MilestoneResult crosses back — so a long roadmap
 * never bloats the driver's window. It is fully resumable: re-running picks up
 * exactly where it stopped from state.json.
 *
 * The default executor spawns a FRESH agent process scoped to exactly one
 * milestone file (the context reset), reusing the hardened engine seam in
 * src/core/run/engines.ts. It never throws: any spawn/parse failure becomes a
 * `blocked` result the driver turns into a clean stop.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { AshlrConfig, EngineId } from '../types.js';
import { buildEngineCommand, engineInstalled, spawnEngine } from '../run/engines.js';
import { parseMilestone, parseRoadmap, tickSteps } from './parse.js';
import { parseMilestoneResult } from './result.js';
import {
  isMilestoneComplete,
  loadState,
  mergeResult,
  saveState,
  statePath,
} from './state.js';
import type {
  MilestoneDoc,
  MilestoneResult,
  RunMilestoneContext,
  RunMilestoneFn,
} from './types.js';

// ---------------------------------------------------------------------------
// Run summary (returned to the CLI)
// ---------------------------------------------------------------------------

/** Per-milestone outcome line in a run summary. */
export interface MilestoneOutcome {
  milestone: string;
  title: string;
  /** 'skipped' when already complete in state; otherwise the reported status. */
  outcome: 'skipped' | MilestoneResult['status'];
  summary: string;
  blocked_on: string | null;
}

/** What a Goal Loop run did, and where (if anywhere) it paused. */
export interface GoalLoopRunSummary {
  roadmap: string;
  /** Outcomes in execution order. */
  outcomes: MilestoneOutcome[];
  /** Milestone id the loop stopped at (needs_human/blocked/in_progress), or null if it ran out. */
  stoppedAt: string | null;
  /** Why it stopped, or null when every milestone is complete. */
  stopReason: string | null;
  /** True when every roadmap milestone is `done` + gate-passed. */
  allComplete: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunGoalLoopOptions {
  /** Roadmap directory (where state.json lives). */
  dir: string;
  /** Loaded hub config. */
  cfg: AshlrConfig;
  /** Explicit roadmap index filename (else roadmap.md / ROADMAP.md / README.md). */
  roadmapFile?: string;
  /** Predict automatable-vs-human per step and touch nothing. */
  dryRun?: boolean;
  /** Injectable executor (tests pass a fake; defaults to the spawning executor). */
  runMilestone?: RunMilestoneFn;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * Run (or resume) the Goal Loop over a roadmap. Sequential, dependency-ordered;
 * stops at the first milestone that is not `done` + gate-passed. Resumable: a
 * second call skips already-complete milestones and continues.
 */
export async function runGoalLoop(opts: RunGoalLoopOptions): Promise<GoalLoopRunSummary> {
  const runMilestone = opts.runMilestone ?? defaultRunMilestone;
  const index = parseRoadmap(opts.dir, opts.roadmapFile);
  let state = loadState(index.dir, index.path);

  const outcomes: MilestoneOutcome[] = [];
  let stoppedAt: string | null = null;
  let stopReason: string | null = null;

  for (const entry of index.milestones) {
    if (isMilestoneComplete(state, entry.id)) {
      outcomes.push({
        milestone: entry.id,
        title: entry.title,
        outcome: 'skipped',
        summary: state.milestones[entry.id]?.summary ?? 'already complete',
        blocked_on: null,
      });
      continue;
    }

    const doc = parseMilestone(entry.file, entry.id);

    // Record the in-flight milestone BEFORE dispatch so a crash mid-milestone
    // leaves a breadcrumb (active) the next run can report.
    state = { ...state, active: entry.id };
    saveState(index.dir, state);

    const ctx: RunMilestoneContext = {
      dir: index.dir,
      statePath: statePath(index.dir),
      dryRun: opts.dryRun ?? false,
      cfg: opts.cfg,
    };

    // The executor MUST NOT throw; treat a null/thrown result as blocked.
    let result: MilestoneResult;
    try {
      result =
        (await runMilestone(doc, ctx)) ??
        blocked(entry.id, 'executor returned no result');
    } catch (err) {
      result = blocked(entry.id, `executor threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Tick verified steps back into the milestone file (byte-faithful), unless dry-run.
    if (!ctx.dryRun && result.steps_completed.length > 0) {
      tickMilestoneFile(doc, result.steps_completed);
    }

    state = mergeResult(state, result);
    saveState(index.dir, state);

    outcomes.push({
      milestone: entry.id,
      title: entry.title,
      outcome: result.status,
      summary: result.summary,
      blocked_on: result.blocked_on,
    });

    // Only `done` + gate-passed advances; anything else is a clean pause.
    if (result.status !== 'done' || !result.gate_passed) {
      stoppedAt = entry.id;
      stopReason =
        result.blocked_on ??
        (result.status === 'done' ? 'acceptance gate not passed' : `status: ${result.status}`);
      break;
    }
  }

  return {
    roadmap: index.path,
    outcomes,
    stoppedAt,
    stopReason,
    allComplete: stoppedAt === null && index.milestones.every((m) => isMilestoneComplete(state, m.id)),
  };
}

// ---------------------------------------------------------------------------
// Default executor — spawns a fresh agent scoped to ONE milestone file
// ---------------------------------------------------------------------------

/**
 * The default RunMilestoneFn: build a prompt scoped to exactly one milestone,
 * spawn the configured engine in a fresh process (the context reset), and parse
 * its structured JSON. Never throws — returns a `blocked` result on any failure.
 *
 * Engine selection honors `ASHLR_ENGINE` (defaulting to `claude`); the model
 * honors `ASHLR_MODEL` / `AC_MODEL`, matching the orchestrator's resolution.
 * `builtin` is rejected: it runs in-process and so cannot provide the per-
 * milestone context reset this loop depends on.
 */
export const defaultRunMilestone: RunMilestoneFn = async (doc, ctx) => {
  const engine = (process.env['ASHLR_ENGINE'] as EngineId | undefined) ?? 'claude';
  const model = process.env['ASHLR_MODEL'] ?? process.env['AC_MODEL'];

  if (engine === 'builtin') {
    return blocked(
      doc.id,
      'builtin engine runs in-process and cannot give a fresh per-milestone context; set ASHLR_ENGINE=claude (or aw)',
    );
  }
  if (!engineInstalled(engine)) {
    return blocked(doc.id, `engine "${engine}" not found on PATH`);
  }

  const prompt = buildMilestonePrompt(doc, ctx.dryRun);
  const cmd = buildEngineCommand(engine, prompt, ctx.cfg, { cwd: ctx.dir, model });
  if (!cmd) {
    return blocked(doc.id, `engine "${engine}" produced no command`);
  }

  const res = spawnEngine(cmd, ctx.cfg);
  if (!res.ok) {
    return blocked(doc.id, `engine "${engine}" failed: ${res.error ?? 'unknown error'}`);
  }

  return parseMilestoneResult(res.output, doc.id);
};

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/** Build the single-milestone agent prompt: the file, what's done, the strict contract. */
export function buildMilestonePrompt(doc: MilestoneDoc, dryRun: boolean): string {
  const alreadyDone = doc.steps.filter((s) => s.checked).map((s) => s.id);
  const fileBody = doc.lines.join('\n');

  const lines: string[] = [
    `You are executing ONE milestone of a larger roadmap: ${doc.id} — ${doc.title}.`,
    '',
    'Work ONLY on the steps in this milestone. Do not touch other milestones.',
    'For each step, do the work and verify its `Done when:` check before marking it complete.',
    '',
  ];

  if (alreadyDone.length > 0) {
    lines.push(
      `These steps are ALREADY complete — do NOT redo them: ${alreadyDone.join(', ')}.`,
      '',
    );
  }

  if (dryRun) {
    lines.push(
      'DRY RUN: do NOT make any changes. PREDICT, per step, whether it is automatable',
      'or needs a human, and report status `in_progress` with a prediction summary.',
      '',
    );
  } else {
    lines.push(
      'If a step requires a human (manual web action, cloud GPU/notebook, sign-off,',
      'external upload or credentials), do NOT attempt it: stop and report',
      '`needs_human` with `blocked_on` describing exactly what the human must do.',
      'If an automatable step fails twice, report `blocked`.',
      '',
    );
  }

  lines.push(
    '--- MILESTONE FILE ---',
    fileBody,
    '--- END MILESTONE FILE ---',
    '',
    'When finished, return ONLY a single JSON object (no prose, no code fence) of EXACTLY this shape:',
    '{',
    `  "milestone": ${JSON.stringify(doc.id)},`,
    '  "status": "done" | "needs_human" | "blocked" | "in_progress",',
    '  "gate_passed": <true only if the acceptance checklist passes>,',
    '  "steps_completed": ["<step ids you verified this run>"],',
    '  "blocked_on": <string describing the blocker, or null>,',
    '  "summary": "<one short sentence on what happened>"',
    '}',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Construct a `blocked` MilestoneResult — the never-throws fallback. */
function blocked(milestone: string, reason: string): MilestoneResult {
  return {
    milestone,
    status: 'blocked',
    gate_passed: false,
    steps_completed: [],
    blocked_on: reason,
    summary: reason,
  };
}

/**
 * Tick the named steps in a milestone file and write it back, preserving the
 * file's existing EOL style (CRLF on Windows-authored files) so the change is
 * byte-faithful apart from the flipped checkboxes. No-op when nothing changed.
 */
function tickMilestoneFile(doc: MilestoneDoc, completedIds: string[]): void {
  const { lines, changed } = tickSteps(doc, completedIds);
  if (!changed) return;
  let eol = '\n';
  try {
    if (readFileSync(doc.path, 'utf8').includes('\r\n')) eol = '\r\n';
  } catch {
    // unreadable — fall back to LF
  }
  writeFileSync(doc.path, lines.join(eol), 'utf8');
}
