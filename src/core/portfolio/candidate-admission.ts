/**
 * Read-only, fail-closed pre-enrollment evidence for one candidate repository.
 *
 * Candidate metadata is hostile. Every Git call uses an isolated environment,
 * disables optional locks and executable extension points, and reads only
 * bounded metadata or immutable HEAD blobs. Judge-free candidacy additionally
 * requires one repo-owned admission declaration, the latest actual Actions
 * execution to have succeeded, and a separate trusted-App check whose external attestation binds the
 * complete HEAD commit/tree snapshot and every admission policy input.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import {
  buildCanonicalProtectedRemotePolicyDigestV1,
  evaluateSafeMinimumProtectedRemotePolicyV1,
  readBranchProtectionAttestation,
  type BranchProtectionAttestation,
  type RequiredCheckBinding,
  type SafeMinimumProtectedRemotePolicyV1Verdict,
} from '../integrations/github.js';
import {
  canonicalEnrollmentPath,
  readEnrollmentRegistry,
  type EnrollmentRegistrySnapshot,
} from '../sandbox/policy.js';
import { buildRequiredVerificationManifest } from '../run/verification-manifest.js';
import {
  parseRepoVerifyContractDocument,
  type RepoPackageManager,
  type RepoProjectKind,
} from '../run/repo-profile.js';
import { filterVerifyCommandsForProfile } from '../run/verify-commands.js';
import {
  inspectOwnedAuthorityPath,
  resolveTrustedGitCli,
  resolveTrustedGithubCli,
  trustedGitEnvironment,
  trustedGithubEnvironment,
  verifyTrustedGitCli,
  verifyTrustedGithubCli,
  type TrustedExecutablePin,
} from '../util/trusted-executable.js';

export const CANDIDATE_REPO_ADMISSION_SCHEMA_VERSION = 7 as const;
export const CANDIDATE_ADMISSION_CONTRACT_FILE = 'ashlr.admission.json';
export const CANDIDATE_VERIFY_CONTRACT_FILE = 'ashlr.verify.json';
export const CANDIDATE_ADMISSION_AUTHORITY_FILE = 'candidate-admission-authority.json';
export const CANDIDATE_ATTESTATION_DOMAIN = 'ashlr:candidate-admission-whole-head-attestation:v6';
export const CANDIDATE_ADMISSION_EVALUATOR_VERSION = 'ashlr-candidate-admission-evaluator-v6';

const SELF_REPOSITORY = 'ashlrai/ashlr-hub';
const SELF_PACKAGE_NAME = '@ashlr/hub';
const GIT_TIMEOUT_MS = 5_000;
const GH_TIMEOUT_MS = 8_000;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_GH_OUTPUT = 1024 * 1024;
const MAX_HEAD_BLOB_BYTES = 512 * 1024;
const MAX_TRACKED_WORKTREE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_CONFIG_ENTRIES = 2_000;
const SHA1_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const APP_ID_RE = /^[1-9][0-9]{0,19}$/;
const MIN_EVIDENCE_MAX_AGE_MS = 60_000;
const MAX_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_EVIDENCE_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_TRUSTED_APP_IDS = 16;
const GITHUB_COLLECTION_PAGE_SIZE = 100;
const MAX_GITHUB_COLLECTION_ITEMS = 1_000;
const MAX_WORKFLOW_ATTEMPTS = 1_000;
const MAX_AUTHORITY_FILE_BYTES = 64 * 1024;
const AUTHORITY_EPOCH_CLOSURE_ROUNDS = 2;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export type CandidateAdmissionVerdict = 'blocked' | 'proposal-only' | 'evidence-candidate';
export type CandidateRiskClassification = 'ordinary' | 'sensitive' | 'regulated' | 'critical';

export interface CandidateAdmissionFinding {
  id: string;
  detail: string;
  fix: string;
}

export interface CandidateEnrollmentEvidence {
  registryState: EnrollmentRegistrySnapshot['state'];
  registryReason: string;
  enrolled: boolean | null;
}

export interface CandidateMutationProof {
  available: boolean;
  indexUnchanged: boolean;
  gitConfigUnchanged: boolean;
  headUnchanged: boolean;
  headTreeUnchanged: boolean;
  statusUnchanged: boolean;
  controlFilesUnchanged: boolean;
  repoBytesUnchanged: boolean;
  detail: string;
}

export interface CandidateSourceEvidence {
  available: boolean;
  clean: boolean;
  current: boolean;
  branch: string | null;
  defaultBranch: string | null;
  head: string | null;
  remoteHead: string | null;
  dirtyEntries: number | null;
  gitMetadataSafe: boolean;
  mutationProof: CandidateMutationProof;
  detail: string;
}

export interface CandidateVerifierEvidence {
  available: boolean;
  projectKinds: RepoProjectKind[];
  packageManagers: RepoPackageManager[];
  verifyCommandCount: number;
  mergeCommandCount: number;
  requiredManifestDigest: string | null;
  contractPresent: boolean;
  contractValid: boolean;
  contractSource: 'head-regular' | 'missing' | 'invalid-mode' | 'worktree-diverged' | 'unavailable';
  headBlobOid: string | null;
  headMode: string | null;
  worktreeMatchesHead: boolean;
  mergeGradeExplicit: boolean;
  declaredProfile: 'merge' | null;
  detail: string;
}

export interface CandidateAdmissionContractEvidence {
  state: 'head-regular' | 'missing' | 'invalid' | 'invalid-mode' | 'worktree-diverged' | 'unavailable';
  riskClassification: CandidateRiskClassification | null;
  declaredProfile: 'merge' | null;
  workflow: string | null;
  check: string | null;
  headBlobOid: string | null;
  worktreeMatchesHead: boolean;
  detail: string;
}

export interface CandidateAdmissionTrustedPolicy {
  schemaVersion: 2;
  trustedAppIds: string[];
  attestationCheck: string;
  evidenceMaxAgeMs: number;
  evidenceFutureSkewMs: number;
  evaluatorVersion: typeof CANDIDATE_ADMISSION_EVALUATOR_VERSION;
  digest: string;
}

export interface CandidateAdmissionTrustedPolicyEvidence {
  available: boolean;
  schemaVersion: 2 | null;
  trustedAppIds: string[];
  attestationCheck: string | null;
  authorityFile: string;
  custodyState: CandidateTrustedPolicyAuthorityRead['state'];
  evidenceMaxAgeMs: number | null;
  evidenceFutureSkewMs: number | null;
  evaluatorVersion: typeof CANDIDATE_ADMISSION_EVALUATOR_VERSION;
  digest: string | null;
  detail: string;
}

export interface CandidateCheckRunEvidence {
  available: boolean;
  ready: boolean;
  workflow: string | null;
  workflowRunId: string | null;
  workflowRunNumber: number | null;
  workflowRunAttempt: number | null;
  check: string | null;
  workflowJobId: string | null;
  workflowCheckRunId: string | null;
  workflowAppId: string | null;
  attestationCheck: string | null;
  attestationCheckRunId: string | null;
  appId: string | null;
  head: string | null;
  status: string | null;
  conclusion: string | null;
  externalIdMatched: boolean;
  trustedPolicyDigest: string | null;
  evaluatorVersion: string | null;
  workflowCreatedAt: string | null;
  workflowStartedAt: string | null;
  workflowCompletedAt: string | null;
  jobStartedAt: string | null;
  jobCompletedAt: string | null;
  workflowCheckStartedAt: string | null;
  workflowCheckCompletedAt: string | null;
  attestationStartedAt: string | null;
  attestationCompletedAt: string | null;
  fresh: boolean;
  authorityDigest: string | null;
  detail: string;
}

export interface CandidateRemotePrEvidence {
  available: boolean;
  ready: boolean;
  nameWithOwner: string | null;
  repositoryId: string | null;
  defaultBranch: string | null;
  baseHead: string | null;
  candidateHead: string | null;
  protected: boolean;
  pullRequestRequired: boolean;
  requiredChecks: string[];
  requiredCheckBindings: Array<{ context: string; appId: string | null }>;
  safeMinimum: boolean;
  policyDigest: string | null;
  trustedPolicyDigest: string | null;
  evaluatorVersion: string | null;
  observedAt: string | null;
  expectedAttestationId: string | null;
  evidenceScope: 'whole-head-snapshot';
  candidateTreeOid: string | null;
  remoteStableAfterChecks: boolean;
  trustedPolicyStableAfterChecks: boolean;
  checkEvidenceStableAfterRecheck: boolean;
  authorityEpochStable: boolean;
  initialAuthorityEpochDigest: string | null;
  finalAuthorityEpochDigest: string | null;
  checkRun: CandidateCheckRunEvidence;
  detail: string;
}

export interface CandidateRiskEvidence {
  state: 'attested' | 'declared-unattested' | 'missing' | 'invalid' | 'unavailable';
  classification: CandidateRiskClassification | null;
  restricted: boolean;
  selfTarget: boolean | null;
  filenameHeuristicsUsed: false;
  autonomyCeiling: 'proposal-only' | 'evidence-candidate';
  detail: string;
}

export interface CandidateRepoAdmissionReport {
  schemaVersion: typeof CANDIDATE_REPO_ADMISSION_SCHEMA_VERSION;
  generatedAt: string;
  readOnly: true;
  authorityGranted: false;
  mutationPerformed: false;
  repo: string;
  name: string;
  verdict: CandidateAdmissionVerdict;
  admissionReady: boolean;
  judgeFreeEligible: boolean;
  primaryAction: string;
  admissionBlockers: CandidateAdmissionFinding[];
  autonomyBlockers: CandidateAdmissionFinding[];
  warnings: CandidateAdmissionFinding[];
  enrollment: CandidateEnrollmentEvidence;
  source: CandidateSourceEvidence;
  verifier: CandidateVerifierEvidence;
  admissionContract: CandidateAdmissionContractEvidence;
  trustedPolicy: CandidateAdmissionTrustedPolicyEvidence;
  remotePr: CandidateRemotePrEvidence;
  risk: CandidateRiskEvidence;
}

export interface CandidateGitInvocation {
  repo: string;
  args: string[];
  maxOutputBytes: number;
  timeoutMs: number;
  trustedGitCli?: TrustedExecutablePin;
  untrustedRoots?: string[];
}

export interface CandidateGitResult {
  status: number;
  stdout: Buffer;
}

export type CandidateGitRunner = (invocation: CandidateGitInvocation) => CandidateGitResult | null;

export interface CandidateRemoteHeadEvidence {
  available: boolean;
  nameWithOwner: string | null;
  defaultBranch: string | null;
  head: string | null;
  detail: string;
}

export interface CandidateCheckRunRequest {
  candidateRoot: string;
  trustedGithubCli?: TrustedExecutablePin;
  nameWithOwner: string;
  branch: string;
  head: string;
  workflow: string;
  check: string;
  workflowAppId: string;
  attestationCheck: string;
  expectedAttestations: Array<{ appId: string; externalId: string }>;
  trustedPolicyDigest: string;
  evaluatorVersion: typeof CANDIDATE_ADMISSION_EVALUATOR_VERSION;
  evaluatedAt: string;
  evidenceMaxAgeMs: number;
  evidenceFutureSkewMs: number;
}

export interface CandidateTrustedPolicyAuthorityRead {
  state: 'verified' | 'missing' | 'unsafe' | 'unstable' | 'unreadable';
  path: string;
  value: unknown | null;
  proof: string | null;
  detail: string;
}

export interface CandidateAuthorityReadHooks {
  afterOpen?: () => void;
  afterFirstRead?: () => void;
  /** Explicit test anchor; production authority is always anchored to the OS account home. */
  authorityAnchorPath?: string;
}

export interface CandidateRepoAdmissionDeps {
  now: () => Date;
  canonicalPath: (value: string) => string | null;
  readEnrollment: () => EnrollmentRegistrySnapshot;
  git: CandidateGitRunner;
  readRemoteHead: (
    nameWithOwner: string,
    candidateRoot: string,
    trustedGithubCli: TrustedExecutablePin | null,
  ) => CandidateRemoteHeadEvidence;
  readProtection: (
    neutralCwd: string,
    branch: string | undefined,
    options: {
      forceFresh: boolean;
      expectedNameWithOwner: string;
      trustedGithubCli?: TrustedExecutablePin;
      untrustedRoots?: string[];
    },
  ) => Promise<BranchProtectionAttestation>;
  readCheckRun: (request: CandidateCheckRunRequest) => CandidateCheckRunEvidence;
  readTrustedPolicy: () => CandidateTrustedPolicyAuthorityRead;
  resolveGitCli: typeof resolveTrustedGitCli;
  verifyGitCli: typeof verifyTrustedGitCli;
  resolveGithubCli: typeof resolveTrustedGithubCli;
  verifyGithubCli: typeof verifyTrustedGithubCli;
  evaluateSafeMinimum: typeof evaluateSafeMinimumProtectedRemotePolicyV1;
  buildPolicyDigest: typeof buildCanonicalProtectedRemotePolicyDigestV1;
  /** Test-only race hook immediately before the final correlated evidence collection. */
  beforeFinalEvidenceRecheck?: () => void;
  /** Test-only race hook after check recollection and before closing authority rereads. */
  afterFinalEvidenceRecheck?: () => void;
}

interface GitTreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  oid: string;
  path: string;
}

interface HeadFile {
  state: 'regular' | 'missing' | 'invalid-mode' | 'unavailable';
  mode: string | null;
  oid: string | null;
  bytes: Buffer | null;
  worktreeMatchesHead: boolean;
  detail: string;
}

interface AdmissionDeclaration {
  riskClassification: CandidateRiskClassification;
  profile: 'merge';
  workflow: string;
  check: string;
}

