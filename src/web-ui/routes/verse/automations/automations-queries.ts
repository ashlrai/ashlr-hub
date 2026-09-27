/**
 * routes/verse/automations/automations-queries.ts — reads and writes behind
 * the Automations section (core/verse/automations-api.ts).
 *
 *   GET  /api/verse/automations                     → AutomationsOverviewResponse
 *   POST /api/verse/automations                     → 201 { automation }  (create)
 *   POST /api/verse/automations/<id>                → { automation }      (update)
 *   POST /api/verse/automations/<id>/enable|disable → { automation }
 *   POST /api/verse/automations/<id>/delete         → { ok }
 *   POST /api/verse/automations/<id>/fire           → AutomationFireResponse
 *
 * Reads spend nothing. Writes pull the held mutation token, touch the hold,
 * and invalidate the overview.
 */
import type {
  AutomationFireResponse,
  AutomationsOverviewResponse,
  AutomationV1,
} from '../../../../core/automations/types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const AUTOMATIONS_PATH = '/api/verse/automations';
export const AUTOMATIONS_KEY = 'verse-automations';
export const AUTOMATIONS_POLL_MS = 15_000;

export const automationsQuery: QueryDef<AutomationsOverviewResponse> = {
  key: AUTOMATIONS_KEY,
  fetch: (signal) => apiGet<AutomationsOverviewResponse>(AUTOMATIONS_PATH, signal),
};

function token(): string {
  const t = getMutationToken();
  if (!t) throw new VerseMutationLockedError();
  return t;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await apiPost<T>(path, body, token());
  touchMutationHold();
  invalidate(AUTOMATIONS_KEY);
  return res;
}

const at = (id: string, verb?: string): string => `${AUTOMATIONS_PATH}/${encodeURIComponent(id)}${verb ? `/${verb}` : ''}`;

/** Create (id null) or update (id set). The server validates the whole definition. */
export async function saveAutomationDefinition(id: string | null, input: Record<string, unknown>): Promise<AutomationV1> {
  const res = await post<{ automation: AutomationV1 }>(id ? at(id) : AUTOMATIONS_PATH, input);
  return res.automation;
}

export async function setAutomationOn(id: string, enabled: boolean): Promise<AutomationV1> {
  return (await post<{ automation: AutomationV1 }>(at(id, enabled ? 'enable' : 'disable'), {})).automation;
}

export async function removeAutomation(id: string): Promise<void> {
  await post<{ ok: true }>(at(id, 'delete'), {});
}

export async function runAutomation(id: string, dryRun: boolean): Promise<AutomationFireResponse> {
  return post<AutomationFireResponse>(at(id, 'fire'), dryRun ? { dryRun: true } : {});
}
