import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type {
  Proposal,
  LocalDefaultBranchMergeObservation,
  ProposalLocalMergeIntent,
  ProposalRemoteAuthorityBinding,
  ProposalRemoteHandoff,
  RealizedMergeEvidence,
  RemoteHandoffReconciliation,
} from '../types.js';
import { verifyRemoteHandoffReconciliation } from './remote-handoff-attestation.js';
import { sanitizeGithubMergedAt } from './remote-handoff-time.js';
import {
  verifyLocalMergeIntent,
  verifyLocalRealizedMergeReceipt,
} from '../foundry/provenance.js';
import { resolveGitHubOriginAuthorityDetails } from '../git.js';

const SHA_RE = /^[a-f0-9]{40}$/i;
const ATTESTATION_RE = /^[a-f0-9]{64}$/i;
const MAX_REF_LENGTH = 255;
const MAX_PR_URL_LENGTH = 2_048;
const MAX_FUTURE_SKEW_MS = 60_000;
export const MAX_LOCAL_MERGE_RECOVERY_COMMITS = 256;
const REMOTE_HANDOFF_RECOVERY_MARKER = '[ashlr-remote-handoff-retry:1]';
const AUTHORIZATION_RE = /^[a-f0-9]{32}$/;

const LOCAL_KEYS = new Set([
  'schemaVersion',
  'source',
  'base',
  'baseBeforeOid',
  'proposalHeadOid',
  'mergeCommitOid',
  'observedAt',
  'proposalId',
  'diffHash',
  'intentAttestation',
  'attestation',
]);
const LOCAL_OBSERVATION_KEYS = new Set([
  'schemaVersion', 'source', 'base', 'baseBeforeOid', 'proposalHeadOid', 'mergeCommitOid', 'observedAt',
]);
const GITHUB_KEYS = new Set([
  'schemaVersion',
  'source',
  'provider',
  'prUrl',
  'branch',
  'base',
  'expectedHeadOid',
  'mergeCommitOid',
  'mergedAt',
  'reconciliation',
]);
const RECONCILIATION_KEYS = new Set(['schemaVersion', 'observedAt', 'attestation']);

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null;
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(row);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function boundedRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_REF_LENGTH) return null;
  if (value !== value.trim()) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return null;
  }
  return value;
}

function oid(value: unknown): string | null {
  return typeof value === 'string' && SHA_RE.test(value) ? value.toLowerCase() : null;
}

function timestamp(value: unknown): string | null {
  const sanitized = sanitizeGithubMergedAt(value);
  return sanitized && sanitized.length <= 32 ? sanitized : null;
}

function githubPrUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PR_URL_LENGTH || value !== value.trim()) {
    return null;
  }
  return /^https:\/\/github\.com\/[^/?#\s]+\/[^/?#\s]+\/pull\/[1-9]\d*$/i.test(value) ? value : null;
}

function reconciliationOf(value: unknown): RemoteHandoffReconciliation | null {
  const row = recordOf(value);
  if (!row || !exactKeys(row, RECONCILIATION_KEYS) || row['schemaVersion'] !== 1) return null;
  const observedAt = timestamp(row['observedAt']);
  const attestation = typeof row['attestation'] === 'string' && ATTESTATION_RE.test(row['attestation'])
    ? row['attestation'].toLowerCase()
    : null;
  return observedAt && attestation ? { schemaVersion: 1, observedAt, attestation } : null;
}

