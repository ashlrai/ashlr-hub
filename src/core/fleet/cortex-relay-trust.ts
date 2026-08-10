import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { assurePrivateStoragePath } from '../util/private-storage.js';
import type {
  EngineeringAssignmentVerifier,
  EngineeringAssignmentV1,
} from './cortex-engineering-assignment.js';

const MAX_POLICY_BYTES = 128 * 1024;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const WORKSTREAMS = new Set<EngineeringAssignmentV1['workstream']>([
  'personal', 'company', 'govcon', 'commercial',
]);

export interface CortexRelayTrustPolicy extends EngineeringAssignmentVerifier {
  schemaVersion: 1;
  organizationRef: string;
  allowedWorkstreams: readonly EngineeringAssignmentV1['workstream'][];
  locusExecutable: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 &&
    IDENTIFIER_RE.test(value);
}

function parsePolicy(value: unknown): CortexRelayTrustPolicy | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'issuer', 'audience', 'organizationRef', 'allowedWorkstreams',
    'publicKeys', 'locusExecutable',
  ]) || value.schemaVersion !== 1 || !identifier(value.issuer) ||
      !identifier(value.audience) || !identifier(value.organizationRef) ||
      typeof value.locusExecutable !== 'string' || !value.locusExecutable.startsWith('/') ||
      value.locusExecutable.length > 1_024 || !Array.isArray(value.allowedWorkstreams) ||
      value.allowedWorkstreams.length < 1 || value.allowedWorkstreams.length > 4 ||
      !value.allowedWorkstreams.every((entry) => WORKSTREAMS.has(entry as EngineeringAssignmentV1['workstream'])) ||
      new Set(value.allowedWorkstreams).size !== value.allowedWorkstreams.length ||
      !isRecord(value.publicKeys)) return null;
  const keys = Object.entries(value.publicKeys);
  if (keys.length < 1 || keys.length > 16 || keys.some(([keyId, key]) =>
    !identifier(keyId) || typeof key !== 'string' || key.length < 1 || key.length > 16 * 1024)) return null;
  return Object.freeze({
    schemaVersion: 1,
    issuer: value.issuer,
    audience: value.audience,
    organizationRef: value.organizationRef,
    allowedWorkstreams: Object.freeze([
      ...(value.allowedWorkstreams as EngineeringAssignmentV1['workstream'][]),
    ]),
    publicKeys: Object.freeze(Object.fromEntries(keys) as Record<string, string>),
    locusExecutable: value.locusExecutable,
  });
}

/** Read-only fail-closed trust policy. This function never creates or repairs state. */
export function loadCortexRelayTrustPolicy(): CortexRelayTrustPolicy | null {
  const root = join(homedir(), '.ashlr');
  const path = join(root, 'cortex-relay-trust.json');
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
        before.size < 2n || before.size > BigInt(MAX_POLICY_BYTES) ||
        (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) ||
        (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n) ||
        !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: root }).ok) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.nlink !== 1n) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        namedAfter.dev !== before.dev || namedAfter.ino !== before.ino ||
        !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: root }).ok) return null;
    const text = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(text, 'utf8'))) return null;
    return parsePolicy(JSON.parse(text) as unknown);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export const _parseCortexRelayTrustPolicyForTest = parsePolicy;
