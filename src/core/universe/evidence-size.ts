import { canonical } from './artifacts.js';
import type { UniverseArtifact, UniverseGenerationReceipt, UniverseRun, UniverseTrial } from './types.js';

/** Use the existing private-store ceiling; its 64 MiB aggregate limit is separate. */
export const MAX_UNIVERSE_RECORD_BYTES = 1024 * 1024;
/** Sixty-four trials leave 64 KiB for the final run envelope and resource totals. */
export const MAX_UNIVERSE_TRIAL_BYTES = 15 * 1024;
const TRIAL_FINALIZATION_SLACK_BYTES = 256;

export function universeEvidenceBytes(value: unknown): number { return Buffer.byteLength(canonical(value), 'utf8'); }

/** Writer admission only: older version-one records retain their existing codec. */
export function assertTrialEvidenceBudget(trial: UniverseTrial): void {
  // Duration and selection delta are finalized after measurement admission.
  if (universeEvidenceBytes(trial) + TRIAL_FINALIZATION_SLACK_BYTES > MAX_UNIVERSE_TRIAL_BYTES) {
    throw new Error('Universe trial evidence exceeds its 15 KiB byte budget');
  }
}

export function assertRunEvidenceBudget(run: UniverseRun): void {
  // Cover both canonical record envelopes, including process-owner metadata.
  const finalBytes = universeEvidenceBytes({ id: `${run.id}.final`, kind: 'final', run });
  const startBytes = universeEvidenceBytes({ id: `${run.id}.start`, kind: 'start', run,
    ownerPid: 2 ** 31, ownerStart: 'x'.repeat(64) });
  if (Math.max(finalBytes, startBytes) + 1 > MAX_UNIVERSE_RECORD_BYTES) {
    throw new Error('Universe run evidence exceeds its 1 MiB record budget');
  }
}

/** Reserve receipt capacity before contact; measurements are separately admitted before assignment. */
export function preflightTrialEvidenceBudget(trial: UniverseTrial, planned: {
  artifact: UniverseArtifact;
  changedFiles: string[];
  feedback?: NonNullable<UniverseGenerationReceipt['feedback']>;
}): void {
  const hash = 'f'.repeat(64);
  // These are serialization-size placeholders, never counters, source evidence,
  // or persisted errors. A 1024-code-unit error can require six bytes per unit.
  const profile = { ...trial, artifact: planned.artifact, durationMs: Number.MAX_VALUE,
    error: '\u0001'.repeat(1024), score: -Number.MAX_VALUE, delta: -Number.MAX_VALUE,
    ...(trial.generation ? { generation: { ...trial.generation, status: 'succeeded', requestStarted: true,
      promptDigest: hash, responseDigest: hash, durationMs: Number.MAX_VALUE,
      usage: { state: 'reported', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER },
      changedFiles: [...planned.changedFiles], ...(planned.feedback ? { feedback: planned.feedback } : {}),
      // Current local broker errors are fixed ASCII validation messages capped
      // at 512 characters; raw provider bodies never enter this receipt.
      error: 'x'.repeat(512) } } : {}),
  };
  // Leave room for differences in finite numeric serialization and fixed flags.
  if (universeEvidenceBytes(profile) + TRIAL_FINALIZATION_SLACK_BYTES > MAX_UNIVERSE_TRIAL_BYTES) {
    throw new Error('Universe declared receipt exceeds the trial evidence byte budget before execution');
  }
}
