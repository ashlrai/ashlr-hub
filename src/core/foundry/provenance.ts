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
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
  return join(homedir(), '.ashlr', 'foundry', 'provenance.key');
}

interface OpenStorageDirectory {
  fd: number;
  path: string;
  dev: number;
  ino: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function storageError(keyPath: string, detail: string): Error {
  return new Error(`provenance key at ${keyPath} ${detail}`);
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

function openStorageDirectory(keyPath: string, path: string): OpenStorageDirectory {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw storageError(keyPath, `has an unsafe storage directory: ${path}`);
  }
  assertOwnedMode(keyPath, path, before, 'directory');

  const directoryFlag = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | directoryFlag | noFollowFlag());
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw storageError(keyPath, `storage directory changed while opening: ${path}`);
    }
    assertOwnedMode(keyPath, path, opened, 'directory');
    return { fd, path, dev: opened.dev, ino: opened.ino };
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
    if (
      current.isSymbolicLink() || !current.isDirectory() ||
      held.dev !== directory.dev || held.ino !== directory.ino ||
      current.dev !== directory.dev || current.ino !== directory.ino
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

function openStorageDirectories(create: boolean): OpenStorageDirectory[] {
  const keyPath = provenanceKeyPath();
  const home = homedir();
  const paths = [home, join(home, '.ashlr'), join(home, '.ashlr', 'foundry')];
  const directories: OpenStorageDirectory[] = [];
  try {
    directories.push(openStorageDirectory(keyPath, paths[0]!));
    for (const path of paths.slice(1)) {
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      directories.push(openStorageDirectory(keyPath, path));
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

function recoverInstallerLink(
  keyPath: string,
  before: Stats,
  directories: OpenStorageDirectory[],
): Stats {
  if (before.nlink !== 2 || !before.isFile()) return before;
  const prefix = `${basename(keyPath)}.`;
  const candidates = readdirSync(dirname(keyPath))
    .filter((name) => name.startsWith(prefix) && /\.[a-f0-9]{24}\.tmp$/.test(name))
    .map((name) => join(dirname(keyPath), name))
    .filter((path) => {
      const stat = lstatSync(path);
      return !stat.isSymbolicLink() && stat.isFile() && stat.dev === before.dev && stat.ino === before.ino;
    });
  if (candidates.length !== 1) return before;
  assertStorageDirectoriesStable(keyPath, directories);
  unlinkSync(candidates[0]!);
  try { fsyncSync(directories[directories.length - 1]!.fd); } catch { /* best effort */ }
  const recovered = lstatSync(keyPath);
  if (recovered.dev !== before.dev || recovered.ino !== before.ino || recovered.nlink !== 1) {
    throw storageError(keyPath, 'installer link recovery did not preserve the key inode');
  }
  return recovered;
}

/** Read the existing protected key without creating signing authority. */
function loadExistingKey(recoverInterruptedInstall = true): Buffer | null {
  const keyPath = provenanceKeyPath();
  let directories: OpenStorageDirectory[] = [];
  let fd: number | undefined;
  try {
    directories = openStorageDirectories(false);
    let before = lstatSync(keyPath);
    if (before.isSymbolicLink()) {
      throw storageError(keyPath, 'must not be a symbolic link');
    }
    if (recoverInterruptedInstall) before = recoverInstallerLink(keyPath, before, directories);
    validateKeyFile(keyPath, before);

    fd = openSync(keyPath, fsConstants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(fd);
    validateKeyFile(keyPath, opened);
    if (!sameKeySnapshot(opened, before)) {
      throw storageError(keyPath, 'was replaced while opening');
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
    validateKeyFile(keyPath, after);
    validateKeyFile(keyPath, current);
    if (
      !sameKeySnapshot(after, opened) ||
      !sameKeySnapshot(current, opened)
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
    if (!created.isFile() || created.nlink !== 1) {
      throw storageError(keyPath, 'temporary key is not a private regular file');
    }
    assertOwnedMode(keyPath, tmpPath, created, 'file');

    let offset = 0;
    while (offset < key.length) {
      const bytesWritten = writeSync(tmpFd, key, offset, key.length - offset, null);
      if (bytesWritten === 0) throw storageError(keyPath, 'temporary key write made no progress');
      offset += bytesWritten;
    }
    fsyncSync(tmpFd);
    const written = fstatSync(tmpFd);
    if (
      written.dev !== created.dev || written.ino !== created.ino ||
      written.size !== 32 || written.nlink !== 1
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

    const installed = fstatSync(tmpFd);
    const current = lstatSync(keyPath);
    validateKeyFile(keyPath, installed);
    validateKeyFile(keyPath, current);
    if (
      !sameKeySnapshot(installed, current) ||
      installed.dev !== written.dev || installed.ino !== written.ino ||
      installed.size !== written.size || installed.mode !== written.mode ||
      installed.uid !== written.uid || installed.mtimeMs !== written.mtimeMs
    ) {
      throw storageError(keyPath, 'was replaced or modified during creation');
    }
    assertStorageDirectoriesStable(keyPath, directories);
    try { fsyncSync(directories[directories.length - 1]!.fd); } catch { /* best effort */ }
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
