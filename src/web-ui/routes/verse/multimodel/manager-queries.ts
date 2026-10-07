import type { OutcomeManagerSessionRead } from '../../../../core/daemon/outcome-manager.js';
import type { ManagerSubmitInput } from '../../../../core/verse/manager-session.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

const key = (id: string) => `verse-manager:${id}`;
export const managerSessionPath = (id: string) => `/api/verse/outcomes/session/${encodeURIComponent(id)}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const intent = (value: unknown) => value === 'plan' || value === 'review' || value === 'replan';
function stage(value: unknown, running: boolean): boolean {
  if (value === null) return true;
  if (!object(value) || !intent(value.intent) || !['running', 'succeeded', 'failed', 'aborted', 'stale'].includes(String(value.state)) ||
      running && value.state !== 'running') return false;
  return object(value.route) && value.route.tier === 'frontier' && label(value.route.engine) && label(value.route.seatId) && label(value.route.model);
}
/** Shared browser-only validation for actual resident and interactive projections. */
export function validManagerProjection(value: unknown): value is Extract<OutcomeManagerSessionRead, { sourceState: 'healthy' }>['association']['manager'] {
  if (!object(value)) return false;
  if (value.sourceState !== 'healthy') return ['missing', 'degraded'].includes(String(value.sourceState)) && value.enabled === false &&
    value.mode === null && value.sessionId === null && value.conversationRevision === null && value.running === null && value.next === null && value.latest === null;
  return value.enabled === true && ['interactive', 'resident'].includes(String(value.mode)) &&
    (value.sessionId === null ? value.mode === 'resident' : typeof value.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId)) &&
    Number.isSafeInteger(value.conversationRevision) && Number(value.conversationRevision) >= 0 &&
    stage(value.running, true) && stage(value.latest, false) &&
    (value.next === null || object(value.next) && intent(value.next.intent));
}
/** Validate the browser-consumed projection, without importing private ledger or crypto code. */
export function validManagerRead(value: unknown): value is OutcomeManagerSessionRead {
  if (!object(value)) return false;
  if (value.sourceState !== 'healthy') return ['missing', 'degraded', 'unlinked'].includes(String(value.sourceState)) && value.association === null;
  const row = value.association;
  if (!object(row) || typeof row.outcomeId !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(row.outcomeId) ||
      !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Number.isSafeInteger(row.scopeRevision) || Number(row.scopeRevision) < 1 ||
      typeof row.paused !== 'boolean' || !Array.isArray(row.terminalStageIds) || !row.terminalStageIds.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) return false;
  return validManagerProjection(row.manager) && row.manager.sourceState === 'healthy' && row.manager.mode === 'interactive';
}
export function managerSessionQuery(sessionId: string): QueryDef<OutcomeManagerSessionRead> {
  return { key: key(sessionId), async fetch(signal) {
    const value = await apiGet<OutcomeManagerSessionRead>(managerSessionPath(sessionId), signal);
    if (!validManagerRead(value) || value.sourceState === 'healthy' && value.association.manager.sessionId !== sessionId) throw new Error('Manager state is unavailable.');
    return value;
  } };
}
const pendingKey = (id: string) => `ashlr.verse.manager.pending.${id}`;
const pending = new Map<string, ManagerSubmitInput>();
const confirmed = new Map<string, string>();
export function pendingManagerMessage(sessionId: string): ManagerSubmitInput | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey(sessionId)) ?? 'null') as ManagerSubmitInput | null;
    if (value?.sessionId === sessionId && confirmed.get(sessionId) !== value.commandId && typeof value.text === 'string' && typeof value.outcomeId === 'string' &&
        typeof value.commandId === 'string' && typeof value.messageId === 'string') return value;
  } catch { /* Private browsing retains the in-memory pending request. */ }
  return pending.get(sessionId) ?? null;
}
/** A response failure keeps the same identities until confirmed; it never silently falls back to a native turn. */
export async function submitManagerMessage(sessionId: string, text: string): Promise<OutcomeManagerSessionRead> {
  const token = getMutationToken(); if (!token) throw new VerseMutationLockedError();
  let input = pendingManagerMessage(sessionId);
  if (input && input.text !== text) throw new Error('Retry the unconfirmed manager message before changing its text. Your draft is preserved.');
  if (!input) {
    const read = await managerSessionQuery(sessionId).fetch();
    if (read.sourceState === 'degraded') throw new Error('Manager records are unavailable. Your draft is preserved.');
    input = { sessionId, text, outcomeId: read.sourceState === 'healthy' ? read.association.outcomeId : `chat-${crypto.randomUUID()}`,
      commandId: crypto.randomUUID(), messageId: crypto.randomUUID() };
    pending.set(sessionId, input);
    try { localStorage.setItem(pendingKey(sessionId), JSON.stringify(input)); } catch { /* Retained in memory. */ }
  }
  const result = await apiPost<OutcomeManagerSessionRead>('/api/verse/outcomes/interactive', input, token);
  if (!validManagerRead(result) || result.sourceState !== 'healthy' || result.association.outcomeId !== input.outcomeId ||
      result.association.manager.sessionId !== sessionId) throw new Error('Manager message acceptance is unavailable. Retry the same message.');
  confirmed.set(sessionId, input.commandId);
  pending.delete(sessionId);
  try { localStorage.removeItem(pendingKey(sessionId)); } catch { /* Retained only for this browser session. */ }
  touchMutationHold(); invalidate(key(sessionId)); invalidate('verse-outcomes');
  return result;
}
