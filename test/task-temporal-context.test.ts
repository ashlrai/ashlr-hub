import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendTaskContextEvent, createTaskContextEvent, parseTaskContextEvent, projectTaskTemporalContext, readTaskTemporalContext,
  taskContextTimestamp, type TaskContextEventInput, type TaskContextEventV1 } from '../src/core/context/task-temporal-context.js';
import { outcomeDigest } from '../src/core/goals/outcome-types.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const taskRef = 'outcome:one:node:a';
const accountRefs = ['work-account'];
const instant = '2026-10-09T10:00:00.000Z';
function event(overrides: Partial<TaskContextEventInput> = {}): TaskContextEventV1 {
  return createTaskContextEvent({ taskRef, source: { kind: 'calendar', provider: 'google', accountRef: 'work-account',
    objectRef: 'meeting-one', revisionRef: 'revision-one' }, sourceRefs: ['google-calendar:work-account:meeting-one:revision-one'],
  occurredAt: '2026-10-08T10:00:00.000Z', observedAt: '2026-10-08T10:05:00.000Z', validFrom: null, validUntil: null,
  kind: 'upsert', epistemic: 'recorded', content: 'Meeting starts at 11 AM.', supersedes: [], ...overrides });
}
function project(events: TaskContextEventV1[], overrides: Partial<Parameters<typeof projectTaskTemporalContext>[0]> = {}) {
  return projectTaskTemporalContext({ taskRef, accountRefs, asOf: instant, observedThrough: instant,
    sourceState: 'healthy', complete: true, events, ...overrides });
}
function root() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'task-context-')));
  chmodSync(directory, 0o700); roots.push(directory); return directory;
}
describe('private temporal task context', () => {
  it('normalizes explicit timezone offsets and rejects ambiguous or invalid wall-clock timestamps', () => {
    expect(taskContextTimestamp('2026-11-01T01:30:00-04:00')).toBe('2026-11-01T05:30:00.000Z');
    expect(taskContextTimestamp('2026-11-01T01:30:00-05:00')).toBe('2026-11-01T06:30:00.000Z');
    expect(taskContextTimestamp('2024-02-29T12:00:00Z')).toBe('2024-02-29T12:00:00.000Z');
    for (const input of ['2026-02-29T12:00:00Z', '2026-04-31T12:00:00Z', '2026-10-09T24:00:00Z',
      '2026-10-09T10:00:00', '2026-10-09', 'next Friday', '2026-10-09T10:00:60Z']) expect(taskContextTimestamp(input)).toBeNull();
  });
  it('preserves unknown event time and cannot use an unknown-effective revision to erase known evidence', () => {
    const first = event();
    const unknown = event({ source: { ...first.source, revisionRef: 'unknown-date' }, occurredAt: null,
      content: 'The meeting may have changed.', supersedes: [first.eventId] });
    const result = project([first, unknown]);
    expect(result.current).toHaveLength(2);
    expect(result.current.find(item => item.eventId === unknown.eventId)).toMatchObject({ occurredAt: null, temporalResolution: 'unknown' });
    expect(result.conflicts).toContainEqual({ kind: 'unknown-effective-time', eventIds: [unknown.eventId, first.eventId] });
  });
  it('separates occurrence time from late observation and answers both historical views honestly', () => {
    const first = event();
    const change = event({ source: { ...first.source, revisionRef: 'revision-two' }, occurredAt: '2026-10-08T11:00:00Z',
      observedAt: '2026-10-09T09:00:00Z', content: 'Meeting starts at noon.', supersedes: [first.eventId] });
    const beforeArrival = project([first, change], { observedThrough: '2026-10-08T12:00:00Z' });
    expect(beforeArrival.current.map(item => item.content)).toEqual([first.content]);
    const retrospective = project([first, change], { asOf: '2026-10-08T12:00:00Z' });
    expect(retrospective.current.map(item => item.content)).toEqual([change.content]);
    expect(retrospective.history[0]).toMatchObject({ eventId: first.eventId, status: 'superseded', replacedBy: [change.eventId] });
    expect(project([first, change], { asOf: '2026-10-08T10:30:00Z' }).current[0]!.eventId).toBe(first.eventId);
  });
  it('resolves a late predecessor without discarding the newer revision or its original provenance', () => {
    const first = event();
    const next = event({ source: { ...first.source, revisionRef: 'revision-two' }, occurredAt: '2026-10-08T12:00:00Z',
      content: 'Meeting moved.', supersedes: [first.eventId] });
    expect(project([next]).conflicts[0]!.kind).toBe('missing-predecessor');
    const result = project([next, first]);
    expect(result.conflicts).toEqual([]);
    expect(result.current[0]!.sourceRefs).toEqual(next.sourceRefs);
    expect(result.history[0]!.sourceRefs).toEqual(first.sourceRefs);
  });
  it('applies cancellations and validity expiry without deleting the evidence', () => {
    const first = event();
    const cancellation = event({ source: { ...first.source, revisionRef: 'cancel' }, kind: 'cancel',
      occurredAt: '2026-10-08T12:00:00Z', content: 'Meeting canceled.', supersedes: [first.eventId] });
    const result = project([first, cancellation]);
    expect(result.current).toEqual([]);
    expect(result.history).toHaveLength(2);
    expect(result.history.every(item => item.status === 'canceled')).toBe(true);
    expect(project([event({ validUntil: '2026-10-09T09:00:00Z' })]).history[0]!.status).toBe('expired');
  });
  it('does not let an assertion from another account, task or source object supersede an original', () => {
    const first = event();
    const otherAccount = event({ source: { ...first.source, accountRef: 'personal-account', revisionRef: 'two' },
      content: 'Personal meeting.', supersedes: [first.eventId] });
    const otherTask = event({ taskRef: 'other-task', content: 'Different task.' });
    expect(project([first, otherAccount, otherTask]).current.map(item => item.eventId)).toEqual([first.eventId]);
    const together = project([first, otherAccount], { accountRefs: ['work-account', 'personal-account'] });
    expect(together.current).toHaveLength(2);
    expect(together.conflicts[0]!.kind).toBe('invalid-supersession');
    expect(project([first], { accountRefs: [] }).current).toEqual([]);
  });
  it('keeps hypotheses distinct and does not turn them into authoritative cancellation', () => {
    const first = event();
    const opinion = event({ source: { ...first.source, revisionRef: 'opinion' }, epistemic: 'hypothesis', kind: 'cancel',
      content: 'I think this was canceled.', supersedes: [first.eventId] });
    expect(project([first, opinion]).current[0]!.eventId).toBe(first.eventId);
  });
  it('surfaces unlinked contradictory revisions instead of choosing by lexicographic revision or arrival time', () => {
    const first = event();
    const contradiction = event({ source: { ...first.source, revisionRef: 'zz-latest' }, content: 'Meeting starts at 3 PM.' });
    const result = project([contradiction, first]);
    expect(result.current).toHaveLength(2);
    expect(result.current.every(item => item.status === 'conflicted')).toBe(true);
    expect(result.conflicts[0]!.kind).toBe('unlinked-revisions');
  });
  it('retains independent sources that report the same text instead of deduplicating away their provenance', () => {
    const first = event();
    const github = event({ source: { ...first.source, kind: 'github', provider: 'github', objectRef: 'issue-3' }, sourceRefs: ['https://github.com/example/repo/issues/3'] });
    const result = project([first, github, first]);
    expect(result.current).toHaveLength(2);
    expect(result.current.map(item => item.source.kind).sort()).toEqual(['calendar', 'github']);
  });
  it('detects cycles and changed payloads under the same source revision', () => {
    const first = event();
    const second = event({ source: { ...first.source, revisionRef: 'second' }, supersedes: [first.eventId] });
    const linkedFirst = event({ supersedes: [second.eventId] });
    const cycle = project([linkedFirst, second]);
    expect(cycle.current.every(item => item.status === 'conflicted')).toBe(true);
    expect(cycle.conflicts[0]!.kind).toBe('supersession-cycle');
    expect(project([first, event({ content: 'Changed under same revision.' })]).conflicts[0]!.kind).toBe('revision-conflict');
  });
  it('retains missing, partial and malformed-source coverage instead of claiming no facts exist', () => {
    expect(project([], { sourceState: 'missing', complete: true }).coverage.complete).toBe(false);
    expect(project([event()], { complete: false, stopReasons: ['byte-limit'] }).coverage).toMatchObject({ complete: false, stopReasons: ['byte-limit'] });
    const another = event({ source: { ...event().source, objectRef: 'another' } });
    expect(project([event(), another], { maxEvents: 1 }).coverage).toMatchObject({ complete: false, stopReasons: ['event-limit'] });
    expect(project([{ ...event(), kind: 'invented' } as never]).coverage).toMatchObject({ sourceState: 'degraded', complete: false });
  });
  it('does not initialize storage during reads or unauthorized ingestion; rechecks authorization before committing', () => {
    const directory = root();
    expect(readTaskTemporalContext({ root: directory, taskRef, accountRefs }).coverage).toMatchObject({ sourceState: 'missing', complete: false });
    expect(readdirSync(directory)).toEqual([]);
    expect(appendTaskContextEvent({ root: directory, event: event(), stillAuthorized: () => false })).toBe('invalid');
    expect(readdirSync(directory)).toEqual([]);
    let checks = 0;
    expect(appendTaskContextEvent({ root: directory, event: event(), stillAuthorized: () => ++checks === 1 })).toBe('failed');
    expect(readTaskTemporalContext({ root: directory, taskRef, accountRefs }).current).toEqual([]);
  });
  it('persists exact-private evidence, replays duplicate delivery and rejects a changed source revision', () => {
    const directory = root(), first = event();
    const write = (record: TaskContextEventV1) => appendTaskContextEvent({ root: directory, event: record, stillAuthorized: () => true });
    expect(write(first)).toBe('recorded');
    expect(write(event({ observedAt: instant }))).toBe('replayed');
    expect(write(event({ content: 'Conflicting content.' }))).toBe('conflicted');
    const store = join(directory, `task-context-${outcomeDigest(taskRef)}`);
    expect(lstatSync(store).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(store, 'records', `${first.eventId}.json`)).mode & 0o777).toBe(0o600);
    const result = readTaskTemporalContext({ root: directory, taskRef, accountRefs, asOf: instant, observedThrough: instant });
    expect(result.coverage.complete).toBe(true);
    expect(result.current[0]!.observedAt).toBe(first.observedAt);
    expect(result.current[0]!.content).toBe(first.content);
  });
  it('rejects unsafe storage and malformed evidence without leaking an adjacent account record', () => {
    const directory = root(), elsewhere = root();
    const store = join(directory, `task-context-${outcomeDigest(taskRef)}`);
    symlinkSync(elsewhere, store);
    expect(appendTaskContextEvent({ root: directory, event: event(), stillAuthorized: () => true })).toBe('failed');
    expect(readTaskTemporalContext({ root: directory, taskRef, accountRefs }).coverage).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(store); mkdirSync(store, { mode: 0o700 }); mkdirSync(join(store, 'records'), { mode: 0o700 }); mkdirSync(join(store, 'staging'), { mode: 0o700 });
    writeFileSync(join(store, 'records', `${event().eventId}.json`), '{}\n', { mode: 0o600 });
    expect(readTaskTemporalContext({ root: directory, taskRef, accountRefs }).coverage.complete).toBe(false);
    expect(existsSync(join(store, 'records', `${event().eventId}.json`))).toBe(true);
  });
  it('rejects accessor-based evidence without evaluating its getter', () => {
    const getter = vi.fn(() => event().source);
    const value = { ...event() }; Object.defineProperty(value, 'source', { get: getter, enumerable: true });
    expect(parseTaskContextEvent(value)).toBeNull(); expect(getter).not.toHaveBeenCalled();
    const arrayGetter = vi.fn(() => 'sensitive');
    const sourceRefs: string[] = []; Object.defineProperty(sourceRefs, '0', { get: arrayGetter, enumerable: true });
    expect(parseTaskContextEvent({ ...event(), sourceRefs })).toBeNull(); expect(arrayGetter).not.toHaveBeenCalled();
  });
  it('projects a long ordered revision chain without recursive stack growth or losing its current head', () => {
    const chain: TaskContextEventV1[] = [];
    for (let index = 0; index < 2500; index++) {
      chain.push(event({ source: { ...event().source, revisionRef: `revision-${index}` }, content: `Revision ${index}`,
        supersedes: index ? [chain.at(-1)!.eventId] : [] }));
    }
    const result = project(chain, { maxEvents: 2500 });
    expect(result.coverage.complete).toBe(true); expect(result.conflicts).toEqual([]);
    expect(result.current.map(item => item.content)).toEqual(['Revision 2499']); expect(result.history).toHaveLength(2499);
  });
});
