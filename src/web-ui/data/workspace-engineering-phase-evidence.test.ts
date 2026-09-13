import { describe, expect, it } from 'vitest';
import { validEngineeringPhaseEvidence } from './workspace-engineering-phase-evidence.js';
import { phaseFixture } from '../routes/workspace/engineering-phase-fixture.test-support.js';

describe('phase evidence browser boundary', () => {
  it('accepts exact recorded facts and explicitly unavailable evidence without mutating them', () => {
    const value = phaseFixture(), before = JSON.stringify(value);
    expect(validEngineeringPhaseEvidence(value)).toBe(true); expect(JSON.stringify(value)).toBe(before);
    expect(validEngineeringPhaseEvidence({ ...value, sourceState: 'unavailable', reason: 'phase-evidence-unavailable', seed: null, runs: [] })).toBe(true);
  });
  it.each([{ liveness: 'running' }, { scope: 'live' }, { extra: '/private/token' }, { reason: '/private/error' }, { schemaVersion: 2 },
    { sourceState: 'unavailable' }, { seed: null }, { runs: null }])('rejects malformed or overclaimed top-level fields %j', patch => {
    expect(validEngineeringPhaseEvidence({ ...phaseFixture(), ...patch })).toBe(false);
  });
  it.each(['private-path', 'private-field', 'bad-time', 'backwards-time', 'pending-finished', 'settled-unfinished', 'duplicate-trial',
    'duplicate-worker', 'duplicate-run', 'foreign-variant', 'unknown-state', 'unverified-time', 'bounds'])('rejects %s', kind => {
    const value = phaseFixture(), run = value.runs[0]!;
    if (kind === 'private-path') run.runId = '/private/path';
    if (kind === 'private-field') Object.assign(run.evaluators[0]!, { scratchPath: '/private/path' });
    if (kind === 'bad-time') run.evaluators[0]!.startedAt = 'yesterday';
    if (kind === 'backwards-time') run.evaluators[1]!.finishedAt = '2026-09-13T17:00:00.000Z';
    if (kind === 'pending-finished') run.evaluators[0]!.finishedAt = '2026-09-13T17:07:00.000Z';
    if (kind === 'settled-unfinished') run.evaluators[1]!.finishedAt = null;
    if (kind === 'duplicate-trial') run.evaluators.push(run.evaluators[0]!);
    if (kind === 'duplicate-worker') run.workers.push(run.workers[0]!);
    if (kind === 'duplicate-run') value.runs.push(run);
    if (kind === 'foreign-variant') run.evaluators[0]!.variantId = 'foreign';
    if (kind === 'unknown-state') Object.assign(run, { state: 'accepted' });
    if (kind === 'unverified-time') run.workers[0]!.state = 'unverified';
    if (kind === 'bounds') value.runs = Array.from({ length: 128 }, (_, i) => ({ ...run, runId: `run-${i}` }));
    expect(validEngineeringPhaseEvidence(value)).toBe(false);
  });
});