/** Return a sanitized evidence value, or null when any field/key is untrusted. */
export function sanitizeRealizedMergeEvidence(value: unknown): RealizedMergeEvidence | null {
  const row = recordOf(value);
  if (!row || row['schemaVersion'] !== 1) return null;

  if (row['source'] === 'local-default-branch') {
    if (!exactKeys(row, LOCAL_KEYS)) return null;
    const base = boundedRef(row['base']);
    const baseBeforeOid = oid(row['baseBeforeOid']);
    const proposalHeadOid = oid(row['proposalHeadOid']);
    const mergeCommitOid = oid(row['mergeCommitOid']);
    const observedAt = timestamp(row['observedAt']);
    const proposalId = boundedRef(row['proposalId']);
    const diffHash = typeof row['diffHash'] === 'string' && ATTESTATION_RE.test(row['diffHash'])
      ? row['diffHash'].toLowerCase() : null;
    const intentAttestation = typeof row['intentAttestation'] === 'string' && ATTESTATION_RE.test(row['intentAttestation'])
      ? row['intentAttestation'].toLowerCase() : null;
    const attestation = typeof row['attestation'] === 'string' && ATTESTATION_RE.test(row['attestation'])
      ? row['attestation'].toLowerCase() : null;
    if (!base || !baseBeforeOid || !proposalHeadOid || !mergeCommitOid || !observedAt ||
      !proposalId || !diffHash || !intentAttestation || !attestation) return null;
    if (mergeCommitOid === baseBeforeOid) return null;
    return {
      schemaVersion: 1,
      source: 'local-default-branch',
      base,
      baseBeforeOid,
      proposalHeadOid,
      mergeCommitOid,
      observedAt,
      proposalId,
      diffHash,
      intentAttestation,
      attestation,
    };
  }

  if (row['source'] === 'github-host') {
    if (!exactKeys(row, GITHUB_KEYS) || row['provider'] !== 'github') return null;
    const prUrl = githubPrUrl(row['prUrl']);
    const branch = boundedRef(row['branch']);
    const base = boundedRef(row['base']);
    const expectedHeadOid = oid(row['expectedHeadOid']);
    const mergeCommitOid = oid(row['mergeCommitOid']);
    const mergedAt = timestamp(row['mergedAt']);
    const reconciliation = reconciliationOf(row['reconciliation']);
    if (!prUrl || !branch || !base || !expectedHeadOid || !mergeCommitOid || !mergedAt || !reconciliation) {
      return null;
    }
    if (Date.parse(reconciliation.observedAt) < Date.parse(mergedAt)) return null;
    return {
      schemaVersion: 1,
      source: 'github-host',
      provider: 'github',
      prUrl,
      branch,
      base,
      expectedHeadOid,
      mergeCommitOid,
      mergedAt,
      reconciliation,
    };
  }

  return null;
}

function sanitizeLocalMergeObservation(value: unknown): RealizedMergeEvidence | null {
  const row = recordOf(value);
  if (!row || row['schemaVersion'] !== 1 || row['source'] !== 'local-default-branch' ||
    !exactKeys(row, LOCAL_OBSERVATION_KEYS)) return null;
  const base = boundedRef(row['base']);
  const baseBeforeOid = oid(row['baseBeforeOid']);
  const proposalHeadOid = oid(row['proposalHeadOid']);
  const mergeCommitOid = oid(row['mergeCommitOid']);
  const observedAt = timestamp(row['observedAt']);
  if (!base || !baseBeforeOid || !proposalHeadOid || !mergeCommitOid || !observedAt ||
    mergeCommitOid === baseBeforeOid) return null;
  return {
    schemaVersion: 1,
    source: 'local-default-branch',
    base,
    baseBeforeOid,
    proposalHeadOid,
    mergeCommitOid,
    observedAt,
  };
}

function exactRemoteBinding(
  proposal: Record<string, unknown>,
  evidence: Extract<RealizedMergeEvidence, { source: 'github-host' }>,
): boolean {
  const repo = proposal['repo'];
  const id = proposal['id'];
  const handoff = recordOf(proposal['remoteHandoff']);
  if (typeof repo !== 'string' || repo.length === 0 || typeof id !== 'string' || id.length === 0 ||
    !handoff || handoff['provider'] !== 'github' || handoff['state'] !== 'merged' ||
    handoff['prUrl'] !== evidence.prUrl || handoff['branch'] !== evidence.branch ||
    handoff['base'] !== evidence.base || handoff['expectedHeadOid'] !== evidence.expectedHeadOid ||
    handoff['mergeCommitOid'] !== evidence.mergeCommitOid || handoff['mergedAt'] !== evidence.mergedAt) {
    return false;
  }
  const reconciliation = reconciliationOf(handoff['reconciliation']);
  if (!reconciliation || JSON.stringify(reconciliation) !== JSON.stringify(evidence.reconciliation)) return false;
  const typedHandoff = handoff as unknown as ProposalRemoteHandoff;
  return exactSignedRemoteAuthority(proposal, typedHandoff, evidence.prUrl) &&
    verifyRemoteHandoffReconciliation(id, repo, typedHandoff);
}

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

