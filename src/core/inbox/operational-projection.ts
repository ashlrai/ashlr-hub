import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  opendirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import type { Proposal, ProposalStatus } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import {
  classifyOperationalProposalMembership,
  type OperationalProposalMembershipType,
} from './operational-membership.js';
import {
  inboxDir,
  listProposalsDetailed,
  loadProposal,
} from './store.js';
import {
  ownsProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from './proposal-mutation-lock.js';

export const OPERATIONAL_PROPOSAL_PROJECTION_SCHEMA_VERSION = 1 as const;

const MAX_MEMBERS = 4_096;
const MAX_MIGRATION_INPUTS = 65_536;
const MAX_NAMESPACE_ENTRIES = 8_192;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_PROPOSAL_BYTES = 64 * 1024 * 1024;
const MAX_MIGRATION_TOTAL_BYTES = 256 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const PROPOSAL_STATUSES = new Set<ProposalStatus>([
  'pending',
  'approved',
  'rejected',
  'awaiting-host-merge',
  'applied',
  'failed',
]);

const PROPOSAL_DIGEST_DOMAIN = 'ashlr.operational-proposal-projection.proposal.v1';
const MEMBERS_DIGEST_DOMAIN = 'ashlr.operational-proposal-projection.members.v1';
const SIGNING_KEY_DOMAIN = 'ashlr.operational-proposal-projection.signing-key.v1';
const AUTHORITY_ID_DOMAIN = 'ashlr.operational-proposal-projection.authority.v1';
const PROJECTION_ID_DOMAIN = 'ashlr.operational-proposal-projection.id.v1';
const PROJECTION_DIGEST_DOMAIN = 'ashlr.operational-proposal-projection.seal.v1';

export type OperationalProposalClass = Exclude<OperationalProposalMembershipType, null>;

const OPERATIONAL_PROPOSAL_CLASSES = new Set<OperationalProposalClass>([
  'lifecycle',
  'realized-merge-fanout',
  'rejected-partial-recovery',
]);

export interface OperationalProposalProjectionMemberV1 {
  proposalId: string;
  class: OperationalProposalClass;
  status: ProposalStatus;
  createdAt: string;
  expiresAt?: string;
  proposalBytes: number;
  proposalDigest: string;
}

export interface OperationalProposalProjectionV1 {
  schemaVersion: 1;
  generation: number;
  projectionId: string;
  previousProjectionDigest: string | null;
  members: OperationalProposalProjectionMemberV1[];
  membersDigest: string;
  authorityId: string;
  projectionDigest: string;
}

export type OperationalProposalProjectionDegradedReason =
  | 'legacy-unmigrated'
  | 'legacy-source-unavailable'
  | 'projection-unavailable'
  | 'projection-invalid'
  | 'provenance-key-unavailable'
  | 'projection-integrity-failed'
  | 'proposal-source-unavailable'
  | 'proposal-member-mismatch'
  | 'store-lock-not-owned'
  | 'migration-input-invalid'
  | 'projection-write-failed';

export type OperationalProposalsReadResult =
  | {
    state: 'cold-start';
    proposals: [];
    projection: null;
  }
  | {
    state: 'healthy';
    proposals: Proposal[];
    projection: OperationalProposalProjectionV1;
  }
  | {
    state: 'degraded';
    reason: OperationalProposalProjectionDegradedReason;
    proposals: [];
    projection: null;
  };

export interface ReadOperationalProposalsOptions {
  status?: ProposalStatus;
}

export interface MigrateOperationalProposalProjectionOptions {
  proposals: Proposal[];
  storeLock: ProposalStoreMutationLock;
  nowMs?: number;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('invalid JSON value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse JSON array');
        const canonical = canonicalize(entry, ancestors);
        if (canonical === undefined) throw new TypeError('undefined JSON array entry');
        return canonical;
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('non-plain JSON object');
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const canonical = canonicalize(entry, ancestors);
      if (canonical !== undefined) output[key] = canonical;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  const canonical = canonicalize(value, new Set<object>());
  if (canonical === undefined) throw new TypeError('undefined root JSON value');
  return JSON.stringify(canonical);
}

function sha256(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function hmac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function projectionSigningKey(provenanceKey: Buffer): Buffer {
  return createHmac('sha256', provenanceKey)
    .update(SIGNING_KEY_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .digest();
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validProposalId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && PROPOSAL_ID_RE.test(value) &&
    value !== '.' && value !== '..';
}

function validProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === 'string' && PROPOSAL_STATUSES.has(value as ProposalStatus);
}

function readProposalNamespaceIds(): string[] | null {
  const dir = inboxDir();
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(dir, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  if (!safePrivatePath(dirname(dir), 'directory', 0o700) ||
    !safePrivatePath(dir, 'directory', 0o700)) return null;

  const ids: string[] = [];
  let entries = 0;
  const handle = opendirSync(dir);
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      entries += 1;
      if (entries > MAX_NAMESPACE_ENTRIES) return null;
      if (entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) {
        const id = entry.name.slice(0, -'.json'.length);
        if (!validProposalId(id) || entry.name !== `${id}.json`) return null;
        ids.push(id);
      }
      entry = handle.readSync();
    }
  } finally {
    handle.closeSync();
  }

  try {
    const after = lstatSync(dir, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return null;
  } catch {
    return null;
  }
  ids.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return ids;
}

function migrationNamespaceIsComplete(proposals: Proposal[]): boolean {
  try {
    const expectedIds = proposals.map(({ id }) => id)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const before = readProposalNamespaceIds();
    if (!before || before.length !== expectedIds.length ||
      before.some((id, index) => id !== expectedIds[index])) return false;
    let totalBytes = 0;
    for (const proposal of proposals) {
      const current = loadProposal(proposal.id);
      if (!current) return false;
      const currentJson = canonicalJson(current);
      if (currentJson !== canonicalJson(proposal)) return false;
      totalBytes += Buffer.byteLength(currentJson, 'utf8');
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_MIGRATION_TOTAL_BYTES) return false;
    }
    const after = readProposalNamespaceIds();
    return after !== null && after.length === before.length &&
      after.every((id, index) => id === before[index]);
  } catch {
    return false;
  }
}

function validClass(value: unknown): value is OperationalProposalClass {
  return typeof value === 'string' &&
    OPERATIONAL_PROPOSAL_CLASSES.has(value as OperationalProposalClass);
}

function validMember(value: unknown): value is OperationalProposalProjectionMemberV1 {
  if (!isPlainRecord(value)) return false;
  const expiresAtPresent = Object.hasOwn(value, 'expiresAt');
  if (!hasExactKeys(value, [
    'proposalId', 'class', 'status', 'createdAt',
    ...(expiresAtPresent ? ['expiresAt'] : []),
    'proposalBytes', 'proposalDigest',
  ])) return false;
  return validProposalId(value['proposalId']) && validClass(value['class']) &&
    validProposalStatus(value['status']) && canonicalTimestamp(value['createdAt']) &&
    (!expiresAtPresent || canonicalTimestamp(value['expiresAt'])) &&
    Number.isSafeInteger(value['proposalBytes']) && Number(value['proposalBytes']) > 0 &&
    Number(value['proposalBytes']) <= MAX_PROPOSAL_BYTES &&
    typeof value['proposalDigest'] === 'string' && SHA256_RE.test(value['proposalDigest']);
}

function parseManifest(text: string): OperationalProposalProjectionV1 | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainRecord(value) || !hasExactKeys(value, [
      'schemaVersion', 'generation', 'projectionId', 'previousProjectionDigest',
      'members', 'membersDigest', 'authorityId', 'projectionDigest',
    ])) return null;
    if (value['schemaVersion'] !== OPERATIONAL_PROPOSAL_PROJECTION_SCHEMA_VERSION ||
      !Number.isSafeInteger(value['generation']) || Number(value['generation']) < 1 ||
      typeof value['projectionId'] !== 'string' || !SHA256_RE.test(value['projectionId']) ||
      (value['previousProjectionDigest'] !== null &&
        (typeof value['previousProjectionDigest'] !== 'string' || !SHA256_RE.test(value['previousProjectionDigest']))) ||
      !Array.isArray(value['members']) || value['members'].length > MAX_MEMBERS ||
      typeof value['membersDigest'] !== 'string' || !SHA256_RE.test(value['membersDigest']) ||
      typeof value['authorityId'] !== 'string' || !SHA256_RE.test(value['authorityId']) ||
      typeof value['projectionDigest'] !== 'string' || !SHA256_RE.test(value['projectionDigest'])) return null;
    if (!value['members'].every(validMember)) return null;
    let totalBytes = 0;
    let previousId: string | undefined;
    for (const member of value['members']) {
      if (previousId !== undefined && member.proposalId <= previousId) return null;
      previousId = member.proposalId;
      totalBytes += member.proposalBytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_PROPOSAL_BYTES) return null;
    }
    return value as unknown as OperationalProposalProjectionV1;
  } catch {
    return null;
  }
}

