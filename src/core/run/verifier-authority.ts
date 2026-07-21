import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, posix, win32 } from 'node:path';
import type { VerifyCommand, VerifyCommandKind, VerifyCommandProfile } from './verify-commands.js';

const VERIFY_CONTRACT_FILE = 'ashlr.verify.json';
const SNAPSHOT_DOMAIN = 'ashlr.verifier-authority.snapshot';
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CONTRACT_BYTES = 1024 * 1024;
const MAX_REASON_PATH_CHARS = 160;
const VERIFY_COMMAND_KINDS = new Set<VerifyCommandKind>(['typecheck', 'lint', 'build', 'test']);
const VERIFY_COMMAND_PROFILES = new Set<VerifyCommandProfile>(['quick', 'merge', 'deep']);

export type GitObjectFormat = 'sha1' | 'sha256';
export type VerifierAuthorityFileMode = '100644' | '100755';

export interface VerifierAuthorityEntry {
  path: string;
  mode: VerifierAuthorityFileMode;
  blobOid: string;
}

export interface CanonicalMergeVerifyCommand {
  id: string | null;
  kind: VerifyCommandKind;
  cmd: string[];
  cwd: string;
  timeoutMs: number | null;
  required: boolean;
  profiles: VerifyCommandProfile[];
}

export interface VerifierAuthoritySnapshotV1 {
  schemaVersion: 1;
  objectFormat: GitObjectFormat;
  baseCommitOid: string;
  baseTreeOid: string;
  contractBlobOid: string;
  authorityEntries: VerifierAuthorityEntry[];
  mergeCommands: CanonicalMergeVerifyCommand[];
  authoritySnapshotDigest: string;
}

export type VerifierAuthorityFailureCode =
  | 'git-unavailable'
  | 'invalid-base'
  | 'unsupported-object-format'
  | 'contract-missing'
  | 'contract-not-regular'
  | 'contract-too-large'
  | 'contract-invalid-json'
  | 'contract-invalid-schema'
  | 'contract-invalid-mode'
  | 'contract-missing-authority-files'
  | 'contract-invalid-authority-file'
  | 'contract-missing-required-merge-command'
  | 'invalid-merge-command'
  | 'authority-entry-missing'
  | 'authority-entry-not-blob'
  | 'authority-entry-not-regular'
  | 'invalid-candidate-tree'
  | 'authority-entry-changed'
  | 'authority-worktree-missing'
  | 'authority-worktree-not-regular'
  | 'authority-index-mismatch'
  | 'authority-worktree-changed'
  | 'candidate-index-changed'
  | 'candidate-worktree-changed'
  | 'candidate-untracked-path';

export interface VerifierAuthorityFailure {
  ok: false;
  code: VerifierAuthorityFailureCode;
  reason: string;
}

export interface VerifierAuthorityCaptureSuccess {
  ok: true;
  snapshot: VerifierAuthoritySnapshotV1;
}

export type VerifierAuthorityCaptureResult = VerifierAuthorityCaptureSuccess | VerifierAuthorityFailure;

export interface VerifierAuthorityComparisonSuccess {
  ok: true;
  checkedEntryCount: number;
  candidateTreeOid?: string;
}

export type VerifierAuthorityComparisonResult = VerifierAuthorityComparisonSuccess | VerifierAuthorityFailure;

export interface CaptureVerifierAuthorityOptions {
  repoRoot: string;
  baseRevision: string;
  mergeCommands: readonly VerifyCommand[];
}

export interface CompareVerifierAuthorityTreeOptions {
  repoRoot: string;
  candidateRevision: string;
  snapshot: VerifierAuthoritySnapshotV1;
}

export interface CompareVerifierAuthorityWorktreeOptions {
  repoRoot: string;
  snapshot: VerifierAuthoritySnapshotV1;
}

export interface CaptureVerifierCandidateStateOptions {
  repoRoot: string;
  candidateTreeOid: string;
}

export interface VerifierCandidateUntrackedEntry {
  path: string;
  kind: 'file' | 'symlink';
  executable: boolean;
  contentDigest: string;
}

