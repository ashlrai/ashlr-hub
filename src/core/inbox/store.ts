/**
 * store.ts — Proposal persistence for the M23 approval inbox.
 *
 * Persists one proposal per file at ~/.ashlr/inbox/<id>.json.
 *
 * GUARDRAILS:
 *  - PURE PERSISTENCE: never applies anything, never mutates a repo, never
 *    auto-advances status. Status changes happen through setStatus() or the
 *    evidence-gated recordRealizedMerge() writer.
 *  - Never throws: all exported functions swallow errors and return safe
 *    defaults (null / [] / 0) so callers remain unblocked.
 *  - Atomic write: write to <id>.json.tmp then rename, matching the pattern
 *    in core/portfolio/backlog.ts.
 *  - No secrets stored: diffs contain user-owned code (fine); tokens/keys are
 *    not proposal fields. audit() strips secrets defensively on its side.
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type {
  AshlrConfig,
  LocalDefaultBranchMergeObservation,
  LocalDefaultBranchRealizedMerge,
  Proposal,
  ProposalStatus,
  RealizedMergeEvidence,
} from '../types.js';
import { audit } from '../sandbox/audit.js';
import { emitFleetEvent } from '../integrations/pulse-sync.js';
import type { FleetEvent } from '../integrations/pulse-exporter.js';
// M119: decisions ledger hook — additive, never-throws, no behavior change.
import { readDecisionsDetailed, recordDecision } from '../fleet/decisions-ledger.js';
import { linkOutcome } from '../fleet/judge-trace.js';
// M158: destructive-diff pre-judge guard — additive, DEFAULT ON, never-throws.
import { isDestructiveDiff } from '../run/diff-safety.js';
import { causalMetadata, causalMetadataFromProposal } from '../learning/causal.js';
import { canonicalizeProposalDiff, scrubSecrets } from '../util/scrub.js';
import { fsyncDirectory } from '../util/durability.js';
import { canonicalFilesystemPathIdentity } from '../sandbox/policy.js';
import { proposalCompletesGoalMilestone } from '../goals/completion.js';
import { isPostMergeCreditReleaseLabel } from '../fleet/post-merge-credit.js';
// M228: goal-milestone outcome wiring — additive, best-effort, never-throws.
// Imported here (not goals/advance.ts) because inbox/store does NOT import from
// goals/* anywhere, so this import creates no cycle. goals/advance.ts imports
// inbox/store.ts (one direction only).
import * as goalStore from '../goals/store.js';
import {
  acquireProposalStoreMutationLock,
  acquireProposalMutationLock,
  ownsProposalStoreMutationLock,
  ownsProposalMutationLock,
  releaseProposalStoreMutationLock,
  releaseProposalMutationLock,
  type ProposalMutationLock,
  type ProposalStoreMutationLock,
} from './proposal-mutation-lock.js';
import { sanitizeGithubMergedAt } from './remote-handoff-time.js';
import {
  sanitizeRemoteHandoffReconciliation,
  verifyRemoteHandoffReconciliation,
} from './remote-handoff-attestation.js';
import {
  authenticatedRealizedMergeOf,
  canonicalRealizedMergeIdentity,
  sanitizeRealizedMergeEvidence,
  verifyLocalRealizedMergeEvidence,
} from './realized-merge.js';
import {
  signProducerProvenanceV2,
  signLocalRealizedMergeReceipt,
  verifyProvenance,
  verifyLocalMergeIntent,
} from '../foundry/provenance.js';
import { pruneQueuedSelfHealItems } from '../fleet/self-heal-queue-prune.js';
import { proposalRepairId } from '../fleet/proposal-repair-identity.js';
import {
  PROPOSAL_PERSISTENCE_MISMATCH_REASON,
  PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
} from './persistence-mismatch.js';

const MAX_REALIZED_MERGE_FUTURE_SKEW_MS = 60_000;
const AUTHORITATIVE_PROPOSAL_MAX_FILE_BYTES = 4 * 1024 * 1024;
const REALIZED_MERGE_FANOUT_VERSION = 3;

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call-time so tests can relocate HOME)
// ---------------------------------------------------------------------------

/**
 * Absolute path to the inbox directory: ~/.ashlr/inbox.
 * Created lazily by createProposal / setStatus — this function does NOT
 * create it.
 */
export function inboxDir(): string {
  return join(homedir(), '.ashlr', 'inbox');
}

function canonicalProposalRepoIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return null;
  if (scrubSecrets(value) !== value) return null;
  const canonical = canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
  if (canonical === null || scrubSecrets(canonical) !== canonical) return null;
  return canonical;
}

function hasCanonicalProposalRepoIdentity(value: unknown): boolean {
  return value === null || (
    typeof value === 'string' && canonicalProposalRepoIdentity(value) === value
  );
}

/**
 * Absolute path to a specific proposal file.
 * M32 hardening: ids reach this from the web API (GET/POST /api/inbox/:id),
 * so validate the shape here too — defense in depth against path traversal,
 * matching runFilePath's guard in core/run/orchestrator.ts. Generated ids
 * are always [a-z0-9-], so this never rejects a legitimate proposal.
 */
function validProposalId(id: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id) && id !== '.' && id !== '..';
}