function liveRemoteAuthority(repo: string): ProposalRemoteAuthorityBinding | null {
  const authority = resolveGitHubOriginAuthorityDetails(repo);
  if (!authority?.nameWithOwner || authority.pushUrls.length === 0) return null;
  const pushUrls = [...new Set(authority.pushUrls.map(stablePushUrlIdentity))].sort();
  const pushAuthorityDigest = createHash('sha256').update(JSON.stringify([
    'ashlr.github-push-authority.v1',
    authority.nameWithOwner,
    pushUrls,
  ]), 'utf8').digest('hex');
  return { provider: 'github', nameWithOwner: authority.nameWithOwner, pushAuthorityDigest };
}

function exactAuthority(
  left: ProposalRemoteAuthorityBinding | undefined,
  right: ProposalRemoteAuthorityBinding | undefined,
): boolean {
  return Boolean(left && right && left.provider === 'github' && right.provider === 'github' &&
    left.nameWithOwner.length > 0 && left.nameWithOwner === right.nameWithOwner &&
    ATTESTATION_RE.test(left.pushAuthorityDigest) && left.pushAuthorityDigest === right.pushAuthorityDigest);
}

function remoteAuthorizationId(
  phase: 'pre-effect' | 'recovery',
  intent: ProposalLocalMergeIntent,
): string {
  const authority = intent.remoteAuthority;
  if (!authority || !exactAuthority(authority, authority)) return '';
  return createHash('sha256').update(JSON.stringify([
    intent.evidenceProtocol === 'sealed-v3'
      ? 'ashlr.remote-handoff-authorization.sealed-v3.v1'
      : 'ashlr.remote-handoff-authorization.v1',
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
    phase === 'recovery' ? REMOTE_HANDOFF_RECOVERY_MARKER : '',
    ...(intent.evidenceProtocol === 'sealed-v3' ? [intent.evidenceProtocol] : []),
  ]), 'utf8').digest('hex').slice(0, 32);
}

function exactPrRepository(url: string, nameWithOwner: string): boolean {
  const match = url.match(/^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)$/i);
  return Boolean(match?.[1] && match[2] &&
    `${match[1]}/${match[2]}`.toLowerCase() === nameWithOwner.toLowerCase());
}

function exactSignedRemoteAuthority(
  proposal: Record<string, unknown>,
  handoff: ProposalRemoteHandoff,
  prUrl: string,
): boolean {
  try {
    const id = proposal['id'];
    const repo = proposal['repo'];
    const intent = proposal['localMergeIntent'] as ProposalLocalMergeIntent | undefined;
    const recovery = handoff.recovery;
    const phase = recovery === undefined ? 'pre-effect' : 'recovery';
    if (typeof id !== 'string' || typeof repo !== 'string' || !intent || !handoff.authority ||
      !exactAuthority(intent.remoteAuthority, handoff.authority) ||
      !exactAuthority(liveRemoteAuthority(repo) ?? undefined, handoff.authority) ||
      !exactPrRepository(prUrl, handoff.authority.nameWithOwner) ||
      handoff.intentAttestation !== intent.attestation || intent.branch !== handoff.branch ||
      intent.base !== handoff.base || intent.proposalHeadOid.toLowerCase() !== handoff.expectedHeadOid?.toLowerCase() ||
      !verifyLocalMergeIntent(id, repo, intent) || !AUTHORIZATION_RE.test(intent.authorizationId) ||
      intent.authorizationId !== remoteAuthorizationId(phase, intent)) return false;
    return recovery === undefined || (
      recovery.schemaVersion === 1 && recovery.attempt === 1 &&
      recovery.marker === REMOTE_HANDOFF_RECOVERY_MARKER &&
      Number.isFinite(Date.parse(recovery.authorizedAt))
    );
  } catch {
    return false;
  }
}

