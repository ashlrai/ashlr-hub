/**
 * data/mutations.ts — every mutating call the foundation ships with, each
 * wrapped so it (a) pulls the held mutation token from auth-store instead
 * of asking every call site to thread it through, (b) touches the hold on
 * success so a burst of approvals doesn't idle-expire mid-session, and
 * (c) invalidates whatever cache keys the mutation obviously affects so
 * views update without waiting for the next SSE tick.
 *
 * Routes mirror the mutating surface documented at the top of
 * src/core/web/api.ts. Every one of these 404s (not 401/403) when the
 * server was started without --allow-dispatch — apiPost already maps that
 * to DispatchDisabledError.
 */
import { apiPost } from './client.js';
import { getMutationToken, touchMutationHold } from './auth-store.js';
import { invalidate, invalidatePrefix } from './cache.js';

class MissingMutationTokenError extends Error {
  constructor() {
    super('No mutation token held for this session yet.');
    this.name = 'MissingMutationTokenError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new MissingMutationTokenError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

export async function pauseFleet(): Promise<void> {
  await post('/api/fleet/pause', {});
  invalidate('dashboard-snapshot');
  invalidate('control-snapshot');
  invalidate('fleet');
  invalidate('fleet-activity');
}

export async function resumeFleet(): Promise<void> {
  await post('/api/fleet/resume', {});
  invalidate('dashboard-snapshot');
  invalidate('control-snapshot');
  invalidate('fleet');
  invalidate('fleet-activity');
}

export async function approveProposal(id: string): Promise<void> {
  await post(`/api/inbox/${encodeURIComponent(id)}/approve`, {});
  invalidate('inbox');
  invalidate('dashboard-snapshot');
  invalidate(`proposal-detail-${id}`);
  invalidatePrefix('inbox-list:');
}

export async function rejectProposal(id: string): Promise<void> {
  await post(`/api/inbox/${encodeURIComponent(id)}/reject`, {});
  invalidate('inbox');
  invalidate('dashboard-snapshot');
  invalidate(`proposal-detail-${id}`);
  invalidatePrefix('inbox-list:');
}

export interface OpenTargetRequest {
  path: string;
  target: 'editor' | 'finder';
}

export async function openTarget(req: OpenTargetRequest): Promise<void> {
  await post('/api/open', req);
}
