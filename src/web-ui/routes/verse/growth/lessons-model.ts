/**
 * routes/verse/growth/lessons-model.ts — pure helpers for the Lessons view.
 */
import type {
  KnowledgeScope,
  LessonsCauseRow,
  RetroEndKind,
  RetroSource,
  TaskKind,
} from '../../../../core/learn/retro/types.js';
import { TASK_KINDS } from '../../../../core/learn/retro/types.js';

export const END_KIND_LABEL: Readonly<Record<RetroEndKind, string>> = {
  merged: 'Merged',
  reverted: 'Reverted',
  closed: 'Closed',
  'gate-refused': 'Refused',
  'owner-laned': 'Owner lane',
  'verify-failed': 'Verify failed',
  failed: 'Failed',
  expired: 'Expired',
  vetoed: 'Vetoed',
};

export const END_KIND_TONE: Readonly<Record<RetroEndKind, 'success' | 'danger' | 'warning' | 'neutral'>> = {
  merged: 'success',
  reverted: 'danger',
  closed: 'neutral',
  'gate-refused': 'warning',
  'owner-laned': 'neutral',
  'verify-failed': 'danger',
  failed: 'danger',
  expired: 'neutral',
  vetoed: 'warning',
};

export const SOURCE_LABEL: Readonly<Record<RetroSource, string>> = { fleet: 'Fleet', cloud: 'Cloud', leader: 'Leader' };
export const SOURCES: readonly RetroSource[] = ['fleet', 'cloud', 'leader'];

/** The causes chart: one category per cause, one stacked segment per source. */
export function causeChart(causes: readonly LessonsCauseRow[], max = 8): { categories: string[]; values: number[][] } {
  const rows = causes.slice(0, max);
  return {
    categories: rows.map((r) => r.label),
    values: rows.map((r) => SOURCES.map((s) => r.bySource[s] ?? 0)),
  };
}

export function scopeLabel(scope: KnowledgeScope): string {
  const parts = [scope.repo ?? 'Any repo'];
  if (scope.pathGlobs.length > 0) parts.push(scope.pathGlobs.join(', '));
  parts.push(scope.taskKinds.length > 0 ? scope.taskKinds.join(' / ') : 'any task');
  return parts.join(' · ');
}

/** Parse the edit form back into a scope; null when a field is not valid. */
export function parseScopeForm(repo: string, globs: string, kinds: string): KnowledgeScope | null {
  const r = repo.trim();
  if (r !== '' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) return null;
  const pathGlobs = globs.split(',').map((g) => g.trim()).filter(Boolean);
  if (pathGlobs.some((g) => !/^[A-Za-z0-9_.*?{},/@+-]+$/.test(g) || g.includes('..'))) return null;
  const taskKinds = kinds.split(/[,/ ]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (taskKinds.some((k) => !(TASK_KINDS as readonly string[]).includes(k))) return null;
  return { repo: r === '' ? null : r, pathGlobs, taskKinds: taskKinds as TaskKind[] };
}

/** "3 KB of 16 KB" style budget line. */
export function budgetLine(bytes: number, cap: number): string {
  const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`);
  return `${kb(bytes)} approved · each prompt gets at most ${kb(cap)}`;
}
