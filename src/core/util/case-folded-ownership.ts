import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { assurePrivateStoragePath } from './private-storage.js';
import { readStableRegularFile } from './stable-file-read.js';

export const CASE_OWNERSHIP_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_PENDING_CASE_OWNERSHIP_CLAIMS = 1_024;
export const MAX_CASE_OWNERSHIP_METADATA_ENTRIES = 10_000;

const CLAIM_SCHEMA_VERSION = 1;
const MAX_CLAIM_BYTES = 2_048;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_STORE_DIRECTORY_ENTRIES = 20_000;

interface PendingCaseOwnershipClaim {
  schemaVersion: 1;
  id: string;
  foldHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  token: string;
}

export interface CaseOwnershipClaim {
  path: string;
  id: string;
  foldHash: string;
  token: string;
  anchorPath: string;
  legacyPath: string;
}

export class CaseFoldedOwnershipConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaseFoldedOwnershipConflictError';
  }
}

export interface AcquireCaseOwnershipOptions {
  anchorPath: string;
  storeDir: string;
  recordFile: string;
  id: string;
  label: string;
  nowMs?: number;
}

export function isCaseFoldedOwnershipMetadataEntry(name: string): boolean {
  return /^\.id-claim(?:-v1)?-[a-f0-9]{64}$/.test(name);
}

function owned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function foldHash(id: string): string {
  return createHash('sha256').update(id.toLowerCase()).digest('hex');
}

function claimPath(storeDir: string, folded: string): string {
  return join(storeDir, `.id-claim-v1-${folded}`);
}

function writeLockPath(storeDir: string, folded: string): string {
  return join(storeDir, `.write-lock-${folded}`);
}

function strictClaim(value: unknown, nowMs: number): PendingCaseOwnershipClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const claim = value as Record<string, unknown>;
  if (Object.keys(claim).sort().join(',') !==
    'createdAtMs,expiresAtMs,foldHash,id,schemaVersion,token') return null;
  if (
    claim['schemaVersion'] !== CLAIM_SCHEMA_VERSION ||
    typeof claim['id'] !== 'string' || !/^[\w.-]+$/.test(claim['id']) ||
    typeof claim['foldHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(claim['foldHash']) ||
    claim['foldHash'] !== foldHash(claim['id']) ||
    typeof claim['token'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim['token']) ||
    !Number.isSafeInteger(claim['createdAtMs']) ||
    !Number.isSafeInteger(claim['expiresAtMs'])
  ) return null;
  const createdAtMs = Number(claim['createdAtMs']);
  const expiresAtMs = Number(claim['expiresAtMs']);
  if (
    expiresAtMs - createdAtMs !== CASE_OWNERSHIP_RETENTION_MS ||
    createdAtMs > nowMs + MAX_FUTURE_SKEW_MS
  ) return null;
  return claim as unknown as PendingCaseOwnershipClaim;
}

function readClaim(path: string, anchorPath: string, nowMs: number): PendingCaseOwnershipClaim {
  const loaded = readStableRegularFile(path, {
    anchorPath,
    maxFileBytes: MAX_CLAIM_BYTES,
    remainingBytes: MAX_CLAIM_BYTES,
  });
  if (!loaded.ok) throw new Error(`Unsafe case-folded ownership claim: ${loaded.reason}`);
  let parsed: unknown;
  try { parsed = JSON.parse(loaded.text); }
  catch { throw new Error('Invalid case-folded ownership claim'); }
  const claim = strictClaim(parsed, nowMs);
  if (!claim) throw new Error('Invalid case-folded ownership claim');
  return claim;
}

function readLegacyClaim(path: string, anchorPath: string): string {
  const loaded = readStableRegularFile(path, {
    anchorPath,
    maxFileBytes: MAX_CLAIM_BYTES,
    remainingBytes: MAX_CLAIM_BYTES,
  });
  if (!loaded.ok || !/^[\w.-]+$/.test(loaded.text)) {
    throw new Error('Invalid legacy case-folded ownership claim');
  }
  return loaded.text;
}

