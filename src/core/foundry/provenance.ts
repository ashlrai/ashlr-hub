/**
 * provenance.ts — M47.1: HMAC-signed provenance for inbox proposals (H3).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THREAT MODEL — forged frontier merge-authority on a disk record.           ║
 * ║                                                                            ║
 * ║ merge.ts Gate 4 (evaluateMergeAuthority) trusts proposal.engineTier /      ║
 * ║ proposal.engineModel as read from ~/.ashlr/inbox/<id>.json. The agent MCP  ║
 * ║ surface cannot set those fields (they are stamped server-side), but a      ║
 * ║ LOCAL / in-process writer with filesystem access to the inbox COULD forge  ║
 * ║ a record claiming `{engineTier:'frontier', engineModel:'codex:gpt-5.5'}`   ║
 * ║ paired with an arbitrary diff, and slip it past the authority gate.        ║
 * ║                                                                            ║
 * ║ MITIGATION: the sandboxed producer (the ONLY legitimate origin of a        ║
 * ║ frontier proposal) HMAC-signs `${engineModel}|${engineTier}|${diffHash}`   ║
 * ║ with a host-local secret key (~/.ashlr/foundry/provenance.key, mode 0600)  ║
 * ║ and stores the signature + diffHash on the record. The merge gate          ║
 * ║ re-derives the HMAC and FAILS CLOSED on any mismatch. A forger who cannot  ║
 * ║ read the key cannot mint a valid signature; binding the diff hash into the ║
 * ║ MAC also prevents pairing a stolen signature with a swapped diff.          ║
 * ║                                                                            ║
 * ║ RESIDUAL: an attacker who can READ ~/.ashlr/foundry/provenance.key can     ║
 * ║ sign arbitrary records — the key is only as strong as the filesystem       ║
 * ║ permissions protecting it (0600). This raises the bar from "any local      ║
 * ║ writer" to "an attacker who already owns the user's home dir secrets".     ║
 * ║                                                                            ║
 * ║ INVARIANTS: every exported fn NEVER throws (verify catches → fail-closed); ║
 * ║ comparisons are constant-time; node:crypto only.                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type {
  LocalDefaultBranchRealizedMerge,
  ProposalLocalMergeIntent,
} from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  assurePrivateStoragePath,
  type PrivateStorageKind,
  type PrivateStorageMode,
} from '../util/private-storage.js';

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * In-memory ephemeral key used ONLY as a last-resort fallback when the key file
 * can neither be read nor created (e.g. a read-only home). A signature made with
 * this key will not verify against a freshly-loaded persistent key, so the
 * effect is fail-closed at the merge gate — exactly the safe outcome.
 */
let _ephemeralKey: Buffer | null = null;

/**
 * Absolute path to the provenance HMAC key: ~/.ashlr/foundry/provenance.key.
 * Re-resolved at call time so tests can relocate HOME between invocations.
 */
