/** Historical host provenance only; never dispatch permission or acceptance. */
import { canonical, digest } from '../universe/artifacts.js';

export interface ResourceGenerationIdentity {
  universeId: string;
  runId: string;
  variantId: string;
}
export interface ResourceTaskOrigin extends ResourceGenerationIdentity {
  kind: 'universe-generation';
}
const IDENTITY_KEYS = ['universeId', 'runId', 'variantId'];

function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function identifiers(value: Record<string, unknown>): boolean {
  return IDENTITY_KEYS.every(key => typeof value[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value[key]));
}

/** Preserve valid JSON task IDs exactly; scratch paths never affect identity. */
export function resourceGenerationTaskId(identity: ResourceGenerationIdentity): string {
  if (!fields(identity, IDENTITY_KEYS) || !identifiers(identity)) throw new Error('Invalid Universe resource generation identity');
  const identityDigest = digest(canonical(identity));
  // Keep each segment below the public scrubber's token-shaped string bound.
  return `u-${identityDigest.slice(0, 30)}-${identityDigest.slice(30, 60)}`;
}

/** Accept only the historical writer's exact shape and derived identity. */
export function validResourceTaskOrigin(value: unknown, taskId: string): value is ResourceTaskOrigin {
  return fields(value, ['kind', ...IDENTITY_KEYS]) && value.kind === 'universe-generation' && identifiers(value) &&
    resourceGenerationTaskId({ universeId: value.universeId as string, runId: value.runId as string,
      variantId: value.variantId as string }) === taskId;
}
