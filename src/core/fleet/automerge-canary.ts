import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

export type AutoMergeCanaryPatchClass = 'docs-only' | 'rejected';

export type AutoMergeCanaryReason =
  | 'eligible docs-only staged patch'
  | 'eligible docs-only committed patch'
  | 'invalid inspector input'
  | 'git metadata unavailable'
  | 'inspection deadline exceeded'
  | 'inspection output exceeds classifier limits'
  | 'head commit does not have base as its sole parent'
  | 'committed metadata changed during inspection'
  | 'staged metadata changed during inspection'
  | 'malformed git metadata'
  | 'staged patch is empty'
  | 'git metadata path sets differ'
  | 'duplicate or conflicting path metadata'
  | 'path is malformed or ambiguous'
  | 'path is outside the documentation allowlist'
  | 'change status is unsupported'
  | 'file mode is unsupported'
  | 'rename or copy is ambiguous'
  | 'binary content is unsupported'
  | 'blob content is not strict text'
  | 'file change has no content lines'
  | 'staged patch exceeds classifier limits';

export interface AutoMergeCanaryClassification {
  eligible: boolean;
  reason: AutoMergeCanaryReason;
  fileCount: number;
  lineCount: number;
  class: AutoMergeCanaryPatchClass;
  /** Exact staged tree this verdict describes; null for pure facts and refusals. */
  stagedTreeOid: string | null;
  /** Exact commit used as the comparison base; null for pure facts and refusals. */
  baseCommitOid: string | null;
}

export type AutoMergeCanaryCommittedOutcome =
  | 'eligible'
  | 'policy-rejected'
  | 'inspection-failed';

/** Authority-bearing result for one exact immutable base/head commit pair. */
export interface AutoMergeCanaryCommittedClassification {
  outcome: AutoMergeCanaryCommittedOutcome;
  eligible: boolean;
  reason: AutoMergeCanaryReason;
  fileCount: number;
  lineCount: number;
  class: AutoMergeCanaryPatchClass;
  baseCommitOid: string | null;
  headCommitOid: string | null;
  baseTreeOid: string | null;
  headTreeOid: string | null;
  pathDigest: string | null;
}

