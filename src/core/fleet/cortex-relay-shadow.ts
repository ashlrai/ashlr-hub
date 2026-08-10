import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { resolveGitHubOriginAuthorityDetails } from '../git.js';
import {
  inspectLocusV3ShadowAuthority,
  type LocusV3ShadowAuthoritySummary,
} from '../integrations/locus.js';
import { listEnrolled } from '../sandbox/policy.js';
import type { DelegationScope } from '../types.js';
import {
  parseEngineeringAssignmentV1,
  type EngineeringAssignmentV1,
} from './cortex-engineering-assignment.js';

const GIT_TIMEOUT_MS = 3_000;
const SHA1_RE = /^[0-9a-f]{40}$/;

export type CortexRelayShadowReason =
  | 'eligible'
  | 'cancelled'
  | 'invalid-assignment'
  | 'organization-mismatch'
  | 'workstream-denied'
  | 'enrollment-source-invalid'
  | 'unknown-repository'
  | 'ambiguous-repository'
  | 'repository-unavailable'
  | 'repository-identity-changed'
  | 'remote-mismatch'
  | 'default-branch-mismatch'
  | 'stale-source'
  | 'locus-authority-invalid'
  | 'delegation-normalization-failed';

export interface CortexRelayRepositoryObservation {
  repoPath: string;
  nameWithOwner: string;
  defaultBranch: string;
  sourceCommit: string;
  dev: number;
  ino: number;
}

export interface CortexRelayShadowMetadata {
  schemaVersion: 1;
  protocol: 'ashlr-cortex-relay-shadow-outcome/v1';
  mode: 'shadow';
  executionAuthority: false;
  proposalAuthority: false;
  mergeAuthority: false;
  deployAuthority: false;
  accepted: boolean;
  reason: CortexRelayShadowReason;
  observedAt: string;
  inputDigest: string;
  assignmentId?: string;
  assignmentDigest?: string;
  runId?: string;
  workstream?: EngineeringAssignmentV1['workstream'];
  repository?: string;
  defaultBranch?: string;
  sourceCommit?: string;
  tenantRefDigest?: string;
  locus?: LocusV3ShadowAuthoritySummary;
  resultContract?: {
    kind: 'verified-proposal';
    requireDiff: true;
    requireProposal: true;
    requireVerification: true;
    maxChangedFiles: number;
    maxChangedLines: number;
    allowedFileCount: number;
  };
  effects: {
    agentsSpawned: 0;
    proposalsCreated: 0;
    repositoriesMutated: 0;
    merges: 0;
    deployments: 0;
  };
  outcomeDigest: string;
}

export type CortexRelayShadowResult =
  | {
      accepted: true;
      assignment: EngineeringAssignmentV1;
      repoPath: string;
      delegationScope: DelegationScope;
      metadata: CortexRelayShadowMetadata;
    }
  | { accepted: false; metadata: CortexRelayShadowMetadata };

export interface CortexRelayShadowInput {
  assignment: unknown;
  policy: {
    organizationRef: string;
    allowedWorkstreams: readonly EngineeringAssignmentV1['workstream'][];
  };
  signal?: AbortSignal;
}

export interface CortexRelayShadowDependencies {
  now: () => Date;
  listEnrolledRepos: () => string[];
  observeRepository: (repoPath: string) => CortexRelayRepositoryObservation | null;
  observeLocusAuthority: (
    requiredTenantRef: string,
    now: Date,
  ) => LocusV3ShadowAuthoritySummary | null;
  onPhase?: (phase: 'parsed' | 'repository-observed' | 'repository-revalidated' | 'locus-validated') => void;
}

export const CORTEX_RELAY_SHADOW_TEST_CONTROL = Symbol.for(
  'ashlr.cortex-relay-shadow.test-control.v1',
);

function sha256(domain: string, value: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(value) ?? 'undefined'; }
  catch { serialized = 'unserializable'; }
  return `sha256:${createHash('sha256').update(`${domain}\0${serialized}`, 'utf8').digest('hex')}`;
}

function canonicalEnrollment(values: readonly string[]): string[] | null {
  if (values.length > 64) return null;
  const repos: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !isAbsolute(value)) return null;
    const canonical = resolve(value);
    if (canonical !== value) return null;
    repos.push(canonical);
  }
  repos.sort();
  return new Set(repos).size === repos.length ? repos : null;
}

