import type { ResourceEngineeringPhaseEvidence } from '../../../core/resources/engineering-outcomes-types.js';

export function phaseFixture(): ResourceEngineeringPhaseEvidence {
  return { schemaVersion: 1, scope: 'recorded-execution-phases', liveness: 'not-attested', sourceState: 'available', reason: null,
    seed: { state: 'result-recorded', startedAt: '2026-09-13T17:00:00.000Z', finishedAt: '2026-09-13T17:05:00.000Z' },
    runs: [{ runId: 'run-phase-1', generation: 1, state: 'running',
      workers: [{ variantId: 'variant-1', taskId: 'task-phase-1', state: 'completed', startedAt: '2026-09-13T17:05:01.000Z', finishedAt: '2026-09-13T17:06:00.000Z' }],
      evaluators: [{ trialId: 'trial-phase-1', variantId: null, state: 'intent-recorded', startedAt: '2026-09-13T17:06:01.000Z', finishedAt: null },
        { trialId: 'trial-phase-2', variantId: null, state: 'group-exit-confirmed', startedAt: '2026-09-13T17:06:01.000Z', finishedAt: '2026-09-13T17:07:00.000Z' }] }] };
}
