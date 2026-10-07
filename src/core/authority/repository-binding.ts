/**
 * The reviewed Hub → Phantom rename keeps one GitHub repository identity.
 * Labels are conservative self-protection hints, never transferable authority:
 * an effect must independently verify fresh metadata for its EXACT granted name.
 * In particular, GitHub's old-name redirect is not a new-name standing grant.
 */
import { STANDING_GRANT_PATTERNS } from './types.js';

export const HUB_REPOSITORY_IDENTITY = Object.freeze({
  repositoryId: 1263526319,
  repositoryNodeId: 'R_kgDOS0_hrw',
  ownerId: 258113726,
  ownerLogin: 'ashlrai',
  defaultBranch: 'master',
  legacyName: 'ashlrai/ashlr-hub',
  renamedName: 'ashlrai/phantom',
});

export type HubRepositoryLabel = 'ashlrai/ashlr-hub' | 'ashlrai/phantom';

/** Conservative self treatment ONLY; this does not prove numeric identity. */
export function isHubRepositoryLabel(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === HUB_REPOSITORY_IDENTITY.legacyName || normalized === HUB_REPOSITORY_IDENTITY.renamedName;
}

export interface HubRepositoryReference {
  readonly nameWithOwner: HubRepositoryLabel;
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly ownerId: number;
  readonly ownerLogin: string;
}

export interface HubRepositoryBinding extends HubRepositoryReference {
  readonly defaultBranch: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Validate the minimal repository identity returned in a PR base reference. */
export function requireHubRepositoryReference(requestedName: string, raw: unknown): Readonly<HubRepositoryReference> {
  const identity = HUB_REPOSITORY_IDENTITY;
  const repo = record(raw);
  const owner = record(repo?.['owner']);
  if ((requestedName !== identity.legacyName && requestedName !== identity.renamedName)
    || repo?.['full_name'] !== requestedName
    || repo['id'] !== identity.repositoryId || repo['node_id'] !== identity.repositoryNodeId
    || owner?.['id'] !== identity.ownerId || owner['login'] !== identity.ownerLogin) {
    throw new TypeError('Repository metadata does not match the reviewed exact Hub identity.');
  }
  return Object.freeze({ nameWithOwner: requestedName, repositoryId: identity.repositoryId,
    repositoryNodeId: identity.repositoryNodeId, ownerId: identity.ownerId, ownerLogin: identity.ownerLogin });
}

/** Validate a freshly fetched GitHub /repos response; no redirect/alias fallback. */
export function requireHubRepositoryMetadata(requestedName: string, raw: unknown): Readonly<HubRepositoryBinding> {
  const reference = requireHubRepositoryReference(requestedName, raw);
  const repo = record(raw)!;
  if (repo['default_branch'] !== HUB_REPOSITORY_IDENTITY.defaultBranch || repo['private'] !== false || repo['visibility'] !== 'public') {
    throw new TypeError('Repository metadata does not match the reviewed exact Hub identity.');
  }
  return Object.freeze({ ...reference, defaultBranch: HUB_REPOSITORY_IDENTITY.defaultBranch });
}

/**
 * A checkout hint, not metadata proof. Only standard GitHub HTTPS, SSH URL
 * and scp-style origins are accepted; credentials, ports and decorations fail.
 */
export function githubRepositoryFromRemote(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(remote.trim());
  if (!match) return null;
  if (match[2] === '.' || match[2] === '..') return null;
  const name = `${match[1]}/${match[2]}`;
  return STANDING_GRANT_PATTERNS.nameWithOwner.test(name) ? name : null;
}