function writePrivateFile(path: string, value: string, anchorPath: string): void {
  let fd: number | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    const openedBefore = fstatSync(fd);
    if (!openedBefore.isFile() || openedBefore.nlink !== 1 || !owned(openedBefore.uid)) {
      throw new Error('Unsafe ownership claim temporary');
    }
    const assurance = assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath });
    if (!assurance.ok) throw new Error(`Unable to secure ownership claim: ${assurance.reason}`);
    const installed = lstatSync(path);
    const openedAfterAssurance = fstatSync(fd);
    if (
      installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1 ||
      installed.dev !== openedBefore.dev || installed.ino !== openedBefore.ino ||
      openedAfterAssurance.dev !== openedBefore.dev || openedAfterAssurance.ino !== openedBefore.ino
    ) throw new Error('Ownership claim temporary changed during creation');
    const bytes = Buffer.from(value, 'utf8');
    if (writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) {
      throw new Error('Short ownership claim write');
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort before cleanup */ }
      fd = undefined;
    }
    try { unlinkSync(path); } catch { /* best effort after failed creation */ }
    throw error;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function replaceClaim(path: string, claim: PendingCaseOwnershipClaim, anchorPath: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writePrivateFile(tmp, `${JSON.stringify(claim)}\n`, anchorPath);
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or best-effort cleanup */ }
  }
}

function replaceLegacyClaim(path: string, id: string, anchorPath: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writePrivateFile(tmp, id, anchorPath);
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or best-effort cleanup */ }
  }
}

function safelyRemoveRegularFile(path: string): boolean {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || !owned(before.uid)) return false;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) return false;
    closeSync(fd);
    fd = undefined;
    const current = lstatSync(path);
    if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1) return false;
    unlinkSync(path);
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

function pendingClaimFiles(storeDir: string): string[] {
  const claims: string[] = [];
  let entries = 0;
  const handle = opendirSync(storeDir);
  try {
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_STORE_DIRECTORY_ENTRIES) {
        throw new Error('Persistence store directory capacity reached');
      }
      if (/^\.id-claim-v1-[a-f0-9]{64}$/.test(entry.name)) claims.push(entry.name);
    }
  } finally {
    try { handle.closeSync(); } catch { /* best effort bounded enumeration */ }
  }
  return claims;
}

function pruneExpiredClaims(
  storeDir: string,
  anchorPath: string,
  nowMs: number,
): number {
  const files = pendingClaimFiles(storeDir);
  for (const entry of files) {
    const path = join(storeDir, entry);
    const folded = entry.slice('.id-claim-v1-'.length);
    let claim: PendingCaseOwnershipClaim;
    try { claim = readClaim(path, anchorPath, nowMs); }
    catch {
      const recovery = acquireLocalStoreLock(writeLockPath(storeDir, folded), 0);
      if (!recovery) continue;
      try { if (safelyRemoveRegularFile(path)) return files.length - 1; }
      finally { releaseLocalStoreLock(recovery); }
      continue;
    }
    if (claim.expiresAtMs > nowMs) continue;
    const recovery = acquireLocalStoreLock(writeLockPath(storeDir, claim.foldHash), 0);
    if (!recovery) continue;
    try {
      if (safelyRemoveRegularFile(path)) {
        const legacyPath = join(storeDir, `.id-claim-${claim.foldHash}`);
        try {
          if (readLegacyClaim(legacyPath, anchorPath) === claim.id) {
            safelyRemoveRegularFile(legacyPath);
          }
        } catch { /* missing or unsafe compatibility residue remains fail-closed */ }
        return files.length - 1;
      }
    }
    finally { releaseLocalStoreLock(recovery); }
  }
  return files.length;
}

function caseFoldedRecordOwners(storeDir: string, expectedRecord: string): string[] {
  const owners: string[] = [];
  const foldedRecord = expectedRecord.toLowerCase();
  let entries = 0;
  const handle = opendirSync(storeDir);
  try {
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_STORE_DIRECTORY_ENTRIES) {
        throw new Error('Persistence store directory capacity reached');
      }
      if (entry.name.toLowerCase() === foldedRecord) owners.push(entry.name);
    }
  } finally {
    try { handle.closeSync(); } catch { /* best effort bounded enumeration */ }
  }
  return owners;
}

function newClaim(id: string, folded: string, nowMs: number): PendingCaseOwnershipClaim {
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    id,
    foldHash: folded,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + CASE_OWNERSHIP_RETENTION_MS,
    token: randomUUID(),
  };
}