function unsignedProjection(projection: OperationalProposalProjectionV1): Omit<OperationalProposalProjectionV1, 'projectionDigest'> {
  const { projectionDigest: _projectionDigest, ...unsigned } = projection;
  return unsigned;
}

function expectedAuthorityId(key: Buffer): string {
  return hmac(key, AUTHORITY_ID_DOMAIN, { schemaVersion: 1 });
}

function expectedProjectionId(
  key: Buffer,
  generation: number,
  previousProjectionDigest: string | null,
  membersDigest: string,
): string {
  return hmac(key, PROJECTION_ID_DOMAIN, {
    schemaVersion: 1,
    generation,
    previousProjectionDigest,
    membersDigest,
  });
}

function verifyManifest(projection: OperationalProposalProjectionV1, key: Buffer): boolean {
  const membersDigest = sha256(MEMBERS_DIGEST_DOMAIN, projection.members);
  const authorityId = expectedAuthorityId(key);
  const projectionId = expectedProjectionId(
    key,
    projection.generation,
    projection.previousProjectionDigest,
    projection.membersDigest,
  );
  const projectionDigest = hmac(key, PROJECTION_DIGEST_DOMAIN, unsignedProjection(projection));
  return equalDigest(membersDigest, projection.membersDigest) &&
    equalDigest(authorityId, projection.authorityId) &&
    equalDigest(projectionId, projection.projectionId) &&
    equalDigest(projectionDigest, projection.projectionDigest);
}