function exactLocalBinding(
  proposal: Record<string, unknown>,
  evidence: Extract<RealizedMergeEvidence, { source: 'local-default-branch' }>,
): boolean {
  const repo = proposal['repo'];
  const id = proposal['id'];
  const verify = recordOf(proposal['verifyResult']);
  const intent = proposal['localMergeIntent'] as ProposalLocalMergeIntent | undefined;
  return typeof repo === 'string' && repo.length > 0 &&
    typeof id === 'string' && evidence.proposalId !== undefined && id === evidence.proposalId &&
    (proposal['kind'] === 'patch' || proposal['kind'] === 'pr') &&
    typeof proposal['diffHash'] === 'string' && evidence.diffHash !== undefined &&
    proposal['diffHash'] === evidence.diffHash &&
    verify?.['passed'] === true && verify['baseHead'] === evidence.baseBeforeOid &&
    verify['diffHash'] === proposal['diffHash'] &&
    intent !== undefined && evidence.intentAttestation !== undefined && evidence.attestation !== undefined &&
    intent.attestation === evidence.intentAttestation &&
    intent.base === evidence.base && intent.baseBeforeOid === evidence.baseBeforeOid &&
    intent.proposalHeadOid === evidence.proposalHeadOid && intent.diffHash === evidence.diffHash &&
    verifyLocalMergeIntent(id, repo, intent) &&
    verifyLocalRealizedMergeReceipt(id, repo, evidence);
}

/**
 * Project semantic evidence from a proposal already sanitized by the inbox
 * store. Test seams may inject equivalent observations directly. Untrusted
 * disk/network values must use authenticatedRealizedMergeOf instead.
 */
export function realizedMergeOf(value: unknown): RealizedMergeEvidence | null {
  const proposal = recordOf(value);
  if (!proposal || proposal['status'] !== 'applied') return null;
  const evidence = sanitizeRealizedMergeEvidence(proposal['realizedMerge']) ??
    sanitizeLocalMergeObservation(proposal['realizedMerge']);
  return evidence;
}

/**
 * Persistence-boundary verifier. Shape alone is never authority: the witness
 * must bind to this proposal and a local receipt HMAC or host reconciliation.
 */
export function authenticatedRealizedMergeOf(value: unknown): RealizedMergeEvidence | null {
  const proposal = recordOf(value);
  if (!proposal || proposal['status'] !== 'applied') return null;
  const evidence = sanitizeRealizedMergeEvidence(proposal['realizedMerge']);
  if (!evidence) return null;
  const observedAt = evidence.source === 'local-default-branch'
    ? evidence.observedAt
    : evidence.reconciliation.observedAt;
  if (Date.parse(observedAt) > Date.now() + MAX_FUTURE_SKEW_MS) return null;
  return evidence.source === 'local-default-branch'
    ? (exactLocalBinding(proposal, evidence) ? evidence : null)
    : (exactRemoteBinding(proposal, evidence) ? evidence : null);
}

export type CanonicalRealizedMergeIdentity =
  | {
      source: 'github-host';
      repo: string;
      prUrl: string;
      mergeCommitOid: string;
      key: string;
    }
  | {
      source: 'local-default-branch';
      repo: string;
      base: string;
      mergeCommitOid: string;
      key: string;
    };

/**
 * Derive the store-wide uniqueness key only from complete proposal authority.
 * Shape-only evidence and partial proposals never participate in merge credit.
 */