export interface VerifierCandidateStateSnapshot {
  candidateTreeOid: string;
  relevantUntrackedEntries: VerifierCandidateUntrackedEntry[];
}

export interface VerifierCandidateStateCaptureSuccess {
  ok: true;
  snapshot: VerifierCandidateStateSnapshot;
}

export type VerifierCandidateStateCaptureResult =
  | VerifierCandidateStateCaptureSuccess
  | VerifierAuthorityFailure;

export interface CompareVerifierCandidateStateOptions {
  repoRoot: string;
  snapshot: VerifierCandidateStateSnapshot;
}

interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  oid: string;
}

interface ParsedAuthorityContract {
  authorityFiles: string[];
}

function failure(code: VerifierAuthorityFailureCode, reason: string): VerifierAuthorityFailure {
  return { ok: false, code, reason };
}

function boundedPath(path: string): string {
  if (path.length <= MAX_REASON_PATH_CHARS) return path;
  return `${path.slice(0, MAX_REASON_PATH_CHARS - 3)}...`;
}

function git(repoRoot: string, args: readonly string[], maxBuffer = MAX_GIT_OUTPUT_BYTES): Buffer | null {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer,
    });
  } catch {
    return null;
  }
}

function gitText(repoRoot: string, args: readonly string[]): string | null {
  const output = git(repoRoot, args);
  return output?.toString('utf8').trim() ?? null;
}

function isOid(value: string, objectFormat: GitObjectFormat): boolean {
  const length = objectFormat === 'sha1' ? 40 : 64;
  return value.length === length && /^[0-9a-f]+$/.test(value);
}

function resolveObjectFormat(repoRoot: string): GitObjectFormat | null {
  const format = gitText(repoRoot, ['rev-parse', '--show-object-format']);
  return format === 'sha1' || format === 'sha256' ? format : null;
}