export function provenanceKeyPath(): string {
  let home: string;
  try {
    home = homedir();
  } catch {
    throw new Error('invalid home directory for provenance key authority');
  }
  if (typeof home !== 'string' || home.length === 0 || !isAbsolute(home)) {
    throw new Error('invalid home directory for provenance key authority');
  }
  const canonical = resolve(home);
  let ancestor = canonical;
  let insideGitWorktree = false;
  for (;;) {
    if (existsSync(join(ancestor, '.git'))) {
      insideGitWorktree = true;
      break;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (canonical === parse(canonical).root || insideGitWorktree) {
    throw new Error('unsafe home directory for provenance key authority');
  }
  return join(canonical, '.ashlr', 'foundry', 'provenance.key');
}

interface OpenStorageDirectory {
  fd: number;
  path: string;
  dev: bigint;
  ino: bigint;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function storageError(keyPath: string, detail: string): Error {
  return new Error(`provenance key at ${keyPath} ${detail}`);
}

function assurePrivatePath(
  keyPath: string,
  path: string,
  kind: PrivateStorageKind,
  mode: PrivateStorageMode,
  anchorPath: string,
): void {
  const assurance = assurePrivateStoragePath(path, kind, mode, { anchorPath });
  if (!assurance.ok) {
    throw storageError(
      keyPath,
      `does not have exact private storage at ${path}: ${assurance.reason}`,
    );
  }
}

function noFollowFlag(): number {
  // O_NOFOLLOW is absent on some supported filesystems/platforms. The lstat to
  // fstat inode binding below remains mandatory even when the flag is missing.
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function assertOwnedMode(
  keyPath: string,
  path: string,
  stat: Stats,
  kind: 'directory' | 'file',
): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) {
    throw storageError(keyPath, `has a ${kind} not owned by the current user: ${path}`);
  }
  if (process.platform !== 'win32') {
    const unsafeMask = kind === 'directory' ? 0o022 : 0o077;
    if ((stat.mode & unsafeMask) !== 0) {
      const expected = kind === 'directory' ? 'not group/world-writable' : '0600';
      throw storageError(
        keyPath,
        `has unsafe permissions for ${kind} at ${path} ` +
        `(mode ${'0o' + (stat.mode & 0o777).toString(8)}); expected ${expected}`,
      );
    }
  }
}

function openStorageDirectory(
  keyPath: string,
  path: string,
  assurance?: { mode: 'secure-created' | 'inspect-existing'; anchorPath: string },
): OpenStorageDirectory {
  const before = lstatSync(path);
  const beforeIdentity = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw storageError(keyPath, `has an unsafe storage directory: ${path}`);
  }
  assertOwnedMode(keyPath, path, before, 'directory');

  const directoryFlag = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | directoryFlag | noFollowFlag());
  try {
    const opened = fstatSync(fd);
    const openedIdentity = fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || openedIdentity.dev !== beforeIdentity.dev ||
      openedIdentity.ino !== beforeIdentity.ino) {
      throw storageError(keyPath, `storage directory changed while opening: ${path}`);
    }
    assertOwnedMode(keyPath, path, opened, 'directory');
    if (assurance) {
      assurePrivatePath(keyPath, path, 'directory', assurance.mode, assurance.anchorPath);
      const assuredOpened = fstatSync(fd);
      const assuredNamed = lstatSync(path);
      const assuredOpenedIdentity = fstatSync(fd, { bigint: true });
      const assuredNamedIdentity = lstatSync(path, { bigint: true });
      if (
        assuredNamed.isSymbolicLink() || !assuredNamed.isDirectory() ||
        assuredOpenedIdentity.dev !== openedIdentity.dev ||
        assuredOpenedIdentity.ino !== openedIdentity.ino ||
        assuredNamedIdentity.dev !== openedIdentity.dev ||
        assuredNamedIdentity.ino !== openedIdentity.ino
      ) {
        throw storageError(keyPath, `storage directory changed during assurance: ${path}`);
      }
      assertOwnedMode(keyPath, path, assuredOpened, 'directory');
      assertOwnedMode(keyPath, path, assuredNamed, 'directory');
    }
    return { fd, path, dev: openedIdentity.dev, ino: openedIdentity.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertStorageDirectoriesStable(
  keyPath: string,
  directories: OpenStorageDirectory[],
): void {
  for (const directory of directories) {
    const held = fstatSync(directory.fd);
    const current = lstatSync(directory.path);
    const heldIdentity = fstatSync(directory.fd, { bigint: true });
    const currentIdentity = lstatSync(directory.path, { bigint: true });
    if (
      current.isSymbolicLink() || !current.isDirectory() ||
      heldIdentity.dev !== directory.dev || heldIdentity.ino !== directory.ino ||
      currentIdentity.dev !== directory.dev || currentIdentity.ino !== directory.ino
    ) {
      throw storageError(keyPath, `storage directory was replaced: ${directory.path}`);
    }
    assertOwnedMode(keyPath, directory.path, held, 'directory');
    assertOwnedMode(keyPath, directory.path, current, 'directory');
  }
}

function closeStorageDirectories(directories: OpenStorageDirectory[]): void {
  for (const directory of directories.reverse()) {
    try { closeSync(directory.fd); } catch { /* best effort */ }
  }
}

function makeStorageDirectoryDurable(
  keyPath: string,
  directory: OpenStorageDirectory,
): void {
  try {
    fsyncDirectory(directory.path, {
      expectedIdentity: {
        dev: directory.dev,
        ino: directory.ino,
      },
    });
  } catch {
    throw storageError(
      keyPath,
      `could not make storage directory durable: ${directory.path}`,
    );
  }
}

function openStorageDirectories(create: boolean): OpenStorageDirectory[] {
  const keyPath = provenanceKeyPath();
  const home = dirname(dirname(dirname(keyPath)));
  const paths = [home, join(home, '.ashlr'), join(home, '.ashlr', 'foundry')];
  const directories: OpenStorageDirectory[] = [];
  try {
    directories.push(openStorageDirectory(keyPath, paths[0]!));
    for (const path of paths.slice(1)) {
      let created = false;
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      directories.push(openStorageDirectory(keyPath, path, {
        mode: created ? 'secure-created' : 'inspect-existing',
        anchorPath: home,
      }));
      if (created) {
        makeStorageDirectoryDurable(keyPath, directories[directories.length - 2]!);
      }
      assertStorageDirectoriesStable(keyPath, directories);
    }
    return directories;
  } catch (error) {
    closeStorageDirectories(directories);
    throw error;
  }
}

function validateKeyFile(
  keyPath: string,
  stat: Stats,
): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw storageError(keyPath, 'is not a private regular file with exactly one link');
  }
  assertOwnedMode(keyPath, keyPath, stat, 'file');
  if (stat.size !== 32) {
    throw storageError(keyPath, `has invalid length ${stat.size}; expected exactly 32 bytes`);
  }
}

function sameKeySnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === right.nlink &&
    left.mode === right.mode && left.uid === right.uid &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
  );
}

function sameKeyIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === right.nlink &&
    left.mode === right.mode && left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
  );
}

function sameKeyFileObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function recoverInstallerLink(
  keyPath: string,
  before: Stats,
  beforeIdentity: BigIntStats,
  directories: OpenStorageDirectory[],
): { stat: Stats; identity: BigIntStats } {
  if (before.nlink !== 2 || !before.isFile()) return { stat: before, identity: beforeIdentity };
  const prefix = `${basename(keyPath)}.`;
  const candidates = readdirSync(dirname(keyPath))
    .filter((name) => name.startsWith(prefix) && /\.[a-f0-9]{24}\.tmp$/.test(name))
    .map((name) => join(dirname(keyPath), name))
    .filter((path) => {
      const stat = lstatSync(path);
      const identity = lstatSync(path, { bigint: true });
      return !stat.isSymbolicLink() && stat.isFile() &&
        identity.dev === beforeIdentity.dev && identity.ino === beforeIdentity.ino;
    });
  if (candidates.length !== 1) return { stat: before, identity: beforeIdentity };
  assertStorageDirectoriesStable(keyPath, directories);
  unlinkSync(candidates[0]!);
  makeStorageDirectoryDurable(keyPath, directories[directories.length - 1]!);
  const recovered = lstatSync(keyPath);
  const recoveredIdentity = lstatSync(keyPath, { bigint: true });
  if (recoveredIdentity.dev !== beforeIdentity.dev ||
    recoveredIdentity.ino !== beforeIdentity.ino || recoveredIdentity.nlink !== 1n) {
    throw storageError(keyPath, 'installer link recovery did not preserve the key inode');
  }
  return { stat: recovered, identity: recoveredIdentity };
}

