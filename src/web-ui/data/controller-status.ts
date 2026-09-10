import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';
import { apiGet } from './client.js';

export function isControllerId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value);
}
function code(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_:-]{0,191}$/.test(value);
}

/** Validate identity and bounded public fields before rendering any evidence. */
export function validateControllerStatus(value: unknown, controllerId: string): UniversePortfolioControllerView {
  const invalid = () => new Error('Controller evidence could not be validated.');
  if (!isControllerId(controllerId) || !record(value) || value.schemaVersion !== 1 || value.controllerId !== controllerId ||
    typeof value.sourceState !== 'string' || !['healthy', 'missing', 'degraded'].includes(value.sourceState) ||
    typeof value.status !== 'string' || !['completed', 'incomplete', 'cancelled', 'timed-out', 'unavailable', 'draining', 'drained'].includes(value.status) ||
    !(value.createdAt === null || timestamp(value.createdAt)) || !(value.deadlineAt === null || timestamp(value.deadlineAt)) ||
    !timestamp(value.observedAt) || !Array.isArray(value.reasons) || value.reasons.length > 128 || !value.reasons.every(code) ||
    !Array.isArray(value.outcomes) || value.outcomes.length > 64) throw invalid();
  const seen = new Set<string>();
  const outcomes = value.outcomes.map((row: unknown) => {
    if (!record(row) || typeof row.campaignId !== 'string' || !isControllerId(row.campaignId) || seen.has(row.campaignId) ||
      typeof row.state !== 'string' || !['pending', 'in-flight', 'completed', 'held'].includes(row.state) || typeof row.attempted !== 'boolean' || !code(row.reasonCode)) throw invalid();
    seen.add(row.campaignId);
    return { campaignId: row.campaignId, state: row.state, attempted: row.attempted, reasonCode: row.reasonCode };
  });
  let topology: UniversePortfolioControllerView['topology'];
  if (value.topology !== undefined) {
    if (!Array.isArray(value.topology) || value.topology.length > 64 || value.topology.length !== outcomes.length) throw invalid();
    const topologyIds = new Set<string>();
    topology = value.topology.map((node: unknown) => {
      if (!record(node) || !isControllerId(node.campaignId) || !seen.has(node.campaignId) || topologyIds.has(node.campaignId)) throw invalid();
      topologyIds.add(node.campaignId);
      const references = (input: unknown): string[] => {
        if (!Array.isArray(input) || input.length > 63 || !input.every((id) => isControllerId(id) && seen.has(id) && id !== node.campaignId) ||
          new Set(input).size !== input.length) throw invalid();
        return [...input] as string[];
      };
      const dependsOn = references(node.dependsOn); const prerequisites = references(node.prerequisites);
      if (dependsOn.some((id) => !prerequisites.includes(id))) throw invalid();
      return { campaignId: node.campaignId, dependsOn, prerequisites };
    });
    // Bound traversal and reject cycles in effective gates, not only declared edges.
    // The server's additional gates must also be genuine declared ancestors.
    const byId = new Map(topology.map((node) => [node.campaignId, node]));
    const resolved = new Set<string>();
    while (resolved.size < topology.length) {
      const next = topology.find((node) => !resolved.has(node.campaignId) && node.prerequisites.every((id) => resolved.has(id)));
      if (!next) throw invalid();
      resolved.add(next.campaignId);
    }
    for (const node of topology) {
      const ancestors = new Set<string>(); const pending = [...node.dependsOn];
      while (pending.length) {
        const id = pending.pop()!;
        if (ancestors.has(id)) continue;
        ancestors.add(id); pending.push(...byId.get(id)!.dependsOn);
      }
      if (node.prerequisites.some((id) => !ancestors.has(id))) throw invalid();
    }
  }
  let control: UniversePortfolioControllerView['control'];
  if (value.control !== undefined) {
    const current = value.control;
    if (!record(current) || typeof current.mode !== 'string' || !['open', 'drain'].includes(current.mode) || !Number.isInteger(current.sequence) ||
      (current.sequence as number) < 1 || (current.sequence as number) > 511 || !timestamp(current.requestedAt) ||
      !(current.acknowledgedAt === null || timestamp(current.acknowledgedAt))) throw invalid();
    control = { mode: current.mode as 'open' | 'drain', sequence: current.sequence as number,
      requestedAt: current.requestedAt, acknowledgedAt: current.acknowledgedAt };
  }
  if (control?.mode === 'open' && control.acknowledgedAt !== null ||
    value.status === 'draining' && (control?.mode !== 'drain' || control.acknowledgedAt !== null) ||
    value.status === 'drained' && (control?.mode !== 'drain' || control.acknowledgedAt === null)) throw invalid();
  // Explicit projection also prevents unexpected private fields entering UI state.
  return { schemaVersion: 1, controllerId, sourceState: value.sourceState, status: value.status,
    createdAt: value.createdAt, deadlineAt: value.deadlineAt, observedAt: value.observedAt,
    reasons: [...value.reasons], outcomes, ...(topology ? { topology } : {}), ...(control ? { control } : {}) } as UniversePortfolioControllerView;
}

export async function readControllerStatus(controllerId: string, signal?: AbortSignal): Promise<UniversePortfolioControllerView> {
  if (!isControllerId(controllerId)) throw new Error('Enter a valid controller ID.');
  const result = await apiGet<unknown>(`/api/universe/controller-status?controllerId=${encodeURIComponent(controllerId)}`, signal);
  return validateControllerStatus(result, controllerId);
}