export interface AutoMergeCanaryGitInvocation {
  repo: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export type AutoMergeCanaryGitRunResult =
  | { ok: true; stdout: Buffer }
  | { ok: false; reason: 'git-error' | 'timeout' | 'output-limit' };

export type AutoMergeCanaryGitRunner = (
  invocation: AutoMergeCanaryGitInvocation,
) => AutoMergeCanaryGitRunResult;

export interface AutoMergeCanaryCommittedInspectorOptions {
  /** Test seam; production callers use the fixed bounded runner. */
  runGit?: AutoMergeCanaryGitRunner;
  /** May only tighten the production deadline. */
  deadlineMs?: number;
  /** Test seam for deterministic aggregate-deadline coverage. */
  monotonicNow?: () => number;
}

/** Canonical staged facts consumed by the pure canary policy classifier. */
export interface AutoMergeCanaryFileFact {
  path: string;
  status: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  additions: number | null;
  deletions: number | null;
  oldBlobIsText: boolean;
  newBlobIsText: boolean;
}

interface RawFileFact {
  path: string;
  status: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}

interface NumstatFact {
  path: string;
  additions: number | null;
  deletions: number | null;
}

const MAX_FILES = 16;
const MAX_CHANGED_LINES = 100_000;
const MAX_GIT_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 512 * 1024;
const MAX_BLOB_INSPECTION_MS = 1_000;
const MAX_INSPECTION_MS = 15_000;
const MAX_COMMITTED_GIT_INVOCATIONS = 48;
const ZERO_MODE = '000000';
const REGULAR_MODE = '100644';
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ROOT_DOC_NAMES = new Set([
  'architecture',
  'authors',
  'changelog',
  'code_of_conduct',
  'contributing',
  'governance',
  'license',
  'maintainers',
  'migration',
  'notice',
  'readme',
  'roadmap',
  'security',
  'support',
  'upgrading',
]);
// MDX can execute imports and expressions, so it is source rather than inert documentation.
const DOC_EXTENSIONS = new Set(['adoc', 'asciidoc', 'md', 'rst', 'txt']);
const DOC_DIRECTORIES = new Set(['doc', 'docs', 'documentation']);
const FORBIDDEN_DOC_SEGMENTS = new Set([
  '.circleci',
  '.git',
  '.github',
  '.gitlab',
  '__fixtures__',
  '__snapshots__',
  '__tests__',
  'build',
  'ci',
  'dist',
  'fixtures',
  'node_modules',
  'scripts',
  'snapshots',
  'src',
  'source',
  'test',
  'tests',
  'tools',
]);

function accepted(fileCount: number, lineCount: number): AutoMergeCanaryClassification {
  return {
    eligible: true,
    reason: 'eligible docs-only staged patch',
    fileCount,
    lineCount,
    class: 'docs-only',
    stagedTreeOid: null,
    baseCommitOid: null,
  };
}

function rejected(
  reason: AutoMergeCanaryReason,
  fileCount = 0,
  lineCount = 0,
): AutoMergeCanaryClassification {
  return {
    eligible: false,
    reason,
    fileCount,
    lineCount,
    class: 'rejected',
    stagedTreeOid: null,
    baseCommitOid: null,
  };
}

function committedInspectionFailure(
  reason: AutoMergeCanaryReason,
  fileCount = 0,
  lineCount = 0,
): AutoMergeCanaryCommittedClassification {
  return {
    outcome: 'inspection-failed',
    eligible: false,
    reason,
    fileCount,
    lineCount,
    class: 'rejected',
    baseCommitOid: null,
    headCommitOid: null,
    baseTreeOid: null,
    headTreeOid: null,
    pathDigest: null,
  };
}

interface CommitBinding {
  commitOid: string;
  parentOids: string[];
  treeOid: string;
}

function boundCommittedClassification(
  classification: AutoMergeCanaryClassification,
  base: CommitBinding,
  head: CommitBinding,
  pathDigest: string,
): AutoMergeCanaryCommittedClassification {
  const eligible = classification.eligible;
  return {
    outcome: eligible ? 'eligible' : 'policy-rejected',
    eligible,
    reason: eligible ? 'eligible docs-only committed patch' : classification.reason,
    fileCount: classification.fileCount,
    lineCount: classification.lineCount,
    class: classification.class,
    baseCommitOid: base.commitOid,
    headCommitOid: head.commitOid,
    baseTreeOid: base.treeOid,
    headTreeOid: head.treeOid,
    pathDigest,
  };
}

function isZeroOid(oid: string): boolean {
  return FULL_OID.test(oid) && /^0+$/.test(oid);
}

function hasValidObjectIdentity(fact: AutoMergeCanaryFileFact): boolean {
  if (!FULL_OID.test(fact.oldOid) || !FULL_OID.test(fact.newOid)) return false;
  if (fact.oldOid.length !== fact.newOid.length) return false;
  if (fact.status === 'A') return isZeroOid(fact.oldOid) && !isZeroOid(fact.newOid);
  if (fact.status === 'D') return !isZeroOid(fact.oldOid) && isZeroOid(fact.newOid);
  if (fact.status === 'M') {
    return !isZeroOid(fact.oldOid) && !isZeroOid(fact.newOid) && fact.oldOid !== fact.newOid;
  }
  return false;
}

function hasAllowedModeTransition(fact: AutoMergeCanaryFileFact): boolean {
  if (fact.status === 'A') return fact.oldMode === ZERO_MODE && fact.newMode === REGULAR_MODE;
  if (fact.status === 'D') return fact.oldMode === REGULAR_MODE && fact.newMode === ZERO_MODE;
  if (fact.status === 'M') return fact.oldMode === REGULAR_MODE && fact.newMode === REGULAR_MODE;
  return false;
}

function isStrictPath(path: string): boolean {
  if (path.length === 0 || path.length > 4096) return false;
  if (!/^[\x20-\x7e]+$/.test(path)) return false;
  if (!/^[A-Za-z0-9._/ ()+,@#=-]+$/.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('./') || path.endsWith('/')) return false;
  if (path.includes('\\') || path.includes('//') || path.includes(':')) return false;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => segment.startsWith(' ') || segment.endsWith(' '))) return false;
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  if (segments.some((segment) => /[.]$/.test(segment))) return false;
  if (segments.some((segment) => /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(segment))) {
    return false;
  }
  return true;
}

function isAllowlistedDocPath(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  if (segments.some((segment) => FORBIDDEN_DOC_SEGMENTS.has(segment))) return false;
  const base = segments.at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  const extension = dot >= 0 ? base.slice(dot + 1) : '';
  const stem = dot >= 0 ? base.slice(0, dot) : base;

  if (segments.length === 1) {
    if (!ROOT_DOC_NAMES.has(stem)) return false;
    return extension === '' ? stem === 'license' || stem === 'notice' : DOC_EXTENSIONS.has(extension);
  }
  return DOC_DIRECTORIES.has(segments[0]!) && DOC_EXTENSIONS.has(extension);
}

function validLineCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Pure policy decision over complete, authoritative staged Git facts.
 * It accepts only ordinary 100644 documentation blobs with actual text hunks.
 */
export function classifyAutoMergeCanaryFacts(
  facts: readonly AutoMergeCanaryFileFact[],
): AutoMergeCanaryClassification {
  if (facts.length === 0) return rejected('staged patch is empty');
  if (facts.length > MAX_FILES) return rejected('staged patch exceeds classifier limits', facts.length);

  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const addedBlobOids = new Set<string>();
  let lineCount = 0;
  let sawAddition = false;
  let sawDeletion = false;

  for (const fact of facts) {
    if (!validLineCount(fact.additions) || !validLineCount(fact.deletions)) {
      return rejected('binary content is unsupported', facts.length);
    }
    const changed = fact.additions + fact.deletions;
    if (!Number.isSafeInteger(changed)) return rejected('malformed git metadata', facts.length, lineCount);
    if (lineCount > MAX_CHANGED_LINES - changed) {
      return rejected('staged patch exceeds classifier limits', facts.length, lineCount);
    }
    lineCount += changed;
  }

  for (const fact of facts) {
    if (!isStrictPath(fact.path)) return rejected('path is malformed or ambiguous', facts.length, lineCount);
    const foldedPath = fact.path.toLowerCase();
    if (paths.has(fact.path) || foldedPaths.has(foldedPath)) {
      return rejected('duplicate or conflicting path metadata', facts.length, lineCount);
    }
    paths.add(fact.path);
    foldedPaths.add(foldedPath);

    if (fact.status !== 'A' && fact.status !== 'D' && fact.status !== 'M') {
      return rejected('change status is unsupported', facts.length, lineCount);
    }
    if (!hasAllowedModeTransition(fact)) {
      return rejected('file mode is unsupported', facts.length, lineCount);
    }
    if (!hasValidObjectIdentity(fact)) {
      return rejected('malformed git metadata', facts.length, lineCount);
    }
    if (fact.status === 'A') {
      if (addedBlobOids.has(fact.newOid)) {
        return rejected('rename or copy is ambiguous', facts.length, lineCount);
      }
      addedBlobOids.add(fact.newOid);
    }
    if (fact.additions! + fact.deletions! === 0) {
      return rejected('file change has no content lines', facts.length, lineCount);
    }
    sawAddition ||= fact.status === 'A';
    sawDeletion ||= fact.status === 'D';

    if (!isAllowlistedDocPath(fact.path)) {
      return rejected('path is outside the documentation allowlist', facts.length, lineCount);
    }
    if (
      (fact.status !== 'A' && !fact.oldBlobIsText) ||
      (fact.status !== 'D' && !fact.newBlobIsText)
    ) {
      return rejected('blob content is not strict text', facts.length, lineCount);
    }
  }

  // With rename detection disabled for canonical path accounting, an A+D set
  // cannot be distinguished perfectly from a rewritten rename. Fail closed.
  if (sawAddition && sawDeletion) {
    return rejected('rename or copy is ambiguous', facts.length, lineCount);
  }
  return accepted(facts.length, lineCount);
}

function gitEnvironment(): NodeJS.ProcessEnv {
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
  ]) {
    delete env[key];
  }
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

