import { describe, expect, it } from 'vitest';
import { buildResourcePerformance, MAX_RESOURCE_EXECUTION_DURATION_MS, validateResourcePerformanceReport,
  validResourceExecutionMeasurement } from '../src/core/resources/performance.js';
import type { ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';

const worker = { id: 'local-a', provider: 'local' as const, model: 'configured-local', maxConcurrent: 1,
  maxTasksPerWindow: 10, taskWindowMs: 60_000, reservePercent: 10, priority: 1 };
const pool: ResourcePool = { schemaVersion: 1, id: 'pool', workers: [worker, { ...worker, id: 'local-b' }] };
function receipt(id: string, patch: Partial<ResourceTaskReceipt> = {}): ResourceTaskReceipt {
  return { schemaVersion: 1, id, taskDigest: 'a'.repeat(64), poolDigest: 'b'.repeat(64), workerId: 'local-a', capacityKey: 'local-a',
    status: 'completed', startedAt: '2026-09-07T12:00:00.000Z', finishedAt: '2026-09-07T13:00:00.000Z',
    outputDigest: 'c'.repeat(64), inputTokens: 10, outputTokens: 2, reason: 'worker-completed', verifiedAccepted: false,
    execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 100, usageScope: 'local-chat-completion' }, ...patch };
}
const measure = (durationMs: number | null) => ({ schemaVersion: 1 as const, scope: 'worker-execution' as const,
  durationMs, usageScope: 'local-chat-completion' as const });
const build = (rows: ResourceTaskReceipt[]) => buildResourcePerformance(pool, rows);