/** Read the existing protected key without creating signing authority. */
function loadExistingKey(recoverInterruptedInstall = true): Buffer | null {
  const keyPath = provenanceKeyPath();
  let directories: OpenStorageDirectory[] = [];
  let fd: number | undefined;
  try {
    directories = openStorageDirectories(false);
    let before = lstatSync(keyPath);
    let beforeIdentity = lstatSync(keyPath, { bigint: true });
    if (before.isSymbolicLink()) {
      throw storageError(keyPath, 'must not be a symbolic link');
    }
    if (recoverInterruptedInstall) {
      ({ stat: before, identity: beforeIdentity } = recoverInstallerLink(
        keyPath,
        before,
        beforeIdentity,
        directories,
      ));
    }
    validateKeyFile(keyPath, before);

    fd = openSync(keyPath, fsConstants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(fd);
    const openedIdentity = fstatSync(fd, { bigint: true });
    validateKeyFile(keyPath, opened);
    if (!sameKeySnapshot(opened, before) || !sameKeyIdentity(openedIdentity, beforeIdentity)) {
      throw storageError(keyPath, 'was replaced while opening');
    }
    assurePrivatePath(
      keyPath,
      keyPath,
      'file',
      'inspect-existing',
      directories[directories.length - 1]!.path,
    );
    const assuredOpened = fstatSync(fd);
    const assuredNamed = lstatSync(keyPath);
    const assuredOpenedIdentity = fstatSync(fd, { bigint: true });
    const assuredNamedIdentity = lstatSync(keyPath, { bigint: true });
    validateKeyFile(keyPath, assuredOpened);
    validateKeyFile(keyPath, assuredNamed);
    if (!sameKeySnapshot(assuredOpened, opened) || !sameKeySnapshot(assuredNamed, opened) ||
      !sameKeyIdentity(assuredOpenedIdentity, openedIdentity) ||
      !sameKeyIdentity(assuredNamedIdentity, openedIdentity)) {
      throw storageError(keyPath, 'changed during private-storage assurance');
    }

    const key = Buffer.alloc(32);
    let offset = 0;
    while (offset < key.length) {
      const bytesRead = readSync(fd, key, offset, key.length - offset, null);
      if (bytesRead === 0) throw storageError(keyPath, 'was truncated while reading');
      offset += bytesRead;
    }

    const after = fstatSync(fd);
    const current = lstatSync(keyPath);
    const afterIdentity = fstatSync(fd, { bigint: true });
    const currentIdentity = lstatSync(keyPath, { bigint: true });
    validateKeyFile(keyPath, after);
    validateKeyFile(keyPath, current);
    if (
      !sameKeySnapshot(after, opened) ||
      !sameKeySnapshot(current, opened) ||
      !sameKeyIdentity(afterIdentity, openedIdentity) ||
      !sameKeyIdentity(currentIdentity, openedIdentity)
    ) {
      throw storageError(keyPath, 'was replaced or modified while reading');
    }
    assertStorageDirectoriesStable(keyPath, directories);
    return key;
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof Error && error.message.startsWith('provenance key at')) throw error;
    throw storageError(keyPath, 'could not be opened safely');
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    closeStorageDirectories(directories);
  }
}

/**
 * Load the host-local provenance key, creating it on first use.
 *
 * - If the key file exists, read and return its bytes.
 * - Else generate 32 random bytes, `mkdir -p ~/.ashlr/foundry`, and write the
 *   key with mode 0600 via an exclusive temp file + atomic no-clobber link.
 *
 * Unsafe existing storage throws. On creation I/O failure it falls back to a
 * process-lifetime ephemeral key. That fallback is degenerate by design:
 * signatures made with it will not match a persistent key after restart.
 */