function proposalPath(id: string): string {
  if (!validProposalId(id)) {
    throw new Error(`Invalid proposal id: ${JSON.stringify(id)}`);
  }
  return join(inboxDir(), `${id}.json`);
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable, readable slug id for a proposal.
 *
 * Format: `prop-<timestamp-ms>-<sequence>-<24-hex-random>`.
 * - Timestamp prefix gives chronological sorting for free.
 * - A 96-bit random suffix prevents practical cross-process collisions.
 * - All lowercase alphanumeric + hyphens → safe as a filename stem.
 */
let _seq = 0;
export function makeProposalId(): string {
  const ts = Date.now().toString(36); // base-36 ms timestamp, ~8 chars
  const rand = randomBytes(12).toString('hex');
  // Monotonic, zero-padded process counter as the final segment. createdAt has
  // only millisecond resolution, so proposals created in the same ms would
  // otherwise have no defined recency order. The counter gives listProposals a
  // stable "most-recent first" tiebreaker. The counter comes BEFORE the random
  // segment so lexicographic id comparison orders by (timestamp, monotonic counter).
  const seq = (_seq++).toString(36).padStart(6, '0');
  return `prop-${ts}-${seq}-${rand}`;
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

function scrubProposalText(text: string): string {
  try {
    return scrubSecrets(text);
  } catch {
    return text;
  }
}

/**
 * Store-boundary secret scrub for human-readable proposal fields.
 *
 * Diffs are scrubbed in-place so reviewers still see file paths, hunks, and
 * surrounding context. When the diff changes, any trust tuple bound to the old
 * bytes is dropped fail-closed; scrubbing non-diff text does not invalidate it.
 */
function sanitizeProposalForStore<T extends Partial<Proposal> & Pick<Proposal, 'title' | 'summary'>>(
  proposal: T,
): T {
  const next: Partial<Proposal> = { ...proposal };
  let changed = false;

  const scrubTopLevel = (key: 'title' | 'summary' | 'result' | 'decisionReason'): void => {
    const value = next[key];
    if (typeof value !== 'string') return;
    const scrubbed = scrubProposalText(value);
    if (scrubbed !== value) {
      next[key] = scrubbed;
      changed = true;
    }
  };

  scrubTopLevel('title');
  scrubTopLevel('summary');
  scrubTopLevel('result');
  scrubTopLevel('decisionReason');

  if (typeof next.diff === 'string') {
    const scrubbedDiff = canonicalizeProposalDiff(next.diff);
    if (scrubbedDiff !== next.diff) {
      next.diff = scrubbedDiff;
      delete next.diffHash;
      delete next.provenanceSig;
      delete next.producerProvenanceVersion;
      delete next.producerProvenanceSig;
      changed = true;
    }
  }

  if (next.action?.type === 'browser-task') {
    const action = next.action;
    const scrubbedInstructions = scrubProposalText(action.instructions);
    const scrubbedUrl = typeof action.url === 'string' ? scrubProposalText(action.url) : action.url;
    if (scrubbedInstructions !== action.instructions || scrubbedUrl !== action.url) {
      next.action = {
        ...action,
        instructions: scrubbedInstructions,
        ...(scrubbedUrl !== undefined ? { url: scrubbedUrl } : {}),
      };
      changed = true;
    }
  }

  if (next.verifyResult !== undefined) {
    const verify: NonNullable<Proposal['verifyResult']> = next.verifyResult;
    let updatedVerify: NonNullable<Proposal['verifyResult']> = verify;

    const ensureVerify = (): NonNullable<Proposal['verifyResult']> => {
      if (updatedVerify === verify) updatedVerify = { ...verify };
      return updatedVerify;
    };

    if (typeof verify.detail === 'string') {
      const scrubbed = scrubProposalText(verify.detail);
      if (scrubbed !== verify.detail) {
        ensureVerify().detail = scrubbed;
      }
    }

    if (Array.isArray(verify.failed)) {
      const failed = verify.failed.map((item) => scrubProposalText(item));
      if (failed.some((item, idx) => item !== verify.failed![idx])) {
        ensureVerify().failed = failed;
      }
    }

    if (verify.browser !== undefined) {
      let browser = verify.browser;
      const scrubbedDetail = scrubProposalText(browser.detail);
      if (scrubbedDetail !== browser.detail) {
        browser = { ...browser, detail: scrubbedDetail };
      }
      if (browser.visualGrounding !== undefined) {
        const visual = browser.visualGrounding;
        const scrubbedVisualDetail = scrubProposalText(visual.detail);
        if (scrubbedVisualDetail !== visual.detail) {
          browser = { ...browser, visualGrounding: { ...visual, detail: scrubbedVisualDetail } };
        }
      }
      if (browser !== verify.browser) {
        ensureVerify().browser = browser;
      }
    }

    if (updatedVerify !== verify) {
      next.verifyResult = updatedVerify;
      changed = true;
    }
  }

  if (next.remoteHandoff !== undefined) {
    const handoff = next.remoteHandoff;
    const scrubbedDetail = typeof handoff.detail === 'string' ? scrubProposalText(handoff.detail) : handoff.detail;
    const scrubbedPrUrl = typeof handoff.prUrl === 'string' ? scrubProposalText(handoff.prUrl) : handoff.prUrl;
    const scrubbedMergeCommitOid = typeof handoff.mergeCommitOid === 'string' && /^[0-9a-f]{40}$/i.test(handoff.mergeCommitOid)
      ? handoff.mergeCommitOid.toLowerCase()
      : undefined;
    const scrubbedExpectedHeadOid = typeof handoff.expectedHeadOid === 'string' && /^[0-9a-f]{40}$/i.test(handoff.expectedHeadOid)
      ? handoff.expectedHeadOid.toLowerCase()
      : undefined;
    const sanitizedMergedAt = sanitizeGithubMergedAt(handoff.mergedAt);
    const sanitizedReconciliation = sanitizeRemoteHandoffReconciliation(next.id, next.repo, handoff);
    if (
      scrubbedDetail !== handoff.detail ||
      scrubbedPrUrl !== handoff.prUrl ||
      scrubbedMergeCommitOid !== handoff.mergeCommitOid ||
      scrubbedExpectedHeadOid !== handoff.expectedHeadOid ||
      sanitizedMergedAt !== handoff.mergedAt || sanitizedReconciliation !== handoff.reconciliation
    ) {
      const {
        mergeCommitOid: _mergeCommitOid,
        expectedHeadOid: _expectedHeadOid,
        mergedAt: _mergedAt,
        reconciliation: _reconciliation,
        ...safeHandoff
      } = handoff;
      next.remoteHandoff = {
        ...safeHandoff,
        ...(scrubbedDetail !== undefined ? { detail: scrubbedDetail } : {}),
        ...(scrubbedPrUrl !== undefined ? { prUrl: scrubbedPrUrl } : {}),
        ...(scrubbedMergeCommitOid !== undefined ? { mergeCommitOid: scrubbedMergeCommitOid } : {}),
        ...(scrubbedExpectedHeadOid !== undefined ? { expectedHeadOid: scrubbedExpectedHeadOid } : {}),
        ...(sanitizedMergedAt !== undefined ? { mergedAt: sanitizedMergedAt } : {}),
        ...(sanitizedReconciliation !== undefined ? { reconciliation: sanitizedReconciliation } : {}),
      };
      changed = true;
    }
  }

  if (next.localMergeIntent !== undefined) {
    if (!next.id || !next.repo || !verifyLocalMergeIntent(next.id, next.repo, next.localMergeIntent)) {
      delete next.localMergeIntent;
      changed = true;
    }
  }

  const realizedMergeFanoutVersion = next.realizedMergeFanoutVersion;
  if (realizedMergeFanoutVersion !== undefined &&
    realizedMergeFanoutVersion !== 1 && realizedMergeFanoutVersion !== 2 &&
    realizedMergeFanoutVersion !== REALIZED_MERGE_FANOUT_VERSION) {
    delete next.realizedMergeFanoutVersion;
    changed = true;
  }

  if (next.realizedMerge !== undefined) {
    const realizedMerge = authenticatedRealizedMergeOf(next);
    if (realizedMerge === null) {
      delete next.realizedMerge;
      changed = true;
    } else if (JSON.stringify(realizedMerge) !== JSON.stringify(next.realizedMerge)) {
      next.realizedMerge = realizedMerge;
      changed = true;
    }
  }

  if (next.taste !== undefined) {
    const scrubbedRationale = scrubProposalText(next.taste.rationale);
    if (scrubbedRationale !== next.taste.rationale) {
      next.taste = { ...next.taste, rationale: scrubbedRationale };
      changed = true;
    }
  }

  return changed ? (next as T) : proposal;
}

function ownedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function safeProposalFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1 && ownedByCurrentUser(stat);
}

function completeWrite(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error('Short proposal write');
    offset += written;
  }
}

