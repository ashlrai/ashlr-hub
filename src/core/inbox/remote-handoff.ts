/**
 * remote-handoff.ts — reconcile host-owned PR handoffs back into the inbox.
 *
 * Opening a remote PR is not proof of merge. This module reads host state and
 * advances proposals only when the host provides positive outcome evidence.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  listProposalsDetailed,
  loadProposal,
  recordRealizedMerge,
  setStatus,
  updateProposalField,
} from './store.js';
import type { ProposalSourceQuality } from './store.js';
import type {
  Proposal,
  ProposalLocalMergeIntent,
  ProposalRemoteAuthorityBinding,
  ProposalRemoteHandoff,
} from '../types.js';
import type { PrView } from '../integrations/github.js';
import { resolveGitHubOriginAuthorityDetails } from '../git.js';
import type { GitHubOriginAuthority } from '../git.js';
import { signLocalMergeIntent, verifyLocalMergeIntent } from '../foundry/provenance.js';
import { sanitizeGithubMergedAt } from './remote-handoff-time.js';
import {
  acquireProposalMutationLock,
  releaseProposalMutationLock,
  type ProposalMutationLock,
} from './proposal-mutation-lock.js';
import {
  verifyRemoteHandoffReconciliation,
  viewPrWithReconciliation,
} from './remote-handoff-attestation.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
  type OutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { isEnrolled, killSwitchOn } from '../sandbox/policy.js';

export interface RemoteHandoffReconcileResult {
  checked: number;
  merged: number;
  closed: number;
  open: number;
  unknown: number;
  /** Present only when a proven no-PR state was returned for one bounded retry. */
  recovered?: number;
  /** Present when reconciliation was refused because inbox truth was not authoritative. */
  sourceQuality?: ProposalSourceQuality;
}

export const REMOTE_HANDOFF_RECOVERY_MARKER = '[ashlr-remote-handoff-retry:1]' as const;
const HOST_READ_TIMEOUT_MS = 30_000;
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

type RemoteIntentPhase = 'pre-effect' | 'recovery';

type RemoteBranchEvidence =
  | { kind: 'absent' }
  | { kind: 'exact'; head: string }
  | { kind: 'mismatch'; head: string }
  | { kind: 'unknown' };