export function loadOrCreateKey(): Buffer {
  const keyPath = provenanceKeyPath();
  try {
    const existing = loadExistingKey();
    if (existing) return existing;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('provenance key at')) throw error;
  }

  let directories: OpenStorageDirectory[] = [];
  let tmpFd: number | undefined;
  let tmpPath: string | undefined;
  try {
    directories = openStorageDirectories(true);
    assertStorageDirectoriesStable(keyPath, directories);

    const key = randomBytes(32);
    tmpPath = `${keyPath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    tmpFd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
    const created = fstatSync(tmpFd);
    const createdIdentity = fstatSync(tmpFd, { bigint: true });
    if (!created.isFile() || created.nlink !== 1) {
      throw storageError(keyPath, 'temporary key is not a private regular file');
    }
    assertOwnedMode(keyPath, tmpPath, created, 'file');
    const namedCreated = lstatSync(tmpPath);
    const namedCreatedIdentity = lstatSync(tmpPath, { bigint: true });
    if (
      namedCreated.isSymbolicLink() || !namedCreated.isFile() ||
      !sameKeyIdentity(namedCreatedIdentity, createdIdentity) ||
      namedCreated.nlink !== 1 || namedCreated.size !== 0
    ) {
      throw storageError(keyPath, 'temporary key changed during creation');
    }
    assurePrivatePath(
      keyPath,
      tmpPath,
      'file',
      'secure-created',
      directories[directories.length - 1]!.path,
    );
    const secured = fstatSync(tmpFd);
    const namedSecured = lstatSync(tmpPath);
    const securedIdentity = fstatSync(tmpFd, { bigint: true });
    const namedSecuredIdentity = lstatSync(tmpPath, { bigint: true });
    if (
      !secured.isFile() || secured.nlink !== 1 || secured.size !== 0 ||
      namedSecured.isSymbolicLink() || !namedSecured.isFile() ||
      namedSecured.nlink !== 1 || namedSecured.size !== 0 ||
      !sameKeyFileObject(securedIdentity, createdIdentity) ||
      !sameKeyIdentity(namedSecuredIdentity, securedIdentity)
    ) {
      throw storageError(keyPath, 'temporary key changed during private-storage assurance');
    }
    assertOwnedMode(keyPath, tmpPath, secured, 'file');
    assertOwnedMode(keyPath, tmpPath, namedSecured, 'file');

    let offset = 0;
    while (offset < key.length) {
      const bytesWritten = writeSync(tmpFd, key, offset, key.length - offset, null);
      if (bytesWritten === 0) throw storageError(keyPath, 'temporary key write made no progress');
      offset += bytesWritten;
    }
    fsyncSync(tmpFd);
    const written = fstatSync(tmpFd);
    const writtenIdentity = fstatSync(tmpFd, { bigint: true });
    if (
      written.size !== 32 || written.nlink !== 1 ||
      writtenIdentity.dev !== createdIdentity.dev || writtenIdentity.ino !== createdIdentity.ino ||
      writtenIdentity.size !== 32n || writtenIdentity.nlink !== 1n
    ) {
      throw storageError(keyPath, 'temporary key changed while writing');
    }

    assertStorageDirectoriesStable(keyPath, directories);
    linkSync(tmpPath, keyPath); // Atomic install which fails instead of replacing an existing key.
    try {
      unlinkSync(tmpPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    tmpPath = undefined;

    assurePrivatePath(
      keyPath,
      keyPath,
      'file',
      'inspect-existing',
      directories[directories.length - 1]!.path,
    );
    const installed = fstatSync(tmpFd);
    const current = lstatSync(keyPath);
    const installedIdentity = fstatSync(tmpFd, { bigint: true });
    const currentIdentity = lstatSync(keyPath, { bigint: true });
    validateKeyFile(keyPath, installed);
    validateKeyFile(keyPath, current);
    if (
      !sameKeySnapshot(installed, current) ||
      !sameKeyIdentity(installedIdentity, currentIdentity) ||
      installedIdentity.dev !== writtenIdentity.dev || installedIdentity.ino !== writtenIdentity.ino ||
      installed.dev !== written.dev || installed.ino !== written.ino ||
      installed.size !== written.size || installed.mode !== written.mode ||
      installed.uid !== written.uid || installed.mtimeMs !== written.mtimeMs
    ) {
      throw storageError(keyPath, 'was replaced or modified during creation');
    }
    assertStorageDirectoriesStable(keyPath, directories);
    makeStorageDirectoryDurable(keyPath, directories[directories.length - 1]!);
    assertStorageDirectoriesStable(keyPath, directories);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = loadExistingKey();
      if (existing) return existing;
    }
    if (error instanceof Error && error.message.startsWith('provenance key at')) throw error;
    // Last resort: an ephemeral, process-local key. Persisted records signed
    // with this will NOT verify after a fresh load → fail-closed at merge.
    if (!_ephemeralKey) _ephemeralKey = randomBytes(32);
    return _ephemeralKey;
  } finally {
    if (tmpFd !== undefined) {
      try { closeSync(tmpFd); } catch { /* best effort */ }
    }
    if (tmpPath !== undefined) {
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
    }
    closeStorageDirectories(directories);
  }
}

// ---------------------------------------------------------------------------
// Hashing + signing
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of the diff string. Pure; never throws. */
export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256(key, `${engineModel}|${engineTier}|${diffHash}`) as hex.
 * Binds the trust tuple to a concrete diff so a stolen signature cannot be
 * re-paired with a different diff. Never throws.
 */
export function signProvenance(
  engineModel: string,
  engineTier: string,
  diffHash: string,
): string {
  const key = loadOrCreateKey();
  const payload = `${engineModel}|${engineTier}|${diffHash}`;
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

const EVIDENCE_PACK_PAYLOAD_DOMAIN_V3 = 'ashlr.autonomy-evidence-pack.payload.v3';
const EVIDENCE_PACK_SIGNATURE_DOMAIN_V3 = 'ashlr.autonomy-evidence-pack.signature.v3';
const EVIDENCE_PACK_SEAL_DOMAIN_V3 = 'ashlr.autonomy-evidence-pack.seal.v3';
const EVIDENCE_PACK_SIGNING_KEY_DOMAIN_V3 = 'ashlr.autonomy-evidence-pack.signing-key.v3';
const EVIDENCE_PACK_SIGNING_KEY_ID_DOMAIN_V3 = 'ashlr.autonomy-evidence-pack.signing-key-id.v3';
const SHA256_LOWER_HEX_RE = /^[0-9a-f]{64}$/;

export const EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM = 'hmac-sha256' as const;
export const EVIDENCE_PACK_V3_MAX_CANONICAL_BYTES = 1024 * 1024;
export const EVIDENCE_PACK_V3_MAX_DEPTH = 32;
export const EVIDENCE_PACK_V3_MAX_NODES = 16_384;
export const EVIDENCE_PACK_V3_MAX_STRING_BYTES = 128 * 1024;
export const EVIDENCE_PACK_V3_MAX_CONTAINER_ENTRIES = 4_096;
export const EVIDENCE_PACK_V3_MAX_KEY_BYTES = 256;

type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | {
  [key: string]: CanonicalJsonValue;
};

interface CanonicalJsonState {
  nodes: number;
}

export interface EvidencePackSigningIdentityV3 {
  signatureAlgorithm: typeof EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM;
  signingKeyId: string;
}

export interface EvidencePackPayloadSignatureV3 extends EvidencePackSigningIdentityV3 {
  payloadDigest: string;
  signature: string;
}

interface EvidencePackSigningKeyV3 {
  key: Buffer;
  signatureAlgorithm: typeof EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM;
  signingKeyId: string;
}

function canonicalizeEvidencePackJson(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  state: CanonicalJsonState,
): CanonicalJsonValue {
  state.nodes += 1;
  if (state.nodes > EVIDENCE_PACK_V3_MAX_NODES) {
    throw new TypeError('evidence pack JSON has too many values');
  }
  if (depth > EVIDENCE_PACK_V3_MAX_DEPTH) {
    throw new TypeError('evidence pack JSON is too deeply nested');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > EVIDENCE_PACK_V3_MAX_STRING_BYTES) {
      throw new TypeError('evidence pack JSON string is too large');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('evidence pack JSON numbers must be finite');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('evidence pack payload must be acyclic JSON');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('evidence pack JSON must not contain symbol keys');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > EVIDENCE_PACK_V3_MAX_CONTAINER_ENTRIES) {
        throw new TypeError('evidence pack JSON array is too large');
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes('length')) {
        throw new TypeError('evidence pack JSON arrays must not have extra properties');
      }
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('evidence pack JSON arrays must not be sparse');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError('evidence pack JSON must contain only enumerable data properties');
        }
        return canonicalizeEvidencePackJson(entry, ancestors, depth + 1, state);
      });
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('evidence pack JSON objects must be plain records');
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length > EVIDENCE_PACK_V3_MAX_CONTAINER_ENTRIES) {
      throw new TypeError('evidence pack JSON object has too many fields');
    }
    const output = Object.create(null) as Record<string, CanonicalJsonValue>;
    const keys = [...names].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const key of keys) {
      if (Buffer.byteLength(key, 'utf8') > EVIDENCE_PACK_V3_MAX_KEY_BYTES) {
        throw new TypeError('evidence pack JSON key is too large');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('evidence pack JSON must contain only enumerable data properties');
      }
      output[key] = canonicalizeEvidencePackJson(
        descriptor.value,
        ancestors,
        depth + 1,
        state,
      );
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/** Canonical, key-order-independent JSON for evidence-pack v3 cryptography. */
export function canonicalEvidencePackJsonV3(value: unknown): string | null {
  try {
    const canonical = JSON.stringify(canonicalizeEvidencePackJson(
      value,
      new Set<object>(),
      0,
      { nodes: 0 },
    ));
    return Buffer.byteLength(canonical, 'utf8') <= EVIDENCE_PACK_V3_MAX_CANONICAL_BYTES
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function domainSeparatedDigest(domain: string, value: unknown): string | null {
  const canonical = canonicalEvidencePackJsonV3(value);
  if (canonical === null) return null;
  return createHash('sha256').update(domain, 'utf8').update('\n').update(canonical, 'utf8').digest('hex');
}

function evidencePackSigningKeyV3(provenanceKey: Buffer): EvidencePackSigningKeyV3 {
  const key = createHmac('sha256', provenanceKey)
    .update(EVIDENCE_PACK_SIGNING_KEY_DOMAIN_V3, 'utf8')
    .update('\n')
    .digest();
  const signingKeyId = createHash('sha256')
    .update(EVIDENCE_PACK_SIGNING_KEY_ID_DOMAIN_V3, 'utf8')
    .update('\n')
    .update(key)
    .digest('hex');
  return {
    key,
    signatureAlgorithm: EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM,
    signingKeyId,
  };
}

function evidencePackSignatureV3(
  signingKey: EvidencePackSigningKeyV3,
  payloadDigest: string,
): string {
  return createHmac('sha256', signingKey.key)
    .update(EVIDENCE_PACK_SIGNATURE_DOMAIN_V3, 'utf8')
    .update('\n')
    .update(signingKey.signatureAlgorithm, 'utf8')
    .update('\n')
    .update(signingKey.signingKeyId, 'utf8')
    .update('\n')
    .update(payloadDigest, 'utf8')
    .digest('hex');
}

/** Sign one complete canonical evidence-pack v3 payload. */
export function signEvidencePackPayloadV3(payload: unknown): EvidencePackPayloadSignatureV3 | null {
  try {
    const payloadDigest = domainSeparatedDigest(EVIDENCE_PACK_PAYLOAD_DOMAIN_V3, payload);
    if (!payloadDigest) return null;
    const signingKey = evidencePackSigningKeyV3(loadOrCreateKey());
    const signature = evidencePackSignatureV3(signingKey, payloadDigest);
    return {
      payloadDigest,
      signatureAlgorithm: signingKey.signatureAlgorithm,
      signingKeyId: signingKey.signingKeyId,
      signature,
    };
  } catch {
    return null;
  }
}

/**
 * Verify against the current evidence signing-key generation without creating
 * or repairing key storage. There is intentionally no rotation API yet: a
 * replaced provenance key derives a different signingKeyId, so historical
 * signatures become explicitly unknown until a retired-key keyring is added.
 */
export function verifyEvidencePackPayloadV3(
  payload: unknown,
  payloadDigest: unknown,
  signature: unknown,
  signatureAlgorithm?: unknown,
  signingKeyId?: unknown,
): ProvenanceVerdict {
  try {
    if (typeof payloadDigest !== 'string' || !SHA256_LOWER_HEX_RE.test(payloadDigest)) {
      return { ok: false, reason: 'malformed evidence pack v3 payload digest' };
    }
    if (typeof signature !== 'string' || !SHA256_LOWER_HEX_RE.test(signature)) {
      return { ok: false, reason: 'malformed evidence pack v3 signature' };
    }
    if (signatureAlgorithm === undefined) {
      return { ok: false, reason: 'missing evidence pack v3 signature algorithm' };
    }
    if (typeof signatureAlgorithm !== 'string') {
      return { ok: false, reason: 'malformed evidence pack v3 signature algorithm' };
    }
    if (signatureAlgorithm !== EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM) {
      return { ok: false, reason: 'unsupported evidence pack v3 signature algorithm' };
    }
    if (signingKeyId === undefined) {
      return { ok: false, reason: 'missing evidence pack v3 signing key id' };
    }
    if (typeof signingKeyId !== 'string' || !SHA256_LOWER_HEX_RE.test(signingKeyId)) {
      return { ok: false, reason: 'malformed evidence pack v3 signing key id' };
    }
    const expectedDigest = domainSeparatedDigest(EVIDENCE_PACK_PAYLOAD_DOMAIN_V3, payload);
    if (!expectedDigest || !constantTimeEqual(expectedDigest, payloadDigest)) {
      return { ok: false, reason: 'evidence pack v3 payload digest mismatch' };
    }
    const provenanceKey = loadExistingProvenanceKeyReadOnly();
    if (!provenanceKey) return { ok: false, reason: 'missing evidence pack v3 provenance key' };
    const currentSigningKey = evidencePackSigningKeyV3(provenanceKey);
    if (!constantTimeEqual(currentSigningKey.signingKeyId, signingKeyId)) {
      return { ok: false, reason: 'unknown evidence pack v3 signing key id' };
    }
    const expectedSignature = evidencePackSignatureV3(currentSigningKey, expectedDigest);
    if (!constantTimeEqual(expectedSignature, signature)) {
      return { ok: false, reason: 'evidence pack v3 signature mismatch' };
    }
    return { ok: true, reason: 'evidence pack v3 signature valid' };
  } catch (error) {
    return {
      ok: false,
      reason: `evidence pack v3 verify error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function evidencePackSealInputV3(envelope: unknown): Record<string, unknown> | null {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const prototype = Object.getPrototypeOf(envelope);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(envelope).length > 0) return null;

  const input = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(envelope)) {
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    if (key !== 'sealedPackDigest') input[key] = descriptor.value;
  }
  return input;
}

