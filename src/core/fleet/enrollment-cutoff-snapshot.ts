import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { enrollmentPath } from '../sandbox/policy.js';
import { loadExistingProvenanceKey } from '../foundry/provenance.js';
import type { EnrollmentSnapshotV2 } from './post-merge-population-v2.js';
import {
  createAuthenticatedCutoffEnvelopeV2,
  verifyAuthenticatedCutoffEnvelopeV2,
  type AuthenticatedCutoffEnvelopeV2,
} from './authenticated-cutoff-snapshot.js';

const MAX_ENROLLMENT_BYTES = 1024 * 1024;
const MAX_ENROLLED_REPOS = 64;
const CAPTURE_BUDGET_MS = 15_000;
const GIT_TIMEOUT_MS = 2_000;
const SNAPSHOT_KEYS = new Set([
  'repos', 'defaultBranches', 'sourceState', 'complete', 'snapshotSchemaVersion',
  'snapshotKind', 'authorityScope', 'cutoffAuthority', 'cutoffBasis', 'consistency',
  'capturedAt', 'authorityId', 'sourceRoot', 'projectionRoot', 'snapshotDigest',
  'repositoryIdentities',
]);

interface RepositoryIdentity {
  repo: string;
  realPath: string;
  dev: number;
  ino: number;
  gitEntryDigest: string;
}

export type EnrollmentCutoffSnapshotV2 = EnrollmentSnapshotV2 & AuthenticatedCutoffEnvelopeV2 & {
  repositoryIdentities: RepositoryIdentity[];
};

export type CaptureEnrollmentCutoffSnapshotResult =
  | { ok: true; snapshot: EnrollmentCutoffSnapshotV2 }
  | { ok: false; reason: 'source-incomplete' | 'source-changed' | 'branch-unavailable' |
      'branch-changed' | 'invalid-time' | 'key-unavailable' | 'deadline-exceeded' |
      'platform-unsupported' };

interface EnrollmentSourceRead {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  repos: string[];
  fingerprint: string;
}

interface CaptureDependencies {
  now: () => string;
  monotonicNow: () => number;
  identityKey: () => Buffer | null;
  readSource: () => EnrollmentSourceRead;
  resolveDefaultBranch: (repo: string, timeoutMs: number) => string | null;
  inspectRepository: (repo: string) => RepositoryIdentity | null;
  onPhase?: (phase: 'after-first-read' | 'after-first-branches' | 'after-cutoff') => void;
}

function noControls(value: string): boolean {
  return [...value].every((char) => {
    const code = char.codePointAt(0)!;
    return code >= 32 && code !== 127;
  });
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validGitBranch(value: string): boolean {
  const forbidden = '~^:?*[\\';
  if (!value || value === '@' || Buffer.byteLength(value, 'utf8') > 1_024 ||
    [...value].some((char) => {
      const code = char.codePointAt(0)!;
      return code <= 32 || code === 127 || forbidden.includes(char);
    }) || value.includes('..') || value.includes('@{') || value.startsWith('/') ||
    value.endsWith('/') || value.endsWith('.')) return false;
  return value.split('/').every((part) => Boolean(part) && !part.startsWith('.') && !part.endsWith('.lock'));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeNode(stats: Stats, kind: 'file' | 'directory'): boolean {
  if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) return false;
  if (stats.isSymbolicLink()) return false;
  if (kind === 'file' && stats.nlink !== 1) return false;
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) return false;
    if ((stats.mode & 0o022) !== 0) return false;
  }
  return true;
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function degradedSource(): EnrollmentSourceRead {
  return { sourceState: 'degraded', complete: false, repos: [], fingerprint: '' };
}

function enrollmentFingerprint(repos: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(['enrollment-source:v1', repos])).digest('hex');
}

function readEnrollmentSource(): EnrollmentSourceRead {
  const path = enrollmentPath();
  if (!existsSync(path)) {
    return {
      sourceState: 'missing', complete: true, repos: [],
      fingerprint: createHash('sha256').update('missing').digest('hex'),
    };
  }
  let fd: number | undefined;
  try {
    const parentBefore = lstatSync(dirname(path));
    const namedBefore = lstatSync(path);
    if (!safeNode(parentBefore, 'directory') || !safeNode(namedBefore, 'file') ||
      realpathSync(dirname(path)) !== resolve(dirname(path)) ||
      namedBefore.size > MAX_ENROLLMENT_BYTES) return degradedSource();
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!safeNode(opened, 'file') || !sameNode(opened, namedBefore) || opened.size > MAX_ENROLLMENT_BYTES) {
      return degradedSource();
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    const parentAfter = lstatSync(dirname(path));
    if (bytes.length !== opened.size || !safeNode(after, 'file') || !safeNode(namedAfter, 'file') ||
      !safeNode(parentAfter, 'directory') || !sameNode(opened, after) || !sameNode(opened, namedAfter) ||
      after.size !== opened.size || !sameNode(parentBefore, parentAfter)) return degradedSource();
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || !Array.isArray((parsed as { repos?: unknown }).repos)) {
      return degradedSource();
    }
    const values = (parsed as { repos: unknown[] }).repos;
    if (values.length > MAX_ENROLLED_REPOS) return degradedSource();
    const repos: string[] = [];
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 ||
        !noControls(value) || !isAbsolute(value)) return degradedSource();
      const canonical = resolve(value);
      if (canonical !== value) return degradedSource();
      repos.push(canonical);
    }
    repos.sort(compareExact);
    if (new Set(repos).size !== repos.length) return degradedSource();
    return {
      sourceState: 'healthy', complete: true, repos,
      fingerprint: enrollmentFingerprint(repos),
    };
  } catch {
    return degradedSource();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* read already fails closed above */ } }
  }
}

