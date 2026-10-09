import { scrubSecrets } from '../knowledge/index.js';
import type { OutcomeTaskContextResult } from './outcome-task-context.js';

const NATIVE_CONTEXT_BYTES = 32 * 1024;
const EXCERPT_CODE_POINTS = 1024;

/** Preserve JSON structure while scrubbing string values, including secrets across excerpt boundaries. */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, scrubValue(field)]));
  return value;
}
function excerpt(value: unknown): { value: unknown; excerpts: number } {
  if (Array.isArray(value)) {
    const rows = value.map(excerpt);
    return { value: rows.map(row => row.value), excerpts: rows.reduce((total, row) => total + row.excerpts, 0) };
  }
  if (!value || typeof value !== 'object') return { value, excerpts: 0 };
  let excerpts = 0;
  const fields = Object.fromEntries(Object.entries(value).map(([key, field]) => {
    if (key === 'content' && typeof field === 'string' && field.length > EXCERPT_CODE_POINTS) {
      const points = Array.from(field);
      if (points.length > EXCERPT_CODE_POINTS) { excerpts++; return [key, points.slice(0, EXCERPT_CODE_POINTS).join('')]; }
    }
    const child = excerpt(field); excerpts += child.excerpts; return [key, child.value];
  }));
  // Only the content excerpt differs from the recorded evidence; identity, source references and times are retained.
  if (typeof fields.content === 'string' && fields.content !== (value as { content?: unknown }).content) fields.contentComplete = false;
  return { value: fields, excerpts };
}

/** Native transport projection, not a work budget. Large evidence stays in its private store. */
export function renderOutcomeTaskContextText(result: OutcomeTaskContextResult): string {
  if (!result.ok) return JSON.stringify(scrubValue(result));
  const { current, history, conflicts, ...metadata } = result.context;
  const projected = {
    ok: true,
    context: { ...scrubValue(metadata) as typeof metadata, current: [] as unknown[], history: [] as unknown[], conflicts: [] as unknown[],
      outputProjection: { partial: false, omittedEvents: 0, omittedConflicts: 0, excerptedContents: 0 } },
  };
  // Reserve the partial reason and changing counters before admitting any evidence. Account UTF-8 bytes, not characters.
  projected.context.coverage = { ...projected.context.coverage, complete: false,
    stopReasons: [...new Set([...projected.context.coverage.stopReasons, 'native-output-byte-limit'])] };
  let used = Buffer.byteLength(JSON.stringify(projected), 'utf8') + 128;
  for (const [key, rows] of [['current', current], ['history', history], ['conflicts', conflicts]] as const) {
    for (const raw of rows) {
      const safe = scrubValue(raw);
      let candidate = { value: safe, excerpts: 0 };
      let size = Buffer.byteLength(JSON.stringify(candidate.value), 'utf8') + 1;
      if (used + size > NATIVE_CONTEXT_BYTES) {
        candidate = excerpt(safe); size = Buffer.byteLength(JSON.stringify(candidate.value), 'utf8') + 1;
      }
      if (used + size > NATIVE_CONTEXT_BYTES) {
        if (key === 'conflicts') projected.context.outputProjection.omittedConflicts++;
        else projected.context.outputProjection.omittedEvents++;
      } else {
        projected.context[key].push(candidate.value); used += size;
        projected.context.outputProjection.excerptedContents += candidate.excerpts;
      }
    }
  }
  const projection = projected.context.outputProjection;
  projection.partial = projection.omittedEvents > 0 || projection.omittedConflicts > 0 || projection.excerptedContents > 0;
  if (!projection.partial) projected.context.coverage = scrubValue(result.context.coverage) as typeof result.context.coverage;
  const text = JSON.stringify(projected);
  // Scoped metadata is bounded by the source contracts. Fail with valid static JSON if that contract changes.
  return Buffer.byteLength(text, 'utf8') <= NATIVE_CONTEXT_BYTES ? text : JSON.stringify({ ok: false, reason: 'unknown-source' });
}
