import { describe, expect, it } from 'vitest';
import { createTaskContextEvent } from '../src/core/context/task-temporal-context.js';
import { renderOutcomeTaskContextText } from '../src/core/verse/outcome-task-context-output.js';
import type { OutcomeTaskContextView } from '../src/core/verse/outcome-task-context.js';

function fixture(): OutcomeTaskContextView {
  return { schemaVersion: 1, taskRef: 'outcome:one:node:task', asOf: '2026-10-09T10:00:00.000Z', observedThrough: '2026-10-09T10:00:00.000Z',
    coverage: { sourceState: 'healthy', complete: true, stopReasons: [] }, current: [], history: [], conflicts: [],
    outcomeId: 'one', taskId: 'task-id', outcomeRevision: 2, active: true, snapshotObservedAt: '2026-10-09T10:00:00.000Z',
    metadataTemporalScope: 'current-read', sources: [] };
}
function event(objectRef: string, content: string) {
  return { ...createTaskContextEvent({ taskRef: fixture().taskRef,
    source: { kind: 'project-memory', provider: 'phantom', accountRef: 'phantom-local', objectRef, revisionRef: 'one' },
    sourceRefs: [`phantom:memory:${objectRef}`], occurredAt: null, observedAt: fixture().snapshotObservedAt,
    validFrom: null, validUntil: null, kind: 'upsert', epistemic: 'recorded', content, supersedes: [] }),
  status: 'current' as const, temporalResolution: 'unknown' as const, replacedBy: [] };
}
describe('native private context output projection', () => {
  it('keeps small complete results complete without changing evidence', () => {
    const context = fixture(); context.current.push(event('small', 'Useful fact.'));
    const result = JSON.parse(renderOutcomeTaskContextText({ ok: true, context }));
    expect(result.context.current).toEqual(context.current);
    expect(result.context.coverage).toEqual(context.coverage);
    expect(result.context.outputProjection).toEqual({ partial: false, omittedEvents: 0, omittedConflicts: 0, excerptedContents: 0 });
    expect(JSON.parse(renderOutcomeTaskContextText({ ok: false, reason: 'not-found' }))).toEqual({ ok: false, reason: 'not-found' });
  });
  it('caps UTF-8 JSON bytes, reports omissions and preserves provenance while leaving stored contents untouched', () => {
    const context = fixture();
    context.current = Array.from({ length: 80 }, (_, index) => event(`note-${index}`, 'Useful multilingual 中文😀 fact. '.repeat(300)));
    const before = JSON.stringify(context);
    const text = renderOutcomeTaskContextText({ ok: true, context }), result = JSON.parse(text);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(result.context.coverage).toMatchObject({ complete: false, stopReasons: ['native-output-byte-limit'] });
    expect(result.context.outputProjection.omittedEvents).toBeGreaterThan(0);
    expect(result.context.outputProjection.excerptedContents).toBeGreaterThan(0);
    expect(result.context.current[0].sourceRefs).toEqual(context.current[0]!.sourceRefs);
    expect(JSON.stringify(context)).toBe(before);
  });
  it('scrubs whole content before excerpting and never emits a JSON truncation marker', () => {
    const context = fixture(), secret = `sk-${'Ab1c'.repeat(24)}`;
    context.current.push(event('secret-note', `${'Ordinary words. '.repeat(65)}${secret} ${'More ordinary words. '.repeat(3000)}`));
    const text = renderOutcomeTaskContextText({ ok: true, context }), result = JSON.parse(text);
    expect(text).not.toContain(secret); expect(text).not.toContain('Ab1c');
    expect(text).not.toContain('output truncated');
    expect(result.context.current[0].contentComplete).toBe(false);
    expect(result.context.outputProjection.partial).toBe(true);
  });
  it('handles large conflict alternatives and escaped control characters without breaking JSON or retaining complete coverage', () => {
    const context = fixture();
    const left = event('conflict', 'Useful line.\n\t'.repeat(5000)), right = event('conflict', 'Other fact.\n'.repeat(5000));
    context.conflicts.push({ kind: 'revision-conflict', eventIds: [left.eventId], alternatives: [left, right] });
    const text = renderOutcomeTaskContextText({ ok: true, context }), result = JSON.parse(text);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(result.context.coverage.complete).toBe(false);
    expect(result.context.conflicts[0].alternatives[0].contentComplete).toBe(false);
    expect(result.context.outputProjection.excerptedContents).toBe(2);
  });
});