function strictDefaultBranch(repo: string, timeoutMs: number): string | null {
  try {
    const output = execFileSync('git', [
      '-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD',
    ], { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs }).trim();
    if (!output.startsWith('origin/') || output.length <= 'origin/'.length) return null;
    const branch = output.slice('origin/'.length);
    return validGitBranch(branch) ? branch : null;
  } catch {
    return null;
  }
}

function inspectRepository(repo: string): RepositoryIdentity | null {
  try {
    const stats = lstatSync(repo);
    const realPath = realpathSync(repo);
    if (!stats.isDirectory() || stats.isSymbolicLink() || realPath !== repo) return null;
    const gitPath = resolve(repo, '.git');
    const gitStats = lstatSync(gitPath);
    if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) return null;
    const gitRealBefore = realpathSync(gitPath);
    const namedAfter = lstatSync(gitPath);
    const gitRealAfter = realpathSync(gitPath);
    if (!namedAfter.isDirectory() || namedAfter.isSymbolicLink() ||
      !sameNode(gitStats, namedAfter) || gitRealBefore !== gitRealAfter) return null;
    const gitEntryDigest = createHash('sha256').update(JSON.stringify([
      'enrollment-git-entry:v1', gitRealAfter, 'directory', gitStats.dev, gitStats.ino,
    ])).digest('hex');
    return { repo, realPath, dev: stats.dev, ino: stats.ino, gitEntryDigest };
  } catch {
    return null;
  }
}

function sourceSame(left: EnrollmentSourceRead, right: EnrollmentSourceRead): boolean {
  return left.sourceState === right.sourceState && left.complete === right.complete &&
    left.fingerprint === right.fingerprint && JSON.stringify(left.repos) === JSON.stringify(right.repos);
}

function branchSnapshot(
  repos: readonly string[],
  deps: CaptureDependencies,
  deadline: number,
): { branches: Array<{ repo: string; branch: string }>; identities: RepositoryIdentity[] } | null {
  const branches: Array<{ repo: string; branch: string }> = [];
  const identities: RepositoryIdentity[] = [];
  for (const repo of repos) {
    const remaining = Math.floor(deadline - deps.monotonicNow());
    if (remaining <= 0) return null;
    const identityBefore = deps.inspectRepository(repo);
    if (!identityBefore) return null;
    let branch: string | null;
    try { branch = deps.resolveDefaultBranch(repo, Math.min(GIT_TIMEOUT_MS, remaining)); }
    catch { branch = null; }
    const identityAfter = deps.inspectRepository(repo);
    if (!branch || !validGitBranch(branch) || !identityAfter ||
      JSON.stringify(identityBefore) !== JSON.stringify(identityAfter)) return null;
    branches.push({ repo, branch });
    identities.push(identityAfter);
  }
  return { branches, identities };
}