function defaultObserveRepository(repoPath: string): CortexRelayRepositoryObservation | null {
  try {
    const stat = lstatSync(repoPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(repoPath) !== repoPath) return null;
    const top = execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS,
    }).trim();
    if (realpathSync(top) !== repoPath) return null;
    const origin = resolveGitHubOriginAuthorityDetails(repoPath);
    if (!origin) return null;
    const remoteHead = execFileSync('git', [
      '-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD',
    ], { encoding: 'utf8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS }).trim();
    if (!remoteHead.startsWith('origin/') || remoteHead.length <= 7) return null;
    const defaultBranch = remoteHead.slice(7);
    const sourceCommit = execFileSync('git', [
      '-C', repoPath, 'rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}^{commit}`,
    ], { encoding: 'utf8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS }).trim().toLowerCase();
    if (!SHA1_RE.test(sourceCommit)) return null;
    return {
      repoPath, nameWithOwner: origin.nameWithOwner, defaultBranch, sourceCommit,
      dev: stat.dev, ino: stat.ino,
    };
  } catch {
    return null;
  }
}

function validObservation(
  observation: CortexRelayRepositoryObservation | null,
  requestedPath: string,
): observation is CortexRelayRepositoryObservation {
  return observation !== null && observation.repoPath === requestedPath &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(
      observation.nameWithOwner,
    ) && typeof observation.defaultBranch === 'string' && observation.defaultBranch.length > 0 &&
    SHA1_RE.test(observation.sourceCommit) && Number.isSafeInteger(observation.dev) &&
    observation.dev >= 0 && Number.isSafeInteger(observation.ino) && observation.ino >= 0;
}

function normalizedDelegationScope(
  assignment: EngineeringAssignmentV1,
  repoPath: string,
): DelegationScope {
  return Object.freeze({
    schemaVersion: 1,
    origin: 'cortex-relay-shadow',
    sourceRepo: repoPath,
    executionRoot: repoPath,
    taskId: assignment.assignmentId,
    runId: assignment.runId,
    objective: assignment.mission.objective,
    allowedFiles: Object.freeze({
      include: Object.freeze([...assignment.mission.allowedFiles]) as unknown as string[],
      enforceWrites: true,
    }),
    memoryMode: 'repo-only',
    resultContract: Object.freeze({ ...assignment.resultContract }),
  });
}

function metadata(
  reason: CortexRelayShadowReason,
  now: Date,
  input: unknown,
  assignment?: EngineeringAssignmentV1,
  observation?: CortexRelayRepositoryObservation,
  locus?: LocusV3ShadowAuthoritySummary,
): CortexRelayShadowMetadata {
  const base = {
    schemaVersion: 1 as const,
    protocol: 'ashlr-cortex-relay-shadow-outcome/v1' as const,
    mode: 'shadow' as const,
    executionAuthority: false as const,
    proposalAuthority: false as const,
    mergeAuthority: false as const,
    deployAuthority: false as const,
    accepted: reason === 'eligible',
    reason,
    observedAt: now.toISOString(),
    inputDigest: sha256('ashlr:cortex-relay-shadow:input:v1', input),
    ...(assignment ? {
      assignmentId: assignment.assignmentId,
      assignmentDigest: assignment.assignmentDigest,
      runId: assignment.runId,
      workstream: assignment.workstream,
      repository: `${assignment.repo.owner}/${assignment.repo.name}`,
      defaultBranch: assignment.repo.defaultBranch,
      sourceCommit: assignment.repo.sourceCommit,
      tenantRefDigest: sha256('ashlr:cortex-relay-shadow:tenant:v1', assignment.organizationRef),
      resultContract: {
        ...assignment.resultContract,
        allowedFileCount: assignment.mission.allowedFiles.length,
      },
    } : {}),
    ...(observation && assignment ? {
      repository: observation.nameWithOwner,
      defaultBranch: observation.defaultBranch,
      sourceCommit: observation.sourceCommit,
    } : {}),
    ...(locus ? { locus } : {}),
    effects: {
      agentsSpawned: 0 as const, proposalsCreated: 0 as const,
      repositoriesMutated: 0 as const, merges: 0 as const, deployments: 0 as const,
    },
  };
  return Object.freeze({
    ...base,
    outcomeDigest: sha256('ashlr:cortex-relay-shadow:outcome:v1', base),
  });
}

function rejected(
  reason: CortexRelayShadowReason,
  now: Date,
  input: unknown,
  assignment?: EngineeringAssignmentV1,
  observation?: CortexRelayRepositoryObservation,
  locus?: LocusV3ShadowAuthoritySummary,
): CortexRelayShadowResult {
  return { accepted: false, metadata: metadata(reason, now, input, assignment, observation, locus) };
}

export function validateCortexRelayShadow(input: CortexRelayShadowInput): CortexRelayShadowResult {
  return validateCortexRelayShadowInternal(input);
}

/** Vitest-only dependency seam; production callers cannot replace trust sources. */
export function _validateCortexRelayShadowForTest(
  sentinel: symbol,
  input: CortexRelayShadowInput,
  dependencies: Partial<CortexRelayShadowDependencies>,
): CortexRelayShadowResult {
  if (sentinel !== CORTEX_RELAY_SHADOW_TEST_CONTROL || process.env.VITEST !== 'true') {
    throw new Error('invalid Cortex relay shadow test control');
  }
  return validateCortexRelayShadowInternal(input, dependencies);
}

function validateCortexRelayShadowInternal(
  input: CortexRelayShadowInput,
  dependencies: Partial<CortexRelayShadowDependencies> = {},
): CortexRelayShadowResult {
  const deps: CortexRelayShadowDependencies = {
    now: () => new Date(),
    listEnrolledRepos: listEnrolled,
    observeRepository: defaultObserveRepository,
    observeLocusAuthority: (requiredTenantRef, observedAt) =>
      inspectLocusV3ShadowAuthority({ requiredTenantRef, now: observedAt })?.summary ?? null,
    ...dependencies,
  };
  const now = deps.now();
  if (!Number.isFinite(now.getTime())) return rejected('invalid-assignment', new Date(0), input.assignment);
  if (input.signal?.aborted) return rejected('cancelled', now, input.assignment);
  const assignment = parseEngineeringAssignmentV1(input.assignment, { now });
  if (!assignment) return rejected('invalid-assignment', now, input.assignment);
  deps.onPhase?.('parsed');
  if (input.signal?.aborted) return rejected('cancelled', now, input.assignment, assignment);
  if (assignment.organizationRef !== input.policy.organizationRef) {
    return rejected('organization-mismatch', now, input.assignment, assignment);
  }
  if (!input.policy.allowedWorkstreams.includes(assignment.workstream)) {
    return rejected('workstream-denied', now, input.assignment, assignment);
  }

  const firstEnrollment = canonicalEnrollment(deps.listEnrolledRepos());
  if (!firstEnrollment) return rejected('enrollment-source-invalid', now, input.assignment, assignment);
  const target = `${assignment.repo.owner}/${assignment.repo.name}`;
  const candidates: CortexRelayRepositoryObservation[] = [];
  const firstObservations: CortexRelayRepositoryObservation[] = [];
  for (const repoPath of firstEnrollment) {
    if (input.signal?.aborted) {
      return rejected('cancelled', now, input.assignment, assignment);
    }
    const observed = deps.observeRepository(repoPath);
    if (!validObservation(observed, repoPath)) {
      return rejected('repository-unavailable', now, input.assignment, assignment);
    }
    firstObservations.push(observed);
    if (observed.nameWithOwner === target) candidates.push(observed);
  }
  if (candidates.length === 0) {
    return rejected('unknown-repository', now, input.assignment, assignment);
  }
  if (candidates.length !== 1) return rejected('ambiguous-repository', now, input.assignment, assignment);
  const first = candidates[0]!;
  deps.onPhase?.('repository-observed');
  if (input.signal?.aborted) return rejected('cancelled', now, input.assignment, assignment, first);
  if (first.nameWithOwner !== target) return rejected('remote-mismatch', now, input.assignment, assignment, first);
  if (first.defaultBranch !== assignment.repo.defaultBranch) {
    return rejected('default-branch-mismatch', now, input.assignment, assignment, first);
  }
  if (first.sourceCommit !== assignment.repo.sourceCommit) {
    return rejected('stale-source', now, input.assignment, assignment, first);
  }

  if (input.signal?.aborted) return rejected('cancelled', now, input.assignment, assignment, first);
  const secondEnrollment = canonicalEnrollment(deps.listEnrolledRepos());
  if (!secondEnrollment || JSON.stringify(firstEnrollment) !== JSON.stringify(secondEnrollment)) {
    return rejected('repository-identity-changed', now, input.assignment, assignment, first);
  }
  const secondObservations: CortexRelayRepositoryObservation[] = [];
  for (const repoPath of secondEnrollment) {
    if (input.signal?.aborted) {
      return rejected('cancelled', now, input.assignment, assignment, first);
    }
    const observed = deps.observeRepository(repoPath);
    if (!validObservation(observed, repoPath)) {
      return rejected('repository-identity-changed', now, input.assignment, assignment, first);
    }
    secondObservations.push(observed);
  }
  if (JSON.stringify(firstObservations) !== JSON.stringify(secondObservations)) {
    return rejected('repository-identity-changed', now, input.assignment, assignment, first);
  }
  const second = secondObservations.find((observed) => observed.repoPath === first.repoPath)!;
  const locus = deps.observeLocusAuthority(assignment.authority.requiredTenantRef, now);
  if (!locus) return rejected('locus-authority-invalid', now, input.assignment, assignment, second);
  deps.onPhase?.('locus-validated');
  if (input.signal?.aborted) {
    return rejected('cancelled', now, input.assignment, assignment, second, locus);
  }
  if (input.signal?.aborted) {
    return rejected('cancelled', now, input.assignment, assignment, second, locus);
  }
  const thirdEnrollment = canonicalEnrollment(deps.listEnrolledRepos());
  if (!thirdEnrollment || JSON.stringify(secondEnrollment) !== JSON.stringify(thirdEnrollment)) {
    return rejected('repository-identity-changed', now, input.assignment, assignment, second, locus);
  }
  const thirdObservations: CortexRelayRepositoryObservation[] = [];
  for (const repoPath of thirdEnrollment) {
    if (input.signal?.aborted) {
      return rejected('cancelled', now, input.assignment, assignment, second, locus);
    }
    const observed = deps.observeRepository(repoPath);
    if (!validObservation(observed, repoPath)) {
      return rejected('repository-identity-changed', now, input.assignment, assignment, second, locus);
    }
    thirdObservations.push(observed);
  }
  if (JSON.stringify(secondObservations) !== JSON.stringify(thirdObservations)) {
    return rejected('repository-identity-changed', now, input.assignment, assignment, second, locus);
  }
  const third = thirdObservations.find((observed) => observed.repoPath === second.repoPath)!;
  const finalNow = deps.now();
  const finalAssignment = parseEngineeringAssignmentV1(input.assignment, { now: finalNow });
  if (!finalAssignment || finalAssignment.assignmentDigest !== assignment.assignmentDigest) {
    return rejected('invalid-assignment', finalNow, input.assignment, assignment, third, locus);
  }
  const finalLocus = deps.observeLocusAuthority(finalAssignment.authority.requiredTenantRef, finalNow);
  if (!finalLocus || JSON.stringify(finalLocus) !== JSON.stringify(locus)) {
    return rejected('locus-authority-invalid', finalNow, input.assignment, assignment, third);
  }
  deps.onPhase?.('repository-revalidated');
  if (input.signal?.aborted) {
    return rejected('cancelled', finalNow, input.assignment, assignment, third, finalLocus);
  }
  const delegationScope = normalizedDelegationScope(assignment, third.repoPath);
  if (delegationScope.origin !== 'cortex-relay-shadow' ||
    delegationScope.sourceRepo !== third.repoPath || delegationScope.executionRoot !== third.repoPath ||
    delegationScope.resultContract?.kind !== 'verified-proposal' ||
    delegationScope.resultContract.requireDiff !== true ||
    delegationScope.resultContract.requireProposal !== true ||
    delegationScope.resultContract.requireVerification !== true ||
    delegationScope.allowedFiles?.enforceWrites !== true ||
    JSON.stringify(delegationScope.allowedFiles.include) !== JSON.stringify(assignment.mission.allowedFiles)) {
    return rejected('delegation-normalization-failed', finalNow, input.assignment, assignment, third, finalLocus);
  }
  return {
    accepted: true,
    assignment,
    repoPath: third.repoPath,
    delegationScope,
    metadata: metadata('eligible', finalNow, input.assignment, assignment, third, finalLocus),
  };
}