interface LocalSnapshot {
  available: boolean;
  gitMetadataSafe: boolean;
  configReason: string;
  origin: { nameWithOwner: string } | null;
  branch: string | null;
  head: string | null;
  status: Buffer | null;
  tree: GitTreeEntry[] | null;
  configDigest: string | null;
  treeDigest: string | null;
  headTreeOid: string | null;
  trackedBytesDigest: string | null;
  trackedBytesMatchHead: boolean;
  trackedBytesComplete: boolean;
  indexDigest: string | null;
  controlsDigest: string | null;
}

function finding(id: string, detail: string, fix: string): CandidateAdmissionFinding {
  return { id, detail, fix };
}

function defaultGitRunner(invocation: CandidateGitInvocation): CandidateGitResult | null {
  if (!invocation.trustedGitCli || !Array.isArray(invocation.untrustedRoots)) return null;
  const hardening = [
    '--no-pager',
    '--no-optional-locks',
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', `core.hooksPath=${NULL_DEVICE}`,
    '-c', `core.attributesFile=${NULL_DEVICE}`,
    '-c', 'credential.helper=',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always',
    '-c', 'submodule.recurse=false',
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
    '-C', invocation.repo,
  ];
  try {
    const stdout = execFileSync(invocation.trustedGitCli.executable, [...hardening, ...invocation.args], {
      encoding: 'buffer',
      env: trustedGitEnvironment(invocation.trustedGitCli),
      maxBuffer: invocation.maxOutputBytes,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: invocation.timeoutMs,
      windowsHide: true,
    });
    return stdout.length <= invocation.maxOutputBytes ? { status: 0, stdout } : null;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof status === 'number' && Buffer.isBuffer(stdout) && stdout.length <= invocation.maxOutputBytes) {
      return { status, stdout };
    }
    return null;
  }
}

function runGit(
  deps: CandidateRepoAdmissionDeps,
  repo: string,
  args: string[],
  maxOutputBytes = MAX_GIT_OUTPUT,
  timeoutMs = GIT_TIMEOUT_MS,
): CandidateGitResult | null {
  return deps.git({ repo, args, maxOutputBytes, timeoutMs });
}

function gitText(
  deps: CandidateRepoAdmissionDeps,
  repo: string,
  args: string[],
  maxOutputBytes = MAX_GIT_OUTPUT,
): string | null {
  const result = runGit(deps, repo, args, maxOutputBytes);
  return result?.status === 0 ? result.stdout.toString('utf8').trim() : null;
}

function ghApi(endpoint: string, pin: TrustedExecutablePin, candidateRoot: string): unknown | null {
  try {
    if (!verifyTrustedGithubCli(pin, [candidateRoot])) return null;
    const result = spawnSync(pin.executable, ['api', endpoint], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: trustedGithubEnvironment(),
      maxBuffer: MAX_GH_OUTPUT,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
    });
    if (!verifyTrustedGithubCli(pin, [candidateRoot])) return null;
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' ||
        Buffer.byteLength(result.stdout, 'utf8') > MAX_GH_OUTPUT) return null;
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function parseCandidateAdmissionTrustedPolicy(value: unknown): CandidateAdmissionTrustedPolicy | null {
  const raw = objectRecord(value);
  if (!raw || !exactKeys(raw, [
    'attestationCheck', 'evidenceFutureSkewMs', 'evidenceMaxAgeMs', 'schemaVersion', 'trustedAppIds',
  ]) || raw['schemaVersion'] !== 2 || !Array.isArray(raw['trustedAppIds'])) return null;
  const ids = raw['trustedAppIds'].map((item) => {
    if (typeof item === 'number' && Number.isSafeInteger(item) && item > 0) return String(item);
    return typeof item === 'string' ? item : '';
  });
  if (ids.length === 0 || ids.length > MAX_TRUSTED_APP_IDS || ids.some((id) => !APP_ID_RE.test(id)) ||
      new Set(ids).size !== ids.length) return null;
  const attestationCheck = boundedString(raw['attestationCheck'], 256);
  if (!attestationCheck || attestationCheck.trim() !== attestationCheck) return null;
  const evidenceMaxAgeMs = raw['evidenceMaxAgeMs'];
  const evidenceFutureSkewMs = raw['evidenceFutureSkewMs'];
  if (!Number.isSafeInteger(evidenceMaxAgeMs) || Number(evidenceMaxAgeMs) < MIN_EVIDENCE_MAX_AGE_MS ||
      Number(evidenceMaxAgeMs) > MAX_EVIDENCE_MAX_AGE_MS || !Number.isSafeInteger(evidenceFutureSkewMs) ||
      Number(evidenceFutureSkewMs) < 0 || Number(evidenceFutureSkewMs) > MAX_EVIDENCE_FUTURE_SKEW_MS ||
      Number(evidenceFutureSkewMs) >= Number(evidenceMaxAgeMs)) return null;
  const trustedAppIds = [...ids].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const digest = createHash('sha256').update(JSON.stringify([
    'ashlr:candidate-admission-trusted-policy:v2',
    2,
    trustedAppIds,
    attestationCheck,
    evidenceMaxAgeMs,
    evidenceFutureSkewMs,
  ])).digest('hex');
  return {
    schemaVersion: 2,
    trustedAppIds,
    attestationCheck,
    evidenceMaxAgeMs: Number(evidenceMaxAgeMs),
    evidenceFutureSkewMs: Number(evidenceFutureSkewMs),
    evaluatorVersion: CANDIDATE_ADMISSION_EVALUATOR_VERSION,
    digest,
  };
}

export function candidateAdmissionAuthorityPath(): string {
  return join(userInfo().homedir, '.ashlr', 'control', CANDIDATE_ADMISSION_AUTHORITY_FILE);
}

type AuthorityStat = ReturnType<typeof fstatSync> & {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function sameAuthorityIdentity(left: AuthorityStat, right: AuthorityStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameAuthoritySnapshot(left: AuthorityStat, right: AuthorityStat): boolean {
  return sameAuthorityIdentity(left, right) && left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function safeAuthorityStat(stat: AuthorityStat): boolean {
  return stat.isFile() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(MAX_AUTHORITY_FILE_BYTES) &&
    (process.platform === 'win32' || typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o077n) === 0n);
}

function readExactAuthorityBytes(fd: number, size: number): Buffer | null {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) return null;
    offset += count;
  }
  return bytes;
}

function authorityFailure(
  state: Exclude<CandidateTrustedPolicyAuthorityRead['state'], 'verified'>,
  path: string,
  detail: string,
): CandidateTrustedPolicyAuthorityRead {
  return { state, path, value: null, proof: null, detail };
}

function authorityProof(custodyDigest: string, stat: AuthorityStat, bytes: Buffer): string {
  return createHash('sha256').update(JSON.stringify([
    custodyDigest,
    stat.dev.toString(),
    stat.ino.toString(),
    stat.mode.toString(),
    stat.uid.toString(),
    stat.gid.toString(),
    stat.nlink.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
    createHash('sha256').update(bytes).digest('hex'),
  ])).digest('hex');
}

