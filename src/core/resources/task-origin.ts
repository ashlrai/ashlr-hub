/** Host-recorded provenance, never dispatch permission or proof of completion. */
import { canonical, digest } from '../universe/artifacts.js';

export interface ResourceGenerationIdentity {
  universeId: string;
  runId: string;
  variantId: string;
}
export interface ResourceGenerationTaskOrigin extends ResourceGenerationIdentity {
  kind: 'universe-generation';
}
export interface ResourceSuccessorTaskOrigin {
  kind: 'engineering-successor-proposal';
  scopeDigest: string;
  proposalKey: string;
}
export type ResourceTaskOrigin = ResourceGenerationTaskOrigin | ResourceSuccessorTaskOrigin;
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
const identityKeys = ['universeId', 'runId', 'variantId'];
function identifiers(value: Record<string, unknown>): boolean {
  return identityKeys.every(key => typeof value[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value[key]));
}

/** Preserve the existing task ID exactly; scratch paths never affect identity. */
export function resourceGenerationTaskId(identity: ResourceGenerationIdentity): string {
  if (!fields(identity, identityKeys) || !identifiers(identity)) throw new Error('Invalid Universe resource generation identity');
  const identityDigest = digest(canonical(identity));
  // Segments stay below the public scrubber's token-shaped string bound.
  return `u-${identityDigest.slice(0, 30)}-${identityDigest.slice(30, 60)}`;
}

export function validResourceTaskOrigin(value: unknown, taskId: string): value is ResourceTaskOrigin {
  if (fields(value, ['kind', 'scopeDigest', 'proposalKey'])) {
    return value.kind === 'engineering-successor-proposal' && typeof value.scopeDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(value.scopeDigest) && typeof value.proposalKey === 'string' &&
      /^[a-f0-9]{48}$/.test(value.proposalKey) && taskId === `proposal-${value.proposalKey}`;
  }
  return fields(value, ['kind', ...identityKeys]) && value.kind === 'universe-generation' && identifiers(value) &&
    resourceGenerationTaskId({ universeId: value.universeId as string, runId: value.runId as string,
      variantId: value.variantId as string }) === taskId;
}
