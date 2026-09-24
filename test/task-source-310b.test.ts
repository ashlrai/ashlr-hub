/**
 * V3.10 Track B (U5): the fleet task source (SPEC-310B §3 "Task source").
 * enqueueTask / cancelTask are frozen cross-unit contracts (U4 files repair
 * tasks, U8 dispatches and cancels on a veto). Store: 0600, locked, bounded;
 * a corrupt queue is never read as empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cancelTask,
  cleanTaskText,
  enqueueInsightTasks,
  enqueueTask,
  fleetTaskIdOfItem,
  fleetTaskWorkItems,
  mergeFleetTaskItems,
  readTaskQueue,
  recordTaskDispatch,
  releaseParkedTasks,
  scoreTask,
  sizeBudgetFor,
  taskQueuePath,
  TASK_QUEUE_LIMITS,
} from '../src/core/fleet/task-source.js';
import type { FleetTaskInput } from '../src/core/fleet/fleet-types.js';
import type { ReasoningInsight } from '../src/core/reasoning/types.js';
import type { WorkItem } from '../src/core/types.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'u5-tasks-'));
  file = join(dir, 'fleet', 'tasks.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(over: Partial<FleetTaskInput> = {}): FleetTaskInput {
  return {
    repo: 'ashlrai/binshield',
    source: 'leader',
    title: 'Add a regression test for the parser',
    detail: 'The parser drops trailing commas.',
    difficulty: 'low',
    value: 4,
    requestedBy: 'leader',
    ...over,
  };
}

describe('enqueueTask', () => {
  it('queues a task with the size budget it was sliced to, in a 0600 file', () => {
    const result = enqueueTask(input(), { nowMs: NOW, file, sizeBudget: { files: 4, lines: 150 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deduped).toBe(false);
    expect(result.task).toMatchObject({ status: 'queued', attempts: 0, sizeBudget: { files: 4, lines: 150 }, parkedUntil: null });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'fleet')).mode & 0o777).toBe(0o700);
  });

  it('without a standing policy slices to the most conservative compiled caps', () => {
    expect(sizeBudgetFor('ashlrai/binshield')).toEqual({ files: 4, lines: 150 });
  });

  it('is idempotent on dedupeKey while the first task is unfinished', () => {
    const first = enqueueTask(input({ dedupeKey: 'repair:L1' }), { nowMs: NOW, file });
    const second = enqueueTask(input({ dedupeKey: 'repair:L1', title: 'different' }), { nowMs: NOW, file });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.deduped).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    const queue = readTaskQueue(file);
    expect(queue.ok && queue.tasks.length).toBe(1);
  });

  it('refuses malformed input without writing anything', () => {
    expect(enqueueTask(input({ repo: 'not a repo' }), { file })).toMatchObject({ ok: false });
    expect(enqueueTask(input({ value: 9 }), { file })).toMatchObject({ ok: false });
    expect(enqueueTask(input({ title: '   ' }), { file })).toMatchObject({ ok: false });
    expect(enqueueTask(input({ source: 'nope' as never }), { file })).toMatchObject({ ok: false });
    expect(enqueueTask(input({ dedupeKey: 'has space' }), { file })).toMatchObject({ ok: false });
    expect(readTaskQueue(file)).toEqual({ ok: true, tasks: [] });
  });

  it('scrubs and caps untrusted text (a model wrote it)', () => {
    const result = enqueueTask(input({
      title: `Fix it\u202e now ghp_${'a'.repeat(36)} ${'x'.repeat(400)}`,
      detail: 'line one\nline two',
    }), { nowMs: NOW, file });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.title).not.toContain('\u202e');
    expect(result.task.title).not.toContain(`ghp_${'a'.repeat(36)}`);
    expect(result.task.title.length).toBeLessThanOrEqual(TASK_QUEUE_LIMITS.maxTitleChars);
    expect(result.task.detail).toContain('\n');
    expect(cleanTaskText('a\u0007b', 10, true)).toBe('ab');
  });

  it('never reads a corrupt queue as empty', () => {
    enqueueTask(input(), { nowMs: NOW, file });
    writeFileSync(file, '{"v":1,"tasks":', { mode: 0o600 });
    expect(readTaskQueue(file).ok).toBe(false);
    expect(enqueueTask(input(), { nowMs: NOW, file })).toMatchObject({ ok: false });
  });

  it('resolves the default path under the isolated HOME', () => {
    expect(taskQueuePath()).toContain(join('.ashlr', 'fleet', 'tasks.json'));
  });
});

describe('cancelTask and dispatch updates', () => {
  it('cancels a queued or parked task, never a dispatched one', () => {
    const queued = enqueueTask(input(), { nowMs: NOW, file });
    if (!queued.ok) throw new Error('enqueue failed');
    const cancelled = cancelTask({ taskId: queued.task.id, reason: 'vetoed', actor: 'leader' }, { nowMs: NOW, file });
    expect(cancelled).toMatchObject({ ok: true, task: { status: 'cancelled' } });

    const other = enqueueTask(input({ title: 'second' }), { nowMs: NOW, file });
    if (!other.ok) throw new Error('enqueue failed');
    recordTaskDispatch(other.task.id, { kind: 'dispatched' }, { nowMs: NOW, file });
    const refused = cancelTask({ taskId: other.task.id, reason: 'too late', actor: 'mason' }, { nowMs: NOW, file });
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.reason).toMatch(/dispatched and can no longer be cancelled/);
    expect(cancelTask({ taskId: '00000000-0000-4000-8000-000000000000', reason: 'x', actor: 'mason' }, { file })).toMatchObject({ ok: false });
  });

  it('finishes on a proposal, retries a no-result up to the attempt cap, parks on a hold', () => {
    const queued = enqueueTask(input(), { nowMs: NOW, file });
    if (!queued.ok) throw new Error('enqueue failed');
    const id = queued.task.id;
    expect(recordTaskDispatch(id, { kind: 'no-result', reason: 'empty diff' }, { nowMs: NOW, file })).toMatchObject({ status: 'queued', attempts: 1 });
    expect(recordTaskDispatch(id, { kind: 'held', reason: 'seat spent', parkedUntil: new Date(NOW + 3_600_000).toISOString() }, { nowMs: NOW, file }))
      .toMatchObject({ status: 'parked' });
    expect(releaseParkedTasks({ nowMs: NOW + 30 * 60_000, file })).toBe(0);
    expect(releaseParkedTasks({ nowMs: NOW + 2 * 3_600_000, file })).toBe(1);
    recordTaskDispatch(id, { kind: 'no-result', reason: 'empty diff' }, { nowMs: NOW, file });
    expect(recordTaskDispatch(id, { kind: 'no-result', reason: 'empty diff' }, { nowMs: NOW, file })).toMatchObject({ status: 'failed', attempts: 3 });

    const produced = enqueueTask(input({ title: 'produces' }), { nowMs: NOW, file });
    if (!produced.ok) throw new Error('enqueue failed');
    expect(recordTaskDispatch(produced.task.id, { kind: 'produced', proposalId: 'p-1' }, { nowMs: NOW, file })).toMatchObject({ status: 'done' });
  });

  it('re-queues a dispatched task the daemon lost track of', () => {
    const queued = enqueueTask(input(), { nowMs: NOW, file });
    if (!queued.ok) throw new Error('enqueue failed');
    recordTaskDispatch(queued.task.id, { kind: 'dispatched' }, { nowMs: NOW, file });
    expect(releaseParkedTasks({ nowMs: NOW + 7 * 3_600_000, file })).toBe(1);
    const queue = readTaskQueue(file);
    expect(queue.ok && queue.tasks[0]!.status).toBe('queued');
  });
});

describe('scoring and projection into the backlog', () => {
  it('scores value × P(ship) ÷ cost, decaying with failed attempts', () => {
    const base = scoreTask({ value: 3, difficulty: 'medium', attempts: 0 });
    expect(base).toBeCloseTo(1.5, 3);
    expect(scoreTask({ value: 3, difficulty: 'medium', attempts: 1 })).toBeLessThan(base);
    expect(scoreTask({ value: 3, difficulty: 'low', attempts: 0 })).toBeGreaterThan(base);
    expect(scoreTask({ value: 3, difficulty: 'medium', attempts: 0 }, 0.9)).toBeGreaterThan(base);
  });

  it('projects ready tasks onto their enrolled checkout with the size budget in the brief', () => {
    const a = enqueueTask(input({ title: 'ready' }), { nowMs: NOW, file, sizeBudget: { files: 2, lines: 80 } });
    const b = enqueueTask(input({ title: 'unenrolled', repo: 'ashlrai/elsewhere' }), { nowMs: NOW, file });
    if (!a.ok || !b.ok) throw new Error('enqueue failed');
    const queue = readTaskQueue(file);
    if (!queue.ok) throw new Error('read failed');
    const items = fleetTaskWorkItems(queue.tasks, (nwo) => (nwo === 'ashlrai/binshield' ? '/tmp/mirrors/ashlrai__binshield' : null), { nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: '/tmp/mirrors/ashlrai__binshield', source: 'goal', title: 'ready' });
    expect(items[0]!.detail).toMatch(/at most 2 file\(s\) and 80 changed line\(s\)/);
    expect(items[0]!.tags).toContain('difficulty:low');
    expect(fleetTaskIdOfItem(items[0]!)).toBe(a.task.id);
    expect(fleetTaskIdOfItem({ id: '/repo:todo:abc' })).toBeNull();
  });

  it('merges into a backlog by a stable score sort, without duplicates', () => {
    const scanned = (id: string, score: number): WorkItem => ({
      id, repo: '/r', source: 'todo', title: id, detail: '', value: 3, effort: 2, score, tags: [], ts: new Date(NOW).toISOString(),
    });
    const merged = mergeFleetTaskItems([scanned('a', 2), scanned('b', 1)], [scanned('t', 1.5), scanned('a', 9)]);
    expect(merged.map((i) => i.id)).toEqual(['a', 't', 'b']);
  });
});

describe('A7 insights → add-tests tasks', () => {
  function insight(over: Partial<ReasoningInsight> = {}): ReasoningInsight {
    return {
      id: 'ins-1',
      kind: 'verification-gap',
      repo: 'binshield',
      engine: 'grok',
      severity: 'warn',
      title: 'Edits to parser.ts were never tested',
      evidence: [{ ref: 'session:abc', at: new Date(NOW).toISOString() }],
      count: 3,
      firstAt: new Date(NOW - 86_400_000).toISOString(),
      lastAt: new Date(NOW).toISOString(),
      ...over,
    };
  }

  it('files one idempotent task per verification-gap insight on a covered repo', () => {
    const repoOf = (label: string) => (label === 'binshield' ? 'ashlrai/binshield' : null);
    const insights = [insight(), insight({ id: 'ins-2', kind: 'struggle' }), insight({ id: 'ins-3', repo: 'unknown' })];
    expect(enqueueInsightTasks(insights, repoOf, { nowMs: NOW, file })).toBe(1);
    expect(enqueueInsightTasks(insights, repoOf, { nowMs: NOW, file })).toBe(0);
    const queue = readTaskQueue(file);
    if (!queue.ok) throw new Error('read failed');
    expect(queue.tasks).toHaveLength(1);
    expect(queue.tasks[0]).toMatchObject({ source: 'insight', insightId: 'ins-1', dedupeKey: 'insight:ins-1', difficulty: 'low' });
    expect(queue.tasks[0]!.title).toMatch(/^Add tests: /);
  });
});
