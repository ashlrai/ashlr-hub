import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface BuildIdentity {
  schemaVersion: 1;
  packageVersion: string | null;
  revision: string | null;
  dirty: boolean | null;
  provenance: 'git' | 'github-actions' | 'unavailable';
}

const REVISION_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const PACKAGE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const EMBEDDED_BUILD_IDENTITY = Symbol.for('ashlr.build-identity.v1');

export const UNAVAILABLE_BUILD_IDENTITY: Readonly<BuildIdentity> = Object.freeze({
  schemaVersion: 1,
  packageVersion: null,
  revision: null,
  dirty: null,
  provenance: 'unavailable',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBuildIdentity(raw: string): BuildIdentity | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schemaVersion !== 1) return null;
    if (typeof value.packageVersion !== 'string' || !PACKAGE_VERSION_RE.test(value.packageVersion)) return null;
    if (value.provenance === 'git') {
      if (typeof value.revision !== 'string' || !REVISION_RE.test(value.revision)) return null;
      if (typeof value.dirty !== 'boolean') return null;
    } else if (value.provenance === 'github-actions') {
      if (typeof value.revision !== 'string' || !REVISION_RE.test(value.revision)) return null;
      if (value.dirty !== null) return null;
    } else if (value.provenance === 'unavailable') {
      if (value.revision !== null || value.dirty !== null) return null;
    } else {
      return null;
    }
    return {
      schemaVersion: 1,
      packageVersion: value.packageVersion,
      revision: value.revision,
      dirty: value.dirty,
      provenance: value.provenance,
    } as BuildIdentity;
  } catch {
    return null;
  }
}

/** Read only build-produced data. This deliberately never shells out to Git. */
export function readBuildIdentity(options: { raw?: string; manifestPath?: string } = {}): BuildIdentity {
  if (options.raw !== undefined) {
    return parseBuildIdentity(options.raw) ?? { ...UNAVAILABLE_BUILD_IDENTITY };
  }
  const manifestPath = options.manifestPath
    ?? fileURLToPath(new URL('../build-identity.json', import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    const embedded = Reflect.get(globalThis, EMBEDDED_BUILD_IDENTITY) as unknown;
    raw = typeof embedded === 'string' ? embedded : '';
  }
  return parseBuildIdentity(raw) ?? { ...UNAVAILABLE_BUILD_IDENTITY };
}