/**
 * Reserve a case-folded id while its first record is being committed.
 * The caller must already hold the matching folded-id write lock.
 */
export function acquireCaseFoldedOwnership(
  options: AcquireCaseOwnershipOptions,
): CaseOwnershipClaim | null {
  const { anchorPath, storeDir, recordFile, id, label } = options;
  const nowMs = options.nowMs ?? Date.now();
  const expectedRecord = basename(recordFile);
  const owners = caseFoldedRecordOwners(storeDir, expectedRecord);
  if (owners.length > 1 || (owners.length === 1 && owners[0] !== expectedRecord)) {
    throw new CaseFoldedOwnershipConflictError(
      `${label} id collides with existing persisted id: ${owners[0] ?? id}`,
    );
  }

  const folded = foldHash(id);
  const path = claimPath(storeDir, folded);
  const legacyPath = join(storeDir, `.id-claim-${folded}`);
  if (owners.length === 1 && !existsSync(legacyPath) && !existsSync(path)) return null;
  const maintenance = acquireLocalStoreLock(join(storeDir, '.id-claims-maintenance-lock'));
  if (!maintenance) throw new Error(`${label} ownership maintenance lock unavailable`);
  try {
    if (owners.length === 1) {
      if (existsSync(path)) {
        const pending = readClaim(path, anchorPath, nowMs);
        if (pending.foldHash === folded) safelyRemoveRegularFile(path);
      }
      if (existsSync(legacyPath)) {
        const legacyId = readLegacyClaim(legacyPath, anchorPath);
        if (foldHash(legacyId) !== folded) throw new Error(`Invalid legacy ${label.toLowerCase()} ownership claim`);
        safelyRemoveRegularFile(legacyPath);
      }
      return null;
    }

    if (existsSync(legacyPath)) {
      const legacyId = readLegacyClaim(legacyPath, anchorPath);
      if (foldHash(legacyId) !== folded) throw new Error(`Invalid legacy ${label.toLowerCase()} ownership claim`);
      if (!existsSync(path)) replaceClaim(path, newClaim(legacyId, folded, nowMs), anchorPath);
    }

    if (existsSync(path)) {
      const pending = readClaim(path, anchorPath, nowMs);
      if (pending.id === id) {
        if (!existsSync(legacyPath)) replaceLegacyClaim(legacyPath, id, anchorPath);
        return { path, id, foldHash: folded, token: pending.token, anchorPath, legacyPath };
      }
      if (pending.expiresAtMs > nowMs) {
        throw new CaseFoldedOwnershipConflictError(
          `${label} id collides with a pending case-folded ownership claim`,
        );
      }
      const replacement = newClaim(id, folded, nowMs);
      replaceLegacyClaim(legacyPath, id, anchorPath);
      replaceClaim(path, replacement, anchorPath);
      return { path, id, foldHash: folded, token: replacement.token, anchorPath, legacyPath };
    }

    const pendingCount = pruneExpiredClaims(storeDir, anchorPath, nowMs);
    if (pendingCount >= MAX_PENDING_CASE_OWNERSHIP_CLAIMS) {
      throw new Error(`${label} pending ownership claim capacity reached`);
    }
    const claim = newClaim(id, folded, nowMs);
    replaceLegacyClaim(legacyPath, id, anchorPath);
    replaceClaim(path, claim, anchorPath);
    return { path, id, foldHash: folded, token: claim.token, anchorPath, legacyPath };
  } finally {
    releaseLocalStoreLock(maintenance);
  }
}

/** Best-effort retirement after the record rename is already committed. */
export function completeCaseFoldedOwnership(claim: CaseOwnershipClaim | null): void {
  if (!claim) return;
  try {
    const current = readClaim(claim.path, claim.anchorPath, Date.now());
    if (current.id === claim.id && current.token === claim.token) {
      safelyRemoveRegularFile(claim.path);
      try {
        const legacyId = readLegacyClaim(claim.legacyPath, claim.anchorPath);
        if (legacyId === claim.id) safelyRemoveRegularFile(claim.legacyPath);
      } catch { /* a later exact-record save retries compatibility cleanup */ }
    }
  } catch { /* committed record remains authoritative; retry cleanup on its next save */ }
}
