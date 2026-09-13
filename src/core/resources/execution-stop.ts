/** Read-only projection; never expose the authority path or grant activation. */
import { readKillSwitch } from '../sandbox/policy.js';
import type { ResourceConsoleSnapshot } from './console-types.js';

export function readResourceExecutionStop(): NonNullable<ResourceConsoleSnapshot['executionStop']> {
  let state: 'active' | 'inactive' | 'unknown' = 'unknown';
  try {
    const observation = readKillSwitch();
    if (observation.sourceState === 'healthy' && (observation.state === 'active' || observation.state === 'inactive')) {
      state = observation.state;
    }
  } catch { /* Unreadable authority is never evidence that execution is clear. */ }
  return { state, sampledAt: new Date().toISOString() };
}
