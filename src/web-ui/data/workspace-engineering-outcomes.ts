import type { ResourceEngineeringOutcomes as Outcomes } from '../../core/resources/engineering-outcomes-types.js';
import type { ResourceConsoleEngineeringEnrollment as Enrollment } from '../../core/resources/console-engineering-types.js';
import { apiGet, ApiError } from './client.js';
import { validWorkspaceEngineeringEnrollment } from './workspace-engineering.js';
import { validateResourceEngineeringOutcomes } from '../../core/resources/engineering-outcomes-validation.js';
export { engineeringOutcomeReasons } from '../../core/resources/engineering-outcomes-validation.js';


const invalid = () => new Error('Outcome evidence could not be verified. Refresh evidence before relying on it.');
export function validateWorkspaceEngineeringOutcomes(value: unknown, selected: Enrollment): Outcomes {
  if (!validWorkspaceEngineeringEnrollment(selected)) throw invalid();
  return validateResourceEngineeringOutcomes(value, selected);
}

export class WorkspaceEngineeringOutcomeReadError extends Error {
  constructor(readonly reason: 'busy' | 'timeout' | 'unavailable') {
    super(reason === 'busy'
      ? 'Another outcome proof read is in progress. Wait for it to finish before reading again. No work was started.'
      : reason === 'timeout'
        ? 'Outcome proof exceeded its read deadline. Evidence is unavailable; the console remains usable. No work was started.'
        : 'Outcome reader is unavailable. Check the local console diagnostics. If cleanup is unconfirmed, resolve it before trying again; retrying cannot clear it. No work was started.');
    this.name = 'WorkspaceEngineeringOutcomeReadError';
  }
}

export async function readWorkspaceEngineeringOutcomes(selected: Enrollment, signal?: AbortSignal): Promise<Outcomes> {
  if (!validWorkspaceEngineeringEnrollment(selected)) throw invalid();
  try {
    const value = await apiGet<unknown>(`/api/resources/engineering/${selected.id}/outcomes`, signal);
    if (signal?.aborted) throw invalid();
    return validateWorkspaceEngineeringOutcomes(value, selected);
  } catch (error) {
    if (!signal?.aborted && error instanceof ApiError && [429, 503, 504].includes(error.status)) {
      // The shared GET client deliberately discards server prose. A 503 alone
      // cannot distinguish unavailable proof from unconfirmed native cleanup.
      throw new WorkspaceEngineeringOutcomeReadError(error.status === 429 ? 'busy' : error.status === 504 ? 'timeout' : 'unavailable');
    }
    throw invalid();
  }
}
