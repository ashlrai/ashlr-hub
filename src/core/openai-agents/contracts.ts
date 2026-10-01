/** Read-only projections: never expose instructions, tool arguments, files or error messages. */
export interface ManagedSessionMetadata {
  id: string;
  createdAt: number;
  status: 'idle' | 'in_progress' | 'requires_action' | 'failed';
  agent: { id: string; model: string };
  requiredActionCount: number;
}
export interface ManagedTurnMetadata {
  id: string;
  sessionId: string;
  agentId: string;
  subagentId: string | null;
  createdAt: number;
  status: 'queued' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled';
}
export interface MetadataPage<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}
export class AgentsReadError extends Error {
  constructor(public readonly code: 'missing-auth' | 'invalid-argument' | 'invalid-response' | 'response-too-large' | 'timeout' | 'transport' | 'authentication' | 'permission' | 'not-found' | 'rate-limit' | 'provider-error') {
    super(code);
    this.name = 'AgentsReadError';
  }
}
function invalid(): never { throw new AgentsReadError('invalid-response'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export function validResourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
}
function id(value: unknown): string { return validResourceId(value) ? value : invalid(); }
function createdAt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : invalid();
}
export function sessionMetadata(value: unknown): ManagedSessionMetadata {
  const r = record(value), agent = record(r.agent);
  if (r.object !== 'agent.session' || !Array.isArray(r.required_actions) || r.required_actions.length > 1000) invalid();
  if (typeof agent.model !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(agent.model)) invalid();
  return { id: id(r.id), createdAt: createdAt(r.created_at),
    status: enumValue(r.status, ['idle', 'in_progress', 'requires_action', 'failed']),
    agent: { id: id(agent.id), model: agent.model }, requiredActionCount: r.required_actions.length };
}
export function turnMetadata(value: unknown, sessionId: string): ManagedTurnMetadata {
  const r = record(value);
  if (r.object !== 'agent.session.turn' || r.session_id !== sessionId) invalid();
  return { id: id(r.id), sessionId, agentId: id(r.agent_id),
    subagentId: r.subagent_id === null ? null : id(r.subagent_id), createdAt: createdAt(r.created_at),
    status: enumValue(r.status, ['queued', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled']) };
}
export function metadataPage<T extends { id: string }>(value: unknown, limit: number, project: (item: unknown) => T): MetadataPage<T> {
  const r = record(value);
  if (r.object !== 'list' || !Array.isArray(r.data) || r.data.length > limit || typeof r.has_more !== 'boolean') invalid();
  const data = r.data.map(project);
  if (new Set(data.map(item => item.id)).size !== data.length) invalid();
  const last = data.at(-1)?.id ?? null;
  if (r.last_id !== last || (r.has_more && !last)) invalid();
  return { data, hasMore: r.has_more, nextCursor: r.has_more ? last : null };
}