/** Durably install one proposal under the global store-writer fence. */
function persistProposal(
  expectedId: string,
  proposal: Proposal,
  createOnly = false,
  ownerLock?: ProposalStoreMutationLock,
): void {
  const ownsStoreLock = ownsProposalStoreMutationLock(ownerLock);
  const storeLock = ownsStoreLock ? ownerLock! : acquireProposalStoreMutationLock();
  if (!storeLock) throw new Error('Proposal store mutation lock unavailable');
  let fd: number | undefined;
  let backupFd: number | undefined;
  let tmp: string | undefined;
  let backup: string | undefined;
  let dir: string | undefined;
  let dest: string | undefined;
  let destinationInstalled = false;
  let committed = false;
  let directoryCreated = false;
  try {
    const safeProposal = sanitizeProposalForStore(proposal);
    if (safeProposal.id !== expectedId) throw new Error('Proposal persistence identity mismatch');
    if (!hasCanonicalProposalRepoIdentity(safeProposal.repo)) {
      throw new Error('Proposal repository identity is not canonical');
    }
    dir = inboxDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      directoryCreated = true;
    }
    const directoryBefore = lstatSync(dir);
    if (!safeProposalDirectory(directoryBefore) || !ownedByCurrentUser(directoryBefore)) {
      throw new Error('Unsafe proposal directory');
    }
    if (process.platform !== 'win32') chmodSync(dir, 0o700);

    dest = proposalPath(safeProposal.id);
    if (createOnly && existsSync(dest)) throw new Error('Proposal id collision');
    if (!createOnly) {
      if (!existsSync(dest) || !safeProposalFile(lstatSync(dest))) {
        throw new Error('Unsafe or missing existing proposal');
      }
      backup = join(dir, `.${safeProposal.id}.${process.pid}.${randomBytes(12).toString('hex')}.rollback`);
      const prior = readProposalFileBounded(
        dest,
        HARD_PROPOSAL_READ_MAX_FILE_BYTES,
        HARD_PROPOSAL_READ_MAX_FILE_BYTES,
      );
      if (!prior.ok) throw new Error('Existing proposal could not be captured for rollback');
      const priorBytes = Buffer.from(prior.text, 'utf8');
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
      backupFd = openSync(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      const openedBackup = fstatSync(backupFd);
      if (!safeProposalFile(openedBackup)) throw new Error('Unsafe proposal rollback file');
      completeWrite(backupFd, priorBytes);
      if (process.platform !== 'win32') fchmodSync(backupFd, 0o600);
      fsyncSync(backupFd);
      const writtenBackup = fstatSync(backupFd);
      if (!safeProposalFile(writtenBackup) || !sameProposalSource(openedBackup, writtenBackup) ||
        writtenBackup.size !== priorBytes.length) {
        throw new Error('Proposal rollback file changed during write');
      }
      closeSync(backupFd);
      backupFd = undefined;
    }

    const bytes = Buffer.from(JSON.stringify(safeProposal, null, 2) + '\n', 'utf8');
    if (bytes.length > AUTHORITATIVE_PROPOSAL_MAX_FILE_BYTES) {
      throw new Error('Proposal exceeds the readable store limit');
    }
    tmp = join(dir, `.${safeProposal.id}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    const opened = fstatSync(fd);
    if (!safeProposalFile(opened)) throw new Error('Unsafe proposal temporary file');
    completeWrite(fd, bytes);
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (!safeProposalFile(written) || !sameProposalSource(opened, written) || written.size !== bytes.length) {
      throw new Error('Proposal temporary file changed during write');
    }
    closeSync(fd);
    fd = undefined;

    const directoryBeforeRename = lstatSync(dir);
    if (!safeProposalDirectory(directoryBeforeRename) || !sameProposalSource(directoryBefore, directoryBeforeRename)) {
      throw new Error('Proposal directory changed during write');
    }
    if (createOnly && existsSync(dest)) throw new Error('Proposal id collision');
    if (createOnly) {
      linkSync(tmp, dest);
      destinationInstalled = true;
      unlinkSync(tmp);
      tmp = undefined;
    } else {
      renameSync(tmp, dest);
      destinationInstalled = true;
      tmp = undefined;
    }
    const installed = lstatSync(dest);
    const directoryAfter = lstatSync(dir);
    if (!safeProposalFile(installed) || !sameProposalSource(written, installed) ||
      !safeProposalDirectory(directoryAfter) || !sameProposalSource(directoryBefore, directoryAfter)) {
      throw new Error('Proposal installation identity check failed');
    }
    const installedRead = readProposalFileBounded(dest, bytes.length, bytes.length);
    if (!installedRead.ok || installedRead.text !== bytes.toString('utf8')) {
      throw new Error('Installed proposal bytes do not match the durable temporary file');
    }
    fsyncDirectory(dir);
    if (directoryCreated) fsyncDirectory(dirname(dir));
    const directoryAfterSync = lstatSync(dir);
    if (!safeProposalDirectory(directoryAfterSync) || !sameProposalSource(directoryBefore, directoryAfterSync)) {
      throw new Error('Proposal directory changed during durability sync');
    }
    committed = true;
  } catch (error) {
    if (destinationInstalled && !committed && dir && dest) {
      try {
        if (backup && existsSync(backup)) {
          renameSync(backup, dest);
          backup = undefined;
        }
        else if (createOnly && existsSync(dest)) unlinkSync(dest);
        fsyncDirectory(dir);
      } catch {
        // The caller still receives failure; subsequent bounded reads remain
        // the authority for any uncertain installation state.
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve persistence error */ }
    }
    if (backupFd !== undefined) {
      try { closeSync(backupFd); } catch { /* preserve persistence error */ }
    }
    if (tmp !== undefined) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
    if (backup !== undefined && (committed || !destinationInstalled)) {
      try { unlinkSync(backup); } catch { /* harmless hidden rollback debris */ }
    }
    if (!ownsStoreLock) releaseProposalStoreMutationLock(storeLock);
  }
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/** Structural proposal contract shared by canonical storage and recovery staging. */
export function isValidProposal(parsed: unknown): parsed is Proposal {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const p = parsed as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    typeof p['origin'] === 'string' &&
    typeof p['kind'] === 'string' &&
    typeof p['title'] === 'string' &&
    typeof p['summary'] === 'string' &&
    typeof p['status'] === 'string' &&
    typeof p['createdAt'] === 'string' &&
    hasCanonicalProposalRepoIdentity(p['repo'])
  );
}

const HARD_PROPOSAL_READ_MAX_FILES = 4_096;
// Bounded operational headroom for the live authority source, not archival retention.
const DEFAULT_PROPOSAL_READ_MAX_FILES = HARD_PROPOSAL_READ_MAX_FILES;
const DEFAULT_PROPOSAL_READ_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_PROPOSAL_READ_MAX_FILE_BYTES = AUTHORITATIVE_PROPOSAL_MAX_FILE_BYTES;
const HARD_PROPOSAL_READ_MAX_BYTES = 256 * 1024 * 1024;
const HARD_PROPOSAL_READ_MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PROPOSAL_DIRECTORY_ENTRIES = 8_192;

type ProposalReadRacePoint = 'after-directory-scan' | 'after-file-read';

let proposalReadRaceHookForTest:
  | ((point: ProposalReadRacePoint, path: string) => void)
  | undefined;

/** Deterministic synchronous filesystem-race seam for store-focused tests. */
export function _setProposalReadRaceHookForTest(
  hook: ((point: ProposalReadRacePoint, path: string) => void) | undefined,
): void {
  proposalReadRaceHookForTest = hook;
}

export interface ListProposalsDetailedOptions {
  status?: ProposalStatus;
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
  /** Return no proposals unless the selected source was read and validated completely. */
  requireComplete?: boolean;
}

export type ProposalReadStopReason =
  | 'file-limit'
  | 'byte-limit'
  | 'per-file-byte-limit'
  | 'invalid-file'
  | 'io-error';

export interface ProposalSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: ProposalReadStopReason[];
  filesDiscovered: number;
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  unreadableFiles: number;
}

export interface ProposalsReadResult extends ProposalSourceQuality {
  proposals: Proposal[];
}

function boundedProposalReadOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

function emptyProposalRead(
  sourceState: ProposalSourceQuality['sourceState'],
  overrides: Partial<ProposalsReadResult> = {},
): ProposalsReadResult {
  return {
    proposals: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesDiscovered: 0,
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

function pushProposalStopReason(
  reasons: ProposalReadStopReason[],
  reason: ProposalReadStopReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sameProposalSource(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeProposalDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function sameProposalFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameProposalSource(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    Number(left.nlink) === Number(right.nlink)
  );
}

function sameProposalDirectorySnapshot(left: Stats, right: Stats): boolean {
  return (
    sameProposalSource(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    Number(left.nlink) === Number(right.nlink)
  );
}

interface ProposalDirectoryEntries {
  all: string[];
  proposals: string[];
  limitExceeded: boolean;
}

function readProposalDirectoryEntries(dir: string): ProposalDirectoryEntries {
  const all: string[] = [];
  const proposals: string[] = [];
  const handle = opendirSync(dir);
  let limitExceeded = false;
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      if (all.length >= MAX_PROPOSAL_DIRECTORY_ENTRIES) {
        limitExceeded = true;
        break;
      }
      all.push(entry.name);
      if (entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) {
        proposals.push(entry.name);
      }
      entry = handle.readSync();
    }
  } finally {
    handle.closeSync();
  }
  all.sort((left, right) => left.localeCompare(right));
  proposals.sort((left, right) => left.localeCompare(right));
  return { all, proposals, limitExceeded };
}

type ProposalFileRead =
  | { ok: true; text: string; bytesRead: number }
  | { ok: false; reason: Exclude<ProposalReadStopReason, 'file-limit'> };

function readProposalFileBounded(
  filePath: string,
  remainingBytes: number,
  maxFileBytes: number,
): ProposalFileRead {
  let fd: number | undefined;
  try {
    const namedBefore = lstatSync(filePath);
    if (!safeProposalFile(namedBefore)) return { ok: false, reason: 'io-error' };
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    fd = openSync(filePath, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    if (!safeProposalFile(before) || !sameProposalSource(namedBefore, before)) {
      return { ok: false, reason: 'io-error' };
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, reason: 'io-error' };
    if (size > maxFileBytes) return { ok: false, reason: 'per-file-byte-limit' };
    if (size > remainingBytes) return { ok: false, reason: 'byte-limit' };

    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, offset, size - offset, null);
      if (count === 0) return { ok: false, reason: 'io-error' };
      offset += count;
    }

    const after = fstatSync(fd);
    proposalReadRaceHookForTest?.('after-file-read', filePath);
    const namedAfter = lstatSync(filePath);
    if (
      !safeProposalFile(after) ||
      !safeProposalFile(namedAfter) ||
      !sameProposalFileSnapshot(before, after) ||
      !sameProposalFileSnapshot(after, namedAfter)
    ) {
      return { ok: false, reason: 'io-error' };
    }
    return { ok: true, text: buffer.toString('utf8'), bytesRead: offset };
  } catch {
    return { ok: false, reason: 'io-error' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort read */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Pulse Map telemetry (Phase: proposal-lifecycle spans) — ADDITIVE, no-op
// unless the fleet→pulse round-trip is opted in (PULSE_URL + PAT). This is
// pure TELEMETRY: it never changes proposal semantics and never weakens the
// proposal-only / kill-switch guarantees — it only mirrors lifecycle MOTION
// (created / merged / declined) into the cloud Map so the graph reflects
// proposals advancing, not just ticks. METADATA ONLY: we emit the repo
// basename + the lifecycle outcome — NEVER the diff, title body, or any file
// contents. Every call is wrapped so a Pulse outage can NEVER affect the
// proposal flow (best-effort, fire-and-forget, swallow-then-log).
// ---------------------------------------------------------------------------

/**
 * Map a proposal lifecycle transition to the fleet event the cloud ingest
 * understands:
 *   - creation                     → 'proposal'  (a proposal now exists)
 *   - approved                     → 'proposal'   (authorized, not landed)
 *   - applied                      → 'proposal'   (an action completed; merge unproven)
 *   - awaiting-host-merge          → 'proposal'   (remote handoff, not landed)
 *   - rejected (declined)          → 'decline'    (it was turned down)
 * Any other transition (e.g. a 'pending' reset or an apply 'failed' outcome)
 * is surfaced as a generic 'proposal' span so the motion is still visible.
 * Returns the FleetEvent kind; the raw status is carried as the outcome.
 */
function lifecycleEvent(status: ProposalStatus): FleetEvent {
  if (status === 'rejected') return 'decline';
  return 'proposal';
}

/**
 * Best-effort, NON-THROWING fleet-span emit for a proposal lifecycle moment.
 *
 * - Gated entirely by emitFleetEvent → pulseSyncEnabled: a complete NO-OP
 *   (no network, no fetch) unless BOTH a Pulse endpoint (PULSE_URL / cfg.pulse)
 *   AND a PAT are configured. When unconfigured this returns immediately.
 * - Fire-and-forget: the returned promise is detached with a .catch() so the
 *   proposal call path never awaits the network and a Pulse outage / rejection
 *   can never propagate into the proposal flow.
 * - METADATA ONLY: refId = proposal id; repo = basename of the repo path;
 *   outcome = the lifecycle status/origin. NEVER the diff or any file content.
 *
 * `owner` is threaded through cfg.user so the cloud can attribute the span to a
 * teammate (carried as ashlr.fleet.owner) — matching the createProposal owner
 * stamping. No cfg ⇒ env-driven opt-in still applies.
 */
function emitProposalSpan(
  event: FleetEvent,
  proposal: Pick<Proposal, 'id' | 'repo' | 'owner'>,
  outcome: string,
  cfg?: Pick<AshlrConfig, 'user'>,
): void {
  try {
    // repo is an absolute path on a Proposal; ship only the basename as a
    // metadata hint (the cloud resolves nodes by name). Never a full path's
    // parent dirs — keep it to the bare repo name.
    const repo = proposal.repo ? basename(proposal.repo) : null;
    // Build the minimal AshlrConfig surface emitFleetEvent needs. pulseSyncEnabled
    // reads cfg.pulse + env; exporterConfig reads cfg.user. We never have the
    // full config here, so rely on env-based opt-in (PULSE_URL) + carry owner.
    const fleetCfg = {
      ...(cfg?.user ? { user: cfg.user } : {}),
    } as AshlrConfig;

    // emitFleetEvent is itself gated + no-throw, but we still detach + swallow:
    // store.ts must NEVER throw and must NEVER block on the network.
    void Promise.resolve(
      emitFleetEvent(fleetCfg, {
        event,
        refId: proposal.id,
        outcome,
        repo,
      }),
    ).catch(() => {
      // Pulse outage / rejection — telemetry is best-effort; proposal flow is
      // unaffected. Swallow (emitFleetEvent already logs at its boundary).
    });
  } catch {
    // Constructing the span input must never break a proposal lifecycle call.
  }
}

// ---------------------------------------------------------------------------
// M228: Goal-milestone outcome linker — additive, best-effort, never-throws.
// ---------------------------------------------------------------------------

/**
 * When a proposal resolves (verified applied → done; rejected → pending/blocked),
 * find the goal milestone that holds this proposalId and update its status
 * to reflect the terminal outcome.
 *
 * - verified 'applied' → milestone 'done' (the work landed and passed verification)
 * - 'rejected' → milestone 'pending' if it previously had no swarmId hint of
 *                a hard failure; otherwise 'blocked' so a human must steer it.
 *                NOTE: a milestone with proposalId set is currently 'proposed'
 *                (normal path) or 'blocked' (needs-approval branch). In both
 *                cases on reject we reset to 'pending' for retry — the conductor
 *                can re-advance it on the next cycle.  A caller that wants to
 *                permanently block can call updateMilestoneStatus directly.
 *
 * Best-effort: any error is swallowed so a Pulse outage / corrupt goal file
 * NEVER disrupts the proposal lifecycle flow.
 */
function linkMilestoneOutcome(
  proposalId: string,
  outcome: 'applied' | 'rejected',
  stillAuthorized?: () => boolean,
): boolean {
  const isStillAuthorized = stillAuthorized ?? (() => true);
  try {
    if (!isStillAuthorized()) return false;
    const source = Object.prototype.hasOwnProperty.call(goalStore, 'listGoalsDetailed')
      ? goalStore.listGoalsDetailed()
      : { goals: goalStore.listGoals(), sourceState: 'healthy' as const, complete: true };
    if (!source.complete || source.sourceState === 'degraded') return false;
    for (const goal of source.goals) {
      const linkedMilestones = goal.milestones.filter((milestone) => milestone.proposalId === proposalId);
      for (const milestone of linkedMilestones) {
        if (!isStillAuthorized()) return false;
        const newStatus =
          outcome === 'applied'
            ? ('done' as const)
            : ('pending' as const); // reset to pending for retry on rejection

        if (milestone.status !== newStatus) {
          const updated = stillAuthorized
            ? goalStore.updateMilestoneStatus(goal.id, milestone.id, newStatus, { stillAuthorized })
            : goalStore.updateMilestoneStatus(goal.id, milestone.id, newStatus);
          if (!updated) return false;
        }
        if (!isStillAuthorized()) return false;
        const persistedMilestone = goalStore.loadGoal(goal.id)?.milestones
          .find((candidate) => candidate.id === milestone.id);
        if (persistedMilestone?.proposalId !== proposalId || persistedMilestone.status !== newStatus) {
          return false;
        }
      }
    }
    return isStillAuthorized();
  } catch {
    // Never disrupts the proposal flow.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function bindCreatedProposalRunSummary(
  summary: Proposal['runEventSummary'],
  runId: string | undefined,
  proposalId: string | undefined,
  proposalCreated = summary?.proposalCreated,
): Proposal['runEventSummary'] {
  if (!summary) return undefined;
  const {
    runId: _unboundRunId,
    proposalId: _unboundProposalId,
    proposalCreated: _unboundProposalCreated,
    outcome: unboundOutcome,
    actionCounts: unboundActionCounts,
    ...metadata
  } = summary;
  const outcome = proposalCreated === false &&
    (unboundOutcome === 'proposal-created' || unboundOutcome === 'filed')
    ? undefined
    : unboundOutcome;
  let actionCounts = unboundActionCounts;
  if (proposalCreated === false && actionCounts) {
    const { proposalCreated: _unboundCreatedCount, ...remainingCounts } = actionCounts;
    actionCounts = Object.keys(remainingCounts).length > 0 ? remainingCounts : undefined;
  }
  return {
    ...metadata,
    ...(runId ? { runId } : {}),
    ...(outcome ? { outcome } : {}),
    ...(actionCounts ? { actionCounts } : {}),
    ...(proposalCreated !== undefined ? { proposalCreated } : {}),
    ...(proposalCreated === true && proposalId ? { proposalId } : {}),
  };
}

/**
 * Create a new proposal, persist it, audit the creation, and return it.
 *
 * Assigns:
 *  - `id`        — fresh unique slug (stable, filename-safe)
 *  - `status`    — 'pending'
 *  - `createdAt` — current ISO timestamp
 *  - `owner`     — cfg.user?.id ?? cfg.user?.name (M109; undefined when cfg absent)
 *
 * NEVER applies or mutates any repo.
 * Never throws. Persistence failure returns an explicit rejected result that
 * cannot be mistaken for a filed proposal.
 */
export function createProposal(
  p: Omit<Proposal, 'id' | 'status' | 'createdAt'>,
  cfg?: Pick<AshlrConfig, 'user' | 'foundry'>,
): Proposal {
  const canonicalRepo = p.repo === null ? null : canonicalProposalRepoIdentity(p.repo);
  const repoIdentityValid = p.repo === null || canonicalRepo !== null;
  const input = sanitizeProposalForStore({
    ...p,
    // Invalid raw identity is never scrubbed into a different path or exposed
    // to persistence/audit. The rejected return is deliberately unscoped.
    repo: repoIdentityValid ? canonicalRepo : null,
  });
  // Proposal creation is not a post-merge credit release protocol. Normalize
  // the reserved authority label before any causal metadata is signed or saved.
  if (typeof input.labelBasis === 'string' &&
    isPostMergeCreditReleaseLabel(input.labelBasis.trim())) {
    input.labelBasis = 'proposal-status';
  }
  // Realized merge evidence is never accepted on proposal creation. The only
  // supported persistence boundary for this field is recordRealizedMerge.
  delete input.realizedMerge;
  delete input.realizedMergeFanoutVersion;
  delete input.localMergeIntent;
  // M109: stamp owner from cfg.user when not already set by the caller.
  const owner = input.owner ?? cfg?.user?.id ?? cfg?.user?.name;

  // M158: destructive-diff guard — default ON (cfg.foundry?.diffSafety !== false).
  // Applied before status is set so a destructive proposal never enters 'pending'.
  const diffSafetyEnabled = cfg?.foundry?.diffSafety !== false;
  let initialStatus: Proposal['status'] = 'pending';
  let diffSafetyRejectionReason: string | undefined;
  if (diffSafetyEnabled && input.diff) {
    try {
      const guard = isDestructiveDiff(input.diff);
      if (guard.destructive) {
        initialStatus = 'rejected';
        diffSafetyRejectionReason = `destructive diff auto-rejected: ${guard.reason ?? 'destructive pattern detected'}`;
      }
    } catch {
      // Guard is best-effort — never disrupts proposal creation.
    }
  }

  const proposalId = makeProposalId();
  const createdAt = new Date().toISOString();
  const boundRunEventSummary = bindCreatedProposalRunSummary(
    input.runEventSummary,
    input.runId,
    proposalId,
  );
  const baseProposal: Proposal = {
    ...input,
    ...(boundRunEventSummary ? { runEventSummary: boundRunEventSummary } : {}),
    ...(owner !== undefined ? { owner } : {}),
    id: proposalId,
    status: initialStatus,
    createdAt,
    ...(diffSafetyRejectionReason !== undefined
      ? { decisionReason: diffSafetyRejectionReason, decidedAt: new Date().toISOString() }
      : {}),
  };
  const proposal: Proposal = {
    ...baseProposal,
    ...causalMetadata({
      proposalId,
      workItemId: baseProposal.workItemId,
      runId: baseProposal.runId,
      trajectoryId: baseProposal.trajectoryId,
      routeSnapshot: baseProposal.routeSnapshot,
      runEventSummary: baseProposal.runEventSummary,
      evidenceOutcome: baseProposal.evidenceOutcome,
      learningSource: baseProposal.learningSource ?? 'proposal',
      labelBasis: baseProposal.labelBasis ?? 'proposal-status',
      routerPolicyVersion: baseProposal.routerPolicyVersion,
      learningEpoch: baseProposal.learningEpoch,
      ts: createdAt,
    }),
  };
  if (verifyProvenance(proposal).ok) {
    const producerProvenanceSig = signProducerProvenanceV2(proposal);
    if (producerProvenanceSig) {
      proposal.producerProvenanceVersion = 2;
      proposal.producerProvenanceSig = producerProvenanceSig;
    }
  }

  let persisted = false;
  const storeLock = repoIdentityValid ? acquireProposalStoreMutationLock() : null;
  if (storeLock) {
    try {
      // Dedup and installation share one namespace transaction so two
      // processes cannot both observe absence and file the same diff.
      if (initialStatus === 'pending' && input.diffHash) {
        const pendingSnapshot = listProposalsDetailed({
          status: 'pending',
          requireComplete: true,
          maxFiles: HARD_PROPOSAL_READ_MAX_FILES,
          maxBytes: HARD_PROPOSAL_READ_MAX_BYTES,
          maxFileBytes: HARD_PROPOSAL_READ_MAX_FILE_BYTES,
        });
        if (!pendingSnapshot.complete || pendingSnapshot.sourceState === 'degraded') {
          throw new Error('Proposal dedup source is incomplete');
        }
        const duplicate = pendingSnapshot.proposals.find(
          (existing) => existing.diffHash === input.diffHash,
        );
        if (duplicate) {
          const dedupRunEventSummary = bindCreatedProposalRunSummary(
            input.runEventSummary,
            input.runId,
            undefined,
            false,
          );
          audit({
            action: 'inbox:proposal-rejected',
            repo: (input.repo as string | null) ?? null,
            sandboxId: (input.sandboxId as string | undefined) ?? null,
            summary: `proposal skipped (diffHash dedup): [${input.kind}] ${input.title} — duplicate of ${duplicate.id}`,
            result: 'ok',
          });
          return {
            ...input,
            ...(dedupRunEventSummary ? { runEventSummary: dedupRunEventSummary } : {}),
            ...(owner !== undefined ? { owner } : {}),
            id: duplicate.id,
            status: 'rejected' as const,
            createdAt,
            decisionReason: `diffHash dedup: duplicate of ${duplicate.id}`,
            decidedAt: createdAt,
          };
        }
      }
      persistProposal(proposal.id, proposal, true, storeLock);
      persisted = true;
    } catch {
      persisted = false;
    } finally {
      releaseProposalStoreMutationLock(storeLock);
    }
  }

  const failedRunEventSummary = persisted
    ? undefined
    : bindCreatedProposalRunSummary(proposal.runEventSummary, proposal.runId, undefined, false);
  const returnedProposal: Proposal = persisted
    ? proposal
    : {
        ...proposal,
        ...(failedRunEventSummary ? { runEventSummary: failedRunEventSummary } : {}),
        status: 'rejected',
        decisionReason: repoIdentityValid
          ? 'proposal persistence failed'
          : 'invalid proposal repository identity',
        decidedAt: new Date().toISOString(),
      };

  audit({
    action: !persisted || initialStatus === 'rejected' ? 'inbox:proposal-rejected' : 'inbox:proposal-created',
    repo: repoIdentityValid ? proposal.repo ?? null : null,
    sandboxId: proposal.sandboxId ?? null,
    summary:
      !persisted
        ? repoIdentityValid
          ? `proposal persistence failed: [${proposal.kind}] ${proposal.title} (id=${proposal.id})`
          : `proposal repository identity refused: [${proposal.kind}] ${proposal.title} (id=${proposal.id})`
        : initialStatus === 'rejected'
        ? `proposal auto-rejected (diff-safety): [${proposal.kind}] ${proposal.title} (id=${proposal.id}) — ${diffSafetyRejectionReason}`
        : `proposal created: [${proposal.kind}] ${proposal.title} (id=${proposal.id})`,
    result: persisted ? 'ok' : 'refused',
  });

  // M158: emit decisions-ledger entry for auto-rejected proposals.
  if (persisted && initialStatus === 'rejected' && diffSafetyRejectionReason !== undefined) {
    try {
      const ts = new Date().toISOString();
      recordDecision({
        ts,
        proposalId: proposal.id,
        ...(proposal.workItemId ? { workItemId: proposal.workItemId } : {}),
        ...(proposal.workSource ? { workSource: proposal.workSource } : {}),
        ...(proposal.runId ? { runId: proposal.runId } : {}),
        ...causalMetadataFromProposal(proposal, {
          ts,
          learningSource: 'decision-ledger',
          labelBasis: 'proposal-status',
        }),
        action: 'rejected',
        verdict: 'rejected',
        reason: diffSafetyRejectionReason,
      });
    } catch {
      // Ledger is best-effort.
    }
  }

  // Pulse Map: a proposal now exists. Outcome = its origin so the cloud can
  // distinguish backlog / swarm / manual / agent provenance. Best-effort.
  if (persisted) {
    emitProposalSpan(
      initialStatus === 'rejected' ? 'decline' : 'proposal',
      proposal,
      initialStatus === 'rejected' ? 'rejected' : proposal.origin,
      cfg,
    );
  }

  return returnedProposal;
}

/**
 * True only for the synthetic, non-persisted result returned when createProposal
 * reuses an existing pending proposal's id for diffHash compatibility.
 */
export function isDiffDedupResult(proposal: Proposal): boolean {
  return (
    proposal.status === 'rejected' &&
    proposal.decisionReason === `diffHash dedup: duplicate of ${proposal.id}`
  );
}

/**
 * List all persisted proposals, most-recent first by `createdAt`.
 * Optionally filter by status.
 *
 * Read-only. Unreadable / corrupt files are silently skipped.
 * Never throws.
 */
export function listProposals(filter?: { status?: ProposalStatus }): Proposal[] {
  try {
    const dir = inboxDir();
    if (!existsSync(dir)) return [];
    const directoryBefore = lstatSync(dir);
    if (!safeProposalDirectory(directoryBefore) || !ownedByCurrentUser(directoryBefore)) return [];

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    } catch {
      return [];
    }

    const proposals: Proposal[] = [];
    for (const file of files) {
      try {
        const loaded = readProposalFileBounded(
          join(dir, file),
          HARD_PROPOSAL_READ_MAX_FILE_BYTES,
          HARD_PROPOSAL_READ_MAX_FILE_BYTES,
        );
        if (!loaded.ok) continue;
        const parsed: unknown = JSON.parse(loaded.text);
        if (isValidProposal(parsed) && validProposalId(parsed.id) && file === `${parsed.id}.json`) {
          proposals.push(sanitizeProposalForStore(parsed));
        }
      } catch {
        // Unreadable or malformed — skip silently.
      }
    }

    // Apply optional status filter.
    const filtered =
      filter?.status !== undefined
        ? proposals.filter((p) => p.status === filter.status)
        : proposals;

    // Most-recent first by createdAt (ISO strings sort lexicographically).
    // Tiebreak on id (which embeds a monotonic counter) so proposals created
    // within the same millisecond still order newest-first deterministically.
    filtered.sort((a, b) => {
      if (a.createdAt < b.createdAt) return 1;
      if (a.createdAt > b.createdAt) return -1;
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return 0;
    });

    const directoryAfter = lstatSync(dir);
    if (!safeProposalDirectory(directoryAfter) || !sameProposalSource(directoryBefore, directoryAfter)) return [];

    return filtered;
  } catch {
    return [];
  }
}

/**
 * Bounded proposal enumeration with explicit source-quality diagnostics.
 *
 * Unlike the compatibility `listProposals` reader, this path rejects links and
 * non-regular files, detects inbox replacement, and reports every skipped file.
 * Never throws.
 */
export function listProposalsDetailed(
  opts: ListProposalsDetailedOptions = {},
): ProposalsReadResult {
  try {
    const maxFiles = boundedProposalReadOption(
      opts.maxFiles,
      DEFAULT_PROPOSAL_READ_MAX_FILES,
      HARD_PROPOSAL_READ_MAX_FILES,
    );
    const maxBytes = boundedProposalReadOption(
      opts.maxBytes,
      DEFAULT_PROPOSAL_READ_MAX_BYTES,
      HARD_PROPOSAL_READ_MAX_BYTES,
    );
    const maxFileBytes = boundedProposalReadOption(
      opts.maxFileBytes,
      DEFAULT_PROPOSAL_READ_MAX_FILE_BYTES,
      HARD_PROPOSAL_READ_MAX_FILE_BYTES,
    );
    const dir = inboxDir();
    if (!existsSync(dir)) return emptyProposalRead('missing');

    let directoryBefore: Stats;
    try {
      directoryBefore = lstatSync(dir);
      if (!safeProposalDirectory(directoryBefore) || !ownedByCurrentUser(directoryBefore)) {
        return emptyProposalRead('degraded', {
          complete: false,
          stopReasons: ['io-error'],
          unreadableFiles: 1,
        });
      }
    } catch {
      return emptyProposalRead('degraded', {
        complete: false,
        stopReasons: ['io-error'],
        unreadableFiles: 1,
      });
    }

    const result = emptyProposalRead('healthy', { sourcePresent: true });
    let directoryEntries: ProposalDirectoryEntries;
    try {
      directoryEntries = readProposalDirectoryEntries(dir);
    } catch {
      return emptyProposalRead('degraded', {
        sourcePresent: true,
        complete: false,
        stopReasons: ['io-error'],
        unreadableFiles: 1,
      });
    }

    proposalReadRaceHookForTest?.('after-directory-scan', dir);
    const files = directoryEntries.proposals;
    if (directoryEntries.limitExceeded) {
      pushProposalStopReason(result.stopReasons, 'file-limit');
      result.complete = false;
    }
    result.filesDiscovered = files.length;

    for (const file of files) {
      if (result.filesRead >= maxFiles) {
        pushProposalStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        break;
      }
      const remainingBytes = maxBytes - result.bytesRead;
      if (remainingBytes <= 0) {
        pushProposalStopReason(result.stopReasons, 'byte-limit');
        result.complete = false;
        break;
      }

      result.filesRead++;
      const loaded = readProposalFileBounded(join(dir, file), remainingBytes, maxFileBytes);
      if (!loaded.ok) {
        pushProposalStopReason(result.stopReasons, loaded.reason);
        result.complete = false;
        if (loaded.reason === 'io-error') result.unreadableFiles++;
        if (loaded.reason === 'byte-limit') break;
        continue;
      }
      result.bytesRead += loaded.bytesRead;

      try {
        const parsed: unknown = JSON.parse(loaded.text);
        if (!isValidProposal(parsed) || !validProposalId(parsed.id) || file !== `${parsed.id}.json`) {
          result.invalidFiles++;
          result.complete = false;
          pushProposalStopReason(result.stopReasons, 'invalid-file');
          continue;
        }
        const proposal = sanitizeProposalForStore(parsed);
        if (opts.status === undefined || proposal.status === opts.status) {
          result.proposals.push(proposal);
        }
      } catch {
        result.invalidFiles++;
        result.complete = false;
        pushProposalStopReason(result.stopReasons, 'invalid-file');
      }
    }

    try {
      const finalEntries = readProposalDirectoryEntries(dir);
      const directoryAfter = lstatSync(dir);
      const directoryContentChanged = !directoryEntries.limitExceeded && (
        finalEntries.limitExceeded ||
        finalEntries.all.length !== directoryEntries.all.length ||
        finalEntries.all.some((entry, index) => entry !== directoryEntries.all[index])
      );
      if (
        directoryContentChanged ||
        !safeProposalDirectory(directoryAfter) ||
        !ownedByCurrentUser(directoryAfter) ||
        !sameProposalDirectorySnapshot(directoryBefore, directoryAfter)
      ) {
        pushProposalStopReason(result.stopReasons, 'io-error');
        result.complete = false;
        result.unreadableFiles++;
      }
    } catch {
      pushProposalStopReason(result.stopReasons, 'io-error');
      result.complete = false;
      result.unreadableFiles++;
    }

    result.proposals.sort((a, b) => {
      if (a.createdAt < b.createdAt) return 1;
      if (a.createdAt > b.createdAt) return -1;
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return 0;
    });
    if (result.invalidFiles > 0 || result.unreadableFiles > 0 || !result.complete) {
      result.sourceState = 'degraded';
      result.complete = false;
    }
    if (opts.requireComplete === true && result.sourceState === 'degraded') {
      result.proposals = [];
    }
    return result;
  } catch {
    return emptyProposalRead('degraded', {
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  }
}

/**
 * Load a single proposal by id.
 * Returns null if absent, unreadable, or malformed.
 * Never throws.
 */
export function loadProposal(id: string): Proposal | null {
  try {
    const dir = inboxDir();
    const directoryBefore = lstatSync(dir);
    if (!safeProposalDirectory(directoryBefore) || !ownedByCurrentUser(directoryBefore)) return null;
    const p = proposalPath(id);
    if (!existsSync(p)) return null;
    const loaded = readProposalFileBounded(
      p,
      HARD_PROPOSAL_READ_MAX_FILE_BYTES,
      HARD_PROPOSAL_READ_MAX_FILE_BYTES,
    );
    if (!loaded.ok) return null;
    const directoryAfter = lstatSync(dir);
    if (!safeProposalDirectory(directoryAfter) || !sameProposalSource(directoryBefore, directoryAfter)) return null;
    const parsed: unknown = JSON.parse(loaded.text);
    if (isValidProposal(parsed) && parsed.id === id) return sanitizeProposalForStore(parsed);
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a new status (and optional result detail) for an existing proposal.
 *
 * - Sets `decidedAt` to now when moving to 'approved' or 'rejected'.
 * - No-op if the proposal does not exist or cannot be read.
 * - NEVER applies anything — pure persistence change only.
 * - Audits the decision.
 * - Never throws.
 *
 * M119 ADDITIVE: optional `reason` param — when supplied, persisted as
 * `decisionReason` on the proposal and emitted to the decisions ledger.
 * When absent → no behavior change whatsoever.
 */
export function setStatus(
  id: string,
  status: ProposalStatus,
  result?: string,
  reason?: string,
  ownerLock?: ProposalMutationLock,
  transitionPatch: Partial<Pick<Proposal, 'remoteHandoff'>> = {},
  expectedCurrentStatus?: ProposalStatus,
): boolean {
  const ownsLock = ownsProposalMutationLock(id, ownerLock);
  const mutationLock = ownsLock ? ownerLock! : acquireProposalMutationLock(id);
  if (!mutationLock) return false;
  let persisted = false;
  try {
    const existing = loadProposal(id);
    if (existing === null) return false;
    if (expectedCurrentStatus !== undefined && existing.status !== expectedCurrentStatus) return false;

    // Partial captures are immutable review evidence. They may be rejected or
    // repaired, but no status transition may grant apply/merge authority.
    if (
      existing.isPartial === true &&
      (status === 'approved' || status === 'awaiting-host-merge' || status === 'applied')
    ) {
      audit({
        action: 'inbox:proposal-transition-refused',
        repo: existing.repo ?? null,
        sandboxId: existing.sandboxId ?? null,
        summary: `partial proposal authority transition refused: ${status} (id=${id})`,
        result: 'refused',
      });
      return false;
    }

    const decidedStatuses: ProposalStatus[] = ['approved', 'rejected'];
    const machineRecoveryDecision =
      status === 'rejected' &&
      (reason === PROPOSAL_PERSISTENCE_MISMATCH_REASON ||
        (reason === undefined && result === PROPOSAL_PERSISTENCE_MISMATCH_RESULT) ||
        reason?.startsWith('auto-drained: permanent readiness blocker persisted') === true);
    const revokeRejectedCaptureRecovery =
      status === 'rejected' &&
      !machineRecoveryDecision &&
      typeof existing.repo === 'string' && existing.repo.length > 0;
    const updated: Proposal = sanitizeProposalForStore({
      ...existing,
      ...transitionPatch,
      status,
      ...(result !== undefined ? { result } : {}),
      ...(revokeRejectedCaptureRecovery && result === undefined &&
        existing.result === PROPOSAL_PERSISTENCE_MISMATCH_RESULT
        ? { result: undefined }
        : {}),
      // M119: persist decisionReason when provided (additive, backward-compatible).
      ...(reason !== undefined ? { decisionReason: reason } : {}),
      ...(revokeRejectedCaptureRecovery && reason === undefined &&
        (existing.decisionReason === PROPOSAL_PERSISTENCE_MISMATCH_REASON ||
          existing.decisionReason?.startsWith('auto-drained: permanent readiness blocker persisted'))
        ? { decisionReason: undefined }
        : {}),
      ...(revokeRejectedCaptureRecovery ? { stuckPassCount: undefined } : {}),
      ...(decidedStatuses.includes(status)
        ? { decidedAt: new Date().toISOString() }
        : {}),
    });

    try {
      persistProposal(id, updated);
      persisted = true;
    } catch {
      return false;
    }

    // The proposal decision is authoritative and must commit before its queue
    // projection is cleaned up. Dispatch independently revalidates any stale
    // rejected-capture row, so lock contention or a crash here cannot revive it.
    if (revokeRejectedCaptureRecovery) {
      const recoveryId = proposalRepairId(existing.repo!, id);
      pruneQueuedSelfHealItems((item) =>
        item.id === recoveryId && item.tags.includes('rejected-capture-recovery'));
    }

    audit({
      action: `inbox:proposal-${status}`,
      repo: updated.repo ?? null,
      sandboxId: updated.sandboxId ?? null,
      summary: `proposal ${status}: [${updated.kind}] ${updated.title} (id=${id})${result ? ` — ${result}` : ''}`,
      result: 'ok',
    });

    // M119: emit a decisions-ledger entry for every status transition that
    // represents a decision or lifecycle action. Neither authorization nor a
    // generic applied transition is proof that a default-branch merge occurred.
    // Best-effort: recordDecision never throws; no behavior change when absent.
    try {
      const ledgerAction =
        status === 'approved'
            ? 'merge-authorized'
            : status === 'rejected'
              ? 'rejected'
              : status === 'awaiting-host-merge'
                ? 'handoff'
                : 'judged';
      // Derive the engine id from the model string (segment before ':').
      const engineModel = updated.engineModel;
      const engineId = engineModel ? engineModel.split(':')[0] : undefined;
      const ts = new Date().toISOString();
      recordDecision({
        ts,
        proposalId: id,
        ...(updated.workItemId ? { workItemId: updated.workItemId } : {}),
        ...(updated.workSource ? { workSource: updated.workSource } : {}),
        ...(updated.runId ? { runId: updated.runId } : {}),
        ...causalMetadataFromProposal(updated, {
          ts,
          learningSource: 'decision-ledger',
          labelBasis: 'proposal-status',
        }),
        action: ledgerAction,
        ...(engineId ? { engine: engineId } : {}),
        ...(engineModel ? { model: engineModel } : {}),
        verdict: status,
        ...(reason !== undefined ? { reason } : {}),
      });
    } catch {
      // Ledger is best-effort — never disrupts the proposal flow.
    }

    // M141: rejected is a real terminal judge outcome. Realized merge outcomes
    // are linked only by recordRealizedMerge after evidence commits.
    try {
      if (status === 'rejected') linkOutcome(id, 'rejected');
    } catch { /* never disrupts the proposal flow */ }

    // M228: rejection releases a linked milestone for retry. Merge milestone
    // credit is emitted only by recordRealizedMerge.
    if (status === 'rejected') linkMilestoneOutcome(id, 'rejected');

    // Pulse Map: mirror generic lifecycle motion. Rejected → 'decline'; every
    // other status, including applied, → 'proposal'. Only recordRealizedMerge
    // emits a merge span. The raw status is the outcome. This ONLY reports motion —
    // setStatus has already (and only) changed the persisted status; no apply /
    // merge / kill-switch behavior is touched here. Owner is carried from the
    // persisted proposal.
    emitProposalSpan(
      lifecycleEvent(status),
      updated,
      status,
      updated.owner ? { user: { id: updated.owner } } : undefined,
    );
    return true;
  } catch {
    return persisted;
  } finally {
    if (!ownsLock) releaseProposalMutationLock(mutationLock);
  }
}

/**
 * Atomically persist the only evidence-backed transition that means "merged".
 * Merge-specific telemetry and credit are emitted only after this write commits.
 */
function ensureRealizedMergeDecision(
  updated: Proposal,
  realizedMerge: RealizedMergeEvidence,
  stillAuthorized: () => boolean = () => true,
): boolean {
  const mergedRows = (): ReturnType<typeof readDecisionsDetailed> | null => {
    const result = readDecisionsDetailed({ proposalId: updated.id, requireComplete: true });
    return result.complete && result.sourceState !== 'degraded' ? result : null;
  };

  try {
    if (!stillAuthorized()) return false;
    const before = mergedRows();
    if (!before) return false;
    const existingMerged = before.decisions.filter((entry) => entry.action === 'merged');
    if (existingMerged.length > 0) {
      return stillAuthorized() && existingMerged.length === 1 &&
        existingMerged[0]?.labelBasis === 'realized-merge-v1';
    }

    const engineModel = updated.engineModel;
    const engineId = engineModel?.split(':')[0];
    const ts = realizedMerge.source === 'local-default-branch'
      ? realizedMerge.observedAt
      : realizedMerge.reconciliation.observedAt;
    if (!stillAuthorized()) return false;
    recordDecision({
      ts,
      proposalId: updated.id,
      ...(updated.workItemId ? { workItemId: updated.workItemId } : {}),
      ...(updated.workSource ? { workSource: updated.workSource } : {}),
      ...(updated.runId ? { runId: updated.runId } : {}),
      ...causalMetadataFromProposal(updated, {
        ts,
        learningSource: 'decision-ledger',
        labelBasis: 'realized-merge-v1',
      }),
      action: 'merged',
      ...(engineId ? { engine: engineId } : {}),
      ...(engineModel ? { model: engineModel } : {}),
      verdict: 'merged',
      reason: `realized merge observed via ${realizedMerge.source}`,
    });

    if (!stillAuthorized()) return false;
    const after = mergedRows();
    if (!after) return false;
    const persistedMerged = after.decisions.filter((entry) => entry.action === 'merged');
    return persistedMerged.length === 1 && persistedMerged[0]?.labelBasis === 'realized-merge-v1';
  } catch {
    return false;
  }
}

function retryIdempotentRealizedMergeProjections(
  updated: Proposal,
  stillAuthorized: () => boolean = () => true,
): boolean {
  if (!stillAuthorized()) return false;
  // A realized merge is factual lifecycle evidence, not positive learning
  // authority. Judge-outcome credit is deliberately withheld until a future
  // purpose-built post-merge release proof mints post-merge-credit-release-v1.
  if (proposalCompletesGoalMilestone(updated) &&
    !linkMilestoneOutcome(updated.id, 'applied', stillAuthorized)) return false;
  return stillAuthorized();
}

function fanoutRealizedMerge(
  updated: Proposal,
  realizedMerge: RealizedMergeEvidence,
  stillAuthorized: () => boolean = () => true,
): boolean {
  // Version 3 acknowledges factual idempotent projections. Positive routing,
  // judge, ROI, trajectory, worked-ledger, and skill credit are a separate
  // release protocol and are never implied by this marker.
  if (!stillAuthorized()) return false;
  if (!ensureRealizedMergeDecision(updated, realizedMerge, stillAuthorized)) return false;

  if (!retryIdempotentRealizedMergeProjections(updated, stillAuthorized)) return false;
  if (!stillAuthorized()) return false;
  if (updated.realizedMergeFanoutVersion !== REALIZED_MERGE_FANOUT_VERSION) {
    try {
      emitProposalSpan(
        'merge',
        updated,
        'merged',
        updated.owner ? { user: { id: updated.owner } } : undefined,
      );
    } catch { /* deterministic retry may repair another projection */ }
  }
  return stillAuthorized();
}

export function recordRealizedMerge(
  id: string,
  evidence: RealizedMergeEvidence | LocalDefaultBranchMergeObservation,
  ownerLock?: ProposalMutationLock,
  stillAuthorized: () => boolean = () => false,
): boolean {
  const ownsLock = ownsProposalMutationLock(id, ownerLock);
  const mutationLock = ownsLock ? ownerLock! : acquireProposalMutationLock(id);
  if (!mutationLock) return false;
  let storeLock: ProposalStoreMutationLock | null = null;
  let persisted = false;
  try {
    const observedAt = evidence.source === 'local-default-branch'
      ? evidence.observedAt
      : evidence.reconciliation.observedAt;
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs) || observedMs > Date.now() + MAX_REALIZED_MERGE_FUTURE_SKEW_MS) {
      return false;
    }
    storeLock = acquireProposalStoreMutationLock();
    if (!storeLock) return false;
    const snapshot = listProposalsDetailed({
      requireComplete: true,
      maxFiles: HARD_PROPOSAL_READ_MAX_FILES,
      maxBytes: HARD_PROPOSAL_READ_MAX_BYTES,
      maxFileBytes: HARD_PROPOSAL_READ_MAX_FILE_BYTES,
    });
    if (!snapshot.complete || snapshot.sourceState !== 'healthy') return false;
    const existing = snapshot.proposals.find((proposal) => proposal.id === id);
    if (!existing || existing.isPartial === true) return false;
    const identityOwnedByAnotherProposal = (candidate: Proposal): boolean => {
      const identity = canonicalRealizedMergeIdentity(candidate);
      if (!identity) return true;
      return snapshot.proposals.some((proposal) =>
        proposal.id !== id && canonicalRealizedMergeIdentity(proposal)?.key === identity.key);
    };
    const priorEvidence = authenticatedRealizedMergeOf(existing);
    if (priorEvidence) {
      let matches = false;
      if (evidence.source === 'local-default-branch') {
        matches = priorEvidence.source === 'local-default-branch' &&
          priorEvidence.base === evidence.base && priorEvidence.baseBeforeOid === evidence.baseBeforeOid &&
          priorEvidence.proposalHeadOid === evidence.proposalHeadOid &&
          priorEvidence.mergeCommitOid === evidence.mergeCommitOid && priorEvidence.observedAt === evidence.observedAt;
      } else {
        const sanitized = sanitizeRealizedMergeEvidence(evidence);
        matches = sanitized !== null && JSON.stringify(priorEvidence) === JSON.stringify(sanitized);
      }
      if (existing.status !== 'applied' || !matches) return false;
      if (identityOwnedByAnotherProposal(existing)) return false;
      if (stillAuthorized() &&
        fanoutRealizedMerge(existing, priorEvidence, stillAuthorized) && stillAuthorized()) {
        if (existing.realizedMergeFanoutVersion !== REALIZED_MERGE_FANOUT_VERSION) {
          persistProposal(id, {
            ...existing,
            realizedMergeFanoutVersion: REALIZED_MERGE_FANOUT_VERSION,
          }, false, storeLock);
        }
      }
      return true;
    }

    let realizedMerge: RealizedMergeEvidence | null = sanitizeRealizedMergeEvidence(evidence);
    if (evidence.source === 'local-default-branch') {
      const intent = existing.localMergeIntent;
      if ((existing.status !== 'pending' && existing.status !== 'approved') ||
        !existing.repo || !existing.diffHash || !intent ||
        !verifyLocalMergeIntent(existing.id, existing.repo, intent) ||
        intent.base !== evidence.base || intent.baseBeforeOid !== evidence.baseBeforeOid ||
        intent.proposalHeadOid !== evidence.proposalHeadOid || intent.diffHash !== existing.diffHash ||
        !verifyLocalRealizedMergeEvidence(existing.repo, evidence)) return false;
      const unsigned: Omit<LocalDefaultBranchRealizedMerge, 'attestation'> = {
        ...evidence,
        proposalId: existing.id,
        diffHash: existing.diffHash,
        intentAttestation: intent.attestation,
      };
      const attestation = signLocalRealizedMergeReceipt(existing.id, existing.repo, unsigned);
      realizedMerge = attestation ? { ...unsigned, attestation } : null;
    }
    if (!realizedMerge) return false;

    let remoteHandoff = existing.remoteHandoff;
    if (realizedMerge.source === 'github-host') {
      const current = existing.remoteHandoff;
      if (existing.status !== 'awaiting-host-merge' || !existing.repo || !current || current.provider !== 'github' ||
        current.state !== 'awaiting-host-merge' || current.prUrl !== realizedMerge.prUrl ||
        current.branch !== realizedMerge.branch || current.base !== realizedMerge.base ||
        current.expectedHeadOid?.toLowerCase() !== realizedMerge.expectedHeadOid) {
        return false;
      }
      remoteHandoff = {
        ...current,
        state: 'merged',
        prUrl: realizedMerge.prUrl,
        branch: realizedMerge.branch,
        base: realizedMerge.base,
        expectedHeadOid: realizedMerge.expectedHeadOid,
        mergeCommitOid: realizedMerge.mergeCommitOid,
        mergedAt: realizedMerge.mergedAt,
        reconciliation: realizedMerge.reconciliation,
        updatedAt: realizedMerge.reconciliation.observedAt,
        detail: `remote PR merged at ${realizedMerge.mergedAt}: ${realizedMerge.prUrl}`,
      };
      if (!verifyRemoteHandoffReconciliation(id, existing.repo, remoteHandoff)) return false;
    }

    const result = realizedMerge.source === 'local-default-branch'
      ? `merged proposal head ${realizedMerge.proposalHeadOid} into '${realizedMerge.base}' at ${realizedMerge.mergeCommitOid} (local, not pushed)`
      : `remote PR merged at ${realizedMerge.mergedAt}: ${realizedMerge.prUrl}`;
    const updated = sanitizeProposalForStore({
      ...existing,
      status: 'applied',
      result,
      realizedMerge,
      ...(remoteHandoff ? { remoteHandoff } : {}),
    });
    if (!authenticatedRealizedMergeOf(updated)) return false;
    if (identityOwnedByAnotherProposal(updated)) return false;
    persistProposal(id, updated, false, storeLock);
    persisted = true;

    audit({
      action: 'inbox:proposal-applied',
      repo: updated.repo ?? null,
      sandboxId: updated.sandboxId ?? null,
      summary: `proposal realized merge: [${updated.kind}] ${updated.title} (id=${id}) — ${result}`,
      result: 'ok',
    });

    if (stillAuthorized() && fanoutRealizedMerge(updated, realizedMerge, stillAuthorized) && stillAuthorized()) {
      persistProposal(id, {
        ...updated,
        realizedMergeFanoutVersion: REALIZED_MERGE_FANOUT_VERSION,
      }, false, storeLock);
    }
    return true;
  } catch {
    return persisted;
  } finally {
    if (storeLock) releaseProposalStoreMutationLock(storeLock);
    if (!ownsLock) releaseProposalMutationLock(mutationLock);
  }
}

/** Replay only the idempotent projections for an already-authenticated merge. */
export function replayRealizedMergeFanout(
  id: string,
  ownerLock?: ProposalMutationLock,
  stillAuthorized: () => boolean = () => false,
): boolean {
  if (!stillAuthorized()) return false;
  const existing = loadProposal(id);
  if (!existing || existing.status !== 'applied') {
    return false;
  }
  const realizedMerge = authenticatedRealizedMergeOf(existing);
  if (!realizedMerge) return false;
  if (!stillAuthorized()) return false;
  return recordRealizedMerge(id, realizedMerge, ownerLock, stillAuthorized);
}

/**
 * M259: Patch a single field on an existing proposal (atomic read-modify-write).
 *
 * Used by runAutoMergePass to increment judgeNonShipCount without touching any
 * other field. Pure persistence — NEVER changes status, NEVER applies anything.
 * Returns true only when the update was durably persisted. Never throws.
 */
export function updateProposalField(
  id: string,
  patch: Partial<Pick<Proposal, 'judgeNonShipCount' | 'verifyResult' | 'stuckPassCount' | 'remoteHandoff' | 'localMergeIntent'>>,
  ownerLock?: ProposalMutationLock,
): boolean {
  const ownsLock = ownsProposalMutationLock(id, ownerLock);
  const mutationLock = ownsLock ? ownerLock! : acquireProposalMutationLock(id);
  if (!mutationLock) return false;
  try {
    const existing = loadProposal(id);
    if (existing === null) return false;
    const updated: Proposal = sanitizeProposalForStore({ ...existing, ...patch });
    try {
      persistProposal(id, updated);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    if (!ownsLock) releaseProposalMutationLock(mutationLock);
  }
}

/**
 * Count proposals with status === 'pending'.
 * Read-only. Returns 0 on any error.
 * Never throws.
 */
export function pendingCount(): number {
  try {
    return listProposals({ status: 'pending' }).length;
  } catch {
    return 0;
  }
}