export function canonicalRealizedMergeIdentity(value: unknown): CanonicalRealizedMergeIdentity | null {
  const proposal = recordOf(value);
  if (!proposal || proposal['isPartial'] === true ||
    (proposal['kind'] !== 'patch' && proposal['kind'] !== 'pr')) return null;
  const evidence = authenticatedRealizedMergeOf(proposal);
  if (!evidence) return null;

  if (evidence.source === 'github-host') {
    const match = evidence.prUrl.match(
      /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)$/i,
    );
    if (!match?.[1] || !match[2] || !match[3]) return null;
    const repo = `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    const prUrl = `https://github.com/${repo}/pull/${match[3]}`;
    const mergeCommitOid = evidence.mergeCommitOid.toLowerCase();
    return {
      source: 'github-host',
      repo,
      prUrl,
      mergeCommitOid,
      key: JSON.stringify(['github-host', repo, prUrl, mergeCommitOid]),
    };
  }

  const repo = proposal['repo'];
  if (typeof repo !== 'string' || repo.length === 0 || repo.includes('\0')) return null;
  try {
    const realRepo = realpathSync.native(repo);
    const mergeCommitOid = evidence.mergeCommitOid.toLowerCase();
    return {
      source: 'local-default-branch',
      repo: realRepo,
      base: evidence.base,
      mergeCommitOid,
      key: JSON.stringify(['local-default-branch', realRepo, evidence.base, mergeCommitOid]),
    };
  } catch {
    return null;
  }
}

export function hasRealizedMergeEvidence(value: unknown): value is Proposal & {
  realizedMerge: RealizedMergeEvidence;
} {
  return realizedMergeOf(value) !== null;
}

function gitRead(repo: string, args: readonly string[]): string | null {
  try {
    const env = { ...process.env };
    for (const key of [
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR',
      'GIT_CONFIG_PARAMETERS',
      'GIT_DIR',
      'GIT_INDEX_FILE',
      'GIT_NAMESPACE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_WORK_TREE',
    ]) delete env[key];
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
    }).trim();
  } catch {
    return null;
  }
}

/** Locate the exact ordered merge witness on the base's bounded first-parent history. */
export function findLocalRealizedMergeDescendant(
  repo: string,
  base: string,
  baseBeforeOid: string,
  proposalHeadOid: string,
): string | null {
  if (!repo || repo.includes('\0') || !boundedRef(base) ||
    !SHA_RE.test(baseBeforeOid) || !SHA_RE.test(proposalHeadOid)) return null;
  const currentBase = gitRead(repo, ['rev-parse', '--verify', `refs/heads/${base}`])?.toLowerCase();
  if (!currentBase || currentBase === baseBeforeOid.toLowerCase()) return null;
  const rows = gitRead(repo, [
    'rev-list', '--first-parent', '--parents',
    `--max-count=${MAX_LOCAL_MERGE_RECOVERY_COMMITS}`,
    currentBase,
    `^${baseBeforeOid.toLowerCase()}`,
  ]);
  if (!rows) return null;
  const expectedBase = baseBeforeOid.toLowerCase();
  const expectedHead = proposalHeadOid.toLowerCase();
  for (const row of rows.split(/\r?\n/)) {
    const fields = row.trim().toLowerCase().split(/\s+/);
    if (fields.length === 3 && fields[1] === expectedBase && fields[2] === expectedHead &&
      SHA_RE.test(fields[0] ?? '')) return fields[0]!;
  }
  return null;
}

/**
 * Re-prove a local witness at the persistence boundary. The exact merge must
 * remain on the base's bounded first-parent history and have the verified base
 * and proposal heads as its ordered parents.
 */
export function verifyLocalRealizedMergeEvidence(
  repo: string,
  evidence: RealizedMergeEvidence | LocalDefaultBranchMergeObservation,
  requireCurrentBase = true,
): boolean {
  if (evidence.source !== 'local-default-branch' || !repo || repo.includes('\0')) return false;
  if (requireCurrentBase) {
    const found = findLocalRealizedMergeDescendant(
      repo,
      evidence.base,
      evidence.baseBeforeOid,
      evidence.proposalHeadOid,
    );
    if (found !== evidence.mergeCommitOid) return false;
  }
  const parents = gitRead(repo, ['rev-list', '--parents', '-n', '1', evidence.mergeCommitOid])
    ?.toLowerCase().split(/\s+/);
  return parents?.length === 3 &&
    parents[0] === evidence.mergeCommitOid &&
    parents[1] === evidence.baseBeforeOid &&
    parents[2] === evidence.proposalHeadOid;
}