/**
 * Digest a plain pre-seal or complete evidence-pack envelope, always excluding
 * exactly its own sealedPackDigest field and retaining every other field.
 */
export function sealedEvidencePackDigestV3(envelope: unknown): string | null {
  try {
    const input = evidencePackSealInputV3(envelope);
    return input === null ? null : domainSeparatedDigest(EVIDENCE_PACK_SEAL_DOMAIN_V3, input);
  } catch {
    return null;
  }
}

/** Constant-time verification of the self-excluding complete-pack seal. */
export function verifySealedEvidencePackDigestV3(
  signedPack: unknown,
  sealedPackDigest: unknown,
): ProvenanceVerdict {
  try {
    if (typeof sealedPackDigest !== 'string' || !SHA256_LOWER_HEX_RE.test(sealedPackDigest)) {
      return { ok: false, reason: 'malformed evidence pack v3 sealed pack digest' };
    }
    const expected = sealedEvidencePackDigestV3(signedPack);
    if (!expected || !constantTimeEqual(expected, sealedPackDigest)) {
      return { ok: false, reason: 'evidence pack v3 sealed pack digest mismatch' };
    }
    return { ok: true, reason: 'evidence pack v3 sealed pack digest valid' };
  } catch (error) {
    return {
      ok: false,
      reason: `evidence pack v3 seal verify error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const PRODUCER_PROVENANCE_DOMAIN = 'ashlr.producer-provenance.v2';

export interface ProducerProvenanceV2Fields {
  id: string;
  repo: string | null;
  workItemId?: string;
  workSource?: string;
  engineModel?: string;
  engineTier?: string;
  diff?: string;
  diffHash?: string;
  provenanceSig?: string;
  producerProvenanceVersion?: number;
  producerProvenanceSig?: string;
}

function producerProvenancePayload(p: ProducerProvenanceV2Fields): string | null {
  try {
    if (!p.id || p.id.length > 255 || !p.repo || !p.workItemId || !p.workSource ||
      !p.engineModel || !p.engineTier || !p.diffHash) return null;
    const canonicalRepo = realpathSync(p.repo);
    return JSON.stringify([
      PRODUCER_PROVENANCE_DOMAIN,
      p.id,
      canonicalRepo,
      p.workSource,
      p.workItemId,
      p.engineModel,
      p.engineTier,
      p.diffHash,
    ]);
  } catch {
    return null;
  }
}

/** Sign the complete producer identity used by positive causal learning. */
export function signProducerProvenanceV2(p: ProducerProvenanceV2Fields): string {
  try {
    const payload = producerProvenancePayload(p);
    return payload
      ? createHmac('sha256', loadOrCreateKey()).update(payload, 'utf8').digest('hex')
      : '';
  } catch {
    return '';
  }
}

/**
 * Verify the complete producer identity. Legacy provenance deliberately does
 * not satisfy this contract: it remains lifecycle-visible but cannot create a
 * positive learning label.
 */
export function verifyProducerProvenanceV2(p: ProducerProvenanceV2Fields): ProvenanceVerdict {
  try {
    if (p.producerProvenanceVersion !== 2) {
      return { ok: false, reason: 'missing producer provenance v2' };
    }
    if (!p.producerProvenanceSig) {
      return { ok: false, reason: 'missing producer provenance v2 signature' };
    }
    const legacy = verifyProvenance(p);
    if (!legacy.ok) return legacy;
    const expected = signProducerProvenanceV2(p);
    if (!expected || !constantTimeEqual(expected, p.producerProvenanceSig)) {
      return { ok: false, reason: 'producer provenance v2 signature mismatch' };
    }
    return { ok: true, reason: 'producer provenance v2 signature valid' };
  } catch (err) {
    return {
      ok: false,
      reason: `producer provenance v2 verify error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const LOCAL_MERGE_INTENT_DOMAIN = 'ashlr.local-merge-intent.v1';
const LOCAL_REALIZED_MERGE_DOMAIN = 'ashlr.local-realized-merge.v1';
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const AUTHORIZATION_ID_RE = /^[0-9a-f]{32}$/;

function validIntentFields(intent: Omit<ProposalLocalMergeIntent, 'attestation'>): boolean {
  return intent.schemaVersion === 1 && intent.branch.length > 0 && intent.branch.length <= 255 &&
    intent.base.length > 0 && intent.base.length <= 255 &&
    HEX40_RE.test(intent.baseBeforeOid) && HEX40_RE.test(intent.proposalHeadOid) &&
    HEX64_RE.test(intent.diffHash) && HEX64_RE.test(intent.evidencePackDigest) &&
    AUTHORIZATION_ID_RE.test(intent.authorizationId) && Number.isFinite(Date.parse(intent.authorizedAt));
}

function localMergeIntentPayload(
  proposalId: string,
  repo: string,
  intent: Omit<ProposalLocalMergeIntent, 'attestation'>,
): string | null {
  try {
    if (!proposalId || proposalId.length > 255 || !repo || !validIntentFields(intent)) return null;
    return JSON.stringify([
      LOCAL_MERGE_INTENT_DOMAIN, proposalId, realpathSync(repo), intent.schemaVersion,
      intent.branch, intent.base, intent.baseBeforeOid, intent.proposalHeadOid,
      intent.diffHash, intent.evidencePackDigest, intent.authorizationId, intent.authorizedAt,
    ]);
  } catch {
    return null;
  }
}

export function signLocalMergeIntent(
  proposalId: string,
  repo: string,
  intent: Omit<ProposalLocalMergeIntent, 'attestation'>,
): string {
  try {
    const payload = localMergeIntentPayload(proposalId, repo, intent);
    return payload ? createHmac('sha256', loadOrCreateKey()).update(payload, 'utf8').digest('hex') : '';
  } catch {
    return '';
  }
}

export function verifyLocalMergeIntent(
  proposalId: string,
  repo: string,
  intent: ProposalLocalMergeIntent,
): boolean {
  try {
    if (!HEX64_RE.test(intent.attestation)) return false;
    const { attestation, ...unsigned } = intent;
    const payload = localMergeIntentPayload(proposalId, repo, unsigned);
    const key = payload ? loadExistingKey() : null;
    if (!payload || !key) return false;
    return constantTimeEqual(
      createHmac('sha256', key).update(payload, 'utf8').digest('hex'),
      attestation,
    );
  } catch {
    return false;
  }
}

function localRealizedMergePayload(
  proposalId: string,
  repo: string,
  evidence: Omit<LocalDefaultBranchRealizedMerge, 'attestation'>,
): string | null {
  try {
    if (!proposalId || evidence.proposalId !== proposalId || !repo ||
      typeof evidence.diffHash !== 'string' || typeof evidence.intentAttestation !== 'string' ||
      !HEX40_RE.test(evidence.baseBeforeOid) || !HEX40_RE.test(evidence.proposalHeadOid) ||
      !HEX40_RE.test(evidence.mergeCommitOid) || !HEX64_RE.test(evidence.diffHash) ||
      !HEX64_RE.test(evidence.intentAttestation) || !Number.isFinite(Date.parse(evidence.observedAt))) return null;
    return JSON.stringify([
      LOCAL_REALIZED_MERGE_DOMAIN, proposalId, realpathSync(repo), evidence.schemaVersion,
      evidence.source, evidence.base, evidence.baseBeforeOid, evidence.proposalHeadOid,
      evidence.mergeCommitOid, evidence.observedAt, evidence.diffHash, evidence.intentAttestation,
    ]);
  } catch {
    return null;
  }
}

export function signLocalRealizedMergeReceipt(
  proposalId: string,
  repo: string,
  evidence: Omit<LocalDefaultBranchRealizedMerge, 'attestation'>,
): string {
  try {
    const payload = localRealizedMergePayload(proposalId, repo, evidence);
    return payload ? createHmac('sha256', loadOrCreateKey()).update(payload, 'utf8').digest('hex') : '';
  } catch {
    return '';
  }
}

export function verifyLocalRealizedMergeReceipt(
  proposalId: string,
  repo: string,
  evidence: LocalDefaultBranchRealizedMerge,
): boolean {
  try {
    if (typeof evidence.attestation !== 'string' || !HEX64_RE.test(evidence.attestation)) return false;
    const { attestation, ...unsigned } = evidence;
    const payload = localRealizedMergePayload(proposalId, repo, unsigned);
    const key = payload ? loadExistingKey() : null;
    if (!payload || !key) return false;
    return constantTimeEqual(
      createHmac('sha256', key).update(payload, 'utf8').digest('hex'),
      attestation,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Judge attestation — M157: tamper-proof 'ship' verdict binding
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 over `${proposalId}|${judgeEngine}|${verdict}|${diffHash}` as hex.
 *
 * Binds the judge identity, the verdict, the proposal id, AND the diff hash into
 * one MAC so that:
 *   - A forged ledger entry without the key cannot mint a valid attestation.
 *   - A stolen attestation cannot be replayed for a different proposalId or diff.
 *   - A stale attestation from a different judging run is rejected if any tuple
 *     member changed.
 *
 * Only called for verdict='ship' from a frontier (claude-*) judge.
 * Never throws.
 */
export function signJudgeAttestation(params: {
  proposalId: string;
  judgeEngine: string;
  verdict: string;
  diffHash: string;
  issuedAt?: string;
  mergeIntent?: 'would-merge';
}): string {
  const key = loadOrCreateKey();
  const payload = params.issuedAt !== undefined || params.mergeIntent !== undefined
    ? `ashlr.judge-attestation.v2|${params.proposalId}|${params.judgeEngine}|${params.verdict}|${params.diffHash}|${params.issuedAt ?? ''}|${params.mergeIntent ?? ''}`
    : `${params.proposalId}|${params.judgeEngine}|${params.verdict}|${params.diffHash}`;
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

export interface JudgeAttestationVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a judge attestation produced by `signJudgeAttestation`.
 * FAIL-CLOSED — any missing field, HMAC mismatch, or unexpected error → ok:false.
 *
 * Never throws.
 */
export function verifyJudgeAttestation(
  attestation: string | undefined,
  params: {
    proposalId: string;
    judgeEngine: string;
    verdict: string;
    diffHash: string;
    issuedAt?: string;
    mergeIntent?: 'would-merge';
  },
): JudgeAttestationVerdict {
  try {
    if (!attestation) {
      return { ok: false, reason: 'missing judge attestation' };
    }
    if (!params.proposalId) {
      return { ok: false, reason: 'missing proposalId' };
    }
    if (!params.judgeEngine) {
      return { ok: false, reason: 'missing judgeEngine' };
    }
    if (!params.verdict) {
      return { ok: false, reason: 'missing verdict' };
    }
    if (!params.diffHash) {
      return { ok: false, reason: 'missing diffHash' };
    }
    if (params.issuedAt !== undefined && !Number.isFinite(Date.parse(params.issuedAt))) {
      return { ok: false, reason: 'invalid judge attestation issuedAt' };
    }
    if ((params.issuedAt === undefined) !== (params.mergeIntent === undefined)) {
      return { ok: false, reason: 'incomplete replay-resistant judge attestation fields' };
    }
    const expected = signJudgeAttestation(params);
    if (!constantTimeEqual(expected, attestation)) {
      return { ok: false, reason: 'judge attestation HMAC mismatch — forged or stale attestation' };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `judge attestation verify error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Skill-card attestation - immutable payload binding
// ---------------------------------------------------------------------------

const SKILL_CARD_ATTESTATION_DOMAIN = 'ashlr.skill-card-attestation.v1';
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface SkillCardAttestationParams {
  /** Caller-computed canonical SHA-256 hash of the complete immutable card. */
  contentHash: string;
  skillId: string;
  revision: number;
  proposalId: string;
  diffHash: string;
}

export interface SkillCardAttestationVerdict {
  ok: boolean;
  reason?: string;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function skillCardAttestationInputError(
  params: SkillCardAttestationParams | null | undefined,
): string | undefined {
  if (!params || typeof params !== 'object') {
    return 'missing skill card attestation parameters';
  }

  for (const [name, value] of [
    ['skillId', params.skillId],
    ['proposalId', params.proposalId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) return `missing ${name}`;
    if (value.trim() !== value || hasControlCharacter(value)) return `malformed ${name}`;
  }

  if (!Number.isSafeInteger(params.revision) || params.revision < 1) {
    return 'malformed revision';
  }

  for (const [name, value] of [
    ['contentHash', params.contentHash],
    ['diffHash', params.diffHash],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) return `missing ${name}`;
    if (!SHA256_HEX_RE.test(value)) return `malformed ${name}`;
  }

  return undefined;
}

/**
 * Encode a versioned, domain-separated tuple without the `|` delimiter used by
 * proposal provenance and judge attestations. Base64url framing keeps that
 * delimiter out even when an id itself contains `|`, preventing a legacy
 * proposal signature from being replayed as a skill-card signature.
 */
function skillCardAttestationPayload(params: SkillCardAttestationParams): string {
  const tuple = [
    params.contentHash,
    params.skillId,
    String(params.revision),
    params.proposalId,
    params.diffHash,
  ];
  const encodedTuple = tuple
    .map((value) => Buffer.from(value, 'utf8').toString('base64url'))
    .join('.');
  return `${SKILL_CARD_ATTESTATION_DOMAIN}\n${encodedTuple}`;
}

function computeSkillCardAttestation(params: SkillCardAttestationParams): string {
  return createHmac('sha256', loadOrCreateKey())
    .update(skillCardAttestationPayload(params), 'utf8')
    .digest('hex');
}

/** Return the durable generated key only when its exact format is intact. */
export function loadExistingProvenanceKey(): Buffer | null {
  const key = loadExistingKey();
  return key?.length === 32 ? key : null;
}

/**
 * Strictly read the durable key without repairing interrupted installation.
 * Observation/status callers use this path so a read can never unlink or fsync.
 */
export function loadExistingProvenanceKeyReadOnly(): Buffer | null {
  const key = loadExistingKey(false);
  return key?.length === 32 ? key : null;
}

/**
 * Sign an immutable skill-card payload using the protected provenance key.
 * Returns an empty string instead of minting an ambiguous signature when the
 * caller supplies a missing/malformed tuple or the protected key is unusable.
 */
export function signSkillCardAttestation(params: SkillCardAttestationParams): string {
  try {
    if (skillCardAttestationInputError(params)) return '';
    return computeSkillCardAttestation(params);
  } catch {
    return '';
  }
}

/**
 * Verify an immutable skill-card attestation. Every tuple member is required,
 * both hashes and the MAC must be canonical lowercase SHA-256 hex, and all
 * failures are returned as `ok:false`.
 */
export function verifySkillCardAttestation(
  attestation: string | undefined,
  params: SkillCardAttestationParams,
): SkillCardAttestationVerdict {
  try {
    if (typeof attestation !== 'string' || attestation.length === 0) {
      return { ok: false, reason: 'missing skill card attestation' };
    }
    if (!SHA256_HEX_RE.test(attestation)) {
      return { ok: false, reason: 'malformed skill card attestation' };
    }

    const inputError = skillCardAttestationInputError(params);
    if (inputError) return { ok: false, reason: inputError };

    const key = loadExistingKey();
    if (!key) return { ok: false, reason: 'missing skill card attestation key' };
    const expected = createHmac('sha256', key)
      .update(skillCardAttestationPayload(params), 'utf8')
      .digest('hex');
    if (!constantTimeEqual(expected, attestation)) {
      return { ok: false, reason: 'skill card attestation HMAC mismatch - forged or stale attestation' };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `skill card attestation verify error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Verification (fail-closed)
// ---------------------------------------------------------------------------

export interface ProvenanceVerdict {
  ok: boolean;
  reason: string;
}

/** Constant-time string compare over equal-length hex; false if lengths differ. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual requires equal-length buffers — a length mismatch is itself
  // a non-match, so short-circuit (without leaking timing on the bytes).
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a proposal's signed provenance. FAIL-CLOSED in every doubtful case.
 *
 * Rejects when:
 *  - any of engineModel / engineTier / diff / diffHash / provenanceSig is missing;
 *  - hashDiff(diff) !== diffHash (the stored diff was tampered after signing);
 *  - the recomputed HMAC does not equal provenanceSig (constant-time compare;
 *    a length mismatch counts as a non-match).
 *
 * ok:true ONLY when every check passes. NEVER throws (any error → fail-closed).
 */
export function verifyProvenance(p: {
  engineModel?: string;
  engineTier?: string;
  diff?: string;
  diffHash?: string;
  provenanceSig?: string;
}): ProvenanceVerdict {
  try {
    if (!p.engineModel) {
      return { ok: false, reason: 'missing engineModel' };
    }
    if (!p.engineTier) {
      return { ok: false, reason: 'missing engineTier' };
    }
    if (p.diff === undefined || p.diff === null) {
      return { ok: false, reason: 'missing diff' };
    }
    if (!p.diffHash) {
      return { ok: false, reason: 'missing diffHash' };
    }
    if (!p.provenanceSig) {
      return { ok: false, reason: 'missing provenanceSig' };
    }

    // The stored diff must hash to the recorded diffHash — otherwise the diff
    // was swapped after signing (the signature binds the tuple to diffHash, not
    // to the diff bytes directly).
    const recomputedHash = hashDiff(p.diff);
    if (!constantTimeEqual(recomputedHash, p.diffHash)) {
      return { ok: false, reason: 'diff hash mismatch (diff tampered after signing)' };
    }

    const expectedSig = signProvenance(p.engineModel, p.engineTier, p.diffHash);
    if (!constantTimeEqual(expectedSig, p.provenanceSig)) {
      return { ok: false, reason: 'provenance signature mismatch' };
    }

    return { ok: true, reason: 'provenance signature valid' };
  } catch (err) {
    return {
      ok: false,
      reason: `provenance verify error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
