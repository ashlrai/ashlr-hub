import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBuildIdentity } from '../build-identity.js';

const REVISION_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export interface LaunchdReleaseFileIdentity {
  path: string;
  sha256: string;
}

export interface LaunchdReleaseObservation {
  schemaVersion: 1;
  releaseRevision: string;
  releaseRoot: string;
  node: LaunchdReleaseFileIdentity;
  supervisor: LaunchdReleaseFileIdentity;
  child: LaunchdReleaseFileIdentity;
  observationDigest: string;
}

function sameSnapshot(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function stableFileIdentity(requestedPath: string, requireCanonicalRequest: boolean): LaunchdReleaseFileIdentity {
  const requested = resolve(requestedPath);
  const canonical = realpathSync(requested);
  if (requireCanonicalRequest && canonical !== requested) {
    throw new Error('launchd release file path is not canonical');
  }
  const beforePath = lstatSync(canonical, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n ||
    beforePath.size < 1n || beforePath.size > BigInt(MAX_EXECUTABLE_BYTES)) {
    throw new Error('launchd release file is not a stable regular file');
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(canonical, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameSnapshot(beforePath, opened)) throw new Error('launchd release file changed before read');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(opened.size)) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(opened.size) - offset), offset);
      if (count <= 0) throw new Error('launchd release file short read');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(canonical, { bigint: true });
    if (!sameSnapshot(opened, after) || !sameSnapshot(after, afterPath) || realpathSync(canonical) !== canonical) {
      throw new Error('launchd release file changed during observation');
    }
    return Object.freeze({ path: canonical, sha256: hash.digest('hex') });
  } finally {
    closeSync(fd);
  }
}

export function launchdReleaseObservationDigest(
  value: Omit<LaunchdReleaseObservation, 'observationDigest'>,
): string {
  return createHash('sha256')
    .update('ashlr:launchd-release-observation:v1\0', 'utf8')
    .update(JSON.stringify([
      value.schemaVersion,
      value.releaseRevision,
      value.releaseRoot,
      value.node.path,
      value.node.sha256,
      value.supervisor.path,
      value.supervisor.sha256,
      value.child.path,
      value.child.sha256,
    ]), 'utf8')
    .digest('hex');
}

export function isLaunchdReleaseObservation(value: unknown): value is LaunchdReleaseObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const observation = value as Record<string, unknown>;
  if (Object.keys(observation).sort().join(',') !==
    'child,node,observationDigest,releaseRevision,releaseRoot,schemaVersion,supervisor') return false;
  const file = (entry: unknown): entry is LaunchdReleaseFileIdentity => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return Object.keys(record).sort().join(',') === 'path,sha256' &&
      typeof record['path'] === 'string' && resolve(record['path']) === record['path'] &&
      typeof record['sha256'] === 'string' && DIGEST_RE.test(record['sha256']);
  };
  if (observation['schemaVersion'] !== 1 ||
    typeof observation['releaseRevision'] !== 'string' || !REVISION_RE.test(observation['releaseRevision']) ||
    typeof observation['releaseRoot'] !== 'string' || resolve(observation['releaseRoot']) !== observation['releaseRoot'] ||
    !file(observation['node']) || !file(observation['supervisor']) || !file(observation['child']) ||
    typeof observation['observationDigest'] !== 'string' || !DIGEST_RE.test(observation['observationDigest'])) {
    return false;
  }
  const { observationDigest: digest, ...unsigned } = value as LaunchdReleaseObservation;
  return launchdReleaseObservationDigest(unsigned) === digest;
}

function canonicalReleaseRootFromEntrypoint(entrypoint: string, role: 'supervisor' | 'child'): string {
  const expectedName = role === 'supervisor' ? 'launchd-supervisor.js' : 'launchd-daemon-child.js';
  const requested = resolve(entrypoint);
  const canonical = realpathSync(requested);
  if (requested !== canonical) throw new Error('launchd release entrypoint path is not canonical');
  if (basename(canonical) !== expectedName) throw new Error('launchd release entrypoint role mismatch');
  const releaseRoot = realpathSync(dirname(dirname(dirname(canonical))));
  const expectedPath = join(releaseRoot, 'dist', 'cli', expectedName);
  if (canonical !== expectedPath) {
    throw new Error('launchd release entrypoint is not the canonical release path');
  }
  return releaseRoot;
}

function canonicalReleaseRootFromModule(): string {
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  return realpathSync(dirname(dirname(dirname(dirname(modulePath)))));
}

function observeReleaseRoot(releaseRoot: string): LaunchdReleaseObservation {
  const releaseRevision = basename(releaseRoot);
  if (!REVISION_RE.test(releaseRevision)) throw new Error('launchd release directory is not revision-addressed');
  const releasesRoot = realpathSync(join(realpathSync(resolve(homedir())), '.local', 'share', 'ashlr', 'releases'));
  if (dirname(releaseRoot) !== releasesRoot || resolve(releasesRoot, releaseRevision) !== releaseRoot) {
    throw new Error('launchd release is outside the immutable release store');
  }

  const supervisorPath = join(releaseRoot, 'dist', 'cli', 'launchd-supervisor.js');
  const childPath = join(releaseRoot, 'dist', 'cli', 'launchd-daemon-child.js');
  const identity = parseBuildIdentity(readFileSync(join(releaseRoot, 'dist', 'build-identity.json'), 'utf8'));
  if (!identity || identity.revision !== releaseRevision || identity.provenance === 'unavailable' ||
    identity.dirty === true) throw new Error('launchd release build identity is not immutable');

  const unsigned = {
    schemaVersion: 1 as const,
    releaseRevision,
    releaseRoot,
    node: stableFileIdentity(process.execPath, false),
    supervisor: stableFileIdentity(supervisorPath, true),
    child: stableFileIdentity(childPath, true),
  };
  return Object.freeze({ ...unsigned, observationDigest: launchdReleaseObservationDigest(unsigned) });
}

/** Observe only the executable release that is actually running this process. */
export function observeLaunchdRelease(role: 'supervisor' | 'child'): LaunchdReleaseObservation {
  const invoked = process.argv[1];
  if (!invoked) throw new Error('launchd release entrypoint is unavailable');
  return observeReleaseRoot(canonicalReleaseRootFromEntrypoint(invoked, role));
}

/** Observe the immutable packaged release that owns this service module before OS mutation. */
export function observeLaunchdInstallRelease(): LaunchdReleaseObservation {
  return observeReleaseRoot(canonicalReleaseRootFromModule());
}