function stablePushUrlIdentity(raw: string): string {
  const value = raw.trim();
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

/** Hash effective push destinations without retaining credentials in proposal state. */
export function remotePushAuthorityDigest(authority: GitHubOriginAuthority): string {
  const pushUrls = [...new Set(authority.pushUrls.map(stablePushUrlIdentity))].sort();
  if (!authority.nameWithOwner || pushUrls.length === 0) return '';
  return createHash('sha256').update(JSON.stringify([
    'ashlr.github-push-authority.v1',
    authority.nameWithOwner,
    pushUrls,
  ]), 'utf8').digest('hex');
}

export function remoteAuthorityBinding(
  authority: GitHubOriginAuthority,
): ProposalRemoteAuthorityBinding | null {
  const pushAuthorityDigest = remotePushAuthorityDigest(authority);
  return authority.nameWithOwner && HEX64_RE.test(pushAuthorityDigest)
    ? { provider: 'github', nameWithOwner: authority.nameWithOwner, pushAuthorityDigest }
    : null;
}

function sameAuthority(
  left: ProposalRemoteAuthorityBinding | undefined,
  right: ProposalRemoteAuthorityBinding | undefined,
): boolean {
  return Boolean(left && right && left.provider === 'github' && right.provider === 'github' &&
    left.nameWithOwner.length > 0 &&
    left.nameWithOwner === right.nameWithOwner &&
    left.pushAuthorityDigest === right.pushAuthorityDigest &&
    HEX64_RE.test(left.pushAuthorityDigest));
}

function sameOptionalAuthority(
  left: ProposalRemoteAuthorityBinding | undefined,
  right: ProposalRemoteAuthorityBinding | undefined,
): boolean {
  return left === undefined && right === undefined ? true : sameAuthority(left, right);
}

export function remoteAuthorityMatchesRepo(
  repo: string,
  expected: ProposalRemoteAuthorityBinding,
): boolean {
  const current = resolveGitHubOriginAuthorityDetails(repo);
  const binding = current ? remoteAuthorityBinding(current) : null;
  return sameAuthority(binding ?? undefined, expected);
}

/**
 * The HMAC signer authenticates authorizationId. Deriving that id from the
 * remote fields makes the otherwise-local intent signature bind exact host and
 * push authority without changing the provenance signing format.
 */
export function remoteIntentAuthorizationId(
  phase: RemoteIntentPhase,
  intent: Omit<ProposalLocalMergeIntent, 'attestation' | 'authorizationId'>,
): string {
  const authority = intent.remoteAuthority;
  if (!authority || !sameAuthority(authority, authority)) return '';
  const recoveryMarker = phase === 'recovery' ? REMOTE_HANDOFF_RECOVERY_MARKER : '';
  return createHash('sha256').update(JSON.stringify([
    'ashlr.remote-handoff-authorization.v1',
    phase,
    authority.provider,
    authority.nameWithOwner,
    authority.pushAuthorityDigest,
    intent.schemaVersion,
    intent.branch,
    intent.base,
    intent.baseBeforeOid,
    intent.proposalHeadOid,
    intent.diffHash,
    intent.evidencePackDigest,
    intent.authorizedAt,
    recoveryMarker,
  ]), 'utf8').digest('hex').slice(0, 32);
}

function validRecoveryMarker(handoff: ProposalRemoteHandoff): boolean {
  return handoff.recovery?.schemaVersion === 1 && handoff.recovery.attempt === 1 &&
    handoff.recovery.marker === REMOTE_HANDOFF_RECOVERY_MARKER &&
    Number.isFinite(Date.parse(handoff.recovery.authorizedAt));
}

function intentPhase(handoff: ProposalRemoteHandoff): RemoteIntentPhase {
  return handoff.recovery === undefined ? 'pre-effect' : 'recovery';
}

function verifyStandaloneRemoteIntent(proposal: Proposal, phase: RemoteIntentPhase): boolean {
  try {
    const intent = proposal.localMergeIntent;
    if (!proposal.repo || !intent?.remoteAuthority ||
      !verifyLocalMergeIntent(proposal.id, proposal.repo, intent)) return false;
    const { attestation: _attestation, authorizationId: _authorizationId, ...unsigned } = intent;
    return HEX32_RE.test(intent.authorizationId) &&
      intent.authorizationId === remoteIntentAuthorizationId(phase, unsigned);
  } catch {
    return false;
  }
}

function verifyBoundRemoteIntent(
  proposal: Proposal,
  handoff: ProposalRemoteHandoff,
  phase: RemoteIntentPhase,
): boolean {
  try {
    const intent = proposal.localMergeIntent;
    if (!proposal.repo || !intent || !handoff.authority ||
      !sameAuthority(intent.remoteAuthority, handoff.authority) ||
      handoff.intentAttestation !== intent.attestation ||
      intent.branch !== handoff.branch || intent.base !== handoff.base ||
      intent.proposalHeadOid.toLowerCase() !== handoff.expectedHeadOid?.toLowerCase() ||
      !verifyLocalMergeIntent(proposal.id, proposal.repo, intent)) return false;
    const { attestation: _attestation, authorizationId: _authorizationId, ...unsigned } = intent;
    const expectedAuthorizationId = remoteIntentAuthorizationId(phase, unsigned);
    return HEX32_RE.test(intent.authorizationId) && intent.authorizationId === expectedAuthorizationId;
  } catch {
    return false;
  }
}

/** Narrow daemon eligibility predicate: ordinary approved proposals remain untouched. */
export function isApprovedRemoteHandoffRetryCandidate(proposal: Proposal): boolean {
  try {
    const handoff = proposal.remoteHandoff;
    if (proposal.status !== 'approved' || !proposal.repo) return false;
    if (!handoff) {
      const authority = proposal.localMergeIntent?.remoteAuthority;
      return Boolean(authority && verifyStandaloneRemoteIntent(proposal, 'pre-effect') &&
        remoteAuthorityMatchesRepo(proposal.repo, authority));
    }
    return Boolean(handoff.provider === 'github' && handoff.state === 'unknown' &&
      !handoff.prUrl && validRecoveryMarker(handoff) && handoff.authority &&
      sameAuthority(proposal.localMergeIntent?.remoteAuthority, handoff.authority) &&
      verifyStandaloneRemoteIntent(proposal, 'recovery') &&
      remoteAuthorityMatchesRepo(proposal.repo, handoff.authority));
  } catch {
    return false;
  }
}

function prUrlMatchesAuthority(url: string | undefined, nameWithOwner: string): boolean {
  if (!url) return false;
  const match = url.match(/^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)$/i);
  return Boolean(match?.[1] && match[2] &&
    `${match[1]}/${match[2]}`.toLowerCase() === nameWithOwner.toLowerCase());
}

