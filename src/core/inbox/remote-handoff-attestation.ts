import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync,
  fsyncSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeSync, type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProposalRemoteHandoff, RemoteHandoffReconciliation } from '../types.js';
import { viewPr } from '../integrations/github.js';
import type { PrView } from '../integrations/github.js';
import { resolveGitHubOriginAuthority } from '../git.js';
import { sanitizeGithubMergedAt } from './remote-handoff-time.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

const SHA_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_FUTURE_SKEW_MS = 60_000;
let reconciliationKeyDiagnostic: string | null = null;

export function getRemoteHandoffKeyDiagnostic(): string | null {
  return reconciliationKeyDiagnostic;
}

function privateOwner(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function privateDir(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && privateOwner(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && privateOwner(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function storageHome(): string {
  const configured = process.env.ASHLR_HOME?.trim();
  if (configured && isAbsolute(configured) && ![...configured].some((char) => char.charCodeAt(0) < 32)) {
    try { return resolve(configured); } catch { /* use private default */ }
  }
  return resolve(join(homedir(), '.ashlr'));
}

function reconciliationKeyPath(): string {
  const legacy = join(storageHome(), 'foundry', 'remote-handoff-reconciliation.key');
  if (process.platform !== 'win32' || existsSync(legacy)) return legacy;
  return join(storageHome(), 'foundry', 'reconciliation', 'key');
}

function ensurePrivateDir(path: string, assureWindows = false): Stats {
  const existed = existsSync(path);
  if (!existed) mkdirSync(path, { mode: 0o700 });
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || !privateOwner(before)) {
    throw new Error('unsafe reconciliation key directory');
  }
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (!privateDir(after) || !sameNode(before, after)) throw new Error('reconciliation key directory changed');
  const directoryAssurance = assureWindows ? assurePrivateStoragePath(
    path, 'directory', existed ? 'inspect-existing' : 'secure-created',
    { anchorPath: storageHome() },
  ) : null;
  if (directoryAssurance && !directoryAssurance.ok) {
    reconciliationKeyDiagnostic = directoryAssurance.reason;
    if (!existed) {
      try {
        const failed = lstatSync(path);
        if (sameNode(after, failed)) {
          rmdirSync(path);
          fsyncDirectory(dirname(path));
        }
      } catch { /* retain fail-closed state if cleanup cannot be proven */ }
    }
    throw new Error('reconciliation key directory ACL unavailable');
  }
  const assured = lstatSync(path);
  if (!privateDir(assured) || !sameNode(after, assured)) throw new Error('reconciliation key directory changed');
  return assured;
}

function loadDedicatedKey(create: boolean): Buffer | null {
  reconciliationKeyDiagnostic = null;
  const path = reconciliationKeyPath();
  let fd: number | undefined;
  let uncommitted: Stats | undefined;
  try {
    const root = ensurePrivateDir(storageHome());
    const foundry = ensurePrivateDir(join(storageHome(), 'foundry'));
    if (!privateDir(foundry)) return null;
    if (process.platform === 'win32' && dirname(path) !== join(storageHome(), 'foundry')) {
      ensurePrivateDir(dirname(path), true);
    }
    const rebound = lstatSync(storageHome());
    if (!privateDir(rebound) || !sameNode(root, rebound)) return null;
    if (!existsSync(path) && create) {
      const bytes = randomBytes(32);
      try {
        fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        const opened = fstatSync(fd);
        uncommitted = opened;
        if (!privateFile(opened)) return null;
        const createdAssurance = assurePrivateStoragePath(path, 'file', 'secure-created', {
          anchorPath: storageHome(),
        });
        if (!createdAssurance.ok) {
          reconciliationKeyDiagnostic = createdAssurance.reason;
          return null;
        }
        const assured = lstatSync(path);
        if (!privateFile(assured) || !sameNode(opened, assured) || assured.size !== 0) return null;
        if (writeSync(fd, bytes) !== bytes.length) return null;
        fchmodSync(fd, 0o600);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        const installed = lstatSync(path);
        if (!privateFile(installed) || !sameNode(opened, installed) || installed.size !== 32) return null;
        fsyncDirectory(dirname(path));
        uncommitted = undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      }
    }
    if (!existsSync(path)) return null;
    const named = lstatSync(path);
    if (!privateFile(named) || named.size !== 32) return null;
    const existingAssurance = assurePrivateStoragePath(path, 'file', 'inspect-existing', {
      anchorPath: storageHome(),
    });
    if (!existingAssurance.ok) {
      reconciliationKeyDiagnostic = existingAssurance.reason;
      return null;
    }
    const assured = lstatSync(path);
    if (!privateFile(assured) || !sameNode(named, assured) || assured.size !== named.size) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size !== 32) return null;
    const bytes = Buffer.alloc(32);
    if (readSync(fd, bytes, 0, 32, 0) !== 32) return null;
    const after = fstatSync(fd);
    const reboundFile = lstatSync(path);
    if (!privateFile(after) || !privateFile(reboundFile) || !sameNode(opened, after) ||
      !sameNode(after, reboundFile) || after.size !== 32) return null;
    return bytes;
  } catch { return null; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (uncommitted) {
      try {
        const named = lstatSync(path);
        if (sameNode(uncommitted, named)) {
          unlinkSync(path);
          fsyncDirectory(dirname(path));
        }
      } catch { /* retain fail-closed state if cleanup cannot be proven */ }
    }
  }
}

function payload(
  proposalId: string,
  repo: string,
  handoff: ProposalRemoteHandoff,
  observedAt: string,
): unknown[] | null {
  const mergedAt = sanitizeGithubMergedAt(handoff.mergedAt);
  const observed = sanitizeGithubMergedAt(observedAt);
  if (!proposalId || !repo || handoff.provider !== 'github' || handoff.state !== 'merged' ||
    !handoff.prUrl || !handoff.branch || !handoff.base || !mergedAt || !observed ||
    !SHA_RE.test(handoff.mergeCommitOid ?? '') || !SHA_RE.test(handoff.expectedHeadOid ?? '')) return null;
  if (Date.parse(observed) < Date.parse(mergedAt) || Date.parse(observed) > Date.now() + MAX_FUTURE_SKEW_MS) return null;
  try {
    return [
      'ashlr:remote-handoff-reconciliation:v1', proposalId, resolve(repo), handoff.prUrl,
      handoff.branch, handoff.base, handoff.expectedHeadOid, handoff.mergeCommitOid,
      mergedAt, observed,
    ];
  } catch { return null; }
}

function signature(values: unknown[], createKey = false): string | null {
  try {
    const key = loadDedicatedKey(createKey);
    if (!key) return null;
    return createHmac('sha256', key).update(JSON.stringify(values), 'utf8').digest('hex');
  } catch { return null; }
}

function strongIdentity(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  return Boolean(
    handoff.prUrl && pr.url && handoff.prUrl === pr.url &&
    handoff.branch && pr.headRefName && handoff.branch === pr.headRefName &&
    handoff.base && pr.baseRefName && handoff.base === pr.baseRefName &&
    handoff.expectedHeadOid && pr.headRefOid &&
    handoff.expectedHeadOid.toLowerCase() === pr.headRefOid.toLowerCase()
  );
}

function prUrlMatchesRepository(url: string, nameWithOwner: string): boolean {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/i);
  return Boolean(match?.[1] && match[2] &&
    `${match[1]}/${match[2]}`.toLowerCase() === nameWithOwner.toLowerCase());
}

export interface ReconciledHostRead {
  pr: PrView;
  reconciliation?: RemoteHandoffReconciliation;
}

/** The only signing boundary: first perform a real host read, then bind it. */
export function viewPrWithReconciliation(
  repo: string,
  selector: string,
  proposalId: string,
  handoff: ProposalRemoteHandoff,
): ReconciledHostRead | null {
  const nameWithOwner = resolveGitHubOriginAuthority(repo);
  if (!nameWithOwner) return null;
  const pr = viewPr(repo, selector, { repo: nameWithOwner });
  if (!pr?.url || !prUrlMatchesRepository(pr.url, nameWithOwner)) return null;
  const mergedAt = sanitizeGithubMergedAt(pr.mergedAt);
  const mergeCommitOid = typeof pr.mergeCommitOid === 'string' && SHA_RE.test(pr.mergeCommitOid.toLowerCase())
    ? pr.mergeCommitOid.toLowerCase()
    : undefined;
  if (!mergedAt || !mergeCommitOid || !strongIdentity(handoff, pr)) return { pr };
  const observedAt = new Date().toISOString();
  const mergedHandoff: ProposalRemoteHandoff = {
    ...handoff,
    state: 'merged',
    prUrl: pr.url,
    branch: pr.headRefName,
    base: pr.baseRefName,
    mergeCommitOid,
    mergedAt,
  };
  const values = payload(proposalId, repo, mergedHandoff, observedAt);
  const attestation = values ? signature(values, true) : null;
  return attestation
    ? { pr, reconciliation: { schemaVersion: 1, observedAt, attestation } }
    : { pr };
}

export function verifyRemoteHandoffReconciliation(
  proposalId: string,
  repo: string,
  handoff: ProposalRemoteHandoff,
): boolean {
  const receipt = handoff.reconciliation;
  if (!receipt || receipt.schemaVersion !== 1 || !DIGEST_RE.test(receipt.attestation)) return false;
  if (sanitizeGithubMergedAt(receipt.observedAt) !== receipt.observedAt) return false;
  const values = payload(proposalId, repo, handoff, receipt.observedAt);
  const expected = values ? signature(values) : null;
  if (!expected) return false;
  const left = Buffer.from(receipt.attestation, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sanitizeRemoteHandoffReconciliation(
  proposalId: string | undefined,
  repo: string | null | undefined,
  handoff: ProposalRemoteHandoff,
): RemoteHandoffReconciliation | undefined {
  return proposalId && repo && verifyRemoteHandoffReconciliation(proposalId, repo, handoff)
    ? handoff.reconciliation
    : undefined;
}
