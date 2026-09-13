/** Fixed-field transport observations, never settlement or acceptance authority. */
import { types } from 'node:util';
import type { VerifySubprocessResult } from '../run/verify-commands.js';

export interface FixedEvaluatorCustodyDiagnostics {
  schemaVersion: 1;
  boundary: 'outer-process-group' | 'nested-activity' | 'completed' | 'not-started' | 'unobserved';
  exitCode: number | null;
  signalled: boolean | null;
  timedOut: boolean | null;
  cancelled: boolean | null;
  outputTruncated: boolean | null;
}
export interface FixedEvaluatorResult extends VerifySubprocessResult {
  custodyDiagnostics?: FixedEvaluatorCustodyDiagnostics;
}
const boundaries = ['outer-process-group', 'nested-activity', 'completed', 'not-started', 'unobserved'];
const flag = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
export function summarizeFixedEvaluatorCustody(result: VerifySubprocessResult | undefined,
  boundary: FixedEvaluatorCustodyDiagnostics['boundary']): FixedEvaluatorCustodyDiagnostics {
  return { schemaVersion: 1, boundary,
    exitCode: result && Number.isSafeInteger(result.exitCode) && result.exitCode >= -1 && result.exitCode <= 255 ? result.exitCode : null,
    signalled: result?.signal === null ? false : typeof result?.signal === 'string' ? true : null,
    timedOut: flag(result?.timedOut), cancelled: flag(result?.cancelled), outputTruncated: flag(result?.outputTruncated) };
}
export function validateFixedEvaluatorCustodyDiagnostics(input: unknown): FixedEvaluatorCustodyDiagnostics {
  const unavailable = () => new Error('Evaluator custody diagnostics unavailable');
  const keys = ['schemaVersion', 'boundary', 'exitCode', 'signalled', 'timedOut', 'cancelled', 'outputTruncated'];
  // Read descriptors before values: diagnostics must never execute caller code
  // or recursively traverse an unexpected object merely to reject it.
  if (!input || typeof input !== 'object' || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== keys.length) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) throw unavailable();
  const value = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value])) as unknown as FixedEvaluatorCustodyDiagnostics;
  if (value.schemaVersion !== 1 ||
    !boundaries.includes(value.boundary) || !(value.exitCode === null || Number.isSafeInteger(value.exitCode) && value.exitCode >= -1 && value.exitCode <= 255) ||
    [value.signalled, value.timedOut, value.cancelled, value.outputTruncated].some(item => item !== null && typeof item !== 'boolean')) {
    throw unavailable();
  }
  return value;
}