export function captureEnrollmentCutoffSnapshotV2(
  dependencies: Partial<CaptureDependencies> = {},
): CaptureEnrollmentCutoffSnapshotResult {
  try {
  const deps: CaptureDependencies = {
    now: () => new Date().toISOString(),
    monotonicNow: () => performance.now(),
    identityKey: () => { try { return loadExistingProvenanceKey(); } catch { return null; } },
    readSource: readEnrollmentSource,
    resolveDefaultBranch: strictDefaultBranch,
    inspectRepository,
    ...dependencies,
  };
  if (process.platform === 'win32') return { ok: false, reason: 'platform-unsupported' };
  const deadline = deps.monotonicNow() + CAPTURE_BUDGET_MS;
  const first = deps.readSource();
  if (!first.complete || first.sourceState !== 'healthy') return { ok: false, reason: 'source-incomplete' };
  deps.onPhase?.('after-first-read');
  const branchesBefore = branchSnapshot(first.repos, deps, deadline);
  if (!branchesBefore) {
    return { ok: false, reason: deps.monotonicNow() >= deadline ? 'deadline-exceeded' : 'branch-unavailable' };
  }
  deps.onPhase?.('after-first-branches');
  const second = deps.readSource();
  if (!sourceSame(first, second)) return { ok: false, reason: 'source-changed' };
  const capturedAt = deps.now();
  if (!canonicalTimestamp(capturedAt)) return { ok: false, reason: 'invalid-time' };
  deps.onPhase?.('after-cutoff');
  const branchesAfter = branchSnapshot(second.repos, deps, deadline);
  if (!branchesAfter) {
    return { ok: false, reason: deps.monotonicNow() >= deadline ? 'deadline-exceeded' : 'branch-unavailable' };
  }
  if (JSON.stringify(branchesBefore) !== JSON.stringify(branchesAfter)) {
    return { ok: false, reason: 'branch-changed' };
  }
  const third = deps.readSource();
  if (!sourceSame(second, third)) return { ok: false, reason: 'source-changed' };
  if (deps.monotonicNow() >= deadline) return { ok: false, reason: 'deadline-exceeded' };
  let key: Buffer | null;
  try { key = deps.identityKey(); } catch { key = null; }
  if (!key || key.length !== 32) return { ok: false, reason: 'key-unavailable' };
  if (deps.monotonicNow() >= deadline) return { ok: false, reason: 'deadline-exceeded' };
  const envelope = createAuthenticatedCutoffEnvelopeV2({
    kind: 'enrollment',
    capturedAt,
    sourcePayload: [third.sourceState, third.complete, third.fingerprint, third.repos],
    projectionPayload: [branchesAfter.branches, branchesAfter.identities],
  }, () => key);
  if (!envelope) return { ok: false, reason: 'key-unavailable' };
  if (deps.monotonicNow() >= deadline) return { ok: false, reason: 'deadline-exceeded' };
  return {
    ok: true,
    snapshot: {
      repos: third.repos,
      defaultBranches: branchesAfter.branches,
      repositoryIdentities: branchesAfter.identities,
      sourceState: third.sourceState,
      complete: true,
      ...envelope,
    },
  };
  } catch {
    return { ok: false, reason: 'source-incomplete' };
  }
}

export function verifyEnrollmentCutoffSnapshotV2(
  snapshot: EnrollmentCutoffSnapshotV2,
  keyProvider: () => Buffer | null = () => {
    try { return loadExistingProvenanceKey(); } catch { return null; }
  },
): boolean {
  try {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      Object.keys(snapshot).length !== SNAPSHOT_KEYS.size ||
      Object.keys(snapshot).some((key) => !SNAPSHOT_KEYS.has(key)) ||
      process.platform === 'win32' || snapshot.snapshotKind !== 'enrollment' ||
      snapshot.sourceState !== 'healthy' || !snapshot.complete ||
      snapshot.repos.length > MAX_ENROLLED_REPOS ||
      snapshot.defaultBranches.length !== snapshot.repos.length) return false;
    const repos = [...snapshot.repos].sort(compareExact);
    if (JSON.stringify(repos) !== JSON.stringify(snapshot.repos) || new Set(repos).size !== repos.length ||
      repos.some((repo) => !isAbsolute(repo) || resolve(repo) !== repo || !noControls(repo))) {
      return false;
    }
    const branches = [...snapshot.defaultBranches]
      .sort((left, right) => compareExact(left.repo, right.repo));
    if (JSON.stringify(branches) !== JSON.stringify(snapshot.defaultBranches) ||
      branches.some((row, index) => Object.keys(row).length !== 2 ||
        !Object.hasOwn(row, 'repo') || !Object.hasOwn(row, 'branch') ||
        row.repo !== repos[index] || !validGitBranch(row.branch))) return false;
    if (!Array.isArray(snapshot.repositoryIdentities) ||
      snapshot.repositoryIdentities.length !== repos.length ||
      snapshot.repositoryIdentities.some((row, index) => Object.keys(row).length !== 5 ||
        row.repo !== repos[index] || row.realPath !== repos[index] ||
        repos[index]!.length > 4_096 || !Number.isSafeInteger(row.dev) || row.dev < 0 ||
        !Number.isSafeInteger(row.ino) || row.ino < 0 ||
        !/^[a-f0-9]{64}$/.test(row.gitEntryDigest))) return false;
    return verifyAuthenticatedCutoffEnvelopeV2(snapshot, {
      kind: 'enrollment',
      capturedAt: snapshot.capturedAt,
      sourcePayload: [snapshot.sourceState, snapshot.complete,
        enrollmentFingerprint(snapshot.repos), snapshot.repos],
      projectionPayload: [snapshot.defaultBranches, snapshot.repositoryIdentities],
    }, keyProvider);
  } catch {
    return false;
  }
}