function defaultCommittedGitRunner(
  invocation: AutoMergeCanaryGitInvocation,
): AutoMergeCanaryGitRunResult {
  try {
    const stdout = execFileSync('git', ['-C', invocation.repo, ...invocation.args], {
      encoding: 'buffer',
      maxBuffer: invocation.maxOutputBytes,
      timeout: invocation.timeoutMs,
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.length <= invocation.maxOutputBytes
      ? { ok: true, stdout }
      : { ok: false, reason: 'output-limit' };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';
    if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
    if (code === 'ENOBUFS') return { ok: false, reason: 'output-limit' };
    return { ok: false, reason: 'git-error' };
  }
}

function runGit(
  repo: string,
  args: readonly string[],
  maxBuffer: number,
  timeoutMs = MAX_INSPECTION_MS,
  deadline = Number.POSITIVE_INFINITY,
): Buffer | null {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) return null;
  const result = defaultCommittedGitRunner({
    repo,
    args,
    maxOutputBytes: maxBuffer,
    timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)),
  });
  if (performance.now() >= deadline || !result.ok) return null;
  return result.stdout;
}

class CommittedInspectionFailure extends Error {
  constructor(readonly reason: AutoMergeCanaryReason) {
    super(reason);
  }
}

function decodeStrictUtf8(value: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

function nulFields(value: Buffer): string[] | null {
  if (value.length === 0) return [];
  if (value[value.length - 1] !== 0) return null;
  const decoded = decodeStrictUtf8(value);
  if (decoded === null) return null;
  const fields = decoded.split('\0');
  fields.pop();
  return fields;
}

function parseCommitBinding(value: Buffer): CommitBinding | null {
  const fields = nulFields(value);
  if (fields === null || fields.length !== 3) return null;
  const [commitOid, parentField, treeOid] = fields;
  if (!FULL_OID.test(commitOid!) || isZeroOid(commitOid!) ||
    !FULL_OID.test(treeOid!) || isZeroOid(treeOid!)) return null;
  const parentOids = parentField === '' ? [] : parentField!.split(' ');
  if (parentOids.some((oid) => !FULL_OID.test(oid) || isZeroOid(oid) || oid.length !== commitOid!.length)) {
    return null;
  }
  if (treeOid!.length !== commitOid!.length) return null;
  return { commitOid: commitOid!, parentOids, treeOid: treeOid! };
}

function sameCommitBinding(left: CommitBinding, right: CommitBinding): boolean {
  return left.commitOid === right.commitOid && left.treeOid === right.treeOid &&
    left.parentOids.length === right.parentOids.length &&
    left.parentOids.every((oid, index) => oid === right.parentOids[index]);
}

function digestSortedPaths(paths: readonly string[]): string {
  const sorted = [...paths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  return createHash('sha256').update(sorted.join('\0'), 'utf8').digest('hex');
}

function boundedLineCount(facts: readonly NumstatFact[]): number {
  let lineCount = 0;
  for (const fact of facts) {
    if (!validLineCount(fact.additions) || !validLineCount(fact.deletions)) continue;
    const changed = fact.additions + fact.deletions;
    if (!Number.isSafeInteger(changed) || lineCount > Number.MAX_SAFE_INTEGER - changed) continue;
    lineCount += changed;
  }
  return lineCount;
}

function parseRawFacts(value: Buffer): RawFileFact[] | null {
  const fields = nulFields(value);
  if (fields === null || fields.length % 2 !== 0) return null;
  const facts: RawFileFact[] = [];
  const headerPattern = /^:([0-7]{6}) ([0-7]{6}) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([A-Z][0-9]{0,3})$/;
  for (let index = 0; index < fields.length; index += 2) {
    const match = headerPattern.exec(fields[index]!);
    const path = fields[index + 1]!;
    if (!match || path.length === 0) return null;
    facts.push({
      path,
      oldMode: match[1]!,
      newMode: match[2]!,
      oldOid: match[3]!,
      newOid: match[4]!,
      status: match[5]!,
    });
  }
  return facts;
}

function parseDecimalCount(value: string): number | null | undefined {
  if (value === '-') return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseNumstatFacts(value: Buffer): NumstatFact[] | null {
  const fields = nulFields(value);
  if (fields === null) return null;
  const facts: NumstatFact[] = [];
  for (const field of fields) {
    const firstTab = field.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : field.indexOf('\t', firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) return null;
    const additions = parseDecimalCount(field.slice(0, firstTab));
    const deletions = parseDecimalCount(field.slice(firstTab + 1, secondTab));
    const path = field.slice(secondTab + 1);
    if (additions === undefined || deletions === undefined || path.length === 0) return null;
    facts.push({ path, additions, deletions });
  }
  return facts;
}

function renameOrCopyDetected(value: Buffer): boolean | null {
  const fields = nulFields(value);
  if (fields === null) return null;
  let index = 0;
  let detected = false;
  while (index < fields.length) {
    const match = /^:[0-7]{6} [0-7]{6} (?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])(?:[0-9]{1,3})?$/.exec(fields[index]!);
    if (!match) return null;
    index += 1;
    const pathCount = match[1] === 'R' || match[1] === 'C' ? 2 : 1;
    if (index + pathCount > fields.length) return null;
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      if (fields[index + pathIndex]!.length === 0) return null;
    }
    detected ||= pathCount === 2;
    index += pathCount;
  }
  return detected;
}

function isStrictText(value: Buffer): boolean {
  const decoded = decodeStrictUtf8(value);
  if (decoded === null) return false;
  for (const char of decoded) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function isStrictTextBlob(
  repo: string,
  oid: string,
  cache: Map<string, boolean>,
  deadline = Number.POSITIVE_INFINITY,
): boolean {
  const cached = cache.get(oid);
  if (cached !== undefined) return cached;
  const value = runGit(
    repo,
    ['cat-file', 'blob', oid],
    MAX_BLOB_BYTES,
    MAX_BLOB_INSPECTION_MS,
    deadline,
  );
  if (value === null) {
    cache.set(oid, false);
    return false;
  }
  const strict = isStrictText(value);
  cache.set(oid, strict);
  return strict;
}

function writeStagedTree(repo: string, deadline = Number.POSITIVE_INFINITY): string | null {
  const value = runGit(repo, ['write-tree'], 1024, MAX_INSPECTION_MS, deadline);
  if (value === null) return null;
  const decoded = decodeStrictUtf8(value)?.trim() ?? '';
  return FULL_OID.test(decoded) && !isZeroOid(decoded) ? decoded : null;
}

/**
 * Inspect one exact immutable commit pair without consulting refs, the index,
 * or the worktree. Complete results bind all object identities and paths;
 * inspection failures deliberately carry no authority-bearing identities.
 */
export function inspectCommittedAutoMergeCanaryPatch(
  repo: string,
  baseOid: string,
  headOid: string,
  options: AutoMergeCanaryCommittedInspectorOptions = {},
): AutoMergeCanaryCommittedClassification {
  if (!repo || repo.length > 4096 || repo.includes('\0') ||
    !FULL_OID.test(baseOid) || isZeroOid(baseOid) ||
    !FULL_OID.test(headOid) || isZeroOid(headOid) ||
    baseOid.length !== headOid.length || baseOid === headOid) {
    return committedInspectionFailure('invalid inspector input');
  }

  const requestedDeadline = options.deadlineMs;
  const deadlineMs = typeof requestedDeadline === 'number' && Number.isFinite(requestedDeadline)
    ? Math.max(1, Math.min(MAX_INSPECTION_MS, Math.floor(requestedDeadline)))
    : MAX_INSPECTION_MS;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const deadline = monotonicNow() + deadlineMs;
  const gitRunner = options.runGit ?? defaultCommittedGitRunner;
  let invocations = 0;
  let finalizing = false;
  let observedFiles = 0;
  let observedLines = 0;

  const invoke = (args: readonly string[], maxOutputBytes: number, timeoutMs = MAX_INSPECTION_MS): Buffer => {
    const remaining = Math.floor(deadline - monotonicNow());
    if (remaining < 1 || invocations >= MAX_COMMITTED_GIT_INVOCATIONS) {
      throw new CommittedInspectionFailure('inspection deadline exceeded');
    }
    invocations += 1;
    let result: AutoMergeCanaryGitRunResult;
    try {
      result = gitRunner({
        repo,
        args,
        maxOutputBytes,
        timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)),
      });
    } catch {
      throw new CommittedInspectionFailure('git metadata unavailable');
    }
    if (monotonicNow() >= deadline) {
      throw new CommittedInspectionFailure('inspection deadline exceeded');
    }
    if (!result.ok) {
      if (result.reason === 'timeout') {
        throw new CommittedInspectionFailure('inspection deadline exceeded');
      }
      if (result.reason === 'output-limit') {
        throw new CommittedInspectionFailure('inspection output exceeds classifier limits');
      }
      throw new CommittedInspectionFailure('git metadata unavailable');
    }
    if (!Buffer.isBuffer(result.stdout)) {
      throw new CommittedInspectionFailure('malformed git metadata');
    }
    if (result.stdout.length > maxOutputBytes) {
      throw new CommittedInspectionFailure('inspection output exceeds classifier limits');
    }
    return result.stdout;
  };

  const commitArgs = (oid: string) => [
    'show', '-s', '--no-patch', '--no-show-signature',
    '--format=format:%H%x00%P%x00%T%x00', oid, '--',
  ] as const;
  const readCommit = (oid: string): { binding: CommitBinding; raw: Buffer } => {
    const raw = invoke(commitArgs(oid), 1024);
    const binding = parseCommitBinding(raw);
    if (binding === null || binding.commitOid !== oid) {
      throw new CommittedInspectionFailure('malformed git metadata');
    }
    return { binding, raw };
  };
  const rawArgs = [
    'diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv',
    baseOid, headOid, '--',
  ] as const;
  const numstatArgs = [
    'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
    baseOid, headOid, '--',
  ] as const;
  const similarityArgs = [
    'diff', '--raw', '-z', '--find-renames=1%', '--find-copies=1%', '--find-copies-harder',
    '--no-abbrev', '--no-ext-diff', '--no-textconv', baseOid, headOid, '--',
  ] as const;

  try {
    const initialBase = readCommit(baseOid);
    const initialHead = readCommit(headOid);
    if (initialHead.binding.parentOids.length !== 1 ||
      initialHead.binding.parentOids[0] !== baseOid) {
      return committedInspectionFailure('head commit does not have base as its sole parent');
    }

    const raw = invoke(rawArgs, MAX_GIT_METADATA_BYTES);
    const numstat = invoke(numstatArgs, MAX_GIT_METADATA_BYTES);
    const similarity = invoke(similarityArgs, MAX_GIT_METADATA_BYTES);
    const rawFacts = parseRawFacts(raw);
    const numstatFacts = parseNumstatFacts(numstat);
    if (rawFacts === null || numstatFacts === null) {
      return committedInspectionFailure('malformed git metadata');
    }
    observedFiles = Math.max(rawFacts.length, numstatFacts.length);
    observedLines = boundedLineCount(numstatFacts);

    const rawByPath = new Map<string, RawFileFact>();
    for (const fact of rawFacts) {
      if (rawByPath.has(fact.path)) {
        return committedInspectionFailure('malformed git metadata', observedFiles, observedLines);
      }
      rawByPath.set(fact.path, fact);
    }
    const numstatByPath = new Map<string, NumstatFact>();
    for (const fact of numstatFacts) {
      if (numstatByPath.has(fact.path)) {
        return committedInspectionFailure('malformed git metadata', observedFiles, observedLines);
      }
      numstatByPath.set(fact.path, fact);
    }
    if (rawByPath.size !== numstatByPath.size ||
      [...rawByPath.keys()].some((path) => !numstatByPath.has(path))) {
      return committedInspectionFailure('git metadata path sets differ', observedFiles, observedLines);
    }
    const pathDigest = digestSortedPaths([...rawByPath.keys()]);

    const renameCopy = renameOrCopyDetected(similarity);
    if (renameCopy === null) {
      return committedInspectionFailure('malformed git metadata', observedFiles, observedLines);
    }

    let classification: AutoMergeCanaryClassification;
    if (rawFacts.length === 0 && numstatFacts.length === 0) {
      classification = rejected('staged patch is empty');
    } else if (rawFacts.length > MAX_FILES || numstatFacts.length > MAX_FILES) {
      classification = rejected('staged patch exceeds classifier limits', observedFiles, observedLines);
    } else if (renameCopy) {
      classification = rejected('rename or copy is ambiguous', rawFacts.length, observedLines);
    } else {
      const facts: AutoMergeCanaryFileFact[] = rawFacts.map((rawFact) => {
        const counts = numstatByPath.get(rawFact.path)!;
        return {
          ...rawFact,
          additions: counts.additions,
          deletions: counts.deletions,
          oldBlobIsText: true,
          newBlobIsText: true,
        };
      });
      const preliminary = classifyAutoMergeCanaryFacts(facts);
      if (!preliminary.eligible) {
        classification = preliminary;
      } else {
        const textBlobCache = new Map<string, boolean>();
        const inspectBlob = (oid: string): boolean => {
          const cached = textBlobCache.get(oid);
          if (cached !== undefined) return cached;
          const value = invoke(['cat-file', 'blob', oid], MAX_BLOB_BYTES, MAX_BLOB_INSPECTION_MS);
          const strict = isStrictText(value);
          textBlobCache.set(oid, strict);
          return strict;
        };
        for (const fact of facts) {
          fact.oldBlobIsText = fact.oldMode === ZERO_MODE ? true : inspectBlob(fact.oldOid);
          fact.newBlobIsText = fact.newMode === ZERO_MODE ? true : inspectBlob(fact.newOid);
        }
        classification = classifyAutoMergeCanaryFacts(facts);
      }
    }

    finalizing = true;
    const finalBase = readCommit(baseOid);
    const finalHead = readCommit(headOid);
    const finalRaw = invoke(rawArgs, MAX_GIT_METADATA_BYTES);
    const finalNumstat = invoke(numstatArgs, MAX_GIT_METADATA_BYTES);
    const finalSimilarity = invoke(similarityArgs, MAX_GIT_METADATA_BYTES);
    if (!sameCommitBinding(initialBase.binding, finalBase.binding) ||
      !sameCommitBinding(initialHead.binding, finalHead.binding) ||
      !initialBase.raw.equals(finalBase.raw) || !initialHead.raw.equals(finalHead.raw) ||
      !raw.equals(finalRaw) || !numstat.equals(finalNumstat) || !similarity.equals(finalSimilarity)) {
      return committedInspectionFailure(
        'committed metadata changed during inspection',
        observedFiles,
        observedLines,
      );
    }
    return boundCommittedClassification(
      classification,
      finalBase.binding,
      finalHead.binding,
      pathDigest,
    );
  } catch (error) {
    const reason = error instanceof CommittedInspectionFailure
      ? error.reason
      : 'git metadata unavailable';
    if (reason === 'inspection deadline exceeded') {
      return committedInspectionFailure(reason, observedFiles, observedLines);
    }
    return committedInspectionFailure(
      finalizing ? 'committed metadata changed during inspection' : reason,
      observedFiles,
      observedLines,
    );
  }
}