/** Read the fixed operator authority file without following or trusting its path name. */
export function readCandidateAdmissionTrustedPolicyAuthority(
  path = candidateAdmissionAuthorityPath(),
  hooks: CandidateAuthorityReadHooks = {},
): CandidateTrustedPolicyAuthorityRead {
  let namedBefore: AuthorityStat;
  try {
    namedBefore = lstatSync(path, { bigint: true }) as AuthorityStat;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? authorityFailure('missing', path, 'operator authority file is absent')
      : authorityFailure('unreadable', path, 'operator authority file cannot be inspected');
  }
  const authorityAnchor = hooks.authorityAnchorPath ?? userInfo().homedir;
  const custodyBefore = inspectOwnedAuthorityPath(path, authorityAnchor);
  if (!custodyBefore || namedBefore.isSymbolicLink() || !safeAuthorityStat(namedBefore)) {
    return authorityFailure('unsafe', path, 'authority path must have a symlink-free, owner/root-owned, non-writable hierarchy and a bounded owner-only regular leaf with no unsafe ACL grants');
  }

  let fd: number | null = null;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true }) as AuthorityStat;
    if (!safeAuthorityStat(opened) || !sameAuthoritySnapshot(namedBefore, opened)) {
      return authorityFailure('unstable', path, 'authority file identity changed while opening');
    }
    hooks.afterOpen?.();
    const first = readExactAuthorityBytes(fd, Number(opened.size));
    hooks.afterFirstRead?.();
    const between = fstatSync(fd, { bigint: true }) as AuthorityStat;
    const second = readExactAuthorityBytes(fd, Number(opened.size));
    const after = fstatSync(fd, { bigint: true }) as AuthorityStat;
    const namedAfter = lstatSync(path, { bigint: true }) as AuthorityStat;
    const custodyAfter = inspectOwnedAuthorityPath(path, authorityAnchor);
    if (!first || !second || !first.equals(second) || !safeAuthorityStat(between) ||
        !safeAuthorityStat(after) || !safeAuthorityStat(namedAfter) ||
        !sameAuthoritySnapshot(opened, between) || !sameAuthoritySnapshot(between, after) ||
        !sameAuthoritySnapshot(after, namedAfter) || !custodyAfter ||
        custodyAfter.canonicalPath !== custodyBefore.canonicalPath || custodyAfter.digest !== custodyBefore.digest) {
      return authorityFailure('unstable', path, 'authority hierarchy, file identity, metadata, or bytes changed during the bounded read');
    }
    try {
      return {
        state: 'verified',
        path,
        value: JSON.parse(first.toString('utf8')) as unknown,
        proof: authorityProof(custodyAfter.digest, after, first),
        detail: 'owner-only authority file and every parent passed ACL-aware identity-stable double-read custody',
      };
    } catch {
      return authorityFailure('unreadable', path, 'authority file is not valid JSON');
    }
  } catch {
    return authorityFailure('unreadable', path, 'authority file could not be opened or read without following links');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readDefaultTrustedPolicy(): CandidateTrustedPolicyAuthorityRead {
  return readCandidateAdmissionTrustedPolicyAuthority();
}

function trustedPolicyEvidence(
  policy: CandidateAdmissionTrustedPolicy | null,
  authority: CandidateTrustedPolicyAuthorityRead,
): CandidateAdmissionTrustedPolicyEvidence {
  return policy ? {
    available: true,
    schemaVersion: policy.schemaVersion,
    trustedAppIds: [...policy.trustedAppIds],
    attestationCheck: policy.attestationCheck,
    authorityFile: authority.path,
    custodyState: authority.state,
    evidenceMaxAgeMs: policy.evidenceMaxAgeMs,
    evidenceFutureSkewMs: policy.evidenceFutureSkewMs,
    evaluatorVersion: policy.evaluatorVersion,
    digest: policy.digest,
    detail: `${policy.trustedAppIds.length} operator-pinned GitHub App signer(s) under ${policy.evaluatorVersion}`,
  } : {
    available: false,
    schemaVersion: null,
    trustedAppIds: [],
    attestationCheck: null,
    authorityFile: authority.path,
    custodyState: authority.state,
    evidenceMaxAgeMs: null,
    evidenceFutureSkewMs: null,
    evaluatorVersion: CANDIDATE_ADMISSION_EVALUATOR_VERSION,
    digest: null,
    detail: authority.state === 'verified'
      ? 'operator-pinned candidate admission signer policy is malformed'
      : authority.detail,
  };
}

function boundedString(value: unknown, max = 8_192): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function safeRef(value: string): boolean {
  if (value.length === 0 || value.length > 256 || /[~^:?*\\]/.test(value)) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

function defaultRemoteHead(
  nameWithOwner: string,
  candidateRoot: string,
  trustedGithubCli: TrustedExecutablePin | null,
): CandidateRemoteHeadEvidence {
  if (!trustedGithubCli || !verifyTrustedGithubCli(trustedGithubCli, [candidateRoot])) {
    return { available: false, nameWithOwner: null, defaultBranch: null, head: null, detail: 'trusted GitHub executable custody is unavailable' };
  }
  const repo = objectRecord(ghApi(`repos/${nameWithOwner}`, trustedGithubCli, candidateRoot));
  const fullName = boundedString(repo?.['full_name'], 512);
  const branch = boundedString(repo?.['default_branch'], 256);
  if (!fullName || fullName.toLowerCase() !== nameWithOwner.toLowerCase() || !branch || !safeRef(branch)) {
    return { available: false, nameWithOwner: null, defaultBranch: null, head: null, detail: 'GitHub repository identity is unavailable' };
  }
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  const ref = objectRecord(ghApi(`repos/${nameWithOwner}/git/ref/heads/${encodedBranch}`, trustedGithubCli, candidateRoot));
  const object = objectRecord(ref?.['object']);
  const head = boundedString(object?.['sha'], 64);
  if (!head || !SHA1_RE.test(head)) {
    return { available: false, nameWithOwner: fullName, defaultBranch: branch, head: null, detail: 'GitHub default-branch head is unavailable' };
  }
  return {
    available: true,
    nameWithOwner: fullName,
    defaultBranch: branch,
    head: head.toLowerCase(),
    detail: `live GitHub ${branch} head is ${head.slice(0, 12)}`,
  };
}

function emptyCheckRun(detail: string): CandidateCheckRunEvidence {
  return {
    available: false,
    ready: false,
    workflow: null,
    workflowRunId: null,
    workflowRunNumber: null,
    workflowRunAttempt: null,
    check: null,
    workflowJobId: null,
    workflowCheckRunId: null,
    workflowAppId: null,
    attestationCheck: null,
    attestationCheckRunId: null,
    appId: null,
    head: null,
    status: null,
    conclusion: null,
    externalIdMatched: false,
    trustedPolicyDigest: null,
    evaluatorVersion: null,
    workflowCreatedAt: null,
    workflowStartedAt: null,
    workflowCompletedAt: null,
    jobStartedAt: null,
    jobCompletedAt: null,
    workflowCheckStartedAt: null,
    workflowCheckCompletedAt: null,
    attestationStartedAt: null,
    attestationCompletedAt: null,
    fresh: false,
    authorityDigest: null,
    detail,
  };
}

function idString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && APP_ID_RE.test(value)) return value;
  return null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function strictTimestamp(value: unknown): { value: string; time: number } | null {
  if (typeof value !== 'string' || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = new Date(time).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) return null;
  return { value, time };
}

type StrictTimestamp = NonNullable<ReturnType<typeof strictTimestamp>>;

interface CandidateEvidenceTimes {
  workflowCreatedAt: { value: string; time: number };
  workflowStartedAt: { value: string; time: number };
  workflowCompletedAt: { value: string; time: number };
  jobStartedAt: { value: string; time: number };
  jobCompletedAt: { value: string; time: number };
  workflowCheckStartedAt: { value: string; time: number };
  workflowCheckCompletedAt: { value: string; time: number };
  attestationStartedAt: { value: string; time: number };
  attestationCompletedAt: { value: string; time: number };
}

function evidenceTimes(
  workflowRun: Record<string, unknown>,
  job: Record<string, unknown>,
  workflowCheckRun: Record<string, unknown>,
  attestationCheckRun: Record<string, unknown>,
  request: CandidateCheckRunRequest,
): CandidateEvidenceTimes | null {
  const workflowCreatedAt = strictTimestamp(workflowRun['created_at']);
  const workflowStartedAt = strictTimestamp(workflowRun['run_started_at']);
  const workflowCompletedAt = strictTimestamp(workflowRun['updated_at']);
  const jobStartedAt = strictTimestamp(job['started_at']);
  const jobCompletedAt = strictTimestamp(job['completed_at']);
  const workflowCheckStartedAt = strictTimestamp(workflowCheckRun['started_at']);
  const workflowCheckCompletedAt = strictTimestamp(workflowCheckRun['completed_at']);
  const attestationStartedAt = strictTimestamp(attestationCheckRun['started_at']);
  const attestationCompletedAt = strictTimestamp(attestationCheckRun['completed_at']);
  if (!workflowCreatedAt || !workflowStartedAt || !workflowCompletedAt || !jobStartedAt ||
      !jobCompletedAt || !workflowCheckStartedAt || !workflowCheckCompletedAt ||
      !attestationStartedAt || !attestationCompletedAt) return null;
  const parsed: CandidateEvidenceTimes = {
    workflowCreatedAt,
    workflowStartedAt,
    workflowCompletedAt,
    jobStartedAt,
    jobCompletedAt,
    workflowCheckStartedAt,
    workflowCheckCompletedAt,
    attestationStartedAt,
    attestationCompletedAt,
  };
  const now = strictTimestamp(request.evaluatedAt)?.time;
  if (now === undefined) return null;
  const minimum = now - request.evidenceMaxAgeMs;
  const maximum = now + request.evidenceFutureSkewMs;
  if (Object.values(parsed).some((item) => item.time < minimum || item.time > maximum)) return null;
  const { workflowCreatedAt: wc, workflowStartedAt: ws, workflowCompletedAt: wd,
    jobStartedAt: js, jobCompletedAt: jd, workflowCheckStartedAt: cs,
    workflowCheckCompletedAt: cd, attestationStartedAt: ats, attestationCompletedAt: atd } = parsed;
  if (!(wc.time <= ws.time && ws.time <= js.time && js.time <= jd.time && jd.time <= wd.time &&
      ws.time <= cs.time && cs.time <= cd.time && cd.time <= wd.time &&
      js.time <= cd.time && cs.time <= jd.time && wd.time <= ats.time && ats.time <= atd.time)) return null;
  return parsed;
}

function checkRunIdFromUrl(value: unknown, nameWithOwner: string): string | null {
  const url = boundedString(value, 2_048);
  try {
    const parsed = url ? new URL(url) : null;
    const expected = `/repos/${nameWithOwner.toLowerCase()}/check-runs/`;
    if (parsed?.protocol !== 'https:' || parsed.hostname !== 'api.github.com' || parsed.username !== '' ||
        parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' ||
        !parsed.pathname.toLowerCase().startsWith(expected)) return null;
    const id = parsed.pathname.slice(expected.length);
    return APP_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function exactCollectionPage(
  value: unknown,
  key: string,
): { total: number; rows: Record<string, unknown>[] } | null {
  const root = objectRecord(value);
  const rows = root?.[key];
  const total = root?.['total_count'];
  if (!Array.isArray(rows) || rows.length > GITHUB_COLLECTION_PAGE_SIZE || !Number.isSafeInteger(total) ||
      Number(total) < rows.length || Number(total) > MAX_GITHUB_COLLECTION_ITEMS) return null;
  const parsed = rows.map(objectRecord);
  return parsed.every((row) => row !== null)
    ? { total: Number(total), rows: parsed as Record<string, unknown>[] }
    : null;
}

function paginatedEndpoint(endpoint: string, page: number): string | null {
  const separator = endpoint.indexOf('?');
  const base = separator < 0 ? endpoint : endpoint.slice(0, separator);
  if (!base || base.includes('#')) return null;
  const query = new URLSearchParams(separator < 0 ? '' : endpoint.slice(separator + 1));
  query.set('per_page', String(GITHUB_COLLECTION_PAGE_SIZE));
  query.set('page', String(page));
  return `${base}?${query.toString()}`;
}

function canonicalAuthorityDigest(value: unknown): string | null {
  let nodes = 0;
  const normalize = (item: unknown, depth: number): unknown | undefined => {
    nodes++;
    if (nodes > 200_000 || depth > 32) return undefined;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : undefined;
    if (Array.isArray(item)) {
      const values: unknown[] = [];
      for (const entry of item) {
        const normalized = normalize(entry, depth + 1);
        if (normalized === undefined) return undefined;
        values.push(normalized);
      }
      return values;
    }
    const record = objectRecord(item);
    if (!record) return undefined;
    const keys = Object.keys(record).sort();
    if (keys.length > 1_000) return undefined;
    const normalized: Record<string, unknown> = {};
    for (const key of keys) {
      if (record[key] === undefined) continue;
      const entry = normalize(record[key], depth + 1);
      if (entry === undefined) return undefined;
      normalized[key] = entry;
    }
    return normalized;
  };
  try {
    const normalized = normalize(value, 0);
    if (normalized === undefined) return null;
    const bytes = JSON.stringify(normalized);
    if (Buffer.byteLength(bytes, 'utf8') > 16 * 1024 * 1024) return null;
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

/** Collect every page twice and reject shifting totals, identities, ordering, or bytes. */
function stablePaginatedCollection(
  api: CandidateGithubApiReader,
  endpoint: string,
  key: string,
): Record<string, unknown>[] | null {
  const collect = (): { total: number; rows: Record<string, unknown>[] } | null => {
    const firstEndpoint = paginatedEndpoint(endpoint, 1);
    if (!firstEndpoint) return null;
    const first = exactCollectionPage(api(firstEndpoint), key);
    if (!first) return null;
    const pageCount = Math.max(1, Math.ceil(first.total / GITHUB_COLLECTION_PAGE_SIZE));
    const rows = [...first.rows];
    for (let page = 2; page <= pageCount; page += 1) {
      const pageEndpoint = paginatedEndpoint(endpoint, page);
      const current = pageEndpoint ? exactCollectionPage(api(pageEndpoint), key) : null;
      const expectedLength = Math.min(
        GITHUB_COLLECTION_PAGE_SIZE,
        first.total - ((page - 1) * GITHUB_COLLECTION_PAGE_SIZE),
      );
      if (!current || current.total !== first.total || current.rows.length !== expectedLength) return null;
      rows.push(...current.rows);
    }
    const sentinelEndpoint = paginatedEndpoint(endpoint, pageCount + 1);
    const sentinel = sentinelEndpoint ? exactCollectionPage(api(sentinelEndpoint), key) : null;
    if (!sentinel || sentinel.total !== first.total || sentinel.rows.length !== 0 || rows.length !== first.total) {
      return null;
    }
    const ids = rows.map((row) => idString(row['id']));
    if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) return null;
    return { total: first.total, rows };
  };
  const before = collect();
  const after = collect();
  return before && after && canonicalAuthorityDigest(before) !== null &&
    canonicalAuthorityDigest(before) === canonicalAuthorityDigest(after)
    ? after.rows
    : null;
}

interface WorkflowRunCandidate {
  run: Record<string, unknown>;
  id: string;
  number: number;
  attempt: number;
  created: StrictTimestamp;
  started: StrictTimestamp;
  updated: StrictTimestamp;
}

function orderedWorkflowRuns(
  rows: readonly Record<string, unknown>[],
  request: CandidateCheckRunRequest,
): { latest: WorkflowRunCandidate; all: WorkflowRunCandidate[] } | null {
  const pathMatches = (value: unknown): boolean => {
    if (value === request.workflow) return true;
    if (typeof value !== 'string' || !value.startsWith(`${request.workflow}@`)) return false;
    const sourceRef = value.slice(request.workflow.length + 1);
    return safeRef(sourceRef);
  };
  if (rows.length === 0 || rows.some((run) => !pathMatches(run['path']) ||
    boundedString(run['head_sha'], 64)?.toLowerCase() !== request.head.toLowerCase() ||
    run['head_branch'] !== request.branch)) return null;
  const matching = rows;
  const candidates = matching.map((run) => ({
    run,
    id: idString(run['id']),
    number: positiveInteger(run['run_number']),
    attempt: positiveInteger(run['run_attempt']),
    created: strictTimestamp(run['created_at']),
    started: strictTimestamp(run['run_started_at']),
    updated: strictTimestamp(run['updated_at']),
  }));
  if (candidates.some((row) => !row.id || row.number === null || row.attempt === null ||
      !row.created || !row.started || !row.updated ||
      row.created.time > row.started.time || row.started.time > row.updated.time)) return null;
  const parsed = candidates as WorkflowRunCandidate[];
  if (new Set(parsed.map((row) => row.id)).size !== parsed.length ||
      new Set(parsed.map((row) => `${row.number}\0${row.attempt}`)).size !== parsed.length) return null;
  parsed.sort((left, right) => right.started.time - left.started.time ||
    right.created.time - left.created.time || right.updated.time - left.updated.time);
  const first = parsed[0]!;
  if (parsed.length > 1 && parsed[1]!.started.time === first.started.time) return null;
  return { latest: first, all: parsed };
}

function latestAttestationCheck(
  rows: readonly Record<string, unknown>[],
): { run: Record<string, unknown>; id: string } | null {
  if (rows.length === 0) return null;
  const candidates = rows.map((run) => ({
    run,
    id: idString(run['id']),
    started: strictTimestamp(run['started_at']),
  }));
  if (candidates.some((row) => !row.id || !row.started) ||
      new Set(candidates.map((row) => row.id)).size !== candidates.length) return null;
  candidates.sort((left, right) => right.started!.time - left.started!.time);
  if (candidates.length > 1 && candidates[0]!.started!.time === candidates[1]!.started!.time) return null;
  return { run: candidates[0]!.run, id: candidates[0]!.id! };
}

export type CandidateGithubApiReader = (endpoint: string) => unknown | null;

export function readCandidateCheckRunEvidence(
  request: CandidateCheckRunRequest,
  injectedApi?: CandidateGithubApiReader,
): CandidateCheckRunEvidence {
  if (!isAbsolute(request.candidateRoot) || request.candidateRoot.length > 4_096 || request.candidateRoot.includes('\0') ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(request.nameWithOwner) ||
      !safeRef(request.branch) || !SHA1_RE.test(request.head) ||
      !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(request.workflow) ||
      request.check.trim() !== request.check || request.check.length === 0 || request.check.length > 256 ||
      !APP_ID_RE.test(request.workflowAppId) || request.attestationCheck.trim() !== request.attestationCheck ||
      request.attestationCheck.length === 0 || request.attestationCheck.length > 256 ||
      !Array.isArray(request.expectedAttestations) || request.expectedAttestations.length === 0 ||
      request.expectedAttestations.length > MAX_TRUSTED_APP_IDS ||
      request.expectedAttestations.some((item) => !APP_ID_RE.test(item.appId) ||
        item.appId === request.workflowAppId || !/^ashlr-admission-v6:[0-9a-f]{64}$/.test(item.externalId)) ||
      new Set(request.expectedAttestations.map((item) => item.appId)).size !== request.expectedAttestations.length ||
      new Set(request.expectedAttestations.map((item) => item.externalId)).size !== request.expectedAttestations.length ||
      !SHA256_RE.test(request.trustedPolicyDigest) ||
      request.evaluatorVersion !== CANDIDATE_ADMISSION_EVALUATOR_VERSION || !strictTimestamp(request.evaluatedAt) ||
      !Number.isSafeInteger(request.evidenceMaxAgeMs) || request.evidenceMaxAgeMs < MIN_EVIDENCE_MAX_AGE_MS ||
      request.evidenceMaxAgeMs > MAX_EVIDENCE_MAX_AGE_MS || !Number.isSafeInteger(request.evidenceFutureSkewMs) ||
      request.evidenceFutureSkewMs < 0 || request.evidenceFutureSkewMs > MAX_EVIDENCE_FUTURE_SKEW_MS ||
      request.evidenceFutureSkewMs >= request.evidenceMaxAgeMs) {
    return emptyCheckRun('check-run request is malformed');
  }
  const trustedGithubCli = injectedApi ? null : request.trustedGithubCli ?? resolveTrustedGithubCli([request.candidateRoot]);
  if (!injectedApi && !trustedGithubCli) return emptyCheckRun('trusted GitHub executable custody is unavailable');
  if (!injectedApi && !verifyTrustedGithubCli(trustedGithubCli!, [request.candidateRoot])) {
    return emptyCheckRun('trusted GitHub executable custody changed before check collection');
  }
  const api = injectedApi ?? ((endpoint: string) => ghApi(endpoint, trustedGithubCli!, request.candidateRoot));
  const authorityRecords: unknown[] = [];
  const collectAuthority = (endpoint: string, key: string): Record<string, unknown>[] | null => {
    const rows = stablePaginatedCollection(api, endpoint, key);
    if (rows) authorityRecords.push({ endpoint, key, rows });
    return rows;
  };
  const query = new URLSearchParams({
    branch: request.branch,
    head_sha: request.head,
    per_page: '100',
  });
  const workflowEndpoint = `repos/${request.nameWithOwner}/actions/workflows/${encodeURIComponent(basename(request.workflow))}/runs?${query.toString()}`;
  const runs = collectAuthority(workflowEndpoint, 'workflow_runs');
  if (!runs) return emptyCheckRun('complete exact-head workflow run history is unavailable');
  const orderedRuns = orderedWorkflowRuns(runs, request);
  if (!orderedRuns) return emptyCheckRun('latest exact-head workflow execution is missing, malformed, or chronologically ambiguous');
  const latestWorkflow = orderedRuns.latest;
  const workflowRun = latestWorkflow.run;
  if (workflowRun['status'] !== 'completed' || workflowRun['conclusion'] !== 'success') {
    return { ...emptyCheckRun('latest exact-head workflow execution is not successful'), available: true,
      workflow: request.workflow, workflowRunId: latestWorkflow.id,
      workflowRunNumber: latestWorkflow.number, workflowRunAttempt: latestWorkflow.attempt,
      status: boundedString(workflowRun['status'], 64), conclusion: boundedString(workflowRun['conclusion'], 64) };
  }

  const declaredCheckRuns = new Map<string, { runId: string; attempt: number; jobId: string }>();
  let selectedJob: Record<string, unknown> | null = null;
  let observedAttempts = 0;
  for (const run of orderedRuns.all) {
    for (let attempt = 1; attempt <= run.attempt; attempt += 1) {
      observedAttempts++;
      if (observedAttempts > MAX_WORKFLOW_ATTEMPTS) {
        return emptyCheckRun('complete bounded workflow attempt history exceeds the admission evidence cap');
      }
      const jobsEndpoint = `repos/${request.nameWithOwner}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`;
      const jobs = collectAuthority(jobsEndpoint, 'jobs');
      if (!jobs || jobs.some((item) => idString(item['run_id']) !== run.id ||
        boundedString(item['head_sha'], 64)?.toLowerCase() !== request.head.toLowerCase() ||
        (item['run_attempt'] !== undefined && positiveInteger(item['run_attempt']) !== attempt))) {
        return emptyCheckRun('complete workflow-attempt job evidence is unavailable or malformed');
      }
      const matchingJobs = jobs.filter((item) => item['name'] === request.check);
      if (matchingJobs.length > 1) return emptyCheckRun('workflow attempt has ambiguous declared job evidence');
      const matching = matchingJobs[0];
      if (!matching) continue;
      const jobId = idString(matching['id']);
      const checkRunId = checkRunIdFromUrl(matching['check_run_url'], request.nameWithOwner);
      if (!jobId || !checkRunId || declaredCheckRuns.has(checkRunId)) {
        return emptyCheckRun('workflow-attempt job/check identity is missing or duplicated');
      }
      declaredCheckRuns.set(checkRunId, { runId: run.id, attempt, jobId });
      if (run.id === latestWorkflow.id && attempt === latestWorkflow.attempt) selectedJob = matching;
    }
  }
  if (!selectedJob) return emptyCheckRun('latest workflow attempt has missing declared job evidence');
  const job = selectedJob;
  const workflowJobId = idString(job['id']);
  const workflowCheckRunId = checkRunIdFromUrl(job['check_run_url'], request.nameWithOwner);
  if (!workflowJobId || !workflowCheckRunId || job['status'] !== 'completed' || job['conclusion'] !== 'success') {
    return { ...emptyCheckRun('latest declared workflow job is missing, pending, or unsuccessful'), available: true,
      workflow: request.workflow, workflowRunId: latestWorkflow.id,
      workflowRunNumber: latestWorkflow.number, workflowRunAttempt: latestWorkflow.attempt,
      check: request.check, workflowJobId };
  }
  const workflowCheckRun = objectRecord(api(`repos/${request.nameWithOwner}/check-runs/${workflowCheckRunId}`));
  if (workflowCheckRun) authorityRecords.push({
    endpoint: `repos/${request.nameWithOwner}/check-runs/${workflowCheckRunId}`,
    value: workflowCheckRun,
  });
  const workflowAppId = idString(objectRecord(workflowCheckRun?.['app'])?.['id']);
  if (!workflowCheckRun || workflowCheckRun['name'] !== request.check || workflowAppId !== request.workflowAppId ||
      boundedString(workflowCheckRun['head_sha'], 64)?.toLowerCase() !== request.head.toLowerCase() ||
      workflowCheckRun['status'] !== 'completed' || workflowCheckRun['conclusion'] !== 'success') {
    return { ...emptyCheckRun('workflow job check does not match its protected required-check App and exact head'), available: true,
      workflow: request.workflow, workflowRunId: latestWorkflow.id,
      workflowRunNumber: latestWorkflow.number, workflowRunAttempt: latestWorkflow.attempt,
      check: request.check, workflowJobId, workflowCheckRunId, workflowAppId };
  }

  const workflowCheckQuery = new URLSearchParams({
    app_id: request.workflowAppId,
    check_name: request.check,
    filter: 'all',
    per_page: '100',
  });
  const workflowCheckRows = collectAuthority(
    `repos/${request.nameWithOwner}/commits/${request.head}/check-runs?${workflowCheckQuery.toString()}`,
    'check_runs',
  );
  if (!workflowCheckRows) return emptyCheckRun('complete exact-head workflow check context history is unavailable');
  const listedWorkflowCheckIds = workflowCheckRows.map((row) => idString(row['id']));
  if (listedWorkflowCheckIds.some((id) => id === null) ||
      new Set(listedWorkflowCheckIds).size !== listedWorkflowCheckIds.length ||
      workflowCheckRows.some((row) => row['name'] !== request.check ||
        boundedString(row['head_sha'], 64)?.toLowerCase() !== request.head.toLowerCase() ||
        idString(objectRecord(row['app'])?.['id']) !== request.workflowAppId) ||
      listedWorkflowCheckIds.length !== declaredCheckRuns.size ||
      listedWorkflowCheckIds.some((id) => !declaredCheckRuns.has(id!)) ||
      [...declaredCheckRuns.keys()].some((id) => !listedWorkflowCheckIds.includes(id)) ||
      !listedWorkflowCheckIds.includes(workflowCheckRunId)) {
    return emptyCheckRun('required workflow context/App has duplicate, cross-workflow, or uncorrelated exact-head check evidence');
  }
  const selectedListedCheck = workflowCheckRows.find((row) => idString(row['id']) === workflowCheckRunId)!;
  if (selectedListedCheck['status'] !== workflowCheckRun['status'] ||
      selectedListedCheck['conclusion'] !== workflowCheckRun['conclusion']) {
    return emptyCheckRun('selected workflow check changed during exact-head context enumeration');
  }

  const attestationRuns: Record<string, unknown>[] = [];
  for (const expected of request.expectedAttestations) {
    const checkQuery = new URLSearchParams({
      app_id: expected.appId,
      check_name: request.attestationCheck,
      filter: 'all',
      per_page: '100',
    });
    const rows = collectAuthority(
      `repos/${request.nameWithOwner}/commits/${request.head}/check-runs?${checkQuery.toString()}`,
      'check_runs',
    );
    if (!rows) return emptyCheckRun('complete trusted-App attestation check history is unavailable');
    if (rows.some((row) => row['name'] !== request.attestationCheck ||
      boundedString(row['head_sha'], 64)?.toLowerCase() !== request.head.toLowerCase() ||
      idString(objectRecord(row['app'])?.['id']) !== expected.appId)) {
      return emptyCheckRun('trusted-App attestation query returned malformed or ambiguous exact-head evidence');
    }
    attestationRuns.push(...rows);
  }
  const latestAttestation = latestAttestationCheck(attestationRuns);
  if (!latestAttestation) return emptyCheckRun('latest trusted-App exact-head attestation check is missing or ambiguous');
  const attestationCheckRun = latestAttestation.run;
  const appId = idString(objectRecord(attestationCheckRun['app'])?.['id']);
  const expectedExternalId = request.expectedAttestations.find((item) => item.appId === appId)?.externalId ?? null;
  const head = boundedString(attestationCheckRun['head_sha'], 64)?.toLowerCase() ?? null;
  const status = boundedString(attestationCheckRun['status'], 64);
  const conclusion = boundedString(attestationCheckRun['conclusion'], 64);
  const externalId = boundedString(attestationCheckRun['external_id'], 512);
  const times = evidenceTimes(workflowRun, job, workflowCheckRun, attestationCheckRun, request);
  const authorityDigest = canonicalAuthorityDigest([
    'ashlr:candidate-admission-correlated-authority:v1',
    request.nameWithOwner.toLowerCase(),
    request.branch,
    request.head.toLowerCase(),
    request.workflow,
    request.check,
    request.workflowAppId,
    request.attestationCheck,
    request.expectedAttestations,
    authorityRecords,
  ]);
  const ready = appId !== null && expectedExternalId !== null && head === request.head.toLowerCase() &&
    status === 'completed' && conclusion === 'success' && externalId === expectedExternalId && times !== null &&
    authorityDigest !== null;
  return {
    available: true,
    ready,
    workflow: request.workflow,
    workflowRunId: latestWorkflow.id,
    workflowRunNumber: latestWorkflow.number,
    workflowRunAttempt: latestWorkflow.attempt,
    check: request.check,
    workflowJobId,
    workflowCheckRunId,
    workflowAppId,
    attestationCheck: request.attestationCheck,
    attestationCheckRunId: latestAttestation.id,
    appId,
    head,
    status,
    conclusion,
    externalIdMatched: externalId === expectedExternalId,
    trustedPolicyDigest: request.trustedPolicyDigest,
    evaluatorVersion: request.evaluatorVersion,
    workflowCreatedAt: times?.workflowCreatedAt.value ?? null,
    workflowStartedAt: times?.workflowStartedAt.value ?? null,
    workflowCompletedAt: times?.workflowCompletedAt.value ?? null,
    jobStartedAt: times?.jobStartedAt.value ?? null,
    jobCompletedAt: times?.jobCompletedAt.value ?? null,
    workflowCheckStartedAt: times?.workflowCheckStartedAt.value ?? null,
    workflowCheckCompletedAt: times?.workflowCheckCompletedAt.value ?? null,
    attestationStartedAt: times?.attestationStartedAt.value ?? null,
    attestationCompletedAt: times?.attestationCompletedAt.value ?? null,
    fresh: times !== null,
    authorityDigest,
    detail: ready
      ? 'latest successful Actions workflow attempt and independent trusted-App exact-head check carry the whole-snapshot admission attestation'
      : times === null
        ? 'workflow, job, and check timestamps are missing, invalid, future-skewed, inconsistent, or expired'
        : 'latest evidence does not bind the workflow attempt, required-check App, trusted attestor App, exact head, evaluator, and external admission attestation',
  };
}

const DEFAULT_DEPS: CandidateRepoAdmissionDeps = {
  now: () => new Date(),
  canonicalPath: canonicalEnrollmentPath,
  readEnrollment: readEnrollmentRegistry,
  git: defaultGitRunner,
  readRemoteHead: defaultRemoteHead,
  readProtection: readBranchProtectionAttestation,
  readCheckRun: readCandidateCheckRunEvidence,
  readTrustedPolicy: readDefaultTrustedPolicy,
  resolveGitCli: resolveTrustedGitCli,
  verifyGitCli: verifyTrustedGitCli,
  resolveGithubCli: resolveTrustedGithubCli,
  verifyGithubCli: verifyTrustedGithubCli,
  evaluateSafeMinimum: evaluateSafeMinimumProtectedRemotePolicyV1,
  buildPolicyDigest: buildCanonicalProtectedRemotePolicyDigestV1,
};

function parseNulList(value: Buffer | null, maxEntries: number): string[] | null {
  if (!value) return null;
  if (value.length === 0) return [];
  const parts = value.toString('utf8').split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts.length <= maxEntries && parts.every((entry) => entry.length > 0) ? parts : null;
}

function parseConfig(value: Buffer): Map<string, string[]> | null {
  const entries = parseNulList(value, MAX_CONFIG_ENTRIES);
  if (!entries) return null;
  const config = new Map<string, string[]>();
  for (const entry of entries) {
    const newline = entry.indexOf('\n');
    if (newline <= 0) return null;
    const key = entry.slice(0, newline).toLowerCase();
    const value = entry.slice(newline + 1);
    const values = config.get(key) ?? [];
    values.push(value);
    config.set(key, values);
  }
  return config;
}

function unsafeConfigKey(key: string): boolean {
  return key === 'include.path' || key.startsWith('includeif.') || key === 'core.fsmonitor' ||
    key === 'core.hookspath' || key === 'core.sshcommand' || key === 'core.gitproxy' ||
    key === 'core.alternaterefscommand' || key === 'core.worktree' ||
    key === 'core.splitindex' || key === 'extensions.worktreeconfig' ||
    key === 'credential.helper' || /^credential\..+\.helper$/.test(key) ||
    key.startsWith('alias.') || key.startsWith('url.') || key.startsWith('protocol.') ||
    /^filter\..+\.(?:clean|smudge|process|required)$/.test(key) ||
    /^diff\..+\.(?:command|textconv)$/.test(key) || /^merge\..+\.driver$/.test(key) ||
    /^remote\..+\.(?:vcs|uploadpack|receivepack)$/.test(key);
}

function canonicalGitHubRemote(value: string): { nameWithOwner: string; canonicalUrl: string } | null {
  const match = value.match(/^https:\/\/github\.com\/([^/?#@]+)\/([^/?#@]+?)(?:\.git)?$/i) ??
    value.match(/^git@github\.com:([^/?#:]+)\/([^/?#]+?)(?:\.git)?$/i) ??
    value.match(/^ssh:\/\/git@github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?$/i);
  if (!match?.[1] || !match[2]) return null;
  const owner = match[1];
  const repo = match[2];
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
  return {
    nameWithOwner: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
    canonicalUrl: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}.git`,
  };
}

function auditConfig(config: Map<string, string[]>): { safe: boolean; reason: string; origin: { nameWithOwner: string } | null } {
  const unsafe = [...config.keys()].find(unsafeConfigKey);
  if (unsafe) return { safe: false, reason: `effectful local Git configuration is prohibited (${unsafe})`, origin: null };
  const remoteEntries = [...config.entries()].filter(([key]) => /^remote\..+\.(?:url|pushurl)$/.test(key));
  for (const [, values] of remoteEntries) {
    if (values.length === 0 || values.some((value) => canonicalGitHubRemote(value) === null)) {
      return { safe: false, reason: 'every remote URL must be canonical HTTPS or SSH github.com transport', origin: null };
    }
  }
  const fetch = config.get('remote.origin.url') ?? [];
  const push = config.get('remote.origin.pushurl') ?? fetch;
  if (fetch.length === 0 || push.length === 0) {
    return { safe: false, reason: 'canonical origin fetch and effective push URLs are required', origin: null };
  }
  const destinations = [...fetch, ...push].map(canonicalGitHubRemote);
  if (destinations.some((value) => value === null)) {
    return { safe: false, reason: 'origin contains a prohibited remote helper or non-canonical transport', origin: null };
  }
  const names = new Set(destinations.map((value) => value!.nameWithOwner));
  const nameWithOwner = names.size === 1 ? names.values().next().value : null;
  return nameWithOwner
    ? { safe: true, reason: 'local Git config is non-effectful and origin is canonical GitHub transport', origin: { nameWithOwner } }
    : { safe: false, reason: 'origin fetch and push identities disagree', origin: null };
}

function parseTree(value: Buffer): GitTreeEntry[] | null {
  const raw = parseNulList(value, MAX_TREE_ENTRIES);
  if (!raw) return null;
  const entries: GitTreeEntry[] = [];
  for (const item of raw) {
    const match = item.match(/^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/);
    if (!match?.[1] || !match[2] || !match[3] || !match[4] ||
        match[4].startsWith('/') || match[4].split('/').some((part) => !part || part === '.' || part === '..')) return null;
    entries.push({ mode: match[1], type: match[2] as GitTreeEntry['type'], oid: match[3], path: match[4] });
  }
  return entries;
}

function gitDirectory(repo: string): string | null {
  const entry = join(repo, '.git');
  try {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) return realpathSync(entry);
    if (!stat.isFile() || stat.size > 4_096) return null;
    const text = readFileSync(entry, 'utf8').trim();
    const match = text.match(/^gitdir: (.+)$/);
    if (!match?.[1]) return null;
    const target = resolve(repo, match[1]);
    const targetStat = lstatSync(target);
    return targetStat.isDirectory() && !targetStat.isSymbolicLink() ? realpathSync(target) : null;
  } catch {
    return null;
  }
}

function fileDigest(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_GIT_OUTPUT) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function pathStateDigest(path: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return createHash('sha256').update(`symlink\0${readlinkSync(path)}`).digest('hex');
    }
    if (!stat.isFile() || stat.size > MAX_HEAD_BLOB_BYTES) return `unsupported:${stat.mode}:${stat.size}`;
    return createHash('sha256').update(`file\0${stat.mode}\0`).update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

function controlsDigest(repo: string): string {
  const values = [CANDIDATE_VERIFY_CONTRACT_FILE, CANDIDATE_ADMISSION_CONTRACT_FILE, 'package.json']
    .map((path) => [path, pathStateDigest(join(repo, path))]);
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function trackedWorktreeSnapshot(
  repo: string,
  tree: readonly GitTreeEntry[] | null,
): { digest: string | null; matchesHead: boolean; complete: boolean } {
  if (!tree) return { digest: null, matchesHead: false, complete: false };
  const aggregate = createHash('sha256');
  let totalBytes = 0;
  let matchesHead = true;
  for (const entry of tree) {
    if (entry.mode === '160000' || entry.type !== 'blob') {
      return { digest: null, matchesHead: false, complete: false };
    }
    const absolute = resolve(repo, entry.path);
    const rel = relative(repo, absolute).replace(/\\/g, '/');
    if (rel !== entry.path || rel.startsWith('../') || isAbsolute(rel)) {
      return { digest: null, matchesHead: false, complete: false };
    }
    let bytes: Buffer;
    try {
      const stat = lstatSync(absolute);
      if (entry.mode === '120000') {
        if (!stat.isSymbolicLink()) return { digest: null, matchesHead: false, complete: false };
        bytes = Buffer.from(readlinkSync(absolute), 'utf8');
      } else {
        if (!['100644', '100755'].includes(entry.mode) || !stat.isFile() || stat.isSymbolicLink()) {
          return { digest: null, matchesHead: false, complete: false };
        }
        if (stat.size < 0 || totalBytes + stat.size > MAX_TRACKED_WORKTREE_BYTES) {
          return { digest: null, matchesHead: false, complete: false };
        }
        bytes = readFileSync(absolute);
      }
    } catch {
      return { digest: null, matchesHead: false, complete: false };
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TRACKED_WORKTREE_BYTES) return { digest: null, matchesHead: false, complete: false };
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`, 'utf8').update(bytes).digest('hex');
    if (oid !== entry.oid) matchesHead = false;
    aggregate.update(`${entry.path}\0${entry.mode}\0${bytes.length}\0`, 'utf8');
    aggregate.update(createHash('sha256').update(bytes).digest());
  }
  return { digest: aggregate.digest('hex'), matchesHead, complete: true };
}

function snapshotLocal(repo: string, deps: CandidateRepoAdmissionDeps): LocalSnapshot {
  const gitDir = gitDirectory(repo);
  const indexDigest = gitDir ? fileDigest(join(gitDir, 'index')) : null;
  const controls = controlsDigest(repo);
  if (!gitDir) {
    return { available: false, gitMetadataSafe: false, configReason: 'repository metadata is missing, symlinked, or malformed', origin: null, branch: null, head: null, status: null, tree: null, configDigest: null, treeDigest: null, headTreeOid: null, trackedBytesDigest: null, trackedBytesMatchHead: false, trackedBytesComplete: false, indexDigest, controlsDigest: controls };
  }
  const configResult = runGit(deps, repo, ['config', '--local', '--no-includes', '--null', '--list'], 512 * 1024);
  const config = configResult?.status === 0 ? parseConfig(configResult.stdout) : null;
  if (!config) {
    return { available: false, gitMetadataSafe: false, configReason: 'bounded local Git configuration is unavailable', origin: null, branch: null, head: null, status: null, tree: null, configDigest: null, treeDigest: null, headTreeOid: null, trackedBytesDigest: null, trackedBytesMatchHead: false, trackedBytesComplete: false, indexDigest, controlsDigest: controls };
  }
  const configAudit = auditConfig(config);
  if (!configAudit.safe) {
    return { available: false, gitMetadataSafe: false, configReason: configAudit.reason, origin: null, branch: null, head: null, status: null, tree: null, configDigest: createHash('sha256').update(configResult!.stdout).digest('hex'), treeDigest: null, headTreeOid: null, trackedBytesDigest: null, trackedBytesMatchHead: false, trackedBytesComplete: false, indexDigest, controlsDigest: controls };
  }
  const root = gitText(deps, repo, ['rev-parse', '--show-toplevel']);
  const branch = gitText(deps, repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const headRaw = gitText(deps, repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const headTreeRaw = gitText(deps, repo, ['rev-parse', '--verify', 'HEAD^{tree}']);
  const statusResult = runGit(deps, repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
  const treeResult = runGit(deps, repo, ['ls-tree', '-r', '-z', 'HEAD']);
  const head = headRaw && SHA1_RE.test(headRaw) ? headRaw.toLowerCase() : null;
  const headTreeOid = headTreeRaw && SHA1_RE.test(headTreeRaw) ? headTreeRaw.toLowerCase() : null;
  const tree = treeResult?.status === 0 ? parseTree(treeResult.stdout) : null;
  const tracked = trackedWorktreeSnapshot(repo, tree);
  const available = root !== null && resolve(root) === repo && Boolean(branch && safeRef(branch)) &&
    head !== null && headTreeOid !== null && statusResult?.status === 0 && tree !== null;
  return {
    available,
    gitMetadataSafe: true,
    configReason: available ? configAudit.reason : 'bounded repository facts are unavailable',
    origin: configAudit.origin,
    branch: branch && safeRef(branch) ? branch : null,
    head,
    status: statusResult?.status === 0 ? statusResult.stdout : null,
    tree,
    configDigest: createHash('sha256').update(configResult!.stdout).digest('hex'),
    treeDigest: treeResult?.status === 0 ? createHash('sha256').update(treeResult.stdout).digest('hex') : null,
    headTreeOid,
    trackedBytesDigest: tracked.digest,
    trackedBytesMatchHead: tracked.matchesHead,
    trackedBytesComplete: tracked.complete,
    indexDigest,
    controlsDigest: controls,
  };
}

function headFile(
  repo: string,
  tree: readonly GitTreeEntry[] | null,
  path: string,
  deps: CandidateRepoAdmissionDeps,
): HeadFile {
  if (!tree) return { state: 'unavailable', mode: null, oid: null, bytes: null, worktreeMatchesHead: false, detail: 'immutable HEAD tree is unavailable' };
  const entries = tree.filter((entry) => entry.path === path);
  if (entries.length === 0) return { state: 'missing', mode: null, oid: null, bytes: null, worktreeMatchesHead: false, detail: `${path} is absent from HEAD` };
  const entry = entries.length === 1 ? entries[0]! : null;
  if (!entry || entry.type !== 'blob' || entry.mode !== '100644') {
    return { state: 'invalid-mode', mode: entry?.mode ?? null, oid: entry?.oid ?? null, bytes: null, worktreeMatchesHead: false, detail: `${path} must be an ordinary 100644 HEAD blob; symlink, executable, and submodule modes are refused` };
  }
  const result = runGit(deps, repo, ['cat-file', 'blob', entry.oid], MAX_HEAD_BLOB_BYTES);
  if (result?.status !== 0 || result.stdout.length > MAX_HEAD_BLOB_BYTES) {
    return { state: 'unavailable', mode: entry.mode, oid: entry.oid, bytes: null, worktreeMatchesHead: false, detail: `${path} HEAD blob is unavailable` };
  }
  let worktreeMatchesHead = false;
  try {
    const worktree = join(repo, path);
    const stat = lstatSync(worktree);
    worktreeMatchesHead = stat.isFile() && !stat.isSymbolicLink() && stat.size === result.stdout.length &&
      readFileSync(worktree).equals(result.stdout);
  } catch {
    worktreeMatchesHead = false;
  }
  return {
    state: worktreeMatchesHead ? 'regular' : 'unavailable',
    mode: entry.mode,
    oid: entry.oid,
    bytes: result.stdout,
    worktreeMatchesHead,
    detail: worktreeMatchesHead ? `${path} is an immutable regular HEAD blob matching the worktree` : `${path} worktree bytes diverge from immutable HEAD`,
  };
}

function detectKinds(tree: readonly GitTreeEntry[] | null): { projectKinds: RepoProjectKind[]; packageManagers: RepoPackageManager[] } {
  const paths = new Set((tree ?? []).map((entry) => entry.path));
  const projectKinds = new Set<RepoProjectKind>();
  const packageManagers = new Set<RepoPackageManager>();
  if (paths.has('package.json')) { projectKinds.add('node'); packageManagers.add(paths.has('pnpm-lock.yaml') ? 'pnpm' : paths.has('yarn.lock') ? 'yarn' : paths.has('bun.lock') || paths.has('bun.lockb') ? 'bun' : 'npm'); }
  if (paths.has('Cargo.toml')) { projectKinds.add('rust'); packageManagers.add('cargo'); }
  if (paths.has('pyproject.toml') || paths.has('setup.py') || paths.has('requirements.txt')) { projectKinds.add('python'); packageManagers.add('python'); }
  if (paths.has('Makefile') || paths.has('makefile')) { projectKinds.add('make'); packageManagers.add('make'); }
  if (paths.has('justfile') || paths.has('Justfile')) { projectKinds.add('just'); packageManagers.add('just'); }
  if (paths.has(CANDIDATE_VERIFY_CONTRACT_FILE)) projectKinds.add('verify-contract');
  return { projectKinds: [...projectKinds].sort(), packageManagers: [...packageManagers].sort() };
}

function inspectVerifier(repo: string, tree: readonly GitTreeEntry[] | null, deps: CandidateRepoAdmissionDeps): CandidateVerifierEvidence {
  const file = headFile(repo, tree, CANDIDATE_VERIFY_CONTRACT_FILE, deps);
  const kinds = detectKinds(tree);
  if (file.state !== 'regular' || !file.bytes) {
    const source = file.state === 'missing' ? 'missing' : file.state === 'invalid-mode' ? 'invalid-mode' :
      file.bytes && !file.worktreeMatchesHead ? 'worktree-diverged' : 'unavailable';
    return { available: false, ...kinds, verifyCommandCount: 0, mergeCommandCount: 0, requiredManifestDigest: null, contractPresent: file.state !== 'missing', contractValid: false, contractSource: source, headBlobOid: file.oid, headMode: file.mode, worktreeMatchesHead: file.worktreeMatchesHead, mergeGradeExplicit: false, declaredProfile: null, detail: file.detail };
  }
  const document = parseRepoVerifyContractDocument(repo, file.bytes.toString('utf8'));
  const mergeCommands = filterVerifyCommandsForProfile(document.commands, 'merge');
  const manifest = document.summary.valid ? buildRequiredVerificationManifest(repo, mergeCommands) : null;
  const ready = document.summary.valid && document.summary.mergeGradeExplicit && manifest !== null;
  return {
    available: true,
    ...kinds,
    verifyCommandCount: document.commands.length,
    mergeCommandCount: manifest?.commandCount ?? 0,
    requiredManifestDigest: manifest?.digest ?? null,
    contractPresent: true,
    contractValid: document.summary.valid,
    contractSource: 'head-regular',
    headBlobOid: file.oid,
    headMode: file.mode,
    worktreeMatchesHead: true,
    mergeGradeExplicit: document.summary.mergeGradeExplicit,
    declaredProfile: ready ? 'merge' : null,
    detail: ready ? `${manifest.commandCount} required merge-profile command(s) from immutable HEAD` : document.summary.mergeGradeReason,
  };
}

function parseAdmissionDeclaration(bytes: Buffer): AdmissionDeclaration | null {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  const root = objectRecord(raw);
  const evidence = objectRecord(root?.['judgeFreeEvidence']);
  if (!root || !evidence || !exactKeys(root, ['judgeFreeEvidence', 'riskClassification', 'schemaVersion']) ||
      !exactKeys(evidence, ['check', 'profile', 'workflow']) || root['schemaVersion'] !== 2) return null;
  const risk = root['riskClassification'];
  const profile = evidence['profile'];
  const workflow = evidence['workflow'];
  const check = evidence['check'];
  if (!['ordinary', 'sensitive', 'regulated', 'critical'].includes(String(risk)) || profile !== 'merge' ||
      typeof workflow !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow) ||
      typeof check !== 'string' || check.trim() !== check || check.length === 0 || check.length > 256) return null;
  return { riskClassification: risk as CandidateRiskClassification, profile: 'merge', workflow, check };
}

function inspectAdmissionContract(repo: string, tree: readonly GitTreeEntry[] | null, deps: CandidateRepoAdmissionDeps): { evidence: CandidateAdmissionContractEvidence; declaration: AdmissionDeclaration | null } {
  const file = headFile(repo, tree, CANDIDATE_ADMISSION_CONTRACT_FILE, deps);
  if (file.state !== 'regular' || !file.bytes) {
    const state = file.state === 'missing' ? 'missing' : file.state === 'invalid-mode' ? 'invalid-mode' :
      file.bytes && !file.worktreeMatchesHead ? 'worktree-diverged' : 'unavailable';
    return { declaration: null, evidence: { state, riskClassification: null, declaredProfile: null, workflow: null, check: null, headBlobOid: file.oid, worktreeMatchesHead: file.worktreeMatchesHead, detail: file.detail } };
  }
  const declaration = parseAdmissionDeclaration(file.bytes);
  if (!declaration) {
    return { declaration: null, evidence: { state: 'invalid', riskClassification: null, declaredProfile: null, workflow: null, check: null, headBlobOid: file.oid, worktreeMatchesHead: true, detail: 'immutable ashlr.admission.json v2 is malformed or contains undeclared fields such as signer identity' } };
  }
  return { declaration, evidence: { state: 'head-regular', riskClassification: declaration.riskClassification, declaredProfile: declaration.profile, workflow: declaration.workflow, check: declaration.check, headBlobOid: file.oid, worktreeMatchesHead: true, detail: 'immutable admission declaration is structurally valid and nominates no signer; trusted live attestation is still required' } };
}

function inspectSelfTarget(repo: string, tree: readonly GitTreeEntry[] | null, origin: string | null, deps: CandidateRepoAdmissionDeps): boolean | null {
  if (origin?.toLowerCase() === SELF_REPOSITORY) return true;
  const entry = tree?.find((item) => item.path === 'package.json');
  if (!entry) return origin ? false : null;
  const file = headFile(repo, tree, 'package.json', deps);
  if (file.state !== 'regular' || !file.bytes) return null;
  try {
    const parsed = objectRecord(JSON.parse(file.bytes.toString('utf8')));
    return parsed?.['name'] === SELF_PACKAGE_NAME;
  } catch {
    return null;
  }
}

export function buildCandidateAdmissionAttestationId(input: {
  nameWithOwner: string;
  repositoryId: string;
  branch: string;
  baseHead: string;
  candidateHead: string;
  candidateTreeOid: string;
  evidenceScope: 'whole-head-snapshot';
  workflow: string;
  check: string;
  workflowAppId: string;
  attestationCheck: string;
  attestationAppId: string;
  trustedPolicyDigest: string;
  protectedRemotePolicyDigest: string;
  evaluatorVersion: typeof CANDIDATE_ADMISSION_EVALUATOR_VERSION;
  verifierManifestDigest: string;
  profile: 'merge';
  riskClassification: CandidateRiskClassification;
}): string | null {
  if (!SHA1_RE.test(input.baseHead) || !SHA1_RE.test(input.candidateHead) ||
      !SHA1_RE.test(input.candidateTreeOid) || input.evidenceScope !== 'whole-head-snapshot' ||
      !SHA256_RE.test(input.verifierManifestDigest) || !APP_ID_RE.test(input.workflowAppId) ||
      !APP_ID_RE.test(input.attestationAppId) || input.attestationAppId === input.workflowAppId ||
      !SHA256_RE.test(input.trustedPolicyDigest) || !SHA256_RE.test(input.protectedRemotePolicyDigest) ||
      input.evaluatorVersion !== CANDIDATE_ADMISSION_EVALUATOR_VERSION) return null;
  const digest = createHash('sha256').update(JSON.stringify([
    CANDIDATE_ATTESTATION_DOMAIN,
    input.nameWithOwner.toLowerCase(),
    input.repositoryId,
    input.branch,
    input.baseHead.toLowerCase(),
    input.candidateHead.toLowerCase(),
    input.candidateTreeOid.toLowerCase(),
    input.evidenceScope,
    input.workflow,
    input.check,
    input.workflowAppId,
    input.attestationCheck,
    input.attestationAppId,
    input.trustedPolicyDigest.toLowerCase(),
    input.protectedRemotePolicyDigest.toLowerCase(),
    input.evaluatorVersion,
    input.verifierManifestDigest.toLowerCase(),
    input.profile,
    input.riskClassification,
  ])).digest('hex');
  return `ashlr-admission-v6:${digest}`;
}

function emptyMutationProof(detail: string): CandidateMutationProof {
  return { available: false, indexUnchanged: false, gitConfigUnchanged: false, headUnchanged: false, headTreeUnchanged: false, statusUnchanged: false, controlFilesUnchanged: false, repoBytesUnchanged: false, detail };
}

function emptySource(detail: string): CandidateSourceEvidence {
  return { available: false, clean: false, current: false, branch: null, defaultBranch: null, head: null, remoteHead: null, dirtyEntries: null, gitMetadataSafe: false, mutationProof: emptyMutationProof('mutation proof unavailable'), detail };
}

function dirtyEntryCount(status: Buffer | null): number | null {
  return status === null ? null : parseNulList(status, MAX_TREE_ENTRIES)?.length ?? null;
}

function finalizeSource(before: LocalSnapshot, after: LocalSnapshot, remote: CandidateRemoteHeadEvidence): CandidateSourceEvidence {
  const indexUnchanged = before.indexDigest !== null && before.indexDigest === after.indexDigest;
  const gitConfigUnchanged = before.configDigest !== null && before.configDigest === after.configDigest;
  const headUnchanged = before.head !== null && before.head === after.head;
  const headTreeUnchanged = before.treeDigest !== null && before.treeDigest === after.treeDigest;
  const statusUnchanged = before.status !== null && after.status !== null && before.status.equals(after.status);
  const controlFilesUnchanged = before.controlsDigest !== null && before.controlsDigest === after.controlsDigest;
  const trackedBytesUnchanged = before.trackedBytesDigest !== null &&
    before.trackedBytesDigest === after.trackedBytesDigest;
  const repoBytesUnchanged = indexUnchanged && gitConfigUnchanged && headUnchanged && headTreeUnchanged && statusUnchanged && controlFilesUnchanged &&
    before.trackedBytesComplete && after.trackedBytesComplete && trackedBytesUnchanged;
  const mutationProof: CandidateMutationProof = {
    available: before.available && after.available && repoBytesUnchanged,
    indexUnchanged,
    gitConfigUnchanged,
    headUnchanged,
    headTreeUnchanged,
    statusUnchanged,
    controlFilesUnchanged,
    repoBytesUnchanged,
    detail: repoBytesUnchanged
      ? 'index, local config, HEAD/tree, porcelain state, control files, and every bounded tracked worktree byte were unchanged across all probes'
      : 'repository or index evidence changed or could not be proven stable across probes',
  };
  const count = dirtyEntryCount(before.status);
  const clean = count === 0 && before.trackedBytesMatchHead && after.trackedBytesMatchHead;
  const current = remote.available && before.branch === remote.defaultBranch && before.head === remote.head;
  const available = before.available && after.available && before.gitMetadataSafe && remote.available && repoBytesUnchanged;
  return {
    available,
    clean,
    current,
    branch: before.branch,
    defaultBranch: remote.defaultBranch,
    head: before.head,
    remoteHead: remote.head,
    dirtyEntries: count,
    gitMetadataSafe: before.gitMetadataSafe,
    mutationProof,
    detail: !before.gitMetadataSafe ? before.configReason : !repoBytesUnchanged ? mutationProof.detail :
      clean && current ? `clean ${before.branch} checkout matches exact live GitHub head ${before.head?.slice(0, 12)}` :
        `source is ${clean ? 'clean' : `dirty (${count ?? 'unknown'} entries)`} and ${current ? 'current' : 'not at the exact live default head'}`,
  };
}

function emptyRemote(detail: string, candidateHead: string | null = null): CandidateRemotePrEvidence {
  return {
    available: false,
    ready: false,
    nameWithOwner: null,
    repositoryId: null,
    defaultBranch: null,
    baseHead: null,
    candidateHead,
    protected: false,
    pullRequestRequired: false,
    requiredChecks: [],
    requiredCheckBindings: [],
    safeMinimum: false,
    policyDigest: null,
    trustedPolicyDigest: null,
    evaluatorVersion: null,
    observedAt: null,
    expectedAttestationId: null,
    evidenceScope: 'whole-head-snapshot',
    candidateTreeOid: null,
    remoteStableAfterChecks: false,
    trustedPolicyStableAfterChecks: false,
    checkEvidenceStableAfterRecheck: false,
    authorityEpochStable: false,
    initialAuthorityEpochDigest: null,
    finalAuthorityEpochDigest: null,
    checkRun: emptyCheckRun('check run was not inspected'),
    detail,
  };
}

function sameRemoteHead(left: CandidateRemoteHeadEvidence, right: CandidateRemoteHeadEvidence): boolean {
  return left.available === right.available && left.nameWithOwner?.toLowerCase() === right.nameWithOwner?.toLowerCase() &&
    left.defaultBranch === right.defaultBranch && left.head?.toLowerCase() === right.head?.toLowerCase();
}

function protectionAuthoritySnapshot(value: BranchProtectionAttestation): string {
  return JSON.stringify({
    available: value.available,
    baseHead: value.baseHead?.toLowerCase() ?? null,
    branch: value.branch,
    branchProtection: value.branchProtection,
    defaultBranch: value.defaultBranch,
    nameWithOwner: value.nameWithOwner?.toLowerCase() ?? null,
    ok: value.ok,
    policySnapshot: value.policySnapshot,
    protected: value.protected,
    repositoryId: value.repositoryId,
    requiredCheckBindings: value.requiredCheckBindings
      .map((binding) => ({ appId: binding.appId, context: binding.context }))
      .sort((left, right) => `${left.context}\0${left.appId ?? ''}`.localeCompare(`${right.context}\0${right.appId ?? ''}`)),
    requiredChecks: [...value.requiredChecks].sort(),
    requirements: [...value.requirements].sort(),
    sources: [...value.sources].sort(),
  });
}

function sameTrustedPolicyAuthority(
  before: CandidateTrustedPolicyAuthorityRead,
  after: CandidateTrustedPolicyAuthorityRead,
  beforePolicy: CandidateAdmissionTrustedPolicy | null,
  afterPolicy: CandidateAdmissionTrustedPolicy | null,
): boolean {
  return before.state === 'verified' && after.state === 'verified' && before.path === after.path &&
    before.proof !== null && before.proof === after.proof && beforePolicy !== null && afterPolicy !== null &&
    beforePolicy.digest === afterPolicy.digest;
}

function sameCandidateCheckAuthority(
  before: CandidateCheckRunEvidence,
  after: CandidateCheckRunEvidence,
): boolean {
  if (!before.ready || !after.ready || !before.authorityDigest ||
      before.authorityDigest !== after.authorityDigest) return false;
  const beforeDigest = canonicalAuthorityDigest(before);
  return beforeDigest !== null && beforeDigest === canonicalAuthorityDigest(after);
}

function localAuthoritySnapshot(value: LocalSnapshot | null): Record<string, unknown> | null {
  if (!value) return null;
  return {
    available: value.available,
    branch: value.branch,
    configDigest: value.configDigest,
    configReason: value.configReason,
    controlsDigest: value.controlsDigest,
    gitMetadataSafe: value.gitMetadataSafe,
    head: value.head?.toLowerCase() ?? null,
    headTreeOid: value.headTreeOid?.toLowerCase() ?? null,
    indexDigest: value.indexDigest,
    origin: value.origin?.nameWithOwner.toLowerCase() ?? null,
    statusDigest: value.status ? createHash('sha256').update(value.status).digest('hex') : null,
    trackedBytesComplete: value.trackedBytesComplete,
    trackedBytesDigest: value.trackedBytesDigest,
    trackedBytesMatchHead: value.trackedBytesMatchHead,
    treeDigest: value.treeDigest,
  };
}

function remoteHeadAuthoritySnapshot(value: CandidateRemoteHeadEvidence): Record<string, unknown> {
  return {
    available: value.available,
    defaultBranch: value.defaultBranch,
    head: value.head?.toLowerCase() ?? null,
    nameWithOwner: value.nameWithOwner?.toLowerCase() ?? null,
  };
}

function trustedPolicyAuthoritySnapshot(
  authority: CandidateTrustedPolicyAuthorityRead,
  policy: CandidateAdmissionTrustedPolicy | null,
): Record<string, unknown> {
  return {
    path: authority.path,
    policy,
    proof: authority.proof,
    state: authority.state,
  };
}

function authorityEpochDigest(input: {
  local: LocalSnapshot | null;
  remoteHead: CandidateRemoteHeadEvidence;
  protection: BranchProtectionAttestation;
  trustedAuthority: CandidateTrustedPolicyAuthorityRead;
  trustedPolicy: CandidateAdmissionTrustedPolicy | null;
  checkRun: CandidateCheckRunEvidence;
}): string | null {
  return canonicalAuthorityDigest({
    domain: 'ashlr:candidate-admission-authority-epoch:v1',
    localRepo: localAuthoritySnapshot(input.local),
    operatorPolicy: trustedPolicyAuthoritySnapshot(input.trustedAuthority, input.trustedPolicy),
    protectionAndRulesets: protectionAuthoritySnapshot(input.protection),
    remoteHeadAndDefaultBranch: remoteHeadAuthoritySnapshot(input.remoteHead),
    workflowJobsChecksAttestationsAndPagination: input.checkRun,
  });
}

async function inspectRemotePr(
  candidateRoot: string,
  sourceSnapshot: LocalSnapshot | null,
  sourceHead: string | null,
  sourceTreeOid: string | null,
  remoteHead: CandidateRemoteHeadEvidence,
  origin: string | null,
  verifier: CandidateVerifierEvidence,
  declaration: AdmissionDeclaration | null,
  trustedPolicy: CandidateAdmissionTrustedPolicy | null,
  trustedAuthority: CandidateTrustedPolicyAuthorityRead,
  trustedGithubCli: TrustedExecutablePin | null,
  evaluatedAt: string,
  captureFinalLocalSnapshot: () => LocalSnapshot | null,
  deps: CandidateRepoAdmissionDeps,
): Promise<CandidateRemotePrEvidence> {
  if (!origin || !remoteHead.available || !remoteHead.defaultBranch || !remoteHead.head || !sourceHead || !sourceTreeOid) {
    return emptyRemote('canonical GitHub source identity/head is unavailable', sourceHead);
  }
  if (!trustedGithubCli || !deps.verifyGithubCli(trustedGithubCli, [candidateRoot])) {
    return emptyRemote('trusted GitHub executable custody is unavailable', sourceHead);
  }
  let live: BranchProtectionAttestation;
  try {
    live = await deps.readProtection(tmpdir(), remoteHead.defaultBranch, {
      forceFresh: true,
      expectedNameWithOwner: origin,
      trustedGithubCli,
      untrustedRoots: [candidateRoot],
    });
  } catch {
    return { ...emptyRemote('live branch-protection observation failed', sourceHead), nameWithOwner: origin };
  }
  const pullRequestRequired = live.requirements.includes('pull_request');
  const identityBound = live.nameWithOwner?.toLowerCase() === origin.toLowerCase() &&
    live.defaultBranch === remoteHead.defaultBranch && live.branch === remoteHead.defaultBranch &&
    live.baseHead?.toLowerCase() === remoteHead.head.toLowerCase();
  const workflowMatches = declaration
    ? live.requiredCheckBindings.filter((binding) => binding.context === declaration.check && binding.appId !== null)
    : [];
  const workflowBinding = workflowMatches.length === 1 ? workflowMatches[0]! : null;
  const declaredBinding: RequiredCheckBinding[] = workflowBinding ? [{ ...workflowBinding }] : [];
  const liveBindings = live.requiredCheckBindings
    .map((binding) => `${binding.context}\0${binding.appId ?? ''}`)
    .sort();
  const expectedBindings = declaredBinding.map((binding) => `${binding.context}\0${binding.appId ?? ''}`).sort();
  const bindingsExact = declaration !== null && trustedPolicy !== null && workflowBinding !== null &&
    JSON.stringify(liveBindings) === JSON.stringify(expectedBindings);
  let safeMinimum: SafeMinimumProtectedRemotePolicyV1Verdict | null = null;
  if (live.policySnapshot && declaration && workflowBinding) safeMinimum = deps.evaluateSafeMinimum(live.policySnapshot, declaredBinding);
  const policyDigest = live.policySnapshot && safeMinimum?.ok && declaration && workflowBinding
    ? deps.buildPolicyDigest(live.policySnapshot, declaredBinding)
    : null;
  const attestorIndependent = trustedPolicy !== null && workflowBinding?.appId !== null &&
    workflowBinding?.appId !== undefined && trustedPolicy.trustedAppIds.every((appId) => appId !== workflowBinding.appId);
  const expectedAttestations = declaration && trustedPolicy && workflowBinding?.appId && attestorIndependent && verifier.requiredManifestDigest &&
    live.repositoryId && identityBound && policyDigest
    ? trustedPolicy.trustedAppIds.map((attestationAppId) => ({
      appId: attestationAppId,
      externalId: buildCandidateAdmissionAttestationId({
        nameWithOwner: origin,
        repositoryId: live.repositoryId!,
        branch: remoteHead.defaultBranch!,
        baseHead: remoteHead.head!,
        candidateHead: sourceHead,
        candidateTreeOid: sourceTreeOid,
        evidenceScope: 'whole-head-snapshot',
        workflow: declaration.workflow,
        check: declaration.check,
        workflowAppId: workflowBinding.appId!,
        attestationCheck: trustedPolicy.attestationCheck,
        attestationAppId,
        trustedPolicyDigest: trustedPolicy.digest,
        protectedRemotePolicyDigest: policyDigest,
        evaluatorVersion: trustedPolicy.evaluatorVersion,
        verifierManifestDigest: verifier.requiredManifestDigest!,
        profile: declaration.profile,
        riskClassification: declaration.riskClassification,
      })!,
    })).filter((item) => item.externalId !== null)
    : [];
  const checkRequest: CandidateCheckRunRequest | null = declaration && trustedPolicy && workflowBinding?.appId &&
    expectedAttestations.length === trustedPolicy.trustedAppIds.length
    ? {
        candidateRoot,
        trustedGithubCli,
        nameWithOwner: origin,
        branch: remoteHead.defaultBranch,
        head: sourceHead,
        workflow: declaration.workflow,
        check: declaration.check,
        workflowAppId: workflowBinding.appId,
        attestationCheck: trustedPolicy.attestationCheck,
        expectedAttestations,
        trustedPolicyDigest: trustedPolicy.digest,
        evaluatorVersion: trustedPolicy.evaluatorVersion,
        evaluatedAt,
        evidenceMaxAgeMs: trustedPolicy.evidenceMaxAgeMs,
        evidenceFutureSkewMs: trustedPolicy.evidenceFutureSkewMs,
      }
    : null;
  let initialCheckRun = emptyCheckRun(
    'trusted signer policy, immutable admission declaration, or verifier/policy binding is unavailable',
  );
  if (checkRequest) {
    try {
      initialCheckRun = deps.readCheckRun(checkRequest);
    } catch {
      initialCheckRun = emptyCheckRun('initial correlated check evidence collection failed');
    }
  }
  const initialAuthorityEpochDigest = authorityEpochDigest({
    local: sourceSnapshot,
    remoteHead,
    protection: live,
    trustedAuthority,
    trustedPolicy,
    checkRun: initialCheckRun,
  });
  interface ClosingAuthorityObservation {
    digest: string | null;
    localStable: boolean;
    remoteHead: CandidateRemoteHeadEvidence;
    protection: BranchProtectionAttestation;
    trustedAuthority: CandidateTrustedPolicyAuthorityRead;
    trustedPolicy: CandidateAdmissionTrustedPolicy | null;
    checkRun: CandidateCheckRunEvidence;
  }
  const failedRemote = (): CandidateRemoteHeadEvidence => ({
    available: false,
    nameWithOwner: null,
    defaultBranch: null,
    head: null,
    detail: 'closing remote observation failed',
  });
  const closingObservations: ClosingAuthorityObservation[] = [];
  let closureHookFailed = false;
  try {
    deps.beforeFinalEvidenceRecheck?.();
  } catch {
    closureHookFailed = true;
  }
  for (let round = 0; round < AUTHORITY_EPOCH_CLOSURE_ROUNDS; round += 1) {
    const localBefore = captureFinalLocalSnapshot();
    let closingRemote = failedRemote();
    let closingProtection = { ...live, available: false, ok: false, detail: 'closing protection observation failed' };
    let closingAuthority = authorityFailure('unreadable', trustedAuthority.path, 'closing operator authority observation failed');
    let closingPolicy: CandidateAdmissionTrustedPolicy | null = null;
    let closingCheck = emptyCheckRun('closing correlated check evidence collection failed');
    try {
      if (closureHookFailed) throw new Error('closing authority hook failed');
      closingRemote = deps.readRemoteHead(origin, candidateRoot, trustedGithubCli);
      closingProtection = await deps.readProtection(tmpdir(), remoteHead.defaultBranch, {
        forceFresh: true,
        expectedNameWithOwner: origin,
        trustedGithubCli,
        untrustedRoots: [candidateRoot],
      });
      closingAuthority = deps.readTrustedPolicy();
      closingPolicy = closingAuthority.state === 'verified'
        ? parseCandidateAdmissionTrustedPolicy(closingAuthority.value)
        : null;
      closingCheck = checkRequest ? deps.readCheckRun(checkRequest) : initialCheckRun;
      if (round === 0) deps.afterFinalEvidenceRecheck?.();
    } catch {
      closingRemote = failedRemote();
      closingProtection = { ...live, available: false, ok: false, detail: 'closing protection observation failed' };
      closingAuthority = authorityFailure('unreadable', trustedAuthority.path, 'closing operator authority observation failed');
      closingPolicy = null;
      closingCheck = emptyCheckRun('closing correlated check evidence collection failed');
    }
    const localAfter = captureFinalLocalSnapshot();
    const localBeforeDigest = canonicalAuthorityDigest(localAuthoritySnapshot(localBefore));
    const localAfterDigest = canonicalAuthorityDigest(localAuthoritySnapshot(localAfter));
    closingObservations.push({
      digest: authorityEpochDigest({
        local: localAfter,
        remoteHead: closingRemote,
        protection: closingProtection,
        trustedAuthority: closingAuthority,
        trustedPolicy: closingPolicy,
        checkRun: closingCheck,
      }),
      localStable: localBeforeDigest !== null && localBeforeDigest === localAfterDigest,
      remoteHead: closingRemote,
      protection: closingProtection,
      trustedAuthority: closingAuthority,
      trustedPolicy: closingPolicy,
      checkRun: closingCheck,
    });
  }
  const finalObservation = closingObservations.at(-1)!;
  const checkRun = finalObservation.checkRun;
  const remoteStableAfterChecks = closingObservations.every((observation) =>
    sameRemoteHead(remoteHead, observation.remoteHead) &&
    protectionAuthoritySnapshot(live) === protectionAuthoritySnapshot(observation.protection));
  const trustedPolicyStableAfterChecks = closingObservations.every((observation) =>
    sameTrustedPolicyAuthority(
      trustedAuthority,
      observation.trustedAuthority,
      trustedPolicy,
      observation.trustedPolicy,
    ));
  const checkEvidenceStableAfterRecheck = checkRequest !== null && closingObservations.every((observation) =>
    sameCandidateCheckAuthority(initialCheckRun, observation.checkRun));
  const finalAuthorityEpochDigest = finalObservation.digest;
  const authorityEpochStable = initialAuthorityEpochDigest !== null && closingObservations.length === AUTHORITY_EPOCH_CLOSURE_ROUNDS &&
    closingObservations.every((observation) => observation.localStable && observation.digest === initialAuthorityEpochDigest) &&
    remoteStableAfterChecks && trustedPolicyStableAfterChecks && checkEvidenceStableAfterRecheck;
  const expectedAttestationId = checkRun.appId
    ? expectedAttestations.find((item) => item.appId === checkRun.appId)?.externalId ?? null
    : expectedAttestations.length === 1 ? expectedAttestations[0]!.externalId : null;
  const ready = live.available && live.ok && live.protected && pullRequestRequired && identityBound &&
    sourceHead === remoteHead.head && bindingsExact && safeMinimum?.ok === true && policyDigest !== null &&
    attestorIndependent && checkRun.ready && checkEvidenceStableAfterRecheck &&
    remoteStableAfterChecks && trustedPolicyStableAfterChecks && authorityEpochStable;
  const detail = !live.available || !live.ok || !live.protected ? live.detail : !pullRequestRequired
    ? 'default branch protection does not require a pull request'
    : !identityBound ? 'branch protection identity/base does not match the exact live candidate source'
    : sourceHead !== remoteHead.head ? 'candidate head does not equal the exact protected default-branch head'
    : !trustedPolicy ? 'operator-pinned candidate admission signer policy is absent or malformed'
    : !workflowBinding ? 'declared workflow check is not bound to exactly one required-check App'
    : !bindingsExact ? 'live required checks do not exactly match the declared workflow check and its App identity'
    : !attestorIndependent ? 'operator-pinned attestor App must be independent from the protected workflow App'
    : !safeMinimum?.ok ? `safe-minimum protected-remote policy failed${safeMinimum ? ` (${safeMinimum.reason})` : ''}`
    : !checkEvidenceStableAfterRecheck
      ? `correlated workflow/check authority changed during final evidence recheck (${checkRun.detail})`
    : !checkRun.ready ? checkRun.detail
    : !remoteStableAfterChecks ? 'remote head or protected policy changed during check collection'
    : !trustedPolicyStableAfterChecks ? 'operator signer policy identity or digest changed during check collection'
    : !authorityEpochStable ? 'complete local, remote, protection, policy, and correlated-check authority epoch did not close unchanged'
    : policyDigest === null ? 'protected-remote policy digest is unavailable'
    : 'fresh whole-HEAD snapshot, protected policy, Actions workflow attempt, and independent trusted-App attestation are bound and stable across collection';
  return {
    available: live.available,
    ready,
    nameWithOwner: live.nameWithOwner,
    repositoryId: live.repositoryId,
    defaultBranch: live.defaultBranch,
    baseHead: live.baseHead,
    candidateHead: sourceHead,
    protected: live.protected,
    pullRequestRequired,
    requiredChecks: [...live.requiredChecks],
    requiredCheckBindings: live.requiredCheckBindings.map((binding) => ({ ...binding })),
    safeMinimum: safeMinimum?.ok === true,
    policyDigest,
    trustedPolicyDigest: trustedPolicy?.digest ?? null,
    evaluatorVersion: trustedPolicy?.evaluatorVersion ?? null,
    observedAt: live.observedAt || null,
    expectedAttestationId,
    evidenceScope: 'whole-head-snapshot',
    candidateTreeOid: sourceTreeOid,
    remoteStableAfterChecks,
    trustedPolicyStableAfterChecks,
    checkEvidenceStableAfterRecheck,
    authorityEpochStable,
    initialAuthorityEpochDigest,
    finalAuthorityEpochDigest,
    checkRun,
    detail,
  };
}

function primaryAction(admission: CandidateAdmissionFinding[], autonomy: CandidateAdmissionFinding[]): string {
  if (admission[0]) return admission[0].fix;
  if (autonomy[0]) return autonomy[0].fix;
  return 'Review this evidence, then explicitly enroll the repo if proposal-only fleet work is desired.';
}

/** Inspect one candidate without enrollment, verifier execution, state writes, daemon activity, or authority mutation. */
export async function inspectCandidateRepoAdmission(
  input: string,
  overrides: Partial<CandidateRepoAdmissionDeps> = {},
): Promise<CandidateRepoAdmissionReport> {
  let deps = { ...DEFAULT_DEPS, ...overrides };
  const nowValue = deps.now();
  const evaluatorClockValid = Number.isFinite(nowValue.getTime());
  const evaluatedAt = evaluatorClockValid ? nowValue.toISOString() : new Date(0).toISOString();
  let trustedPolicy: CandidateAdmissionTrustedPolicy | null = null;
  let trustedAuthority: CandidateTrustedPolicyAuthorityRead = {
    state: 'unreadable',
    path: candidateAdmissionAuthorityPath(),
    value: null,
    proof: null,
    detail: 'operator authority file read failed',
  };
  try {
    trustedAuthority = deps.readTrustedPolicy();
    trustedPolicy = evaluatorClockValid && trustedAuthority.state === 'verified'
      ? parseCandidateAdmissionTrustedPolicy(trustedAuthority.value)
      : null;
  } catch {
    trustedPolicy = null;
  }
  const trustedPolicyReport = trustedPolicyEvidence(trustedPolicy, trustedAuthority);
  const requested = typeof input === 'string' && input.trim() ? input : '.';
  const canonical = deps.canonicalPath(requested);
  const repo = canonical ?? resolve(requested);
  const admissionBlockers: CandidateAdmissionFinding[] = [];
  const autonomyBlockers: CandidateAdmissionFinding[] = [];
  const warnings: CandidateAdmissionFinding[] = [];

  let pathReady = canonical !== null;
  try { pathReady = pathReady && lstatSync(repo).isDirectory(); } catch { pathReady = false; }
  if (!pathReady) admissionBlockers.push(finding('repo-path-invalid', 'candidate path is missing, unreadable, or not a directory', 'Provide an existing readable repository directory.'));
  const untrustedGitRoots = [repo, join(repo, 'node_modules')];
  const trustedGitCli = pathReady ? deps.resolveGitCli(untrustedGitRoots) : null;
  let gitCustodyChanged = false;
  const unboundGitRunner = deps.git;
  const verifyGitCli = deps.verifyGitCli;
  deps = {
    ...deps,
    git: (invocation) => {
      if (!trustedGitCli || !verifyGitCli(trustedGitCli, untrustedGitRoots)) {
        gitCustodyChanged = trustedGitCli !== null;
        return null;
      }
      let result: CandidateGitResult | null = null;
      let threw = false;
      try {
        result = unboundGitRunner({
          ...invocation,
          trustedGitCli,
          untrustedRoots: [...untrustedGitRoots],
        });
      } catch {
        threw = true;
      }
      const custodyStable = verifyGitCli(trustedGitCli, untrustedGitRoots);
      if (!custodyStable) gitCustodyChanged = true;
      return !threw && custodyStable ? result : null;
    },
  };
  if (pathReady && !trustedGitCli) {
    admissionBlockers.push(finding(
      'trusted-git-custody-unavailable',
      'a root-owned system Git executable with attacker-nonwritable custody through the filesystem root is unavailable',
      'Install Git at a supported system-owned path; user-owned Homebrew, npm, PATH, and candidate installations are refused.',
    ));
  }
  const trustedGithubCli = pathReady ? deps.resolveGithubCli([repo]) : null;

  let enrollment: CandidateEnrollmentEvidence;
  try {
    const registry = deps.readEnrollment();
    enrollment = registry.state === 'ready'
      ? { registryState: 'ready', registryReason: registry.reason, enrolled: canonical ? registry.repos.includes(canonical) : false }
      : { registryState: 'degraded', registryReason: registry.reason, enrolled: null };
  } catch {
    enrollment = { registryState: 'degraded', registryReason: 'registry-read-failed', enrolled: null };
  }
  if (enrollment.registryState === 'degraded') admissionBlockers.push(finding('enrollment-registry-degraded', `enrollment authority is degraded (${enrollment.registryReason})`, 'Repair enrollment authority before adding or trusting another repository.'));
  else if (enrollment.enrolled) warnings.push(finding('already-enrolled', 'repository is already enrolled; this command grants no additional authority', 'No enrollment action is needed.'));

  const before = pathReady ? snapshotLocal(repo, deps) : null;
  if (pathReady && (!before?.gitMetadataSafe || !before.available)) {
    admissionBlockers.push(finding('hostile-git-metadata', before?.configReason ?? 'repository metadata is unavailable', 'Remove effectful Git configuration, helper transports, submodules, or malformed metadata before admission.'));
  }
  const origin = before?.origin?.nameWithOwner ?? null;
  const remoteHead = origin
    ? deps.readRemoteHead(origin, repo, trustedGithubCli)
    : { available: false, nameWithOwner: null, defaultBranch: null, head: null, detail: 'canonical origin is unavailable' };
  const verifier = before?.available ? inspectVerifier(repo, before.tree, deps) : {
    available: false, projectKinds: [], packageManagers: [], verifyCommandCount: 0, mergeCommandCount: 0,
    requiredManifestDigest: null, contractPresent: false, contractValid: false, contractSource: 'unavailable' as const,
    headBlobOid: null, headMode: null, worktreeMatchesHead: false, mergeGradeExplicit: false, declaredProfile: null,
    detail: 'Verifier was not inspected because hostile Git metadata was not cleared',
  };
  const admissionInspection = before?.available
    ? inspectAdmissionContract(repo, before.tree, deps)
    : { declaration: null, evidence: { state: 'unavailable' as const, riskClassification: null, declaredProfile: null, workflow: null, check: null, headBlobOid: null, worktreeMatchesHead: false, detail: 'Admission declaration was not inspected' } };
  const selfTarget = before?.available ? inspectSelfTarget(repo, before.tree, origin, deps) : null;
  let after: LocalSnapshot | null = null;
  let finalLocalCaptured = false;
  const captureFinalLocalSnapshot = (): LocalSnapshot | null => {
    const observed = pathReady ? snapshotLocal(repo, deps) : null;
    if (!finalLocalCaptured) after = observed;
    finalLocalCaptured = true;
    return observed;
  };
  const remotePr = await inspectRemotePr(
    repo,
    before,
    before?.head ?? null,
    before?.headTreeOid ?? null,
    remoteHead,
    origin,
    verifier,
    admissionInspection.declaration,
    trustedPolicy,
    trustedAuthority,
    trustedGithubCli,
    evaluatedAt,
    captureFinalLocalSnapshot,
    deps,
  );
  if (!finalLocalCaptured) captureFinalLocalSnapshot();
  const source = before && after ? finalizeSource(before, after, remoteHead) : emptySource('Git source was not inspected');

  if (pathReady && gitCustodyChanged) admissionBlockers.push(finding(
    'trusted-git-custody-changed',
    'the pinned Git executable or its installation hierarchy changed around an invocation',
    'Restore stable private Git installation custody and rerun the complete preflight.',
  ));
  if (pathReady && !source.available) admissionBlockers.push(finding('source-evidence-unavailable', source.detail, 'Restore bounded immutable Git/source evidence and rerun the preflight.'));
  else if (source.available) {
    if (!source.clean) admissionBlockers.push(finding('source-dirty', source.detail, 'Commit or intentionally remove local changes before admission.'));
    if (!source.current) admissionBlockers.push(finding('source-not-current', source.detail, 'Update the checkout to the exact live GitHub default-branch head before admission.'));
  }
  if (pathReady && !source.mutationProof.repoBytesUnchanged) admissionBlockers.push(finding('repo-mutation-proof-unavailable', source.mutationProof.detail, 'Require unchanged index, HEAD, status, and inspected control-file bytes across the complete probe.'));

  if (before?.available) {
    if (!verifier.contractPresent) admissionBlockers.push(finding('verifier-contract-missing', `root ${CANDIDATE_VERIFY_CONTRACT_FILE} is absent from HEAD`, `Add a regular 100644 ${CANDIDATE_VERIFY_CONTRACT_FILE} to HEAD with required merge-profile commands.`));
    else if (!verifier.contractValid || verifier.contractSource !== 'head-regular' || !verifier.worktreeMatchesHead) admissionBlockers.push(finding('verifier-contract-not-immutable', verifier.detail, 'Use a regular immutable HEAD verifier blob whose worktree bytes match exactly.'));
    else if (!verifier.mergeGradeExplicit || verifier.mergeCommandCount === 0 || !verifier.requiredManifestDigest) admissionBlockers.push(finding('verifier-contract-not-merge-grade', verifier.detail, 'Declare at least one required merge-profile verifier command.'));
  }

  if (selfTarget === true) autonomyBlockers.push(finding('self-target-prohibited', 'candidate admission never grants judge-free authority to Ashlr Hub itself', 'Keep self-target work proposal-only with independent review.'));
  else if (selfTarget === null) autonomyBlockers.push(finding('self-target-evidence-unavailable', 'immutable self-target classification is unavailable', 'Restore immutable origin/package identity evidence.'));

  if (!trustedPolicy) autonomyBlockers.push(finding('trusted-signer-policy-unavailable', trustedPolicyReport.detail, `Install a versioned owner-only operator authority file at ${candidateAdmissionAuthorityPath()}.`));

  if (admissionInspection.evidence.state !== 'head-regular' || !admissionInspection.declaration) {
    autonomyBlockers.push(finding('risk-classification-unattested', admissionInspection.evidence.detail, `Add an immutable signer-free ${CANDIDATE_ADMISSION_CONTRACT_FILE} v2 and obtain a fresh trusted-App admission attestation.`));
  } else if (admissionInspection.declaration.riskClassification !== 'ordinary') {
    autonomyBlockers.push(finding('risk-classification-restricted', `repo-owned risk classification is ${admissionInspection.declaration.riskClassification}`, 'Keep sensitive, regulated, or critical repositories proposal-only.'));
  }
  if (!remotePr.ready) autonomyBlockers.push(finding('protected-remote-pr-incomplete', remotePr.detail, 'Require exact protected base/head plus a fresh trusted-App workflow/check attestation binding both policy digests, evaluator version, verifier digest, merge profile, and risk classification.'));

  for (const blocker of [...admissionBlockers].reverse()) autonomyBlockers.unshift(finding(`admission:${blocker.id}`, blocker.detail, blocker.fix));
  const riskAttested = admissionInspection.declaration !== null && remotePr.ready;
  const riskRestricted = selfTarget !== false || !riskAttested || admissionInspection.declaration?.riskClassification !== 'ordinary';
  const risk: CandidateRiskEvidence = {
    state: !admissionInspection.declaration ? (admissionInspection.evidence.state === 'missing' ? 'missing' : admissionInspection.evidence.state === 'invalid' ? 'invalid' : 'unavailable') : riskAttested ? 'attested' : 'declared-unattested',
    classification: admissionInspection.declaration?.riskClassification ?? null,
    restricted: riskRestricted,
    selfTarget,
    filenameHeuristicsUsed: false,
    autonomyCeiling: riskRestricted ? 'proposal-only' : 'evidence-candidate',
    detail: selfTarget === true ? 'self-target is always proposal-only' : riskAttested
      ? `repo-owned ${admissionInspection.declaration!.riskClassification} risk classification is bound by the exact successful check attestation`
      : 'risk is fail-closed: filename absence is never positive evidence and exact external attestation is missing',
  };
  const admissionReady = admissionBlockers.length === 0;
  const judgeFreeEligible = admissionReady && autonomyBlockers.length === 0 && !riskRestricted;
  const verdict: CandidateAdmissionVerdict = !admissionReady ? 'blocked' : judgeFreeEligible ? 'evidence-candidate' : 'proposal-only';

  return {
    schemaVersion: CANDIDATE_REPO_ADMISSION_SCHEMA_VERSION,
    generatedAt: evaluatedAt,
    readOnly: true,
    authorityGranted: false,
    mutationPerformed: false,
    repo,
    name: basename(repo),
    verdict,
    admissionReady,
    judgeFreeEligible,
    primaryAction: primaryAction(admissionBlockers, autonomyBlockers),
    admissionBlockers,
    autonomyBlockers,
    warnings,
    enrollment,
    source,
    verifier,
    admissionContract: admissionInspection.evidence,
    trustedPolicy: trustedPolicyReport,
    remotePr,
    risk,
  };
}
