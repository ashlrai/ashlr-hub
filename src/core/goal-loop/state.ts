/**
 * Persistence for the Goal Loop runner — load/save/merge the durable state.json
 * that lets the loop resume cold after any milestone (see docs/MILESTONE-CONTRACT.md).
 *
 * state.json holds ONLY tiny per-milestone summaries + bookkeeping — never the
 * agents' heavy context. It lives next to the roadmap index. Writes are atomic
 * (tmp-write + rename), matching src/core/inbox/store.ts, so a crash mid-write
 * leaves the OLD complete file, never a partial one.
 *
 * Everything here is tolerant: a missing or malformed state.json yields a FRESH
 * state rather than throwing — the loop must always be able to (re)start.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  GoalLoopState,
  MilestoneResult,
  MilestoneStateEntry,
} from './types.js';

/** ISO timestamp helper — single call site so tests can reason about it. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Absolute path to the state file for a given roadmap directory. */
export function statePath(dir: string): string {
  return resolve(dir, 'state.json');
}

/** A fresh, empty state for a roadmap that has never been run. */
function freshState(roadmapPath: string): GoalLoopState {
  return {
    version: 1,
    roadmap: resolve(roadmapPath),
    active: null,
    milestones: {},
    updatedAt: nowIso(),
  };
}

/**
 * Whether a parsed value is a usable GoalLoopState. Deliberately shallow — we
 * accept anything with the right scalar/record shape and let `loadState` repair
 * the rest, because a partially-written file is still better than a hard reset.
 */
function isStateShape(v: unknown): v is GoalLoopState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    s['version'] === 1 &&
    typeof s['roadmap'] === 'string' &&
    typeof s['milestones'] === 'object' &&
    s['milestones'] !== null
  );
}

/**
 * Load the persisted state for a roadmap directory.
 *
 * Returns a FRESH state when the file is absent or malformed (never throws). When
 * present and shaped, `roadmap` is normalised to the supplied `roadmapPath` so a
 * moved roadmap dir doesn't strand the state.
 */
export function loadState(dir: string, roadmapPath: string): GoalLoopState {
  const path = statePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return freshState(roadmapPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshState(roadmapPath);
  }

  if (!isStateShape(parsed)) return freshState(roadmapPath);

  // Accept the file, but re-anchor the roadmap path to the one we were asked for.
  return { ...parsed, roadmap: resolve(roadmapPath) };
}

/**
 * Persist state atomically: write `<dir>/state.json.tmp`, then rename over the
 * real file (POSIX-atomic). Stamps `updatedAt`. Creates the directory if needed.
 */
export function saveState(dir: string, state: GoalLoopState): void {
  const dest = statePath(dir);
  mkdirSync(dirname(dest), { recursive: true });
  const toWrite: GoalLoopState = { ...state, updatedAt: nowIso() };
  const tmp = dest + '.tmp';
  writeFileSync(tmp, JSON.stringify(toWrite, null, 2) + '\n', 'utf8');
  renameSync(tmp, dest);
}

/** Union two id lists, preserving first-seen order. */
function unionIds(existing: string[], incoming: string[]): string[] {
  const out = existing.slice();
  const seen = new Set(existing);
  for (const id of incoming) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Fold a per-milestone `MilestoneResult` into the state, MERGING (never
 * clobbering): `steps_done` is the UNION across runs and never shrinks; the
 * latest status/gate/blocked_on/summary win. Sets `active` to this milestone.
 *
 * Returns a NEW state object (input is not mutated).
 */
export function mergeResult(
  state: GoalLoopState,
  result: MilestoneResult,
): GoalLoopState {
  const id = result.milestone;
  const prev = state.milestones[id];
  const entry: MilestoneStateEntry = {
    milestone: id,
    status: result.status,
    gate_passed: result.gate_passed,
    steps_done: unionIds(prev?.steps_done ?? [], result.steps_completed ?? []),
    blocked_on: result.blocked_on,
    summary: result.summary,
    updatedAt: nowIso(),
  };
  return {
    ...state,
    active: id,
    milestones: { ...state.milestones, [id]: entry },
  };
}

/**
 * Whether a milestone is fully complete per the resume rule: status `done` AND
 * the acceptance gate passed. Anything else is (re-)dispatched on resume.
 */
export function isMilestoneComplete(
  state: GoalLoopState,
  milestoneId: string,
): boolean {
  const e = state.milestones[milestoneId];
  return !!e && e.status === 'done' && e.gate_passed === true;
}

/** The step ids already verified for a milestone (fed to the agent on resume). */
export function stepsDone(state: GoalLoopState, milestoneId: string): string[] {
  return state.milestones[milestoneId]?.steps_done ?? [];
}