function safePrivatePath(path: string, kind: 'file' | 'directory', exactMode: number): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || (kind === 'file'
      ? !stat.isFile() || stat.nlink !== 1n
      : !stat.isDirectory())) return false;
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return false;
    if (process.platform !== 'win32' && Number(stat.mode & 0o777n) !== exactMode) return false;
    return assurePrivateStoragePath(path, kind, 'inspect-existing', {
      anchorPath: homedir(),
    }).ok;
  } catch {
    return false;
  }
}

function legacyState(): OperationalProposalsReadResult {
  const legacy = listProposalsDetailed({ maxFiles: 1, requireComplete: false });
  if (legacy.filesDiscovered > 0) {
    return { state: 'degraded', reason: 'legacy-unmigrated', proposals: [], projection: null };
  }
  if (legacy.sourceState === 'degraded') {
    return { state: 'degraded', reason: 'legacy-source-unavailable', proposals: [], projection: null };
  }
  return { state: 'cold-start', proposals: [], projection: null };
}

function readProjectionFile():
  | { state: 'missing' }
  | { state: 'ok'; projection: OperationalProposalProjectionV1; key: Buffer }
  | { state: 'degraded'; reason: OperationalProposalProjectionDegradedReason } {
  const path = operationalProposalProjectionPath();
  try {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { state: 'degraded', reason: 'projection-unavailable' };
      }
      const root = dirname(operationalProposalProjectionDir());
      try {
        lstatSync(root);
        if (!safePrivatePath(root, 'directory', 0o700)) {
          return { state: 'degraded', reason: 'projection-unavailable' };
        }
      } catch (rootError) {
        if ((rootError as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
        return { state: 'degraded', reason: 'projection-unavailable' };
      }
      try {
        lstatSync(operationalProposalProjectionDir());
        if (!safePrivatePath(operationalProposalProjectionDir(), 'directory', 0o700)) {
          return { state: 'degraded', reason: 'projection-unavailable' };
        }
      } catch (directoryError) {
        if ((directoryError as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { state: 'degraded', reason: 'projection-unavailable' };
        }
      }
      return { state: 'missing' };
    }
    if (!safePrivatePath(dirname(operationalProposalProjectionDir()), 'directory', 0o700) ||
      !safePrivatePath(operationalProposalProjectionDir(), 'directory', 0o700) ||
      !safePrivatePath(path, 'file', 0o600)) {
      return { state: 'degraded', reason: 'projection-unavailable' };
    }
    const read = readStableRegularFile(path, {
      anchorPath: homedir(),
      maxFileBytes: MAX_MANIFEST_BYTES,
      remainingBytes: MAX_MANIFEST_BYTES,
    });
    if (!read.ok) return { state: 'degraded', reason: 'projection-unavailable' };
    const projection = parseManifest(read.text);
    if (!projection) return { state: 'degraded', reason: 'projection-invalid' };
    let key: Buffer | null;
    try { key = loadExistingProvenanceKeyReadOnly(); } catch { key = null; }
    if (!key || key.length !== 32) {
      return { state: 'degraded', reason: 'provenance-key-unavailable' };
    }
    if (!verifyManifest(projection, projectionSigningKey(key))) {
      return { state: 'degraded', reason: 'projection-integrity-failed' };
    }
    return { state: 'ok', projection, key };
  } catch {
    return { state: 'degraded', reason: 'projection-unavailable' };
  }
}

function proposalIdentityMatches(proposal: Proposal, member: OperationalProposalProjectionMemberV1): boolean {
  return proposal.id === member.proposalId && proposal.status === member.status &&
    proposal.createdAt === member.createdAt;
}

function readOperationalProposalsAt(
  options: ReadOperationalProposalsOptions,
  nowMs: number,
): OperationalProposalsReadResult {
  const manifestRead = readProjectionFile();
  if (manifestRead.state === 'missing') return legacyState();
  if (manifestRead.state === 'degraded') {
    return { state: 'degraded', reason: manifestRead.reason, proposals: [], projection: null };
  }

  const proposals: Proposal[] = [];
  let remainingBytes = MAX_TOTAL_PROPOSAL_BYTES;
  for (const member of manifestRead.projection.members) {
    if (member.expiresAt !== undefined && Date.parse(member.expiresAt) < nowMs) continue;
    const proposalPath = join(inboxDir(), `${member.proposalId}.json`);
    if (!safePrivatePath(dirname(inboxDir()), 'directory', 0o700) ||
      !safePrivatePath(inboxDir(), 'directory', 0o700) ||
      !safePrivatePath(proposalPath, 'file', 0o600)) {
      return { state: 'degraded', reason: 'proposal-source-unavailable', proposals: [], projection: null };
    }
    const read = readStableRegularFile(proposalPath, {
      anchorPath: homedir(),
      maxFileBytes: MAX_PROPOSAL_BYTES,
      remainingBytes,
    });
    if (!read.ok) {
      return { state: 'degraded', reason: 'proposal-source-unavailable', proposals: [], projection: null };
    }
    remainingBytes -= read.bytesRead;
    try {
      const parsed: unknown = JSON.parse(read.text);
      if (!isPlainRecord(parsed)) throw new TypeError('proposal is not an object');
      const canonical = canonicalJson(parsed);
      const proposalBytes = Buffer.byteLength(canonical, 'utf8');
      const proposalDigest = sha256(PROPOSAL_DIGEST_DOMAIN, parsed);
      const proposal = parsed as unknown as Proposal;
      const classified = classifyOperationalProposalMembership(proposal, new Date(nowMs));
      if (proposalBytes !== member.proposalBytes ||
        !equalDigest(proposalDigest, member.proposalDigest) ||
        !proposalIdentityMatches(proposal, member) ||
        classified.class !== 'active' || classified.type !== member.class ||
        (classified.expiresAt ?? undefined) !== member.expiresAt) {
        throw new TypeError('projection member does not match proposal');
      }
      if (options.status === undefined || proposal.status === options.status) proposals.push(proposal);
    } catch {
      return { state: 'degraded', reason: 'proposal-member-mismatch', proposals: [], projection: null };
    }
  }
  return { state: 'healthy', proposals, projection: manifestRead.projection };
}

/** Absolute private directory containing the current operational projection. */
export function operationalProposalProjectionDir(): string {
  const home = homedir();
  if (!isAbsolute(home)) throw new Error('invalid home directory for proposal projection');
  return join(resolve(home), '.ashlr', 'proposal-projection');
}

/** Absolute path to the sealed V1 operational proposal projection. */
export function operationalProposalProjectionPath(): string {
  return join(operationalProposalProjectionDir(), 'current.json');
}

/** Read the sealed projection without creating, repairing, locking, or rewriting storage. */
export function readOperationalProposals(
  options: ReadOperationalProposalsOptions = {},
): OperationalProposalsReadResult {
  if (options.status !== undefined && !validProposalStatus(options.status)) {
    return { state: 'degraded', reason: 'projection-invalid', proposals: [], projection: null };
  }
  return readOperationalProposalsAt(options, Date.now());
}

function ensurePrivateDirectory(path: string, anchorPath: string): void {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (process.platform !== 'win32' && created) chmodSync(path, 0o700);
  if (!safePrivatePath(path, 'directory', 0o700)) throw new Error('unsafe projection directory');
  const assurance = assurePrivateStoragePath(
    path,
    'directory',
    created ? 'secure-created' : 'inspect-existing',
    { anchorPath },
  );
  if (!assurance.ok) throw new Error(`unsafe projection directory: ${assurance.reason}`);
  if (created) fsyncDirectory(dirname(path));
}

function projectionMember(proposal: Proposal, nowMs: number):
  | { state: 'excluded' }
  | { state: 'invalid' }
  | { state: 'included'; member: OperationalProposalProjectionMemberV1 } {
  const classified = classifyOperationalProposalMembership(proposal, new Date(nowMs));
  if (classified.class === 'excluded') return { state: 'excluded' };
  if (classified.class === 'invalid' || classified.type === null) return { state: 'invalid' };
  const canonical = canonicalJson(proposal);
  const proposalBytes = Buffer.byteLength(canonical, 'utf8');
  if (proposalBytes <= 0 || proposalBytes > MAX_PROPOSAL_BYTES) return { state: 'invalid' };
  const member: OperationalProposalProjectionMemberV1 = {
    proposalId: proposal.id,
    class: classified.type,
    status: proposal.status,
    createdAt: proposal.createdAt,
    ...(classified.expiresAt !== null ? { expiresAt: classified.expiresAt } : {}),
    proposalBytes,
    proposalDigest: sha256(PROPOSAL_DIGEST_DOMAIN, proposal),
  };
  return validMember(member) ? { state: 'included', member } : { state: 'invalid' };
}

function degraded(reason: OperationalProposalProjectionDegradedReason): OperationalProposalsReadResult {
  return { state: 'degraded', reason, proposals: [], projection: null };
}

/**
 * Seal one explicitly complete proposal generation while the caller owns the
 * global proposal-store writer lock. Proposal files are observational inputs;
 * this function writes only the projection directory and manifest.
 *
 * This is an offline bootstrap primitive, not live proposal authority. Runtime
 * consumers must remain on the complete legacy reader until proposal writes and
 * projection publication share a crash-recoverable transaction and an external
 * monotonic anchor can reject replay of an older valid generation.
 */
export function migrateOperationalProposalProjection(
  options: MigrateOperationalProposalProjectionOptions,
): OperationalProposalsReadResult {
  if (!ownsProposalStoreMutationLock(options.storeLock)) return degraded('store-lock-not-owned');
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(nowMs) || !Array.isArray(options.proposals) ||
    options.proposals.length > MAX_MIGRATION_INPUTS) return degraded('migration-input-invalid');

  let key: Buffer | null;
  try { key = loadExistingProvenanceKeyReadOnly(); } catch { key = null; }
  if (!key || key.length !== 32) return degraded('provenance-key-unavailable');
  const signingKey = projectionSigningKey(key);

  const current = readProjectionFile();
  if (current.state === 'degraded') return degraded(current.reason);
  const generation = current.state === 'ok' ? current.projection.generation + 1 : 1;
  if (!Number.isSafeInteger(generation)) return degraded('migration-input-invalid');

  try {
    const seen = new Set<string>();
    const members: OperationalProposalProjectionMemberV1[] = [];
    for (const proposal of options.proposals) {
      if (!isPlainRecord(proposal) || !validProposalId(proposal.id) || seen.has(proposal.id)) {
        return degraded('migration-input-invalid');
      }
      seen.add(proposal.id);
      const projected = projectionMember(proposal, nowMs);
      if (projected.state === 'invalid') return degraded('migration-input-invalid');
      if (projected.state === 'included') members.push(projected.member);
    }
    if (members.length > MAX_MEMBERS || !migrationNamespaceIsComplete(options.proposals)) {
      return degraded('migration-input-invalid');
    }
    members.sort((left, right) => left.proposalId < right.proposalId ? -1 : left.proposalId > right.proposalId ? 1 : 0);
    const totalBytes = members.reduce((total, member) => total + member.proposalBytes, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_PROPOSAL_BYTES) {
      return degraded('migration-input-invalid');
    }

    const previousProjectionDigest = current.state === 'ok'
      ? current.projection.projectionDigest
      : null;
    const membersDigest = sha256(MEMBERS_DIGEST_DOMAIN, members);
    const base = {
      schemaVersion: OPERATIONAL_PROPOSAL_PROJECTION_SCHEMA_VERSION,
      generation,
      projectionId: expectedProjectionId(signingKey, generation, previousProjectionDigest, membersDigest),
      previousProjectionDigest,
      members,
      membersDigest,
      authorityId: expectedAuthorityId(signingKey),
    };
    const projection: OperationalProposalProjectionV1 = {
      ...base,
      projectionDigest: hmac(signingKey, PROJECTION_DIGEST_DOMAIN, base),
    };
    const json = `${canonicalJson(projection)}\n`;
    if (Buffer.byteLength(json, 'utf8') > MAX_MANIFEST_BYTES) return degraded('migration-input-invalid');

    const home = resolve(homedir());
    const ashlrRoot = dirname(operationalProposalProjectionDir());
    ensurePrivateDirectory(ashlrRoot, home);
    ensurePrivateDirectory(operationalProposalProjectionDir(), ashlrRoot);
    const temporaryPath = join(
      operationalProposalProjectionDir(),
      `.current.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
    );
    writePrivateFileAtomically(temporaryPath, operationalProposalProjectionPath(), json, {
      anchorPath: operationalProposalProjectionDir(),
      label: 'operational proposal projection',
    });
    return readOperationalProposalsAt({}, nowMs);
  } catch {
    return degraded('projection-write-failed');
  }
}
