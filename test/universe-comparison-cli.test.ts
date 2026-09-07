import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { UniverseCampaignComparison, UniverseComparisonArm } from '../src/core/universe/comparison-types.js';

const core = vi.hoisted(() => ({ readUniverseCampaignComparison: vi.fn() }));
vi.mock('../src/core/universe/index.js', () => core);
import { cmdUniverseCompare } from '../src/cli/universe-compare.js';

function arm(campaignId: string): UniverseComparisonArm {
  return { campaignId, universeId: `${campaignId}-universe`, definitionDigest: 'd'.repeat(64), manifestDigest: 'e'.repeat(64),
    comparatorDigest: 'c'.repeat(64), sourceState: 'healthy', campaignState: 'completed', reasons: [], completed: true,
    fresh: true, fullyAttributed: true, nonempty: true, metric: { name: 'score', direction: 'maximize', minImprovement: 0 },
    feedback: { configured: false, observed: 'disabled', runs: { disabled: 2, legacyV1: 0, searchV2: 0 },
      receipts: { modelTrials: 2, legacyFeedback: 0, searchContext: 0 } },
    counts: { attempts: 2, completedRuns: 2, interruptedRuns: 0, failedRuns: 0, passedTrials: 2, admissions: 1,
      improvements: 1, distinctSelectedArtifacts: 2, modelRequestsStarted: 2, reportedModelRequests: 2,
      reservedModelRequests: 2, verifiedDeliveryBranches: 2, distinctDeliveredArtifacts: 1 },
    usage: { reportedTokens: 200, recordedTokens: 200, complete: true }, timing: { recordedRunDurationMs: 500, wallSpanMs: 700 },
    rates: { scope: 'campaign-recorded-run-time-and-reported-model-tokens', improvementsPerMillionTokens: 5_000,
      distinctSelectedArtifactsPerMillionTokens: 10_000, improvementsPerHour: 7_200, distinctSelectedArtifactsPerHour: 14_400, reasons: [] },
    niches: [{ niche: 'quality', score: 2, runId: 'run-two', trialId: 'trial-two', artifactDigest: 'a'.repeat(64) }], acceptedChanges: null };
}

function report(): UniverseCampaignComparison {
  return { schemaVersion: 1, sampledAt: '2026-09-07T00:00:00.000Z', measurementScope: 'local-experiment', authority: 'observation-only',
    sourceState: 'healthy', reasons: [], baseline: arm('baseline'), challenger: arm('challenger'),
    matching: { comparator: true, configuration: true, workload: true, comparable: true, reasons: [] },
    differences: [], feedbackContrast: 'same-feedback-condition',
    scoreDeltas: [{ niche: 'quality', baselineScore: 2, challengerScore: 2, directionAdjustedDelta: 0 }], acceptedChanges: null };
}