function resolveCommit(repoRoot: string, revision: string, objectFormat: GitObjectFormat): string | null {
  if (!revision || revision.includes('\0')) return null;
  const oid = gitText(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
  return oid && isOid(oid, objectFormat) ? oid : null;
}

function resolveTree(repoRoot: string, revision: string, objectFormat: GitObjectFormat): string | null {
  const oid = gitText(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{tree}`]);
  return oid && isOid(oid, objectFormat) ? oid : null;
}

function readTreeEntry(repoRoot: string, treeOid: string, path: string): GitTreeEntry | null {
  const output = git(repoRoot, ['ls-tree', '-z', '--full-tree', treeOid, '--', `:(literal)${path}`]);
  if (!output || output.length === 0) return null;
  const records = output.toString('utf8').split('\0').filter(Boolean);
  if (records.length !== 1) return null;
  const tab = records[0]!.indexOf('\t');
  if (tab < 0) return null;
  const metadata = records[0]!.slice(0, tab).split(' ');
  const entryPath = records[0]!.slice(tab + 1);
  if (metadata.length !== 3 || entryPath !== path) return null;
  return { mode: metadata[0]!, type: metadata[1]!, oid: metadata[2]!, path: entryPath };
}

function isNormalizedAuthorityPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) return false;
  if (isAbsolute(value) || win32.isAbsolute(value) || value === '.' || value.startsWith('./')) return false;
  if (posix.normalize(value) !== value) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contractCommandIsValid(raw: unknown): raw is Record<string, unknown> {
  if (!isPlainObject(raw)) return false;
  if (typeof raw['id'] !== 'string' || raw['id'].trim().length === 0) return false;
  if (typeof raw['kind'] !== 'string' || !VERIFY_COMMAND_KINDS.has(raw['kind'] as VerifyCommandKind)) return false;
  if (!Array.isArray(raw['cmd']) || raw['cmd'].length === 0) return false;
  if (!raw['cmd'].every((part) => typeof part === 'string' && part.length > 0 && !part.includes('\0'))) return false;
  if (raw['cwd'] !== undefined
    && (typeof raw['cwd'] !== 'string' || normalizedCommandCwd(raw['cwd']) === null)) return false;
  if (raw['timeoutMs'] !== undefined
    && (!Number.isSafeInteger(raw['timeoutMs']) || (raw['timeoutMs'] as number) <= 0)) return false;
  if (raw['required'] !== undefined && typeof raw['required'] !== 'boolean') return false;
  if (raw['profiles'] !== undefined) {
    if (!Array.isArray(raw['profiles']) || raw['profiles'].length === 0) return false;
    if (!raw['profiles'].every((profile) => typeof profile === 'string'
      && VERIFY_COMMAND_PROFILES.has(profile as VerifyCommandProfile))) return false;
  }
  return true;
}

function parseAuthorityContract(raw: Buffer): ParsedAuthorityContract | VerifierAuthorityFailure {
  if (raw.length > MAX_CONTRACT_BYTES) {
    return failure('contract-too-large', 'verifier contract exceeds the authority snapshot size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return failure('contract-invalid-json', 'verifier contract is not valid JSON');
  }
  if (!isPlainObject(parsed) || parsed['schemaVersion'] !== 1) {
    return failure('contract-invalid-schema', 'verifier contract must use schemaVersion 1');
  }
  if (parsed['mode'] !== 'replace-detected') {
    return failure('contract-invalid-mode', 'verifier authority requires replace-detected mode');
  }
  const authorityFiles = parsed['authorityFiles'];
  if (!Array.isArray(authorityFiles) || authorityFiles.length === 0) {
    return failure('contract-missing-authority-files', 'verifier authority requires non-empty authorityFiles');
  }
  const seen = new Set<string>();
  for (const path of authorityFiles) {
    if (!isNormalizedAuthorityPath(path) || seen.has(path)) {
      return failure('contract-invalid-authority-file', 'verifier authorityFiles must be unique normalized repo paths');
    }
    seen.add(path);
  }
  const commands = parsed['commands'];
  if (!Array.isArray(commands) || !commands.every(contractCommandIsValid)) {
    return failure('contract-missing-required-merge-command', 'verifier contract commands are invalid');
  }
  const hasRequiredMergeCommand = commands.some((command) => {
    const profiles = command['profiles'];
    return command['required'] !== false && Array.isArray(profiles) && profiles.includes('merge');
  });
  if (!hasRequiredMergeCommand) {
    return failure('contract-missing-required-merge-command', 'verifier contract requires a required merge command');
  }
  return { authorityFiles: [...authorityFiles] };
}

function normalizedCommandCwd(cwd: string | undefined): string | null {
  if (cwd === undefined || cwd === '' || cwd === '.') return '.';
  return isNormalizedAuthorityPath(cwd) ? cwd : null;
}

function canonicalizeMergeCommands(
  commands: readonly VerifyCommand[],
): CanonicalMergeVerifyCommand[] | VerifierAuthorityFailure {
  if (commands.length === 0 || !commands.some((command) => command.required !== false)) {
    return failure('invalid-merge-command', 'effective merge verification requires a required command');
  }
  const canonical: CanonicalMergeVerifyCommand[] = [];
  for (const command of commands) {
    const cwd = normalizedCommandCwd(command.cwd);
    const profiles = command.profiles ?? [];
    const valid = VERIFY_COMMAND_KINDS.has(command.kind)
      && Array.isArray(command.cmd)
      && command.cmd.length > 0
      && command.cmd.every((part) => typeof part === 'string' && part.length > 0 && !part.includes('\0'))
      && (command.id === undefined || (typeof command.id === 'string' && command.id.trim().length > 0))
      && cwd !== null
      && (command.timeoutMs === undefined
        || (Number.isSafeInteger(command.timeoutMs) && command.timeoutMs > 0))
      && (command.required === undefined || typeof command.required === 'boolean')
      && Array.isArray(profiles)
      && profiles.every((profile) => VERIFY_COMMAND_PROFILES.has(profile));
    if (!valid) {
      return failure('invalid-merge-command', 'effective merge verification contains an invalid command');
    }
    canonical.push({
      id: command.id ?? null,
      kind: command.kind,
      cmd: [...command.cmd],
      cwd: cwd!,
      timeoutMs: command.timeoutMs ?? null,
      required: command.required !== false,
      profiles: [...new Set(profiles)].sort(),
    });
  }
  return canonical;
}

function isFailure(value: unknown): value is VerifierAuthorityFailure {
  return isPlainObject(value) && value['ok'] === false && typeof value['code'] === 'string';
}

function authorityEntryFromTree(
  repoRoot: string,
  treeOid: string,
  path: string,
  objectFormat: GitObjectFormat,
): VerifierAuthorityEntry | VerifierAuthorityFailure {
  const entry = readTreeEntry(repoRoot, treeOid, path);
  if (!entry) {
    return failure('authority-entry-missing', `authority file '${boundedPath(path)}' is missing from the Git tree`);
  }
  if (entry.type !== 'blob' || !isOid(entry.oid, objectFormat)) {
    return failure('authority-entry-not-blob', `authority file '${boundedPath(path)}' is not an exact Git blob`);
  }
  if (entry.mode !== '100644' && entry.mode !== '100755') {
    return failure('authority-entry-not-regular', `authority file '${boundedPath(path)}' is not a regular Git file`);
  }
  return { path, mode: entry.mode, blobOid: entry.oid };
}

function snapshotDigest(input: Omit<VerifierAuthoritySnapshotV1, 'authoritySnapshotDigest'>): string {
  const canonical = JSON.stringify({
    domain: SNAPSHOT_DOMAIN,
    schemaVersion: input.schemaVersion,
    objectFormat: input.objectFormat,
    baseCommitOid: input.baseCommitOid,
    baseTreeOid: input.baseTreeOid,
    contractBlobOid: input.contractBlobOid,
    authorityEntries: input.authorityEntries,
    mergeCommands: input.mergeCommands,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Capture repository-owned verifier authority from an immutable base Git tree. */
export function captureVerifierAuthoritySnapshot(
  options: CaptureVerifierAuthorityOptions,
): VerifierAuthorityCaptureResult {
  const objectFormat = resolveObjectFormat(options.repoRoot);
  if (!objectFormat) {
    return failure('unsupported-object-format', 'repository Git object format is unavailable or unsupported');
  }
  const baseCommitOid = resolveCommit(options.repoRoot, options.baseRevision, objectFormat);
  if (!baseCommitOid) return failure('invalid-base', 'base revision does not resolve to a Git commit');
  const baseTreeOid = resolveTree(options.repoRoot, baseCommitOid, objectFormat);
  if (!baseTreeOid) return failure('invalid-base', 'base commit tree is unavailable');

  const contractEntry = readTreeEntry(options.repoRoot, baseTreeOid, VERIFY_CONTRACT_FILE);
  if (!contractEntry) return failure('contract-missing', 'root ashlr.verify.json is not tracked in the base tree');
  if (contractEntry.type !== 'blob' || !isOid(contractEntry.oid, objectFormat)) {
    return failure('contract-not-regular', 'root ashlr.verify.json is not an exact Git blob');
  }
  if (contractEntry.mode !== '100644' && contractEntry.mode !== '100755') {
    return failure('contract-not-regular', 'root ashlr.verify.json is not a regular Git file');
  }
  const contractSizeRaw = gitText(options.repoRoot, ['cat-file', '-s', contractEntry.oid]);
  const contractSize = contractSizeRaw === null ? Number.NaN : Number(contractSizeRaw);
  if (!Number.isSafeInteger(contractSize) || contractSize < 0) {
    return failure('git-unavailable', 'verifier contract blob size could not be read');
  }
  if (contractSize > MAX_CONTRACT_BYTES) {
    return failure('contract-too-large', 'verifier contract exceeds the authority snapshot size limit');
  }
  const contractRaw = git(options.repoRoot, ['cat-file', 'blob', contractEntry.oid], MAX_CONTRACT_BYTES);
  if (!contractRaw) return failure('git-unavailable', 'verifier contract blob could not be read');
  const contract = parseAuthorityContract(contractRaw);
  if (isFailure(contract)) return contract;
  const mergeCommands = canonicalizeMergeCommands(options.mergeCommands);
  if (isFailure(mergeCommands)) return mergeCommands;

  const authorityPaths = [...new Set([VERIFY_CONTRACT_FILE, ...contract.authorityFiles])].sort();
  const authorityEntries: VerifierAuthorityEntry[] = [];
  for (const path of authorityPaths) {
    const entry = authorityEntryFromTree(options.repoRoot, baseTreeOid, path, objectFormat);
    if (isFailure(entry)) return entry;
    authorityEntries.push(entry);
  }

  const snapshotWithoutDigest: Omit<VerifierAuthoritySnapshotV1, 'authoritySnapshotDigest'> = {
    schemaVersion: 1,
    objectFormat,
    baseCommitOid,
    baseTreeOid,
    contractBlobOid: contractEntry.oid,
    authorityEntries,
    mergeCommands,
  };
  return {
    ok: true,
    snapshot: {
      ...snapshotWithoutDigest,
      authoritySnapshotDigest: snapshotDigest(snapshotWithoutDigest),
    },
  };
}

/** Compare a candidate commit or tree to the exact authority entries captured from the base. */
export function compareVerifierAuthorityCandidateTree(
  options: CompareVerifierAuthorityTreeOptions,
): VerifierAuthorityComparisonResult {
  const candidateTreeOid = resolveTree(
    options.repoRoot,
    options.candidateRevision,
    options.snapshot.objectFormat,
  );
  if (!candidateTreeOid) {
    return failure('invalid-candidate-tree', 'candidate revision does not resolve to a Git tree');
  }
  for (const expected of options.snapshot.authorityEntries) {
    const actual = authorityEntryFromTree(
      options.repoRoot,
      candidateTreeOid,
      expected.path,
      options.snapshot.objectFormat,
    );
    if (isFailure(actual)) return actual;
    if (actual.mode !== expected.mode || actual.blobOid !== expected.blobOid) {
      return failure('authority-entry-changed', `authority file '${boundedPath(expected.path)}' changed in the candidate tree`);
    }
  }
  return {
    ok: true,
    checkedEntryCount: options.snapshot.authorityEntries.length,
    candidateTreeOid,
  };
}

function readIndexEntry(repoRoot: string, path: string): GitTreeEntry | null {
  const output = git(repoRoot, ['ls-files', '--stage', '-z', '--', `:(literal)${path}`]);
  if (!output || output.length === 0) return null;
  const records = output.toString('utf8').split('\0').filter(Boolean);
  if (records.length !== 1) return null;
  const tab = records[0]!.indexOf('\t');
  if (tab < 0 || records[0]!.slice(tab + 1) !== path) return null;
  const metadata = records[0]!.slice(0, tab).split(' ');
  if (metadata.length !== 3 || metadata[2] !== '0') return null;
  return { mode: metadata[0]!, type: 'blob', oid: metadata[1]!, path };
}

/** Compare both the candidate index and live authority files to the captured base blobs. */
export function compareVerifierAuthorityWorktree(
  options: CompareVerifierAuthorityWorktreeOptions,
): VerifierAuthorityComparisonResult {
  for (const expected of options.snapshot.authorityEntries) {
    const indexEntry = readIndexEntry(options.repoRoot, expected.path);
    if (!indexEntry || indexEntry.mode !== expected.mode || indexEntry.oid !== expected.blobOid) {
      return failure('authority-index-mismatch', `authority file '${boundedPath(expected.path)}' differs in the Git index`);
    }
    let stat;
    try {
      stat = lstatSync(join(options.repoRoot, expected.path));
    } catch {
      return failure('authority-worktree-missing', `authority file '${boundedPath(expected.path)}' is missing from the worktree`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return failure('authority-worktree-not-regular', `authority file '${boundedPath(expected.path)}' is not a regular worktree file`);
    }
    if (process.platform !== 'win32') {
      const worktreeMode: VerifierAuthorityFileMode = (stat.mode & 0o111) === 0 ? '100644' : '100755';
      if (worktreeMode !== expected.mode) {
        return failure('authority-worktree-changed', `authority file '${boundedPath(expected.path)}' mode changed in the worktree`);
      }
    }
    const worktreeOid = gitText(options.repoRoot, [
      'hash-object',
      `--path=${expected.path}`,
      '--',
      expected.path,
    ]);
    if (!worktreeOid || !isOid(worktreeOid, options.snapshot.objectFormat) || worktreeOid !== expected.blobOid) {
      return failure('authority-worktree-changed', `authority file '${boundedPath(expected.path)}' content changed in the worktree`);
    }
  }
  return { ok: true, checkedEntryCount: options.snapshot.authorityEntries.length };
}

function relevantUntrackedEntries(
  repoRoot: string,
  objectFormat: GitObjectFormat,
): VerifierCandidateUntrackedEntry[] | VerifierAuthorityFailure {
  const output = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!output) {
    return failure('git-unavailable', 'untracked verifier worktree state could not be inspected');
  }
  const entries: VerifierCandidateUntrackedEntry[] = [];
  for (const path of output.toString('utf8').split('\0').filter(Boolean)) {
    let stat;
    try {
      stat = lstatSync(join(repoRoot, path));
    } catch {
      return failure('candidate-untracked-path', `untracked path '${boundedPath(path)}' changed during inspection`);
    }
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(join(repoRoot, path));
      } catch {
        return failure('candidate-untracked-path', `untracked symlink '${boundedPath(path)}' changed during inspection`);
      }
      entries.push({
        path,
        kind: 'symlink',
        executable: false,
        contentDigest: createHash('sha256').update('symlink\0').update(target).digest('hex'),
      });
      continue;
    }
    if (!stat.isFile()) {
      return failure('candidate-untracked-path', `untracked path '${boundedPath(path)}' is not a regular file`);
    }
    const oid = gitText(repoRoot, ['hash-object', '--no-filters', '--', path]);
    if (!oid || !isOid(oid, objectFormat)) {
      return failure('git-unavailable', `untracked path '${boundedPath(path)}' could not be hashed`);
    }
    entries.push({
      path,
      kind: 'file',
      executable: process.platform !== 'win32' && (stat.mode & 0o111) !== 0,
      contentDigest: oid,
    });
  }
  return entries;
}

/** Capture the exact candidate index, tracked worktree, and relevant untracked state. */
export function captureVerifierCandidateState(
  options: CaptureVerifierCandidateStateOptions,
): VerifierCandidateStateCaptureResult {
  const objectFormat = resolveObjectFormat(options.repoRoot);
  if (!objectFormat) {
    return failure('unsupported-object-format', 'repository Git object format is unavailable or unsupported');
  }
  const candidateTreeOid = resolveTree(options.repoRoot, options.candidateTreeOid, objectFormat);
  if (!candidateTreeOid) {
    return failure('invalid-candidate-tree', 'candidate revision does not resolve to a Git tree');
  }

  const indexTreeOid = gitText(options.repoRoot, ['write-tree']);
  if (!indexTreeOid || !isOid(indexTreeOid, objectFormat)) {
    return failure('git-unavailable', 'current verifier index tree could not be resolved');
  }
  if (indexTreeOid !== candidateTreeOid) {
    return failure('candidate-index-changed', 'verifier changed the staged candidate index');
  }

  const trackedDrift = git(options.repoRoot, [
    'diff-files',
    '--raw',
    '-z',
    '--ignore-submodules=none',
    '--',
  ]);
  if (!trackedDrift) {
    return failure('git-unavailable', 'tracked verifier worktree state could not be inspected');
  }
  if (trackedDrift.length > 0) {
    return failure('candidate-worktree-changed', 'verifier changed a tracked candidate worktree path');
  }

  const untracked = relevantUntrackedEntries(options.repoRoot, objectFormat);
  if (isFailure(untracked)) return untracked;

  return {
    ok: true,
    snapshot: { candidateTreeOid, relevantUntrackedEntries: untracked },
  };
}

/** Compare live verifier state to a previously captured exact candidate state. */
export function compareVerifierCandidateState(
  options: CompareVerifierCandidateStateOptions,
): VerifierAuthorityFailure | { ok: true } {
  const current = captureVerifierCandidateState({
    repoRoot: options.repoRoot,
    candidateTreeOid: options.snapshot.candidateTreeOid,
  });
  if (!current.ok) return current;
  if (JSON.stringify(current.snapshot.relevantUntrackedEntries)
    !== JSON.stringify(options.snapshot.relevantUntrackedEntries)) {
    return failure('candidate-untracked-path', 'verifier changed non-ignored untracked candidate state');
  }
  return { ok: true };
}
