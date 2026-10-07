// Trusted bootstrap identity contract: never execute candidate TS/dist to admit artifacts.
import assert from 'node:assert/strict';

export const HUB_REPOSITORY_IDENTITY = Object.freeze({
  repositoryId: 1263526319,
  repositoryNodeId: 'R_kgDOS0_hrw',
  ownerId: 258113726,
  ownerLogin: 'ashlrai',
  defaultBranch: 'master',
  legacyName: 'ashlrai/ashlr-hub',
  renamedName: 'ashlrai/phantom',
});
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

export function requireRepositoryReference(requestedName, raw) {
  const id = HUB_REPOSITORY_IDENTITY; const repo = object(raw); const owner = object(repo?.owner);
  assert.ok((requestedName === id.legacyName || requestedName === id.renamedName)
    && repo?.full_name === requestedName && repo.id === id.repositoryId && repo.node_id === id.repositoryNodeId
    && owner?.id === id.ownerId && owner.login === id.ownerLogin, 'repository reference does not match the reviewed exact identity');
  return Object.freeze({ nameWithOwner: requestedName, repositoryId: id.repositoryId, repositoryNodeId: id.repositoryNodeId, ownerId: id.ownerId, ownerLogin: id.ownerLogin });
}

export function requireRepositoryMetadata(requestedName, raw) {
  const reference = requireRepositoryReference(requestedName, raw);
  assert.ok(raw.default_branch === HUB_REPOSITORY_IDENTITY.defaultBranch && raw.private === false && raw.visibility === 'public', 'repository metadata does not match the reviewed exact identity');
  return Object.freeze({ ...reference, defaultBranch: HUB_REPOSITORY_IDENTITY.defaultBranch });
}

/** Event IDs are capture data; fresh API/reference proof is still required at admission. */
export function requireProducerEnvironment(env) {
  const id = HUB_REPOSITORY_IDENTITY;
  assert.ok(env.GITHUB_REPOSITORY === id.legacyName || env.GITHUB_REPOSITORY === id.renamedName, 'unreviewed producer repository namespace');
  const integer = (value) => { assert.match(value ?? '', /^[1-9][0-9]*$/); const number = Number(value); assert.ok(Number.isSafeInteger(number)); return number; };
  const repositoryId = integer(env.GITHUB_REPOSITORY_ID); const ownerId = integer(env.GITHUB_REPOSITORY_OWNER_ID);
  assert.equal(repositoryId, id.repositoryId, 'producer repository ID differs'); assert.equal(ownerId, id.ownerId, 'producer owner ID differs');
  return Object.freeze({ repository: env.GITHUB_REPOSITORY, repositoryId, ownerId });
}

export function requireManifestProducer(version, producer) {
  assert.ok(version === 1 || version === 2, 'unsupported hosted artifact schema');
  if (version === 1) { assert.equal(producer?.repository, HUB_REPOSITORY_IDENTITY.legacyName, 'legacy artifact namespace differs'); return; }
  assert.ok(producer?.repository === HUB_REPOSITORY_IDENTITY.legacyName || producer?.repository === HUB_REPOSITORY_IDENTITY.renamedName, 'unreviewed artifact namespace');
  assert.equal(producer.repositoryId, HUB_REPOSITORY_IDENTITY.repositoryId, 'artifact repository ID differs');
  assert.equal(producer.ownerId, HUB_REPOSITORY_IDENTITY.ownerId, 'artifact owner ID differs');
}