/**
 * Inspect the current index relative to an exact base commit. This requests
 * only NUL-delimited Git metadata and bounded blobs; it never obtains or stores
 * raw patch text. All Git invocations are argv-only.
 */
export function inspectStagedAutoMergeCanaryPatch(
  repo: string,
  baseHead: string,
): AutoMergeCanaryClassification {
  if (!repo || repo.includes('\0') || !FULL_OID.test(baseHead) || isZeroOid(baseHead)) {
    return rejected('invalid inspector input');
  }
  const deadline = performance.now() + MAX_INSPECTION_MS;
  if (runGit(repo, ['cat-file', '-e', `${baseHead}^{commit}`], 1024, MAX_INSPECTION_MS, deadline) === null) {
    return rejected('git metadata unavailable');
  }

  const rawArgs = [
    'diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', baseHead, '--',
  ] as const;
  const numstatArgs = [
    'diff', '--cached', '--numstat', '-z', '--no-renames', '--no-ext-diff', baseHead, '--',
  ] as const;
  const similarityArgs = [
    'diff', '--cached', '--raw', '-z', '--find-renames=1%', '--find-copies=1%',
    '--find-copies-harder', '--no-abbrev', '--no-ext-diff', baseHead, '--',
  ] as const;
  const raw = runGit(repo, rawArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  const numstat = runGit(repo, numstatArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  const similarity = runGit(repo, similarityArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  if (raw === null || numstat === null || similarity === null) {
    return rejected('git metadata unavailable');
  }

  const rawFacts = parseRawFacts(raw);
  const numstatFacts = parseNumstatFacts(numstat);
  if (rawFacts === null || numstatFacts === null) return rejected('malformed git metadata');
  if (rawFacts.length === 0 && numstatFacts.length === 0) return rejected('staged patch is empty');
  if (rawFacts.length > MAX_FILES || numstatFacts.length > MAX_FILES) {
    return rejected('staged patch exceeds classifier limits', Math.max(rawFacts.length, numstatFacts.length));
  }

  const rawByPath = new Map<string, RawFileFact>();
  for (const fact of rawFacts) {
    if (rawByPath.has(fact.path)) {
      return rejected('duplicate or conflicting path metadata', rawFacts.length);
    }
    rawByPath.set(fact.path, fact);
  }
  const numstatByPath = new Map<string, NumstatFact>();
  for (const fact of numstatFacts) {
    if (numstatByPath.has(fact.path)) {
      return rejected('duplicate or conflicting path metadata', numstatFacts.length);
    }
    numstatByPath.set(fact.path, fact);
  }
  if (
    rawByPath.size !== numstatByPath.size ||
    [...rawByPath.keys()].some((path) => !numstatByPath.has(path))
  ) {
    return rejected('git metadata path sets differ', Math.max(rawByPath.size, numstatByPath.size));
  }

  const renameCopy = renameOrCopyDetected(similarity);
  if (renameCopy === null) return rejected('malformed git metadata');
  if (renameCopy) {
    const lineCount = numstatFacts.reduce((total, fact) => {
      if (!validLineCount(fact.additions) || !validLineCount(fact.deletions)) return total;
      const next = total + fact.additions + fact.deletions;
      return Number.isSafeInteger(next) ? next : total;
    }, 0);
    return rejected('rename or copy is ambiguous', rawFacts.length, lineCount);
  }

  const facts: AutoMergeCanaryFileFact[] = [];
  const textBlobCache = new Map<string, boolean>();
  for (const rawFact of rawFacts) {
    const counts = numstatByPath.get(rawFact.path)!;
    facts.push({
      ...rawFact,
      additions: counts.additions,
      deletions: counts.deletions,
      oldBlobIsText:
        rawFact.oldMode === ZERO_MODE
          ? true
          : isStrictTextBlob(repo, rawFact.oldOid, textBlobCache, deadline),
      newBlobIsText:
        rawFact.newMode === ZERO_MODE
          ? true
          : isStrictTextBlob(repo, rawFact.newOid, textBlobCache, deadline),
    });
  }
  const finalRaw = runGit(repo, rawArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  const finalNumstat = runGit(repo, numstatArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  const finalSimilarity = runGit(repo, similarityArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  if (finalRaw === null || finalNumstat === null || finalSimilarity === null) {
    return rejected('git metadata unavailable');
  }
  if (!raw.equals(finalRaw) || !numstat.equals(finalNumstat) || !similarity.equals(finalSimilarity)) {
    return rejected('staged metadata changed during inspection', facts.length);
  }
  const classification = classifyAutoMergeCanaryFacts(facts);
  if (!classification.eligible) return classification;

  // Bind the verdict to an immutable tree identity. Re-read both metadata and
  // the tree after materializing it so a concurrent index mutation cannot be
  // paired with facts inspected from an earlier snapshot.
  const stagedTreeOid = writeStagedTree(repo, deadline);
  const boundRaw = runGit(repo, rawArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  const boundNumstat = runGit(repo, numstatArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  const boundSimilarity = runGit(repo, similarityArgs, MAX_GIT_METADATA_BYTES, MAX_INSPECTION_MS, deadline);
  const boundTreeOid = writeStagedTree(repo, deadline);
  if (stagedTreeOid === null || boundTreeOid === null || stagedTreeOid !== boundTreeOid ||
    boundRaw === null || boundNumstat === null || boundSimilarity === null ||
    !raw.equals(boundRaw) || !numstat.equals(boundNumstat) || !similarity.equals(boundSimilarity)) {
    return rejected('staged metadata changed during inspection', facts.length, classification.lineCount);
  }
  return { ...classification, stagedTreeOid: boundTreeOid, baseCommitOid: baseHead };
}