describe('Universe comparison CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.readUniverseCampaignComparison.mockReturnValue(report());
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [], ['baseline'], ['baseline', 'challenger', 'extra'], ['same', 'same'], ['UPPER', 'challenger'],
    ['baseline', '../escape'], ['a'.repeat(65), 'challenger'], ['', 'challenger'], ['baseline', ' '],
    ['baseline', 'a\n'], ['a\x85', 'challenger'], ['baseline', 'challenger', '--unknown'],
    ['baseline', 'challenger', '--root'], ['baseline', 'challenger', '--root', '--json'],
    ['baseline', 'challenger', '--root', ''], ['baseline', 'challenger', '--root', '  '],
    ['baseline', 'challenger', '--root', 'a\0b'], ['baseline', 'challenger', '--root', 'a\nb'],
    ['baseline', 'challenger', '--root', 'a\x85b'], ['baseline', 'challenger', '--root', '-odd'],
    ['baseline', 'challenger', '--root', 'a'.repeat(4097)],
    ['baseline', 'challenger', '--root', '/one', '--root', '/two'],
    ['baseline', 'challenger', '--json'], ['--help', '-h'], ['--help', '--unknown'],
    ['--help', 'same', 'same'], ['--help', 'UPPER'], ['baseline', 'challenger', '--root=/tmp'],
  ])('rejects invalid arguments %j before reading', async (...args) => {
    expect(await cmdUniverseCompare([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(core.readUniverseCampaignComparison).not.toHaveBeenCalled();
  });

  it('returns the exact SDK report and resolves the requested private root', async () => {
    expect(await cmdUniverseCompare(['baseline', '--root', 'private store', 'challenger', '--json'])).toBe(0);
    expect(core.readUniverseCampaignComparison).toHaveBeenCalledWith('baseline', 'challenger', { root: resolve('private store') });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(report());
  });

  it('leaves the SDK default root unchanged', async () => {
    expect(await cmdUniverseCompare(['baseline', 'challenger', '--json'])).toBe(0);
    expect(core.readUniverseCampaignComparison).toHaveBeenCalledWith('baseline', 'challenger', { root: undefined });
  });

  it.each(['missing', 'degraded'] as const)('returns exit 1 with the exact %s report', async (sourceState) => {
    const value = report(); value.sourceState = sourceState;
    core.readUniverseCampaignComparison.mockReturnValue(value);
    expect(await cmdUniverseCompare(['baseline', 'challenger', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(value);
  });

  it('keeps healthy unmatched evidence distinct from read errors', async () => {
    const value = report();
    value.matching = { comparator: false, configuration: false, workload: false, comparable: false, reasons: ['comparator-mismatch'] };
    value.differences = ['variant-configuration'];
    value.scoreDeltas[0]!.directionAdjustedDelta = null;
    core.readUniverseCampaignComparison.mockReturnValue(value);
    expect(await cmdUniverseCompare(['baseline', 'challenger'])).toBe(1);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('source healthy · not comparison-eligible');
    expect(text).toContain('Exact comparator match: false');
    expect(text).toContain('Difference: variant-configuration');
    expect(text).toContain('Matching: comparator-mismatch');
    expect(text).toContain('direction-adjusted delta=unavailable');
    expect(errors).not.toHaveBeenCalled();
  });

  it('renders truthful coverage, timing, outcome and delivery layers without a winner claim', async () => {
    expect(await cmdUniverseCompare(['baseline', 'challenger'])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Model request coverage: 2/2');
    expect(text).toContain('Observed token subtotal: 200 · complete model-generation tokens: 200');
    expect(text).toContain('Recorded run duration: 500 ms · wall-clock span: 700 ms');
    expect(text).toContain('Archive admissions: 1 · strict improvements: 1');
    expect(text).toContain('local delivery branches: 2 · distinct delivered artifacts: 1');
    expect(text).toContain('not production acceptance');
    expect(text).toContain('Accepted production changes: unavailable');
    expect(text).toContain('not an atomic global snapshot');
    expect(text).not.toContain('Winner:');
    expect(text).not.toContain('$');
  });

  it('does not turn unavailable accounting into zero, infinity or cost savings', async () => {
    const value = report();
    value.matching.comparable = false;
    value.baseline.usage = { recordedTokens: 25, reportedTokens: null, complete: false };
    value.baseline.timing = { recordedRunDurationMs: null, wallSpanMs: null };
    value.baseline.counts.verifiedDeliveryBranches = null;
    value.baseline.counts.distinctDeliveredArtifacts = null;
    value.baseline.rates = { scope: 'campaign-recorded-run-time-and-reported-model-tokens', improvementsPerMillionTokens: null,
      distinctSelectedArtifactsPerMillionTokens: null, improvementsPerHour: null, distinctSelectedArtifactsPerHour: null, reasons: ['usage-incomplete'] };
    core.readUniverseCampaignComparison.mockReturnValue(value);
    expect(await cmdUniverseCompare(['baseline', 'challenger'])).toBe(1);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Observed token subtotal: 25 · complete model-generation tokens: unavailable');
    expect(text).toContain('Recorded run duration: unavailable ms');
    expect(text).toContain('distinct delivered artifacts: unavailable');
    expect(text).toContain('Rate limitation: usage-incomplete');
    expect(text).not.toContain('Infinity');
  });

  it.each([['--help'], ['-h'], ['baseline', 'challenger', '--help']])('prints help for %j without reading', async (...args) => {
    expect(await cmdUniverseCompare(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('Reads never create a missing store');
    expect(output.mock.calls[0]![0]).toContain('0 healthy comparison-eligible, 1 incomplete/unmatched, 2 invalid arguments');
    expect(output.mock.calls[0]![0]).toContain('bundled feedback contrast');
    expect(core.readUniverseCampaignComparison).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not expose private unexpected errors in JSON=%s', async (json) => {
    core.readUniverseCampaignComparison.mockImplementation(() => { throw new Error('/private/secret candidate output'); });
    expect(await cmdUniverseCompare(['baseline', 'challenger', ...(json ? ['--json'] : [])])).toBe(1);
    if (json) expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Comparison evidence unavailable' });
    else expect(errors).toHaveBeenCalledWith('universe compare: Comparison evidence unavailable');
    expect(core.readUniverseCampaignComparison).toHaveBeenCalledOnce();
  });

  it('routes compare through the Universe dispatcher', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['compare', 'baseline', 'challenger', '--json'])).toBe(0);
    expect(core.readUniverseCampaignComparison).toHaveBeenCalledWith('baseline', 'challenger', { root: undefined });
  });

  it('registers observation-only agent help', async () => {
    const { AGENT_COMMANDS } = await import('../src/cli/help.js');
    const entry = AGENT_COMMANDS.find((item) => item.usage.startsWith('ashlr universe compare'))!;
    expect(entry).toMatchObject({ safety: 'read', jsonShape: 'UniverseCampaignComparison' });
    expect(entry.description).toContain('No provider calls');
  });

  it.each(['bash', 'zsh'])('includes compare in %s completion', async (shell) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { cmdCompletions } = await import('../src/cli/completions.js');
    expect(await cmdCompletions([shell])).toBe(0);
    expect(stdout.mock.calls.map(([value]) => value).join('')).toMatch(/universe\).*compare/);
  });
});
