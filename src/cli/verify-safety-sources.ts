/** Artifact-owned text for the native structural diagnostic, never an authority grant. */
import { createHash } from 'node:crypto';

export const VERIFY_SAFETY_SOURCE_SYMBOL = Symbol.for('ashlr.verify-safety-sources.v1');
export const VERIFY_SAFETY_SOURCE_KEYS = [
  'sandbox/policy', 'daemon/loop', 'knowledge/index', 'knowledge/graph', 'run/provider-client',
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Validate the complete snapshot once. A bad snapshot must never fall back to sibling files. */
export function embeddedSafetySourceReader(raw: unknown, buildIdentityJson: unknown): (key: string) => string {
  if (typeof raw !== 'string' || typeof buildIdentityJson !== 'string' || buildIdentityJson.length === 0) {
    throw new Error('Native safety source snapshot or build identity is missing');
  }
  const value: unknown = JSON.parse(raw);
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'buildIdentityJson', 'sources']) ||
    value.schemaVersion !== 1 || value.buildIdentityJson !== buildIdentityJson ||
    !object(value.sources) || !exactKeys(value.sources, VERIFY_SAFETY_SOURCE_KEYS)) {
    throw new Error('Native safety source snapshot does not match this build');
  }
  const sources = new Map<string, string>();
  for (const key of VERIFY_SAFETY_SOURCE_KEYS) {
    const entry = value.sources[key];
    if (!object(entry) || !exactKeys(entry, ['text', 'sha256']) || typeof entry.text !== 'string' ||
      entry.text.length === 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      createHash('sha256').update(entry.text, 'utf8').digest('hex') !== entry.sha256) {
      throw new Error('Native safety source snapshot is incomplete or changed');
    }
    sources.set(key, entry.text);
  }
  return (key) => {
    const text = sources.get(key);
    if (text === undefined) throw new Error('Unknown native safety source key');
    return text;
  };
}
