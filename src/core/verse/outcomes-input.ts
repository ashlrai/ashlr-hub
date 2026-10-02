import { normalizeOutcomeScope, outcomeToken, type OutcomeScope } from '../goals/outcome-types.js';
import { OUTCOME_ID_PATTERN, type OutcomeOperation } from './outcomes-api-types.js';
import { expandHomePrefix } from './path-guard.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Unexpected or missing outcome fields.');
  }
}

/** Shared by the route and the fixed worker; there is no planner graph input. */
export function normalizeOutcomeOperation(value: unknown): OutcomeOperation {
  const input = object(value);
  if (input.kind === 'read') { exactKeys(input, ['kind']); return { kind: 'read' }; }
  const kind = input.kind;
  if (kind !== 'start' && kind !== 'edit' && kind !== 'pause' && kind !== 'resume') throw new Error('Invalid outcome action.');
  const keys = ['kind', 'id', 'commandId', 'expectedRevision'];
  if (kind === 'start' || kind === 'edit') keys.push('scope');
  exactKeys(input, keys);
  if (typeof input.id !== 'string' || !OUTCOME_ID_PATTERN.test(input.id) || !outcomeToken(input.commandId) ||
      !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 ||
      (kind === 'start' && input.expectedRevision !== 0)) throw new Error('Invalid outcome identity, command or revision.');
  const command = { id: input.id, commandId: input.commandId, expectedRevision: Number(input.expectedRevision) };
  if (kind === 'start' || kind === 'edit') {
    const scope = object(input.scope);
    exactKeys(scope, ['desiredOutcome', 'targetRepos', 'acceptance']);
    // The existing public JSON contract spells this user's home as '~'.
    // Expansion is lexical only; the worker still requires exact enrollment.
    const expanded = { ...scope, targetRepos: Array.isArray(scope.targetRepos)
      ? scope.targetRepos.map(repo => typeof repo === 'string' ? expandHomePrefix(repo) : repo) : scope.targetRepos };
    return { ...command, kind, scope: normalizeOutcomeScope(expanded as unknown as OutcomeScope) };
  }
  return { ...command, kind };
}