function outwardAuthorityStillValid(
  proposal: Proposal,
  handoff: ProposalRemoteHandoff,
  fence: OutwardMutationFence,
): boolean {
  if (!proposal.repo || !handoff.authority || !ownsOutwardMutationFence(fence) ||
    killSwitchOn() || !isEnrolled(proposal.repo) ||
    !remoteAuthorityMatchesRepo(proposal.repo, handoff.authority) ||
    !verifyBoundRemoteIntent(proposal, handoff, intentPhase(handoff))) return false;
  return handoff.prUrl === undefined ||
    prUrlMatchesAuthority(handoff.prUrl, handoff.authority.nameWithOwner);
}

function initialResult(): RemoteHandoffReconcileResult {
  return { checked: 0, merged: 0, closed: 0, open: 0, unknown: 0 };
}

function mergeHandoff(
  handoff: ProposalRemoteHandoff,
  patch: Partial<ProposalRemoteHandoff>,
): ProposalRemoteHandoff {
  return {
    ...handoff,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function selectorFor(handoff: ProposalRemoteHandoff): string | null {
  if (handoff.prUrl && handoff.prUrl.trim()) return handoff.prUrl.trim();
  if (handoff.branch && handoff.branch.trim()) return handoff.branch.trim();
  return null;
}

function isMergedState(state: string | undefined): boolean {
  return state?.toLowerCase() === 'merged';
}

function isClosedState(state: string | undefined): boolean {
  return state?.toLowerCase() === 'closed';
}

function hasConflictingIdentity(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  if (handoff.prUrl && pr.url && handoff.prUrl !== pr.url) return true;
  if (handoff.branch && pr.headRefName && handoff.branch !== pr.headRefName) return true;
  if (handoff.base && pr.baseRefName && handoff.base !== pr.baseRefName) return true;
  if (
    handoff.expectedHeadOid && pr.headRefOid &&
    handoff.expectedHeadOid.toLowerCase() !== pr.headRefOid.toLowerCase()
  ) return true;
  return false;
}

function hasStrongIdentity(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  return Boolean(
    handoff.prUrl && pr.url && handoff.prUrl === pr.url &&
    handoff.branch && pr.headRefName && handoff.branch === pr.headRefName &&
    handoff.base && pr.baseRefName && handoff.base === pr.baseRefName &&
    handoff.expectedHeadOid && pr.headRefOid &&
    handoff.expectedHeadOid.toLowerCase() === pr.headRefOid.toLowerCase()
  );
}

/** A URL-less durable intent may bind only a complete observation of its exact PR identity. */
function canBindPrUrl(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  return Boolean(
    !handoff.prUrl && pr.url &&
    handoff.branch && pr.headRefName && handoff.branch === pr.headRefName &&
    handoff.base && pr.baseRefName && handoff.base === pr.baseRefName &&
    handoff.expectedHeadOid && pr.headRefOid &&
    handoff.expectedHeadOid.toLowerCase() === pr.headRefOid.toLowerCase()
  );
}

function sameQueryIdentity(left: ProposalRemoteHandoff, right: ProposalRemoteHandoff): boolean {
  return left.provider === right.provider && left.branch === right.branch &&
    left.base === right.base && left.prUrl === right.prUrl &&
    left.expectedHeadOid === right.expectedHeadOid && left.createdAt === right.createdAt &&
    left.intentAttestation === right.intentAttestation &&
    sameOptionalAuthority(left.authority, right.authority) &&
    left.recovery?.schemaVersion === right.recovery?.schemaVersion &&
    left.recovery?.attempt === right.recovery?.attempt &&
    left.recovery?.marker === right.recovery?.marker &&
    left.recovery?.authorizedAt === right.recovery?.authorizedAt;
}

function awaitingHostMerge(proposal: Proposal | null): proposal is Proposal & {
  remoteHandoff: ProposalRemoteHandoff;
} {
  return proposal?.status === 'awaiting-host-merge' &&
    proposal.remoteHandoff?.state === 'awaiting-host-merge';
}

/** A successful empty host query is evidence of absence; every failure stays unknown. */
function hostProvesNoPr(
  repo: string,
  handoff: ProposalRemoteHandoff,
  authority: GitHubOriginAuthority,
): boolean | null {
  if (!handoff.branch || handoff.branch.length > 255) return null;
  try {
    const raw = execFileSync('gh', [
      'pr', 'list',
      '--repo', authority.nameWithOwner,
      '--head', handoff.branch,
      '--state', 'all',
      '--limit', '2',
      '--json', 'number,url,state,headRefName,headRefOid,baseRefName',
    ], {
      cwd: repo,
      timeout: HOST_READ_TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
      },
    });
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length === 0 : null;
  } catch {
    return null;
  }
}

/** Read the canonical remote ref without mutating local refs. Empty stdout is definite absence. */
function remoteBranchEvidence(
  repo: string,
  handoff: ProposalRemoteHandoff,
  authority: GitHubOriginAuthority,
): RemoteBranchEvidence {
  if (!handoff.branch || !handoff.expectedHeadOid) return { kind: 'unknown' };
  try {
    const ref = `refs/heads/${handoff.branch}`;
    const raw = execFileSync('git', ['-C', repo, 'ls-remote', '--heads', authority.pushUrl, ref], {
      timeout: HOST_READ_TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    if (!raw) return { kind: 'absent' };
    const rows = raw.split(/\r?\n/).filter(Boolean);
    if (rows.length !== 1) return { kind: 'unknown' };
    const [head, observedRef] = rows[0]!.trim().split(/\s+/, 2);
    if (observedRef !== ref || !head || !/^[0-9a-f]{40}$/i.test(head)) return { kind: 'unknown' };
    const normalized = head.toLowerCase();
    return normalized === handoff.expectedHeadOid.toLowerCase()
      ? { kind: 'exact', head: normalized }
      : { kind: 'mismatch', head: normalized };
  } catch {
    return { kind: 'unknown' };
  }
}

function recoverProvenUrlLessIntent(
  proposal: Proposal,
  handoff: ProposalRemoteHandoff,
  branchEvidence: RemoteBranchEvidence,
  authority: GitHubOriginAuthority,
  mutationLock: ProposalMutationLock,
  fence: OutwardMutationFence,
): 'recovered' | 'closed' | 'unknown' {
  const current = loadProposal(proposal.id);
  if (!awaitingHostMerge(current) || current.remoteHandoff.provider !== 'github' ||
    !sameQueryIdentity(handoff, current.remoteHandoff) || current.remoteHandoff.prUrl ||
    !outwardAuthorityStillValid(current, current.remoteHandoff, fence)) return 'unknown';
    const currentBinding = current.remoteHandoff.authority;
    const capturedBinding = remoteAuthorityBinding(authority);
    if (!current.repo || !currentBinding || !capturedBinding ||
      !sameAuthority(currentBinding, capturedBinding) || !remoteAuthorityMatchesRepo(current.repo, currentBinding) ||
      !verifyBoundRemoteIntent(current, current.remoteHandoff, intentPhase(current.remoteHandoff))) {
      return 'unknown';
    }
    if (branchEvidence.kind === 'mismatch') {
      const detail = `remote handoff rejected: host confirmed no PR and staging branch head changed ` +
        `(expected ${handoff.expectedHeadOid}, observed ${branchEvidence.head})`;
      return setStatus(proposal.id, 'rejected', detail, undefined, mutationLock, {
        remoteHandoff: mergeHandoff(current.remoteHandoff, { state: 'closed', detail }),
      }) ? 'closed' : 'unknown';
    }
    if (branchEvidence.kind !== 'absent' && branchEvidence.kind !== 'exact') return 'unknown';

    if (current.remoteHandoff.recovery !== undefined) {
      if (!validRecoveryMarker(current.remoteHandoff)) return 'unknown';
      const detail = `remote handoff recovery exhausted: host again confirmed no PR and ` +
        `staging branch is ${branchEvidence.kind === 'exact' ? 'still exact' : 'absent'}; no merge credited`;
      return setStatus(proposal.id, 'rejected', detail, undefined, mutationLock, {
        remoteHandoff: mergeHandoff(current.remoteHandoff, { state: 'closed', detail }),
      }) ? 'closed' : 'unknown';
    }

    const signedIntent = current.localMergeIntent!;
    const authorizedAt = new Date().toISOString();
    const {
      attestation: _priorAttestation,
      authorizationId: _priorAuthorizationId,
      ...intentWithoutAuthorization
    } = signedIntent;
    const recoveryAuthorizationId = remoteIntentAuthorizationId('recovery', {
      ...intentWithoutAuthorization,
      authorizedAt,
    });
    const unsignedRecoveryIntent: Omit<ProposalLocalMergeIntent, 'attestation'> = {
      ...intentWithoutAuthorization,
      authorizedAt,
      authorizationId: recoveryAuthorizationId,
    };
    const recoveryAttestation = recoveryAuthorizationId
      ? signLocalMergeIntent(current.id, current.repo, unsignedRecoveryIntent)
      : '';
    if (!recoveryAttestation) return 'unknown';
    const recoveryIntent: ProposalLocalMergeIntent = {
      ...unsignedRecoveryIntent,
      attestation: recoveryAttestation,
    };
    const detail = `remote handoff recovery authorized after host confirmed no PR and staging branch ` +
      `${branchEvidence.kind === 'exact' ? 'matches signed intent' : 'is absent'}; ` +
      `one gated retry allowed ${REMOTE_HANDOFF_RECOVERY_MARKER}`;
    if (!updateProposalField(proposal.id, { localMergeIntent: recoveryIntent }, mutationLock)) {
      return 'unknown';
    }
    return setStatus(proposal.id, 'approved', detail, detail, mutationLock, {
      remoteHandoff: mergeHandoff(current.remoteHandoff, {
        state: 'unknown',
        detail,
        intentAttestation: recoveryAttestation,
        recovery: {
          schemaVersion: 1,
          attempt: 1,
          marker: REMOTE_HANDOFF_RECOVERY_MARKER,
          authorizedAt,
        },
      }),
    }) ? 'recovered' : 'unknown';
}

/** Complete the crash window after the signed recovery intent but before its status write. */
function completeInterruptedRecoveryTransition(
  proposal: Proposal,
  handoff: ProposalRemoteHandoff,
  mutationLock: ProposalMutationLock,
  fence: OutwardMutationFence,
): boolean {
  const intent = proposal.localMergeIntent;
  if (!proposal.repo || !intent || handoff.prUrl || handoff.recovery !== undefined ||
    !handoff.authority || !sameAuthority(intent.remoteAuthority, handoff.authority) ||
    intent.branch !== handoff.branch || intent.base !== handoff.base ||
    intent.proposalHeadOid.toLowerCase() !== handoff.expectedHeadOid?.toLowerCase() ||
    !verifyStandaloneRemoteIntent(proposal, 'recovery') || !ownsOutwardMutationFence(fence) ||
    killSwitchOn() || !isEnrolled(proposal.repo) ||
    !remoteAuthorityMatchesRepo(proposal.repo, handoff.authority)) return false;
  const detail = `completed interrupted remote handoff recovery; one gated retry allowed ` +
    REMOTE_HANDOFF_RECOVERY_MARKER;
  return setStatus(proposal.id, 'approved', detail, detail, mutationLock, {
    remoteHandoff: mergeHandoff(handoff, {
      state: 'unknown',
      detail,
      intentAttestation: intent.attestation,
      recovery: {
        schemaVersion: 1,
        attempt: 1,
        marker: REMOTE_HANDOFF_RECOVERY_MARKER,
        authorizedAt: intent.authorizedAt,
      },
    }),
  });
}

function reconcileOne(proposal: Proposal): RemoteHandoffReconcileResult {
  const result = initialResult();
  const handoff = proposal.remoteHandoff;
  if (!handoff || handoff.provider !== 'github') return result;
  result.checked++;

  const repo = proposal.repo;
  const selector = selectorFor(handoff);
  if (!repo || !existsSync(repo) || !selector) {
    result.unknown++;
    return result;
  }
  const mutationLock = acquireProposalMutationLock(proposal.id);
  if (!mutationLock) {
    result.unknown++;
    return result;
  }
  let fence: OutwardMutationFence | null = null;
  try {
    let current = loadProposal(proposal.id);
    if (!awaitingHostMerge(current) || current.remoteHandoff.provider !== 'github' ||
      !sameQueryIdentity(handoff, current.remoteHandoff)) {
      result.unknown++;
      return result;
    }
    fence = acquireOutwardMutationFence();
    const outwardFence = fence;
    if (!outwardFence || !ownsOutwardMutationFence(outwardFence)) {
      result.unknown++;
      return result;
    }

    if (completeInterruptedRecoveryTransition(current, current.remoteHandoff, mutationLock, outwardFence)) {
      result.recovered = 1;
      return result;
    }
    if (!outwardAuthorityStillValid(current, current.remoteHandoff, outwardFence)) {
      result.unknown++;
      return result;
    }

    const authoritativeHandoff = current.remoteHandoff;
    const authority = resolveGitHubOriginAuthorityDetails(repo);
    const binding = authority ? remoteAuthorityBinding(authority) : null;
    if (!authority || !binding || !authoritativeHandoff.authority ||
      !sameAuthority(binding, authoritativeHandoff.authority)) {
      result.unknown++;
      return result;
    }

    const hostRead = viewPrWithReconciliation(repo, selector, proposal.id, authoritativeHandoff);
    if (!hostRead) {
      if (!authoritativeHandoff.prUrl) {
        const noPr = hostProvesNoPr(repo, authoritativeHandoff, authority);
        current = loadProposal(proposal.id);
        if (noPr === true && awaitingHostMerge(current) &&
          sameQueryIdentity(authoritativeHandoff, current.remoteHandoff) &&
          outwardAuthorityStillValid(current, current.remoteHandoff, outwardFence)) {
          const branchEvidence = remoteBranchEvidence(repo, authoritativeHandoff, authority);
          current = loadProposal(proposal.id);
          if (!awaitingHostMerge(current) ||
            !sameQueryIdentity(authoritativeHandoff, current.remoteHandoff) ||
            !outwardAuthorityStillValid(current, current.remoteHandoff, outwardFence)) {
            result.unknown++;
            return result;
          }
          const recovery = recoverProvenUrlLessIntent(
            current,
            current.remoteHandoff,
            branchEvidence,
            authority,
            mutationLock,
            outwardFence,
          );
          if (recovery === 'recovered') result.recovered = 1;
          else if (recovery === 'closed') result.closed++;
          else result.unknown++;
          return result;
        }
      }
      result.unknown++;
      return result;
    }

    const { pr, reconciliation } = hostRead;
    const mergedAt = sanitizeGithubMergedAt(pr.mergedAt);
    const mergeCommitOid = typeof pr.mergeCommitOid === 'string' && /^[0-9a-f]{40}$/i.test(pr.mergeCommitOid)
      ? pr.mergeCommitOid.toLowerCase()
      : undefined;
    const terminal = Boolean(mergedAt || isMergedState(pr.state) || pr.closed === true || isClosedState(pr.state));

    current = loadProposal(proposal.id);
    if (!awaitingHostMerge(current) || !sameQueryIdentity(authoritativeHandoff, current.remoteHandoff) ||
      !outwardAuthorityStillValid(current, current.remoteHandoff, outwardFence)) {
      result.unknown++;
      return result;
    }

    if (!authoritativeHandoff.prUrl) {
      if (!canBindPrUrl(current.remoteHandoff, pr) ||
        !prUrlMatchesAuthority(pr.url, current.remoteHandoff.authority!.nameWithOwner)) {
        result.unknown++;
        return result;
      }
      const detail = `remote PR identity bound; awaiting independent host outcome read: ${pr.url}`;
      if (!updateProposalField(proposal.id, {
        remoteHandoff: mergeHandoff(current.remoteHandoff, {
          state: 'awaiting-host-merge',
          prUrl: pr.url,
          detail,
        }),
      }, mutationLock)) {
        result.unknown++;
        return result;
      }
      if (terminal) result.unknown++;
      else result.open++;
      return result;
    }

    if (hasConflictingIdentity(authoritativeHandoff, pr) ||
      (terminal && !hasStrongIdentity(authoritativeHandoff, pr))) {
      result.unknown++;
      return result;
    }

    if (mergedAt || isMergedState(pr.state)) {
      if (!mergedAt || !mergeCommitOid || !reconciliation) {
        result.unknown++;
        return result;
      }
      if ((current.remoteHandoff.mergedAt !== undefined && current.remoteHandoff.mergedAt !== mergedAt) ||
        (current.remoteHandoff.mergeCommitOid !== undefined && current.remoteHandoff.mergeCommitOid !== mergeCommitOid) ||
        hasConflictingIdentity(current.remoteHandoff, pr) || !hasStrongIdentity(current.remoteHandoff, pr)) {
        result.unknown++;
        return result;
      }
      const detail = `remote PR merged at ${mergedAt}: ${pr.url}`;
      const remoteHandoff = mergeHandoff(current.remoteHandoff, {
        state: 'merged',
        prUrl: pr.url,
        mergedAt,
        mergeCommitOid,
        reconciliation,
        detail,
      });
      if (!current.repo || !outwardAuthorityStillValid(current, current.remoteHandoff, outwardFence) ||
        !verifyRemoteHandoffReconciliation(proposal.id, current.repo, remoteHandoff) ||
        !recordRealizedMerge(proposal.id, {
          schemaVersion: 1,
          source: 'github-host',
          provider: 'github',
          prUrl: remoteHandoff.prUrl!,
          branch: remoteHandoff.branch!,
          base: remoteHandoff.base!,
          expectedHeadOid: remoteHandoff.expectedHeadOid!,
          mergeCommitOid: remoteHandoff.mergeCommitOid!,
          mergedAt: remoteHandoff.mergedAt!,
          reconciliation: remoteHandoff.reconciliation!,
        }, mutationLock, () =>
          outwardAuthorityStillValid(current!, current!.remoteHandoff!, outwardFence))) {
        result.unknown++;
        return result;
      }
      result.merged++;
      return result;
    }

    if (pr.closed === true || isClosedState(pr.state)) {
      if (current.remoteHandoff.mergedAt !== undefined || current.remoteHandoff.mergeCommitOid !== undefined ||
        hasConflictingIdentity(current.remoteHandoff, pr) || !hasStrongIdentity(current.remoteHandoff, pr)) {
        result.unknown++;
        return result;
      }
      const detail = `remote PR closed without merge: ${pr.url}`;
      const remoteHandoff = mergeHandoff(current.remoteHandoff, { state: 'closed', prUrl: pr.url, detail });
      if (!outwardAuthorityStillValid(current, current.remoteHandoff, outwardFence) ||
        !setStatus(proposal.id, 'rejected', detail, undefined, mutationLock, { remoteHandoff })) {
        result.unknown++;
        return result;
      }
      result.closed++;
      return result;
    }

    if (hasConflictingIdentity(current.remoteHandoff, pr)) {
      result.unknown++;
      return result;
    }
    result.open++;
  } finally {
    releaseOutwardMutationFence(fence);
    releaseProposalMutationLock(mutationLock);
  }
  return result;
}

export function reconcileRemoteHandoffs(): RemoteHandoffReconcileResult {
  const result = initialResult();
  try {
    const snapshot = listProposalsDetailed({
      status: 'awaiting-host-merge',
      requireComplete: true,
    });
    if (!snapshot.complete || snapshot.sourceState === 'degraded') {
      const { proposals: _proposals, ...sourceQuality } = snapshot;
      result.sourceQuality = sourceQuality;
      return result;
    }
    for (const proposal of snapshot.proposals) {
      const one = reconcileOne(proposal);
      result.checked += one.checked;
      result.merged += one.merged;
      result.closed += one.closed;
      result.open += one.open;
      result.unknown += one.unknown;
      if (one.recovered) result.recovered = (result.recovered ?? 0) + one.recovered;
    }
  } catch {
    // Never throw from daemon maintenance/readiness paths.
    result.sourceQuality = {
      sourceState: 'degraded',
      sourcePresent: false,
      complete: false,
      stopReasons: ['io-error'],
      filesDiscovered: 0,
      filesRead: 0,
      bytesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 1,
    };
  }
  return result;
}