describe('descriptive resource performance', () => {
  it('reports empty enrolled workers with unknown quantiles and no quality claim', () => {
    const report = build([]);
    expect(report).toMatchObject({ attempts: 0, quality: 'unmeasured', comparability: 'unmatched-tasks' });
    expect(report.workers).toHaveLength(2);
    expect(report.workers.every((row) => row.usage.totalInputTokens === null && !row.usage.complete &&
      row.durations.every((duration) => duration.samples === 0 && duration.p50Ms === null))).toBe(true);
    expect(validateResourcePerformanceReport(report, pool)).toEqual(report);
  });

  it('separates exact terminal statuses and uses nearest-rank quantiles with explicit sample size', () => {
    const rows = Array.from({ length: 20 }, (_, index) => receipt(`done-${index}`, { execution: measure(index + 1) }));
    rows.push(receipt('failed', { status: 'failed', execution: measure(1_000) }),
      receipt('timeout', { status: 'timed-out', execution: measure(3_000) }),
      receipt('cancelled', { status: 'cancelled', execution: measure(2_000) }));
    const report = build(rows); const row = report.workers[0]!;
    expect(row.counts).toEqual({ total: 23, reserved: 0, completed: 20, failed: 1, timedOut: 1, cancelled: 1, uncertain: 0 });
    expect(row.durations[0]).toEqual({ status: 'completed', attempts: 20, samples: 20, unknownAttempts: 0, p50Ms: 10, p95Ms: 19 });
    expect(row.durations[1]?.p50Ms).toBe(1_000);
    expect(validateResourcePerformanceReport(report, pool)).toEqual(report);
  });

  it('never backfills legacy or unknown monotonic time from wall-clock timestamps', () => {
    const legacy = receipt('legacy'); delete legacy.execution;
    const report = build([legacy, receipt('clock-invalid', { execution: measure(null) }), receipt('real-zero', { execution: measure(0) })]);
    expect(report.workers[0]?.durations[0]).toEqual({ status: 'completed', attempts: 3, samples: 1, unknownAttempts: 2, p50Ms: 0, p95Ms: 0 });
    expect(report.workers[0]?.usage.scopes).toEqual([{ scope: 'local-chat-completion', attempts: 2, reportedAttempts: 2 },
      { scope: null, attempts: 1, reportedAttempts: 1 }]);
  });

  it('retains failed reported spend but withholds complete totals for unknown and unresolved work', () => {
    const report = build([receipt('failed', { status: 'failed' }), receipt('unknown', { status: 'cancelled', inputTokens: null, outputTokens: null,
      execution: { ...measure(3), usageScope: null } }), receipt('active', { status: 'reserved', finishedAt: null,
      inputTokens: null, outputTokens: null, outputDigest: null, execution: undefined })]);
    expect(report.workers[0]?.usage).toMatchObject({ reportedAttempts: 1, unknownAttempts: 2,
      reportedInputTokens: 10, reportedOutputTokens: 2, totalInputTokens: null, totalOutputTokens: null, complete: false });
    expect(build([receipt('uncertain', { status: 'uncertain' })]).workers[0]?.usage.complete).toBe(false);
    expect(validateResourcePerformanceReport(report, pool)).toEqual(report);
  });

  it('preserves zero reported counts and withholds overflowing aggregate totals', () => {
    expect(build([receipt('zero', { inputTokens: 0, outputTokens: 0 })]).workers[0]?.usage).toMatchObject({ totalInputTokens: 0, totalOutputTokens: 0, complete: true });
    const report = build([receipt('large', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }), receipt('one')]);
    expect(report.workers[0]?.usage).toMatchObject({ reportedInputTokens: null, reportedOutputTokens: 2,
      totalInputTokens: null, totalOutputTokens: null, complete: false });
    expect(validateResourcePerformanceReport(report, pool)).toEqual(report);
  });

  it('groups by enrolled worker and does not mutate or retain input aliases', () => {
    const rows = [receipt('a'), receipt('b', { workerId: 'local-b', capacityKey: 'local-b', execution: measure(5) })];
    const before = JSON.stringify({ pool, rows }); const report = build(rows);
    expect(report.workers.map((row) => row.counts.total)).toEqual([1, 1]);
    report.workers[0]!.durations[0]!.p50Ms = 999;
    expect(JSON.stringify({ pool, rows })).toBe(before);
    const valid = build(rows); const validated = validateResourcePerformanceReport(valid, pool);
    validated.workers[0]!.usage.scopes[0]!.attempts = 2;
    expect(valid.workers[0]?.usage.scopes[0]?.attempts).toBe(1);
  });

  it.each([NaN, Infinity, -1, MAX_RESOURCE_EXECUTION_DURATION_MS + 1, '1'])('rejects invalid explicit timing %s', (durationMs) => {
    const value = { ...measure(1), durationMs };
    expect(validResourceExecutionMeasurement(value)).toBe(false);
    expect(() => build([receipt('bad', { execution: value as ResourceTaskReceipt['execution'] })])).toThrow();
  });

  it.each(['duplicate', 'orphan', 'scope', 'mixed-ledger', 'one-token', 'reserved-measurement'])('rejects inconsistent evidence: %s', (kind) => {
    const rows = [receipt('one')];
    if (kind === 'duplicate') rows.push(receipt('one'));
    if (kind === 'orphan') rows[0]!.workerId = 'missing';
    if (kind === 'scope') rows[0]!.execution!.usageScope = 'claude-main-loop';
    if (kind === 'mixed-ledger') rows.push(receipt('two', { poolDigest: 'd'.repeat(64) }));
    if (kind === 'one-token') rows[0]!.inputTokens = null;
    if (kind === 'reserved-measurement') rows[0]!.status = 'reserved';
    expect(() => build(rows)).toThrow();
  });

  it.each(['extra', 'counter', 'coverage', 'quantile', 'scope', 'quality'])('validates public report consistency: %s', (kind) => {
    const report = build([receipt('one')]); const row = report.workers[0]!;
    if (kind === 'extra') Object.assign(row.usage, { prompt: 'private' });
    if (kind === 'counter') row.counts.completed++;
    if (kind === 'coverage') row.durations[0]!.samples++;
    if (kind === 'quantile') row.durations[0]!.p50Ms = 101;
    if (kind === 'scope') row.usage.scopes[0]!.scope = 'codex-turn';
    if (kind === 'quality') Object.assign(report, { quality: 'accepted' });
    expect(() => validateResourcePerformanceReport(report, pool)).toThrow();
  });

  it('bounds the source ledger without truncating successful-looking summaries', () => {
    expect(() => build(Array.from({ length: 4_097 }, (_, index) => receipt(`row-${index}`)))).toThrow();
  });

  it('rejects reported usage attributed to a reserved attempt', () => {
    const report = build([receipt('pending', { status: 'reserved', inputTokens: null, outputTokens: null,
      execution: undefined, finishedAt: null, outputDigest: null })]);
    Object.assign(report.workers[0]!.usage, { reportedAttempts: 1, unknownAttempts: 0, reportedInputTokens: 10,
      reportedOutputTokens: 2, scopes: [{ scope: null, attempts: 1, reportedAttempts: 1 }] });
    expect(() => validateResourcePerformanceReport(report, pool)).toThrow();
  });
});
