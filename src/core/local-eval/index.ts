/**
 * Local-agent evaluation harness.
 *
 * Answers one question with a number: did a change to the local-model harness
 * make agents better, worse, or neither? See `types.ts` for the three
 * commitments the design rests on.
 */

export * from './types.js';
export { TASKS } from './tasks.js';
export { classifyTrial, type TrialEvidence, type TrialVerdict } from './classify.js';
export { captureConfiguration, type CaptureOptions } from './configuration.js';
export { countChanges, parseAgentResult, runTrial, type RunTrialOptions } from './runner.js';
export { buildReport, renderReport, summariseTask } from './report.js';
export { diagnoseTimeout, startTrace, type StartTraceOptions, type TraceHandle } from './trace.js';
export { parseArgs, pool } from './main.js';
