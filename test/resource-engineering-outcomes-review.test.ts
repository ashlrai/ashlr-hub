/** Real private accounting/config files; controlled evidence-reader projections, no workers/evaluators. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as delivery from '../src/core/universe/delivery.js';
import { cleanupEngineeringOutcomesFixtures, createEngineeringOutcomesFixture as fixture,
  engineeringOutcomesFixtureTree as tree } from './helpers/resource-engineering-outcomes-fixture.js';

afterEach(cleanupEngineeringOutcomesFixtures);

describe('independent engineering outcome observation boundaries', () => {
  it('never emits unsafe token subtotals from individually valid ledger receipts', () => {
    const f = fixture();
    for (const score of [0, 1]) {
      const { receipt, trial } = f.add(score, score > 0, score > 0 ? 'passed' : 'failed');
      receipt.inputTokens = Number.MAX_SAFE_INTEGER; receipt.outputTokens = 0;
      trial.generation!.usage = { state: 'reported', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 };
      trial.generation!.resource!.receiptDigest = digest(canonical(receipt));
    }
    f.write(); const before = tree(f.outer); const report = f.read();
    expect(report.complete).toBe(false); expect(report.sourceState).not.toBe('healthy');
    expect(report.reasons).toEqual(['usage-accounting-overflow']);
    expect(report.usage.totalTokens).toBeNull();
    for (const total of [report.usage, ...report.campaigns.flatMap(row => [row.usage, ...row.workers.map(worker => worker.usage)])]) {
      expect(Number.isSafeInteger(total.recordedInputTokens)).toBe(true);
      expect(Number.isSafeInteger(total.recordedOutputTokens)).toBe(true);
    }
    expect(tree(f.outer)).toBe(before);
  });
  it('does not carry first-sample timing or usage authority across changing evidence', () => {
    const f = fixture(); f.add(1, true); let sampled = 0;
    vi.mocked(delivery.readUniverseDeliveries).mockImplementation(() => ({
      sourceState: ++sampled === 1 ? 'missing' : 'degraded', deliveries: [], reasons: [] }));
    const before = tree(f.outer); const report = f.read();
    expect(report).toMatchObject({ sourceState: 'degraded', complete: false,
      reasons: ['evidence-changed-during-sampling'], usage: { complete: false, totalTokens: null },
      timing: { complete: false, totalDurationMs: null } });
    for (const row of report.campaigns) for (const worker of row.workers) {
      expect(worker.usage.complete).toBe(false); expect(worker.timing.complete).toBe(false);
      expect(worker.timing.totalDurationMs).toBeNull();
    }
    expect(tree(f.outer)).toBe(before);
  });
  it('retains incomplete admitted work as unknown rather than a zero-attempt completed observation', () => {
    const f = fixture(); f.add(1, true);
    f.universe.runs = []; f.campaign.steps[0]!.state = 'interrupted'; f.state.attempts = []; f.write();
    const report = f.read();
    expect(report).toMatchObject({ complete: false, sourceState: 'degraded',
      usage: { attempts: 1, unknownAttempts: 1, joinedAttempts: 0, totalTokens: null },
      timing: { attempts: 1, measuredAttempts: 0, totalDurationMs: null } });
    expect(report.campaigns[0]!.workers).toEqual([]);
  });
  it('will not promote an existing delivered marker without independent campaign delivery proof', () => {
    const f = fixture(); f.add(1, true);
    vi.mocked(delivery.readUniverseDeliveries).mockReturnValue({
      sourceState: 'healthy', reasons: [], deliveries: [{ branch: 'codex/result', status: 'delivered' }] as never });
    const report = f.read();
    expect(report).toMatchObject({ complete: false, campaigns: [{
      stages: { verifiedLocalDeliveries: null }, reasons: ['delivery-evidence-unverified'] }] });
    expect(report.productionAccepted).toBeNull(); expect(report.routingChanged).toBe(false);
  });
});
